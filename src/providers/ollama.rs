//! The Ollama provider: the spec (the published `:cloud` catalog) plus
//! the transport. Ollama is the harness's original path — a local daemon
//! (or the same API hosting the cloud catalog) reached through the
//! `ollama-rs` types. The wire functions here post `/api/chat` directly:
//! ollama-rs's HTTP client is crate-private and its `ChatMessage` has no
//! `tool_name` field, so the request body is assembled in `stream.rs`
//! (with `tool_name` stamped on tool results) and handed to these
//! transport calls. Errors carry the raw response body so the
//! "does not support thinking" retry in the loop can string-match it.

use super::{ProviderSpec, Transport};

use ollama_rs::Ollama;
use ollama_rs::generation::chat::ChatMessageResponse;

/// Ollama cloud models. Each one sends prompts and tool outputs off
/// this machine. Ollama offers them on a Pro plan or a pre-paid
/// balance, so the selector lists them as one OLLAMA group. Local chat
/// models are not in this list: those come from the user's Ollama
/// installation at serve time.
pub(crate) const MODELS: &[&str] = &[
    "gemma4:31b-cloud",
    "nemotron-3-super:cloud",
    "nemotron-3-ultra:cloud",
    "gpt-oss:20b-cloud",
    "gpt-oss:120b-cloud",
    "beam:cloud",
    "inkling-2-small:cloud",
    "muse-spark-open:cloud",
    "hy4:cloud",
    "deepseek-v4.1-flash:cloud",
    "deepseek-v4-pro:cloud",
    "glm-5.3-flash:cloud",
    "glm-5.3:cloud",
    "mistral-large-4:cloud",
    "minimax-m3:cloud",
    "minimax-m3.1-flash:cloud",
    "mimo-v2.6-flash:cloud",
    "mimo-v2.6-pro:cloud",
];

/// Ollama cloud decision models. These answer only the `/v1/systemone`
/// endpoint (bool/score/choice decisions), not `/api/chat`, so they stay
/// out of the chat selector and appear only in the decision tab. Local
/// decision models are discovered at serve time from `/api/tags` (the
/// `decision` capability), like local chat models.
pub(crate) const DECISION_MODELS: &[&str] = &[
    "clef:27b-cloud",
];

pub(crate) const SPEC: ProviderSpec = ProviderSpec {
    id: "Ollama",
    display: "Ollama",
    // "OLLAMA" is the cloud-catalog group. The LOCAL group is built
    // from installed models at serve time and does not need a spec.
    group_name: "OLLAMA",
    host: "http://127.0.0.1:11434",
    chat_url: None,
    models: MODELS,
    key_env: None,
    // Per-model, not per-provider: a catalog tag or any installed tag
    // ending in `:cloud` is a cloud model; a local tag is not.
    // `config::is_cloud_model` applies that rule over this spec.
    cloud: false,
    supports_reasoning_effort: false,
    replays_reasoning: false,
    // Per-model, not per-provider: a multimodal Ollama model advertises
    // `vision` in its capabilities. `model_accepts_images` reads that;
    // the provider-level default is true for daemons that do not report
    // capabilities.
    supports_images: true,
    // Per-model, not per-provider: the live window is each model's
    // `num_ctx` from /api/show, read by config::provider_context_window.
    context_window: None,
    // Daemon-relative: a signed-in Ollama daemon answers with the live
    // cloud catalog at this path (the same list the official app uses).
    // A daemon that does not serve it — older build, or not signed in —
    // leaves the static table above in place.
    models_endpoint: Some("/api/v1/models/cloud"),
    transport: Transport::Ollama,
    // The daemon caches an unchanged message prefix. There is no
    // conversation header. `keep_alive` on the chat body keeps the
    // model loaded across an approval pause.
    cache_conversation_header: None,
    request_headers: &[],
};

fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::LazyLock<reqwest::Client> =
        std::sync::LazyLock::new(reqwest::Client::new);
    &CLIENT
}

/// POST `/api/chat` and parse one JSON response. The error string is the
/// response body when Ollama rejects the call, so a "does not support
/// thinking" rejection still reaches the retry above this helper.
pub(crate) async fn send_chat(
    ollama: &Ollama,
    body: &serde_json::Value,
) -> Result<ChatMessageResponse, String> {
    let url = format!("{}api/chat", ollama.url_str());
    let response = http_client()
        .post(url)
        .json(body)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(response.text().await.unwrap_or_default());
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

/// POST `/v1/systemone` and parse one JSON response. Decision models
/// answer this endpoint only — a chat model refuses it. The error string
/// is the response body when the daemon rejects the call.
pub(crate) async fn send_systemone(
    ollama: &Ollama,
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let url = format!("{}v1/systemone", ollama.url_str());
    let response = http_client()
        .post(url)
        .json(body)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(response.text().await.unwrap_or_default());
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

/// POST `/api/chat` with streaming and yield one parsed line at a time.
pub(crate) async fn send_chat_stream(
    ollama: &Ollama,
    body: &serde_json::Value,
) -> Result<tokio_stream::wrappers::ReceiverStream<Result<ChatMessageResponse, ()>>, String> {
    let url = format!("{}api/chat", ollama.url_str());
    let response = http_client()
        .post(url)
        .json(body)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(response.text().await.unwrap_or_default());
    }
    let (tx, rx) = tokio::sync::mpsc::channel(32);
    tokio::spawn(read_chat_stream(response, tx));
    Ok(tokio_stream::wrappers::ReceiverStream::new(rx))
}

/// Read an Ollama chat stream the same way ollama-rs does: NDJSON lines,
/// a trailing partial line, and a hard error only when the body itself fails.
async fn read_chat_stream(
    response: reqwest::Response,
    tx: tokio::sync::mpsc::Sender<Result<ChatMessageResponse, ()>>,
) {
    use tokio_stream::StreamExt as _;
    let mut buffer = String::new();
    // Raw bytes waiting for a split multibyte character to complete, so
    // a chunk boundary never costs the finished lines around it.
    let mut pending: Vec<u8> = Vec::new();
    let mut bytes = response.bytes_stream();
    while let Some(chunk) = bytes.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => {
                eprintln!("Failed to read response: {error}");
                let _ = tx.send(Err(())).await;
                return;
            }
        };
        pending.extend_from_slice(&chunk);
        while let Some(text) = super::take_decodable(&mut pending) {
            buffer.push_str(&text);
            let mut start = 0;
            while let Some(pos) = buffer[start..].find('\n') {
                let end = start + pos;
                let line = buffer[start..end].trim();
                if !line.is_empty() {
                    match serde_json::from_str::<ChatMessageResponse>(line) {
                        Ok(parsed) => {
                            if tx.send(Ok(parsed)).await.is_err() {
                                return;
                            }
                        }
                        Err(error) => eprintln!("Failed to deserialize response: {error}"),
                    }
                }
                start = end + 1;
            }
            if start > 0 {
                buffer = buffer[start..].to_string();
            }
        }
    }
    let trailing = buffer.trim();
    if !trailing.is_empty()
        && let Ok(parsed) = serde_json::from_str::<ChatMessageResponse>(trailing)
    {
        let _ = tx.send(Ok(parsed)).await;
    }
}

/// Reqwest's connect failure, without a later model error mixed in.
/// Returns the server address from the chat URL.
fn ollama_connect_host(detail: &str) -> Option<&str> {
    let rest = detail
        .trim()
        .strip_prefix("error sending request for url (")?;
    let (url, _) = rest.split_once(')')?;
    let host = url
        .trim()
        .trim_end_matches("/api/chat")
        .trim_end_matches('/');
    if host.is_empty() { None } else { Some(host) }
}

/// The sentence shown when both the stream and the fallback fail to reach Ollama.
pub(crate) fn ollama_down_message(detail: &str) -> Option<String> {
    let host = if let Some(inner) = detail.strip_prefix("Ollama request failed (stream: ") {
        let (stream, fallback) = inner.rsplit_once("; fallback: ")?;
        let fallback = fallback.strip_suffix(')')?.trim();
        let host = ollama_connect_host(stream.trim())?;
        ollama_connect_host(fallback)?;
        host
    } else if let Some(inner) = detail.strip_prefix("Ollama request failed: ") {
        ollama_connect_host(inner.trim())?
    } else {
        ollama_connect_host(detail)?
    };
    Some(format!(
        "Ollama is not reachable at {host}. Start the server and generate again."
    ))
}
