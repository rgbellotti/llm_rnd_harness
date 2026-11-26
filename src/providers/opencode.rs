//! OpenCode Console's pay-as-you-go inference gateway. Console translates
//! every paid text model onto OpenAI Chat Completions, so this provider uses
//! the shared transport. Selector names carry an `opencode/` prefix because
//! gateway ids overlap direct providers (for example `grok-4.7`).

use super::{CatalogFormat, ProviderSpec, Transport};

/// Console API key, also listed in `providers::KEY_ENV_VARS`.
pub(crate) const KEY_ENV: &str = "OPENCODE_API_KEY";

/// Small paid, tool-capable fallback. The live workspace catalog replaces
/// this list at startup when `OPENCODE_API_KEY` is available.
pub(crate) const MODELS: &[&str] = &[
    "kimi-k3",
    "glm-5.3",
    "minimax-m3",
    "deepseek-v4.1-flash",
    "grok-4.7",
];

pub(crate) const SPEC: ProviderSpec = ProviderSpec {
    id: "OpenCode",
    display: "OpenCode",
    group_name: "OPENCODE",
    host: "https://opencode.ai",
    chat_url: Some("https://opencode.ai/inference/openai/v1/chat/completions"),
    models: MODELS,
    selector_prefix: Some("opencode/"),
    conversation_id_prefix: Some("ses_"),
    catalog_format: CatalogFormat::OpenCode,
    key_env: Some(KEY_ENV),
    cloud: true,
    // Console models differ: some do not accept an effort field and the
    // supported values vary. Keep provider defaults until per-model effort
    // controls are wired, rather than sending Grok's setting to every model.
    supports_reasoning_effort: false,
    replays_reasoning: false,
    // Conservative fallback. The live catalog's modalities override this
    // per model, so image-capable models still receive `view_img` pixels.
    supports_images: false,
    // Per-model `limit.context` from the live catalog. Unknown fallback
    // models ask for the typed context guide instead of guessing.
    context_window: None,
    models_endpoint: Some("https://opencode.ai/inference/v1/models"),
    transport: Transport::ChatCompletions,
    // Console routes a conversation consistently and reuses its prompt
    // cache. The shared client adds `ses_` to the harness run id.
    cache_conversation_header: Some("x-opencode-session"),
    request_headers: &[("User-Agent", "llm-rnd-harness/0.1.0")],
};
