//! The xAI (Grok) provider spec. The Chat Completions machinery it
//! shares with the other OpenAI-style providers lives in
//! `providers::chat_completions`; only this declaration is xAI's.

use super::{ProviderSpec, Transport};

/// The API-key variable, also listed in `providers::KEY_ENV_VARS`.
pub(crate) const KEY_ENV: &str = "XAI_API_KEY";

/// Grok text models on the xAI API. A run reaches them only when
/// `XAI_API_KEY` is available. They are always remote.
pub(crate) const MODELS: &[&str] = &["grok-4.7", "grok-4.6", "grok-4.5"];

pub(crate) const SPEC: ProviderSpec = ProviderSpec {
    id: "xAI",
    display: "Grok",
    group_name: "GROK",
    host: "https://api.x.ai",
    chat_url: Some("https://api.x.ai/v1/chat/completions"),
    models: MODELS,
    key_env: Some(KEY_ENV),
    cloud: true,
    // Kept from the pre-registry behavior, now uniform: only xAI
    // approvals offered a per-round effort change, and the Reflection
    // integration had already extended it to its web/PDF/RAG dialogs.
    // A provider that accepts reasoning_effort gets the dialogs too.
    supports_reasoning_effort: true,
    // xAI has no reasoning-replay field: the request leaves the readable
    // trace out, and resending it would only bill it again as input.
    // Reflection is the opposite; see reflection::SPEC.
    replays_reasoning: false,
    // Grok models are multimodal: image parts are accepted on the xAI
    // Chat Completions endpoint, so `view_img` may attach pixels.
    supports_images: true,
    // Grok-4.7, grok-4.6, and grok-4.5 each list a 500,000-token window
    // on the xAI model pages and pricing table (checked 2026-11-15).
    context_window: Some(500_000),
    // The OpenAI-compatible model list, fetched live at startup when the
    // key is set; the static table above answers on any failure.
    models_endpoint: Some("https://api.x.ai/v1/models"),
    transport: Transport::ChatCompletions,
    // Sticky routing for automatic prefix caching. The run id is the
    // header value. Do not send reasoning_content: xAI Chat Completions
    // has no ciphertext field, and a readable trace is billed again.
    cache_conversation_header: Some("x-grok-conv-id"),
    request_headers: &[],
};
