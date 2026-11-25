//! Tool implementations and the file-based custom-tool registry.
//!
//! Shell commands, user questions, and web search/fetch are compiled in.
//! Additional tools register at startup from JSON spec files (`--tools`).
pub mod ask_user;
pub mod capture;
pub mod elevation;
pub mod pdf;
pub mod project_mem;
pub mod protocol;
pub mod rag;
pub mod registry;
pub mod run_cmd;
pub mod run_sudo_relay;
pub mod view_img;
pub mod web;
pub mod write_file;

use ollama_rs::generation::tools::ToolInfo;

use self::registry::CustomToolSpec;

/// Soft cap on one tool's captured output: the tail is replaced with an
/// explicit truncation marker so both the model and the user see that and
/// where truncation happened. Applied to run_cmd, custom tools, and the
/// web-tool process stdout; prompts and model responses stay uncapped.
pub(crate) fn truncate_tool_output(out: String) -> String {
    const MAX: usize = crate::config::MAX_TOOL_OUTPUT_BYTES;
    if out.len() <= MAX {
        return out;
    }
    let mut end = MAX;
    while !out.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n…[tool output truncated: {} bytes total, showing the first {} bytes]",
        &out[..end],
        out.len(),
        end
    )
}

/// Compiled-in tools only: shell, user interaction, web retrieval, PDF
/// reading. Deterministic (no filesystem); generated RAG corpus tools and
/// file customs are appended by [`all_tools`].
pub(crate) fn builtin_tools() -> Vec<ToolInfo> {
    let mut tools = vec![
        run_cmd::tool_info(),
        run_sudo_relay::tool_info(),
        ask_user::tool_info(),
        write_file::tool_info(),
        view_img::tool_info(),
    ];
    tools.extend(web::tool_infos());
    tools.extend(pdf::tool_infos());
    tools.push(project_mem::tool_info());
    tools
}

/// The full registry for one request: builtins, file customs, one generated
/// search tool per validated RAG corpus in the workspace root.
pub(crate) async fn all_tools() -> Vec<ToolInfo> {
    let mut tools = builtin_tools();
    tools.extend(rag::tool_infos());
    tools.extend(
        super::config::CUSTOM_TOOLS
            .read()
            .await
            .iter()
            .map(|s: &CustomToolSpec| s.info.clone()),
    );
    tools
}

/// The default enable set: everything currently registered except
/// `project_mem`, which stays off until this launch's checkbox is turned on.
pub(crate) async fn default_enabled() -> std::collections::HashSet<String> {
    all_tools()
        .await
        .into_iter()
        .map(|tool| {
            serde_json::to_value(&tool).unwrap()["function"]["name"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .filter(|name| name != project_mem::TOOL_NAME)
        .collect()
}

/// The registry the model may see on the next request: `all_tools()`,
/// minus any tools disabled via /tools.
pub(crate) async fn current_tools(state: &crate::config::AppState) -> Vec<ToolInfo> {
    let enabled: std::collections::HashSet<String> = match state.enabled_tools.read() {
        Ok(guard) => guard.clone(),
        // A poisoned lock means a previous write panicked: fail open.
        Err(poisoned) => poisoned.into_inner().clone(),
    };
    all_tools()
        .await
        .into_iter()
        .filter(|tool| {
            enabled.contains(
                serde_json::to_value(tool).unwrap()["function"]["name"]
                    .as_str()
                    .unwrap(),
            )
        })
        .collect()
}

/// Enabled tools plus the two per-tool approval sets, in registration order.
#[derive(Debug)]
pub(crate) struct ToolPolicy {
    pub enabled: Vec<String>,
    pub approve_calls: Vec<String>,
    pub approve_outputs: Vec<String>,
}

fn tool_function_name(tool: &ToolInfo) -> String {
    serde_json::to_value(tool).unwrap()["function"]["name"]
        .as_str()
        .unwrap()
        .to_string()
}

async fn known_tool_names() -> Vec<String> {
    all_tools()
        .await
        .into_iter()
        .map(|tool| tool_function_name(&tool))
        .collect()
}

fn require_known(known: &[String], names: &[String]) -> Result<(), String> {
    for name in names {
        if !known.iter().any(|known_name| known_name == name) {
            return Err(format!("Unknown tool: {name}"));
        }
    }
    Ok(())
}

fn ordered(known: &[String], set: &std::collections::HashSet<String>) -> Vec<String> {
    known
        .iter()
        .filter(|name| set.contains(*name))
        .cloned()
        .collect()
}

fn read_name_set(
    lock: &std::sync::RwLock<std::collections::HashSet<String>>,
) -> Result<std::collections::HashSet<String>, String> {
    match lock.read() {
        Ok(guard) => Ok(guard.clone()),
        Err(err) => Err(format!("tool state poisoned: {err}")),
    }
}

fn write_name_set(
    lock: &std::sync::RwLock<std::collections::HashSet<String>>,
    set: std::collections::HashSet<String>,
) -> Result<(), String> {
    let mut guard = lock
        .write()
        .map_err(|err| format!("tool state poisoned: {err}"))?;
    *guard = set;
    Ok(())
}

/// Fail-open snapshot for a run that has already started. A poisoned lock
/// keeps the set a panicked writer left behind.
pub(crate) fn snapshot_name_set(
    lock: &std::sync::RwLock<std::collections::HashSet<String>>,
) -> std::collections::HashSet<String> {
    match lock.read() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    }
}

/// Set which tools load on the next run, and which of them skip approval.
///
/// Unknown names are refused wholesale. `approve_calls` is kept only for
/// enabled tools other than the always-manual two: `ask_user` is a
/// question, and `view_img` is the one tool whose result leaves the
/// machine as pixels, so its dialog always opens. `approve_outputs` is
/// kept only for those same tools when they are not in `approve_calls`.
/// Allow all for calls already skips the output review, so that flag is
/// not stored again. `None` leaves the stored set and then applies those
/// same rules, so disabling a tool clears its flags.
pub(crate) async fn set_tool_policy(
    state: &crate::config::AppState,
    enabled_names: &[String],
    approve_calls: Option<&[String]>,
    approve_outputs: Option<&[String]>,
) -> Result<ToolPolicy, String> {
    let known = known_tool_names().await;
    require_known(&known, enabled_names)?;
    if let Some(names) = approve_calls {
        require_known(&known, names)?;
    }
    if let Some(names) = approve_outputs {
        require_known(&known, names)?;
    }
    let enabled: std::collections::HashSet<String> = enabled_names.iter().cloned().collect();
    if enabled.contains(project_mem::TOOL_NAME) && state.memory.selected().await.is_none() {
        return Err("Select a project before enabling project_mem.".to_string());
    }
    let calls_in = match approve_calls {
        Some(names) => names.iter().cloned().collect(),
        None => read_name_set(&state.approve_calls)?,
    };
    let outputs_in = match approve_outputs {
        Some(names) => names.iter().cloned().collect(),
        None => read_name_set(&state.approve_outputs)?,
    };
    let manual = |name: &str| name == ask_user::TOOL_NAME || name == view_img::TOOL_NAME;
    let calls: std::collections::HashSet<String> = calls_in
        .into_iter()
        .filter(|name| enabled.contains(name) && !manual(name))
        .collect();
    let outputs: std::collections::HashSet<String> = outputs_in
        .into_iter()
        .filter(|name| {
            enabled.contains(name) && !manual(name) && !calls.contains(name)
        })
        .collect();
    write_name_set(&state.enabled_tools, enabled.clone())?;
    write_name_set(&state.approve_calls, calls.clone())?;
    write_name_set(&state.approve_outputs, outputs.clone())?;
    // Persist the user's selection so the next launch loads it. The
    // always-manual tools stay in the file as written; the startup load
    // forces them off again.
    if let Some(path) = state.tool_policy_path.clone() {
        let persisted = PersistedToolPolicy {
            enabled_tools: ordered(&known, &enabled),
            approve_calls: ordered(&known, &calls),
            approve_outputs: ordered(&known, &outputs),
        };
        let _ = tokio::task::spawn_blocking(move || save_tool_policy_file(&path, &persisted)).await;
    }
    Ok(ToolPolicy {
        enabled: ordered(&known, &enabled),
        approve_calls: ordered(&known, &calls),
        approve_outputs: ordered(&known, &outputs),
    })
}

/// Set the enabled tools. Refuses unknown names wholesale (all-or-nothing),
/// so a bad name never silently disables more than it asked. Approval flags
/// for a tool that is no longer enabled are cleared. Test-only helper:
/// production paths call [`set_tool_policy`] directly.
#[cfg(test)]
pub(crate) async fn set_enabled_tools(
    state: &crate::config::AppState,
    names: &[String],
) -> Result<Vec<String>, String> {
    Ok(set_tool_policy(state, names, None, None).await?.enabled)
}

// --- Persisted tool policy -------------------------------------------------
// The tool policy survives restarts in one small JSON file beside the
// harness-keys file, so the browser is not the keeper of tool state.
// `project_mem` is always forced off at load: it stays manual each launch.
// Unknown names (a custom tool that was not registered this launch) are
// dropped, and the approval sets keep only enabled tools.

/// The JSON the policy file stores. Missing fields load as empty lists,
/// which the loader then falls back per-field.
#[derive(serde::Serialize, serde::Deserialize)]
struct PersistedToolPolicy {
    #[serde(default)]
    enabled_tools: Vec<String>,
    #[serde(default)]
    approve_calls: Vec<String>,
    #[serde(default)]
    approve_outputs: Vec<String>,
}

/// The user's tool-policy file: `$XDG_CONFIG_HOME/harness-tools.json`, or
/// `~/.config/harness-tools.json` when XDG is unset — the same directory
/// as the harness-keys file. `None` when no config home resolves;
/// persistence then stays off.
pub(crate) fn tool_policy_path() -> Option<std::path::PathBuf> {
    let dir = std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .map(|home| std::path::PathBuf::from(home).join(".config"))
        })?;
    Some(dir.join("harness-tools.json"))
}

fn load_tool_policy_file(path: &std::path::Path) -> Option<PersistedToolPolicy> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return None,
    };
    match serde_json::from_slice::<PersistedToolPolicy>(&bytes) {
        Ok(policy) => Some(policy),
        Err(error) => {
            eprintln!(
                "tools: {} was unreadable ({error}); the default tool policy loads instead",
                path.display()
            );
            None
        }
    }
}

fn save_tool_policy_file(path: &std::path::Path, policy: &PersistedToolPolicy) {
    let text = match serde_json::to_string_pretty(policy) {
        Ok(text) => text,
        Err(error) => {
            eprintln!("tools: could not serialize the tool policy ({error})");
            return;
        }
    };
    if let Err(error) = std::fs::write(path, text) {
        eprintln!(
            "tools: could not save the tool policy to {} ({error})",
            path.display()
        );
    }
}

/// The cleaning rules `set_tool_policy` applies, without a state: drop
/// unknown names, force the always-manual tool off, and keep the
/// approval sets only for enabled tools other than the always-manual
/// two (`ask_user`, `view_img`); `approve_outputs` additionally not in
/// `approve_calls`.
fn clean_loaded_policy(
    known: &[String],
    enabled: &mut std::collections::HashSet<String>,
    calls: &mut std::collections::HashSet<String>,
    outputs: &mut std::collections::HashSet<String>,
) {
    let keep_known = |names: &mut std::collections::HashSet<String>| {
        names.retain(|name| known.iter().any(|known_name| known_name == name));
    };
    keep_known(enabled);
    keep_known(calls);
    keep_known(outputs);
    enabled.remove(project_mem::TOOL_NAME);
    let manual = |name: &str| name == ask_user::TOOL_NAME || name == view_img::TOOL_NAME;
    calls.retain(|name| enabled.contains(name) && !manual(name));
    outputs.retain(|name| {
        enabled.contains(name) && !manual(name) && !calls.contains(name)
    });
}

/// The tool policy a fresh launch starts with: the persisted file when it
/// exists, else everything registered except `project_mem`, which is
/// always off until turned on this launch.
pub(crate) async fn startup_tool_policy() -> (
    std::collections::HashSet<String>,
    std::collections::HashSet<String>,
    std::collections::HashSet<String>,
) {
    let known = known_tool_names().await;
    let mut enabled: std::collections::HashSet<String> = default_enabled().await;
    let mut calls = std::collections::HashSet::new();
    let mut outputs = std::collections::HashSet::new();
    if let Some(path) = tool_policy_path()
        && let Some(policy) = load_tool_policy_file(&path)
    {
        enabled = policy.enabled_tools.into_iter().collect();
        calls = policy.approve_calls.into_iter().collect();
        outputs = policy.approve_outputs.into_iter().collect();
        clean_loaded_policy(&known, &mut enabled, &mut calls, &mut outputs);
    }
    (enabled, calls, outputs)
}

/// The enabled set, in registration order. Test-only helper.
#[cfg(test)]
pub(crate) async fn enabled_tool_names(state: &crate::config::AppState) -> Vec<String> {
    tool_policy_lists(state).await.enabled
}

/// Enabled tools and both approval sets, in registration order.
pub(crate) async fn tool_policy_lists(state: &crate::config::AppState) -> ToolPolicy {
    let known = known_tool_names().await;
    let enabled = snapshot_name_set(&state.enabled_tools);
    let calls = snapshot_name_set(&state.approve_calls);
    let outputs = snapshot_name_set(&state.approve_outputs);
    ToolPolicy {
        enabled: ordered(&known, &enabled),
        approve_calls: ordered(&known, &calls),
        approve_outputs: ordered(&known, &outputs),
    }
}
#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn approval_sets_follow_the_enabled_tool() {
        let state = crate::config::AppState {
            ollama: ollama_rs::Ollama::default(),
            web_runner: "/bin/echo".into(),
            semaphore: std::sync::Arc::new(tokio::sync::Semaphore::new(1)),
            enabled_tools: crate::config::empty_tool_set(),
            approve_calls: crate::config::empty_tool_set(),
            approve_outputs: crate::config::empty_tool_set(),
            pending: std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
            run_counter: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(1)),
            runs: std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
            stop_next: std::sync::Arc::new(tokio::sync::Mutex::new(None)),
            stop_flags: std::sync::Arc::new(tokio::sync::Mutex::new(
                std::collections::HashMap::new(),
            )),
            history: crate::history::HistoryDb::open(":memory:"),
            memory: crate::memory::MemoryDb::open(":memory:"),
            review_run_cmd: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tool_policy_path: None,
        };
        let unknown = super::set_tool_policy(&state, &["not_a_tool".into()], None, None)
            .await
            .expect_err("unknown tool");
        assert!(unknown.contains("Unknown tool"), "{unknown}");
        let unknown_flag =
            super::set_tool_policy(&state, &["run_cmd".into()], Some(&["nope".into()]), None)
                .await
                .expect_err("unknown approval target");
        assert!(unknown_flag.contains("Unknown tool"), "{unknown_flag}");

        let policy = super::set_tool_policy(
            &state,
            &["run_cmd".into(), "ask_user".into(), "view_img".into()],
            Some(&["run_cmd".into(), "ask_user".into(), "web_fetch".into(), "view_img".into()]),
            Some(&["run_cmd".into(), "web_fetch".into(), "ask_user".into(), "view_img".into()]),
        )
        .await
        .expect("policy");
        assert_eq!(
            policy.enabled,
            vec!["run_cmd".to_string(), "ask_user".to_string(), "view_img".to_string()]
        );
        // ask_user is a question and view_img always shows its image, so
        // neither keeps approval flags even when the browser sends them.
        assert_eq!(policy.approve_calls, vec!["run_cmd".to_string()]);
        assert!(
            policy.approve_outputs.is_empty(),
            "Allow all for calls drops the stored output flag: {:?}",
            policy.approve_outputs
        );

        let outputs_only = super::set_tool_policy(
            &state,
            &["run_cmd".into(), "ask_user".into()],
            Some(&[]),
            Some(&["run_cmd".into(), "web_fetch".into(), "ask_user".into()]),
        )
        .await
        .expect("output flag while calls stay on approve");
        assert!(outputs_only.approve_calls.is_empty());
        assert_eq!(outputs_only.approve_outputs, vec!["run_cmd".to_string()]);

        let calls_again = super::set_tool_policy(
            &state,
            &["run_cmd".into(), "ask_user".into()],
            Some(&["run_cmd".into()]),
            None,
        )
        .await
        .expect("calls clear the stored output flag");
        assert_eq!(calls_again.approve_calls, vec!["run_cmd".to_string()]);
        assert!(calls_again.approve_outputs.is_empty());

        let narrowed = super::set_tool_policy(&state, &["ask_user".into()], None, None)
            .await
            .expect("intersect");
        assert_eq!(narrowed.enabled, vec!["ask_user".to_string()]);
        assert!(narrowed.approve_calls.is_empty());
        assert!(narrowed.approve_outputs.is_empty());

        let relay = super::set_tool_policy(
            &state,
            &["run_cmd".into(), "run_sudo_cmd_relay".into()],
            Some(&["run_sudo_cmd_relay".into(), "run_cmd".into()]),
            Some(&["run_sudo_cmd_relay".into()]),
        )
        .await
        .expect("relay policy");
        assert!(relay.enabled.iter().any(|name| name == "run_sudo_cmd_relay"));
        // The relay tool is a normal toggle: its approval sets follow the
        // enabled tool like any other, and Allow all for calls clears the
        // stored output flag.
        assert!(
            relay
                .approve_calls
                .iter()
                .any(|name| name == "run_sudo_cmd_relay"),
            "{:?}",
            relay.approve_calls
        );
        assert!(
            !relay
                .approve_outputs
                .iter()
                .any(|name| name == "run_sudo_cmd_relay"),
            "{:?}",
            relay.approve_outputs
        );
    }

    #[tokio::test]
    async fn run_sudo_cmd_relay_is_on_by_default_and_run_sudo_cmd_is_not_registered() {
        let state = crate::config::AppState {
            ollama: ollama_rs::Ollama::default(),
            web_runner: "/bin/echo".into(),
            semaphore: std::sync::Arc::new(tokio::sync::Semaphore::new(1)),
            enabled_tools: std::sync::Arc::new(std::sync::RwLock::new(
                super::default_enabled().await,
            )),
            approve_calls: crate::config::empty_tool_set(),
            approve_outputs: crate::config::empty_tool_set(),
            pending: std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
            run_counter: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(1)),
            runs: std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
            stop_next: std::sync::Arc::new(tokio::sync::Mutex::new(None)),
            stop_flags: std::sync::Arc::new(tokio::sync::Mutex::new(
                std::collections::HashMap::new(),
            )),
            history: crate::history::HistoryDb::open(":memory:"),
            memory: crate::memory::MemoryDb::open(":memory:"),
            review_run_cmd: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tool_policy_path: None,
        };
        let initial = super::current_tools(&state).await;
        assert!(
            initial
                .iter()
                .any(|tool| tool.function.name == super::run_sudo_relay::TOOL_NAME)
        );
        // The retired password tool is not registered at all, so it cannot
        // appear in the config view or be enabled.
        assert!(
            super::all_tools()
                .await
                .iter()
                .all(|tool| tool.function.name != "run_sudo_cmd")
        );
        let fresh = super::default_enabled().await;
        assert!(fresh.contains(super::run_sudo_relay::TOOL_NAME));
        // The relay is a normal toggle: disabling and re-enabling it works.
        let disabled = super::set_enabled_tools(&state, &["run_cmd".into()])
            .await
            .expect("disable relay");
        assert!(!disabled.iter().any(|name| name == super::run_sudo_relay::TOOL_NAME));
        let enabled = super::set_enabled_tools(
            &state,
            &[
                "run_cmd".into(),
                super::run_sudo_relay::TOOL_NAME.to_string(),
            ],
        )
        .await
        .expect("enable relay");
        assert!(enabled.iter().any(|name| name == super::run_sudo_relay::TOOL_NAME));
    }

    #[test]
    fn generalized_harness_registers_builtin_tools() {
        let names: Vec<String> = super::builtin_tools()
            .iter()
            .map(|tool| {
                serde_json::to_value(tool).unwrap()["function"]["name"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(
            names,
            [
                "run_cmd",
                "run_sudo_cmd_relay",
                "ask_user",
                "write_file",
                "view_img",
                "web_search",
                "web_fetch",
                "read_pdf",
                "project_mem"
            ]
        );
    }

    #[test]
    fn long_outputs_are_truncated_at_a_marker_not_silently() {
        let under = "x".repeat(crate::config::MAX_TOOL_OUTPUT_BYTES);
        assert_eq!(super::truncate_tool_output(under.clone()), under);
        let multibyte = "é".repeat(3_000_000); // half-boundary boundary cases
        let truncated = super::truncate_tool_output(multibyte);
        assert!(truncated.contains("[tool output truncated:"), "{truncated}");
        assert!(truncated.len() < 3_000_000 * 2 + 200);
        // The truncation marker always carries the full original size.
        assert!(truncated.contains(&format!("{} bytes total", 3_000_000 * 2)));
    }

    fn test_state() -> crate::config::AppState {
        crate::config::AppState {
            ollama: ollama_rs::Ollama::default(),
            web_runner: "/bin/echo".into(),
            semaphore: std::sync::Arc::new(tokio::sync::Semaphore::new(1)),
            enabled_tools: crate::config::empty_tool_set(),
            approve_calls: crate::config::empty_tool_set(),
            approve_outputs: crate::config::empty_tool_set(),
            pending: std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
            run_counter: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(1)),
            runs: std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
            stop_next: std::sync::Arc::new(tokio::sync::Mutex::new(None)),
            stop_flags: std::sync::Arc::new(tokio::sync::Mutex::new(
                std::collections::HashMap::new(),
            )),
            history: crate::history::HistoryDb::open(":memory:"),
            memory: crate::memory::MemoryDb::open(":memory:"),
            review_run_cmd: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            tool_policy_path: None,
        }
    }

    fn temp_policy_file(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "harness-tools-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("tools.json")
    }

    #[test]
    fn clean_loaded_policy_forces_the_manual_tool_off_and_keeps_known_ones() {
        let known = vec![
            "run_cmd".to_string(),
            "run_sudo_cmd_relay".to_string(),
            "project_mem".to_string(),
            "ask_user".to_string(),
            "view_img".to_string(),
            "read_pdf".to_string(),
        ];
        let mut enabled = [
            "run_cmd".to_string(),
            "run_sudo_cmd".to_string(),
            "run_sudo_cmd_relay".to_string(),
            "project_mem".to_string(),
            "view_img".to_string(),
            "read_pdf".to_string(),
            "vanished_tool".to_string(),
        ]
        .into_iter()
        .collect();
        let mut calls = ["run_cmd".to_string(), "ask_user".to_string()]
            .into_iter()
            .collect();
        let mut outputs = [
            "run_cmd".to_string(),
            "read_pdf".to_string(),
            "view_img".to_string(),
            "ask_user".to_string(),
        ]
        .into_iter()
        .collect();
        super::clean_loaded_policy(&known, &mut enabled, &mut calls, &mut outputs);
        assert!(enabled.contains("run_cmd"));
        assert!(enabled.contains("view_img"));
        // The relay is a normal tool and stays enabled.
        assert!(enabled.contains("run_sudo_cmd_relay"));
        // The deprecated password tool is dropped as unknown, like a custom
        // tool that was not registered this launch.
        assert!(!enabled.contains("run_sudo_cmd"));
        assert!(!enabled.contains("project_mem"));
        assert!(!enabled.contains("vanished_tool"));
        assert!(calls.contains("run_cmd"));
        assert!(!calls.contains("ask_user"));
        assert!(outputs.contains("read_pdf"));
        // view_img is always manual: a stale flag from an older policy
        // file cannot put it on Allow all.
        assert!(!outputs.contains("view_img"));
        assert!(!outputs.contains("run_cmd"), "allow-all calls clear outputs");
    }

    #[test]
    fn the_policy_file_round_trips_and_a_corrupt_file_loads_nothing() {
        let path = temp_policy_file("roundtrip");
        let policy = super::PersistedToolPolicy {
            enabled_tools: vec!["run_cmd".into(), "view_img".into()],
            approve_calls: vec!["run_cmd".into()],
            approve_outputs: vec!["read_pdf".into()],
        };
        super::save_tool_policy_file(&path, &policy);
        let loaded = super::load_tool_policy_file(&path).expect("readable");
        assert_eq!(loaded.enabled_tools, policy.enabled_tools);
        assert_eq!(loaded.approve_calls, policy.approve_calls);
        assert_eq!(loaded.approve_outputs, policy.approve_outputs);
        std::fs::write(&path, b"not json").unwrap();
        assert!(super::load_tool_policy_file(&path).is_none());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[tokio::test]
    async fn a_policy_change_is_persisted_when_a_path_is_set() {
        let path = temp_policy_file("persist");
        let mut state = test_state();
        state.tool_policy_path = Some(path.clone());
        super::set_tool_policy(
            &state,
            &["run_cmd".into(), "view_img".into()],
            Some(&["run_cmd".into()]),
            None,
        )
        .await
        .expect("policy");
        let loaded = super::load_tool_policy_file(&path).expect("saved file");
        assert_eq!(
            loaded.enabled_tools,
            vec!["run_cmd".to_string(), "view_img".to_string()]
        );
        assert_eq!(loaded.approve_calls, vec!["run_cmd".to_string()]);
        assert!(loaded.approve_outputs.is_empty());
        // A normal tool can be turned on this launch and the file records
        // it; only `project_mem` is forced off again at the next load.
        super::set_tool_policy(
            &state,
            &[
                "run_cmd".into(),
                super::run_sudo_relay::TOOL_NAME.to_string(),
            ],
            None,
            None,
        )
        .await
        .expect("relay policy");
        let again = super::load_tool_policy_file(&path).expect("second save");
        assert!(again.enabled_tools.contains(&super::run_sudo_relay::TOOL_NAME.to_string()));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
