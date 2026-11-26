//! The Reflection provider spec. The Chat Completions machinery it
//! shares with the other OpenAI-style providers lives in
//! `providers::chat_completions`; only this declaration is Reflection's.

use super::{CatalogFormat, ProviderSpec, Transport};

/// The API-key variable, also listed in `providers::KEY_ENV_VARS`.
pub(crate) const KEY_ENV: &str = "REFLECTION_API_KEY";

/// Reflection text models on the Reflection API. A run reaches them
/// only when `REFLECTION_API_KEY` is available. They are always remote.
pub(crate) const MODELS: &[&str] = &["Beam-1.0-501B-A23B"];

pub(crate) const SPEC: ProviderSpec = ProviderSpec {
    id: "Reflection",
    display: "Reflection",
    group_name: "REFLECTION",
    host: "https://api.reflection.ai",
    chat_url: Some("https://api.reflection.ai/openai/v1/chat/completions"),
    models: MODELS,
    selector_prefix: None,
    conversation_id_prefix: None,
    catalog_format: CatalogFormat::OpenAI,
    key_env: Some(KEY_ENV),
    cloud: true,
    // The pre-registry behavior was mixed: the request always carried
    // reasoning_effort, web/PDF/RAG approval dialogs offered a per-round
    // change, and run_cmd approvals did not. The registry unifies it:
    // a provider that accepts reasoning_effort offers the dialogs too.
    supports_reasoning_effort: true,
    // Verified live against Beam-1.0-501B-A23B on 2026-11-17:
    // Reflection REQUIRES the readable reasoning trace
    // (`reasoning_content`) on every earlier assistant message. A
    // multi-round request without it is rejected with HTTP 400
    // `missing_required_parameter` naming
    // `messages[N].reasoning_content`. The replay is billed as input
    // tokens (a 133-character trace cost 87 prompt tokens on the
    // probe's second round), so the cost is real but mandatory. xAI is
    // the opposite; see xai::SPEC.
    replays_reasoning: true,
    // The Reflection endpoint is text-only: it rejects a conversation
    // containing an image with HTTP 400 ("This API supports text input
    // only"). `view_img` therefore never attaches pixels to this
    // provider's turns; the model gets a text refusal instead.
    supports_images: false,
    // No published context window for Beam-1.0-501B-A23B yet. A run
    // under this spec asks for a typed guide limit instead.
    context_window: None,
    // The OpenAI-compatible model list, fetched live at startup when the
    // key is set; the static entry above answers on any failure.
    models_endpoint: Some("https://api.reflection.ai/openai/v1/models"),
    transport: Transport::ChatCompletions,
    // Prompt-cache keys do not change Reflection caching (docs,
    // 2026-11-18). A stable message prefix is the lever. The header
    // accepts an assistant turn that arrived without reasoning so the
    // loop does not invent a trace to satisfy the 400.
    cache_conversation_header: None,
    request_headers: &[("Reflection-Missing-Reasoning-Strategy", "auto")],
};
