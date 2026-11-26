//! The shared OpenAI-style Chat Completions client. One transport serves
//! every provider whose `Transport` is `ChatCompletions`: xAI (Grok),
//! Reflection, and OpenCode Console. The next compatible provider is a
//! spec entry, not a new client.
//!
//! The tool loop stays in [`crate::stream`]. This module translates one
//! round into a streaming `POST {spec.chat_url}/…` and turns the SSE
//! stream back into text deltas, a readable reasoning trace, and
//! assembled tool calls. Per-provider behavior comes from the spec:
//! the endpoint, the key variable, the error labels, whether
//! `reasoning_effort` is sent, and whether the reasoning trace must be
//! replayed on earlier assistant messages (Reflection requires it —
//! verified live 2026-11-17; xAI does not want it). Server-side search
//! stays off for every Chat Completions provider: the request carries no
//! search field, and retrieval goes through the harness tools, which wait
//! for approval.
//!
//! Reasoning tokens are billed separately from visible completion
//! tokens: a usage object can report `completion_tokens: 9` and
//! `reasoning_tokens: 94` with `total_tokens` equal to prompt +
//! completion + reasoning.

use std::{
    collections::BTreeMap,
    pin::Pin,
    task::{Context, Poll},
    time::{Duration, Instant},
};

use ollama_rs::generation::tools::ToolInfo;
use serde_json::{Value, json};
use tokio_stream::Stream;

use super::ProviderSpec;

/// USD ticks per dollar, as documented on the chat-completions usage
/// object.
const TICKS_PER_USD: f64 = 10_000_000_000.0;

/// The key this run's provider needs, or the one-line reason it cannot
/// run. Read once and cached; the message names the spec's variable so
/// the operator knows exactly what to add to harness-keys.
pub(crate) fn require_key(spec: &ProviderSpec) -> Result<String, String> {
    cached_api_key(spec).ok_or_else(|| {
        format!(
            "This {} model needs an API key. Add {} to the harness-keys file, or export it and restart.",
            spec.display,
            spec.key_env.unwrap_or_default()
        )
    })
}

/// Read the API key once, then drop the spec's key variable from the
/// process environment so a later shell command cannot inherit it. A
/// key loaded from the encrypted harness-keys file wins. The page
/// never receives it.
fn cached_api_key(spec: &ProviderSpec) -> Option<String> {
    static KEYS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<&'static str, Option<String>>>,
    > = std::sync::OnceLock::new();
    let key_env = spec.key_env.unwrap_or_default();
    let keys = KEYS.get_or_init(Default::default);
    if let Ok(map) = keys.lock()
        && let Some(cached) = map.get(key_env)
    {
        return cached.clone();
    }
    let found = if let Some(installed) = crate::keys::installed_provider_key(key_env) {
        // SAFETY: one variable, removed once, before any tool is spawned.
        unsafe { std::env::remove_var(key_env) };
        installed.filter(|value| !value.is_empty())
    } else {
        let found = std::env::var(key_env)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        // SAFETY: removing one variable the process itself just read.
        // No other thread is spawning work during this first read.
        unsafe { std::env::remove_var(key_env) };
        found
    };
    if let Ok(mut map) = keys.lock() {
        map.insert(key_env, found.clone());
    }
    found
}

pub(crate) fn ticks_to_usd(ticks: u64) -> f64 {
    ticks as f64 / TICKS_PER_USD
}

/// Stable conversation id sent under the provider's cache/session header.
pub(crate) fn conversation_header_value(spec: &ProviderSpec, id: &str) -> Option<String> {
    let id = id.trim();
    if id.is_empty() || spec.cache_conversation_header.is_none() {
        return None;
    }
    Some(format!("{}{}", spec.conversation_id_prefix.unwrap_or(""), id))
}

/// The reasoning field an outbound assistant message carries, per spec:
/// Reflection requires the trace replayed (verified: a multi-round
/// request without it is rejected with HTTP 400
/// `missing_required_parameter`), xAI does not want it.
pub(crate) fn replay_field(spec: &ProviderSpec, thinking: Option<&String>) -> Option<String> {
    if spec.replays_reasoning {
        thinking.cloned()
    } else {
        None
    }
}

/// One image attached to a message, in the OpenAI-compatible shape
/// (`image_url` with a base64 data URL).
pub(crate) struct OutboundImage {
    pub media_type: String,
    pub base64: String,
}

/// One message in the Chat Completions body.
pub(crate) struct OutboundMessage {
    pub role: String,
    pub content: String,
    pub tool_calls: Vec<OutboundToolCall>,
    pub tool_call_id: Option<String>,
    /// The replayed reasoning trace. Providers that do not want it
    /// leave this `None` ([`replay_field`]); the serializer always
    /// writes a present, non-empty trace.
    pub reasoning_content: Option<String>,
    /// Images attached to this message (from `view_img`). Empty for every
    /// ordinary message.
    pub images: Vec<OutboundImage>,
}

pub(crate) struct OutboundToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

pub(crate) fn request_body(
    spec: &ProviderSpec,
    model: &str,
    messages: &[OutboundMessage],
    tools: &[ToolInfo],
    effort: &str,
) -> Value {
    let messages: Vec<Value> = messages.iter().map(message_json).collect();
    let mut body = json!({
        "model": super::upstream_model_name(spec, model),
        "messages": messages,
        "stream": true,
        "stream_options": { "include_usage": true },
    });
    if spec.supports_reasoning_effort {
        body["reasoning_effort"] = Value::String(effort.to_string());
    }
    if !tools.is_empty()
        && let Ok(encoded) = serde_json::to_value(tools)
    {
        body["tools"] = encoded;
    }
    body
}

fn message_json(message: &OutboundMessage) -> Value {
    let mut slot = json!({ "role": message.role });
    if !message.images.is_empty() {
        // A multimodal message: content is an array of text + image parts.
        let mut parts = Vec::new();
        if !message.content.is_empty() {
            parts.push(json!({ "type": "text", "text": message.content }));
        }
        for image in &message.images {
            parts.push(json!({ "type": "image_url", "image_url": { "url": format!("data:{};base64,{}", image.media_type, image.base64) } }));
        }
        slot["content"] = Value::Array(parts);
    } else if message.content.is_empty() && !message.tool_calls.is_empty() {
        slot["content"] = Value::Null;
    } else {
        slot["content"] = Value::String(message.content.clone());
    }
    if let Some(reasoning) = &message.reasoning_content
        && !reasoning.is_empty()
    {
        slot["reasoning_content"] = Value::String(reasoning.clone());
    }
    if !message.tool_calls.is_empty() {
        slot["tool_calls"] = Value::Array(
            message
                .tool_calls
                .iter()
                .map(|call| {
                    json!({
                        "id": call.id,
                        "type": "function",
                        "function": {
                            "name": call.name,
                            "arguments": arguments_string(&call.arguments),
                        }
                    })
                })
                .collect(),
        );
    }
    if message.role == "tool"
        && let Some(id) = message.tool_call_id.as_ref().filter(|id| !id.is_empty())
    {
        slot["tool_call_id"] = Value::String(id.clone());
    }
    slot
}

fn arguments_string(arguments: &Value) -> String {
    match arguments {
        Value::String(text) => text.clone(),
        other => serde_json::to_string(other).unwrap_or_else(|_| "{}".to_string()),
    }
}

#[derive(Default)]
pub(crate) struct Accum {
    model: String,
    tools: BTreeMap<u32, PartialTool>,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub reasoning_tokens: u64,
    pub cached_tokens: u64,
    pub cost_usd_ticks: Option<u64>,
    /// The provider's `finish_reason` for the turn, when it sends one.
    /// `"length"` means the reply was cut off at the context or output
    /// limit — the harness surfaces that instead of showing a silently
    /// truncated answer.
    pub finish_reason: Option<String>,
}

struct PartialTool {
    id: String,
    name: String,
    arguments: String,
}

pub(crate) struct FinishedCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

pub(crate) struct Finish {
    pub model: String,
    pub calls: Vec<FinishedCall>,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub reasoning_tokens: u64,
    pub cached_tokens: u64,
    pub cost_usd_ticks: Option<u64>,
    pub finish_reason: Option<String>,
}

pub(crate) enum LiveDelta {
    Content(String),
    Reasoning(String),
}

pub(crate) struct SseStep {
    pub deltas: Vec<LiveDelta>,
    pub finished: bool,
}

impl Accum {
    pub(crate) fn finish(&self) -> Finish {
        let calls = self
            .tools
            .iter()
            .map(|(index, tool)| FinishedCall {
                id: if tool.id.is_empty() {
                    format!("call_{index}")
                } else {
                    tool.id.clone()
                },
                name: if tool.name.is_empty() {
                    "unknown".to_string()
                } else {
                    tool.name.clone()
                },
                arguments: parse_arguments(&tool.arguments),
            })
            .collect();
        Finish {
            model: self.model.clone(),
            calls,
            prompt_tokens: self.prompt_tokens,
            completion_tokens: self.completion_tokens,
            reasoning_tokens: self.reasoning_tokens,
            cached_tokens: self.cached_tokens,
            cost_usd_ticks: self.cost_usd_ticks,
            finish_reason: self.finish_reason.clone(),
        }
    }
}

fn parse_arguments(raw: &str) -> Value {
    let raw = raw.trim();
    if raw.is_empty() {
        return json!({});
    }
    serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string()))
}

/// Apply one SSE line. Malformed JSON is skipped so a single bad event
/// does not drop the reasoning already shown. `[DONE]` finishes the turn.
pub(crate) fn push_sse_line(label: &str, accum: &mut Accum, line: &str) -> SseStep {
    let Some(data) = sse_data(line) else {
        return SseStep {
            deltas: Vec::new(),
            finished: false,
        };
    };
    if data.is_empty() {
        return SseStep {
            deltas: Vec::new(),
            finished: false,
        };
    }
    if data == "[DONE]" {
        return SseStep {
            deltas: Vec::new(),
            finished: true,
        };
    }
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        eprintln!("{label}: skipped a stream event that was not JSON");
        return SseStep {
            deltas: Vec::new(),
            finished: false,
        };
    };
    if let Some(model) = value.get("model").and_then(|item| item.as_str())
        && !model.is_empty()
    {
        accum.model = model.to_string();
    }
    if let Some(usage) = value.get("usage") {
        read_usage(accum, usage);
    }
    let mut deltas = Vec::new();
    let Some(choice) = value
        .get("choices")
        .and_then(|items| items.as_array())
        .and_then(|items| items.first())
    else {
        return SseStep {
            deltas,
            finished: false,
        };
    };
    // finish_reason rides the closing chunk, which may carry no delta at
    // all — read it before the delta check below can return early.
    if let Some(reason) = choice.get("finish_reason").and_then(|item| item.as_str()) {
        accum.finish_reason = Some(reason.to_string());
    }
    let Some(delta) = choice.get("delta") else {
        return SseStep {
            deltas,
            finished: false,
        };
    };
    if let Some(text) = delta.get("content").and_then(|item| item.as_str())
        && !text.is_empty()
    {
        deltas.push(LiveDelta::Content(text.to_string()));
    }
    if let Some(text) = delta
        .get("reasoning_content")
        .and_then(|item| item.as_str())
        && !text.is_empty()
    {
        deltas.push(LiveDelta::Reasoning(text.to_string()));
    }
    if let Some(calls) = delta.get("tool_calls").and_then(|item| item.as_array()) {
        for call in calls {
            absorb_tool_fragment(accum, call);
        }
    }
    SseStep {
        deltas,
        finished: false,
    }
}

fn sse_data(line: &str) -> Option<&str> {
    let line = line.trim();
    let rest = line.strip_prefix("data:")?;
    Some(rest.trim())
}

fn read_usage(accum: &mut Accum, usage: &Value) {
    if let Some(count) = usage.get("prompt_tokens").and_then(|item| item.as_u64()) {
        accum.prompt_tokens = count;
    }
    if let Some(count) = usage
        .get("completion_tokens")
        .and_then(|item| item.as_u64())
    {
        accum.completion_tokens = count;
    }
    if let Some(count) = usage
        .pointer("/completion_tokens_details/reasoning_tokens")
        .and_then(|item| item.as_u64())
    {
        accum.reasoning_tokens = count;
    }
    if let Some(count) = usage
        .pointer("/prompt_tokens_details/cached_tokens")
        .and_then(|item| item.as_u64())
    {
        accum.cached_tokens = count;
    }
    if let Some(ticks) = usage
        .get("cost_in_usd_ticks")
        .and_then(|item| item.as_u64())
    {
        accum.cost_usd_ticks = Some(ticks);
    } else if let Some(usd) = usage.get("cost").and_then(|item| item.as_f64())
        && usd.is_finite()
        && usd >= 0.0
    {
        // OpenCode reports dollars rather than provider-specific ticks.
        accum.cost_usd_ticks = Some((usd * TICKS_PER_USD).round() as u64);
    }
}

fn absorb_tool_fragment(accum: &mut Accum, call: &Value) {
    let index = call
        .get("index")
        .and_then(|item| item.as_u64())
        .unwrap_or(0) as u32;
    let tool = accum.tools.entry(index).or_insert_with(|| PartialTool {
        id: String::new(),
        name: String::new(),
        arguments: String::new(),
    });
    if let Some(id) = call.get("id").and_then(|item| item.as_str())
        && !id.is_empty()
    {
        tool.id = id.to_string();
    }
    let Some(function) = call.get("function") else {
        return;
    };
    if let Some(name) = function.get("name").and_then(|item| item.as_str())
        && !name.is_empty()
    {
        tool.name = name.to_string();
    }
    if let Some(arguments) = function.get("arguments").and_then(|item| item.as_str()) {
        tool.arguments.push_str(arguments);
    }
}

pub(crate) struct ChatPiece {
    pub model: String,
    pub content: String,
    pub reasoning: String,
    pub calls: Vec<FinishedCall>,
    pub done: bool,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub reasoning_tokens: u64,
    pub cached_tokens: u64,
    pub cost_usd_ticks: Option<u64>,
    pub elapsed_ms: f64,
    /// The provider's `finish_reason`, when the closing chunk sent one.
    pub finish_reason: Option<String>,
}

pub(crate) struct GuardedStream {
    inner: tokio_stream::wrappers::ReceiverStream<Result<ChatPiece, ()>>,
    reader: tokio::task::JoinHandle<()>,
}

impl Drop for GuardedStream {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

impl Stream for GuardedStream {
    type Item = Result<ChatPiece, ()>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Pin::new(&mut self.get_mut().inner).poll_next(cx)
    }
}

fn client() -> &'static reqwest::Client {
    static CLIENT: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            // Reasoning models can sit open far longer than a local reply.
            // Stop aborts this task, which drops the request.
            .timeout(Duration::from_secs(3600))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    });
    &CLIENT
}

/// Upper bound on a rate-limit backoff. A provider asking for more than
/// this is retried after the cap; the operator can stop the run instead
/// of waiting minutes inside one round.
const RETRY_AFTER_MAX_SECS: u64 = 60;

/// Backoff when a 429 carries no usable `Retry-After`. Short enough to
/// ride out a burst, long enough not to hammer the API.
const RETRY_AFTER_DEFAULT_SECS: u64 = 10;

/// `Retry-After` in seconds, capped at [`RETRY_AFTER_MAX_SECS`]. An
/// HTTP-date form or an unparsable value returns `None` so the caller
/// uses its default.
fn retry_after_seconds(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let raw = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    let secs: u64 = raw.trim().parse().ok()?;
    Some(secs.min(RETRY_AFTER_MAX_SECS))
}

pub(crate) async fn stream_chat(
    spec: &ProviderSpec,
    api_key: &str,
    body: &Value,
    conversation_id: Option<&str>,
) -> Result<GuardedStream, String> {
    let Some(url) = spec.chat_url else {
        return Err(format!(
            "{} provider spec has no chat URL. The command was not run.",
            spec.display
        ));
    };
    // One bounded rate-limit retry: honor Retry-After when the API sends
    // it, else a short default. Stop still works during the backoff —
    // dropping this future cancels the sleep.
    let mut rate_limited_once = false;
    loop {
        let mut request = client()
            .post(url)
            .bearer_auth(api_key)
            .header(reqwest::header::ACCEPT, "text/event-stream");
        for (name, value) in spec.request_headers {
            request = request.header(*name, *value);
        }
        // Same id for every round of this run, so a provider that caches
        // by conversation can keep the prefix on one server. A header
        // the spec does not name is not sent.
        if let (Some(name), Some(id)) = (spec.cache_conversation_header, conversation_id)
            && let Some(value) = conversation_header_value(spec, id)
            && let Ok(value) = reqwest::header::HeaderValue::from_str(&value)
        {
            request = request.header(name, value);
        }
        let response = match request
            .json(body)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => return Err(format!("{} request failed: {error}", spec.display)),
        };
        if response.status().as_u16() == 429 {
            if rate_limited_once {
                return Err(format!(
                    "{} rate limit: still refused after one retry. Try again later.",
                    spec.display
                ));
            }
            let wait = retry_after_seconds(response.headers()).unwrap_or(RETRY_AFTER_DEFAULT_SECS);
            eprintln!(
                "{}: rate limited (HTTP 429); retrying in {wait}s",
                spec.display
            );
            tokio::time::sleep(Duration::from_secs(wait)).await;
            rate_limited_once = true;
            continue;
        }
        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(format!(
                "{} request failed ({status}): {}",
                spec.display,
                clip(&text)
            ));
        }
        let (tx, rx) = tokio::sync::mpsc::channel(32);
        let reader = tokio::spawn(read_sse(spec.display, response, tx));
        return Ok(GuardedStream {
            inner: tokio_stream::wrappers::ReceiverStream::new(rx),
            reader,
        });
    }
}

async fn read_sse(
    label: &'static str,
    response: reqwest::Response,
    tx: tokio::sync::mpsc::Sender<Result<ChatPiece, ()>>,
) {
    use tokio_stream::StreamExt as _;
    let started = Instant::now();
    let mut accum = Accum::default();
    let mut buffer = String::new();
    // Raw bytes still waiting for enough of a split multibyte character
    // to decode. A TCP chunk can end mid-character; decoding only what
    // is complete keeps every finished line in that chunk.
    let mut pending: Vec<u8> = Vec::new();
    let mut bytes = response.bytes_stream();
    while let Some(chunk) = bytes.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => {
                eprintln!("{label}: stream read failed: {error}");
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
                let line = buffer[start..end].trim_end_matches('\r').to_string();
                start = end + 1;
                if line.is_empty() {
                    continue;
                }
                let step = push_sse_line(label, &mut accum, &line);
                if !forward_deltas(&tx, &accum, step.deltas).await {
                    return;
                }
                if step.finished {
                    let _ = tx.send(Ok(finish_piece(&accum, started.elapsed()))).await;
                    return;
                }
            }
            if start > 0 {
                buffer = buffer[start..].to_string();
            }
        }
    }
    let trailing = buffer.trim().to_string();
    if !trailing.is_empty() {
        let step = push_sse_line(label, &mut accum, &trailing);
        if !forward_deltas(&tx, &accum, step.deltas).await || step.finished {
            if step.finished {
                let _ = tx.send(Ok(finish_piece(&accum, started.elapsed()))).await;
            }
            return;
        }
    }
    let _ = tx.send(Ok(finish_piece(&accum, started.elapsed()))).await;
}

async fn forward_deltas(
    tx: &tokio::sync::mpsc::Sender<Result<ChatPiece, ()>>,
    accum: &Accum,
    deltas: Vec<LiveDelta>,
) -> bool {
    for delta in deltas {
        let (content, reasoning) = match delta {
            LiveDelta::Content(text) => (text, String::new()),
            LiveDelta::Reasoning(text) => (String::new(), text),
        };
        let piece = ChatPiece {
            model: accum.model.clone(),
            content,
            reasoning,
            calls: Vec::new(),
            done: false,
            prompt_tokens: 0,
            completion_tokens: 0,
            reasoning_tokens: 0,
            cached_tokens: 0,
            cost_usd_ticks: None,
            elapsed_ms: 0.0,
            finish_reason: None,
        };
        if tx.send(Ok(piece)).await.is_err() {
            return false;
        }
    }
    true
}

fn finish_piece(accum: &Accum, elapsed: Duration) -> ChatPiece {
    let done = accum.finish();
    ChatPiece {
        model: done.model,
        content: String::new(),
        reasoning: String::new(),
        calls: done.calls,
        done: true,
        prompt_tokens: done.prompt_tokens,
        completion_tokens: done.completion_tokens,
        reasoning_tokens: done.reasoning_tokens,
        cached_tokens: done.cached_tokens,
        cost_usd_ticks: done.cost_usd_ticks,
        elapsed_ms: elapsed.as_secs_f64() * 1000.0,
        finish_reason: done.finish_reason,
    }
}

/// Clip a provider error body for display. Cuts on a UTF-8 character
/// boundary: byte 4000 of a multibyte message must not panic the task
/// that is already reporting the failure.
fn clip(text: &str) -> String {
    let text = text.trim();
    if text.len() <= 4000 {
        return text.to_string();
    }
    let mut end = 4000;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::super::{opencode, reflection, xai};
    use super::*;

    fn message(
        role: &str,
        content: &str,
        tool_calls: Vec<OutboundToolCall>,
        tool_call_id: Option<&str>,
    ) -> OutboundMessage {
        OutboundMessage {
            role: role.to_string(),
            content: content.to_string(),
            tool_calls,
            tool_call_id: tool_call_id.map(str::to_string),
            reasoning_content: None,
            images: Vec::new(),
        }
    }

    #[test]
    fn a_multimodal_message_serializes_as_a_content_parts_array() {
        let msg = OutboundMessage {
            role: "tool".to_string(),
            content: "image metadata".to_string(),
            tool_calls: vec![],
            tool_call_id: Some("call_1".to_string()),
            reasoning_content: None,
            images: vec![OutboundImage {
                media_type: "image/png".to_string(),
                base64: "AAAA".to_string(),
            }],
        };
        let slot = message_json(&msg);
        let content = slot["content"].as_array().expect("content is an array");
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "image metadata");
        assert_eq!(content[1]["type"], "image_url");
        assert_eq!(
            content[1]["image_url"]["url"],
            "data:image/png;base64,AAAA"
        );
        assert_eq!(slot["tool_call_id"], "call_1");
    }

    #[test]
    fn an_image_only_message_has_no_empty_text_part() {
        let msg = OutboundMessage {
            role: "tool".to_string(),
            content: String::new(),
            tool_calls: vec![],
            tool_call_id: None,
            reasoning_content: None,
            images: vec![OutboundImage {
                media_type: "image/png".to_string(),
                base64: "AAAA".to_string(),
            }],
        };
        let slot = message_json(&msg);
        let content = slot["content"].as_array().expect("content is an array");
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "image_url");
    }

    #[test]
    fn the_request_keeps_search_off_and_replays_tool_ids() {
        let tool: ToolInfo = serde_json::from_value(json!({
            "type": "function",
            "function": {
                "name": "run_cmd",
                "description": "Run a shell command",
                "parameters": { "type": "object", "properties": { "command": { "type": "string" } } }
            }
        }))
        .expect("tool schema");
        for (spec, model) in [
            (&xai::SPEC, "grok-4.7"),
            (&reflection::SPEC, "Beam-1.0-501B-A23B"),
        ] {
            let body = request_body(
                spec,
                model,
                &[
                    message("system", "be careful", vec![], None),
                    message("user", "where am I", vec![], None),
                    message(
                        "assistant",
                        "",
                        vec![OutboundToolCall {
                            id: "call_1".into(),
                            name: "run_cmd".into(),
                            arguments: json!({ "command": "pwd" }),
                        }],
                        None,
                    ),
                    message("tool", "/tmp", vec![], Some("call_1")),
                ],
                &[tool.clone()],
                "high",
            );
            assert_eq!(body["model"], model);
            assert_eq!(body["reasoning_effort"], "high");
            assert!(body.get("search_parameters").is_none());
            assert!(body.get("web_search_options").is_none());
            assert_eq!(body["stream"], true);
            assert_eq!(body["stream_options"]["include_usage"], true);
            assert!(body.get("think").is_none());
            let messages = body["messages"].as_array().unwrap();
            assert!(messages[2]["content"].is_null());
            assert!(messages[2].get("reasoning_content").is_none());
            assert_eq!(messages[2]["tool_calls"][0]["id"], "call_1");
            assert_eq!(
                messages[2]["tool_calls"][0]["function"]["arguments"],
                "{\"command\":\"pwd\"}"
            );
            assert_eq!(messages[3]["role"], "tool");
            assert_eq!(messages[3]["tool_call_id"], "call_1");
            assert_eq!(messages[3]["content"], "/tmp");
            assert_eq!(body["tools"][0]["function"]["name"], "run_cmd");
            let encoded = body.to_string();
            assert!(!encoded.contains("XAI_API_KEY"));
            assert!(!encoded.contains("REFLECTION_API_KEY"));
            assert!(!encoded.contains("OPENCODE_API_KEY"));
        }
    }

    #[test]
    fn opencode_requests_strip_the_selector_prefix_and_use_its_session_shape() {
        let body = request_body(
            &opencode::SPEC,
            "opencode/grok-4.7",
            &[message("user", "hello", vec![], None)],
            &[],
            "xhigh",
        );
        assert_eq!(body["model"], "grok-4.7");
        assert!(body.get("reasoning_effort").is_none());
        assert_eq!(
            conversation_header_value(&opencode::SPEC, " run-7-123 "),
            Some("ses_run-7-123".to_string())
        );
        assert_eq!(
            conversation_header_value(&xai::SPEC, "run-7-123"),
            Some("run-7-123".to_string())
        );
        assert_eq!(conversation_header_value(&opencode::SPEC, "  "), None);
        assert_eq!(
            opencode::SPEC.request_headers,
            [("User-Agent", "llm-rnd-harness/0.1.0")]
        );
    }

    #[test]
    fn opencode_usage_cost_in_dollars_is_recorded() {
        let mut accum = Accum::default();
        push_sse_line(
            "opencode",
            &mut accum,
            r#"data: {"model":"kimi-k3","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"cost":0.00412}}"#,
        );
        let done = accum.finish();
        assert_eq!(done.cost_usd_ticks, Some(41_200_000));
        assert!((ticks_to_usd(done.cost_usd_ticks.unwrap()) - 0.00412).abs() < 1e-9);
    }

    #[test]
    fn sse_assembles_a_split_tool_call_and_bills_reasoning_apart_from_completion() {
        let mut accum = Accum::default();
        let lines = [
            r#"data: {"model":"grok-4.7","choices":[{"delta":{"reasoning_content":"Need the path."}}]}"#,
            r#"data: {"model":"grok-4.7","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"run_cmd","arguments":""}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"command\":"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"pwd\"}"}}]}}]}"#,
            r#"data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":32,"completion_tokens":9,"total_tokens":135,"prompt_tokens_details":{"cached_tokens":6},"completion_tokens_details":{"reasoning_tokens":94},"cost_in_usd_ticks":5000000000}}"#,
            "data: [DONE]",
        ];
        let mut reasoning = String::new();
        let mut finished = false;
        for line in lines {
            let step = push_sse_line("probe", &mut accum, line);
            for delta in step.deltas {
                if let LiveDelta::Reasoning(text) = delta {
                    reasoning.push_str(&text);
                }
            }
            finished |= step.finished;
        }
        assert!(finished);
        assert_eq!(reasoning, "Need the path.");
        let done = accum.finish();
        assert_eq!(done.model, "grok-4.7");
        assert_eq!(done.calls.len(), 1);
        assert_eq!(done.calls[0].id, "call_1");
        assert_eq!(done.calls[0].name, "run_cmd");
        assert_eq!(done.calls[0].arguments["command"], "pwd");
        assert_eq!(done.prompt_tokens, 32);
        assert_eq!(done.completion_tokens, 9);
        assert_eq!(done.reasoning_tokens, 94);
        assert_eq!(done.cached_tokens, 6);
        assert_eq!(done.cost_usd_ticks, Some(5_000_000_000));
        assert_eq!(done.finish_reason.as_deref(), Some("tool_calls"));
        assert!((ticks_to_usd(5_000_000_000) - 0.5).abs() < 1e-9);
    }

    #[test]
    fn broken_tool_arguments_stay_visible_as_text() {
        let mut accum = Accum::default();
        push_sse_line(
            "probe",
            &mut accum,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"run_cmd","arguments":"{not json"}}]}}]}"#,
        );
        let done = accum.finish();
        assert_eq!(done.calls[0].arguments, "{not json");
    }

    #[test]
    fn reasoning_replay_is_a_per_provider_preference() {
        let trace = Some("Need the path.".to_string());
        // Verified 2026-11-17: Reflection requires the trace back;
        // xAI does not want it.
        assert_eq!(
            replay_field(&reflection::SPEC, trace.as_ref()),
            Some("Need the path.".to_string())
        );
        assert_eq!(replay_field(&xai::SPEC, trace.as_ref()), None);
        // The mapper's choice is what the request carries.
        let mut with_trace = message("assistant", "I will check.", vec![], None);
        with_trace.reasoning_content = replay_field(&reflection::SPEC, trace.as_ref());
        assert_eq!(
            message_json(&with_trace)["reasoning_content"],
            "Need the path."
        );
        let withheld = OutboundMessage {
            reasoning_content: replay_field(&xai::SPEC, trace.as_ref()),
            ..with_trace
        };
        assert!(withheld.reasoning_content.is_none());
        assert!(message_json(&withheld).get("reasoning_content").is_none());
    }

    #[test]
    fn clip_cuts_on_a_character_boundary() {
        // The byte at offset 4000 falls inside a multibyte character: the
        // cut must back up to the boundary, not panic.
        let text = format!("{}{}", "x".repeat(3999), "世x");
        assert_eq!(text.len(), 4003);
        let clipped = clip(&text);
        assert!(clipped.ends_with('…'));
        assert_eq!(clipped.len(), 3999 + "…".len());
        // A boundary-aligned cut keeps exactly 4000 bytes.
        let plain = "x".repeat(5000);
        assert_eq!(clip(&plain).len(), 4000 + "…".len());
    }

    #[test]
    fn retry_after_is_parsed_and_capped() {
        let mut headers = reqwest::header::HeaderMap::new();
        assert_eq!(retry_after_seconds(&headers), None);
        headers.insert(
            reqwest::header::RETRY_AFTER,
            reqwest::header::HeaderValue::from_static("30"),
        );
        assert_eq!(retry_after_seconds(&headers), Some(30));
        headers.insert(
            reqwest::header::RETRY_AFTER,
            reqwest::header::HeaderValue::from_static("1200"),
        );
        assert_eq!(retry_after_seconds(&headers), Some(RETRY_AFTER_MAX_SECS));
        headers.insert(
            reqwest::header::RETRY_AFTER,
            reqwest::header::HeaderValue::from_static("not-a-number"),
        );
        assert_eq!(retry_after_seconds(&headers), None);
        // The HTTP-date form is not parsed; the caller uses its default.
        headers.insert(
            reqwest::header::RETRY_AFTER,
            reqwest::header::HeaderValue::from_static("Wed, 21 Oct 2026 07:28:00 GMT"),
        );
        assert_eq!(retry_after_seconds(&headers), None);
    }
}
