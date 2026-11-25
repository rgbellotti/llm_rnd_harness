//! RAG corpus tools. Each `*.rag.db` in the workspace root that passes
//! `rag_meta` validation is registered as its own tool, named after the
//! sanitized corpus name: `godot_docs.rag.db` → `godot_docs_search`.
//! No universal loader — the model sees one purpose-built tool per corpus
//! and no other RAG plumbing; disabling a corpus in the config view drops
//! it from the next session's tool list entirely (zero schema tokens).
//!
//! All RAG databases are read-only, pre-built SQLite files matching the
//! `rag_document` / `rag_node` / `rag_meta` schema. The embedding matrix
//! is decoded lazily on the first search of a corpus (the Godot corpus is
//! ~90 MB) and cached for the process lifetime.
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, LazyLock, RwLock};

use ollama_rs::{
    Ollama,
    generation::embeddings::request::{EmbeddingsInput, GenerateEmbeddingsRequest},
    generation::tools::ToolInfo,
};
use rusqlite::{Connection, OpenFlags, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Hard bounds on a corpus. A `.rag.db` in the workspace is untrusted
/// input; these keep a malicious or corrupt corpus from turning a search
/// into an OOM.
const MAX_RAG_DIMS: usize = 16_384;
const MAX_RAG_CHUNKS: usize = 2_000_000;
const MAX_RAG_MATRIX_BYTES: usize = 512 * 1024 * 1024;
const MAX_RAG_CACHE_BYTES: usize = 1024 * 1024 * 1024;
/// Per-chunk SQL-side read cap (SQLite `substr` counts characters) and
/// global output cap handed to the model/browser.
const MAX_RAG_CHUNK_CHARS: usize = 64 * 1024;
const MAX_RAG_OUTPUT_BYTES: usize = 256 * 1024;

/// One discovered corpus file (validated at scan time, embeddings not read).
#[derive(Clone, Debug)]
pub(crate) struct RagCandidate {
    /// Sanitized base name (tool name is `name` + `_search`).
    pub name: String,
    pub tool_name: String,
    pub description: String,
    pub attribution: String,
    pub embedding_model: String,
    pub dims: usize,
    pub chunks: usize,
    pub documents: usize,
    pub path: String,
    pub query_hint: Option<String>,
    pub allow_kind: bool,
}

/// Scan a directory for `*.rag.db` candidates. Returns (valid, skipped)
/// where skipped carries (filename, reason) for unusable files.
pub(crate) fn scan_catalog_in(dir: &Path) -> (Vec<RagCandidate>, Vec<(String, String)>) {
    let mut candidates = Vec::new();
    let mut skipped = Vec::new();
    let Ok(read_dir) = std::fs::read_dir(dir) else {
        return (candidates, skipped);
    };
    for entry in read_dir.flatten() {
        let path = entry.path();
        let Some(file_name) = path.file_name().map(|s| s.to_string_lossy().into_owned()) else {
            continue;
        };
        if !file_name.ends_with(".rag.db") {
            continue;
        }
        match inspect_candidate(&path) {
            Ok(candidate) => candidates.push(candidate),
            Err(reason) => skipped.push((file_name, reason)),
        }
    }
    candidates.sort_by(|a, b| a.name.cmp(&b.name));
    (candidates, skipped)
}

pub(crate) fn scan_catalog() -> (Vec<RagCandidate>, Vec<(String, String)>) {
    scan_catalog_in(Path::new(crate::config::WORKSPACE_DIR.as_path()))
}

/// Filename stem without the `.rag.db` suffix: "godot_docs.rag.db" → "godot_docs".
fn corpus_stem(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .and_then(|n| n.strip_suffix(".rag.db").map(str::to_string))
        .unwrap_or_else(|| "corpus".to_string())
}

fn open_readonly(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("cannot open {path:?} read-only: {e}"))
}

fn read_meta(conn: &Connection) -> Result<HashMap<String, String>, String> {
    let mut meta = HashMap::new();
    let mut stmt = conn
        .prepare("SELECT key, value FROM rag_meta")
        .map_err(|e| format!("no usable rag_meta table: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("cannot read rag_meta: {e}"))?;
    for row in rows.flatten() {
        meta.insert(row.0, row.1);
    }
    Ok(meta)
}

fn count(conn: &Connection, sql: &str) -> Result<usize, String> {
    conn.query_row(sql, [], |row| row.get::<_, i64>(0))
        .map(|n| n as usize)
        .map_err(|e| format!("cannot count rows: {e}"))
}

/// Validate a candidate end-to-end (meta + blob width + counts) without
/// loading the embedding matrix.
fn inspect_candidate(path: &Path) -> Result<RagCandidate, String> {
    let conn = open_readonly(path)?;
    let meta = read_meta(&conn)?;
    let embedding_model = meta
        .get("embedding_model")
        .filter(|s| !s.trim().is_empty())
        .ok_or("rag_meta is missing embedding_model")?
        .clone();
    let dims: usize = meta
        .get("dims")
        .ok_or("rag_meta is missing dims")?
        .parse()
        .map_err(|_| "rag_meta dims is not a number".to_string())?;
    if dims == 0 {
        return Err("rag_meta dims = 0".into());
    }
    if dims > MAX_RAG_DIMS {
        return Err(format!(
            "rag_meta dims = {dims} exceeds the supported maximum ({MAX_RAG_DIMS})"
        ));
    }
    let expected_blob = dims
        .checked_mul(4)
        .ok_or_else(|| "rag_meta dims * 4 overflows".to_string())?;
    // Width of a real chunk must match dims; tolerate an empty corpus.
    if let Ok(bytes) = conn.query_row(
        "SELECT length(embedding) FROM rag_node WHERE role = 'chunk' LIMIT 1",
        [],
        |row| row.get::<_, i64>(0),
    ) {
        let bytes = bytes as usize;
        if bytes != expected_blob {
            return Err(format!(
                "embedding blob is {bytes} bytes, expected {expected_blob} (dims {dims})"
            ));
        }
    }
    let chunks = count(&conn, "SELECT count(*) FROM rag_node WHERE role = 'chunk'")?;
    let documents = count(&conn, "SELECT count(*) FROM rag_document")?;
    if chunks > MAX_RAG_CHUNKS {
        return Err(format!(
            "corpus has {chunks} chunks, above the supported maximum ({MAX_RAG_CHUNKS})"
        ));
    }
    let matrix_bytes = chunks
        .checked_mul(expected_blob)
        .ok_or_else(|| "corpus embedding matrix size overflows".to_string())?;
    if matrix_bytes > MAX_RAG_MATRIX_BYTES {
        return Err(format!(
            "corpus embedding matrix would need {matrix_bytes} bytes, above the supported maximum ({MAX_RAG_MATRIX_BYTES})"
        ));
    }
    let raw_name = meta
        .get("name")
        .filter(|s| !s.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| corpus_stem(path));
    let name = sanitize_name(&raw_name);
    let query_hint = meta
        .get("query_hint")
        .filter(|s| !s.trim().is_empty())
        .cloned();
    let allow_kind = meta
        .get("kind")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(true);
    let description = meta
        .get("description")
        .filter(|s| !s.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| format!("RAG corpus ({chunks} chunks, {documents} documents)"));
    let attribution = meta.get("attribution").cloned().unwrap_or_default();
    Ok(RagCandidate {
        tool_name: format!("{name}_search"),
        name,
        description,
        attribution,
        embedding_model,
        dims,
        chunks,
        documents,
        path: path.to_string_lossy().into_owned(),
        query_hint,
        allow_kind,
    })
}

/// Tool-name-safe corpus identifier: lowercase alphanumerics and single
/// underscores, must start with a letter, capped so the suffixed search
/// name stays within 64 bytes.
fn sanitize_name(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut last_underscore = false;
    for c in raw.chars() {
        let c = c.to_ascii_lowercase();
        let safe = match c {
            'a'..='z' | '0'..='9' => {
                last_underscore = false;
                Some(c)
            }
            '_' | '-' | '.' | ' ' => {
                if last_underscore || out.is_empty() {
                    None
                } else {
                    last_underscore = true;
                    Some('_')
                }
            }
            _ => None,
        };
        if let Some(c) = safe {
            out.push(c);
        }
    }
    while out.ends_with('_') {
        out.pop();
    }
    let out = if out.is_empty() {
        "corpus".to_string()
    } else if !out
        .chars()
        .next()
        .map(|c| c.is_ascii_alphabetic())
        .unwrap_or(false)
    {
        format!("c_{out}")
    } else {
        out
    };
    // Cap so "<name>_search" stays under 64 bytes; tool names are looked up
    // verbatim, so truncation is safe.
    if out.len() > 56 {
        out[..56].trim_end_matches('_').to_string()
    } else {
        out
    }
}

/// Corpora for the current run: scanned once at run start ([`begin_run`])
/// and reused by every call in it. The scan opens each `.rag.db`, reads
/// its meta, and runs two `count(*)` queries, so repeating it three times
/// per tool call was waste. Outside a run, callers scan directly. The
/// next run rescans, so a `.rag.db` dropped in mid-session still appears
/// in the following run.
static RUN_CORPORA: std::sync::LazyLock<
    std::sync::RwLock<Option<std::sync::Arc<Vec<RagCandidate>>>>,
> = std::sync::LazyLock::new(|| std::sync::RwLock::new(None));

/// Snapshot the workspace corpora for the current run. Called at run
/// start beside the tool-set snapshot: a run in flight keeps the corpora
/// it started with.
pub(crate) fn begin_run() {
    let scanned = scan_catalog().0;
    if let Ok(mut slot) = RUN_CORPORA.write() {
        *slot = Some(std::sync::Arc::new(scanned));
    }
}

/// Drop the run cache. Test isolation only; the next `begin_run`
/// refreshes it anyway.
#[cfg(test)]
pub(crate) fn clear_run_corpora() {
    if let Ok(mut slot) = RUN_CORPORA.write() {
        *slot = None;
    }
}

/// All validated corpora: the current run's snapshot when one is
/// active, else a direct scan (the startup banner, tool registration).
pub(crate) fn corpora() -> Vec<RagCandidate> {
    if let Ok(slot) = RUN_CORPORA.read()
        && let Some(list) = slot.as_ref()
    {
        return list.as_ref().clone();
    }
    scan_catalog().0
}

/// Look up a corpus by its search tool name.
pub(crate) fn corpus_for_tool(tool_name: &str) -> Option<RagCandidate> {
    corpora()
        .into_iter()
        .find(|candidate| candidate.tool_name == tool_name)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ChunkKind {
    Text,
    Code,
    Table,
    Image,
}

impl ChunkKind {
    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "text" => Some(ChunkKind::Text),
            "code" => Some(ChunkKind::Code),
            "table" => Some(ChunkKind::Table),
            "image" => Some(ChunkKind::Image),
            _ => None,
        }
    }
}

struct ChunkEntry {
    id: i64,
    kind: ChunkKind,
    vector: Vec<f32>,
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

fn norm(a: &[f32]) -> f32 {
    dot(a, a).sqrt()
}

/// True when `name` is a registered `<corpus>_search` tool.
pub(crate) fn is_corpus_search_tool(name: &str) -> bool {
    corpora()
        .iter()
        .any(|candidate| candidate.tool_name == name)
}

/// The reviewable form of a corpus search. Constructed per tool call from
/// the corpus bound to the `<corpus>_search` tool that the model invoked.
#[derive(Clone, Debug, Serialize)]
pub(crate) struct RagSearchRequest {
    /// Discriminator for the review modal (the frontend branches on this).
    pub kind: String,
    /// Base corpus name (the part before `_search`), for provenance/error text.
    pub corpus: String,
    pub query: String,
    pub k: usize,
    pub kind_filter: Option<String>,
    pub preview: Option<String>,
}

impl RagSearchRequest {
    pub fn parse(name: &str, args: &Value) -> Result<Self, String> {
        let candidate = corpus_for_tool(name)
            .ok_or_else(|| format!("{name:?} is not a registered RAG corpus tool"))?;
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Args {
            query: String,
            k: Option<usize>,
            kind: Option<String>,
        }
        let a: Args = serde_json::from_value(args.clone()).map_err(|e| e.to_string())?;
        let query = a.query.trim();
        if query.is_empty() {
            return Err("provide a non-empty query".into());
        }
        let k = a.k.unwrap_or(5);
        if !(1..=10).contains(&k) {
            return Err("k must be between 1 and 10".into());
        }
        let kind_filter = a
            .kind
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty());
        if let Some(kind) = &kind_filter
            && ChunkKind::parse(kind).is_none()
        {
            return Err(format!(
                "kind must be one of text, code, table, image (got {kind:?})"
            ));
        }
        Ok(Self {
            kind: "rag".into(),
            corpus: candidate.name,
            query: query.to_string(),
            k,
            kind_filter,
            preview: None,
        })
    }

    /// True when execution produced reviewable text (guards the review gate).
    /// True when execution produced reviewable text (guards the review gate).
    pub fn has_reviewable_text(&self, exec: &super::web::Execution) -> bool {
        exec.exit_code == Some(0) && !exec.stdout.trim().is_empty()
    }

    fn failure(&self, stderr: String) -> super::web::Execution {
        super::web::Execution {
            stdout: String::new(),
            stderr,
            exit_code: None,
            duration_ms: 0,
            raw_body: None,
        }
    }

    /// Embed the query, rank every chunk, return the formatted results.
    /// Never panics: every failure is returned as an Execution with
    /// exit_code: None, which the caller turns into a plain tool result.
    pub(crate) async fn execute(&self, ollama: &Ollama) -> super::web::Execution {
        let start = std::time::Instant::now();
        let candidate = match corpora()
            .iter()
            .find(|candidate| candidate.name == self.corpus)
            .cloned()
        {
            Some(candidate) => candidate,
            None => {
                return self.failure(format!(
                    "RAG corpus {:?} is no longer registered (harness restart resets the list)",
                    self.corpus
                ));
            }
        };
        let request = GenerateEmbeddingsRequest::new(
            candidate.embedding_model.clone(),
            EmbeddingsInput::Single(self.query.clone()),
        );
        let response = match ollama.generate_embeddings(request).await {
            Ok(response) => response,
            Err(error) => {
                return self.failure(format!(
                    "embedding model {:?} failed: {error}",
                    candidate.embedding_model
                ));
            }
        };
        let query_vec = match response.embeddings.into_iter().next() {
            Some(vector) => vector,
            None => {
                return self.failure(format!(
                    "embedding model {:?} returned no vector",
                    candidate.embedding_model
                ));
            }
        };
        if query_vec.len() != candidate.dims {
            return self.failure(format!(
                "embedding model produced {} dims, expected {} (rag_meta dims)",
                query_vec.len(),
                candidate.dims
            ));
        }
        let kind_filter = self
            .kind_filter
            .as_deref()
            .map(|raw| ChunkKind::parse(raw).expect("validated at parse"));
        if kind_filter.is_some() && !candidate.allow_kind {
            return self.failure(
                "this corpus does not allow content-kind filtering (rag_meta kind != 1)".into(),
            );
        }

        // Ranking is CPU-bound; keep it off the async workers' critical path.
        let k = self.k;
        let candidate_path = candidate.path.clone();
        let candidate_name = candidate.name.clone();
        let candidate_desc = candidate.description.clone();
        let candidate_attr = candidate.attribution.clone();
        let candidate_total = candidate.chunks;
        let query = query_vec;
        let matrix = match corpus_matrix(&candidate) {
            Ok(matrix) => matrix,
            Err(message) => return self.failure(message),
        };
        let top_k: Vec<(i64, f32)> =
            match tokio::task::spawn_blocking(move || -> Result<Vec<(i64, f32)>, String> {
                let query_norm = norm(&query);
                if query_norm == 0.0 {
                    return Err("embedding model returned a zero vector".into());
                }
                let mut scored: Vec<(i64, f32)> = matrix
                    .chunks
                    .iter()
                    .filter(|chunk| kind_filter.map(|f| chunk.kind == f).unwrap_or(true))
                    .map(|chunk| {
                        let chunk_norm = norm(&chunk.vector);
                        let score = if chunk_norm == 0.0 {
                            0.0
                        } else {
                            dot(&query, &chunk.vector) / (query_norm * chunk_norm)
                        };
                        (chunk.id, score)
                    })
                    .collect();
                scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
                Ok(scored.into_iter().take(k).collect())
            })
            .await
            {
                Ok(Ok(ranked)) => ranked,
                Ok(Err(message)) => return self.failure(message),
                Err(e) => return self.failure(format!("ranking task failed: {e}")),
            };

        // Fetch full rows for the top-k hits; the matrix only holds ids.
        let conn = match open_readonly(Path::new(&candidate_path)) {
            Ok(conn) => conn,
            Err(message) => return self.failure(message),
        };
        let kind_note = self
            .kind_filter
            .as_deref()
            .map(|k| format!(" · kind={k}"))
            .unwrap_or_default();
        let attribution = if candidate_attr.is_empty() {
            "(not recorded)".to_string()
        } else {
            candidate_attr.clone()
        };
        let mut out = format!(
            "RAG: {name} — {desc}\nquery: \"{query}\" · top {shown} of {total} chunks{kind_note}\nattribution: {attr}\n",
            name = candidate_name,
            desc = candidate_desc,
            query = self.query,
            shown = top_k.len(),
            total = candidate_total,
            kind_note = kind_note,
            attr = attribution,
        );
        let mut output_truncated = false;
        for (position, (id, score)) in top_k.iter().enumerate() {
            if out.len() >= MAX_RAG_OUTPUT_BYTES {
                output_truncated = true;
                break;
            }
            let row = conn.query_row(
                "SELECT substr(n.content, 1, ?2), n.content_kind, n.heading, n.heading_path, d.title, d.source_path
                 FROM rag_node n
                 JOIN rag_document d ON d.id = n.document_id
                 WHERE n.id = ?1",
                params![id, MAX_RAG_CHUNK_CHARS as i64],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            );
            let (content, kind, heading, heading_path, title, source_path) = match row {
                Ok(row) => row,
                Err(_) => continue,
            };
            let heading_line = render_heading(&heading, &heading_path);
            out.push_str(&format!(
                "\n--- result {} (score {score:.3}) ---\n{title} · {source_path} · kind: {kind}\n{heading_line}{content}\n",
                position + 1,
            ));
        }
        if out.len() > MAX_RAG_OUTPUT_BYTES {
            output_truncated = true;
        }
        if output_truncated {
            let original = out.len();
            let mut end = MAX_RAG_OUTPUT_BYTES;
            while end > 0 && !out.is_char_boundary(end) {
                end -= 1;
            }
            out.truncate(end);
            out.push_str(&format!(
                "\n…[RAG output truncated: {original} bytes total, showing the first {end} bytes]"
            ));
        }

        super::web::Execution {
            stdout: out,
            stderr: String::new(),
            exit_code: Some(0),
            duration_ms: start.elapsed().as_millis() as u64,
            raw_body: None,
        }
    }

    /// Failure rendering for the single-stage (hard error) path.
    pub fn failure_text(&self, exec: &super::web::Execution) -> String {
        format!(
            "rag_search failed for {:?}\n{}\nexit code: {:?}",
            self.query, exec.stderr, exec.exit_code
        )
    }

    /// Validate the reviewed/submitted text: an empty submission would
    /// erase the retrieval silently, so it is rejected outright.
    pub fn result(&self, text: String) -> Result<Value, String> {
        if text.trim().is_empty() {
            return Err(
                "Enter the curated results, or an explicit no-results/retrieval-error report."
                    .into(),
            );
        }
        Ok(json!({ "query": self.query, "content": text }))
    }
}

fn render_heading(heading: &str, heading_path: &str) -> String {
    let trimmed = heading_path.trim();
    let parts: Vec<String> = if trimmed.is_empty() || trimmed == "[]" {
        Vec::new()
    } else {
        serde_json::from_str::<Vec<String>>(trimmed).unwrap_or_default()
    };
    let mut line = String::new();
    if !heading.trim().is_empty() {
        line.push_str(&format!("heading: {}\n", heading.trim()));
    }
    if !parts.is_empty() {
        line.push_str(&format!("path: {}\n", parts.join(" > ")));
    }
    line
}

/// The embedding matrix for one corpus, decoded once and cached for the
/// process lifetime. Read-only; the file is never written to.
struct CorpusMatrix {
    chunks: Vec<ChunkEntry>,
    bytes: usize,
}

static MATRICES: LazyLock<RwLock<HashMap<String, Arc<CorpusMatrix>>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

fn corpus_matrix(candidate: &RagCandidate) -> Result<Arc<CorpusMatrix>, String> {
    if let Ok(guard) = MATRICES.read()
        && let Some(cached) = guard.get(&candidate.name)
    {
        return Ok(cached.clone());
    }
    let conn = open_readonly(Path::new(&candidate.path))?;
    let mut stmt = conn
        .prepare(
            "SELECT id, embedding, content_kind FROM rag_node WHERE role = 'chunk' AND embedding IS NOT NULL",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    let expected_blob = candidate
        .dims
        .checked_mul(4)
        .ok_or_else(|| format!("corpus {:?} dims * 4 overflows", candidate.name))?;
    // The scan already caps the corpus; start small rather than allocating
    // the whole advertised count up front.
    let mut chunks = Vec::with_capacity(candidate.chunks.min(4096));
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let id: i64 = row.get(0).map_err(|e| e.to_string())?;
        let blob: Vec<u8> = row.get(1).map_err(|e| e.to_string())?;
        let kind: String = row.get(2).map_err(|e| e.to_string())?;
        if blob.len() != expected_blob {
            return Err(format!(
                "chunk {id} embedding is {} bytes, expected {expected_blob} (dims {}) — refusing to load \"{}\"",
                blob.len(),
                candidate.dims,
                candidate.name
            ));
        }
        let vector: Vec<f32> = blob
            .as_chunks::<4>()
            .0
            .iter()
            .map(|c| f32::from_le_bytes(*c))
            .collect();
        chunks.push(ChunkEntry {
            id,
            kind: ChunkKind::parse(&kind).unwrap_or(ChunkKind::Text),
            vector,
        });
    }
    let bytes = chunks
        .len()
        .checked_mul(expected_blob)
        .unwrap_or(MAX_RAG_CACHE_BYTES);
    let matrix = Arc::new(CorpusMatrix { chunks, bytes });
    let mut guard = MATRICES
        .write()
        .map_err(|e| format!("rag matrix cache poisoned: {e}"))?;
    // Keep the process-lifetime cache bounded. Evicting everything except
    // the newly loaded corpus is simple and predictable; a corpus search
    // is not a hot enough path to need a fancier policy.
    let cached_bytes: usize = guard.values().map(|matrix| matrix.bytes).sum();
    if cached_bytes.saturating_add(matrix.bytes) > MAX_RAG_CACHE_BYTES {
        guard.clear();
    }
    Ok(guard
        .entry(candidate.name.clone())
        .or_insert_with(|| matrix.clone())
        .clone())
}

pub(crate) fn tool_infos() -> Vec<ToolInfo> {
    corpora()
        .iter()
        .map(|candidate| {
            let mut description = candidate.description.clone();
            if !description.contains(candidate.documents.to_string().as_str()) {
                description.push_str(&format!(" ({} documents)", candidate.documents));
            }
            if let Some(hint) = &candidate.query_hint {
                description.push_str(&format!(" Hint: {hint}."));
            }
            json!({"type":"function", "function": {
                "name": candidate.tool_name,
                "description": description,
                "parameters":{"type":"object","properties": {
                    "query":{"type":"string","description": crate::model_voice::RAG_QUERY},
                    "k":{"type":"integer","minimum":1,"maximum":10,"default":5,"description": crate::model_voice::RAG_K},
                    "kind":{"type":"string","enum":["text","code","table","image"],"description": crate::model_voice::RAG_KIND}
                }, "required":["query"], "additionalProperties":false}
            }})
        })
        .map(|v| serde_json::from_value(v).expect("rag tool schemas"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use std::path::PathBuf;

    fn scratch_dir(tag: &str) -> PathBufForTests {
        PathBufForTests(PathBuf::from(std::env::temp_dir().join(format!(
            "rag-test-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))))
    }

    struct PathBufForTests(std::path::PathBuf);
    impl Drop for PathBufForTests {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write_fixture(
        dir: &Path,
        name: &str,
        dims: usize,
        chunks: &[(i64, Vec<f32>)],
        meta: &[(&str, &str)],
    ) {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join(name);
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE rag_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE rag_document(id INTEGER PRIMARY KEY, title TEXT NOT NULL, source_path TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
             CREATE TABLE rag_node(id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES rag_document(id) ON DELETE CASCADE, ref_id TEXT NOT NULL, parent_id INTEGER, position INTEGER NOT NULL, role TEXT NOT NULL CHECK(role IN ('section','chunk')), heading TEXT NOT NULL DEFAULT '', heading_path TEXT NOT NULL DEFAULT '[]', content TEXT NOT NULL DEFAULT '', content_kind TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT '', anchor TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL DEFAULT '{}', embedding_model TEXT, dims INTEGER, embedding BLOB);",
        ).unwrap();
        for (key, value) in meta {
            conn.execute(
                "INSERT INTO rag_meta(key, value) VALUES (?1, ?2)",
                params![key, value],
            )
            .unwrap();
        }
        conn.execute("INSERT INTO rag_document(id, title, source_path, created_at) VALUES (1, 'Doc One', 'one.md', 0)", []).unwrap();
        for (id, vector) in chunks {
            let blob: Vec<u8> = vector.iter().flat_map(|f| f.to_le_bytes()).collect();
            conn.execute(
                "INSERT INTO rag_node(id, document_id, ref_id, parent_id, position, role, heading, heading_path, content, content_kind, language, anchor, embedding_model, dims, embedding) VALUES (?1, 1, 'c1', NULL, 1, 'chunk', '', '[]', ?2, 'text', '', '', 'mock', ?3, ?4)",
                params![id, format!("chunk-{id}"), dims, blob],
            ).unwrap();
        }
    }

    #[test]
    fn scan_catalog_discovers_valid_and_reports_invalid() {
        let dir = scratch_dir("scan");
        write_fixture(
            &dir.0,
            "alpha.rag.db",
            4,
            &[(1, vec![1.0, 0.0, 0.0, 0.0]), (2, vec![0.0, 1.0, 0.0, 0.0])],
            &[("embedding_model", "mock"), ("dims", "4")],
        );
        write_fixture(
            &dir.0,
            "broken.rag.db",
            8,
            &[(3, vec![1.0, 0.0, 0.0, 0.0])],
            &[("embedding_model", "mock"), ("dims", "999")],
        );
        std::fs::write(dir.0.join("not-a-db.txt"), b"plain text").unwrap();
        let (valid, skipped) = scan_catalog_in(&dir.0);
        assert_eq!(valid.len(), 1, "one valid corpus: {valid:?}");
        assert_eq!(valid[0].name, "alpha");
        assert_eq!(valid[0].chunks, 2);
        assert_eq!(valid[0].embedding_model, "mock");
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].0, "broken.rag.db");
    }

    #[test]
    fn a_run_snapshot_answers_every_corpus_lookup_for_the_run() {
        clear_run_corpora();
        // The run cache is authoritative for the whole run: a tool name
        // in the snapshot resolves even when the file behind it is not
        // on disk (mid-run the scan would not be repeated anyway).
        let candidate = RagCandidate {
            name: "snap".into(),
            tool_name: "snap_search".into(),
            description: "snapshot corpus".into(),
            attribution: "snap source".into(),
            embedding_model: "mock".into(),
            dims: 4,
            chunks: 1,
            documents: 1,
            path: "snap.rag.db".into(),
            query_hint: None,
            allow_kind: false,
        };
        if let Ok(mut slot) = RUN_CORPORA.write() {
            *slot = Some(std::sync::Arc::new(vec![candidate]));
        }
        assert!(is_corpus_search_tool("snap_search"));
        assert!(corpus_for_tool("snap_search").is_some());
        assert!(corpora().len() == 1);
        // Outside a run, the direct scan answers again.
        clear_run_corpora();
        assert!(!is_corpus_search_tool("snap_search"));
    }

    #[test]
    fn rejects_unreasonable_embedding_dimensions_and_corpus_size() {
        let dir = scratch_dir("bounds");
        write_fixture(
            &dir.0,
            "huge-dims.rag.db",
            20_000,
            &[],
            &[("embedding_model", "mock"), ("dims", "20000")],
        );
        let err = inspect_candidate(&dir.0.join("huge-dims.rag.db")).unwrap_err();
        assert!(err.contains("exceeds the supported maximum"), "{err}");
    }

    #[test]
    fn stem_strips_rag_db_suffix() {
        assert_eq!(corpus_stem(Path::new("godot_docs.rag.db")), "godot_docs");
        assert_eq!(corpus_stem(Path::new("/tmp/my.rag.db")), "my");
    }

    #[test]
    fn ranking_by_dot_product_prefers_closest() {
        let q = vec![1.0, 0.0, 0.0, 0.0];
        let chunks = vec![
            ChunkEntry {
                id: 1,
                kind: ChunkKind::Text,
                vector: vec![1.0, 0.0, 0.0, 0.0],
            },
            ChunkEntry {
                id: 2,
                kind: ChunkKind::Text,
                vector: vec![0.0, 1.0, 0.0, 0.0],
            },
            ChunkEntry {
                id: 3,
                kind: ChunkKind::Text,
                vector: vec![0.8, 0.2, 0.0, 0.0],
            },
        ];
        let query_norm = norm(&q);
        let mut scored: Vec<(i64, f32)> = chunks
            .iter()
            .map(|c| (c.id, dot(&q, &c.vector) / (query_norm * norm(&c.vector))))
            .collect();
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
        assert_eq!(scored[0].0, 1);
        assert_eq!(scored[1].0, 3);
    }
}

    #[test]
    fn the_reference_builder_output_is_a_valid_corpus() {
        // tools/build_rag.py generated tools/fixtures/demo.rag.db in its
        // --offline mode. The startup scan accepting that file is the
        // contract between the reference builder and the harness: if a
        // schema change breaks the builder, this fails before release.
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tools/fixtures");
        assert!(
            dir.join("demo.rag.db").is_file(),
            "the committed fixture is missing: regenerate it with \
             `python3 tools/build_rag.py tools/fixtures/source.md \
             -o tools/fixtures/demo.rag.db -m qwen3-embedding:4b --offline`"
        );
        let (valid, skipped) = scan_catalog_in(&dir);
        assert!(skipped.is_empty(), "the fixture must not be skipped: {skipped:?}");
        let demo = valid
            .iter()
            .find(|candidate| candidate.tool_name == "demo_search")
            .expect("the builder's corpus registers as a search tool");
        assert!(demo.chunks > 0, "the fixture carries real chunk rows");
        assert_eq!(demo.embedding_model, "qwen3-embedding:4b");
        assert_eq!(demo.dims, 4);
    }
