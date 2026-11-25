//! Bounded capture of a child process' stdout and stderr.
//!
//! Every tool process is spawned through this module so these
//! properties hold everywhere:
//!
//! - **Bounded memory.** Output is streamed and cut at the cap *while
//!   the process runs*. Buffering everything first and trimming
//!   afterwards (the previous behaviour) let a 30-second `yes` grow
//!   gigabytes in RAM before the trim ever ran — the trim bounded what
//!   was kept, not what was captured.
//! - **Bounded lifetime.** The child starts in its own process group
//!   and the whole group is killed on timeout, so a backgrounded
//!   grandchild of `bash -c` does not outlive the tool call.
//! - **No inherited stdin.** A tool can never consume the harness'
//!   own terminal input.
//! - **No secret environment.** `XAI_API_KEY`, `REFLECTION_API_KEY`,
//!   `HARNESS_DB_KEY`, and the re-exec handoff descriptor are removed from
//!   the child's environment.
//!   The parent is non-dumpable, so the child also cannot read those
//!   values back from `/proc/<pid>/environ` or `/proc/<pid>/mem`. Children
//!   inherit the non-dumpable flag. `/proc/<pid>/stat` stays readable.
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

/// Prefix of the marker appended to a stream that hit the cap. The
/// existing `[tool output truncated:` wording is kept so transcripts
/// and tests can match on it.
pub(crate) const TRUNCATED_MARKER: &str = "[tool output truncated:";

/// How long to keep draining the pipes after the child exited. A
/// backgrounded grandchild can hold a pipe open; the tool call must not
/// wait for it forever.
const DRAIN_GRACE: Duration = Duration::from_secs(5);

/// Process groups of the tool processes that are currently running.
/// Used by the shutdown handler: a tool process lives in its own
/// group, so it would not receive the terminal's Ctrl-C.
static LIVE_GROUPS: std::sync::LazyLock<Mutex<HashMap<u32, Arc<GroupState>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Kill every tool process group that is still running. Called when the
/// harness itself is asked to stop. Going through `GroupState::kill`
/// keeps the armed/start-time checks: a pid that has already been reaped
/// and possibly recycled is never signaled blindly.
pub(crate) fn kill_all_groups() {
    let groups: Vec<Arc<GroupState>> = LIVE_GROUPS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .values()
        .cloned()
        .collect();
    for state in groups {
        state.kill();
    }
}

/// Shared state of one tool process group.
struct GroupState {
    pid: u32,
    /// `/proc/<pid>/stat` start time captured at spawn. If the pid is
    /// recycled, this value changes and the group must not be signaled.
    start_time: Option<u64>,
    /// Whether the group may still be killed. Cleared once the child
    /// has been reaped: after that the pid can be recycled, and killing
    /// a recycled pid would hit an unrelated process.
    armed: AtomicBool,
}

impl GroupState {
    /// Kill the group — only while it is safe to do so.
    fn kill(&self) {
        if !self.armed.load(Ordering::Relaxed) {
            return;
        }
        // The armed flag closes the reaped-pid window; the start-time
        // check closes the pid-reuse window even if shutdown races the
        // reap on another thread. On platforms without /proc this is
        // None and the armed check remains the guard.
        if let Some(expected) = self.start_time
            && process_start_time(self.pid) != Some(expected)
        {
            return;
        }
        kill_group(self.pid);
    }

    /// Stop tracking the group (the child has been reaped, or it is
    /// gone).
    fn disarm(&self) {
        self.armed.store(false, Ordering::Relaxed);
        LIVE_GROUPS
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.pid);
    }
}

/// The start time field (22) from `/proc/<pid>/stat`, used to distinguish
/// a live process from a recycled pid. Linux-only in practice; elsewhere
/// this returns None and callers retain the armed-flag guard.
pub(crate) fn process_start_time(pid: u32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The comm field (field 2) is parenthesized and may contain spaces or
    // parentheses; split after the last ')' and count from field 3.
    let close = stat.rfind(')')?;
    let fields: Vec<&str> = stat[close + 1..].split_whitespace().collect();
    // starttime is field 22 overall; state is field 3, so index 19.
    fields.get(19)?.parse().ok()
}

/// Keeps a tool process group from outliving the harness. Dropping the
/// capture (an aborted run, a disconnected client, a shut-down harness)
/// takes the whole group down.
struct GroupGuard {
    state: Arc<GroupState>,
}

impl Drop for GroupGuard {
    fn drop(&mut self) {
        // The ordinary group kill is one signal: keep it in the drop,
        // so the armed check still runs before the disarm below.
        self.state.kill();
        self.state.disarm();
    }
}

/// Result of one captured child process.
pub(crate) struct Captured {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    /// The process was still running when the timeout elapsed.
    pub timed_out: bool,
    /// The process could not be started at all.
    pub spawn_error: Option<String>,
}

/// Text returned to the model, with the process status kept beside it.
/// `exit_code` is history metadata and is not part of `text`. `None`
/// means the OS reported no code (the process never started, or it was
/// killed). Do not substitute a sentinel such as `-1`.
#[derive(Debug, Clone)]
pub(crate) struct CapturedText {
    pub text: String,
    pub exit_code: Option<i32>,
}

impl Captured {
    /// Transcript note for a process that was killed at the timeout.
    pub(crate) fn timeout_note(&self, secs: u64) -> Option<String> {
        self.timed_out
            .then(|| format!("(timed out after {secs}s and was killed)"))
    }
}

/// Shared buffer for one stream: the bytes captured so far plus the
/// truncation flag. Shared so the bytes survive a drain timeout (the
/// reader task may still be running when we stop waiting for it).
struct Sink {
    bytes: Mutex<Vec<u8>>,
    truncated: AtomicBool,
    cap: usize,
}

impl Sink {
    fn new(cap: usize) -> Self {
        Sink {
            bytes: Mutex::new(Vec::new()),
            truncated: AtomicBool::new(false),
            cap,
        }
    }

    /// Take the captured bytes, with an explicit marker when the stream
    /// was cut short.
    fn take(&self) -> String {
        let bytes = {
            let mut guard = self.bytes.lock().unwrap_or_else(|p| p.into_inner());
            std::mem::take(&mut *guard)
        };
        let mut text = String::from_utf8_lossy(&bytes).into_owned();
        if self.truncated.load(Ordering::Relaxed) {
            text.push_str(&format!(
                "\n…{TRUNCATED_MARKER} output exceeded the {} byte cap]",
                self.cap
            ));
        }
        text
    }
}

/// Run `program` with `args` in `cwd`, capturing at most `cap` bytes per
/// stream and killing the process group after `timeout`.
pub(crate) async fn run(
    program: &Path,
    args: &[String],
    cwd: &Path,
    timeout: Duration,
    cap: usize,
) -> Captured {
    run_for(program, args, cwd, Some(timeout), cap).await
}

/// Same capture as [`run`]. `timeout: None` waits until the process exits,
/// the output cap is hit, or this future is dropped (Stop run, a
/// disconnect, or harness shutdown). There is no clock limit.
pub(crate) async fn run_for(
    program: &Path,
    args: &[String],
    cwd: &Path,
    timeout: Option<Duration>,
    cap: usize,
) -> Captured {
    run_prepared(CaptureSpec {
        program: program.to_path_buf(),
        args: args.to_vec(),
        cwd: cwd.to_path_buf(),
        timeout,
        cap,
        clear_env: false,
        env: Vec::new(),
    })
    .await
}

/// One prepared child. `clear_env` replaces the environment with `env`.
pub(crate) struct CaptureSpec {
    pub program: std::path::PathBuf,
    pub args: Vec<String>,
    pub cwd: std::path::PathBuf,
    pub timeout: Option<Duration>,
    pub cap: usize,
    pub clear_env: bool,
    pub env: Vec<(String, String)>,
}

/// Same capture as [`run_for`], with an explicit environment.
pub(crate) async fn run_prepared(spec: CaptureSpec) -> Captured {
    let start = Instant::now();
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if spec.clear_env {
        command.env_clear();
        for (key, value) in &spec.env {
            command.env(key, value);
        }
    } else {
        // One list with the provider registry: every provider API key and
        // the history passphrase, so a provider added to the registry is
        // scrubbed here without touching this file.
        for name in crate::providers::secret_env_vars() {
            command.env_remove(name);
        }
        // The re-exec handoff descriptor is closed before any tool runs.
        // Strip the name anyway so a child does not see a stale fd number.
        command.env_remove(crate::harden::HANDOFF_FD_VAR);
    }
    #[cfg(unix)]
    {
        // Own process group: the group is killed as a unit, so a
        // backgrounded grandchild of `bash -c` dies with the tool call.
        command.process_group(0);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            return Captured {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: None,
                duration_ms: start.elapsed().as_millis() as u64,
                timed_out: false,
                spawn_error: Some(e.to_string()),
            };
        }
    };

    let pid = child.id().unwrap_or(0);
    // From here on the group is tracked: an aborted run, a disconnected
    // client or a shut-down harness takes the tool process with it.
    let state = Arc::new(GroupState {
        pid,
        start_time: process_start_time(pid),
        armed: AtomicBool::new(pid != 0),
    });
    if pid != 0 {
        LIVE_GROUPS
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(pid, state.clone());
    }
    let _group = GroupGuard {
        state: state.clone(),
    };
    let out_sink = Arc::new(Sink::new(spec.cap));
    let err_sink = Arc::new(Sink::new(spec.cap));
    let mut out_task = tokio::spawn(read_capped(
        child.stdout.take(),
        out_sink.clone(),
        state.clone(),
    ));
    let mut err_task = tokio::spawn(read_capped(
        child.stderr.take(),
        err_sink.clone(),
        state.clone(),
    ));

    // One sleep shared by both phases. After it fires, polling it again
    // completes immediately, so the reap does not start a second budget.
    // `None` disables the branch: the call waits until the process ends.
    let mut deadline = spec
        .timeout
        .map(|limit| Box::pin(tokio::time::sleep(limit)));
    let limited = deadline.is_some();
    let mut timed_out = false;

    // Phase 1: wait for both pipes to reach EOF. The child is *not*
    // reaped yet: while it is unreaped its pid is reserved, so the
    // group can still be killed safely.
    let mut out_done = false;
    let mut err_done = false;
    while !(out_done && err_done) {
        tokio::select! {
            _ = &mut out_task, if !out_done => out_done = true,
            _ = &mut err_task, if !err_done => err_done = true,
            _ = async {
                match deadline.as_mut() {
                    Some(sleep) => sleep.as_mut().await,
                    None => std::future::pending::<()>().await,
                }
            }, if limited => {
                timed_out = true;
                // The kill runs off the Tokio worker so a timeout arm
                // never blocks a worker thread.
                let kill_state = Arc::clone(&state);
                let _ = tokio::task::spawn_blocking(move || kill_state.kill()).await;
                break;
            }
        }
    }

    // Phase 2: reap the child. The pipes are closed, so it is about to
    // be done; the deadline still applies.
    let status = {
        let waited = tokio::select! {
            status = child.wait() => Some(status.ok()),
            _ = async {
                match deadline.as_mut() {
                    Some(sleep) => sleep.as_mut().await,
                    None => std::future::pending::<()>().await,
                }
            }, if limited => None,
        };
        match waited {
            Some(status) => status,
            None => {
                timed_out = true;
                // Same as the phase-1 timeout: the kill runs off the
                // worker.
                let kill_state = Arc::clone(&state);
                let _ = tokio::task::spawn_blocking(move || kill_state.kill()).await;
                let _ = child.start_kill();
                child.wait().await.ok()
            }
        }
    };
    // The child is reaped: its pid can be recycled from here on, so the
    // group must not be killed by pid any more.
    state.disarm();

    // Drain what is left, but never wait forever for a pipe held open by
    // a surviving grandchild. A stream that already reached EOF is
    // finished — its handle must not be polled again.
    if !out_done {
        let _ = tokio::time::timeout(DRAIN_GRACE, &mut out_task).await;
        out_task.abort();
    }
    if !err_done {
        let _ = tokio::time::timeout(DRAIN_GRACE, &mut err_task).await;
        err_task.abort();
    }

    let stdout = out_sink.take();
    let stderr = err_sink.take();
    Captured {
        stdout,
        stderr,
        exit_code: status.and_then(|s| s.code()),
        duration_ms: start.elapsed().as_millis() as u64,
        timed_out,
        spawn_error: None,
    }
}

/// Read one stream into `sink`, stopping at the cap. Crossing the cap
/// takes the whole process group down: the child would otherwise block
/// on a pipe nobody drains, and it may have children of its own.
async fn read_capped<R>(pipe: Option<R>, sink: Arc<Sink>, state: Arc<GroupState>)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    let Some(mut pipe) = pipe else { return };
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let read = match pipe.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        let crossed = {
            let mut guard = sink.bytes.lock().unwrap_or_else(|p| p.into_inner());
            let room = sink.cap.saturating_sub(guard.len());
            if read > room {
                guard.extend_from_slice(&chunk[..room]);
                sink.truncated.store(true, Ordering::Relaxed);
                true
            } else {
                guard.extend_from_slice(&chunk[..read]);
                false
            }
        };
        if crossed {
            // Cap crossing can happen on a Tokio worker; the kill stays
            // off it so the stream task is never blocked by it.
            let kill_state = Arc::clone(&state);
            let _ = tokio::task::spawn_blocking(move || kill_state.kill()).await;
            return;
        }
    }
}

/// Kill the child's whole process group. The child is started as a
/// group leader, so the negative pid addresses the group and reaches
/// grandchildren too.
#[cfg(unix)]
fn kill_group(pid: u32) {
    let Ok(pid) = i32::try_from(pid) else { return };
    if pid <= 0 {
        return;
    }
    // SAFETY: `kill` takes no pointers and is async-signal-safe; the
    // negative pid targets the process group the child leads.
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_group(_pid: u32) {}

#[cfg(test)]
mod capture_tests {
    use super::*;
    use crate::config::MAX_TOOL_OUTPUT_BYTES;

    #[tokio::test]
    async fn captures_output_and_exit_code() {
        let captured = run(
            Path::new("/bin/sh"),
            &[
                "-c".to_string(),
                "printf hello; printf oops >&2".to_string(),
            ],
            Path::new("."),
            Duration::from_secs(10),
            1024,
        )
        .await;
        assert!(captured.spawn_error.is_none(), "{:?}", captured.spawn_error);
        assert_eq!(captured.stdout, "hello");
        assert_eq!(captured.stderr, "oops");
        assert_eq!(captured.exit_code, Some(0));
        assert!(!captured.timed_out);
        assert!(!captured.stdout.contains(TRUNCATED_MARKER));
    }

    #[tokio::test]
    async fn output_past_the_cap_is_cut_and_the_process_is_killed() {
        // 1 MiB of output against a 64 KiB cap: the stream is cut, the
        // marker says so, and the memory held stays at the cap.
        let captured = run(
            Path::new("/bin/sh"),
            &[
                "-c".to_string(),
                "head -c 1048576 /dev/zero | tr '\\0' y".to_string(),
            ],
            Path::new("."),
            Duration::from_secs(10),
            64 * 1024,
        )
        .await;
        assert!(
            captured.stdout.contains(TRUNCATED_MARKER),
            "{}",
            captured.stdout
        );
        assert!(
            captured.stdout.len() <= 64 * 1024 + 200,
            "{}",
            captured.stdout.len()
        );
        // Killed by the cap, so there is no exit code to report.
        assert_eq!(captured.exit_code, None);
    }

    #[tokio::test]
    async fn the_cap_keeps_memory_bounded_at_the_configured_limit() {
        // The whole point of the streaming cap: a runaway `yes` cannot
        // grow the capture without bound.
        let captured = run(
            Path::new("/bin/sh"),
            &["-c".to_string(), "yes y".to_string()],
            Path::new("."),
            Duration::from_secs(10),
            128 * 1024,
        )
        .await;
        assert!(captured.stdout.contains(TRUNCATED_MARKER));
        assert!(
            captured.stdout.len() <= 128 * 1024 + 200,
            "{}",
            captured.stdout.len()
        );
    }

    #[tokio::test]
    async fn a_timeout_kills_the_process_group() {
        let captured = run(
            Path::new("/bin/sh"),
            &["-c".to_string(), "sleep 30".to_string()],
            Path::new("."),
            Duration::from_millis(300),
            1024,
        )
        .await;
        assert!(captured.timed_out);
        assert_eq!(captured.exit_code, None);
        assert!(captured.timeout_note(30).is_some());
    }

    #[tokio::test]
    async fn a_backgrounded_grandchild_does_not_survive_the_timeout() {
        // The grandchild holds the inherited stdout pipe open; without
        // a process-group kill it would keep running (and keep the tool
        // call waiting) after the parent shell was killed.
        let marker = std::env::temp_dir().join("harness_capture_grandchild.pid");
        let _ = std::fs::remove_file(&marker);
        let captured = run(
            Path::new("/bin/sh"),
            &[
                "-c".to_string(),
                format!("(sleep 30 & echo $! > {}) ; sleep 30", marker.display()),
            ],
            Path::new("."),
            Duration::from_millis(300),
            1024,
        )
        .await;
        assert!(captured.timed_out);
        // Give the group a moment to die, then check the pid is gone.
        let pid: i32 = std::fs::read_to_string(&marker)
            .ok()
            .and_then(|t| t.trim().parse().ok())
            .expect("grandchild pid recorded");
        let mut alive = true;
        for _ in 0..50 {
            if !Path::new(&format!("/proc/{pid}")).exists() {
                alive = false;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if alive {
            // Not observable through /proc (non-Linux): kill it anyway
            // so the test leaves nothing behind.
            let _ = std::process::Command::new("kill")
                .arg("-9")
                .arg(pid.to_string())
                .status();
        }
        assert!(!alive, "grandchild {pid} outlived the tool call");
    }

    #[tokio::test]
    async fn dropping_the_capture_kills_the_process_group() {
        // An aborted run (client disconnect, /stop) drops the capture
        // future: the tool process must not survive it.
        let marker = std::env::temp_dir().join("harness_capture_abort.pid");
        let _ = std::fs::remove_file(&marker);
        let marker_in_child = marker.clone();
        let handle = tokio::spawn(async move {
            run(
                Path::new("/bin/sh"),
                &[
                    "-c".to_string(),
                    format!("echo $$ > {}; sleep 30", marker_in_child.display()),
                ],
                Path::new("."),
                Duration::from_secs(30),
                1024,
            )
            .await
        });
        let pid = wait_for_pid(&marker).await;
        handle.abort();
        let _ = handle.await;
        let mut alive = true;
        for _ in 0..50 {
            if !Path::new(&format!("/proc/{pid}")).exists() {
                alive = false;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if alive {
            let _ = std::process::Command::new("kill")
                .arg("-9")
                .arg(pid.to_string())
                .status();
        }
        assert!(!alive, "tool process {pid} outlived the aborted capture");
    }

    /// Wait for a child to record its pid, then return it.
    async fn wait_for_pid(marker: &Path) -> i32 {
        for _ in 0..100 {
            if let Ok(text) = std::fs::read_to_string(marker)
                && let Ok(pid) = text.trim().parse::<i32>()
            {
                return pid;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("the child never recorded its pid");
    }

    #[tokio::test]
    async fn the_default_cap_matches_the_configured_limit() {
        // The default tool cap is the one the harness advertises.
        assert_eq!(MAX_TOOL_OUTPUT_BYTES, 4 * 1024 * 1024);
    }
}
