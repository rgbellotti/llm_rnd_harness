//! Shared run state: the approval types, the pending-approval map,
//! the per-launch stop flags, and [`AppState`] itself.

use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64},
    },
    time::Duration,
};

use axum::body::Bytes;
use ollama_rs::Ollama;
use serde::Serialize;
use tokio::sync::{Mutex, RwLock, Semaphore, mpsc, oneshot};

use crate::{history::HistoryDb, memory::MemoryDb, tools::registry::CustomToolSpec};

pub(crate) const REVIEW_RUN_CMD_DEFAULT: bool = true;
#[derive(Debug)]
pub(crate) enum ApprovalDecision {
    /// Run the tool. `command_timeout` is the person's limit for this
    /// `run_cmd` only (`30s`, `20m`, or `none`). `None` keeps the model's
    /// argument. Omitted, `none`, and `default` have no time limit. Later
    /// calls are unchanged. `command` replaces the shell text for this
    /// `run_cmd` only. `note` is prepended to the tool text the model
    /// reads and is not passed to the shell.
    Approved {
        command_timeout: Option<String>,
        command: Option<String>,
        note: Option<String>,
    },
    Redirect(String),
    Answer(serde_json::Value),
    /// Text the user submitted at the review gate (fetched page content,
    /// extracted PDF text, search snippets, or a shell transcript).
    /// Objects are sent as JSON. A bare string is sent as that text.
    WebResult(serde_json::Value),
    /// Explicit "run this fetch, search, or PDF read now" decision. Search
    /// and fetch open a second review after capture. PDF requests open the
    /// same review for extracted text (`mode: "text"` only).
    ReviewExecute(ReviewRequest),
}

/// Shell output held for the optional `run_cmd` review stage.
///
/// Stage one is the ordinary command approval. This value exists only
/// after the command has run, when the config flag asked for a second look.
#[derive(Clone, Debug, Serialize)]
pub(crate) struct CmdReview {
    pub kind: String,
    pub command: String,
    pub preview: String,
}

/// Something that executes only after an explicit user approval and is then
/// reviewed before its output reaches the model. Serializes transparently
/// as the inner request — the frontend branches on the inner `kind`
/// ("search" | "fetch" | "pdf" | "rag" | "cmd").
#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub(crate) enum ReviewRequest {
    Web(crate::tools::web::WebRequest),
    Pdf(crate::tools::pdf::PdfRequest),
    Rag(crate::tools::rag::RagSearchRequest),
    Cmd(CmdReview),
}

pub(crate) struct PendingApproval {
    pub review_request: Option<ReviewRequest>,
    pub sender: oneshot::Sender<ApprovalDecision>,
    pub interaction: Option<crate::tools::ask_user::UserInteraction>,
    /// Set by POST /approve when the dialog includes a Grok effort. The
    /// loop keeps a clone of this handle and reads it after the decision
    /// arrives. The next request uses that level, and later dialogs in
    /// the same run open on it.
    pub reasoning_effort: std::sync::Arc<std::sync::Mutex<Option<String>>>,
    /// The person's drag-select focus region on a `view_img` approval.
    /// Absent means no region was highlighted. Set by POST /approve,
    /// read by the loop after the decision.
    pub image_region: std::sync::Arc<std::sync::Mutex<Option<crate::tools::view_img::ImageRegion>>>,
    /// Crop-and-send on the same `view_img` approval: true attaches only
    /// the drag-selected region instead of the full normalized image.
    /// Written together with `image_region`, so it only applies when that
    /// slot is set; absent and false are the same.
    pub image_crop: std::sync::Arc<std::sync::Mutex<bool>>,
}

impl PendingApproval {
    pub(crate) fn new(
        sender: oneshot::Sender<ApprovalDecision>,
        interaction: Option<crate::tools::ask_user::UserInteraction>,
        review_request: Option<ReviewRequest>,
    ) -> Self {
        Self {
            review_request,
            sender,
            interaction,
            reasoning_effort: std::sync::Arc::new(std::sync::Mutex::new(None)),
            image_region: std::sync::Arc::new(std::sync::Mutex::new(None)),
            image_crop: std::sync::Arc::new(std::sync::Mutex::new(false)),
        }
    }
}

/// One NDJSON line on the `/generate` stream.
pub(crate) type ChunkTx = mpsc::Sender<Result<Bytes, axum::Error>>;

/// Prefix of every run id the harness hands out (`run-<n>-<millis>`).
pub(crate) const RUN_ID_PREFIX: &str = "run-";
/// How long an armed stop flag can still matter: the window between a run
/// task being spawned and registering itself in `runs`.
pub(crate) const STOP_FLAG_TTL: Duration = Duration::from_secs(60);
/// How many stop flags may be armed at once.
pub(crate) const MAX_STOP_FLAGS: usize = 32;

/// Empty tool-name set. Approval sets start empty so a launch stays on
/// the manual approval path. Test-only: production launches fill the sets
/// from the persisted tool policy or the registered defaults.
#[cfg(test)]
pub(crate) fn empty_tool_set() -> Arc<std::sync::RwLock<std::collections::HashSet<String>>> {
    Arc::new(std::sync::RwLock::new(std::collections::HashSet::new()))
}

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) ollama: Ollama,
    pub(crate) web_runner: std::path::PathBuf,
    pub(crate) semaphore: Arc<Semaphore>,
    pub(crate) enabled_tools: Arc<std::sync::RwLock<std::collections::HashSet<String>>>,
    /// Tools whose calls run without the approval dialog. Empty at launch,
    /// so a session stays on the manual path until these are turned on.
    /// A run reads the set once at start. `ask_user` is never stored.
    pub(crate) approve_calls: Arc<std::sync::RwLock<std::collections::HashSet<String>>>,
    /// Tools whose captured output is submitted without the second review.
    /// A name is stored only for an enabled tool that is not in
    /// `approve_calls`. Allow all for calls skips that review on its own.
    /// A run reads the set once at start.
    pub(crate) approve_outputs: Arc<std::sync::RwLock<std::collections::HashSet<String>>>,
    pub(crate) pending: Arc<Mutex<HashMap<String, PendingApproval>>>,
    pub(crate) run_counter: Arc<AtomicU64>,
    /// In-flight chains by run_id, so POST /stop can abort them. Entries are
    /// removed when the task ends on its own; aborting drops the task (and
    /// its semaphore permit) immediately.
    pub(crate) runs: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
    /// Run ids a `/stop` request targeted in the window between the run task
    /// spawning and registering itself in `runs`. The tool loop consumes its
    /// flag at the top of the very first round and ends immediately, so a
    /// stop issued moments "too early" still stops.
    ///
    /// The flags carry a timestamp and are bounded: an id that can no
    /// longer match a run (too old, or beyond the cap) is dropped rather
    /// than kept forever.
    pub(crate) stop_flags: Arc<Mutex<HashMap<String, std::time::Instant>>>,
    /// A stop that named no run id and found none in flight: the next
    /// run to start consumes it. One slot, same TTL as the id flags.
    pub(crate) stop_next: Arc<Mutex<Option<std::time::Instant>>>,
    /// Permanent session history (SQLite). When this cannot record, the
    /// page says so and new runs stay refused unless the request allows
    /// an unrecorded session.
    pub(crate) history: HistoryDb,
    /// Project memory (SQLCipher, same passphrase as history). Unavailable
    /// memory does not refuse runs; the tool and the memory tab report it.
    pub(crate) memory: MemoryDb,
    /// When true, `run_cmd` output opens a review dialog before the model
    /// sees it. Each launch starts on ([`REVIEW_RUN_CMD_DEFAULT`]). A run
    /// reads this once at start.
    pub(crate) review_run_cmd: Arc<AtomicBool>,
    /// Where the tool policy (enabled tools and the two approval sets)
    /// persists across launches. `None` disables persistence (tests).
    /// `main` sets the user config file so selections survive restarts
    /// without the browser.
    pub(crate) tool_policy_path: Option<std::path::PathBuf>,
}

impl AppState {
    /// Arm a stop flag for a run that has not registered itself yet.
    ///
    /// Only ids that look like a run id are accepted, the armed flags
    /// expire, and their number is capped: a `/stop` request for an id
    /// that will never match a run cannot pile up in memory.
    pub(crate) async fn arm_stop_flag(&self, id: &str) -> bool {
        if !looks_like_run_id(id) {
            return false;
        }
        let mut flags = self.stop_flags.lock().await;
        let now = std::time::Instant::now();
        // Flags that can no longer match a live run are worthless.
        flags.retain(|_, armed| now.duration_since(*armed) < STOP_FLAG_TTL);
        if flags.len() >= MAX_STOP_FLAGS
            && let Some(oldest) = flags
                .iter()
                .min_by_key(|(_, armed)| **armed)
                .map(|(id, _)| id.clone())
        {
            flags.remove(&oldest);
        }
        flags.insert(id.to_string(), now);
        true
    }

    /// Consume an armed stop flag, if there is one for this run.
    pub(crate) async fn take_stop_flag(&self, id: &str) -> bool {
        self.stop_flags.lock().await.remove(id).is_some()
    }

    /// Arm the no-id stop: the next run that starts is stopped at its
    /// first round. One slot — a second arm overwrites the first.
    pub(crate) async fn arm_stop_next(&self) {
        *self.stop_next.lock().await = Some(std::time::Instant::now());
    }

    /// Consume the no-id stop if one is armed and still fresh. A stale
    /// arm (no run arrived within the TTL) is discarded, not consumed.
    pub(crate) async fn take_stop_next(&self) -> bool {
        match self.stop_next.lock().await.take() {
            Some(armed) => armed.elapsed() < STOP_FLAG_TTL,
            None => false,
        }
    }
}

/// True for ids in the harness' own run-id shape (`run-<n>-<millis>`).
fn looks_like_run_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix(RUN_ID_PREFIX) else {
        return false;
    };
    let mut parts = rest.split('-');
    let counter = parts.next().unwrap_or_default();
    let stamp = parts.next().unwrap_or_default();
    if parts.next().is_some() {
        return false;
    }
    !counter.is_empty()
        && !stamp.is_empty()
        && counter.bytes().all(|b| b.is_ascii_digit())
        && stamp.bytes().all(|b| b.is_ascii_digit())
}

/// Live custom-tool registry, process-global: CLI `--tools` files seed it at
/// startup. Reads rebuild the per-round tools vector from it.
pub(crate) static CUSTOM_TOOLS: std::sync::LazyLock<RwLock<Vec<CustomToolSpec>>> =
    std::sync::LazyLock::new(|| RwLock::new(Vec::new()));
