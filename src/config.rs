//! Process-wide configuration: limits, CLI parsing, the workspace and
//! the role settings, plus the re-export surface for the split modules.
//! Model identity and the Ollama machinery live in [`crate::models`]; the
//! page assets and handler in [`crate::page`]; the shared run state in
//! [`crate::state`]. Sentences the model reads live in
//! [`crate::model_voice`].

pub(crate) use crate::models::*;
pub(crate) use crate::page::*;
pub(crate) use crate::state::*;

/// Port the harness listens on (loopback only).
pub const PORT: u16 = 3239;

/// `run_cmd` output review starts on for each launch. The config checkbox
/// can turn it off for later runs in that same process.
// There is deliberately no round cap: a tool chain ends when the model
// stops calling tools or when the user Stops it. The real bound is the
// human approval gate — every round (including ask_user) waits for a
// decision — so an unbounded chain only advances while someone keeps
// approving it. That wait has no deadline. A call can sit while you look
// up what it does; Stop or a disconnect is what ends the run. Tool
// processes keep their own execution timeouts so a hung command cannot
// hold the process. A fixed round budget used to truncate legitimate long
// sessions (a hundred rounds is nothing for an agentic search loop).
// No character caps are applied to prompts either.

/// Soft cap on one tool's captured output. Unbounded capture inside the
/// tool timeout (`yes` produces GBs in 30 s) was an OOM vector; the tail is
/// replaced with an explicit truncation marker so the model and user see
/// exactly what happened. Prompts and model responses stay uncapped.
pub const MAX_TOOL_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

/// Explicit working directory for all tool processes. Captured once at
/// startup so `run_cmd`/`custom tools` never inherit an accidental cwd.
/// Served via `/config` and baked into the system prompt per run.
pub(crate) static WORKSPACE_DIR: std::sync::LazyLock<std::path::PathBuf> =
    std::sync::LazyLock::new(|| {
        std::env::current_dir()
            .ok()
            .and_then(|p| p.canonicalize().ok())
            .unwrap_or_else(|| std::path::PathBuf::from("."))
    });

pub(crate) fn workspace_dir_string() -> String {
    WORKSPACE_DIR.to_string_lossy().into_owned()
}

/// How long a role template may be. A run sends it on every model call.
pub(crate) const ROLE_TEMPLATE_MAX: usize = 64 * 1024;
/// How long a workspace path named in the role may be.
pub(crate) const WORKSPACE_ENV_MAX: usize = 4096;

/// The role the next run reads, plus whether the workspace sentence follows it.
/// Process-local, like [`CURRENT_MODEL`]. A restart returns to the built-in
/// role until the page sends the copy it saved in the browser.
#[derive(Clone, Debug)]
pub(crate) struct RoleSettings {
    pub template: String,
    pub workspace_enabled: bool,
    /// Empty means the launch directory. Tool processes keep that directory
    /// either way; this path is only the one named in the sentence.
    pub workspace_env: String,
}

pub(crate) fn default_role_settings() -> RoleSettings {
    RoleSettings {
        template: crate::model_voice::SYSTEM_PROMPT.to_string(),
        workspace_enabled: true,
        workspace_env: String::new(),
    }
}

pub(crate) static ROLE_SETTINGS: std::sync::LazyLock<std::sync::RwLock<RoleSettings>> =
    std::sync::LazyLock::new(|| std::sync::RwLock::new(default_role_settings()));

/// Serializes tests that read or replace [`ROLE_SETTINGS`].
#[cfg(test)]
pub(crate) static ROLE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(crate) fn role_settings() -> RoleSettings {
    ROLE_SETTINGS
        .read()
        .map(|guard| guard.clone())
        .unwrap_or_else(|_| default_role_settings())
}

pub(crate) fn store_role_settings(next: RoleSettings) -> Result<(), ()> {
    match ROLE_SETTINGS.write() {
        Ok(mut guard) => {
            *guard = next;
            Ok(())
        }
        Err(_) => Err(()),
    }
}

/// The directory the workspace sentence names. An empty custom path uses
/// the launch directory.
pub(crate) fn effective_workspace_env(settings: &RoleSettings) -> String {
    let custom = settings.workspace_env.trim();
    if custom.is_empty() {
        workspace_dir_string()
    } else {
        custom.to_string()
    }
}

pub(crate) fn workspace_sentence_text(settings: &RoleSettings) -> String {
    if !settings.workspace_enabled {
        return String::new();
    }
    let path = effective_workspace_env(settings);
    if path.is_empty() {
        return String::new();
    }
    crate::model_voice::workspace_sentence(&path)
}

pub(crate) fn normalize_role_template(raw: &str) -> Result<String, String> {
    if raw.len() > ROLE_TEMPLATE_MAX {
        return Err(format!("Role is longer than {ROLE_TEMPLATE_MAX} bytes."));
    }
    if raw.contains('\0') {
        return Err("Role cannot contain a null byte.".to_string());
    }
    Ok(raw.to_string())
}

pub(crate) fn normalize_workspace_env(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.len() > WORKSPACE_ENV_MAX {
        return Err(format!(
            "Workspace path is longer than {WORKSPACE_ENV_MAX} bytes."
        ));
    }
    if trimmed.chars().any(|c| c == '\0' || c == '\n' || c == '\r') {
        return Err("Workspace path cannot contain a line break.".to_string());
    }
    if trimmed.is_empty() || trimmed == workspace_dir_string() {
        return Ok(String::new());
    }
    Ok(trimmed.to_string())
}

pub(crate) fn system_prompt_with_workspace() -> String {
    let settings = role_settings();
    let path = effective_workspace_env(&settings);
    crate::model_voice::render_role(
        &settings.template,
        comment_tag(),
        &path,
        settings.workspace_enabled,
    )
}

/// Internal decision delivered from POST /approve to the paused tool loop.
/// Arguments the harness itself understands. Cargo's `--` is ignored.
#[derive(Debug)]
pub(crate) struct CliArgs {
    pub tool_files: Vec<String>,
    /// `--history <path>`. Wins over `HARNESS_DB_PATH` when both are set.
    pub history_path: Option<String>,
}

const USAGE: &str = "cargo run -- --tools a.json b.json --history /path/to/harness.db";

pub(crate) fn parse_cli(argv: &[String]) -> Result<CliArgs, String> {
    let mut tool_files = Vec::new();
    let mut history_path = None;
    let mut i = 1;
    while i < argv.len() {
        // Tolerate a bare `--` (cargo's separator is stripped by cargo
        // itself, but direct `./binary -- --tools …` invocations keep it).
        if argv[i] == "--" {
            i += 1;
            continue;
        }
        match argv[i].as_str() {
            "--tools" => {
                i += 1;
                let mut count = 0;
                while i < argv.len() && !argv[i].starts_with("--") {
                    tool_files.push(argv[i].clone());
                    count += 1;
                    i += 1;
                }
                if count == 0 {
                    return Err(format!("--tools needs at least one file (usage: {USAGE})"));
                }
            }
            "--history" => {
                let Some(path) = argv.get(i + 1) else {
                    return Err(format!("--history needs a path (usage: {USAGE})"));
                };
                if path.is_empty() || path.starts_with("--") {
                    return Err(format!("--history needs a path (usage: {USAGE})"));
                }
                if history_path.is_some() {
                    return Err("--history was given twice".to_string());
                }
                history_path = Some(path.clone());
                i += 2;
            }
            // The first-startup encryption wizard ran in `keys::prepare`,
            // before this parse: the flag is accepted so the start that
            // asked for it does not die on an unknown argument.
            "--setup-keys" => {
                i += 1;
            }
            other => {
                return Err(format!("unknown argument: {other} (usage: {USAGE})"));
            }
        }
    }
    Ok(CliArgs {
        tool_files,
        history_path,
    })
}

#[cfg(test)]
pub(crate) fn parse_tool_files(argv: &[String]) -> Result<Vec<String>, String> {
    Ok(parse_cli(argv)?.tool_files)
}

#[cfg(test)]
mod config_tests {
    use super::*;
    use std::{
        collections::HashMap,
        sync::{Arc, atomic::{AtomicBool, AtomicU64}},
    };
    use tokio::sync::{Mutex, Semaphore};

    async fn state() -> AppState {
        AppState {
            ollama: ollama_rs::Ollama::default(),
            web_runner: "/bin/echo".into(),
            semaphore: Arc::new(Semaphore::new(1)),
            enabled_tools: Arc::new(std::sync::RwLock::new(
                crate::tools::default_enabled().await,
            )),
            approve_calls: empty_tool_set(),
            approve_outputs: empty_tool_set(),
            pending: Arc::new(Mutex::new(HashMap::new())),
            run_counter: Arc::new(AtomicU64::new(1)),
            runs: Arc::new(Mutex::new(HashMap::new())),
            stop_flags: Arc::new(Mutex::new(HashMap::new())),
            stop_next: Arc::new(Mutex::new(None)),
            history: crate::history::HistoryDb::open(":memory:"),
            memory: crate::memory::MemoryDb::open(":memory:"),
            review_run_cmd: Arc::new(AtomicBool::new(false)),
            tool_policy_path: None,
        }
    }

    struct RestoreRole(RoleSettings);
    impl Drop for RestoreRole {
        fn drop(&mut self) {
            if let Ok(mut guard) = ROLE_SETTINGS.write() {
                *guard = self.0.clone();
            }
        }
    }

    fn role_lock() -> std::sync::MutexGuard<'static, ()> {
        ROLE_TEST_LOCK.lock().unwrap_or_else(|err| err.into_inner())
    }

    /// The launch marker and the workspace path are architectural.
    /// The sentences around them live in `model_voice` and are not asserted here.
    #[test]
    fn the_default_model_is_known_and_overridable() {
        // The fallback is in a provider catalog, so a fresh launch (no
        // saved default) always offers a working selection.
        assert!(crate::providers::REGISTRY
            .iter()
            .any(|spec| crate::providers::catalog_contains(spec, FALLBACK_MODEL)));
        // "Make Default" overrides the default at runtime and leaves the
        // current selection untouched.
        let original = default_model();
        store_default_model("grok-4.6".to_string()).expect("default lock");
        assert_eq!(default_model(), "grok-4.6");
        store_default_model(original).expect("restore");
    }

    #[test]
    fn the_setup_keys_flag_is_accepted_and_ignored_by_the_parse() {
        // The wizard ran in `keys::prepare`, before the parse; the flag
        // must not die here as an unknown argument.
        let args = parse_cli(&[
            "llm_rnd_harness".to_string(),
            "--setup-keys".to_string(),
        ])
        .expect("accepted");
        assert!(args.tool_files.is_empty());
        assert!(args.history_path.is_none());
        // An unknown flag still is an error, so the acceptance is not a
        // blanket ignore.
        assert!(parse_cli(&["llm_rnd_harness".to_string(), "--nope".to_string()]).is_err());
    }

    #[test]
    fn system_prompt_carries_the_launch_marker_and_workspace() {
        let _lock = role_lock();
        let _restore = RestoreRole(role_settings());
        store_role_settings(default_role_settings()).expect("role lock");
        let prompt = system_prompt_with_workspace();
        let tag = comment_tag();
        let workspace = workspace_dir_string();
        assert_eq!(tag.len(), 20, "{tag}");
        assert!(tag.bytes().all(|byte| byte.is_ascii_hexdigit()), "{tag}");
        assert_eq!(comment_tag(), tag, "the launch marker stays fixed");
        assert_ne!(
            harness_token(),
            COMMENT_KEY.as_str(),
            "the comment key stays off the bearer token"
        );
        assert!(prompt.contains(&format!("<{tag}>")), "{prompt}");
        assert!(prompt.contains(&format!("</{tag}>")), "{prompt}");
        assert!(
            !prompt.contains("<user_comment>"),
            "the page's display name is not the marker the model trusts: {prompt}"
        );
        assert!(!prompt.contains("</user_comment>"), "{prompt}");
        assert!(prompt.contains(&workspace), "{prompt}");
        assert!(!prompt.contains("{comment_tag}"), "{prompt}");
        assert!(!prompt.contains("{workspace}"), "{prompt}");
    }

    #[test]
    fn the_workspace_sentence_follows_the_switch_and_the_named_path() {
        let _lock = role_lock();
        let _restore = RestoreRole(role_settings());
        store_role_settings(RoleSettings {
            template: "Role only.".into(),
            workspace_enabled: false,
            workspace_env: "/tmp/custom-harness-env".into(),
        })
        .expect("role lock");
        let off = system_prompt_with_workspace();
        assert!(off.contains("Role only."));
        assert!(!off.contains("/tmp/custom-harness-env"), "{off}");
        assert!(!off.contains(&workspace_dir_string()), "{off}");
        store_role_settings(RoleSettings {
            template: "Role only.".into(),
            workspace_enabled: true,
            workspace_env: "/tmp/custom-harness-env".into(),
        })
        .expect("role lock");
        let on = system_prompt_with_workspace();
        assert!(on.contains("/tmp/custom-harness-env"), "{on}");
        assert!(!on.contains(&workspace_dir_string()), "{on}");
        assert_eq!(
            normalize_workspace_env("  /tmp/custom-harness-env  ").expect("path"),
            "/tmp/custom-harness-env"
        );
        assert_eq!(normalize_workspace_env("").expect("empty"), "");
        assert_eq!(
            normalize_workspace_env(&workspace_dir_string()).expect("launch path"),
            ""
        );
        assert!(normalize_workspace_env("a\nb").is_err());
        assert!(normalize_role_template("ok").is_ok());
        assert!(normalize_role_template(&"x".repeat(ROLE_TEMPLATE_MAX + 1)).is_err());
    }

    #[test]
    fn history_flag_is_parsed_beside_tools() {
        let argv = ["prog", "--tools", "a.json", "--history", "/tmp/h.db"]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>();
        let cli = parse_cli(&argv).unwrap();
        assert_eq!(cli.tool_files, vec!["a.json".to_string()]);
        assert_eq!(cli.history_path.as_deref(), Some("/tmp/h.db"));
        let twice = ["prog", "--history", "a", "--history", "b"]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>();
        let error = parse_cli(&twice).unwrap_err();
        assert!(error.contains("twice"), "{error}");
        let missing = ["prog", "--history"]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>();
        assert!(parse_cli(&missing).is_err());
        let tools = parse_tool_files(&argv).unwrap();
        assert_eq!(tools, vec!["a.json".to_string()]);
    }

    #[test]
    fn model_names_are_attribute_safe() {
        for spec in crate::providers::REGISTRY {
            for model in spec.models {
                assert!(
                    is_safe_model_name(model),
                    "{model:?} is not safe inside the single-quoted data-groups attribute"
                );
            }
        }
        let json = model_groups_json(&InstalledModels {
            local: vec!["bad'name".into(), "chat:1b".into(), "has space".into()],
            extra_cloud: vec!["quote\"cloud".into(), "extra:cloud".into()],
            skipped_unsafe: 0,
        });
        assert!(json.contains("chat:1b"), "{json}");
        assert!(json.contains("extra:cloud"), "{json}");
        assert!(!json.contains("bad'name"), "{json}");
        assert!(!json.contains("has space"), "{json}");
        assert!(!json.contains("quote"), "{json}");
        assert!(
            !json.contains('\''),
            "data-groups JSON must stay free of single quotes: {json}"
        );
        let empty: serde_json::Value =
            serde_json::from_str(&model_groups_json(&InstalledModels::default())).unwrap();
        assert_eq!(empty[0]["group"], "OLLAMA");
        assert_eq!(
            empty[0]["models"].as_array().unwrap().len(),
            crate::providers::ollama::MODELS.len()
        );
        assert_eq!(empty[1]["group"], "LOCAL");
        assert!(empty[1]["models"].as_array().unwrap().is_empty());
        assert_eq!(empty[2]["group"], "GROK");
        assert_eq!(
            empty[2]["models"].as_array().unwrap().len(),
            crate::providers::xai::MODELS.len()
        );
        assert_eq!(empty[3]["group"], "REFLECTION");
        assert_eq!(
            empty[3]["models"].as_array().unwrap().len(),
            crate::providers::reflection::MODELS.len()
        );
    }

    #[test]
    fn chat_models_come_from_ollama_tags_and_embeddings_stay_out() {
        let body = r#"{
            "models": [
                {"name": "embed-small:0.6b", "capabilities": ["tools", "thinking", "embedding"]},
                {"name": "embed:4b", "capabilities": ["tools", "embedding"]},
                {"name": "chat:1b", "capabilities": ["completion", "tools", "thinking"]},
                {"name": "chat:1b", "capabilities": ["completion"]},
                {"name": "gemma4:31b-cloud", "capabilities": ["completion"]},
                {"name": "extra:cloud", "capabilities": ["completion", "tools"]},
                {"name": "tools-only:1b", "capabilities": ["tools", "thinking"]},
                {"name": "bad'name:1b", "capabilities": ["completion"]},
                {"name": "grok-4.7", "capabilities": ["completion"]},
                {"name": "needs-show:1b"}
            ]
        }"#;
        let pending = parse_tags(body.as_bytes()).expect("tags");
        assert!(
            pending
                .iter()
                .any(|model| model.name == "needs-show:1b" && model.capabilities.is_none())
        );
        let mut resolved = Vec::new();
        for model in pending {
            if model.name == "needs-show:1b" {
                resolved.push((model.name, vec!["completion".into()]));
                continue;
            }
            resolved.push((model.name, model.capabilities.unwrap_or_default()));
        }
        let installed = partition_chat_models(resolved);
        assert_eq!(
            installed.local,
            vec!["chat:1b".to_string(), "needs-show:1b".to_string()]
        );
        assert_eq!(installed.extra_cloud, vec!["extra:cloud".to_string()]);
        assert_eq!(installed.skipped_unsafe, 1);
        assert!(!installed.contains("embed:4b"));
        assert!(!installed.contains("embed-small:0.6b"));
        assert!(!installed.contains("gemma4:31b-cloud"));
    }

    #[tokio::test]
    async fn the_served_page_carries_groups_current_model_and_token() {
        let installed = InstalledModels {
            local: vec!["chat:1b".into()],
            extra_cloud: vec!["extra:cloud".into()],
            skipped_unsafe: 0,
        };
        let response = page_response(&installed);
        let csp = response
            .headers()
            .get(axum::http::header::CONTENT_SECURITY_POLICY)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        assert!(
            csp.contains("script-src 'nonce-"),
            "strict script CSP: {csp}"
        );
        assert!(
            csp.contains("connect-src 'self'"),
            "CSP limits exfiltration: {csp}"
        );
        let bytes = axum::body::to_bytes(response.into_body(), 16 * 1024 * 1024)
            .await
            .unwrap();
        let html = String::from_utf8(bytes.to_vec()).unwrap();
        // Toggle button present; its text is one of the known models
        // (the suite may switch CURRENT_MODEL between tests).
        let start = html
            .find("id=\"modelToggle\"")
            .expect("toggle button present");
        let end = html[start..].find("</button>").expect("toggle end") + start;
        let toggle_text = html[start..end]
            .split('>')
            .nth(1)
            .expect("toggle text")
            .trim();
        assert!(
            is_offered_model(toggle_text, &installed),
            "toggle shows a known model, got {toggle_text:?}"
        );
        // Groups attribute parses and carries the catalog, Grok, and the
        // injected local chat model. The list is not this machine's install.
        let start = html.find("data-groups='").expect("groups attribute") + "data-groups='".len();
        let end = html[start..].find('\'').expect("groups attribute end") + start;
        let groups: serde_json::Value = serde_json::from_str(&html[start..end]).unwrap();
        let labels: Vec<&str> = groups
            .as_array()
            .unwrap()
            .iter()
            .map(|group| group["group"].as_str().unwrap())
            .collect();
        assert_eq!(labels, vec!["OLLAMA", "LOCAL", "GROK", "REFLECTION"]);
        let names: Vec<&str> = groups
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|g| g["models"].as_array().unwrap().iter())
            .map(|m| m.as_str().unwrap())
            .collect();
        for spec in crate::providers::REGISTRY {
            for model in spec.models {
                assert!(names.contains(model), "{model} missing from selector");
            }
        }
        assert!(names.contains(&"chat:1b"));
        assert_eq!(
            names.iter().filter(|name| **name == "extra:cloud").count(),
            1
        );
        assert!(!names.contains(&"lfm2.5:8b"));
        assert!(!names.iter().any(|name| name.contains("embed")));
        assert!(
            html.contains("name=\"harness-token\" content=\""),
            "token meta present"
        );
        assert!(
            html.contains("<script nonce=\""),
            "inline script carries the CSP nonce"
        );
        assert!(
            html.contains("function vimOnKeyDown"),
            "the prompt and the other text areas share the vim handler"
        );
        assert!(html.contains("id=\"prompt\""));
        assert!(html.contains("id=\"docsBtn\""));
        assert!(html.contains("id=\"toolsBtn\""));
        assert!(html.contains("id=\"docsView\""));
        assert!(html.contains("id=\"toolsView\""));
        assert!(
            html.contains("name=\"scroll-arrow\" content=\"data:image/png;base64,"),
            "scroll arrow is inlined"
        );
        assert!(!html.contains("{SCROLL_ARROW}"));
        assert!(html.contains("id=\"deltaIcon\""));
        assert!(
            html.contains("points=\"50,10.48 90,79.76 10,79.76\""),
            "the activity mark is the equilateral triangle"
        );
        assert!(!html.contains("{DELTA_ICON}"));
        // The app script is inlined. A literal end tag inside that script
        // (for example in a generated archive) would close it early and
        // print the rest of the source into the page.
        assert_eq!(
            html.matches("</script>").count(),
            2,
            "the page should close only its two script elements"
        );
    }

    #[test]
    fn web_directory_matches_the_page_compiled_into_the_binary() {
        let (html, css, js) = read_web_page().expect("web sources");
        assert_eq!(html, TEMPLATE);
        assert_eq!(css, STYLE);
        assert_eq!(js, APP_JS);
    }

    #[test]
    fn unknown_models_are_refused() {
        assert!(is_known_model("beam:cloud"));
        assert!(is_known_model("gemma4:31b-cloud"));
        assert!(!is_known_model("lfm2.5:8b"));
        assert!(!is_known_model(""));
        assert!(!is_known_model("BEAM:CLOUD"));
        assert!(!is_known_model("beam:cloud "));
        assert!(!is_known_model("beam:cloud; rm -rf /"));
        assert!(!is_known_model("beam'cloud"));
        assert!(!is_known_model("beam\"cloud"));
        assert!(!is_safe_model_name("beam:cloud; rm -rf /"));
        assert!(!is_safe_model_name("beam'cloud"));
        assert!(!is_safe_model_name("beam\"cloud"));
        assert!(is_known_model("grok-4.7"));
        assert!(is_cloud_model("grok-4.7"));
        assert!(is_cloud_model("beam:cloud"));
        assert!(is_cloud_model("extra:cloud"));
        assert!(!is_cloud_model("chat:1b"));
        assert_eq!(crate::providers::for_model("grok-4.7").id, "xAI");
        assert_eq!(crate::providers::for_model("beam:cloud").id, "Ollama");
        let installed = InstalledModels {
            local: vec!["chat:1b".into()],
            extra_cloud: vec!["extra:cloud".into()],
            skipped_unsafe: 0,
        };
        assert!(is_offered_model("chat:1b", &installed));
        assert!(is_offered_model("extra:cloud", &installed));
        assert!(is_offered_model("beam:cloud", &installed));
        assert!(!is_offered_model("lfm2.5:8b", &installed));
        assert!(!is_offered_model("qwen3-embedding:4b", &installed));
        assert!(!is_offered_model(
            "beam'cloud",
            &InstalledModels {
                local: vec!["beam'cloud".into()],
                ..InstalledModels::default()
            }
        ));
        assert!(is_reasoning_effort("high"));
        assert!(!is_reasoning_effort("max"));
    }

    #[tokio::test]
    async fn a_stop_flag_is_armed_once_and_consumed_once() {
        let state = state().await;
        assert!(state.arm_stop_flag("run-1-1700000000000").await);
        assert!(state.take_stop_flag("run-1-1700000000000").await);
        // A second stop finds nothing left to consume.
        assert!(!state.take_stop_flag("run-1-1700000000000").await);
    }

    #[tokio::test]
    async fn a_stop_without_an_id_arms_one_next_run_slot() {
        let state = state().await;
        assert!(!state.take_stop_next().await, "nothing armed yet");
        state.arm_stop_next().await;
        assert!(state.take_stop_next().await, "the arm is consumed");
        // One slot, consumed exactly once.
        assert!(!state.take_stop_next().await);
    }

    #[tokio::test]
    async fn ids_that_cannot_be_run_ids_are_refused() {
        let state = state().await;
        for id in [
            "",
            "nonsense",
            "run-",
            "run-1",
            "run-1-",
            "run-a-b",
            "run-1-2-3",
            "task-1-1700000000000",
        ] {
            assert!(!state.arm_stop_flag(id).await, "{id} should be refused");
        }
        assert!(state.stop_flags.lock().await.is_empty());
    }

    #[tokio::test]
    async fn the_number_of_armed_flags_is_bounded() {
        let state = state().await;
        for index in 0..(MAX_STOP_FLAGS * 3) {
            assert!(
                state
                    .arm_stop_flag(&format!("run-{index}-1700000000000"))
                    .await
            );
        }
        let flags = state.stop_flags.lock().await;
        assert!(flags.len() <= MAX_STOP_FLAGS, "{} flags armed", flags.len());
    }
}
