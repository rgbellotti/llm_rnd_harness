//! HTTP handlers: `/generate` (NDJSON tool-chain stream), `/approve`
//! (human-in-the-loop decisions), `/diff` (command and file diffs),
//! `/config` (registration snapshot), `/context-window` (provider context
//! size for the selected model), and `/history` (permanent session records).
use axum::{
    Json,
    body::{Body, Bytes},
    extract::State,
    http::{StatusCode, header},
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tokio::sync::{mpsc, oneshot};
use tokio_stream::wrappers::ReceiverStream;

use crate::{
    config::{AppState, ApprovalDecision, current_model, workspace_dir_string},
    stream::{PromptRequest, run_tool_loop},
};

#[derive(Deserialize)]
pub(crate) struct RenderRequest {
    content: String,
}

/// Restore formatted responses without generating model text or writing history.
pub(crate) async fn render_handler(
    Json(payload): Json<RenderRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    // The markdown/math parser is CPU-bound. Restored responses are
    // display-only, so refuse absurd inputs rather than letting a large
    // body occupy an async worker.
    const MAX_RENDER_CONTENT_BYTES: usize = 4 * 1024 * 1024;
    if payload.content.len() > MAX_RENDER_CONTENT_BYTES {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            "Response too large to re-render; view it as text instead.".to_string(),
        ));
    }
    // Same rule as /diff: the parsing runs on the blocking pool, not an
    // async worker. A 4 MB render would otherwise pin the runtime thread.
    let content = payload.content;
    let html = tokio::task::spawn_blocking(move || {
        crate::markdown::sanitize_model_html(&crate::markdown::markdown_to_html(&content))
    })
    .await
    .map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("render task failed: {error}"),
        )
    })?;
    Ok(Json(serde_json::json!({ "html": html })))
}

#[derive(Deserialize)]
pub(crate) struct DiffRequest {
    #[serde(default)]
    before: String,
    #[serde(default)]
    after: String,
    /// When set, `after` is the shell command that would run. A recognized
    /// literal file write includes a before/after of that file. The command
    /// is not run, and accepting the dialog is unchanged.
    #[serde(default)]
    file: bool,
}

#[derive(Serialize)]
struct DiffResponse {
    diff: crate::diff::TextDiffView,
    #[serde(skip_serializing_if = "Option::is_none")]
    file: Option<crate::diff::FileDiffView>,
}

/// Line diff for the Edit Command box, plus a file diff when the edited
/// command is a quoted heredoc write. Neither side runs the command.
pub(crate) async fn diff_handler(Json(payload): Json<DiffRequest>) -> impl IntoResponse {
    // The differ and the file read are bounded. Keep them off the runtime.
    let before = payload.before;
    let after = payload.after;
    let want_file = payload.file;
    let joined = tokio::task::spawn_blocking(move || {
        let diff = crate::diff::diff_text(&before, &after);
        let file = if want_file {
            crate::diff::file_diff_for_command(&after)
        } else {
            None
        };
        (diff, file)
    })
    .await;
    match joined {
        Ok((diff, file)) => Json(DiffResponse { diff, file }).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not compute the diff.".to_string(),
        )
            .into_response(),
    }
}

#[derive(Deserialize, Serialize)]
pub(crate) struct ApproveRequest {
    approval_id: String,
    /// "approve" runs the command; "redirect" skips execution and feeds
    /// `text` back to the model as the tool result instead.
    action: String,
    text: Option<String>,
    answers: Option<Vec<crate::tools::ask_user::UserAnswer>>,
    /// Grok effort for the next round. Absent on Ollama approvals. An
    /// unknown value is refused and the pending request stays open.
    #[serde(default)]
    reasoning_effort: Option<String>,
    /// Time limit chosen on a `run_cmd` approval. Absent keeps the model's
    /// argument. A present value must be `30s`, `20m`, or `none`; anything
    /// else is refused and the pending request stays open. The choice
    /// applies to this command only.
    #[serde(default)]
    command_timeout: Option<String>,
    /// Replacement shell text for this `run_cmd` only. Absent runs the
    /// model's command. A present blank value is refused and the pending
    /// request stays open. The value is not used for any other action.
    #[serde(default)]
    command: Option<String>,
    /// The person's drag-select focus region on a `view_img` approval, in
    /// normalized 0..1 coordinates. Absent when no region was highlighted.
    /// Clamped and degenerate-rejected by [`crate::tools::view_img::ImageRegion::normalized`].
    #[serde(default)]
    image_region: Option<crate::tools::view_img::ImageRegion>,
    /// Crop-and-send on the same `view_img` approval: true attaches only
    /// the selected region instead of the full image. Read only together
    /// with a valid `image_region`; absent and false are the same.
    #[serde(default)]
    image_crop: Option<bool>,
}

pub(crate) async fn generate_handler(
    State(state): State<AppState>,
    Json(payload): Json<PromptRequest>,
) -> impl IntoResponse {
    let prompt = payload.prompt.trim().to_string();
    if prompt.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            "Please enter a prompt.".to_string(),
        )
            .into_response();
    }
    if let Some(reason) = state.history.block_reason(payload.allow_unrecorded) {
        return (StatusCode::CONFLICT, reason).into_response();
    }
    // Single-user harness: one chain at a time. Any overlapping request gets
    // a fast 429 instead of interleaving runs and approvals.
    let permit = match Arc::clone(&state.semaphore).try_acquire_owned() {
        Ok(p) => p,
        Err(_) => {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                "Process already running — please finish before starting new task.".to_string(),
            )
                .into_response();
        }
    };

    let (tx, rx) = mpsc::channel::<Result<Bytes, axum::Error>>(64);
    let run_id = format!(
        "run-{}-{}",
        state.run_counter.fetch_add(1, Ordering::Relaxed),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let loop_state = state.clone();
    let run_id_owned = run_id.clone();
    let uploaded = payload.uploaded_files.clone();
    // The typed context guide for this run, when the provider reports no
    // window of its own.
    let context_limit = payload.context_limit;

    let cleanup_state = state.clone();
    let cleanup_id = run_id.clone();
    // Register before the task can finish. Without this barrier a very
    // fast run could complete and remove its entry before this handler
    // inserted the handle, leaving a stale entry that /stop could select
    // instead of the active run.
    let (start_tx, start_rx) = oneshot::channel::<()>();
    let handle = tokio::spawn(async move {
        // Hold the permit for the whole chain.
        let _permit = permit;
        if start_rx.await.is_err() {
            return;
        }
        run_tool_loop(loop_state, run_id_owned, prompt, uploaded, context_limit, tx).await;
        cleanup_state.runs.lock().await.remove(&cleanup_id);
    });
    {
        let mut runs = state.runs.lock().await;
        // A stale entry can only exist if a previous task died without
        // unregistering; abort defensively before replacing it.
        if let Some(old) = runs.insert(run_id.clone(), handle) {
            old.abort();
        }
    }
    let _ = start_tx.send(());

    (
        [
            (header::CONTENT_TYPE, "application/x-ndjson"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        Body::from_stream(ReceiverStream::new(rx)),
    )
        .into_response()
}

/// Parse one `/approve` body and wipe the raw bytes. The JavaScript string
/// that built the body cannot be wiped; the page does not log the body.
pub(crate) fn parse_approve_body(raw: &mut Vec<u8>) -> Result<ApproveRequest, String> {
    let parsed = serde_json::from_slice::<ApproveRequest>(raw);
    for byte in raw.iter_mut() {
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
    parsed.map_err(|_| "Could not read the approval.".to_string())
}

fn zero_owned_bytes(body: Bytes) {
    if let Ok(mut unique) = body.try_into_mut() {
        for byte in unique.iter_mut() {
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
    }
}

pub(crate) async fn approve_handler(
    State(state): State<AppState>,
    body: Bytes,
) -> impl IntoResponse {
    let mut raw = body.to_vec();
    zero_owned_bytes(body);
    let payload = match parse_approve_body(&mut raw) {
        Ok(payload) => payload,
        Err(error) => return (StatusCode::BAD_REQUEST, error).into_response(),
    };
    let mut pending = state.pending.lock().await;
    let Some(request) = pending.get(&payload.approval_id) else {
        return (
            StatusCode::NOT_FOUND,
            "Unknown or expired request id — the run may have ended.".to_string(),
        )
            .into_response();
    };
    let chosen_effort = match payload
        .reasoning_effort
        .as_deref()
        .map(str::trim)
        .filter(|effort| !effort.is_empty())
    {
        Some(effort) if crate::config::is_reasoning_effort(effort) => Some(effort.to_string()),
        Some(_) => {
            return (
                StatusCode::BAD_REQUEST,
                "Reasoning effort must be low, medium, high, or xhigh.".to_string(),
            )
                .into_response();
        }
        None => None,
    };
    // Trimmed empty is the same as absent: the model's argument stands.
    // `default` is a model-side alias for 30s and is not a dialog value.
    let chosen_timeout = match payload
        .command_timeout
        .as_deref()
        .map(str::trim)
        .filter(|limit| !limit.is_empty())
    {
        Some("30s" | "20m" | "none") => Some(
            payload
                .command_timeout
                .as_deref()
                .unwrap_or_default()
                .trim()
                .to_string(),
        ),
        Some(_) => {
            return (
                StatusCode::BAD_REQUEST,
                "Command time limit must be 30s, 20m, or none.".to_string(),
            )
                .into_response();
        }
        None => None,
    };
    // A blank replacement is a mistake, not a request to run the model's
    // command. Absent means the model's command stands.
    let chosen_command = match payload.command.as_deref() {
        None => None,
        Some(command) => {
            let command = command.trim();
            if command.is_empty() {
                return (
                    StatusCode::BAD_REQUEST,
                    "Enter the command to run.".to_string(),
                )
                    .into_response();
            }
            Some(command.to_string())
        }
    };
    let chosen_note = payload
        .text
        .as_deref()
        .map(str::trim)
        .filter(|note| !note.is_empty())
        .map(str::to_string);
    let decision = if let Some(review) = &request.review_request {
        // The review gate is shared between web tools and read_pdf: both
        // execute only on the explicit execute decision, and both pass
        // through a second review where the user approves (or edits) the
        // exact text that reaches the model.
        let redirect = |text: Option<String>| {
            let text = text.unwrap_or_default();
            if text.trim().is_empty() {
                Err("Alternate instructions are empty.".to_string())
            } else {
                Ok(ApprovalDecision::Redirect(text))
            }
        };
        match review {
            crate::config::ReviewRequest::Web(web) => match payload.action.as_str() {
                "approve" | "web_execute" if web.preview.is_none() => Ok(
                    ApprovalDecision::ReviewExecute(crate::config::ReviewRequest::Web(web.clone())),
                ),
                "web_result" => web
                    .result(payload.text.clone().unwrap_or_default())
                    .map(ApprovalDecision::WebResult),
                "redirect" => redirect(payload.text.clone()),
                _ => Err("This request expects fetched web results.".to_string()),
            },
            crate::config::ReviewRequest::Pdf(pdf) => match payload.action.as_str() {
                "approve" | "web_execute" if pdf.preview.is_none() => Ok(
                    ApprovalDecision::ReviewExecute(crate::config::ReviewRequest::Pdf(pdf.clone())),
                ),
                "web_result" => pdf
                    .result(payload.text.clone().unwrap_or_default())
                    .map(ApprovalDecision::WebResult),
                "redirect" => redirect(payload.text.clone()),
                _ => Err("This request expects extracted PDF text.".to_string()),
            },
            crate::config::ReviewRequest::Rag(rag) => match payload.action.as_str() {
                "approve" | "web_execute" if rag.preview.is_none() => Ok(
                    ApprovalDecision::ReviewExecute(crate::config::ReviewRequest::Rag(rag.clone())),
                ),
                "web_result" => rag
                    .result(payload.text.clone().unwrap_or_default())
                    .map(ApprovalDecision::WebResult),
                "redirect" => redirect(payload.text.clone()),
                _ => Err("This request expects curated RAG results.".to_string()),
            },
            crate::config::ReviewRequest::Cmd(_) => match payload.action.as_str() {
                "web_result" => {
                    let text = payload.text.clone().unwrap_or_default();
                    if text.trim().is_empty() {
                        Err("Enter the command output, or an explicit note that it produced nothing useful.".to_string())
                    } else {
                        // A bare string: the loop sends this text as the tool
                        // result. Wrapping it in JSON would quote it.
                        Ok(ApprovalDecision::WebResult(serde_json::Value::String(text)))
                    }
                }
                "redirect" => redirect(payload.text.clone()),
                _ => Err("This request expects reviewed command output.".to_string()),
            },
        }
    } else {
        match (&request.interaction, payload.action.as_str()) {
            (Some(interaction), "answer") => interaction
                .answer(payload.answers.as_deref().unwrap_or(&[]))
                .map(ApprovalDecision::Answer),
            (None, "approve") => Ok(ApprovalDecision::Approved {
                command_timeout: chosen_timeout,
                command: chosen_command,
                note: chosen_note,
            }),
            (None, "redirect") => {
                let text = payload.text.unwrap_or_default();
                if text.trim().is_empty() {
                    Err("Alternate instructions are empty.".to_string())
                } else {
                    Ok(ApprovalDecision::Redirect(text))
                }
            }
            (Some(_), _) => Err("This request requires question answers.".to_string()),
            (None, _) => Err("Expected approve or redirect.".to_string()),
        }
    };
    let decision = match decision {
        Ok(decision) => decision,
        Err(error) => return (StatusCode::BAD_REQUEST, error).into_response(),
    };
    if let Some(effort) = chosen_effort
        && let Some(waiting) = pending.get(&payload.approval_id)
        && let Ok(mut guard) = waiting.reasoning_effort.lock()
    {
        *guard = Some(effort);
    }
    if let Some(waiting) = pending.get(&payload.approval_id) {
        // The drag-select focus region stays off the decision value. The
        // view_img loop reads it from this slot after the decision, along
        // with the crop flag that says only the region should be sent.
        if payload.action == "approve"
            && let Some(region) = payload.image_region.clone().and_then(|r| r.normalized())
            && let Ok(mut guard) = waiting.image_region.lock()
        {
            *guard = Some(region);
            if let Ok(mut crop) = waiting.image_crop.lock() {
                *crop = payload.image_crop.unwrap_or(false);
            }
        }
    }
    // Invalid submissions leave the original request available for retry.
    let request = pending
        .remove(&payload.approval_id)
        .expect("request held under lock");
    drop(pending);
    if request.sender.send(decision).is_err() {
        return (
            StatusCode::GONE,
            "Run is no longer waiting for this response.".to_string(),
        )
            .into_response();
    }
    (StatusCode::OK, "ok".to_string()).into_response()
}

#[derive(Deserialize)]
pub(crate) struct StopRequest {
    /// Omit under the single-user lock to stop the active run.
    pub(crate) run_id: Option<String>,
}

/// Abort an in-flight chain. The task is dropped (freeing its semaphore
/// permit) and its pending approvals are purged so a later run never
/// inherits them. The browser sees the NDJSON stream close.
pub(crate) async fn stop_handler(
    State(state): State<AppState>,
    Json(payload): Json<StopRequest>,
) -> impl IntoResponse {
    let target = match payload.run_id {
        Some(id) => {
            if !state.runs.lock().await.contains_key(&id) {
                // Registration race: the generate task exists but has not
                // entered the runs map yet. Arm a stop flag the loop checks
                // at its first round so "stop" issued slightly early wins.
                // The flag is bounded and expires — an id that can never
                // match a run is refused rather than remembered.
                if state.arm_stop_flag(&id).await {
                    return (StatusCode::OK, "stop armed".to_string()).into_response();
                }
                return (
                    StatusCode::NOT_FOUND,
                    "No run in flight with that id.".to_string(),
                )
                    .into_response();
            }
            id
        }
        None => {
            let runs = state.runs.lock().await;
            let Some((id, _)) = runs.iter().next() else {
                // Same registration race as the id path, for a caller
                // that has no id yet (the run has not announced itself):
                // arm the next-run slot so a stop issued slightly early
                // still wins. Harmless when no run is coming — the slot
                // is one deep and expires with the same TTL.
                drop(runs);
                state.arm_stop_next().await;
                return (StatusCode::OK, "stop armed".to_string()).into_response();
            };
            id.clone()
        }
    };
    if let Some(handle) = state.runs.lock().await.remove(&target) {
        handle.abort();
    }
    {
        let mut pending = state.pending.lock().await;
        pending.retain(|id, _| !id.starts_with(&format!("{target}:")));
    }
    // Preserve accumulated metrics instead of zeroing them: sum per-round
    // metrics events so the permanent record keeps prompt/completion totals
    // even when the chain never reached its natural `done` event.
    // Never overwrite a terminal status (done/error/aborted/stopped).
    if let Some(Some(doc)) = state.history.get_run(&target).await {
        let status = doc
            .get("run")
            .and_then(|r| r.get("status"))
            .and_then(|s| s.as_str())
            .unwrap_or("");
        if matches!(status, "done" | "error" | "aborted" | "stopped") {
            return (StatusCode::OK, "stopped".to_string()).into_response();
        }
        let events = doc
            .get("events")
            .and_then(|e| e.as_array())
            .cloned()
            .unwrap_or_default();
        let mut next_seq: i64 = 0;
        let mut total_prompt: i64 = 0;
        let mut total_completion: i64 = 0;
        for e in &events {
            if let Some(seq) = e.get("seq").and_then(|s| s.as_i64()) {
                next_seq = next_seq.max(seq);
            }
            if e.get("type").and_then(|t| t.as_str()) == Some("metrics")
                && let Some(p) = e.get("payload")
            {
                total_prompt += p.get("prompt_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                total_completion += p
                    .get("completion_tokens")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
            }
        }
        next_seq += 1;
        let wall_ms = doc
            .get("run")
            .and_then(|r| r.get("wall_ms"))
            .and_then(|w| w.as_i64())
            .unwrap_or(0);
        state
            .history
            .add_event(&target, next_seq, "stopped", 0, &serde_json::json!({}))
            .await;
        state
            .history
            .finish_run(&target, "stopped", total_prompt, total_completion, wall_ms)
            .await;
    } else if state.history.enabled() {
        // No row (e.g. abort raced create_run): record minimal terminal state.
        state
            .history
            .add_event(&target, 1, "stopped", 0, &serde_json::json!({}))
            .await;
        state.history.finish_run(&target, "stopped", 0, 0, 0).await;
    }
    (StatusCode::OK, "stopped".to_string()).into_response()
}

/// `GET /history` — the recorded sessions, newest first. `?limit=N` caps
/// the list at the N newest runs; the default is unbounded, because
/// export and continue always page over the full list.
#[derive(serde::Deserialize)]
pub(crate) struct HistoryListQuery {
    #[serde(default)]
    limit: Option<String>,
}

pub(crate) async fn history_list_handler(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<HistoryListQuery>,
) -> impl IntoResponse {
    let limit = match query.limit {
        None => None,
        Some(raw) => match raw.trim().parse::<usize>() {
            Ok(n) => Some(n),
            Err(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    format!("limit {raw:?} is not a non-negative integer"),
                )
                    .into_response();
            }
        },
    };
    Json(state.history.list_runs(limit).await).into_response()
}

/// `GET /history/page` — one summary page plus the total row count.
/// The older `/history` response stays an array for existing callers.
#[derive(serde::Deserialize)]
pub(crate) struct HistoryPageQuery {
    #[serde(default)]
    limit: Option<String>,
    #[serde(default)]
    offset: Option<String>,
}

fn history_page_count(raw: Option<&str>, field: &str, default: usize) -> Result<usize, String> {
    let Some(raw) = raw else { return Ok(default) };
    match raw.trim().parse::<usize>() {
        Ok(n) if i64::try_from(n).is_ok() => Ok(n),
        _ => Err(format!("{field} {raw:?} is not a non-negative integer")),
    }
}

pub(crate) async fn history_page_handler(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<HistoryPageQuery>,
) -> impl IntoResponse {
    let limit = match history_page_count(query.limit.as_deref(), "limit", 20) {
        Ok(limit) => limit,
        Err(reason) => return (StatusCode::BAD_REQUEST, reason).into_response(),
    };
    let offset = match history_page_count(query.offset.as_deref(), "offset", 0) {
        Ok(offset) => offset,
        Err(reason) => return (StatusCode::BAD_REQUEST, reason).into_response(),
    };
    match state.history.list_runs_page(limit, offset).await {
        Some(page) => Json(page).into_response(),
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            state
                .history
                .failure_reason()
                .unwrap_or_else(|| "History is unavailable.".to_string()),
        )
            .into_response(),
    }
}

pub(crate) async fn history_get_handler(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> impl IntoResponse {
    match state.history.get_run(&id).await {
        Some(Some(mut doc)) => {
            annotate_history_doc(&mut doc);
            Json(doc).into_response()
        }
        // A missing run is an ordinary 404 and does not latch anything.
        Some(None) => (StatusCode::NOT_FOUND, "No such recorded run.".to_string()).into_response(),
        // A database failure is not the run's fault: say so instead of
        // pretending the run never existed.
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            state
                .history
                .failure_reason()
                .unwrap_or_else(|| "history is unavailable".to_string()),
        )
            .into_response(),
    }
}

fn annotate_history_doc(doc: &mut serde_json::Value) {
    let Some(events) = doc.get_mut("events").and_then(|value| value.as_array_mut()) else {
        return;
    };
    crate::diff::annotate_history_edits(events);
}

#[derive(Deserialize)]
pub(crate) struct HistoryRoundsQuery {
    #[serde(default)]
    from: Option<i64>,
    #[serde(default)]
    to: Option<i64>,
    #[serde(default)]
    tail: Option<i64>,
}

/// A scroll window of one recorded run. The full transcript stays on
/// `GET /history/{id}` for export and continue.
pub(crate) async fn history_rounds_handler(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    axum::extract::Query(query): axum::extract::Query<HistoryRoundsQuery>,
) -> impl IntoResponse {
    match state
        .history
        .round_window(&id, query.from, query.to, query.tail)
        .await
    {
        Some(mut doc) => {
            annotate_history_doc(&mut doc);
            Json(doc).into_response()
        }
        None => (StatusCode::NOT_FOUND, "No such recorded run.".to_string()).into_response(),
    }
}

pub(crate) async fn history_event_handler(
    State(state): State<AppState>,
    axum::extract::Path(hid): axum::extract::Path<String>,
) -> impl IntoResponse {
    let hid = match hid.trim().parse::<i64>() {
        Ok(n) if n > 0 => n,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                "History id must be a positive integer.".to_string(),
            )
                .into_response();
        }
    };
    match state.history.get_event(hid).await {
        Some(Some(doc)) => Json(doc).into_response(),
        Some(None) => (StatusCode::NOT_FOUND, "No such history event.".to_string()).into_response(),
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            state
                .history
                .failure_reason()
                .unwrap_or_else(|| "history is unavailable".to_string()),
        )
            .into_response(),
    }
}

pub(crate) async fn history_delete_handler(
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> impl IntoResponse {
    if state.history.delete_run(&id).await {
        (StatusCode::OK, "deleted".to_string()).into_response()
    } else {
        (StatusCode::NOT_FOUND, "No such recorded run.".to_string()).into_response()
    }
}

/// Registry provenance for one custom tool. The builtin (`run_cmd`) has
/// no entry and is reported as `"builtin"` client-side.
#[derive(Serialize)]
struct ToolMeta {
    name: String,
    origin: String,
    file: String,
}

/// Exact registration snapshot the model sees at session start.
/// Serialized from the same structs the tool loop sends — read-only proof
/// of what the model is aware of. Served to the ⚙ config tab.
#[derive(Serialize)]
struct ConfigResponse {
    model: String,
    /// The model future launches start with. "Make Default" overrides it.
    default_model: String,
    /// The model the "decision" tab queries. Independent of `model`.
    decision_model: String,
    /// Selector groups for the decision tab: OLLAMA cloud decision models
    /// plus the LOCAL installed decision models.
    decision_models: String,
    /// True when the selected model sends prompts/tool outputs off-box.
    model_cloud: bool,
    system_prompt: String,
    /// Role template the config page edits. `{comment_tag}` is still a
    /// placeholder here. `system_prompt` is that template after filling.
    system_prompt_template: String,
    /// Built-in role from `model_voice`. Restore default sends this text back.
    system_prompt_default: String,
    /// First 20 hex characters of this launch's comment key. The curation
    /// box inserts it; displayed transcripts translate it back.
    comment_tag: String,
    /// None = no round cap (chains end when the model stops or the user stops).
    max_tool_rounds: Option<usize>,
    workspace_dir: String,
    /// Directory named in the workspace sentence. The launch directory
    /// when the custom path is empty.
    workspace_env: String,
    /// When false, the workspace sentence is left off the role.
    workspace_env_enabled: bool,
    /// The sentence that will follow the role. Empty when the switch is off.
    workspace_sentence: String,
    custom_files: Vec<String>,
    tools: Vec<ollama_rs::generation::tools::ToolInfo>,
    tool_meta: Vec<ToolMeta>,
    enabled_tools: Vec<String>,
    /// Tools whose calls skip the approval dialog on the next run.
    approve_calls: Vec<String>,
    /// Tools whose captured output skips the second review on the next run.
    approve_outputs: Vec<String>,
    /// When true, the next run reviews `run_cmd` output before the model sees it.
    review_run_cmd: bool,
    /// False when the database could not be opened or a write has failed.
    /// New runs stay refused until the page sends `allow_unrecorded`.
    history_recording: bool,
    /// The first reason recording stopped. Empty while recording.
    history_error: Option<String>,
    /// Effort used by the next Grok run. Ollama runs ignore it.
    reasoning_effort: String,
    /// True when `XAI_API_KEY` is set. The key itself stays on the server.
    grok_key: bool,
    /// True when `REFLECTION_API_KEY` is set. The key itself stays on the server.
    reflection_key: bool,
    /// True when `OPENCODE_API_KEY` is set. The key itself stays on the server.
    opencode_key: bool,
    /// True when the Ollama daemon answered a reachability probe.
    ollama_server: bool,
    /// True when `HARNESS_DB_KEY` is loaded. The passphrase stays on the server.
    harness_db_key: bool,
    /// Project memory catalog for the config and tools dropdowns. Notes stay
    /// on `/memory`; this is only the names and the selection.
    memory_recording: bool,
    memory_error: Option<String>,
    memory_project: Option<String>,
    memory_projects: Vec<crate::memory::ProjectInfo>,
}


fn memory_busy(state: &AppState) -> Result<(), String> {
    if state.semaphore.available_permits() == 0 {
        return Err("A run is in flight — change project memory when it finishes.".to_string());
    }
    Ok(())
}

async fn disable_project_mem(state: &AppState) {
    let policy = crate::tools::tool_policy_lists(state).await;
    if !policy
        .enabled
        .iter()
        .any(|name| name == crate::tools::project_mem::TOOL_NAME)
    {
        return;
    }
    let enabled: Vec<String> = policy
        .enabled
        .into_iter()
        .filter(|name| name != crate::tools::project_mem::TOOL_NAME)
        .collect();
    let _ = crate::tools::set_tool_policy(state, &enabled, None, None).await;
}

pub(crate) async fn memory_get_handler(State(state): State<AppState>) -> impl IntoResponse {
    Json(state.memory.snapshot().await).into_response()
}

#[derive(Deserialize)]
pub(crate) struct MemoryNameRequest {
    name: String,
    #[serde(default)]
    description: String,
}

#[derive(Deserialize)]
pub(crate) struct MemorySelectRequest {
    name: Option<String>,
}

pub(crate) async fn memory_create_handler(
    State(state): State<AppState>,
    Json(payload): Json<MemoryNameRequest>,
) -> impl IntoResponse {
    if let Err(message) = memory_busy(&state) {
        return (StatusCode::CONFLICT, message).into_response();
    }
    if let Err(message) = state
        .memory
        .create_project(&payload.name, &payload.description)
        .await
    {
        return (StatusCode::BAD_REQUEST, message).into_response();
    }
    // A new project is selected so the dropdown and the tool can use it.
    // The tool itself stays off until the checkbox is turned on.
    if let Err(message) = state.memory.select(Some(payload.name.trim())).await {
        return (StatusCode::BAD_REQUEST, message).into_response();
    }
    Json(state.memory.snapshot().await).into_response()
}

pub(crate) async fn memory_description_handler(
    State(state): State<AppState>,
    Json(payload): Json<MemoryNameRequest>,
) -> impl IntoResponse {
    if let Err(message) = memory_busy(&state) {
        return (StatusCode::CONFLICT, message).into_response();
    }
    if let Err(message) = state
        .memory
        .update_description(&payload.name, &payload.description)
        .await
    {
        return (StatusCode::BAD_REQUEST, message).into_response();
    }
    Json(state.memory.snapshot().await).into_response()
}

pub(crate) async fn memory_select_handler(
    State(state): State<AppState>,
    Json(payload): Json<MemorySelectRequest>,
) -> impl IntoResponse {
    if let Err(message) = memory_busy(&state) {
        return (StatusCode::CONFLICT, message).into_response();
    }
    let name = payload.name.as_deref().map(str::trim).filter(|name| !name.is_empty());
    if let Err(message) = state.memory.select(name).await {
        return (StatusCode::BAD_REQUEST, message).into_response();
    }
    if name.is_none() {
        disable_project_mem(&state).await;
    }
    Json(state.memory.snapshot().await).into_response()
}

pub(crate) async fn memory_delete_handler(
    State(state): State<AppState>,
    Json(payload): Json<MemoryNameRequest>,
) -> impl IntoResponse {
    if let Err(message) = memory_busy(&state) {
        return (StatusCode::CONFLICT, message).into_response();
    }
    let selected = state.memory.selected().await;
    if let Err(message) = state.memory.delete_project(&payload.name).await {
        return (StatusCode::BAD_REQUEST, message).into_response();
    }
    if selected.as_deref() == Some(payload.name.trim()) {
        disable_project_mem(&state).await;
    }
    Json(state.memory.snapshot().await).into_response()
}

#[derive(Deserialize)]
pub(crate) struct ToolsRequest {
    enabled: Vec<String>,
    /// Absent leaves the stored set in place. The handler then keeps only
    /// names that are still enabled. `ask_user` is dropped.
    #[serde(default)]
    approve_calls: Option<Vec<String>>,
    /// Absent leaves the stored set in place. A name is kept only for an
    /// enabled tool that is not in `approve_calls`.
    #[serde(default)]
    approve_outputs: Option<Vec<String>>,
}

/// Set the tools registered for the *next* run (in-memory, process-local
/// like CURRENT_MODEL). Refuses unknown names wholesale. A run in flight
/// keeps its start-of-run snapshot regardless.
pub(crate) async fn tools_handler(
    State(state): State<AppState>,
    Json(payload): Json<ToolsRequest>,
) -> impl IntoResponse {
    // Keep the documented start-of-run snapshot semantics: a run in flight
    // must not observe a mid-chain registry mutation. The stream loop also
    // snapshots its tools at run start.
    if state.semaphore.available_permits() == 0 {
        return (
            StatusCode::CONFLICT,
            "A run is in flight — change tools when it finishes.".to_string(),
        )
            .into_response();
    }
    match crate::tools::set_tool_policy(
        &state,
        &payload.enabled,
        payload.approve_calls.as_deref(),
        payload.approve_outputs.as_deref(),
    )
    .await
    {
        Ok(policy) => Json(serde_json::json!({
            "enabled_tools": policy.enabled,
            "approve_calls": policy.approve_calls,
            "approve_outputs": policy.approve_outputs,
        }))
        .into_response(),
        Err(message) => (StatusCode::BAD_REQUEST, message).into_response(),
    }
}

/// Provider context window for the model the next run will use.
/// `tokens` is null when the provider did not report one; the page then
/// asks for a typed guide limit before starting the run.
pub(crate) async fn context_window_handler(
    State(state): State<AppState>,
) -> Json<serde_json::Value> {
    let tokens = crate::config::provider_context_window(&state.ollama, &current_model()).await;
    Json(serde_json::json!({ "tokens": tokens }))
}

// ---- the workspace listing behind the `work` pane -----------------------

/// One line of the workspace listing: a file or a directory with its
/// children already nested. `dir` decides the trailing slash and the
/// copy affordance on the page.
#[derive(Serialize)]
pub(crate) struct WorkspaceEntry {
    name: String,
    dir: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    children: Vec<WorkspaceEntry>,
}

/// The `/workspace` payload the work pane renders.
#[derive(Serialize)]
pub(crate) struct WorkspaceListing {
    /// Absolute workspace path, shown and copyable as the pane's root.
    root: String,
    entries: Vec<WorkspaceEntry>,
    /// True when the depth or entry cap stopped the walk early.
    truncated: bool,
}

/// Deepest path shown, counted in components: `src/tools/x.rs` is three.
/// Deeper directories appear as plain names a person opens on disk.
const WORKSPACE_MAX_DEPTH: usize = 3;
/// Total lines the walk may produce, bounding one request's filesystem
/// work and the pane's size. Dot entries (`.git`, editor caches) are
/// skipped before the budget and never count against it.
const WORKSPACE_MAX_ENTRIES: usize = 400;

/// Read one directory level. Directories first, then files, each
/// alphabetical. An unreadable level renders as nothing rather than an
/// error: a permission problem on one folder must not sink the pane.
/// `budget` is shared across the whole walk; when it runs out the walk
/// stops and the caller marks the listing truncated.
fn walk_workspace(dir: &std::path::Path, depth: usize, budget: &mut usize) -> (Vec<WorkspaceEntry>, bool) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return (Vec::new(), false);
    };
    let mut found: Vec<(String, bool)> = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        // `file_type` does not follow symlinks: a link to a directory is
        // listed as a file and never descended, so the walk cannot cycle.
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        found.push((name, is_dir));
    }
    // The work pane leads with the root's own files — the place a person
    // drops downloads — then the subdirectories. Deeper levels keep the
    // classic tree order, directories first, so a folder's contents read
    // as a fan-out under its name.
    if depth == 1 {
        found.sort_by(|a, b| {
            a.1.cmp(&b.1).then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase()))
        });
    } else {
        found.sort_by(|a, b| {
            b.1.cmp(&a.1).then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase()))
        });
    }
    let mut out = Vec::new();
    let mut truncated = false;
    for (name, is_dir) in found {
        if *budget == 0 {
            truncated = true;
            break;
        }
        *budget -= 1;
        let mut children = Vec::new();
        if is_dir && depth < WORKSPACE_MAX_DEPTH {
            let (kids, inner_truncated) = walk_workspace(&dir.join(&name), depth + 1, budget);
            children = kids;
            truncated = truncated || inner_truncated;
        }
        out.push(WorkspaceEntry {
            name,
            dir: is_dir,
            children,
        });
    }
    (out, truncated)
}

/// The `work` pane's directory listing: read-only names behind the same
/// token auth as every other route. The caps bound the filesystem work
/// so one request cannot stall the page on a huge tree.
pub(crate) async fn workspace_handler() -> Json<WorkspaceListing> {
    let root = crate::config::WORKSPACE_DIR.clone();
    let listing = tokio::task::spawn_blocking(move || {
        let mut budget = WORKSPACE_MAX_ENTRIES;
        let (entries, truncated) = walk_workspace(&root, 1, &mut budget);
        WorkspaceListing {
            root: root.to_string_lossy().into_owned(),
            entries,
            truncated,
        }
    })
    .await
    .unwrap_or_else(|_| WorkspaceListing {
        root: crate::config::workspace_dir_string(),
        entries: Vec::new(),
        truncated: false,
    });
    Json(listing)
}


pub(crate) async fn config_handler(State(state): State<AppState>) -> impl IntoResponse {
    // Reads the live registry — always exactly what the model gets.
    let tools = crate::tools::all_tools().await;
    let policy = crate::tools::tool_policy_lists(&state).await;
    let guard = crate::config::CUSTOM_TOOLS.read().await;
    let model = current_model();
    let role = crate::config::role_settings();
    let (memory_recording, memory_error, memory_project, memory_projects) =
        state.memory.catalog().await;
    let (ollama_server, decision_installed) = tokio::join!(
        crate::models::ollama_server_available(&state.ollama),
        crate::models::installed_decision_models(&state.ollama),
    );
    let decision_installed = decision_installed.unwrap_or_default();
    let decision_models = crate::models::decision_model_groups_json(&decision_installed);
    Json(ConfigResponse {
        model_cloud: crate::config::is_cloud_model(&model),
        model,
        default_model: crate::config::default_model(),
        decision_model: crate::models::decision_model(),
        decision_models,
        system_prompt: crate::config::system_prompt_with_workspace(),
        system_prompt_template: role.template.clone(),
        system_prompt_default: crate::model_voice::SYSTEM_PROMPT.to_string(),
        comment_tag: crate::config::comment_tag().to_string(),
        max_tool_rounds: None,
        workspace_dir: workspace_dir_string(),
        workspace_env: crate::config::effective_workspace_env(&role),
        workspace_env_enabled: role.workspace_enabled,
        workspace_sentence: crate::config::workspace_sentence_text(&role),
        custom_files: guard.iter().map(|s| s.file.clone()).collect(),
        tools,
        tool_meta: guard
            .iter()
            .map(|s| ToolMeta {
                name: s.name.clone(),
                origin: s.origin.clone(),
                file: s.file.clone(),
            })
            .collect(),
        enabled_tools: policy.enabled,
        approve_calls: policy.approve_calls,
        approve_outputs: policy.approve_outputs,
        review_run_cmd: state.review_run_cmd.load(Ordering::Relaxed),
        history_recording: state.history.recording(),
        history_error: state.history.failure_reason(),
        reasoning_effort: crate::config::current_reasoning_effort(),
        grok_key: crate::providers::by_id("xAI")
            .and_then(|spec| spec.key_env)
            .map(crate::keys::provider_key_available)
            .unwrap_or(false),
        reflection_key: crate::providers::by_id("Reflection")
            .and_then(|spec| spec.key_env)
            .map(crate::keys::provider_key_available)
            .unwrap_or(false),
        opencode_key: crate::providers::by_id("OpenCode")
            .and_then(|spec| spec.key_env)
            .map(crate::keys::provider_key_available)
            .unwrap_or(false),
        ollama_server,
        harness_db_key: crate::keys::db_key_available(),
        memory_recording: memory_recording,
        memory_error,
        memory_project,
        memory_projects,
    })
    .into_response()
}

#[derive(Deserialize)]
pub(crate) struct ReasoningEffortRequest {
    effort: String,
}

/// Set how hard the next Grok run thinks. Refused while a run is in
/// flight, same rule as `/model`. Ollama runs do not read this value.
pub(crate) async fn reasoning_effort_handler(
    State(state): State<AppState>,
    Json(payload): Json<ReasoningEffortRequest>,
) -> impl IntoResponse {
    let effort = payload.effort.trim().to_string();
    if !crate::config::is_reasoning_effort(&effort) {
        return (
            StatusCode::BAD_REQUEST,
            format!("Unknown reasoning effort: {effort}"),
        )
            .into_response();
    }
    if state.semaphore.available_permits() == 0 {
        return (
            StatusCode::CONFLICT,
            "A run is in flight — change reasoning effort when it finishes.".to_string(),
        )
            .into_response();
    }
    match crate::config::CURRENT_REASONING_EFFORT.write() {
        Ok(mut guard) => {
            *guard = effort.clone();
            (
                StatusCode::OK,
                Json(serde_json::json!({ "effort": effort })),
            )
                .into_response()
        }
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Reasoning effort lock poisoned".to_string(),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
pub(crate) struct RunCmdReviewRequest {
    enabled: bool,
}

/// Turn `run_cmd` output review on or off for the next run. A run in
/// flight keeps the value it read at start, so this refuses while the
/// single-run semaphore is held — the same rule as `/tools`.
pub(crate) async fn run_cmd_review_handler(
    State(state): State<AppState>,
    Json(payload): Json<RunCmdReviewRequest>,
) -> impl IntoResponse {
    if state.semaphore.available_permits() == 0 {
        return (
            StatusCode::CONFLICT,
            "A run is in flight — change command review when it finishes.".to_string(),
        )
            .into_response();
    }
    state
        .review_run_cmd
        .store(payload.enabled, Ordering::Relaxed);
    Json(serde_json::json!({ "review_run_cmd": payload.enabled })).into_response()
}

#[derive(Deserialize)]
pub(crate) struct RoleRequest {
    template: String,
    workspace_enabled: bool,
    workspace_env: String,
}

fn role_body() -> serde_json::Value {
    let role = crate::config::role_settings();
    serde_json::json!({
        "system_prompt": crate::config::system_prompt_with_workspace(),
        "system_prompt_template": role.template,
        "system_prompt_default": crate::model_voice::SYSTEM_PROMPT,
        "workspace_env_enabled": role.workspace_enabled,
        "workspace_env": crate::config::effective_workspace_env(&role),
        "workspace_sentence": crate::config::workspace_sentence_text(&role),
    })
}

/// Replace the role and the workspace sentence for the next run.
/// A run in flight keeps the prompt it started with.
pub(crate) async fn role_handler(
    State(state): State<AppState>,
    Json(payload): Json<RoleRequest>,
) -> impl IntoResponse {
    if state.semaphore.available_permits() == 0 {
        return (
            StatusCode::CONFLICT,
            "A run is in flight — change the role when it finishes.".to_string(),
        )
            .into_response();
    }
    let template = match crate::config::normalize_role_template(&payload.template) {
        Ok(template) => template,
        Err(message) => return (StatusCode::BAD_REQUEST, message).into_response(),
    };
    let workspace_env = match crate::config::normalize_workspace_env(&payload.workspace_env) {
        Ok(path) => path,
        Err(message) => return (StatusCode::BAD_REQUEST, message).into_response(),
    };
    let next = crate::config::RoleSettings {
        template,
        workspace_enabled: payload.workspace_enabled,
        workspace_env,
    };
    if crate::config::store_role_settings(next).is_err() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Role lock poisoned".to_string(),
        )
            .into_response();
    }
    Json(role_body()).into_response()
}

/// Switch the model used for the *next* run. A name must be in the published
/// cloud catalog, a Grok model, or a chat model the local Ollama lists.
/// Refuses while a run is in flight — the selector grays out the same case
/// (busy = the single-run semaphore has no permit free).
/// The swap is process-local and resets to DEFAULT_MODEL on restart.
#[derive(Deserialize)]
pub(crate) struct ModelRequest {
    model: String,
}

pub(crate) async fn model_handler(
    State(state): State<AppState>,
    Json(payload): Json<ModelRequest>,
) -> impl IntoResponse {
    let model = payload.model.trim().to_string();
    if !crate::config::model_is_selectable(&state.ollama, &model).await {
        return (StatusCode::BAD_REQUEST, format!("Unknown model: {model}")).into_response();
    }
    if state.semaphore.available_permits() == 0 {
        return (
            StatusCode::CONFLICT,
            "A run is in flight — switch models when it finishes.".to_string(),
        )
            .into_response();
    }
    if crate::config::is_cloud_model(&model) {
        eprintln!(
            "***NOTE***: switched to cloud model {model:?} — prompts and tool outputs will leave this machine"
        );
    }
    match crate::config::CURRENT_MODEL.write() {
        Ok(mut guard) => {
            *guard = model.clone();
            (StatusCode::OK, Json(serde_json::json!({ "model": model }))).into_response()
        }
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Model lock poisoned".to_string(),
        )
            .into_response(),
    }
}

/// Set the default model for future launches ("Make Default"). Unlike
/// `/model` it does not touch the current selection; it changes what the
/// next launch starts with. The browser also keeps the copy and re-sends
/// it on load, like the role.
#[derive(Deserialize)]
pub(crate) struct DefaultModelRequest {
    model: String,
}

pub(crate) async fn default_model_handler(
    State(state): State<AppState>,
    Json(payload): Json<DefaultModelRequest>,
) -> impl IntoResponse {
    let model = payload.model.trim().to_string();
    if !crate::config::model_is_selectable(&state.ollama, &model).await {
        return (StatusCode::BAD_REQUEST, format!("Unknown model: {model}")).into_response();
    }
    if crate::config::store_default_model(model.clone()).is_err() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Default model lock poisoned".to_string(),
        )
            .into_response();
    }
    Json(serde_json::json!({ "default_model": model })).into_response()
}

#[derive(Deserialize)]
pub(crate) struct DecisionRequest {
    /// Absent uses the stored decision model.
    #[serde(default)]
    model: Option<String>,
    kind: String,
    prompt: String,
    #[serde(default)]
    min: Option<i64>,
    #[serde(default)]
    max: Option<i64>,
    #[serde(default)]
    options: Option<Vec<String>>,
}

#[derive(Deserialize)]
pub(crate) struct DecisionModelRequest {
    model: String,
}

/// Parse and validate one decision query's kind from the request body.
fn decision_kind(
    kind: &str,
    min: Option<i64>,
    max: Option<i64>,
    options: Option<Vec<String>>,
) -> Result<crate::decision::DecisionKind, String> {
    match kind {
        "bool" => Ok(crate::decision::DecisionKind::Bool),
        "rating" => {
            let min = min.unwrap_or(1);
            let max = max.unwrap_or(5);
            if !(min < max) || min < 0 || max > 100 {
                return Err("Rating scale must satisfy 0 <= min < max <= 100.".to_string());
            }
            Ok(crate::decision::DecisionKind::Rating { min, max })
        }
        "choice" => {
            let options: Vec<String> = options
                .unwrap_or_default()
                .into_iter()
                .map(|option| option.trim().to_string())
                .filter(|option| !option.is_empty())
                .collect();
            if options.is_empty() || options.len() > 26 {
                return Err("Provide between 1 and 26 non-empty options.".to_string());
            }
            let mut seen = std::collections::HashSet::new();
            for option in &options {
                if !seen.insert(option.to_lowercase()) {
                    return Err("Options must be unique.".to_string());
                }
            }
            Ok(crate::decision::DecisionKind::Choice { options })
        }
        other => Err(format!("Unknown decision kind: {other}")),
    }
}

/// Run one decision query against the selected decision model. This does
/// not touch the run semaphore, so it works while a [Generate] run is in
/// flight (including during an approval window). Results are transient:
/// nothing is written to history.
pub(crate) async fn decision_handler(
    State(state): State<AppState>,
    Json(payload): Json<DecisionRequest>,
) -> impl IntoResponse {
    let model = payload
        .model
        .clone()
        .unwrap_or_else(crate::models::decision_model);
    if !crate::models::is_safe_model_name(&model) {
        return (StatusCode::BAD_REQUEST, format!("Unknown model: {model}")).into_response();
    }
    let kind = match decision_kind(&payload.kind, payload.min, payload.max, payload.options) {
        Ok(kind) => kind,
        Err(message) => return (StatusCode::BAD_REQUEST, message).into_response(),
    };
    let prompt = payload.prompt.trim().to_string();
    if prompt.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            "Enter the context to decide on.".to_string(),
        )
            .into_response();
    }
    match tokio::time::timeout(
        std::time::Duration::from_secs(120),
        crate::decision::run_decision(&state.ollama, &model, &kind, &prompt),
    )
    .await
    {
        Ok(Ok(result)) => Json(serde_json::json!({
            "model": result.model,
            "kind": kind.label(),
            "raw": result.raw,
            "value": result.value,
            "parsed_ok": result.parsed_ok,
        }))
        .into_response(),
        Ok(Err(message)) => (StatusCode::BAD_GATEWAY, message).into_response(),
        Err(_) => (
            StatusCode::REQUEST_TIMEOUT,
            "Decision query timed out after 120 seconds.".to_string(),
        )
            .into_response(),
    }
}

/// Switch the model the "decision" tab uses. Unlike `/model`, this does
/// not affect the [Generate] run's model, and it is not refused while a
/// run is in flight.
pub(crate) async fn decision_model_handler(
    State(state): State<AppState>,
    Json(payload): Json<DecisionModelRequest>,
) -> impl IntoResponse {
    let model = payload.model.trim().to_string();
    if !crate::models::decision_model_is_selectable(&state.ollama, &model).await {
        return (StatusCode::BAD_REQUEST, format!("Unknown decision model: {model}")).into_response();
    }
    if crate::models::store_decision_model(model.clone()).is_err() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Decision model lock poisoned".to_string(),
        )
            .into_response();
    }
    Json(serde_json::json!({ "decision_model": model })).into_response()
}

pub(crate) async fn test_tool_handler(
    State(state): State<AppState>,
    Json(payload): Json<TestToolRequest>,
) -> impl IntoResponse {
    let tool = payload.tool.trim().to_string();
    let args = if payload.arguments.is_null() {
        serde_json::json!({})
    } else {
        payload.arguments
    };

    let is_web_fetch = tool == crate::tools::web::FETCH || tool == crate::tools::web::SEARCH;
    let is_pdf = tool == crate::tools::pdf::READ;
    let is_rag = crate::tools::rag::is_corpus_search_tool(&tool);
    let is_write_file = tool == crate::tools::write_file::TOOL_NAME;

    if !is_web_fetch && !is_pdf && !is_rag && !is_write_file {
        return (
            StatusCode::BAD_REQUEST,
            Json(TestToolResponse {
                tool: tool.clone(),
                preview: String::new(),
                raw: None,
                error: Some(format!("tool {tool:?} is not available for manual testing")),
            }),
        )
            .into_response();
    }

    if is_web_fetch {
        let request = match crate::tools::web::WebRequest::parse(&tool, &args) {
            Ok(r) => r,
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(TestToolResponse {
                        tool: tool.clone(),
                        preview: String::new(),
                        raw: None,
                        error: Some(e),
                    }),
                )
                    .into_response();
            }
        };
        let execution = request.execute(&state.web_runner).await;
        let preview = request.kind.as_str();
        let preview = if preview == "fetch" {
            execution.fetch_page_text()
        } else {
            execution.review_text()
        };
        let raw = serde_json::to_string_pretty(&execution).ok();
        return (
            StatusCode::OK,
            Json(TestToolResponse {
                tool,
                preview,
                raw,
                error: None,
            }),
        )
            .into_response();
    }

    if is_pdf {
        let request = match crate::tools::pdf::PdfRequest::parse(&tool, &args) {
            Ok(r) => r,
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(TestToolResponse {
                        tool: tool.clone(),
                        preview: String::new(),
                        raw: None,
                        error: Some(e),
                    }),
                )
                    .into_response();
            }
        };
        let execution = request.execute().await;
        let preview = if execution.exit_code == Some(0) && !execution.stdout.trim().is_empty() {
            execution.stdout.clone()
        } else {
            request.failure_text(&execution)
        };
        let raw = serde_json::to_string_pretty(&execution).ok();
        return (
            StatusCode::OK,
            Json(TestToolResponse {
                tool,
                preview,
                raw,
                error: None,
            }),
        )
            .into_response();
    }

    if is_write_file {
        // The operator's click is the approval: the write executes
        // immediately, and what lands on disk is exactly what was sent.
        // The result text is the same harness-generated line the model
        // would receive after an approved write; the raw window carries
        // the machine-shaped outcome.
        let request = match crate::tools::write_file::WriteFileRequest::parse(&args) {
            Ok(r) => r,
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(TestToolResponse {
                        tool: tool.clone(),
                        preview: String::new(),
                        raw: None,
                        error: Some(e),
                    }),
                )
                    .into_response();
            }
        };
        let outcome = request.execute();
        let raw = serde_json::to_string_pretty(&serde_json::json!({
            "ok": outcome.ok,
            "text": outcome.text.clone(),
            "path": request.display_path,
            "resolved": request.resolved.display().to_string(),
            "mode": request.mode,
            "before_lines": request.before.as_ref().map(|before| before.lines().count()),
            "after_lines": request.after.lines().count(),
        }))
        .ok();
        if !outcome.ok {
            return (
                StatusCode::BAD_REQUEST,
                Json(TestToolResponse {
                    tool,
                    preview: String::new(),
                    raw,
                    error: Some(outcome.text),
                }),
            )
                .into_response();
        }
        return (
            StatusCode::OK,
            Json(TestToolResponse {
                tool,
                preview: outcome.text,
                raw,
                error: None,
            }),
        )
            .into_response();
    }

    // RAG
    let request = match crate::tools::rag::RagSearchRequest::parse(&tool, &args) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(TestToolResponse {
                    tool: tool.clone(),
                    preview: String::new(),
                    raw: None,
                    error: Some(e),
                }),
            )
                .into_response();
        }
    };
    let execution = request.execute(&state.ollama).await;
    let preview = if execution.exit_code == Some(0) && !execution.stdout.trim().is_empty() {
        execution.stdout.clone()
    } else if !execution.stderr.trim().is_empty() {
        format!("{}\n{}", execution.stdout, execution.stderr).trim().to_string()
    } else {
        execution.stdout.clone()
    };
    let raw = serde_json::to_string_pretty(&execution).ok();
    (
        StatusCode::OK,
        Json(TestToolResponse {
            tool,
            preview,
            raw,
            error: None,
        }),
    )
        .into_response()
}

#[derive(Deserialize)]
pub(crate) struct TestToolRequest {
    pub tool: String,
    #[serde(default)]
    pub arguments: serde_json::Value,
}

#[derive(Serialize)]
pub(crate) struct TestToolResponse {
    pub tool: String,
    pub preview: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}


#[cfg(test)]
#[test]
fn approve_body_bytes_are_zeroed_after_parse() {
    // The raw /approve buffer is wiped after parsing, so a sensitive value
    // in the body (an edited command, a pasted transcript) does not linger
    // in the request buffer.
    let mut raw =
        br#"{"approval_id":"x","action":"approve","command":"canary-secret-value"}"#.to_vec();
    let payload = parse_approve_body(&mut raw).expect("parse");
    assert_eq!(payload.command.as_deref(), Some("canary-secret-value"));
    assert!(
        !raw.windows(b"canary-secret-value".len())
            .any(|window| window == b"canary-secret-value"),
        "body remained in the request buffer"
    );
    assert!(raw.iter().all(|byte| *byte == 0));
}

#[cfg(test)]
fn approve_body(request: ApproveRequest) -> Bytes {
    Bytes::from(serde_json::to_vec(&request).expect("approval request serializes"))
}

#[cfg(test)]
mod interaction_tests {
    use super::*;
    use crate::config::PendingApproval;
    use crate::tools::ask_user::{UserAnswer, UserInteraction};
    use std::{collections::HashMap, sync::atomic::AtomicU64};
    use tokio::sync::{Mutex, Semaphore, oneshot};

    fn test_state(history_path: &str) -> AppState {
        AppState {
            web_runner: "/bin/echo".into(),
            ollama: ollama_rs::Ollama::default(),
            semaphore: Arc::new(Semaphore::new(1)),
            enabled_tools: Arc::new(std::sync::RwLock::new(std::collections::HashSet::new())),
            approve_calls: crate::config::empty_tool_set(),
            approve_outputs: crate::config::empty_tool_set(),
            pending: Arc::new(Mutex::new(HashMap::new())),
            run_counter: Arc::new(AtomicU64::new(1)),
            runs: Arc::new(Mutex::new(HashMap::new())),
            stop_flags: Arc::new(Mutex::new(HashMap::new())),
            stop_next: Arc::new(Mutex::new(None)),
            history: crate::history::HistoryDb::open(history_path),
            memory: crate::memory::MemoryDb::open(":memory:"),
            review_run_cmd: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tool_policy_path: None,
        }
    }

    #[tokio::test]
    async fn a_run_is_refused_when_history_is_unavailable() {
        let state = test_state("/nonexistent-dir-xyz/harness.db");
        let response = generate_handler(
            State(state.clone()),
            Json(crate::stream::PromptRequest {
                prompt: "hello".into(),
                uploaded_files: vec![],
                allow_unrecorded: false,
                context_limit: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(text.contains("Session history is unavailable"), "{text}");
        assert_eq!(state.semaphore.available_permits(), 1);
    }

    #[tokio::test]
    async fn config_reports_whether_history_is_recording() {
        let response = config_handler(State(test_state(":memory:")))
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 1_000_000)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["history_recording"], true);
        assert!(json["history_error"].is_null());
        assert!(json["grok_key"].is_boolean());
        assert!(json["reflection_key"].is_boolean());
        assert!(json["opencode_key"].is_boolean());
        assert!(json["ollama_server"].is_boolean());
        assert!(json["harness_db_key"].is_boolean());
        let tag = json["comment_tag"].as_str().unwrap();
        assert_eq!(tag.len(), 20, "{tag}");
        assert!(tag.bytes().all(|byte| byte.is_ascii_hexdigit()), "{tag}");

        let response = config_handler(State(test_state("/nonexistent-dir-xyz/harness.db")))
            .await
            .into_response();
        let bytes = axum::body::to_bytes(response.into_body(), 1_000_000)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["history_recording"], false);
        assert!(
            json["history_error"]
                .as_str()
                .unwrap()
                .contains("open failed"),
            "{json}"
        );
    }

    #[tokio::test]
    async fn restored_response_uses_sanitized_markdown_rendering() {
        let content = "| Key | Value |\n| --- | --- |\n| answer | 53 |\n\n```mojo\nvar x = 53\n```\n\n$\\boxed{53}$\n<script>alert(1)</script>";
        let Json(result) = render_handler(Json(RenderRequest {
            content: content.into(),
        }))
        .await
        .unwrap();
        let html = result["html"].as_str().unwrap();
        assert!(html.contains("<table>"));
        assert!(html.contains("language-mojo"));
        assert!(html.contains("math-inline"));
        assert!(!html.contains("<script"));
        assert!(!html.contains("alert(1)"));
    }

    #[tokio::test]
    async fn stopping_an_unregistered_run_arms_a_bounded_flag() {
        let state = AppState {
            web_runner: "/bin/echo".into(),
            ollama: ollama_rs::Ollama::default(),
            semaphore: Arc::new(Semaphore::new(1)),
            enabled_tools: Arc::new(std::sync::RwLock::new(
                crate::tools::default_enabled().await,
            )),
            approve_calls: crate::config::empty_tool_set(),
            approve_outputs: crate::config::empty_tool_set(),
            pending: Arc::new(Mutex::new(HashMap::new())),
            run_counter: Arc::new(AtomicU64::new(1)),
            runs: Arc::new(Mutex::new(HashMap::new())),
            stop_flags: Arc::new(Mutex::new(HashMap::new())),
            stop_next: Arc::new(Mutex::new(None)),
            history: crate::history::HistoryDb::open(":memory:"),
            memory: crate::memory::MemoryDb::open(":memory:"),
            review_run_cmd: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tool_policy_path: None,
        };
        // A run id in the harness' own shape that has not registered
        // itself yet: the stop is armed.
        let response = stop_handler(
            State(state.clone()),
            Json(StopRequest {
                run_id: Some("run-9-1700000000000".into()),
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(state.stop_flags.lock().await.len(), 1);
        // An id that can never be a run id is refused, and nothing is
        // remembered.
        let response = stop_handler(
            State(state.clone()),
            Json(StopRequest {
                run_id: Some("garbage".into()),
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(state.stop_flags.lock().await.len(), 1);
        // A stop with no id also lands in the spawn→register window: it
        // arms the next-run slot instead of a 404 that loses the stop.
        let response = stop_handler(State(state.clone()), Json(StopRequest { run_id: None }))
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(state.stop_next.lock().await.is_some(), "next-run slot armed");
    }

    #[tokio::test]
    async fn answer_endpoint_keeps_invalid_requests_and_delivers_valid_answers_once() {
        let state = AppState {
            web_runner: "/bin/echo".into(),
            ollama: ollama_rs::Ollama::default(),
            semaphore: Arc::new(Semaphore::new(1)),
            enabled_tools: Arc::new(std::sync::RwLock::new(
                crate::tools::default_enabled().await,
            )),
            approve_calls: crate::config::empty_tool_set(),
            approve_outputs: crate::config::empty_tool_set(),
            pending: Arc::new(Mutex::new(HashMap::new())),
            run_counter: Arc::new(AtomicU64::new(1)),
            runs: Arc::new(Mutex::new(HashMap::new())),
            stop_flags: Arc::new(Mutex::new(HashMap::new())),
            stop_next: Arc::new(Mutex::new(None)),
            history: crate::history::HistoryDb::open(":memory:"),
            memory: crate::memory::MemoryDb::open(":memory:"),
            review_run_cmd: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tool_policy_path: None,
        };
        let interaction = UserInteraction::parse(&serde_json::json!({
            "kind": "question", "title": "Plan", "questions": [
                {"id": "plan", "question": "Which approach?", "options": [{"label": "Simple"}]}
            ]
        }))
        .unwrap();
        let (sender, receiver) = oneshot::channel();
        state.pending.lock().await.insert(
            "run:1:0".into(),
            PendingApproval::new(sender, Some(interaction), None),
        );
        let request = |action: &str, answers| ApproveRequest {
            approval_id: "run:1:0".into(),
            action: action.into(),
            text: None,
            answers,
            reasoning_effort: None,
            command_timeout: None,
            command: None,
            image_region: None,
            image_crop: None,
        };
        let response = approve_handler(State(state.clone()), approve_body(request("approve", None)))
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let response = approve_handler(State(state.clone()), approve_body(request("answer", Some(vec![]))))
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(state.pending.lock().await.contains_key("run:1:0"));
        let response = approve_handler(
            State(state.clone()),
            approve_body(request(
                "answer",
                Some(vec![UserAnswer {
                    id: "plan".into(),
                    choice: None,
                    text: "  raw\ntext  ".into(),
                }]),
            )),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        match receiver.await.unwrap() {
            ApprovalDecision::Answer(value) => {
                assert_eq!(value["answers"][0]["answer"], "  raw\ntext  ")
            }
            other => panic!("unexpected decision: {other:?}"),
        }
        let response = approve_handler(State(state.clone()), approve_body(request("answer", None)))
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        let (sender, _receiver) = oneshot::channel();
        state
            .pending
            .lock()
            .await
            .insert("run:1:0".into(), PendingApproval::new(sender, None, None));
        let response = approve_handler(State(state.clone()), approve_body(request("answer", None)))
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(state.pending.lock().await.contains_key("run:1:0"));
        let response = approve_handler(State(state), approve_body(request("approve", None)))
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn an_approve_parks_the_image_region_and_crop_flag_for_the_loop() {
        // A view_img selection rides slots, not the decision value: the
        // loop reads them after the decision, the way it reads effort.
        let state = AppState {
            web_runner: "/bin/echo".into(),
            ollama: ollama_rs::Ollama::default(),
            semaphore: Arc::new(Semaphore::new(1)),
            enabled_tools: Arc::new(std::sync::RwLock::new(
                crate::tools::default_enabled().await,
            )),
            approve_calls: crate::config::empty_tool_set(),
            approve_outputs: crate::config::empty_tool_set(),
            pending: Arc::new(Mutex::new(HashMap::new())),
            run_counter: Arc::new(AtomicU64::new(1)),
            runs: Arc::new(Mutex::new(HashMap::new())),
            stop_flags: Arc::new(Mutex::new(HashMap::new())),
            stop_next: Arc::new(Mutex::new(None)),
            history: crate::history::HistoryDb::open(":memory:"),
            memory: crate::memory::MemoryDb::open(":memory:"),
            review_run_cmd: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tool_policy_path: None,
        };
        let (sender, _receiver) = oneshot::channel();
        let pending = PendingApproval::new(sender, None, None);
        let region_slot = std::sync::Arc::clone(&pending.image_region);
        let crop_slot = std::sync::Arc::clone(&pending.image_crop);
        state
            .pending
            .lock()
            .await
            .insert("run:1:0".into(), pending);
        let response = approve_handler(
            State(state.clone()),
            approve_body(ApproveRequest {
                approval_id: "run:1:0".into(),
                action: "approve".into(),
                text: None,
                answers: None,
                reasoning_effort: None,
                command_timeout: None,
                command: None,
                image_region: Some(crate::tools::view_img::ImageRegion {
                    x: 0.25,
                    y: 0.25,
                    w: 0.5,
                    h: 0.5,
                }),
                image_crop: Some(true),
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let parked = region_slot
            .lock()
            .unwrap()
            .as_ref()
            .map(|region| (region.x, region.y, region.w, region.h));
        assert_eq!(parked, Some((0.25, 0.25, 0.5, 0.5)));
        assert!(*crop_slot.lock().unwrap(), "the crop flag rides the region");

        // A degenerate region parks nothing, and its crop flag is
        // irrelevant: the loop reads the region first.
        let (sender, _receiver) = oneshot::channel();
        let pending = PendingApproval::new(sender, None, None);
        let region_slot = std::sync::Arc::clone(&pending.image_region);
        let crop_slot = std::sync::Arc::clone(&pending.image_crop);
        state
            .pending
            .lock()
            .await
            .insert("run:2:0".into(), pending);
        let response = approve_handler(
            State(state.clone()),
            approve_body(ApproveRequest {
                approval_id: "run:2:0".into(),
                action: "approve".into(),
                text: None,
                answers: None,
                reasoning_effort: None,
                command_timeout: None,
                command: None,
                image_region: Some(crate::tools::view_img::ImageRegion {
                    x: 0.5,
                    y: 0.5,
                    w: 0.0,
                    h: 0.0,
                }),
                image_crop: Some(true),
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(region_slot.lock().unwrap().is_none(), "degenerate region dropped");
        assert!(!*crop_slot.lock().unwrap(), "no region means no crop flag");
    }
    #[tokio::test]
    async fn web_execute_then_reviewed_submission_flows_once() {
        let state = AppState {
            web_runner: "/bin/echo".into(),
            ollama: ollama_rs::Ollama::default(),
            semaphore: Arc::new(Semaphore::new(1)),
            enabled_tools: Arc::new(std::sync::RwLock::new(
                crate::tools::default_enabled().await,
            )),
            approve_calls: crate::config::empty_tool_set(),
            approve_outputs: crate::config::empty_tool_set(),
            pending: Arc::new(Mutex::new(HashMap::new())),
            run_counter: Arc::new(AtomicU64::new(1)),
            runs: Arc::new(Mutex::new(HashMap::new())),
            stop_flags: Arc::new(Mutex::new(HashMap::new())),
            stop_next: Arc::new(Mutex::new(None)),
            history: crate::history::HistoryDb::open(":memory:"),
            memory: crate::memory::MemoryDb::open(":memory:"),
            review_run_cmd: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tool_policy_path: None,
        };
        let (sender, receiver) = oneshot::channel();
        state.pending.lock().await.insert(
            "web:1:0".into(),
            PendingApproval::new(
                sender,
                None,
                Some(crate::config::ReviewRequest::Web(
                    crate::tools::web::WebRequest::parse(
                        "web_fetch",
                        &serde_json::json!({"url":"https://example.com"}),
                    )
                    .unwrap(),
                )),
            ),
        );
        let request = |action: &str, text: &str| ApproveRequest {
            approval_id: "web:1:0".into(),
            action: action.into(),
            text: Some(text.into()),
            answers: None,
            reasoning_effort: None,
            command_timeout: None,
            command: None,
            image_region: None,
            image_crop: None,
        };
        for (action, text) in [("web_result", " "), ("answer", ""), ("redirect", "")] {
            assert_eq!(
                approve_handler(State(state.clone()), approve_body(request(action, text)))
                    .await
                    .into_response()
                    .status(),
                StatusCode::BAD_REQUEST
            );
            assert!(state.pending.lock().await.contains_key("web:1:0"));
        }
        // The execute decision returns the request itself for the loop.
        {
            let response = approve_handler(State(state.clone()), approve_body(request("web_execute", "")))
                .await
                .into_response();
            assert_eq!(response.status(), StatusCode::OK);
            match receiver.await.unwrap() {
                ApprovalDecision::ReviewExecute(crate::config::ReviewRequest::Web(execute)) => {
                    assert_eq!(execute.kind, "fetch");
                    assert_eq!(execute.url.as_deref(), Some("https://example.com"));
                }
                other => panic!("unexpected {other:?}"),
            }
        }
        // Re-arm, this time with a preview — the review stage rejects another
        // execute decision and accepts only reviewed content.
        let (sender, receiver) = oneshot::channel();
        let mut reviewed = crate::tools::web::WebRequest::parse(
            "web_fetch",
            &serde_json::json!({"url":"https://example.com"}),
        )
        .unwrap();
        reviewed.preview = Some("page text".into());
        state.pending.lock().await.insert(
            "web:1:0".into(),
            PendingApproval::new(
                sender,
                None,
                Some(crate::config::ReviewRequest::Web(reviewed)),
            ),
        );
        let previewed = |action: &str| ApproveRequest {
            approval_id: "web:1:0".into(),
            action: action.into(),
            text: Some("fresh page text".into()),
            answers: None,
            reasoning_effort: None,
            command_timeout: None,
            command: None,
            image_region: None,
            image_crop: None,
        };
        assert_eq!(
            approve_handler(State(state.clone()), approve_body(previewed("web_execute")))
                .await
                .into_response()
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            approve_handler(State(state.clone()), approve_body(previewed("web_result")))
                .await
                .into_response()
                .status(),
            StatusCode::OK
        );
        match receiver.await.unwrap() {
            ApprovalDecision::WebResult(result) => {
                assert_eq!(result["content"], "fresh page text");
                assert_eq!(result["url"], "https://example.com");
            }
            other => panic!("unexpected {other:?}"),
        }
        // Valid submissions are once-only: the reviewed request was consumed.
        assert_eq!(
            approve_handler(State(state.clone()), approve_body(previewed("web_result")))
                .await
                .into_response()
                .status(),
            StatusCode::NOT_FOUND
        );
        assert!(state.pending.lock().await.is_empty());
    }

    async fn model_state() -> AppState {
        AppState {
            web_runner: "/bin/echo".into(),
            ollama: ollama_rs::Ollama::default(),
            semaphore: Arc::new(Semaphore::new(1)),
            enabled_tools: Arc::new(std::sync::RwLock::new(
                crate::tools::default_enabled().await,
            )),
            approve_calls: crate::config::empty_tool_set(),
            approve_outputs: crate::config::empty_tool_set(),
            pending: Arc::new(Mutex::new(HashMap::new())),
            run_counter: Arc::new(AtomicU64::new(1)),
            runs: Arc::new(Mutex::new(HashMap::new())),
            stop_flags: Arc::new(Mutex::new(HashMap::new())),
            stop_next: Arc::new(Mutex::new(None)),
            history: crate::history::HistoryDb::open(":memory:"),
            memory: crate::memory::MemoryDb::open(":memory:"),
            review_run_cmd: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tool_policy_path: None,
        }
    }

    #[tokio::test]
    async fn switching_to_a_known_model_swaps_it_for_the_session() {
        let state = model_state().await;
        let before = crate::config::current_model();
        // Unknown names are refused and the model is unchanged.
        let response = model_handler(
            State(state.clone()),
            Json(ModelRequest {
                model: "not-a-model:cloud".into(),
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(crate::config::current_model(), before);
        // A known model switches.
        let response = model_handler(
            State(state.clone()),
            Json(ModelRequest {
                model: "gemma4:31b-cloud".into(),
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(crate::config::current_model(), "gemma4:31b-cloud");
        // Reset so other tests observe the default.
        if let Ok(mut guard) = crate::config::CURRENT_MODEL.write() {
            *guard = before;
        }
    }

    #[tokio::test]
    async fn switching_is_refused_while_a_run_holds_the_permit() {
        let state = model_state().await;
        let before = crate::config::current_model();
        // Hold the single permit: simulating a run in flight.
        let _permit = state.semaphore.clone().acquire_owned().await.unwrap();
        let response = model_handler(
            State(state.clone()),
            Json(ModelRequest {
                model: "grok-4.6".into(),
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(crate::config::current_model(), before);
    }

    #[tokio::test]
    async fn reasoning_effort_switches_for_the_next_grok_run_and_refuses_while_busy() {
        let state = model_state().await;
        let before = crate::config::current_reasoning_effort();
        let response = reasoning_effort_handler(
            State(state.clone()),
            Json(ReasoningEffortRequest {
                effort: "turbo".into(),
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(crate::config::current_reasoning_effort(), before);
        let response = reasoning_effort_handler(
            State(state.clone()),
            Json(ReasoningEffortRequest {
                effort: "low".into(),
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(crate::config::current_reasoning_effort(), "low");
        let _permit = state.semaphore.clone().acquire_owned().await.unwrap();
        let response = reasoning_effort_handler(
            State(state.clone()),
            Json(ReasoningEffortRequest {
                effort: "high".into(),
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(crate::config::current_reasoning_effort(), "low");
        drop(_permit);
        if let Ok(mut guard) = crate::config::CURRENT_REASONING_EFFORT.write() {
            *guard = before;
        }
    }

    struct RestoreRole(crate::config::RoleSettings);
    impl Drop for RestoreRole {
        fn drop(&mut self) {
            let _ = crate::config::store_role_settings(self.0.clone());
        }
    }

    #[tokio::test]
    async fn the_role_and_workspace_sentence_update_until_a_run_is_busy() {
        let _lock = crate::config::ROLE_TEST_LOCK
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        let _restore = RestoreRole(crate::config::role_settings());
        let state = model_state().await;
        let _permit = state.semaphore.clone().acquire_owned().await.unwrap();
        let busy = role_handler(
            State(state.clone()),
            Json(RoleRequest {
                template: "should not land".into(),
                workspace_enabled: false,
                workspace_env: "/tmp/custom-harness-env".into(),
            }),
        )
        .await
        .into_response();
        assert_eq!(busy.status(), StatusCode::CONFLICT);
        drop(_permit);
        let broken = role_handler(
            State(state.clone()),
            Json(RoleRequest {
                template: "Role only.".into(),
                workspace_enabled: true,
                workspace_env: "bad\npath".into(),
            }),
        )
        .await
        .into_response();
        assert_eq!(broken.status(), StatusCode::BAD_REQUEST);
        let saved = role_handler(
            State(state.clone()),
            Json(RoleRequest {
                template: "Role only.".into(),
                workspace_enabled: false,
                workspace_env: "/tmp/custom-harness-env".into(),
            }),
        )
        .await
        .into_response();
        assert_eq!(saved.status(), StatusCode::OK);
        let off = crate::config::system_prompt_with_workspace();
        assert!(off.contains("Role only."));
        assert!(!off.contains("/tmp/custom-harness-env"), "{off}");
        let saved = role_handler(
            State(state),
            Json(RoleRequest {
                template: "Role only.".into(),
                workspace_enabled: true,
                workspace_env: "/tmp/custom-harness-env".into(),
            }),
        )
        .await
        .into_response();
        assert_eq!(saved.status(), StatusCode::OK);
        let on = crate::config::system_prompt_with_workspace();
        assert!(on.contains("/tmp/custom-harness-env"), "{on}");
        assert!(on.contains("Role only."));
    }

    #[tokio::test]
    async fn approval_keeps_a_chosen_grok_effort_and_rejects_an_unknown_level() {
        let state = model_state().await;
        let (sender, receiver) = oneshot::channel();
        let pending = PendingApproval::new(sender, None, None);
        let slot = std::sync::Arc::clone(&pending.reasoning_effort);
        state.pending.lock().await.insert("run:9:0".into(), pending);
        let request = |effort: Option<&str>| ApproveRequest {
            approval_id: "run:9:0".into(),
            action: "approve".into(),
            text: None,
            answers: None,
            reasoning_effort: effort.map(str::to_string),
            command_timeout: None,
            command: None,
            image_region: None,
            image_crop: None,
        };
        let response = approve_handler(State(state.clone()), approve_body(request(Some("turbo"))))
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(state.pending.lock().await.contains_key("run:9:0"));
        assert!(slot.lock().unwrap().is_none());
        let response = approve_handler(State(state.clone()), approve_body(request(Some(" low "))))
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(slot.lock().unwrap().as_deref(), Some("low"));
        assert!(matches!(
            receiver.await.unwrap(),
            ApprovalDecision::Approved {
                command_timeout: None,
                command: None,
                note: None,
            }
        ));
    }

    #[tokio::test]
    async fn approval_command_timeout_overrides_this_command_and_rejects_unknown_limits() {
        let state = model_state().await;
        let (sender, receiver) = oneshot::channel();
        state
            .pending
            .lock()
            .await
            .insert("run:9:1".into(), PendingApproval::new(sender, None, None));
        let request = |limit: Option<&str>| ApproveRequest {
            approval_id: "run:9:1".into(),
            action: "approve".into(),
            text: None,
            answers: None,
            reasoning_effort: None,
            command_timeout: limit.map(str::to_string),
            command: None,
            image_region: None,
            image_crop: None,
        };
        for bad in ["turbo", "default", "20M"] {
            let response = approve_handler(State(state.clone()), approve_body(request(Some(bad))))
                .await
                .into_response();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{bad}");
            assert!(state.pending.lock().await.contains_key("run:9:1"));
        }
        let response = approve_handler(State(state.clone()), approve_body(request(Some(" none "))))
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        match receiver.await.unwrap() {
            ApprovalDecision::Approved {
                command_timeout,
                command,
                note,
            } => {
                assert_eq!(command_timeout.as_deref(), Some("none"));
                assert!(command.is_none());
                assert!(note.is_none());
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn approval_accepts_an_alternate_command_and_rejects_a_blank_one() {
        let state = model_state().await;
        let (sender, receiver) = oneshot::channel();
        state
            .pending
            .lock()
            .await
            .insert("run:9:2".into(), PendingApproval::new(sender, None, None));
        let request = |command: &str, note: &str| ApproveRequest {
            approval_id: "run:9:2".into(),
            action: "approve".into(),
            text: Some(note.into()),
            answers: None,
            reasoning_effort: None,
            command_timeout: Some("none".into()),
            command: Some(command.into()),
            image_region: None,
            image_crop: None,
        };
        let response = approve_handler(State(state.clone()), approve_body(request("  ", "because")))
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(state.pending.lock().await.contains_key("run:9:2"));
        let response = approve_handler(
            State(state.clone()),
            approve_body(request(" printf person-ok ", " narrower check ")),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        match receiver.await.unwrap() {
            ApprovalDecision::Approved {
                command_timeout,
                command,
                note,
            } => {
                assert_eq!(command_timeout.as_deref(), Some("none"));
                assert_eq!(command.as_deref(), Some("printf person-ok"));
                assert_eq!(note.as_deref(), Some("narrower check"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn tool_toggles_are_refused_while_a_run_holds_the_permit() {
        let state = model_state().await;
        let before = crate::tools::enabled_tool_names(&state).await;
        let _permit = state.semaphore.clone().acquire_owned().await.unwrap();
        let response = tools_handler(
            State(state.clone()),
            Json(ToolsRequest {
                enabled: vec!["run_cmd".into()],
                approve_calls: None,
                approve_outputs: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(crate::tools::enabled_tool_names(&state).await, before);
    }

    #[tokio::test]
    async fn run_cmd_review_toggle_stores_the_flag_and_refuses_during_a_run() {
        let state = model_state().await;
        assert!(!state.review_run_cmd.load(Ordering::Relaxed));
        let response = run_cmd_review_handler(
            State(state.clone()),
            Json(RunCmdReviewRequest { enabled: true }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(state.review_run_cmd.load(Ordering::Relaxed));

        let _permit = state.semaphore.clone().acquire_owned().await.unwrap();
        let response = run_cmd_review_handler(
            State(state.clone()),
            Json(RunCmdReviewRequest { enabled: false }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        // The in-flight run keeps the value it will have snapshotted.
        assert!(state.review_run_cmd.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn command_review_accepts_text_and_rejects_another_execute() {
        let state = model_state().await;
        let (sender, receiver) = oneshot::channel();
        state.pending.lock().await.insert(
            "cmd:1:0".into(),
            PendingApproval::new(
                sender,
                None,
                Some(crate::config::ReviewRequest::Cmd(
                    crate::config::CmdReview {
                        kind: "cmd".into(),
                        command: "printf harness-ok".into(),
                        preview: "stdout:\nharness-ok\n".into(),
                    },
                )),
            ),
        );
        let request = |id: &str, action: &str, text: &str| ApproveRequest {
            approval_id: id.into(),
            action: action.into(),
            text: Some(text.into()),
            answers: None,
            reasoning_effort: None,
            command_timeout: None,
            command: None,
            image_region: None,
            image_crop: None,
        };
        for action in ["web_result", "approve", "web_execute"] {
            assert_eq!(
                approve_handler(State(state.clone()), approve_body(request("cmd:1:0", action, "  ")))
                    .await
                    .into_response()
                    .status(),
                StatusCode::BAD_REQUEST,
                "{action}"
            );
            assert!(state.pending.lock().await.contains_key("cmd:1:0"));
        }
        assert_eq!(
            approve_handler(
                State(state.clone()),
                approve_body(request("cmd:1:0", "web_result", "kept line"))
            )
            .await
            .into_response()
            .status(),
            StatusCode::OK
        );
        match receiver.await.unwrap() {
            ApprovalDecision::WebResult(value) => assert_eq!(value, "kept line"),
            other => panic!("unexpected {other:?}"),
        }

        let (sender, receiver) = oneshot::channel();
        state.pending.lock().await.insert(
            "cmd:1:1".into(),
            PendingApproval::new(
                sender,
                None,
                Some(crate::config::ReviewRequest::Cmd(
                    crate::config::CmdReview {
                        kind: "cmd".into(),
                        command: "printf harness-ok".into(),
                        preview: "stdout:\nharness-ok\n".into(),
                    },
                )),
            ),
        );
        assert_eq!(
            approve_handler(
                State(state.clone()),
                approve_body(request("cmd:1:1", "redirect", "use the file tool"))
            )
            .await
            .into_response()
            .status(),
            StatusCode::OK
        );
        match receiver.await.unwrap() {
            ApprovalDecision::Redirect(text) => assert_eq!(text, "use the file tool"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn tools_endpoint_filters_the_run_registry() {
        let state = model_state().await;
        let all = crate::tools::all_tools().await;
        assert!(all.len() >= 5, "builtin registry at least 5: {all:?}");
        let all_names: Vec<String> = all
            .iter()
            .map(|t| {
                serde_json::to_value(t).unwrap()["function"]["name"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .filter(|name| name != crate::tools::project_mem::TOOL_NAME)
            .collect();
        // Toggling everything off, then adding one tool back.
        let response = tools_handler(
            State(state.clone()),
            Json(ToolsRequest {
                enabled: vec![],
                approve_calls: None,
                approve_outputs: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(crate::tools::current_tools(&state).await.is_empty());
        let response = tools_handler(
            State(state.clone()),
            Json(ToolsRequest {
                enabled: vec!["run_cmd".into()],
                approve_calls: None,
                approve_outputs: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let now: Vec<String> = crate::tools::current_tools(&state)
            .await
            .into_iter()
            .map(|t| {
                serde_json::to_value(&t).unwrap()["function"]["name"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(now, vec!["run_cmd".to_string()]);
        // Unknown names are refused wholesale.
        let response = tools_handler(
            State(state.clone()),
            Json(ToolsRequest {
                enabled: vec!["not_a_tool".into()],
                approve_calls: None,
                approve_outputs: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        // Still only run_cmd — refusal set nothing.
        assert_eq!(
            crate::tools::enabled_tool_names(&state).await,
            vec!["run_cmd".to_string()]
        );
        // Reset to everything on.
        let response = tools_handler(
            State(state.clone()),
            Json(ToolsRequest {
                enabled: all_names.clone(),
                approve_calls: None,
                approve_outputs: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        // The disabled end of all_tools is gone.
        let after: Vec<String> = crate::tools::current_tools(&state)
            .await
            .into_iter()
            .map(|t| {
                serde_json::to_value(&t).unwrap()["function"]["name"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(after, all_names);
    }

    async fn body_json(response: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn history_list_honors_limit_and_defaults_to_unbounded() {
        let state = test_state(":memory:");
        for i in 0..3 {
            let id = format!("run-{i}");
            state
                .history
                .create_run(&id, "title", "model", "prompt", &[], &[], "tag")
                .await;
            state.history.finish_run(&id, "done", 1, 1, 10).await;
        }
        // Default: every run, newest first.
        let response = history_list_handler(
            State(state.clone()),
            axum::extract::Query(HistoryListQuery { limit: None }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        let all = body.as_array().expect("list body");
        assert_eq!(all.len(), 3);
        // A cap returns the same head as the full list.
        let response = history_list_handler(
            State(state.clone()),
            axum::extract::Query(HistoryListQuery { limit: Some("1".into()) }),
        )
        .await
        .into_response();
        let capped = body_json(response).await;
        let capped = capped.as_array().expect("capped body");
        assert_eq!(capped.len(), 1);
        assert_eq!(capped[0]["id"], all[0]["id"]);
        // A non-integer limit is refused and names the caller's value.
        let response = history_list_handler(
            State(state.clone()),
            axum::extract::Query(HistoryListQuery { limit: Some("abc".into()) }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(text.contains("abc"), "{text}");
    }

    #[tokio::test]
    async fn history_page_defaults_to_twenty_and_validates_the_window() {
        let state = test_state(":memory:");
        for i in 0..25 {
            state
                .history
                .create_run(&format!("run-{i:02}"), "title", "model", "prompt", &[], &[], "tag")
                .await;
        }
        let response = history_page_handler(
            State(state.clone()),
            axum::extract::Query(HistoryPageQuery {
                limit: None,
                offset: None,
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        assert_eq!(body["total"], 25);
        assert_eq!(body["limit"], 20);
        assert_eq!(body["offset"], 0);
        assert_eq!(body["runs"].as_array().unwrap().len(), 20);

        let response = history_page_handler(
            State(state.clone()),
            axum::extract::Query(HistoryPageQuery {
                limit: Some("20".into()),
                offset: Some("20".into()),
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        assert_eq!(body["total"], 25);
        assert_eq!(body["offset"], 20);
        assert_eq!(body["runs"].as_array().unwrap().len(), 5);

        for query in [
            HistoryPageQuery {
                limit: Some("abc".into()),
                offset: None,
            },
            HistoryPageQuery {
                limit: None,
                offset: Some("-1".into()),
            },
            HistoryPageQuery {
                limit: Some("9223372036854775808".into()),
                offset: None,
            },
        ] {
            let response = history_page_handler(State(state.clone()), axum::extract::Query(query))
                .await
                .into_response();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
    }

    // Manual testing is for the reviewable tools only. Assert behavior
    // and data, never display wording.
    #[tokio::test]
    async fn manual_testing_refuses_tools_outside_the_allowlist() {
        let state = test_state(":memory:");
        let response = test_tool_handler(
            State(state.clone()),
            Json(TestToolRequest {
                tool: "run_cmd".into(),
                arguments: serde_json::json!({"command": "rm -rf /"}),
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = body_json(response).await;
        // The refusal names the caller's tool: no shell tool is ever
        // runnable from the Test tab.
        assert!(
            body["error"].as_str().unwrap_or("").contains("run_cmd"),
            "{body}"
        );
        assert_eq!(body["preview"], "");
    }

    #[tokio::test]
    async fn manual_testing_reports_argument_errors_without_running() {
        let state = test_state(":memory:");
        let response = test_tool_handler(
            State(state.clone()),
            Json(TestToolRequest {
                tool: "web_fetch".into(),
                arguments: serde_json::json!({}),
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = body_json(response).await;
        assert!(body["error"].as_str().unwrap_or("").len() > 0, "{body}");
        assert_eq!(body["preview"], "");
    }

    #[tokio::test]
    async fn manual_testing_runs_the_tool_and_returns_preview_and_raw() {
        let state = test_state(":memory:");
        let response = test_tool_handler(
            State(state.clone()),
            Json(TestToolRequest {
                tool: "web_search".into(),
                arguments: serde_json::json!({"query": "probe query", "max_results": 2}),
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        assert!(body["error"].is_null(), "{body}");
        // The preview carries the run's own data: the query the caller
        // sent appears in the capture.
        assert!(
            body["preview"].as_str().unwrap_or("").contains("probe query"),
            "{body}"
        );
        // The raw window is the machine-shaped capture, parseable as JSON.
        let raw = body["raw"].as_str().expect("raw capture");
        let raw: serde_json::Value = serde_json::from_str(raw).unwrap();
        assert!(
            raw["stdout"].as_str().unwrap_or("").contains("probe query"),
            "{raw}"
        );
    }

    fn test_temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tt-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn manual_testing_runs_write_file_and_writes_exactly_what_was_sent() {
        let state = test_state(":memory:");
        let dir = test_temp_dir("write");
        let path = dir.join("probe.txt");
        let response = test_tool_handler(
            State(state.clone()),
            Json(TestToolRequest {
                tool: "write_file".into(),
                arguments: serde_json::json!({
                    "path": path.to_str().unwrap(),
                    "mode": "write",
                    "content": "first line\nsecond line\n"
                }),
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_json(response).await;
        assert!(body["error"].is_null(), "{body}");
        // Data, not wording: the preview names the file that was written.
        assert!(
            body["preview"].as_str().unwrap_or("").contains("probe.txt"),
            "{body}"
        );
        // The write landed, byte for byte.
        assert_eq!(std::fs::read(&path).unwrap(), b"first line\nsecond line\n");
        // The raw window is machine-shaped JSON carrying the outcome.
        let raw = body["raw"].as_str().expect("raw capture");
        let raw: serde_json::Value = serde_json::from_str(raw).unwrap();
        assert_eq!(raw["ok"], true, "{raw}");
        assert_eq!(raw["path"], path.to_str().unwrap());
        assert_eq!(raw["mode"], "write");
        assert_eq!(raw["after_lines"], 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn manual_testing_reports_write_file_errors_without_writing() {
        let state = test_state(":memory:");
        let dir = test_temp_dir("edit-err");
        let missing = dir.join("missing.txt");
        let response = test_tool_handler(
            State(state.clone()),
            Json(TestToolRequest {
                tool: "write_file".into(),
                arguments: serde_json::json!({
                    "path": missing.to_str().unwrap(),
                    "mode": "edit",
                    "edits": [{"search": "a", "replace": "b"}]
                }),
            }),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = body_json(response).await;
        assert!(body["error"].as_str().unwrap_or("").len() > 0, "{body}");
        assert_eq!(body["preview"], "");
        // Nothing was written.
        assert!(!missing.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod workspace_tests {
    use super::*;

    fn temp_tree(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "harness-workspace-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(path: &std::path::Path, text: &str) {
        std::fs::write(path, text).unwrap();
    }

    fn names(entries: &[WorkspaceEntry]) -> Vec<String> {
        entries.iter().map(|entry| entry.name.clone()).collect()
    }

    #[test]
    fn root_files_list_first_and_deeper_levels_keep_directories_first() {
        let root = temp_tree("order");
        touch(&root.join("zebra.txt"), "z");
        touch(&root.join(".hidden"), "h");
        touch(&root.join("apple.md"), "a");
        std::fs::create_dir_all(root.join("zdir/nested")).unwrap();
        touch(&root.join("zdir/inside.txt"), "i");
        touch(&root.join("zdir/nested/deep.txt"), "d");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let mut budget = WORKSPACE_MAX_ENTRIES;
        let (entries, truncated) = walk_workspace(&root, 1, &mut budget);
        assert!(!truncated);
        // The root lists its own files first — the downloads a person
        // drops land there and surface immediately — then the directories.
        assert_eq!(names(&entries), vec!["apple.md", "zebra.txt", "zdir"]);
        assert!(!entries[0].dir);
        assert!(entries[2].dir);
        // Deeper levels keep the classic order: directories first, then
        // files, so a folder's fan-out reads as a tree.
        let zdir = &entries[2];
        assert_eq!(names(&zdir.children), vec!["nested", "inside.txt"]);
        let nested = &zdir.children[0];
        assert_eq!(names(&nested.children), vec!["deep.txt"]);
        // Dot entries never appear at any level.
        assert!(!names(&entries).contains(&".hidden".to_string()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn nests_children_and_stops_at_the_depth_cap() {
        let root = temp_tree("depth");
        // a/b/c/deep.txt is four components: a and b are expanded, the
        // third level is listed as names but not descended into.
        std::fs::create_dir_all(root.join("a/b/c")).unwrap();
        touch(&root.join("a/b/c/deep.txt"), "deep");
        touch(&root.join("a/one.rs"), "1");
        let mut budget = WORKSPACE_MAX_ENTRIES;
        let (entries, _) = walk_workspace(&root, 1, &mut budget);
        assert_eq!(names(&entries), vec!["a"]);
        let a = &entries[0].children[0];
        let b = &a.children[0];
        assert_eq!((a.name.as_str(), a.dir), ("b", true));
        assert_eq!(b.name, "c");
        assert!(b.dir);
        // The depth cap stopped the descent: c has no children listed.
        assert!(b.children.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_shared_budget_truncates_the_listing() {
        let root = temp_tree("budget");
        for index in 0..6 {
            touch(&root.join(format!("f{index:02}.txt")), "x");
        }
        let mut budget = 3usize;
        let (entries, truncated) = walk_workspace(&root, 1, &mut budget);
        assert!(truncated, "the walk stopped at the budget");
        assert_eq!(entries.len(), 3, "{:?}", names(&entries));
        assert_eq!(*&budget, 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_directory_is_not_descended_so_the_walk_cannot_cycle() {
        let root = temp_tree("cycle");
        std::fs::create_dir_all(root.join("real")).unwrap();
        touch(&root.join("real/inside.txt"), "x");
        std::os::unix::fs::symlink(&root, root.join("loop")).unwrap();
        let mut budget = WORKSPACE_MAX_ENTRIES;
        let (entries, truncated) = walk_workspace(&root, 1, &mut budget);
        assert!(!truncated);
        let listed = names(&entries);
        // The link is present exactly once and treated as a file: its
        // target's contents are not walked a second time.
        assert_eq!(listed.iter().filter(|name| *name == "loop").count(), 1);
        assert!(
            entries
                .iter()
                .find(|entry| entry.name == "loop")
                .map(|entry| entry.dir)
                == Some(false),
            "the link is listed as a file, not descended"
        );
        let real = entries.iter().find(|entry| entry.name == "real").unwrap();
        assert_eq!(names(&real.children), vec!["inside.txt".to_string()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_unreadable_level_is_empty_rather_than_an_error() {
        let root = temp_tree("missing");
        let (entries, truncated) = walk_workspace(&root.join("nope"), 1, &mut 100usize);
        assert!(entries.is_empty());
        assert!(!truncated);
        let _ = std::fs::remove_dir_all(&root);
    }
}
