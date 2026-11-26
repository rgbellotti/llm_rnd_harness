//! Model identity and predicates, plus the Ollama model machinery:
//! which names are known, cloud, or selectable, the live model lists
//! from the daemon, and the per-provider context-window resolver. The
//! provider catalogs themselves live in [`crate::providers`].

use std::{
    collections::HashMap,
    time::Duration,
};

use ollama_rs::Ollama;
use serde::Deserialize;

/// Model catalogs live in `providers::` — one spec per chat API.
/// `providers::REGISTRY` is the rest.

/// The model a fresh launch falls back to when no persisted default has
/// been saved yet. "Make Default" in the page overrides it at runtime.
pub const FALLBACK_MODEL: &str = crate::providers::xai::MODELS[0];

/// How hard a Grok model thinks before each reply, including before a
/// tool call. The API default is `high`. Ollama runs ignore this.
pub const REASONING_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh"];
pub const DEFAULT_REASONING_EFFORT: &str = "high";

/// How long a model tag may be and still go into the selector or `/model`.
const MODEL_NAME_MAX: usize = 128;

/// True when `name` is in some provider's catalog (live when startup
/// fetched one, static otherwise). A local chat model is not known
/// until Ollama lists it.
pub fn is_known_model(name: &str) -> bool {
    crate::providers::REGISTRY
        .iter()
        .any(|spec| crate::providers::catalog_contains(spec, name))
}

/// True when `name` can sit in the page's model attribute and in a `/model`
/// body. The allowlist is the set Ollama tags use: letters, digits, and
/// `._:/-`. Quotes, spaces, and shell metacharacters stay out.
pub fn is_safe_model_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MODEL_NAME_MAX
        && bytes.iter().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-' | b'/')
        })
        && !name.starts_with('/')
        && !name.ends_with('/')
        && !name.contains("//")
}

/// True when `name` is a cloud model: prompts and tool outputs leave this
/// machine when it is selected. Every registered cloud provider, the
/// published Ollama catalog, and any installed tag that ends in `:cloud`
/// count. A local chat model does not.
pub fn is_cloud_model(name: &str) -> bool {
    crate::providers::for_model(name).cloud || name.ends_with(":cloud")
}

/// `None` when the model can run as configured. `Some(reason)` explains
/// what is missing, for the startup note that tells a first-time user the
/// two ways to a working harness: pull a local model (zero keys), or
/// store a provider key. `key_available` is the caller's answer for the
/// model's provider (the keys file or the environment); `local_models`
/// is what the Ollama daemon currently lists.
pub fn model_blocked(
    model: &str,
    key_available: bool,
    local_models: &[String],
) -> Option<&'static str> {
    if is_cloud_model(model) {
        if key_available {
            return None;
        }
        return Some("no API key is stored for its provider");
    }
    if local_models.iter().any(|name| name == model) {
        return None;
    }
    Some("it is not installed in the local Ollama daemon (or the daemon is not reachable)")
}

pub fn is_reasoning_effort(name: &str) -> bool {
    REASONING_EFFORTS.contains(&name)
}

/// The model used for the *next* run. Switchable at runtime via the
/// selector; resets to [`default_model`] on restart.
pub(crate) static CURRENT_MODEL: std::sync::LazyLock<std::sync::RwLock<String>> =
    std::sync::LazyLock::new(|| std::sync::RwLock::new(default_model()));

pub(crate) fn current_model() -> String {
    CURRENT_MODEL
        .read()
        .map(|g| g.clone())
        .unwrap_or_else(|_| default_model())
}

/// The model the "decision" tab sends its queries to. Independent of
/// [`CURRENT_MODEL`]: a decision query can run while a [Generate] run is
/// in flight and uses this selection instead. Process-local, like
/// [`CURRENT_MODEL`]. Seeded at startup with a local model when one is
/// pulled, else [`FALLBACK_MODEL`] (see [`set_initial_decision_model`]).
pub(crate) static DECISION_MODEL: std::sync::LazyLock<std::sync::RwLock<String>> =
    std::sync::LazyLock::new(|| std::sync::RwLock::new(FALLBACK_MODEL.to_string()));

pub(crate) fn decision_model() -> String {
    DECISION_MODEL
        .read()
        .map(|guard| guard.clone())
        .unwrap_or_else(|_| FALLBACK_MODEL.to_string())
}

pub(crate) fn store_decision_model(name: String) -> Result<(), ()> {
    match DECISION_MODEL.write() {
        Ok(mut guard) => {
            *guard = name;
            Ok(())
        }
        Err(_) => Err(()),
    }
}

/// Seed the decision model once at startup: the first locally-pulled chat
/// model when there is one, else the cloud fallback.
pub(crate) fn set_initial_decision_model(installed: &InstalledModels) {
    let seed = installed
        .local
        .first()
        .cloned()
        .unwrap_or_else(|| FALLBACK_MODEL.to_string());
    if let Ok(mut guard) = DECISION_MODEL.write() {
        *guard = seed;
    }
}

/// The default model for future launches. Process-local like
/// [`CURRENT_MODEL`], seeded from [`FALLBACK_MODEL`], and overridden by
/// "Make Default". The browser keeps the copy and re-sends it on load,
/// exactly like the role.
pub(crate) static DEFAULT_MODEL: std::sync::LazyLock<std::sync::RwLock<String>> =
    std::sync::LazyLock::new(|| std::sync::RwLock::new(FALLBACK_MODEL.to_string()));

pub(crate) fn default_model() -> String {
    DEFAULT_MODEL
        .read()
        .map(|g| g.clone())
        .unwrap_or_else(|_| FALLBACK_MODEL.to_string())
}

pub(crate) fn store_default_model(name: String) -> Result<(), ()> {
    match DEFAULT_MODEL.write() {
        Ok(mut guard) => {
            *guard = name;
            Ok(())
        }
        Err(_) => Err(()),
    }
}

/// Reasoning effort for the next Grok run. Read once at run start.
/// Resets to [`DEFAULT_REASONING_EFFORT`] on restart.
pub(crate) static CURRENT_REASONING_EFFORT: std::sync::LazyLock<std::sync::RwLock<String>> =
    std::sync::LazyLock::new(|| std::sync::RwLock::new(DEFAULT_REASONING_EFFORT.to_string()));

pub(crate) fn current_reasoning_effort() -> String {
    CURRENT_REASONING_EFFORT
        .read()
        .map(|guard| guard.clone())
        .unwrap_or_else(|_| DEFAULT_REASONING_EFFORT.to_string())
}
/// Chat models read from the user's Ollama. `local` runs on this machine.
/// `extra_cloud` is an installed `:cloud` tag that is not already in the
/// published catalog. Embedding models are left out of both.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct InstalledModels {
    pub(crate) local: Vec<String>,
    pub(crate) extra_cloud: Vec<String>,
    pub(crate) skipped_unsafe: usize,
}

impl InstalledModels {
    pub(crate) fn contains(&self, name: &str) -> bool {
        self.local.iter().any(|known| known == name)
            || self.extra_cloud.iter().any(|known| known == name)
    }
}

/// One row of `GET /api/tags`. `capabilities` is absent on older daemons;
/// the caller then asks `/api/show`.
#[derive(Debug, Deserialize)]
pub(crate) struct TagModel {
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) capabilities: Option<Vec<String>>,
    /// Set when the entry is served from a remote host (a cloud mirror,
    /// not a genuinely local model). The official app excludes these from
    /// the local list; the harness does the same.
    #[serde(default)]
    remote_model: Option<String>,
    #[serde(default)]
    remote_host: Option<String>,
}

#[derive(Deserialize)]
struct TagsBody {
    models: Vec<TagModel>,
}

fn ollama_tags_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    });
    &CLIENT
}

fn ollama_api_url(ollama: &Ollama, path: &str) -> String {
    format!(
        "{}/{}",
        ollama.url_str().trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

/// Whether the Ollama daemon answered its root endpoint successfully.
/// This is a reachability check only: an empty model list is still running.
pub(crate) async fn ollama_server_available(ollama: &Ollama) -> bool {
    let url = format!("{}/", ollama.url_str().trim_end_matches('/'));
    match ollama_tags_client().get(url).send().await {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
}

pub(crate) fn parse_tags(bytes: &[u8]) -> Result<Vec<TagModel>, String> {
    serde_json::from_slice::<TagsBody>(bytes)
        .map(|body| body.models)
        .map_err(|_| "Ollama tags response was not a model list".to_string())
}

fn push_unique(list: &mut Vec<String>, name: String) {
    if !list.iter().any(|existing| existing == &name) {
        list.push(name);
    }
}

/// Keep a tag when it advertises `completion` and does not advertise
/// `embedding`. A `:cloud` tag joins the cloud list; anything else is local.
/// Names that cannot sit in the page attribute are counted and dropped.
pub(crate) fn partition_chat_models(entries: Vec<(String, Vec<String>)>) -> InstalledModels {
    let mut installed = InstalledModels::default();
    for (name, capabilities) in entries {
        if !is_safe_model_name(&name) {
            installed.skipped_unsafe += 1;
            continue;
        }
        let embedding = capabilities.iter().any(|cap| cap == "embedding");
        let completion = capabilities.iter().any(|cap| cap == "completion");
        if embedding || !completion {
            continue;
        }
        if is_known_model(&name) {
            continue;
        }
        if name.ends_with(":cloud") {
            push_unique(&mut installed.extra_cloud, name);
        } else {
            push_unique(&mut installed.local, name);
        }
    }
    installed
}

/// Keep a tag when it advertises `decision` (an Ollama decision model:
/// `d3`-family locally, `clef`/`d1`/`laya` in the cloud catalog). A
/// `:cloud` tag joins the cloud list; anything else is local. Names that
/// cannot sit in the page attribute are counted and dropped.
pub(crate) fn partition_decision_models(entries: Vec<(String, Vec<String>)>) -> InstalledModels {
    let mut installed = InstalledModels::default();
    for (name, capabilities) in entries {
        if !is_safe_model_name(&name) {
            installed.skipped_unsafe += 1;
            continue;
        }
        let decision = capabilities.iter().any(|cap| cap == "decision");
        if !decision {
            continue;
        }
        if name.ends_with(":cloud") {
            push_unique(&mut installed.extra_cloud, name);
        } else {
            push_unique(&mut installed.local, name);
        }
    }
    installed
}

fn context_window_cache() -> &'static std::sync::Mutex<HashMap<String, Option<u64>>> {
    static CACHE: std::sync::LazyLock<std::sync::Mutex<HashMap<String, Option<u64>>>> =
        std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));
    &CACHE
}

/// The context window the budget monitor uses for `name`, or `None` when
/// no figure is known.
///
/// A Chat Completions provider's window comes from live per-model metadata
/// when its catalog supplies it, otherwise from the provider spec. An
/// Ollama model uses the live `num_ctx` from its `/api/show` parameters,
/// cached for this launch. A missing value stays missing until restart;
/// the run then falls back to a typed guide.
pub(crate) async fn provider_context_window(ollama: &Ollama, name: &str) -> Option<u64> {
    let spec = crate::providers::for_model(name);
    if let Some(tokens) = crate::providers::model_context_window(spec, name) {
        return Some(tokens);
    }
    // Unknown Chat Completions models have no Ollama metadata to query.
    if !matches!(spec.transport, crate::providers::Transport::Ollama) {
        return None;
    }
    if !is_safe_model_name(name) {
        return None;
    }
    if let Some(cached) = context_window_cache()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .get(name)
        .copied()
    {
        return cached;
    }
    let found = num_ctx_from_show(ollama, name).await;
    let mut guard = context_window_cache()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    *guard.entry(name.to_string()).or_insert(found)
}

async fn num_ctx_from_show(ollama: &Ollama, name: &str) -> Option<u64> {
    let url = ollama_api_url(ollama, "api/show");
    let response = match ollama_tags_client()
        .post(&url)
        .json(&serde_json::json!({ "name": name }))
        .send()
        .await
    {
        Ok(response) => response,
        Err(err) => {
            eprintln!("context window: show for {name} was unavailable ({err})");
            return None;
        }
    };
    if !response.status().is_success() {
        eprintln!(
            "context window: show for {name} was unavailable (HTTP {})",
            response.status()
        );
        return None;
    }
    let bytes = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(err) => {
            eprintln!("context window: show for {name} was unreadable ({err})");
            return None;
        }
    };
    #[derive(Deserialize)]
    struct ShowWindow {
        #[serde(default)]
        parameters: Option<String>,
    }
    match serde_json::from_slice::<ShowWindow>(&bytes) {
        Ok(body) => {
            crate::context_budget::num_ctx_from_parameters(body.parameters.as_deref().unwrap_or(""))
        }
        Err(err) => {
            eprintln!("context window: show for {name} was unreadable ({err})");
            None
        }
    }
}

async fn capabilities_from_show(ollama: &Ollama, name: &str) -> Option<Vec<String>> {
    if !is_safe_model_name(name) {
        return None;
    }
    let url = ollama_api_url(ollama, "api/show");
    let response = match ollama_tags_client()
        .post(&url)
        .json(&serde_json::json!({ "name": name }))
        .send()
        .await
    {
        Ok(response) => response,
        Err(err) => {
            eprintln!("local models: capabilities for {name} were unavailable ({err})");
            return None;
        }
    };
    if !response.status().is_success() {
        eprintln!(
            "local models: capabilities for {name} were unavailable (HTTP {})",
            response.status()
        );
        return None;
    }
    let bytes = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(err) => {
            eprintln!("local models: capabilities for {name} were unreadable ({err})");
            return None;
        }
    };
    #[derive(Deserialize)]
    struct ShowBody {
        #[serde(default)]
        capabilities: Vec<String>,
    }
    match serde_json::from_slice::<ShowBody>(&bytes) {
        Ok(body) => Some(body.capabilities),
        Err(err) => {
            eprintln!("local models: capabilities for {name} were unreadable ({err})");
            None
        }
    }
}

/// Whether `name` can accept image content, when the harness can tell.
/// `Some(false)` means `view_img` must not attach pixels — a text-only
/// provider or model rejects a conversation containing an image (HTTP
/// 400 on Reflection) and the run would die. `Some(true)` allows the
/// attachment. `None` means the harness cannot tell (an older Ollama
/// daemon that reports no capabilities): the caller keeps the previous
/// behavior and the daemon itself answers.
pub(crate) async fn model_accepts_images(ollama: &Ollama, name: &str) -> Option<bool> {
    let spec = crate::providers::for_model(name);
    match spec.transport {
        crate::providers::Transport::ChatCompletions => {
            Some(crate::providers::model_supports_images(spec, name))
        }
        crate::providers::Transport::Ollama => ollama_vision_capability(ollama, name).await,
    }
}

fn vision_cache() -> &'static std::sync::Mutex<HashMap<String, Option<bool>>> {
    static CACHE: std::sync::LazyLock<std::sync::Mutex<HashMap<String, Option<bool>>>> =
        std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));
    &CACHE
}

/// The Ollama answer: `vision` in the model's reported capabilities. A
/// daemon that reports capabilities without `vision` is a text-only
/// model and answers `Some(false)`. `None` when the daemon cannot tell,
/// cached per name like the context window.
async fn ollama_vision_capability(ollama: &Ollama, name: &str) -> Option<bool> {
    if !is_safe_model_name(name) {
        return None;
    }
    if let Some(cached) = vision_cache()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .get(name)
        .copied()
    {
        return cached;
    }
    let found = capabilities_from_show(ollama, name)
        .await
        .map(|caps| caps.iter().any(|cap| cap == "vision"));
    let mut guard = vision_cache()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    *guard.entry(name.to_string()).or_insert(found)
}

/// Fetch the daemon's `/api/tags` and resolve each tag's capabilities,
/// asking `/api/show` for any entry the tags response did not describe.
/// The shared step behind the chat and decision model lists.
async fn resolved_tags(ollama: &Ollama) -> Result<Vec<(String, Vec<String>)>, String> {
    let url = ollama_api_url(ollama, "api/tags");
    let response = ollama_tags_client().get(&url).send().await.map_err(|err| {
        format!(
            "could not read Ollama tags at {url} ({err}); the selector lists the published cloud catalog and Grok models"
        )
    })?;
    if !response.status().is_success() {
        return Err(format!(
            "Ollama tags at {url} returned HTTP {}; the selector lists the published cloud catalog and Grok models",
            response.status()
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|err| format!("Ollama tags response was unreadable ({err})"))?;
    let pending = parse_tags(&bytes)?;
    let mut resolved = Vec::with_capacity(pending.len());
    let mut show_calls = 0usize;
    for entry in pending {
        // A remote-backed tag is a cloud mirror: not a local model, and
        // it must not consume one of the capability-probe slots either.
        if entry.remote_model.is_some() || entry.remote_host.is_some() {
            continue;
        }
        let capabilities = match entry.capabilities {
            Some(capabilities) => capabilities,
            None => {
                show_calls += 1;
                if show_calls > 64 {
                    if show_calls == 65 {
                        eprintln!(
                            "local models: stopped asking Ollama for capabilities after 64 models"
                        );
                    }
                    continue;
                }
                match capabilities_from_show(ollama, &entry.name).await {
                    Some(capabilities) => capabilities,
                    None => continue,
                }
            }
        };
        resolved.push((entry.name, capabilities));
    }
    Ok(resolved)
}

/// Chat models installed in `ollama`. A daemon that cannot be reached leaves
/// the selector on the published cloud catalog and the Grok list.
pub(crate) async fn installed_models(ollama: &Ollama) -> Result<InstalledModels, String> {
    let resolved = resolved_tags(ollama).await?;
    let installed = partition_chat_models(resolved);
    if installed.skipped_unsafe > 0 {
        eprintln!(
            "local models: skipped {} Ollama tag(s) whose names are not safe to put in the selector",
            installed.skipped_unsafe
        );
    }
    Ok(installed)
}

/// Decision models installed in `ollama` (the `decision` capability).
pub(crate) async fn installed_decision_models(ollama: &Ollama) -> Result<InstalledModels, String> {
    Ok(partition_decision_models(resolved_tags(ollama).await?))
}

/// True when `name` may be selected in the decision tab: a cloud decision
/// model in the static catalog, or an installed local decision model.
pub(crate) async fn decision_model_is_selectable(ollama: &Ollama, name: &str) -> bool {
    if !is_safe_model_name(name) {
        return false;
    }
    if crate::providers::ollama::DECISION_MODELS.iter().any(|known| *known == name) {
        return true;
    }
    match installed_decision_models(ollama).await {
        Ok(installed) => installed.contains(name),
        Err(err) => {
            eprintln!("decision models: {err}");
            false
        }
    }
}

/// True when `name` may be selected: the published catalog, a Grok model,
/// or a chat model this Ollama currently lists. An unreachable daemon still
/// accepts the catalog and the Grok list.
pub(crate) async fn model_is_selectable(ollama: &Ollama, name: &str) -> bool {
    if is_known_model(name) {
        return true;
    }
    if !is_safe_model_name(name) {
        return false;
    }
    match installed_models(ollama).await {
        Ok(installed) => is_offered_model(name, &installed),
        Err(err) => {
            eprintln!("local models: {err}");
            false
        }
    }
}

/// True when the selector may offer `name` given models already read from Ollama.
pub(crate) fn is_offered_model(name: &str, installed: &InstalledModels) -> bool {
    is_safe_model_name(name) && (is_known_model(name) || installed.contains(name))
}

/// Model-group payload for the runtime selector. OLLAMA is the published
/// catalog (live when the daemon served it) plus any extra installed
/// `:cloud` chat tag. LOCAL is the user's installed chat models and may
/// be empty. The remaining groups come from the provider registry's
/// catalogs, in registry order (GROK, REFLECTION). Names that fail
/// [`is_safe_model_name`] are left out, so the JSON stays safe inside
/// the single-quoted `data-groups` attribute.
pub(crate) fn model_groups_json(installed: &InstalledModels) -> String {
    let mut cloud: Vec<String> = crate::providers::catalog(&crate::providers::ollama::SPEC);
    for name in &installed.extra_cloud {
        if is_safe_model_name(name) && !cloud.iter().any(|known| known == name) {
            cloud.push(name.clone());
        }
    }
    let local: Vec<String> = installed
        .local
        .iter()
        .filter(|name| is_safe_model_name(name))
        .cloned()
        .collect();
    let mut groups: Vec<(&str, Vec<String>)> = vec![
        ("OLLAMA", cloud),
        ("LOCAL", local),
    ];
    for spec in crate::providers::REGISTRY {
        if matches!(
            spec.transport,
            crate::providers::Transport::ChatCompletions
        ) {
            groups.push((spec.group_name, crate::providers::catalog(spec)));
        }
    }
    let groups: Vec<serde_json::Value> = groups
        .iter()
        .map(|(group, models)| serde_json::json!({ "group": group, "models": models }))
        .collect();
    serde_json::to_string(&groups).expect("model groups serialize")
}

/// Model-group payload for the decision tab's selector. OLLAMA is the
/// published cloud decision catalog (`DECISION_MODELS`) plus any extra
/// installed `:cloud` decision tag; LOCAL is the user's installed
/// decision models (the `decision` capability). Names that fail
/// [`is_safe_model_name`] are left out.
pub(crate) fn decision_model_groups_json(installed: &InstalledModels) -> String {
    let mut cloud: Vec<String> = crate::providers::ollama::DECISION_MODELS
        .iter()
        .map(|name| name.to_string())
        .collect();
    for name in &installed.extra_cloud {
        if is_safe_model_name(name) && !cloud.iter().any(|known| known == name) {
            cloud.push(name.clone());
        }
    }
    let local: Vec<String> = installed
        .local
        .iter()
        .filter(|name| is_safe_model_name(name))
        .cloned()
        .collect();
    let groups: Vec<serde_json::Value> = [
        ("OLLAMA", cloud),
        ("LOCAL", local),
    ]
    .iter()
    .map(|(group, models)| serde_json::json!({ "group": group, "models": models }))
    .collect();
    serde_json::to_string(&groups).expect("decision model groups serialize")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ollama_server_availability_checks_the_root_endpoint() {
        use axum::{Router, routing::get};

        let app = Router::new().route("/", get(|| async { "Ollama is running" }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let running = Ollama::builder()
            .host("http://127.0.0.1")
            .port(address.port())
            .build();
        assert!(ollama_server_available(&running).await);
        server.abort();

        let reserved = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let stopped_port = reserved.local_addr().unwrap().port();
        drop(reserved);
        let stopped = Ollama::builder()
            .host("http://127.0.0.1")
            .port(stopped_port)
            .build();
        assert!(!ollama_server_available(&stopped).await);
    }

    #[test]
    fn model_blocked_names_what_a_first_launch_is_missing() {
        // A cloud model runs only with its provider key stored.
        let grok = crate::providers::xai::MODELS[0];
        assert!(model_blocked(grok, false, &[]).is_some());
        assert!(model_blocked(grok, true, &[]).is_none());
        let opencode = crate::providers::selector_name(
            &crate::providers::opencode::SPEC,
            crate::providers::opencode::MODELS[0],
        );
        assert!(is_cloud_model(&opencode));
        assert!(model_blocked(&opencode, false, &[]).is_some());
        assert!(model_blocked(&opencode, true, &[]).is_none());
        // A local model runs when the daemon lists it; an empty list
        // covers a stopped daemon too.
        let local = vec!["lfm2.5:8b".to_string()];
        assert_eq!(
            model_blocked("lfm2.5:8b", false, &local),
            None,
            "an installed local model needs no key"
        );
        let missing = model_blocked("lfm2.5:8b", false, &[]).expect("missing local model");
        assert!(missing.contains("Ollama daemon"), "{missing}");
        // The default model at a fresh launch is a Grok catalog entry,
        // so the no-key notice is exactly what a first-time user sees.
        assert!(is_cloud_model(FALLBACK_MODEL));
        let reason = model_blocked(FALLBACK_MODEL, false, &[]).expect("default blocked");
        assert!(reason.contains("API key"), "{reason}");
    }
}
