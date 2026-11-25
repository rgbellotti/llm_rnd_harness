//! Permanent session history in a local SQLCipher file.
//!
//! The default path is `$XDG_DATA_HOME/harness/harness.db`, or
//! `~/.local/share/harness/harness.db` when `XDG_DATA_HOME` is unset.
//! `--history` and `HARNESS_DB_PATH` override it. A `./harness.db` left in
//! the workspace is moved once, with its sidecars, when the new path is
//! empty.
//!
//! Page encryption keeps the indexed history reads intact. The passphrase
//! is `HARNESS_DB_KEY`, read once and then removed from the process
//! environment. It is never written into SQL. A plaintext file left by an
//! older harness is copied into an encrypted file, checked, and only then
//! replaced.
//!
//! A plain start (no keys file and no `HARNESS_DB_KEY`) has no passphrase
//! anywhere, so history is session-only: a random in-memory passphrase
//! opens the database at `:memory:`, the real file is never touched, and
//! the project memory beside it follows. Tests keep a fixed fallback
//! passphrase; production refuses nothing — the refusal gate below only
//! applies to genuine failures.
//!
//! Stores absolutely everything the harness records and displays — prompts,
//! thinking, responses, tool calls/results, redirects, metrics — as labeled
//! event sequences, so any past session can be re-rendered on demand exactly
//! like the frontier "previous conversations" list. Read-only recall: there
//! is deliberately no code path from history back into model context.
//!
//! A database that cannot be opened, or a write that fails later, is
//! remembered for the life of the process. The page shows that reason and
//! new runs stay refused unless the request sets `allow_unrecorded`. The
//! run already in flight keeps going. Single-user traffic means one
//! connection behind a mutex held only inside blocking tasks is plenty.
use rusqlite::{Connection, params};
use serde_json::Value;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// Compact the database only when a worthwhile share of the file has
/// been freed. A full `VACUUM` rewrites the whole file, so running it
/// per delete is expensive: it holds the connection for as long as the
/// history is big, and deleting a dozen sessions in a row pays for a
/// dozen rewrites.
const VACUUM_FREE_FRACTION: f64 = 0.1;
/// Minimum time between two compactions.
const VACUUM_MIN_INTERVAL_MS: u64 = 30_000;

#[derive(Clone)]
pub(crate) struct HistoryDb {
    /// SQLite is a blocking C interface: every operation — including
    /// `VACUUM` after deletes — runs inside `spawn_blocking` so the async
    /// executor never stalls behind a lock or a vacuum.
    inner: Option<Arc<std::sync::Mutex<Connection>>>,
    /// When the file was last compacted (unix millis), so two deletes in
    /// a row do not each rewrite it.
    last_vacuum: Arc<AtomicU64>,
    /// The first reason history stopped recording. Empty while recording.
    /// Later failures keep the original reason.
    failure: Arc<Mutex<Option<String>>>,
}

impl HistoryDb {
    pub(crate) fn open(path: &str) -> Self {
        match history_passphrase() {
            Ok(key) => Self::open_with_passphrase(path, key),
            Err(reason) => Self::unavailable(reason),
        }
    }

    /// Open `path` with an explicit passphrase. The production path is
    /// [`Self::open`], which reads `HARNESS_DB_KEY` once. Tests use this
    /// so they do not race on the process environment.
    fn open_with_passphrase(path: &str, key: &str) -> Self {
        let key = match normalize_passphrase(key) {
            Ok(key) => key,
            Err(reason) => return Self::unavailable(reason),
        };
        // SQLite follows symlinks. A workspace writer could replace
        // harness.db (or a sidecar) with a symlink to an arbitrary file;
        // refuse rather than chmod/write through it.
        if let Some(unsafe_path) = symlinked_database_path(path) {
            return Self::unavailable(format!("database path {unsafe_path} is a symlink"));
        }
        if let Err(reason) = recover_interrupted_encryption(path, &key) {
            return Self::unavailable(reason);
        }
        // The transcripts hold everything the model read and everything
        // the user typed: keep them private to the owner. This runs before
        // the plaintext copy so the file is private while it is still
        // readable.
        restrict_permissions(path);
        if is_plaintext_sqlite(path) {
            if let Err(reason) = encrypt_plaintext_history(path, &key) {
                return Self::unavailable(reason);
            }
        }
        match Connection::open(path) {
            Ok(mut conn) => {
                // The key is the first operation. A later statement is what
                // reports a wrong passphrase; sqlite3_key itself returns OK.
                if let Err(reason) = apply_key(&conn, &key) {
                    return Self::unavailable(reason);
                }
                if let Err(reason) = confirm_key(&conn) {
                    return Self::unavailable(reason);
                }
                if let Err(e) = init(&mut conn) {
                    return Self::unavailable(format!("database init failed ({path}): {e}"));
                }
                // The write-ahead log and the shared-memory index exist
                // now; they must be private as well.
                restrict_permissions(path);
                // The encrypted file opened. A plaintext copy left beside
                // it is no longer the record.
                discard_encryption_leftovers(path);
                let db = Self {
                    inner: Some(Arc::new(Mutex::new(conn))),
                    last_vacuum: Arc::new(AtomicU64::new(0)),
                    failure: Arc::new(Mutex::new(None)),
                };
                // Reclaim the space a previous session freed, in the
                // background: the harness must start promptly.
                if tokio::runtime::Handle::try_current().is_ok() {
                    let background = db.clone();
                    tokio::spawn(async move {
                        background.maybe_vacuum("startup-vacuum").await;
                    });
                }
                db
            }
            Err(e) => Self::unavailable(format!("database open failed ({path}): {e}")),
        }
    }

    fn unavailable(reason: String) -> Self {
        eprintln!(
            "history: unavailable ({reason}) — new runs stay refused until the page allows an unrecorded session"
        );
        Self {
            inner: None,
            last_vacuum: Arc::new(AtomicU64::new(0)),
            failure: Arc::new(Mutex::new(Some(reason))),
        }
    }

    pub(crate) fn enabled(&self) -> bool {
        self.inner.is_some()
    }

    /// True when a new run will be written. False after open failure or
    /// the first failed write.
    pub(crate) fn recording(&self) -> bool {
        self.enabled() && self.failure_reason().is_none()
    }

    pub(crate) fn failure_reason(&self) -> Option<String> {
        self.failure
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// `None` when the run may start. `Some` is the sentence the page and
    /// the 409 body show. `allow_unrecorded` is the explicit override.
    pub(crate) fn block_reason(&self, allow_unrecorded: bool) -> Option<String> {
        if self.recording() || allow_unrecorded {
            return None;
        }
        let reason = self
            .failure_reason()
            .unwrap_or_else(|| "history is unavailable".to_string());
        Some(format!(
            "Session history is unavailable ({reason}). New runs stay refused until you allow an unrecorded session."
        ))
    }

    fn note_failure(&self, reason: String) {
        let mut slot = self
            .failure
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if slot.is_none() {
            eprintln!(
                "history: unavailable ({reason}) — new runs stay refused until the page allows an unrecorded session"
            );
            *slot = Some(reason);
        }
    }

    async fn with_conn<F, T>(&self, label: &str, f: F) -> Option<T>
    where
        F: FnOnce(&Connection) -> Result<T, rusqlite::Error> + Send + 'static,
        T: Send + 'static,
    {
        let conn = self.inner.as_ref()?.clone();
        match tokio::task::spawn_blocking(move || {
            let guard = conn.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            f(&guard)
        })
        .await
        {
            Ok(Ok(value)) => Some(value),
            Ok(Err(e)) => {
                self.note_failure(format!("{label} failed: {e}"));
                None
            }
            Err(join_error) => {
                self.note_failure(format!("{label} task failed: {join_error}"));
                None
            }
        }
    }

    pub(crate) async fn create_run(
        &self,
        id: &str,
        title: &str,
        model: &str,
        prompt: &str,
        tool_names: &[String],
        uploaded_files: &[String],
        comment_tag: &str,
    ) {
        let tool_json = serde_json::to_string(tool_names).unwrap_or_default();
        let up_json = serde_json::to_string(uploaded_files).unwrap_or_default();
        let (id, title, model, prompt, comment_tag) = (
            id.to_string(),
            title.to_string(),
            model.to_string(),
            prompt.to_string(),
            comment_tag.to_string(),
        );
        self.with_conn("create_run", move |conn| {
            conn.execute(
                "INSERT INTO runs (id, title, created_at, model, prompt, status, tool_names, uploaded_files, comment_tag)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'running', ?6, ?7, ?8)",
                params![
                    id,
                    title,
                    now_millis(),
                    model,
                    prompt,
                    tool_json,
                    up_json,
                    comment_tag
                ],
            )
        })
        .await;
    }

    /// Insert one event and return its row id. That integer is the history
    /// address (HID) for the block: stable for the life of the file, unique
    /// across runs, and the value compaction headers cite. `None` means
    /// history is not recording.
    pub(crate) async fn add_event(
        &self,
        run_id: &str,
        seq: i64,
        typ: &str,
        round: i64,
        payload: &Value,
    ) -> Option<i64> {
        let payload_str = serde_json::to_string(payload).unwrap_or_default();
        let (run_id, typ) = (run_id.to_string(), typ.to_string());
        self.with_conn("add_event", move |conn| {
            conn.execute(
                "INSERT INTO events (run_id, seq, type, round, payload, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![run_id, seq, typ, round, payload_str, now_millis()],
            )?;
            Ok(conn.last_insert_rowid())
        })
        .await
    }

    pub(crate) async fn finish_run(
        &self,
        id: &str,
        status: &str,
        totals_prompt: i64,
        totals_completion: i64,
        wall_ms: i64,
    ) {
        let (id, status) = (id.to_string(), status.to_string());
        self.with_conn("finish_run", move |conn| {
            conn.execute(
                "UPDATE runs SET status = ?1, totals_prompt = ?2, totals_completion = ?3, wall_ms = ?4 WHERE id = ?5",
                params![status, totals_prompt, totals_completion, wall_ms, id],
            )
        })
        .await;
    }

    pub(crate) async fn list_runs(&self, limit: Option<usize>) -> Vec<Value> {
        // SQLite's LIMIT -1 is unbounded; the caller's absence passes -1.
        let limit = limit.map(|n| n as i64).unwrap_or(-1);
        self.with_conn("list_runs", move |conn| {
            let mut stmt = conn.prepare(
                "SELECT id, title, created_at, model, status, totals_prompt, totals_completion,
                        wall_ms, tool_names, uploaded_files,
                        (SELECT COALESCE(MAX(round), 0) FROM events WHERE events.run_id = runs.id) AS rounds
                 FROM runs ORDER BY created_at DESC LIMIT ?1",
            )?;
            let rows = stmt.query_map([limit], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "title": row.get::<_, String>(1)?,
                    "created_at": row.get::<_, i64>(2)?,
                    "model": row.get::<_, String>(3)?,
                    "status": row.get::<_, String>(4)?,
                    "totals_prompt": row.get::<_, i64>(5)?,
                    "totals_completion": row.get::<_, i64>(6)?,
                    "wall_ms": row.get::<_, i64>(7)?,
                    "tool_names": row.get::<_, String>(8)?,
                    "uploaded_files": row.get::<_, String>(9)?,
                    "rounds": row.get::<_, i64>(10)?,
                }))
            })?;
            rows.collect::<Result<Vec<_>, _>>()
        })
        .await
        .unwrap_or_default()
    }

    /// A missing run is `Some(None)`: it is a 404, not a database
    /// failure, and it must not latch the failure flag that refuses new
    /// runs. `None` is a database failure, which does latch.
    pub(crate) async fn get_run(&self, id: &str) -> Option<Option<Value>> {
        let id = id.to_string();
        self.with_conn("get_run", move |conn| {
            let run = match conn.query_row(
                "SELECT id, title, created_at, model, prompt, status, totals_prompt,
                        totals_completion, wall_ms, tool_names, uploaded_files, comment_tag
                 FROM runs WHERE id = ?1",
                params![id],
                |row| {
                    Ok(serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "title": row.get::<_, String>(1)?,
                        "created_at": row.get::<_, i64>(2)?,
                        "model": row.get::<_, String>(3)?,
                        "prompt": row.get::<_, String>(4)?,
                        "status": row.get::<_, String>(5)?,
                        "totals_prompt": row.get::<_, i64>(6)?,
                        "totals_completion": row.get::<_, i64>(7)?,
                        "wall_ms": row.get::<_, i64>(8)?,
                        "tool_names": row.get::<_, String>(9)?,
                        "uploaded_files": row.get::<_, String>(10)?,
                        "comment_tag": row.get::<_, String>(11)?,
                    }))
                },
            ) {
                Ok(run) => run,
                Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
                Err(error) => return Err(error),
            };
            let mut stmt = conn.prepare(
                "SELECT id, seq, type, round, payload FROM events WHERE run_id = ?1 ORDER BY seq",
            )?;
            let events = stmt
                .query_map(params![id], |row| event_json(row))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Some(serde_json::json!({ "run": run, "events": events })))
        })
        .await
    }

    /// One screen of a run: the run row, the highest positive round, and
    /// the events in `[from, to]` plus every round-0 event (prompt and
    /// pre-round errors). Round 0 is small and is not part of the span
    /// cap. A missing run is `None`.
    ///
    /// `tail` asks for the last N positive rounds (clamped to
    /// [`ROUND_WINDOW_MAX_SPAN`]). Otherwise `from`/`to` select the slice;
    /// a span wider than the cap is truncated. All three empty means the
    /// default tail, so a bare request cannot dump a long transcript.
    pub(crate) async fn round_window(
        &self,
        id: &str,
        from: Option<i64>,
        to: Option<i64>,
        tail: Option<i64>,
    ) -> Option<Value> {
        let id = id.to_string();
        self.with_conn("round_window", move |conn| {
            let run = match select_run(conn, &id)? {
                Some(run) => run,
                None => return Ok(None),
            };
            let max_round: i64 = conn.query_row(
                "SELECT COALESCE(MAX(round), 0) FROM events WHERE run_id = ?1 AND round > 0",
                params![id],
                |row| row.get(0),
            )?;
            let (from, to) = resolve_round_range(max_round, from, to, tail);
            let mut events = read_events(
                conn,
                "SELECT id, seq, type, round, payload FROM events
                 WHERE run_id = ?1 AND round = 0 ORDER BY seq",
                params![id],
            )?;
            if to >= from && from > 0 {
                let mut slice = read_events(
                    conn,
                    "SELECT id, seq, type, round, payload FROM events
                     WHERE run_id = ?1 AND round BETWEEN ?2 AND ?3 ORDER BY seq",
                    params![id, from, to],
                )?;
                events.append(&mut slice);
            }
            events.sort_by_key(|event| event.get("seq").and_then(|seq| seq.as_i64()).unwrap_or(0));
            Ok(Some(serde_json::json!({
                "run": run,
                "max_round": max_round,
                "from": from,
                "to": to,
                "events": events,
            })))
        })
        .await
        .flatten()
    }

    /// One history row by its address. `Some(None)` is a missing id.
    /// `None` means the database could not be read.
    pub(crate) async fn get_event(&self, hid: i64) -> Option<Option<Value>> {
        if hid <= 0 {
            return Some(None);
        }
        self.with_conn("get_event", move |conn| {
            match conn.query_row(
                "SELECT events.id, events.run_id, events.seq, events.type, events.round,
                        events.payload, events.created_at, COALESCE(runs.comment_tag, '')
                 FROM events
                 LEFT JOIN runs ON runs.id = events.run_id
                 WHERE events.id = ?1",
                params![hid],
                |row| {
                    let payload_str: String = row.get(5)?;
                    let typ: String = row.get(3)?;
                    let sent = to_model(&typ);
                    Ok(serde_json::json!({
                        "hid": row.get::<_, i64>(0)?,
                        "run_id": row.get::<_, String>(1)?,
                        "seq": row.get::<_, i64>(2)?,
                        "type": typ,
                        "round": row.get::<_, i64>(4)?,
                        "payload": serde_json::from_str::<Value>(&payload_str).unwrap_or(Value::Null),
                        "created_at": row.get::<_, i64>(6)?,
                        "comment_tag": row.get::<_, String>(7)?,
                        "to_model": sent,
                    }))
                },
            ) {
                Ok(event) => Ok(Some(event)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(error) => Err(error),
            }
        })
        .await
    }

    pub(crate) async fn delete_run(&self, id: &str) -> bool {
        let id = id.to_string();
        let removed = self
            .with_conn("delete_run", move |conn| {
                // Atomic: rely on ON DELETE CASCADE so a crash cannot leave
                // orphan events; single statement keeps it transactional.
                conn.execute("DELETE FROM runs WHERE id = ?1", params![id])
            })
            .await
            .unwrap_or(0);
        if removed > 0 {
            // Reclaim the disk when enough of it has been freed — not on
            // every single delete.
            self.maybe_vacuum("vacuum").await;
        }
        removed > 0
    }

    /// Compact the file when a worthwhile share of it has been freed.
    ///
    /// SQLite reuses the pages a delete frees, so the file does not have
    /// to shrink immediately; a full rewrite is only worth it once a
    /// tenth of the file is free, and never more than once every
    /// `VACUUM_MIN_INTERVAL_MS`.
    async fn maybe_vacuum(&self, label: &str) {
        let worth_it = self
            .with_conn(label, |conn| {
                // In WAL mode the file's free-page count is only updated at
                // a checkpoint, so make one first — that is far cheaper
                // than rewriting the file.
                conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
                let free: i64 = conn.query_row("PRAGMA freelist_count", [], |row| row.get(0))?;
                let total: i64 = conn.query_row("PRAGMA page_count", [], |row| row.get(0))?;
                Ok(total > 0 && free as f64 / total as f64 >= VACUUM_FREE_FRACTION)
            })
            .await
            .unwrap_or(false);
        if !worth_it {
            return;
        }
        let now = now_millis().max(0) as u64;
        let last = self.last_vacuum.load(Ordering::Relaxed);
        if now.saturating_sub(last) < VACUUM_MIN_INTERVAL_MS {
            // Too soon after the last compaction; the next delete tries
            // again.
            return;
        }
        if self.last_vacuum.swap(now, Ordering::Relaxed) != last {
            // Another delete is already compacting.
            return;
        }
        self.with_conn("vacuum", move |conn| {
            conn.execute_batch("VACUUM")?;
            Ok(())
        })
        .await;
    }

    /// Pages SQLite has free inside the file (diagnostics and tests).
    #[cfg(test)]
    pub(crate) async fn free_pages(&self) -> i64 {
        self.with_conn("free_pages", |conn| {
            let free: i64 = conn.query_row("PRAGMA freelist_count", [], |row| row.get(0))?;
            Ok(free)
        })
        .await
        .unwrap_or(0)
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// True for the in-memory / URI paths that are not real files.
fn is_memory_path(path: &str) -> bool {
    path == ":memory:" || path.starts_with("file:")
}

/// Any existing symlink at the database or one of its SQLite sidecar
/// paths. SQLite follows these when opening/writing, so a workspace
/// writer could otherwise redirect the transcript database at an
/// arbitrary file.
fn symlinked_database_path(path: &str) -> Option<String> {
    if is_memory_path(path) {
        return None;
    }
    for candidate in [
        path.to_string(),
        format!("{path}-wal"),
        format!("{path}-shm"),
        format!("{path}.plaintext"),
        format!("{path}.encrypting"),
    ] {
        if let Ok(meta) = std::fs::symlink_metadata(&candidate)
            && meta.file_type().is_symlink()
        {
            return Some(candidate);
        }
    }
    None
}

/// Make the database (and its write-ahead log and shared-memory index)
/// readable by its owner only.
///
/// The file is created with the mode already set, so there is no window
/// in which a transcript is world-readable, and an existing database is
/// tightened as well.
#[cfg(unix)]
fn restrict_permissions(path: &str) {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    if is_memory_path(path) {
        return;
    }
    let database = std::path::Path::new(path);
    if database.exists() {
        let _ = std::fs::set_permissions(database, std::fs::Permissions::from_mode(0o600));
    } else {
        // A relative path has no parent component: it lives in the
        // current directory.
        let parent = database
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| std::path::Path::new("."));
        if parent.exists() {
            let _ = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(false)
                .mode(0o600)
                .open(database);
        }
    }
    // SQLite creates the sidecar files with the database's mode; make
    // sure of it for the ones that are already there.
    for suffix in ["-wal", "-shm"] {
        let side = std::path::PathBuf::from(format!("{path}{suffix}"));
        if side.exists() {
            let _ = std::fs::set_permissions(&side, std::fs::Permissions::from_mode(0o600));
        }
    }
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &str) {}

const MIN_PASSPHRASE_CHARS: usize = 12;
const MAX_PASSPHRASE_BYTES: usize = 1024;
const SQLITE_MAGIC: &[u8] = b"SQLite format 3\0";

/// Read `HARNESS_DB_KEY` once, then drop it from the process environment
/// so a later shell command cannot inherit it. Tests that leave the
/// variable unset use a fixed passphrase so parallel tests do not write
/// the environment.
fn history_passphrase() -> Result<&'static str, String> {
    static KEY: OnceLock<Result<String, String>> = OnceLock::new();
    match KEY.get_or_init(read_history_passphrase) {
        Ok(value) => Ok(value.as_str()),
        Err(reason) => Err(reason.clone()),
    }
}

fn read_history_passphrase() -> Result<String, String> {
    if let Some(installed) = crate::keys::installed_db_key() {
        // SAFETY: one variable, removed once, before any tool is spawned.
        unsafe { std::env::remove_var("HARNESS_DB_KEY") };
        return match installed {
            Some(value) => normalize_passphrase(&value),
            None => session_passphrase(),
        };
    }
    let raw = std::env::var("HARNESS_DB_KEY").ok();
    // SAFETY: the environment is process-global. This runs once, inside
    // OnceLock, and only removes the variable just read above.
    unsafe { std::env::remove_var("HARNESS_DB_KEY") };
    match raw {
        Some(value) => normalize_passphrase(&value),
        None => fallback_passphrase(),
    }
}

/// The passphrase for a plain start: no keys file and no environment
/// value, so no database on disk could be reopened under it later anyway.
/// A random 32-byte hex keeps this session's history — and the project
/// memory beside it — fully usable in memory, and the note says what
/// that means. Tests keep their fixed fallback so parallel runs stay
/// deterministic and never touch `/dev/urandom`.
fn session_passphrase() -> Result<String, String> {
    #[cfg(test)]
    {
        fallback_passphrase()
    }
    #[cfg(not(test))]
    {
        eprintln!(
            "history: session-only — no keys file and no HARNESS_DB_KEY. History works this session and is not saved to disk."
        );
        crate::keys::generate_passphrase()
    }
}

/// True when this launch should keep history in memory instead of
/// opening a file: a plain start (no passphrase anywhere) with no
/// explicit path. An explicit `--history` or `HARNESS_DB_PATH` is still
/// honored and lands where it was told — the caller prints the caveat
/// that the file is encrypted under this session's random key.
pub(crate) fn session_only_location(
    mode: crate::keys::StartupMode,
    cli_path: Option<&str>,
    env_path: Option<&std::ffi::OsStr>,
) -> bool {
    // Empty strings count as absent, the same filter locate_history's
    // chosen_path applies.
    let explicit_cli = cli_path.is_some_and(|path| !path.is_empty());
    let explicit_env = env_path.is_some_and(|path| !path.is_empty());
    mode == crate::keys::StartupMode::PlainSession && !explicit_cli && !explicit_env
}

fn fallback_passphrase() -> Result<String, String> {
    #[cfg(test)]
    {
        Ok("harness-test-key".to_string())
    }
    #[cfg(not(test))]
    {
        Err("Set HARNESS_DB_KEY in the environment of the harness process and restart. History is encrypted with that passphrase.".to_string())
    }
}

/// Trim the ends. Keep interior spaces. Refuse an empty passphrase and a
/// short one: SQLCipher would otherwise accept `""` and encrypt with it.
pub(crate) fn normalize_passphrase(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(
            "HARNESS_DB_KEY is empty. Export a passphrase of at least 12 characters and restart."
                .to_string(),
        );
    }
    if trimmed.chars().count() < MIN_PASSPHRASE_CHARS {
        return Err(
            "HARNESS_DB_KEY must be at least 12 characters. Export a longer passphrase and restart."
                .to_string(),
        );
    }
    if trimmed.len() > MAX_PASSPHRASE_BYTES {
        return Err(
            "HARNESS_DB_KEY is too long. Use a passphrase of at most 1024 bytes and restart."
                .to_string(),
        );
    }
    Ok(trimmed.to_string())
}

fn apply_key(conn: &Connection, key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > MAX_PASSPHRASE_BYTES {
        return Err("refusing to open history with an empty or oversized passphrase".to_string());
    }
    // sqlite3_key copies the bytes. The passphrase is not placed in SQL.
    let rc = unsafe {
        rusqlite::ffi::sqlite3_key(
            conn.handle(),
            key.as_ptr().cast::<std::ffi::c_void>(),
            key.len() as i32,
        )
    };
    if rc != rusqlite::ffi::SQLITE_OK {
        return Err(format!(
            "could not apply the history key (sqlite status {rc})"
        ));
    }
    Ok(())
}

/// `sqlite3_key` returns OK for a wrong passphrase. The next statement
/// fails, and that failure is the signal the page can show.
fn confirm_key(conn: &Connection) -> Result<(), String> {
    match conn.query_row("SELECT count(*) FROM sqlite_master", [], |row| {
        row.get::<_, i64>(0)
    }) {
        Ok(_) => Ok(()),
        Err(error) => Err(history_key_error(&error.to_string())),
    }
}

/// Open a SQLCipher connection with the history passphrase. The caller
/// runs its own schema init. A new file is created encrypted. A plaintext
/// SQLite file is refused rather than migrated.
pub(crate) fn open_keyed_connection(path: &str) -> Result<Connection, String> {
    let key = history_passphrase()?;
    let key = normalize_passphrase(key)?;
    if let Some(unsafe_path) = symlinked_database_path(path) {
        return Err(format!("database path {unsafe_path} is a symlink"));
    }
    if is_plaintext_sqlite(path) {
        return Err(format!(
            "{path} is a plaintext SQLite file. Refusing to open it as encrypted project memory."
        ));
    }
    restrict_permissions(path);
    let conn = Connection::open(path)
        .map_err(|err| format!("database open failed ({path}): {err}"))?;
    apply_key(&conn, &key)?;
    confirm_key(&conn).map_err(|err| err.replace("this history file", "this database"))?;
    restrict_permissions(path);
    Ok(conn)
}

fn history_key_error(message: &str) -> String {
    let lower = message.to_lowercase();
    if lower.contains("not a database")
        || lower.contains("hmac")
        || lower.contains("decrypt")
        || lower.contains("file is encrypted")
    {
        "HARNESS_DB_KEY does not open this history file. Restart with the passphrase that encrypted it.".to_string()
    } else {
        format!("could not open encrypted history: {message}")
    }
}

fn is_plaintext_sqlite(path: &str) -> bool {
    if is_memory_path(path) {
        return false;
    }
    let mut header = [0u8; 16];
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    match std::io::Read::read(&mut file, &mut header) {
        Ok(16) => header.as_slice() == SQLITE_MAGIC,
        _ => false,
    }
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn user_table_counts(conn: &Connection, schema: &str) -> Result<Vec<(String, i64)>, String> {
    if schema != "main" && schema != "source" {
        return Err("could not read the history schema".to_string());
    }
    let list_sql = format!(
        "SELECT name FROM {schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    let mut stmt = conn
        .prepare(&list_sql)
        .map_err(|e| format!("could not read the history schema: {e}"))?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("could not read the history schema: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("could not read the history schema: {e}"))?;
    drop(stmt);
    let mut counts = Vec::with_capacity(names.len());
    for name in names {
        let sql = format!("SELECT count(*) FROM {schema}.{}", quote_ident(&name));
        let count: i64 = conn
            .query_row(&sql, [], |row| row.get(0))
            .map_err(|e| format!("could not count rows while encrypting history: {e}"))?;
        counts.push((name, count));
    }
    Ok(counts)
}

fn keyed_user_table_count(path: &str, key: &str) -> Result<i64, String> {
    let conn = Connection::open(path)
        .map_err(|e| format!("could not open the encrypted history copy: {e}"))?;
    apply_key(&conn, key)?;
    confirm_key(&conn)?;
    conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        [],
        |row| row.get(0),
    )
    .map_err(|e| history_key_error(&e.to_string()))
}

/// A crash between the two renames leaves `path.plaintext` and maybe
/// `path.encrypting` with no `path`. Put a checked encrypted copy back,
/// or restore the plaintext file so this open can encrypt it again.
fn recover_interrupted_encryption(path: &str, key: &str) -> Result<(), String> {
    if is_memory_path(path) {
        return Ok(());
    }
    let plain = format!("{path}.plaintext");
    let dest = format!("{path}.encrypting");
    let path_exists = std::path::Path::new(path).exists();
    let plain_exists = std::path::Path::new(&plain).exists();
    let dest_exists = std::path::Path::new(&dest).exists();

    if !path_exists && dest_exists && plain_exists {
        match keyed_user_table_count(&dest, key) {
            Ok(count) if count > 0 => {
                std::fs::rename(&dest, path)
                    .map_err(|error| format!("could not finish encrypting history: {error}"))?;
                wipe_file(&plain);
                eprintln!("history: finished an interrupted encryption of the existing database");
                return Ok(());
            }
            _ => {
                std::fs::rename(&plain, path).map_err(|error| {
                    format!(
                        "could not restore the plaintext history after an interrupted encryption: {error}"
                    )
                })?;
                wipe_file(&dest);
                return Ok(());
            }
        }
    }
    if !path_exists && plain_exists {
        std::fs::rename(&plain, path).map_err(|error| {
            format!(
                "could not restore the plaintext history after an interrupted encryption: {error}"
            )
        })?;
        if dest_exists {
            wipe_file(&dest);
        }
    } else if path_exists && dest_exists && is_plaintext_sqlite(path) {
        // The copy did not finish. The original is still the record.
        wipe_file(&dest);
    }
    Ok(())
}

fn encrypt_plaintext_history(path: &str, key: &str) -> Result<(), String> {
    eprintln!("history: copying the existing database into an encrypted file");
    let expected = plaintext_table_counts(path)?;
    let dest = format!("{path}.encrypting");
    if let Err(error) = create_private_file(&dest) {
        return Err(error);
    }
    let copied = (|| {
        let conn = Connection::open(&dest)
            .map_err(|e| format!("could not create the encrypted history file: {e}"))?;
        apply_key(&conn, key)?;
        // First statement on the new file, so the key is in use before
        // the plaintext database is attached. KEY '' is the literal empty
        // key for that plaintext file, not the passphrase.
        confirm_key(&conn)?;
        conn.execute("ATTACH DATABASE ?1 AS source KEY ''", params![path])
            .map_err(|e| format!("could not read the existing history for encryption: {e}"))?;
        let exported: Option<String> = conn
            .query_row("SELECT sqlcipher_export('main', 'source')", [], |row| {
                row.get(0)
            })
            .map_err(|e| format!("could not copy history into the encrypted file: {e}"))?;
        if exported.as_deref().is_some_and(|status| status != "ok") {
            return Err("could not copy history into the encrypted file".to_string());
        }
        let from_source = user_table_counts(&conn, "source")?;
        let from_copy = user_table_counts(&conn, "main")?;
        if from_source != expected || from_copy != expected {
            return Err(
                "the encrypted copy did not match the existing history, so the original file was left unchanged"
                    .to_string(),
            );
        }
        conn.execute("DETACH DATABASE source", [])
            .map_err(|e| format!("could not finish the encrypted history copy: {e}"))?;
        drop(conn);

        let check = Connection::open(&dest)
            .map_err(|e| format!("could not reopen the encrypted history copy: {e}"))?;
        apply_key(&check, key)?;
        confirm_key(&check)?;
        let reopened = user_table_counts(&check, "main")?;
        if reopened != expected {
            return Err(
                "the encrypted copy did not match the existing history, so the original file was left unchanged"
                    .to_string(),
            );
        }
        // Leave every page in the main file. The rename below does not
        // move a write-ahead log along with it.
        check
            .execute_batch("PRAGMA journal_mode=DELETE;")
            .map_err(|e| format!("could not finish the encrypted history copy: {e}"))?;
        drop(check);
        let _ = std::fs::remove_file(format!("{dest}-wal"));
        let _ = std::fs::remove_file(format!("{dest}-shm"));
        Ok(())
    })();
    if let Err(error) = copied {
        wipe_file(&dest);
        return Err(error);
    }

    let aside = format!("{path}.plaintext");
    // The checked copy is the record. Wipe a stale aside first so the
    // rename below does not replace it unread.
    wipe_file(&aside);
    if let Err(error) = std::fs::rename(path, &aside) {
        wipe_file(&dest);
        return Err(format!(
            "could not move the existing history aside: {error}"
        ));
    }
    if let Err(error) = std::fs::rename(&dest, path) {
        let _ = std::fs::rename(&aside, path);
        wipe_file(&dest);
        return Err(format!("could not replace the history file: {error}"));
    }
    wipe_file(&aside);
    let _ = std::fs::remove_file(format!("{path}-wal"));
    let _ = std::fs::remove_file(format!("{path}-shm"));
    eprintln!("history: existing database is now encrypted");
    Ok(())
}

fn plaintext_table_counts(path: &str) -> Result<Vec<(String, i64)>, String> {
    let conn =
        Connection::open(path).map_err(|e| format!("could not read the existing history: {e}"))?;
    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
    // Fold the write-ahead log into the main file so the copy sees it.
    // A database that was never in WAL mode can refuse the pragma.
    let checkpointed = conn
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .is_ok();
    let counts = user_table_counts(&conn, "main")?;
    drop(conn);
    if checkpointed {
        let _ = std::fs::remove_file(format!("{path}-wal"));
        let _ = std::fs::remove_file(format!("{path}-shm"));
    }
    Ok(counts)
}

fn create_private_file(path: &str) -> Result<(), String> {
    let _ = std::fs::remove_file(path);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| format!("could not create the encrypted history file: {e}"))?;
    }
    #[cfg(not(unix))]
    {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|e| format!("could not create the encrypted history file: {e}"))?;
    }
    Ok(())
}

fn discard_encryption_leftovers(path: &str) {
    if is_memory_path(path) {
        return;
    }
    wipe_file(&format!("{path}.plaintext"));
    wipe_file(&format!("{path}.encrypting"));
}

/// Overwrite a regular file, then remove it. Unlink alone leaves the
/// bytes on disk. A symlink is removed without being followed.
fn wipe_file(path: &str) {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return;
    };
    if meta.file_type().is_symlink() {
        let _ = std::fs::remove_file(path);
        return;
    }
    if !meta.is_file() {
        return;
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().write(true).open(path) {
        let zeros = vec![0u8; 64 * 1024];
        let mut left = meta.len();
        while left > 0 {
            let n = std::cmp::min(left, zeros.len() as u64) as usize;
            if std::io::Write::write_all(&mut file, &zeros[..n]).is_err() {
                break;
            }
            left -= n as u64;
        }
        let _ = file.sync_all();
    }
    let _ = std::fs::remove_file(path);
}

fn init(conn: &mut Connection) -> Result<(), rusqlite::Error> {
    // A stale writer (killed server, second instance) must never fail the
    // open: wait on locks instead of erroring into disabled-history mode.
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA foreign_keys=ON;
         CREATE TABLE IF NOT EXISTS runs (
             id TEXT PRIMARY KEY,
             title TEXT NOT NULL,
             created_at INTEGER NOT NULL,
             model TEXT NOT NULL,
             prompt TEXT NOT NULL,
             status TEXT NOT NULL DEFAULT 'running',
             totals_prompt INTEGER NOT NULL DEFAULT 0,
             totals_completion INTEGER NOT NULL DEFAULT 0,
             wall_ms INTEGER NOT NULL DEFAULT 0,
             tool_names TEXT NOT NULL DEFAULT '[]',
             uploaded_files TEXT NOT NULL DEFAULT '[]',
             comment_tag TEXT NOT NULL DEFAULT ''
         );
         CREATE TABLE IF NOT EXISTS events (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
             seq INTEGER NOT NULL,
             type TEXT NOT NULL,
             round INTEGER NOT NULL DEFAULT 0,
             payload TEXT NOT NULL DEFAULT '{}',
             created_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, seq);
         CREATE INDEX IF NOT EXISTS idx_events_run_round ON events(run_id, round, seq);",
    )?;
    // CREATE TABLE IF NOT EXISTS leaves an existing database on its old
    // columns. Runs opened after a restart still need the marker that
    // translates this launch's comment tags.
    ensure_comment_tag(conn)?;
    // Nothing is executing at process start. A row still marked running
    // belongs to a harness that stopped before finish_run.
    settle_orphaned_runs(conn)
}

fn settle_orphaned_runs(conn: &mut Connection) -> Result<(), rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id,
                COALESCE((SELECT MAX(seq) FROM events WHERE events.run_id = runs.id), 0),
                COALESCE((SELECT MAX(round) FROM events WHERE events.run_id = runs.id), 0)
         FROM runs WHERE status = 'running'",
    )?;
    let pending = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    if pending.is_empty() {
        return Ok(());
    }
    let now = now_millis();
    let message = serde_json::json!({
        "message": "The harness stopped while this run was still open."
    })
    .to_string();
    let tx = conn.transaction()?;
    for (id, seq, round) in pending {
        tx.execute(
            "INSERT INTO events (run_id, seq, type, round, payload, created_at)
             VALUES (?1, ?2, 'error', ?3, ?4, ?5)",
            params![id, seq + 1, round, message, now],
        )?;
        tx.execute(
            "UPDATE runs SET status = 'aborted' WHERE id = ?1 AND status = 'running'",
            params![id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn ensure_comment_tag(conn: &Connection) -> Result<(), rusqlite::Error> {
    let mut stmt = conn.prepare("PRAGMA table_info(runs)")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == "comment_tag" {
            return Ok(());
        }
    }
    conn.execute(
        "ALTER TABLE runs ADD COLUMN comment_tag TEXT NOT NULL DEFAULT ''",
        [],
    )?;
    Ok(())
}

/// Largest positive-round span one scroll request may return.
const ROUND_WINDOW_MAX_SPAN: i64 = 16;
/// Default tail when a request names neither a tail nor a range.
const ROUND_WINDOW_DEFAULT_TAIL: i64 = 8;

fn resolve_round_range(
    max_round: i64,
    from: Option<i64>,
    to: Option<i64>,
    tail: Option<i64>,
) -> (i64, i64) {
    if max_round <= 0 {
        return (0, 0);
    }
    let tail = match (tail, from, to) {
        (None, None, None) => Some(ROUND_WINDOW_DEFAULT_TAIL),
        (tail, _, _) => tail,
    };
    if let Some(tail) = tail {
        let span = tail.clamp(1, ROUND_WINDOW_MAX_SPAN);
        let end = max_round;
        let start = (end - span + 1).max(1);
        return (start, end);
    }
    let mut start = from.unwrap_or(1).max(1);
    let mut end = to.unwrap_or(max_round).min(max_round);
    if end < start {
        return (start, start - 1);
    }
    if end - start + 1 > ROUND_WINDOW_MAX_SPAN {
        end = start + ROUND_WINDOW_MAX_SPAN - 1;
        if end > max_round {
            end = max_round;
            start = (end - ROUND_WINDOW_MAX_SPAN + 1).max(1);
        }
    }
    (start, end)
}

fn select_run(conn: &Connection, id: &str) -> Result<Option<Value>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, title, created_at, model, prompt, status, totals_prompt,
                totals_completion, wall_ms, tool_names, uploaded_files, comment_tag
         FROM runs WHERE id = ?1",
    )?;
    let mut rows = stmt.query(params![id])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    Ok(Some(serde_json::json!({
        "id": row.get::<_, String>(0)?,
        "title": row.get::<_, String>(1)?,
        "created_at": row.get::<_, i64>(2)?,
        "model": row.get::<_, String>(3)?,
        "prompt": row.get::<_, String>(4)?,
        "status": row.get::<_, String>(5)?,
        "totals_prompt": row.get::<_, i64>(6)?,
        "totals_completion": row.get::<_, i64>(7)?,
        "wall_ms": row.get::<_, i64>(8)?,
        "tool_names": row.get::<_, String>(9)?,
        "uploaded_files": row.get::<_, String>(10)?,
        "comment_tag": row.get::<_, String>(11)?,
    })))
}

fn event_json(row: &rusqlite::Row<'_>) -> Result<Value, rusqlite::Error> {
    let payload_str: String = row.get(4)?;
    let typ: String = row.get(2)?;
    let sent = to_model(&typ);
    Ok(serde_json::json!({
        "hid": row.get::<_, i64>(0)?,
        "seq": row.get::<_, i64>(1)?,
        "type": typ,
        "round": row.get::<_, i64>(3)?,
        "payload": serde_json::from_str::<Value>(&payload_str).unwrap_or(Value::Null),
        "to_model": sent,
    }))
}

/// Whether an event of this type belongs to the model-bound transcript
/// lineage — the one "current" version the model is sent. Everything else
/// (before-review originals, approvals, metrics, notices, corrections,
/// errors) is history-view only and never reaches the model. The flag is
/// derived from the stored type, so every HID entry answers "is this
/// block sent to the model" without a schema migration.
pub(crate) fn to_model(typ: &str) -> bool {
    matches!(
        typ,
        "prompt"
            | "thinking_delta"
            | "content_delta"
            | "tool_call"
            | "tool_result"
            | "context_budget"
    )
}

fn read_events(
    conn: &Connection,
    sql: &str,
    params: impl rusqlite::Params,
) -> Result<Vec<Value>, rusqlite::Error> {
    let mut stmt = conn.prepare(sql)?;
    let events = stmt
        .query_map(params, |row| event_json(row))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(events)
}

/// Short auto title: first line of the prompt, capped, plus nothing else
/// (the date column carries the timestamp).
pub(crate) fn auto_title(prompt: &str) -> String {
    const MAX: usize = 60;
    let first = prompt.trim().split('\n').next().unwrap_or("untitled");
    let mut title: String = first.chars().take(MAX).collect();
    if first.chars().count() > MAX {
        title.push('…');
    }
    if title.is_empty() {
        title = "untitled".to_string();
    }
    title
}

/// Where the history file goes, and the sentences to print before opening it.
#[derive(Debug)]
pub(crate) struct HistoryLocation {
    pub path: PathBuf,
    pub messages: Vec<String>,
}

/// Inputs for [`locate_history`]. Passed in so tests do not mutate the process environment.
pub(crate) struct HistoryLocateInput<'a> {
    pub workspace: &'a Path,
    pub cli_path: Option<&'a str>,
    /// `HARNESS_DB_PATH`. Used when `--history` was not given.
    pub env_path: Option<&'a OsStr>,
    pub xdg_data_home: Option<&'a OsStr>,
    pub home: Option<&'a OsStr>,
}

const HISTORY_SIDECARS: [&str; 4] = ["-wal", "-shm", ".plaintext", ".encrypting"];

/// Resolve the history path, create its directory at mode `0700`, and move a
/// workspace `harness.db` (plus sidecars) when the new path is empty.
pub(crate) fn locate_history(input: HistoryLocateInput<'_>) -> Result<HistoryLocation, String> {
    let mut messages = Vec::new();
    let path = chosen_path(&input, &mut messages)?;
    if path_is_inside_workspace(&path, input.workspace) {
        messages.push(format!(
            "history: {} is inside the workspace. An approved shell command can delete it.",
            path.display()
        ));
    }
    let directory = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty());
    if let Some(directory) = directory {
        ensure_private_dir(directory, &mut messages)?;
    }
    migrate_legacy(input.workspace, &path, &mut messages)?;
    Ok(HistoryLocation { path, messages })
}

fn chosen_path(
    input: &HistoryLocateInput<'_>,
    messages: &mut Vec<String>,
) -> Result<PathBuf, String> {
    if let Some(path) = input.cli_path.filter(|path| !path.is_empty()) {
        let mut message = format!("history: database path is {path} (--history)");
        if input.env_path.is_some_and(|value| !value.is_empty()) {
            message.push_str(". HARNESS_DB_PATH is set and was not used");
        }
        messages.push(message);
        return Ok(PathBuf::from(path));
    }
    if let Some(path) = input.env_path.filter(|path| !path.is_empty()) {
        let shown = path.to_string_lossy();
        messages.push(format!(
            "history: database path is {shown} (HARNESS_DB_PATH)"
        ));
        return Ok(PathBuf::from(path));
    }
    if let Some(xdg) = input.xdg_data_home.filter(|value| !value.is_empty()) {
        let path = PathBuf::from(xdg).join("harness").join("harness.db");
        messages.push(format!(
            "history: database path is {} (XDG_DATA_HOME)",
            path.display()
        ));
        return Ok(path);
    }
    if let Some(home) = input.home.filter(|value| !value.is_empty()) {
        let path = PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("harness")
            .join("harness.db");
        messages.push(format!(
            "history: database path is {} (~/.local/share)",
            path.display()
        ));
        return Ok(path);
    }
    Err(
        "history: no database path. Set HARNESS_DB_PATH, or set HOME so the harness can use ~/.local/share/harness/harness.db."
            .into(),
    )
}

fn path_is_inside_workspace(path: &Path, workspace: &Path) -> bool {
    let workspace = workspace
        .canonicalize()
        .unwrap_or_else(|_| workspace.to_path_buf());
    let candidate = canonical_for_compare(path);
    candidate.starts_with(&workspace)
}

fn canonical_for_compare(path: &Path) -> PathBuf {
    if let Ok(canonical) = path.canonicalize() {
        return canonical;
    }
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    if let Some(parent) = absolute.parent()
        && !parent.as_os_str().is_empty()
        && let Ok(parent) = parent.canonicalize()
    {
        return parent.join(absolute.file_name().unwrap_or_default());
    }
    absolute
}

fn ensure_private_dir(dir: &Path, messages: &mut Vec<String>) -> Result<(), String> {
    if let Ok(meta) = std::fs::symlink_metadata(dir)
        && meta.file_type().is_symlink()
    {
        return Err(format!(
            "history: {} is a symlink. Refusing to use it as the database directory.",
            dir.display()
        ));
    }
    if dir.exists() {
        if !dir.is_dir() {
            return Err(format!(
                "history: {} exists and is not a directory.",
                dir.display()
            ));
        }
        tighten_dir(dir, messages)?;
        return Ok(());
    }
    if let Some(parent) = dir.parent()
        && !parent.as_os_str().is_empty()
        && !parent.exists()
    {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("history: could not create {}: {error}", parent.display()))?;
    }
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir).map_err(|error| {
        format!(
            "history: could not create {} with mode 0700: {error}",
            dir.display()
        )
    })?;
    messages.push(format!("history: created {} with mode 0700", dir.display()));
    Ok(())
}

#[cfg(unix)]
fn tighten_dir(dir: &Path, messages: &mut Vec<String>) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::symlink_metadata(dir)
        .map_err(|error| format!("history: could not read {}: {error}", dir.display()))?
        .permissions()
        .mode()
        & 0o777;
    if mode == 0o700 {
        return Ok(());
    }
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(|error| {
        format!(
            "history: could not set {} to mode 0700: {error}",
            dir.display()
        )
    })?;
    messages.push(format!(
        "history: set {} mode to 0700 (it was {mode:o})",
        dir.display()
    ));
    Ok(())
}

#[cfg(not(unix))]
fn tighten_dir(_dir: &Path, _messages: &mut Vec<String>) -> Result<(), String> {
    Ok(())
}

fn migrate_legacy(workspace: &Path, dest: &Path, messages: &mut Vec<String>) -> Result<(), String> {
    let legacy = workspace.join("harness.db");
    if same_history_path(&legacy, dest) {
        return Ok(());
    }
    let sources = history_set(&legacy);
    let destinations = history_set(dest);
    let source_data: Vec<PathBuf> = sources
        .iter()
        .filter(|path| path.symlink_metadata().is_ok())
        .cloned()
        .collect();
    if source_data.is_empty() {
        return Ok(());
    }
    let has_record = source_data
        .iter()
        .any(|path| is_history_record(path, &legacy));
    if !has_record {
        return Ok(());
    }
    for path in &source_data {
        if std::fs::symlink_metadata(path)
            .map(|meta| meta.file_type().is_symlink())
            .unwrap_or(false)
        {
            messages.push(format!(
                "history: {} is a symlink. It was not moved.",
                path.display()
            ));
            return Ok(());
        }
        if !std::fs::symlink_metadata(path)
            .map(|meta| meta.is_file())
            .unwrap_or(false)
        {
            messages.push(format!(
                "history: {} is not a regular file. It was not moved.",
                path.display()
            ));
            return Ok(());
        }
    }
    if let Some(blocker) = destinations
        .iter()
        .find(|path| path.symlink_metadata().is_ok())
    {
        let shown = source_data
            .iter()
            .find(|path| is_history_record(path, &legacy))
            .unwrap_or(&legacy);
        messages.push(format!(
            "history: left {} in place because {} already exists",
            shown.display(),
            blocker.display()
        ));
        return Ok(());
    }
    let pairs: Vec<(PathBuf, PathBuf)> = sources
        .into_iter()
        .zip(destinations)
        .filter(|(src, _)| src.symlink_metadata().is_ok())
        .collect();
    move_history_files(&pairs, messages)
}

fn is_history_record(path: &Path, legacy: &Path) -> bool {
    path == legacy
        || path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".plaintext") || name.ends_with(".encrypting"))
}

fn history_set(db: &Path) -> Vec<PathBuf> {
    let mut files = vec![db.to_path_buf()];
    for suffix in HISTORY_SIDECARS {
        files.push(sidecar_path(db, suffix));
    }
    files
}

fn sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_else(|| "harness.db".into());
    name.push(suffix);
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.join(name),
        _ => PathBuf::from(name),
    }
}

fn same_history_path(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    canonical_for_compare(left) == canonical_for_compare(right)
}

fn move_history_files(
    pairs: &[(PathBuf, PathBuf)],
    messages: &mut Vec<String>,
) -> Result<(), String> {
    let mut moved = Vec::new();
    for (src, dest) in pairs.iter() {
        match std::fs::rename(src, dest) {
            Ok(()) => {
                messages.push(format!(
                    "history: moved {} to {}",
                    src.display(),
                    dest.display()
                ));
                moved.push((src, dest));
            }
            Err(error) if error.raw_os_error() == Some(libc_exdev()) && moved.is_empty() => {
                return copy_history_files(pairs, messages);
            }
            Err(error) => {
                undo_renames(&moved);
                return Err(format!(
                    "history: could not move {} to {}: {error}",
                    src.display(),
                    dest.display()
                ));
            }
        }
    }
    Ok(())
}

fn undo_renames(moved: &[(&PathBuf, &PathBuf)]) {
    for (src, dest) in moved.iter().rev() {
        let _ = std::fs::rename(dest, src);
    }
}

fn copy_history_files(
    pairs: &[(PathBuf, PathBuf)],
    messages: &mut Vec<String>,
) -> Result<(), String> {
    let mut copied = Vec::new();
    for (src, dest) in pairs.iter() {
        if let Err(error) = copy_file_exact(src, dest) {
            for path in copied.iter().rev() {
                let _ = std::fs::remove_file(path);
            }
            return Err(error);
        }
        copied.push(dest.clone());
    }
    for (src, dest) in pairs.iter() {
        if let Err(error) = std::fs::remove_file(src) {
            messages.push(format!(
                "history: copied {} to {} but could not remove the workspace file: {error}",
                src.display(),
                dest.display()
            ));
            continue;
        }
        messages.push(format!(
            "history: copied {} to {} and removed the workspace file",
            src.display(),
            dest.display()
        ));
    }
    Ok(())
}

fn copy_file_exact(src: &Path, dest: &Path) -> Result<(), String> {
    if dest.symlink_metadata().is_ok() {
        return Err(format!(
            "history: refused to copy over existing {}",
            dest.display()
        ));
    }
    let bytes = std::fs::copy(src, dest).map_err(|error| {
        format!(
            "history: could not copy {} to {}: {error}",
            src.display(),
            dest.display()
        )
    })?;
    let src_len = std::fs::metadata(src)
        .map_err(|error| format!("history: could not read {}: {error}", src.display()))?
        .len();
    if bytes != src_len {
        let _ = std::fs::remove_file(dest);
        return Err(format!(
            "history: the copy of {} did not match the original, so it was removed",
            src.display()
        ));
    }
    if let Ok(file) = std::fs::File::open(dest) {
        let _ = file.sync_all();
    }
    Ok(())
}

fn libc_exdev() -> i32 {
    #[cfg(unix)]
    {
        libc::EXDEV
    }
    #[cfg(not(unix))]
    {
        18
    }
}

#[cfg(test)]
mod history_tests {
    use super::*;
    use std::ffi::OsStr;

    fn remove_history_files(path: &std::path::Path) {
        let text = path.to_string_lossy();
        for suffix in ["", "-wal", "-shm", ".encrypting", ".plaintext"] {
            let _ = std::fs::remove_file(format!("{text}{suffix}"));
        }
    }

    fn test_db(name: &str) -> HistoryDb {
        let dir = std::env::temp_dir().join("harness_history_test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        remove_history_files(&path);
        HistoryDb::open(path.to_str().unwrap())
    }

    #[test]
    fn auto_title_truncates_first_line() {
        assert_eq!(auto_title("hello world"), "hello world");
        assert_eq!(auto_title("  \n\n"), "untitled");
        let long = format!("{}\nsecond", "x".repeat(100));
        let title = auto_title(&long);
        assert!(title.chars().count() <= 61, "{title}");
        assert!(title.starts_with(&"x".repeat(60)));
    }

    #[tokio::test]
    async fn round_trip_run_and_events() {
        let db = test_db("roundtrip.db");
        assert!(db.enabled());
        db.create_run(
            "run-1",
            "t",
            "m",
            "say hi",
            &["run_cmd".to_string()],
            &["a.txt".to_string()],
            "abc123def456",
        )
        .await;
        db.add_event(
            "run-1",
            1,
            "prompt",
            0,
            &serde_json::json!({ "text": "say hi" }),
        )
        .await;
        db.add_event(
            "run-1",
            2,
            "content",
            1,
            &serde_json::json!({ "text": "hi" }),
        )
        .await;
        db.finish_run("run-1", "done", 5, 3, 1200).await;

        let list = db.list_runs(None).await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["status"], "done");
        assert_eq!(list[0]["totals_completion"], 3);

        let doc = db.get_run("run-1").await.flatten().expect("run present");
        assert_eq!(doc["run"]["prompt"], "say hi");
        assert_eq!(doc["run"]["comment_tag"], "abc123def456");
        assert_eq!(doc["events"].as_array().unwrap().len(), 2);
        assert_eq!(doc["events"][1]["type"], "content");
        assert!(doc["events"][0]["hid"].as_i64().unwrap() > 0);
        assert!(doc["events"][1]["hid"].as_i64().unwrap() > doc["events"][0]["hid"].as_i64().unwrap());

        assert!(db.get_run("missing").await.flatten().is_none());
        // The 404 above must not latch the failure flag: a missing run is
        // not a database failure, and new runs must still be recorded.
        // (Regression: get_run used to route QueryReturnedNoRows through
        // with_conn's error path, which latched for the process lifetime.)
        assert!(db.failure_reason().is_none());
        assert!(db.recording());
        assert!(db.block_reason(false).is_none());
        assert!(db.delete_run("run-1").await);
        assert!(!db.delete_run("run-1").await);
        assert!(db.list_runs(None).await.is_empty());
    }

    #[tokio::test]
    async fn event_row_id_is_the_recall_address() {
        let db = test_db("hid-recall.db");
        db.create_run("run-h", "t", "m", "p", &[], &[], "abc123def456")
            .await;
        let first = db
            .add_event("run-h", 1, "prompt", 0, &serde_json::json!({ "text": "p" }))
            .await
            .expect("prompt hid");
        let second = db
            .add_event(
                "run-h",
                2,
                "tool_result",
                1,
                &serde_json::json!({ "name": "run_cmd", "output": "listed", "duration_ms": 10 }),
            )
            .await
            .expect("result hid");
        assert!(second > first);
        let event = db.get_event(second).await.flatten().expect("event");
        assert_eq!(event["hid"], second);
        assert_eq!(event["run_id"], "run-h");
        assert_eq!(event["type"], "tool_result");
        assert_eq!(event["round"], 1);
        assert_eq!(event["payload"]["output"], "listed");
        assert_eq!(event["comment_tag"], "abc123def456");
        assert!(db.get_event(0).await.flatten().is_none());
        assert!(db.get_event(9_000_000).await.flatten().is_none());
        assert!(db.failure_reason().is_none());
        let window = db.round_window("run-h", Some(1), Some(1), None).await.unwrap();
        assert_eq!(window["events"][1]["hid"], second);
    }

    #[tokio::test]
    async fn events_carry_a_to_model_flag() {
        let db = test_db("to-model.db");
        db.create_run("run-t", "t", "m", "p", &[], &[], "").await;
        db.add_event("run-t", 1, "prompt", 0, &serde_json::json!({ "text": "p" }))
            .await;
        db.add_event(
            "run-t",
            2,
            "tool_call",
            1,
            &serde_json::json!({ "name": "run_cmd" }),
        )
        .await;
        db.add_event(
            "run-t",
            3,
            "tool_preview",
            1,
            &serde_json::json!({ "name": "run_cmd", "output": "original" }),
        )
        .await;
        db.add_event(
            "run-t",
            4,
            "tool_result",
            1,
            &serde_json::json!({ "name": "run_cmd", "output": "final" }),
        )
        .await;
        db.add_event(
            "run-t",
            5,
            "context_budget",
            1,
            &serde_json::json!({ "text": "20% fill" }),
        )
        .await;
        db.add_event("run-t", 6, "metrics", 1, &serde_json::json!({})).await;
        let doc = db.get_run("run-t").await.flatten().expect("run present");
        let events = doc["events"].as_array().expect("events");
        let kinds = ["prompt", "tool_call", "tool_preview", "tool_result", "context_budget", "metrics"];
        let expected = [true, true, false, true, true, false];
        for (index, (kind, want)) in kinds.iter().zip(expected.iter()).enumerate() {
            assert_eq!(events[index]["type"], *kind);
            assert_eq!(
                events[index]["to_model"].as_bool().expect("boolean flag"),
                *want,
                "{} should be {}",
                kind,
                want
            );
        }
        assert!(!to_model("approval"));
        assert!(!to_model("notice"));
        assert!(!to_model("protocol_correction"));
        assert!(!to_model("error"));
        assert!(!to_model("stopped"));
        assert!(to_model("thinking_delta"));
        assert!(to_model("content_delta"));
    }

    #[tokio::test]
    async fn the_run_list_honors_the_limit_parameter() {
        let db = test_db("list-limit");
        for i in 0..3 {
            let id = format!("run-{i}");
            db.create_run(&id, "t", "m", "p", &[], &[], "tag").await;
            db.finish_run(&id, "done", 1, 1, 10).await;
        }
        // Unbounded by default; a cap returns the same head as the full
        // list, and zero is a legal cap that returns nothing.
        let all = db.list_runs(None).await;
        assert_eq!(all.len(), 3);
        let one = db.list_runs(Some(1)).await;
        assert_eq!(one.len(), 1);
        assert_eq!(one[0]["id"], all[0]["id"]);
        assert_eq!(db.list_runs(Some(2)).await.len(), 2);
        assert!(db.list_runs(Some(0)).await.is_empty());
        // A cap beyond the table is the table, not an error.
        assert_eq!(db.list_runs(Some(50)).await.len(), 3);
    }

    #[tokio::test]
    async fn round_window_slices_by_round_and_clamps_the_span() {
        let db = test_db("window.db");
        db.create_run("run-w", "t", "m", "prompt", &[], &[], "")
            .await;
        db.add_event(
            "run-w",
            1,
            "prompt",
            0,
            &serde_json::json!({ "text": "prompt" }),
        )
        .await;
        for round in 1..=20 {
            db.add_event(
                "run-w",
                round + 1,
                "content_delta",
                round,
                &serde_json::json!({ "text": format!("r{round}") }),
            )
            .await;
        }
        db.create_run("other", "t", "m", "p", &[], &[], "").await;
        db.add_event(
            "other",
            1,
            "content_delta",
            1,
            &serde_json::json!({ "text": "nope" }),
        )
        .await;

        let tail = db
            .round_window("run-w", None, None, Some(8))
            .await
            .expect("tail window");
        assert_eq!(tail["max_round"], 20);
        assert_eq!(tail["from"], 13);
        assert_eq!(tail["to"], 20);
        assert_eq!(tail["run"]["prompt"], "prompt");
        let events = tail["events"].as_array().unwrap();
        assert_eq!(events.len(), 9, "round 0 plus the last 8 rounds");
        assert_eq!(events[0]["round"], 0);
        assert_eq!(events[1]["round"], 13);
        assert_eq!(events[1]["payload"]["text"], "r13");
        assert_eq!(events.last().unwrap()["round"], 20);
        assert!(
            events
                .iter()
                .all(|event| event["payload"]["text"] != "nope")
        );

        let wide = db
            .round_window("run-w", Some(1), Some(100), None)
            .await
            .expect("clamped span");
        assert_eq!(wide["from"], 1);
        assert_eq!(wide["to"], 16);
        let wide_events = wide["events"].as_array().unwrap();
        assert_eq!(wide_events.len(), 17, "round 0 plus 16 rounds");
        assert_eq!(wide_events.last().unwrap()["round"], 16);

        let end = db
            .round_window("run-w", Some(18), Some(40), None)
            .await
            .expect("clamped to max");
        assert_eq!(end["from"], 18);
        assert_eq!(end["to"], 20);
        assert_eq!(end["events"].as_array().unwrap().len(), 4);

        let empty = db
            .round_window("run-w", Some(5), Some(4), None)
            .await
            .expect("empty positive range still returns the run");
        assert!(empty["to"].as_i64().unwrap() < empty["from"].as_i64().unwrap());
        assert!(
            empty["events"]
                .as_array()
                .unwrap()
                .iter()
                .all(|event| event["round"] == 0)
        );

        let bare = db.round_window("run-w", None, None, None).await.unwrap();
        assert_eq!(bare["from"], 13);
        assert_eq!(bare["to"], 20);

        assert!(
            db.round_window("missing", Some(1), Some(2), None)
                .await
                .is_none()
        );
    }

    #[test]
    fn open_failure_disables_gracefully() {
        let db = HistoryDb::open("/nonexistent-dir-xyz/harness.db");
        assert!(!db.enabled());
        assert!(!db.recording());
        let reason = db.failure_reason().expect("open failure is remembered");
        assert!(reason.contains("open failed"), "{reason}");
        assert!(db.block_reason(false).is_some());
        assert!(db.block_reason(true).is_none());
    }

    #[tokio::test]
    async fn a_failed_write_stops_later_recording() {
        let db = test_db("writefail.db");
        // Let the startup compaction take the connection before this test
        // makes it read-only.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(db.recording(), "a fresh database records");
        {
            let conn = db.inner.as_ref().unwrap().clone();
            let guard = conn.lock().unwrap();
            guard.execute_batch("PRAGMA query_only = ON").unwrap();
        }
        db.create_run("x", "t", "m", "prompt", &[], &[], "").await;
        assert!(db.enabled(), "past sessions stay readable");
        assert!(!db.recording(), "a failed write sticks");
        let reason = db.failure_reason().unwrap();
        let lower = reason.to_lowercase();
        assert!(
            lower.contains("readonly") || lower.contains("read-only"),
            "{reason}"
        );
        assert!(db.block_reason(false).unwrap().contains(&reason));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn transcripts_are_private_to_their_owner() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join("harness_history_perms");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("private.db");
        remove_history_files(&path);
        let db = HistoryDb::open(path.to_str().unwrap());
        assert!(db.enabled());
        // The database was created private, not with the process umask.
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "history db mode {mode:o}");
        // So are the write-ahead log and the shared-memory index.
        db.create_run("perm-test", "t", "m", "p", &[], &[], "")
            .await;
        for suffix in ["-wal", "-shm"] {
            let side = dir.join(format!("private.db{suffix}"));
            if side.exists() {
                let mode = std::fs::metadata(&side).unwrap().permissions().mode() & 0o777;
                assert_eq!(mode, 0o600, "{suffix} mode {mode:o}");
            }
        }
        remove_history_files(&path);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_new_database_is_created_private_right_away() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join("harness_history_perms_new");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("fresh.db");
        remove_history_files(&path);
        let db = HistoryDb::open(path.to_str().unwrap());
        assert!(db.enabled());
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "fresh history db mode {mode:o}");
        remove_history_files(&path);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_database_is_refused() {
        let dir = std::env::temp_dir().join("harness_history_symlink");
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("target.db");
        let link = dir.join("linked.db");
        let _ = std::fs::remove_file(&target);
        let _ = std::fs::remove_file(&link);
        std::fs::write(&target, b"").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let db = HistoryDb::open(link.to_str().unwrap());
        assert!(!db.enabled(), "symlinked history database must be refused");
        assert!(
            db.failure_reason().unwrap_or_default().contains("symlink"),
            "{:?}",
            db.failure_reason()
        );
        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_file(&target);
    }

    #[cfg(unix)]
    #[test]
    fn an_existing_world_readable_database_is_tightened() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join("harness_history_perms");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("loose.db");
        remove_history_files(&path);
        std::fs::write(&path, b"").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let db = HistoryDb::open(path.to_str().unwrap());
        assert!(db.enabled());
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "history db mode {mode:o}");
        remove_history_files(&path);
    }

    #[tokio::test]
    async fn deleting_a_little_does_not_rewrite_the_whole_file() {
        // A full VACUUM per delete rewrote the file every time; now the
        // file is only compacted once enough of it has been freed.
        let db = test_db("vacuum_small.db");
        for index in 0..40 {
            db.create_run(
                &format!("run-{index}"),
                "title",
                "model",
                &"x".repeat(2000),
                &[],
                &[],
                "",
            )
            .await;
        }
        assert!(db.delete_run("run-0").await);
        // The freed pages are still in the file (SQLite reuses them), so
        // no rewrite was triggered.
        assert!(db.free_pages().await > 0, "expected free pages to remain");
    }

    #[tokio::test]
    async fn freeing_a_lot_of_the_file_compacts_it() {
        let db = test_db("vacuum_large.db");
        for index in 0..40 {
            db.create_run(
                &format!("run-{index}"),
                "title",
                "model",
                &"x".repeat(2000),
                &[],
                &[],
                "",
            )
            .await;
        }
        // Deleting frees pages; once enough of the file is free the
        // database is compacted and the pages are handed back.
        let mut compacted = false;
        for index in 1..40 {
            assert!(db.delete_run(&format!("run-{index}")).await);
            if db.free_pages().await == 0 {
                compacted = true;
                break;
            }
        }
        assert!(
            compacted,
            "the file should be compacted once enough is free"
        );
    }

    #[tokio::test]
    async fn comment_tag_round_trips_and_old_databases_gain_the_column() {
        let dir = std::env::temp_dir().join("harness_history_test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("legacy-comment.db");
        remove_history_files(&path);
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE runs (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    model TEXT NOT NULL,
                    prompt TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'running',
                    totals_prompt INTEGER NOT NULL DEFAULT 0,
                    totals_completion INTEGER NOT NULL DEFAULT 0,
                    wall_ms INTEGER NOT NULL DEFAULT 0,
                    tool_names TEXT NOT NULL DEFAULT '[]',
                    uploaded_files TEXT NOT NULL DEFAULT '[]'
                );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO runs (id, title, created_at, model, prompt, status) VALUES ('old', 't', 1, 'm', 'p', 'done')",
                [],
            )
            .unwrap();
        }
        let db = HistoryDb::open(path.to_str().unwrap());
        assert!(db.enabled(), "{:?}", db.failure_reason());
        let old = db.get_run("old").await.flatten().expect("migrated run");
        assert_eq!(old["run"]["comment_tag"], "");
        db.create_run("new", "t", "m", "p", &[], &[], "abc123def456")
            .await;
        let fresh = db.get_run("new").await.flatten().expect("new run");
        assert_eq!(fresh["run"]["comment_tag"], "abc123def456");
        remove_history_files(&path);
    }

    #[tokio::test]
    async fn a_running_row_left_by_a_stopped_harness_is_marked_aborted() {
        let dir = std::env::temp_dir().join("harness_history_test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("orphan-running.db");
        remove_history_files(&path);
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE runs (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    model TEXT NOT NULL,
                    prompt TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'running',
                    totals_prompt INTEGER NOT NULL DEFAULT 0,
                    totals_completion INTEGER NOT NULL DEFAULT 0,
                    wall_ms INTEGER NOT NULL DEFAULT 0,
                    tool_names TEXT NOT NULL DEFAULT '[]',
                    uploaded_files TEXT NOT NULL DEFAULT '[]'
                );
                CREATE TABLE events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL,
                    seq INTEGER NOT NULL,
                    type TEXT NOT NULL,
                    round INTEGER NOT NULL DEFAULT 0,
                    payload TEXT NOT NULL DEFAULT '{}',
                    created_at INTEGER NOT NULL
                );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO runs (id, title, created_at, model, prompt, status) VALUES ('orphan', 'left open', 1, 'm', 'p', 'running')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO runs (id, title, created_at, model, prompt, status) VALUES ('kept', 'finished', 2, 'm', 'p', 'done')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO events (run_id, seq, type, round, payload, created_at) VALUES ('orphan', 1, 'tool_call', 3, '{}', 1)",
                [],
            )
            .unwrap();
        }
        let db = HistoryDb::open(path.to_str().unwrap());
        assert!(db.enabled(), "{:?}", db.failure_reason());
        let orphan = db.get_run("orphan").await.flatten().expect("orphan");
        assert_eq!(orphan["run"]["status"], "aborted");
        let events = orphan["events"].as_array().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1]["type"], "error");
        assert_eq!(events[1]["seq"], 2);
        assert_eq!(events[1]["round"], 3);
        assert_eq!(
            events[1]["payload"]["message"],
            "The harness stopped while this run was still open."
        );
        let kept = db.get_run("kept").await.flatten().expect("kept");
        assert_eq!(kept["run"]["status"], "done");
        assert!(kept["events"].as_array().unwrap().is_empty());

        drop(db);
        let again = HistoryDb::open(path.to_str().unwrap());
        let orphan = again.get_run("orphan").await.flatten().expect("still there");
        assert_eq!(orphan["run"]["status"], "aborted");
        assert_eq!(orphan["events"].as_array().unwrap().len(), 2);
        remove_history_files(&path);
    }

    #[test]
    fn a_new_history_file_is_not_plaintext_sqlite() {
        let dir = std::env::temp_dir().join("harness_history_test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("fresh-encrypted.db");
        remove_history_files(&path);
        let db = HistoryDb::open(path.to_str().unwrap());
        assert!(db.enabled(), "{:?}", db.failure_reason());
        drop(db);
        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.len() >= 16, "encrypted history file is too small");
        assert_ne!(&bytes[..16], b"SQLite format 3\0");
        remove_history_files(&path);
    }

    #[tokio::test]
    async fn memory_history_still_records() {
        let db = HistoryDb::open(":memory:");
        assert!(db.recording(), "{:?}", db.failure_reason());
        db.create_run("m", "t", "m", "p", &[], &[], "").await;
        assert!(db.get_run("m").await.flatten().is_some());
    }

    #[test]
    fn a_short_or_blank_passphrase_is_refused() {
        for key in ["", "   ", "short", "12345678901"] {
            let db = HistoryDb::open_with_passphrase(":memory:", key);
            assert!(!db.enabled(), "{key:?} was accepted");
            let reason = db.failure_reason().expect("a reason");
            assert!(
                reason.contains("at least 12") || reason.contains("empty"),
                "{reason}"
            );
            if !key.is_empty() {
                assert!(
                    !reason.contains(key),
                    "failure reason echoed the passphrase"
                );
            }
        }
        let oversized = "k".repeat(1025);
        let db = HistoryDb::open_with_passphrase(":memory:", &oversized);
        assert!(!db.enabled());
        let reason = db.failure_reason().unwrap();
        assert!(reason.contains("too long"), "{reason}");
        assert!(!reason.contains(&oversized));
    }

    #[tokio::test]
    async fn plaintext_history_is_encrypted_and_the_sentinel_is_not_in_the_file() {
        let dir = std::env::temp_dir().join("harness_history_test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sentinel.db");
        remove_history_files(&path);
        let sentinel = "PLAINTEXT-SENTINEL";
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE runs (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    model TEXT NOT NULL,
                    prompt TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'running',
                    totals_prompt INTEGER NOT NULL DEFAULT 0,
                    totals_completion INTEGER NOT NULL DEFAULT 0,
                    wall_ms INTEGER NOT NULL DEFAULT 0,
                    tool_names TEXT NOT NULL DEFAULT '[]',
                    uploaded_files TEXT NOT NULL DEFAULT '[]'
                );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO runs (id, title, created_at, model, prompt, status) VALUES ('kept', 't', 1, 'm', ?1, 'done')",
                [sentinel],
            )
            .unwrap();
        }
        let padded = "  history test key  ";
        let db = HistoryDb::open_with_passphrase(path.to_str().unwrap(), padded);
        assert!(db.enabled(), "{:?}", db.failure_reason());
        let run = db.get_run("kept").await.flatten().expect("migrated run");
        assert_eq!(run["run"]["prompt"], sentinel);
        drop(db);

        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.len() >= 16);
        assert_ne!(&bytes[..16], b"SQLite format 3\0");
        assert!(
            !bytes
                .windows(sentinel.len())
                .any(|window| window == sentinel.as_bytes()),
            "sentinel still present in the encrypted file"
        );
        for suffix in ["-wal", "-shm", ".plaintext", ".encrypting"] {
            let side = dir.join(format!("sentinel.db{suffix}"));
            if let Ok(side_bytes) = std::fs::read(&side) {
                assert!(
                    !side_bytes
                        .windows(sentinel.len())
                        .any(|window| window == sentinel.as_bytes()),
                    "sentinel still present in {suffix}"
                );
            }
        }
        assert!(!dir.join("sentinel.db.plaintext").exists());
        assert!(!dir.join("sentinel.db.encrypting").exists());

        let again = HistoryDb::open_with_passphrase(path.to_str().unwrap(), "history test key");
        assert!(again.enabled(), "{:?}", again.failure_reason());
        let run = again.get_run("kept").await.flatten().expect("reopened run");
        assert_eq!(run["run"]["prompt"], sentinel);
        remove_history_files(&path);
    }

    #[tokio::test]
    async fn a_wrong_passphrase_does_not_open_and_is_not_echoed() {
        let dir = std::env::temp_dir().join("harness_history_test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("wrong-key.db");
        remove_history_files(&path);
        let right = "correct-passphrase";
        let wrong = "other-passphrase!";
        let db = HistoryDb::open_with_passphrase(path.to_str().unwrap(), right);
        assert!(db.enabled(), "{:?}", db.failure_reason());
        db.create_run("kept", "t", "m", "secret-row", &[], &[], "")
            .await;
        drop(db);

        let denied = HistoryDb::open_with_passphrase(path.to_str().unwrap(), wrong);
        assert!(!denied.enabled());
        let reason = denied.failure_reason().expect("wrong key is remembered");
        assert!(reason.contains("does not open"), "{reason}");
        assert!(
            !reason.contains(right),
            "failure reason echoed the passphrase"
        );
        assert!(
            !reason.contains(wrong),
            "failure reason echoed the passphrase"
        );
        assert!(std::path::Path::new(path.to_str().unwrap()).exists());

        let again = HistoryDb::open_with_passphrase(path.to_str().unwrap(), right);
        assert!(again.enabled(), "{:?}", again.failure_reason());
        let run = again.get_run("kept").await.flatten().expect("row survived");
        assert_eq!(run["run"]["prompt"], "secret-row");
        remove_history_files(&path);
    }

    struct TempTree {
        root: PathBuf,
    }

    impl TempTree {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "harness-locate-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn locate<'a>(
            &'a self,
            cli: Option<&'a str>,
            env_path: Option<&'a OsStr>,
            xdg: Option<&'a OsStr>,
            home: Option<&'a OsStr>,
        ) -> Result<HistoryLocation, String> {
            locate_history(HistoryLocateInput {
                workspace: &self.root.join("ws"),
                cli_path: cli,
                env_path,
                xdg_data_home: xdg,
                home,
            })
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn the_default_path_is_xdg_then_home_and_the_directory_is_private() {
        let tree = TempTree::new();
        std::fs::create_dir_all(tree.root.join("ws")).unwrap();
        let missing = tree.locate(None, None, None, None).unwrap_err();
        assert!(missing.contains("HARNESS_DB_PATH"), "{missing}");
        assert!(missing.contains("HOME"), "{missing}");

        let home = tree.root.join("home");
        let located = tree
            .locate(None, None, None, Some(home.as_os_str()))
            .unwrap();
        let expected = home.join(".local/share/harness/harness.db");
        assert_eq!(located.path, expected);
        assert!(
            located
                .messages
                .iter()
                .any(|message| message.contains("~/.local/share")),
            "{:?}",
            located.messages
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(expected.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o700, "{mode:o}");
        }
        assert!(
            located
                .messages
                .iter()
                .any(|message| message.contains("mode 0700")),
            "{:?}",
            located.messages
        );

        let xdg = tree.root.join("xdg");
        let located = tree
            .locate(None, None, Some(xdg.as_os_str()), Some(home.as_os_str()))
            .unwrap();
        assert_eq!(located.path, xdg.join("harness/harness.db"));
        assert!(
            located
                .messages
                .iter()
                .any(|message| message.contains("XDG_DATA_HOME"))
        );

        let located = tree
            .locate(None, None, Some(OsStr::new("")), Some(home.as_os_str()))
            .unwrap();
        assert_eq!(located.path, expected);
    }

    #[test]
    fn cli_history_wins_over_the_environment_and_warns_inside_the_workspace() {
        let tree = TempTree::new();
        let workspace = tree.root.join("ws");
        std::fs::create_dir_all(&workspace).unwrap();
        let cli = workspace.join("custom.db");
        let env = tree.root.join("env.db");
        let located = tree
            .locate(
                Some(cli.to_str().unwrap()),
                Some(env.as_os_str()),
                None,
                None,
            )
            .unwrap();
        assert_eq!(located.path, cli);
        let text = located.messages.join("\n");
        assert!(text.contains("--history"), "{text}");
        assert!(text.contains("was not used"), "{text}");
        assert!(text.contains("inside the workspace"), "{text}");
    }

    #[test]
    fn a_workspace_database_moves_with_its_sidecars_and_does_not_overwrite() {
        let tree = TempTree::new();
        let workspace = tree.root.join("ws");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(workspace.join("harness.db"), b"db-bytes").unwrap();
        std::fs::write(workspace.join("harness.db-wal"), b"wal-bytes").unwrap();
        std::fs::write(workspace.join("harness.db-shm"), b"shm-bytes").unwrap();
        let home = tree.root.join("home");
        let located = tree
            .locate(None, None, None, Some(home.as_os_str()))
            .unwrap();
        let dest = home.join(".local/share/harness/harness.db");
        assert_eq!(located.path, dest);
        assert_eq!(std::fs::read(&dest).unwrap(), b"db-bytes");
        assert_eq!(
            std::fs::read(sidecar_path(&dest, "-wal")).unwrap(),
            b"wal-bytes"
        );
        assert_eq!(
            std::fs::read(sidecar_path(&dest, "-shm")).unwrap(),
            b"shm-bytes"
        );
        assert!(!workspace.join("harness.db").exists());
        assert!(!workspace.join("harness.db-wal").exists());
        assert!(!workspace.join("harness.db-shm").exists());
        let text = located.messages.join("\n");
        assert!(text.contains("moved"), "{text}");
        assert!(text.contains("harness.db-wal"), "{text}");

        std::fs::write(workspace.join("harness.db"), b"newer").unwrap();
        std::fs::write(workspace.join("harness.db-wal"), b"newer-wal").unwrap();
        let again = tree
            .locate(None, None, None, Some(home.as_os_str()))
            .unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"db-bytes");
        assert_eq!(
            std::fs::read(workspace.join("harness.db")).unwrap(),
            b"newer"
        );
        assert_eq!(
            std::fs::read(sidecar_path(&dest, "-wal")).unwrap(),
            b"wal-bytes"
        );
        let text = again.messages.join("\n");
        assert!(text.contains("left"), "{text}");
        assert!(text.contains("already exists"), "{text}");
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_database_is_not_moved() {
        let tree = TempTree::new();
        let workspace = tree.root.join("ws");
        std::fs::create_dir_all(&workspace).unwrap();
        let target = tree.root.join("elsewhere.db");
        std::fs::write(&target, b"secret-bytes").unwrap();
        std::os::unix::fs::symlink(&target, workspace.join("harness.db")).unwrap();
        let home = tree.root.join("home");
        let located = tree
            .locate(None, None, None, Some(home.as_os_str()))
            .unwrap();
        let text = located.messages.join("\n");
        assert!(text.contains("symlink"), "{text}");
        assert!(text.contains("not moved"), "{text}");
        assert!(!home.join(".local/share/harness/harness.db").exists());
        assert_eq!(std::fs::read(&target).unwrap(), b"secret-bytes");
        assert!(
            std::fs::symlink_metadata(workspace.join("harness.db"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[test]
    fn copy_file_exact_refuses_an_existing_destination() {
        let tree = TempTree::new();
        let src = tree.root.join("src.db");
        let dest = tree.root.join("dest.db");
        std::fs::write(&src, b"abc").unwrap();
        std::fs::write(&dest, b"keep").unwrap();
        let error = copy_file_exact(&src, &dest).unwrap_err();
        assert!(error.contains("refused"), "{error}");
        assert_eq!(std::fs::read(&dest).unwrap(), b"keep");
        let fresh = tree.root.join("fresh.db");
        copy_file_exact(&src, &fresh).unwrap();
        assert_eq!(std::fs::read(&fresh).unwrap(), b"abc");
        assert_eq!(std::fs::read(&src).unwrap(), b"abc");
    }

    #[test]
    fn session_only_history_follows_the_mode_and_the_explicit_paths() {
        use crate::keys::StartupMode;
        // A plain start with nothing explicit: history is session-only.
        assert!(session_only_location(StartupMode::PlainSession, None, None));
        // An empty string counts as absent, like locate_history's filter.
        assert!(session_only_location(
            StartupMode::PlainSession,
            Some(""),
            Some(std::ffi::OsStr::new(""))
        ));
        // An explicit --history or HARNESS_DB_PATH is honored, so the
        // location stays a real file (with the caveat the caller prints).
        assert!(!session_only_location(
            StartupMode::PlainSession,
            Some("/tmp/throwaway.db"),
            None
        ));
        assert!(!session_only_location(
            StartupMode::PlainSession,
            None,
            Some(std::ffi::OsStr::new("/tmp/throwaway.db"))
        ));
        // Encrypted and environment starts always use the real database.
        assert!(!session_only_location(StartupMode::Encrypted, None, None));
        assert!(!session_only_location(StartupMode::EnvImported, None, None));
        assert!(!session_only_location(
            StartupMode::EnvImported,
            Some("/tmp/x.db"),
            None
        ));
    }

    #[test]
    fn in_memory_history_opens_recording_without_a_refusal_wall() {
        // The :memory: location a plain start uses opens and records,
        // and the sibling memory store stays in memory beside it.
        let db = HistoryDb::open(":memory:");
        assert!(db.recording(), "session-only history is usable");
        assert!(db.block_reason(false).is_none(), "no refusal wall");
        assert_eq!(crate::memory::path_beside(":memory:"), ":memory:");
    }
}
