//! The provider registry. Every chat API the harness can drive is one
//! entry in [`REGISTRY`]: its models, its endpoint, its key, and the wire
//! behaviors that differ per service. Code that used to branch on
//! `is_grok_model(name) || is_reflection_model(name)` resolves the
//! provider once with [`for_model`] and reads the spec fields instead.
//! A new OpenAI-style provider is a new spec entry (plus, only when its
//! wire protocol differs, a new transport adapter); the loop, the
//! approvals, and the model selector do not change.
//!
//! Model catalogs live here, not in `config.rs`. The UI selector groups
//! are emitted from this table; only the Ollama LOCAL group is built
//! dynamically from the installed models at serve time. A spec's static
//! `models` list is the fallback the harness knows in advance: a
//! successful live fetch replaces the offered list with the provider's
//! current one, renames included; any failure leaves the static list
//! in place.

pub(crate) mod chat_completions;
pub(crate) mod ollama;
pub(crate) mod reflection;
pub(crate) mod xai;

/// Which transport adapter serves a provider.
pub(crate) enum Transport {
    /// The Ollama daemon (local or the `:cloud` catalog): NDJSON on
    /// `/api/chat`, tool results addressed by `tool_name`, one
    /// think-disabled retry, and a non-streaming fallback.
    Ollama,
    /// OpenAI-style Chat Completions over SSE: tool results addressed
    /// by `tool_call_id`, usage on the final chunk.
    ChatCompletions,
}

/// One provider entry in [`REGISTRY`].
pub(crate) struct ProviderSpec {
    /// Registry id: "Ollama", "xAI", "Reflection". Stable across display
    /// renames; the id is what `by_id` and history lookups key on.
    pub id: &'static str,
    /// Sentence-case name for operator-facing text ("Grok", "Reflection").
    pub display: &'static str,
    /// The selector group these models appear in ("GROK", "REFLECTION").
    /// Ollama's entry claims "OLLAMA" for the cloud catalog; the LOCAL
    /// group is built from the installed models at serve time.
    pub group_name: &'static str,
    /// Egress host named in the startup banner and cloud warnings.
    pub host: &'static str,
    /// The chat endpoint. `None` for Ollama: its URL comes from the
    /// Ollama client and its transport lives in [`ollama`].
    pub chat_url: Option<&'static str>,
    /// The static model catalog: what the harness knows in advance,
    /// offered whenever the live fetch is unavailable. It must contain
    /// the models the spec behaviors were verified against — and, on
    /// the default provider, the default model. Ollama's is the
    /// published cloud catalog; its local models are discovered at
    /// serve time.
    pub models: &'static [&'static str],
    /// The environment / harness-keys variable holding this provider's
    /// API key. `None` when the provider needs no key.
    pub key_env: Option<&'static str>,
    /// True when prompts, tool outputs, and anything a tool reads leave
    /// this machine when this provider's models are selected.
    pub cloud: bool,
    /// True when `reasoning_effort` is sent on every request, and when
    /// this provider's approval dialogs can change the level for the
    /// next round. One field for both: a provider that accepts effort
    /// on requests but not on dialogs has not shown up yet, and the
    /// split can be added when one does.
    pub supports_reasoning_effort: bool,
    /// True when outbound requests must replay the readable reasoning
    /// trace (`reasoning_content`) on earlier assistant messages.
    /// Verified live against Reflection on 2026-11-17: required there,
    /// refused by xAI. See the note on [`reflection::SPEC`].
    pub replays_reasoning: bool,
    /// True when this provider's models accept image content in a
    /// message (`view_img` attaches the normalized PNG pixels). False
    /// for text-only APIs such as Reflection, whose endpoint rejects a
    /// conversation containing an image with HTTP 400. For Ollama the
    /// provider-level value is true; the per-model answer comes from the
    /// daemon's `vision` capability (see
    /// [`crate::models::model_accepts_images`]).
    pub supports_images: bool,
    /// The provider's published context window for this spec's models, in
    /// tokens, when every model in the catalog shares one figure. Used by
    /// the context-budget monitor; the pre-run guide dialog covers specs
    /// and models without a published figure. Ollama is `None` here: its
    /// live window is per-model `num_ctx`, read from `/api/show`.
    pub context_window: Option<u64>,
    /// Where the provider's live model catalog comes from, fetched once at
    /// startup, best-effort. An absolute URL for Chat Completions specs
    /// (the OpenAI-compatible `/v1/models`; the request carries the
    /// provider key). A daemon-relative path for the Ollama spec (no key:
    /// a signed-in daemon answers with the cloud catalog). `None` when the
    /// provider has no such endpoint. Any failure — no key, timeout, odd
    /// shape, empty list — leaves the spec's static `models` in place.
    pub models_endpoint: Option<&'static str>,
    /// Which transport adapter serves this provider.
    pub transport: Transport,
    /// HTTP header that pins this run's requests to one cache server.
    /// The value is the run id. xAI Chat Completions uses
    /// `x-grok-conv-id` (docs, 2026-03). Reflection's prompt-cache
    /// fields do not change caching. Ollama has no such header; it
    /// reuses a stable prefix in the daemon.
    pub cache_conversation_header: Option<&'static str>,
    /// Static headers sent on every chat request. Reflection accepts
    /// `Reflection-Missing-Reasoning-Strategy: auto` so an assistant
    /// turn that returned no reasoning is not a 400. The header adds
    /// no tokens. Empty for providers that have no such header.
    pub request_headers: &'static [(&'static str, &'static str)],
}

/// Every provider, in selector order. Ollama first: it is the default
/// path and the group list starts with its two groups.
pub(crate) const REGISTRY: &[ProviderSpec] = &[ollama::SPEC, xai::SPEC, reflection::SPEC];

/// The provider registered under `id`.
pub(crate) fn by_id(id: &str) -> Option<&'static ProviderSpec> {
    REGISTRY.iter().find(|spec| spec.id == id)
}

/// The provider serving `name`. Model-name validation is separate
/// (`config::is_known_model` gates `/model` and the selector); any name
/// outside the Chat Completions catalogs is served by Ollama, whose
/// local models are only known at serve time.
pub(crate) fn for_model(name: &str) -> &'static ProviderSpec {
    for spec in REGISTRY {
        if matches!(spec.transport, Transport::ChatCompletions) && catalog_contains(spec, name) {
            return spec;
        }
    }
    &ollama::SPEC
}

/// Live model catalogs fetched at startup, keyed by spec id. An absent
/// entry means the fetch did not run or failed: every reader then uses
/// the spec's static catalog. A fetch that parses to nothing is a
/// failure and never replaces the static list.
static LIVE_CATALOGS: std::sync::LazyLock<
    std::sync::RwLock<std::collections::HashMap<&'static str, Vec<String>>>,
> = std::sync::LazyLock::new(|| std::sync::RwLock::new(std::collections::HashMap::new()));

/// Record the live catalog for `id`. Called once per launch, at startup.
pub(crate) fn set_live_catalog(id: &'static str, models: Vec<String>) {
    if let Ok(mut map) = LIVE_CATALOGS.write() {
        map.insert(id, models);
    }
}

/// Drop every live catalog. Test isolation only: the map is per-process.
#[cfg(test)]
pub(crate) fn clear_live_catalogs() {
    if let Ok(mut map) = LIVE_CATALOGS.write() {
        map.clear();
    }
}

/// The model names offered for `spec`: the live catalog when startup
/// fetched one — the provider's current list, renames included — else
/// the spec's static catalog, the list the harness knows in advance.
pub(crate) fn catalog(spec: &ProviderSpec) -> Vec<String> {
    if let Ok(map) = LIVE_CATALOGS.read()
        && let Some(models) = map.get(spec.id)
    {
        return models.clone();
    }
    spec.models.iter().map(|model| model.to_string()).collect()
}

/// True when `name` is offered under `spec`'s catalog (live or static).
pub(crate) fn catalog_contains(spec: &ProviderSpec, name: &str) -> bool {
    catalog(spec).iter().any(|model| model == name)
}

/// Upper bound on a fetched catalog. A provider listing more than this is
/// treated as a broken response, not a selector offer.
const MAX_CATALOG_MODELS: usize = 500;

fn push_catalog_name(names: &mut Vec<String>, name: String) {
    if !names.iter().any(|existing| existing == &name) {
        names.push(name);
    }
}

/// Parse an OpenAI-compatible `/v1/models` body into model ids.
pub(crate) fn parse_openai_models(body: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    let Some(data) = value.get("data").and_then(|item| item.as_array()) else {
        return Vec::new();
    };
    let mut names = Vec::new();
    for entry in data {
        let Some(id) = entry.get("id").and_then(|item| item.as_str()) else {
            continue;
        };
        if crate::config::is_safe_model_name(id) {
            push_catalog_name(&mut names, id.to_string());
        }
        if names.len() >= MAX_CATALOG_MODELS {
            break;
        }
    }
    names
}

/// Parse a daemon cloud-catalog body (`{"models":[{"name":...}]}`) into
/// selector names. The `:cloud` suffix is the selector's contract — a
/// name that does not carry it (or a `-cloud` tag) gets it appended, the
/// same mapping the official Ollama app applies.
pub(crate) fn parse_ollama_cloud_models(body: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    let Some(models) = value.get("models").and_then(|item| item.as_array()) else {
        return Vec::new();
    };
    let mut names = Vec::new();
    for entry in models {
        let name = entry
            .get("name")
            .and_then(|item| item.as_str())
            .or_else(|| entry.get("model").and_then(|item| item.as_str()));
        let Some(name) = name else {
            continue;
        };
        let trimmed = name.trim().trim_end_matches(":latest");
        if trimmed.is_empty() {
            continue;
        }
        let selector_name = if trimmed.ends_with(":cloud")
            || trimmed
                .rsplit(':')
                .next()
                .is_some_and(|tag| tag.ends_with("-cloud"))
        {
            trimmed.to_string()
        } else {
            format!("{trimmed}:cloud")
        };
        if crate::config::is_safe_model_name(&selector_name) {
            push_catalog_name(&mut names, selector_name);
        }
        if names.len() >= MAX_CATALOG_MODELS {
            break;
        }
    }
    names
}

fn catalog_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(|| {
        reqwest::Client::builder()
            // A catalog fetch must never stall the harness start.
            .connect_timeout(std::time::Duration::from_secs(2))
            .timeout(std::time::Duration::from_secs(6))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    });
    &CLIENT
}

/// Fetch `spec`'s live model catalog once at startup. Chat Completions
/// specs authenticate with their provider key and hit the absolute
/// `/v1/models` URL; the Ollama spec asks the daemon at the relative
/// path (a signed-in daemon answers with the cloud catalog). The fetch
/// sends no prompts — only the key the provider already holds.
pub(crate) async fn fetch_live_catalog(
    spec: &ProviderSpec,
    daemon_url: &str,
) -> Result<Vec<String>, String> {
    let Some(endpoint) = spec.models_endpoint else {
        return Err("this provider declares no model-list endpoint".into());
    };
    let body = match spec.transport {
        Transport::Ollama => {
            let url = format!(
                "{}/{}",
                daemon_url.trim_end_matches('/'),
                endpoint.trim_start_matches('/')
            );
            let response = catalog_client()
                .get(&url)
                .send()
                .await
                .map_err(|error| format!("request failed: {error}"))?;
            if !response.status().is_success() {
                return Err(format!("HTTP {}", response.status()));
            }
            let body = response
                .text()
                .await
                .map_err(|error| format!("response unreadable: {error}"))?;
            let names = parse_ollama_cloud_models(&body);
            return if names.is_empty() {
                Err("the daemon listed no cloud models (not signed in?)".into())
            } else {
                Ok(names)
            };
        }
        Transport::ChatCompletions => {
            let Some(key_env) = spec.key_env else {
                return Err("this provider needs no key, so it has no list to fetch".into());
            };
            let Some(Some(key)) = crate::keys::installed_provider_key(key_env) else {
                return Err(format!("{key_env} is not set, so the catalog is not fetched"));
            };
            let response = catalog_client()
                .get(endpoint)
                .bearer_auth(key)
                .send()
                .await
                .map_err(|error| format!("request failed: {error}"))?;
            if !response.status().is_success() {
                return Err(format!("HTTP {}", response.status()));
            }
            response
                .text()
                .await
                .map_err(|error| format!("response unreadable: {error}"))?
        }
    };
    let names = parse_openai_models(&body);
    if names.is_empty() {
        return Err("the provider listed no models".into());
    }
    Ok(names)
}

/// Every provider API-key variable name. One list: `keys.rs` parses
/// exactly these from the harness-keys file, and every environment-scrub
/// site — the `harden.rs` re-exec scan and the `capture.rs` tool-child
/// scrub — derives from it through [`is_secret_var`] /
/// [`secret_env_vars`]. Adding provider number four means its key name
/// appears here once; no scrub list can miss it.
pub(crate) const KEY_ENV_VARS: &[&str] = &[xai::KEY_ENV, reflection::KEY_ENV];

/// True when `name` is a secret variable the harness must keep out of
/// child processes and `/proc/<pid>/environ`. The history passphrase is
/// a peer of the provider keys everywhere a secret must not travel.
pub(crate) fn is_secret_var(name: &str) -> bool {
    KEY_ENV_VARS.contains(&name) || name == "HARNESS_DB_KEY"
}

/// The secret variable names, for code that scrubs or parses them all.
pub(crate) fn secret_env_vars() -> impl Iterator<Item = &'static str> {
    KEY_ENV_VARS.iter().copied().chain(std::iter::once("HARNESS_DB_KEY"))
}

/// Decode as many complete characters as `bytes` carries, draining what
/// decoded. Returns `None` when the head of the buffer is an incomplete
/// multibyte character — a TCP chunk can split one mid-sequence, and the
/// rest must wait for the next chunk. Permanently invalid bytes are
/// dropped one at a time rather than stalling the stream; both transports
/// feed through this so a split character costs at most a few held-back
/// bytes, never the whole chunk (complete lines included) that a
/// from_utf8-and-continue read would have discarded.
pub(crate) fn take_decodable(bytes: &mut Vec<u8>) -> Option<String> {
    if bytes.is_empty() {
        return None;
    }
    let (valid_up_to, error_len) = match std::str::from_utf8(bytes) {
        Ok(_) => (bytes.len(), None),
        Err(error) => (error.valid_up_to(), error.error_len()),
    };
    if valid_up_to == 0 {
        if error_len.is_some() {
            // Not a split character: an invalid byte. Skip it and keep
            // going instead of dropping everything after it.
            bytes.remove(0);
            return Some(String::new());
        }
        // A partial character: hold the bytes for the next chunk.
        return None;
    }
    // `valid_up_to` is a character boundary, so this is lossless.
    let text = String::from_utf8_lossy(&bytes[..valid_up_to]).into_owned();
    bytes.drain(..valid_up_to);
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_spec_is_registered_once_and_reachable_by_id() {
        assert_eq!(REGISTRY.len(), 3);
        assert!(by_id("Ollama").is_some());
        assert!(by_id("xAI").is_some());
        assert!(by_id("Reflection").is_some());
        assert!(by_id("xAI").unwrap().id == "xAI");
        let ids: Vec<&str> = REGISTRY.iter().map(|spec| spec.id).collect();
        for (index, id) in ids.iter().enumerate() {
            assert!(
                !ids[..index].contains(id),
                "{id} is registered more than once"
            );
        }
    }

    #[test]
    fn image_support_is_declared_per_provider() {
        assert!(ollama::SPEC.supports_images);
        assert!(xai::SPEC.supports_images);
        assert!(!reflection::SPEC.supports_images);
    }

    #[tokio::test]
    async fn image_acceptance_follows_the_provider_spec() {
        let ollama = ollama_rs::Ollama::builder()
            .host("http://127.0.0.1")
            .port(1)
            .build();
        assert_eq!(
            crate::models::model_accepts_images(&ollama, "Beam-1.0-501B-A23B").await,
            Some(false)
        );
        assert_eq!(
            crate::models::model_accepts_images(&ollama, "grok-4.7").await,
            Some(true)
        );
        // An unsafe name never reaches the daemon: unknown, not refused.
        assert_eq!(
            crate::models::model_accepts_images(&ollama, "bad'name:1b").await,
            None
        );
    }

    #[test]
    fn for_model_resolves_catalogs_and_defaults_to_ollama() {
        assert_eq!(for_model("grok-4.7").id, "xAI");
        assert_eq!(for_model("grok-4.5").id, "xAI");
        assert_eq!(for_model("Beam-1.0-501B-A23B").id, "Reflection");
        assert_eq!(for_model("gemma4:31b-cloud").id, "Ollama");
        assert_eq!(for_model("lfm2.5:8b").id, "Ollama");
        assert_eq!(for_model("whatever-tag").id, "Ollama");
    }

    #[test]
    fn catalogs_do_not_overlap_between_providers() {
        for spec in REGISTRY {
            for model in spec.models {
                for other in REGISTRY {
                    if other.id != spec.id {
                        assert!(
                            !other.models.contains(model),
                            "{model} is listed by both {} and {}",
                            spec.id,
                            other.id
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn the_secret_list_covers_every_provider_key() {
        for spec in REGISTRY {
            if let Some(key_env) = spec.key_env {
                assert!(
                    KEY_ENV_VARS.contains(&key_env),
                    "{key_env} is missing from KEY_ENV_VARS; every scrub site derives from it"
                );
            }
        }
        assert!(is_secret_var("XAI_API_KEY"));
        assert!(is_secret_var("REFLECTION_API_KEY"));
        assert!(is_secret_var("HARNESS_DB_KEY"));
        assert!(!is_secret_var("HARNESS_HANDOFF_FD"));
        let all: Vec<&str> = secret_env_vars().collect();
        assert_eq!(all, ["XAI_API_KEY", "REFLECTION_API_KEY", "HARNESS_DB_KEY"]);
    }

    #[test]
    fn cache_headers_follow_the_provider_that_can_use_them() {
        assert_eq!(xai::SPEC.cache_conversation_header, Some("x-grok-conv-id"));
        assert!(xai::SPEC.request_headers.is_empty());
        assert!(reflection::SPEC.cache_conversation_header.is_none());
        assert_eq!(
            reflection::SPEC.request_headers,
            [("Reflection-Missing-Reasoning-Strategy", "auto")]
        );
        assert!(ollama::SPEC.cache_conversation_header.is_none());
        assert!(ollama::SPEC.request_headers.is_empty());
    }

    #[test]
    fn a_published_context_window_is_declared_on_the_spec() {
        // The budget monitor reads the window from the spec: the figure
        // the pre-run guide dialog exists to cover is the `None` case.
        assert_eq!(xai::SPEC.context_window, Some(500_000));
        assert_eq!(reflection::SPEC.context_window, None);
        assert_eq!(ollama::SPEC.context_window, None);
    }

    #[test]
    fn every_spec_declares_its_model_list_endpoint() {
        // Chat Completions specs use their absolute OpenAI-compatible
        // /v1/models; the Ollama spec uses the daemon-relative cloud
        // path (no key).
        assert_eq!(xai::SPEC.models_endpoint.as_deref(), Some("https://api.x.ai/v1/models"));
        assert_eq!(
            reflection::SPEC.models_endpoint.as_deref(),
            Some("https://api.reflection.ai/openai/v1/models")
        );
        assert_eq!(ollama::SPEC.models_endpoint.as_deref(), Some("/api/v1/models/cloud"));
    }

    #[test]
    fn openai_model_lists_parse_into_safe_deduped_names() {
        let body = r#"{"object":"list","data":[
            {"id":"grok-4.8","object":"model"},
            {"id":"grok-4.8","object":"model"},
            {"id":"not a 'safe' name!"},
            {"object":"model"},
            {"id":"grok-4.7"}
        ]}"#;
        assert_eq!(
            parse_openai_models(body),
            ["grok-4.8".to_string(), "grok-4.7".to_string()]
        );
        assert!(parse_openai_models("not json").is_empty());
        assert!(parse_openai_models(r#"{"data":{}}"#).is_empty());
    }

    #[test]
    fn daemon_cloud_names_map_to_selector_cloud_names() {
        let body = r#"{"models":[
            {"name":"gemma4:31b"},
            {"name":"beam:latest"},
            {"name":"deepseek-v4:pro-cloud"},
            {"name":"glm-5.3:cloud"},
            {"name":"bad'name"},
            {"model":"mimo-v2.6-pro"}
        ]}"#;
        let names = parse_ollama_cloud_models(body);
        assert_eq!(
            names,
            [
                "gemma4:31b:cloud".to_string(),
                "beam:cloud".to_string(),
                "deepseek-v4:pro-cloud".to_string(),
                "glm-5.3:cloud".to_string(),
                "mimo-v2.6-pro:cloud".to_string(),
            ]
        );
        assert!(parse_ollama_cloud_models("{}").is_empty());
        assert!(parse_ollama_cloud_models(r#"{"models":[{"name":""}]}"#).is_empty());
    }

    #[test]
    fn a_live_catalog_replaces_the_static_one_until_cleared() {
        clear_live_catalogs();
        // Static first: the unknown model is not offered.
        assert!(!catalog_contains(&xai::SPEC, "grok-4.9"));
        set_live_catalog(
            xai::SPEC.id,
            vec!["grok-4.9".to_string(), "grok-4.7".to_string()],
        );
        // Live replaces: the static-only name is gone, the live one is
        // offered, and dispatch follows the live catalog.
        assert!(catalog_contains(&xai::SPEC, "grok-4.9"));
        assert!(!catalog_contains(&xai::SPEC, "grok-4.5"));
        assert_eq!(for_model("grok-4.9").id, "xAI");
        assert!(crate::config::is_known_model("grok-4.9"));
        // The selector groups follow the live catalog too.
        let json = crate::config::model_groups_json(&crate::config::InstalledModels::default());
        assert!(json.contains("grok-4.9"), "{json}");
        assert!(!json.contains("grok-4.5"), "{json}");
        clear_live_catalogs();
        assert!(!catalog_contains(&xai::SPEC, "grok-4.9"));
    }

    #[test]
    fn a_live_rename_updates_the_menu_and_the_static_list_answers_on_failure() {
        clear_live_catalogs();
        // The static fallback offers what the harness knows in advance.
        assert!(catalog_contains(&reflection::SPEC, "Beam-1.0-501B-A23B"));
        // The provider renamed its only model: the live list becomes the
        // menu, old name and all, and dispatch follows the live name.
        set_live_catalog(reflection::SPEC.id, vec!["Beam-1.0-A23B".to_string()]);
        assert!(catalog_contains(&reflection::SPEC, "Beam-1.0-A23B"));
        assert!(!catalog_contains(&reflection::SPEC, "Beam-1.0-501B-A23B"));
        assert_eq!(for_model("Beam-1.0-A23B").id, "Reflection");
        assert!(crate::config::is_known_model("Beam-1.0-A23B"));
        let json = crate::config::model_groups_json(&crate::config::InstalledModels::default());
        assert!(json.contains("Beam-1.0-A23B"), "{json}");
        assert!(!json.contains("Beam-1.0-501B-A23B"), "{json}");
        // No live list available: the hardcoded list answers again.
        clear_live_catalogs();
        assert!(catalog_contains(&reflection::SPEC, "Beam-1.0-501B-A23B"));
    }

    #[test]
    fn a_multibyte_character_split_across_chunks_is_not_dropped() {
        let mut bytes: Vec<u8> = Vec::new();
        // First chunk ends inside a three-byte character.
        bytes.extend_from_slice("data: {\"a\":\"".as_bytes());
        let split_char = "世".as_bytes(); // 3 bytes
        bytes.extend_from_slice(&split_char[..2]);
        assert_eq!(take_decodable(&mut bytes).as_deref(), Some("data: {\"a\":\""));
        // The partial character is held back, not decoded and not lost.
        assert_eq!(take_decodable(&mut bytes), None);
        // The second chunk completes it.
        bytes.extend_from_slice(&split_char[2..]);
        bytes.extend_from_slice("\"}\n".as_bytes());
        assert_eq!(take_decodable(&mut bytes).as_deref(), Some("世\"}\n"));
        assert_eq!(take_decodable(&mut bytes), None, "buffer drained");
    }

    #[test]
    fn an_invalid_byte_is_skipped_and_the_rest_still_decodes() {
        let mut bytes: Vec<u8> = vec![0xff, b'a'];
        assert_eq!(take_decodable(&mut bytes).as_deref(), Some(""));
        assert_eq!(take_decodable(&mut bytes).as_deref(), Some("a"));
        assert_eq!(take_decodable(&mut bytes), None);
    }

    #[test]
    fn fully_valid_input_decodes_in_one_step() {
        let mut bytes: Vec<u8> = "plain ascii line\n".as_bytes().to_vec();
        assert_eq!(take_decodable(&mut bytes).as_deref(), Some("plain ascii line\n"));
        assert!(bytes.is_empty());
    }
}
