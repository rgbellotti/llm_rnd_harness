//! Local single-user LLM research and diagnostics harness (`llm_rnd_harness`).
//!
//! Module map:
//! - [`config`] — limits, CLI parsing, workspace and role settings, and
//!   the re-export surface for the split modules below.
//! - [`models`] — model identity and predicates, the Ollama model lists,
//!   and the context-window resolver.
//! - [`page`] — the single page: assets, launch token, nonce, comment
//!   key, and the page handler.
//! - [`state`] — approval types, the pending-approval map, stop flags,
//!   and `AppState`.
//! - [`diff`] — text diffs for edited commands, literal file writes, and history clips.
//! - [`keys`] — encrypted `harness-keys` file. The startup password is typed, not stored.
//! - [`harden`] — re-exec when the keys were in the starting environment, and mark the process non-dumpable.
//! - [`model_voice`] — sentences the model reads. Edit those; tests do not lock them.
//! - [`tools`] — `run_cmd`, `ask_user`, plus file custom-tool registry.
//! - [`markdown`] — model-response markdown conversion + HTML sanitizing.
//! - [`context_budget`] — the context-window line the model receives at
//!   each crossed budget mark.
//! - [`context_send`] — the provider copy of a prompt: before-review
//!   captures and stale budget blocks are withheld, HID citations kept.
//! - [`providers`] — the provider registry: one spec per chat API (models,
//!   endpoint, key, wire behaviors), the shared Chat Completions client,
//!   and the Ollama transport.
//! - [`stream`] — NDJSON protocol and the tool-calling loop.
//! - [`server`] — HTTP handlers (`/generate`, `/approve`, `/stop`, `/model`, `/config`).
mod auth;
mod config;
mod context_budget;
mod context_send;
mod decision;
mod diff;
mod harden;
mod history;
mod keys;
mod markdown;
mod memory;
mod model_voice;
mod models;
mod page;
mod providers;
mod server;
mod state;
mod stream;
mod tools;
mod update_check;

/// Cap for `/render` and `/approve` request bodies (restored-tab content and
/// reviewed page text). Generous, but no longer unbounded: unbounded bodies
/// were a local-memory DoS.
const RENDER_BODY_LIMIT_BYTES: usize = 32 * 1024 * 1024;

/// Cap for `POST /diff`. The differ itself refuses anything past 256 KiB
/// per side; this stops a larger body from being buffered first.
const DIFF_BODY_LIMIT_BYTES: usize = 1024 * 1024;

use axum::{
    Router,
    routing::{delete, get, post},
};
use std::{collections::HashMap, sync::atomic::AtomicU64};
use std::{net::SocketAddr, sync::Arc};
use tokio::sync::{Mutex, Semaphore};

use config::{CUSTOM_TOOLS, index_html, parse_cli};
use history::HistoryDb;
use ollama_rs::Ollama;
use server::{
    approve_handler, config_handler, context_window_handler, decision_handler,
    decision_model_handler, default_model_handler, diff_handler, generate_handler,
    history_delete_handler, history_event_handler, history_get_handler, history_list_handler,
    history_page_handler, history_rounds_handler, model_handler, reasoning_effort_handler,
    render_handler, role_handler, run_cmd_review_handler, stop_handler, tools_handler,
};
use tools::registry::load_custom_tools;

fn main() {
    // Before the runtime, so re-exec is not racing other threads. This also
    // puts any startup keys back into the environment for `keys::prepare`.
    if let Err(reason) = harden::startup() {
        eprintln!("{reason}");
        std::process::exit(1);
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap_or_else(|error| {
            eprintln!("could not start the runtime: {error}");
            std::process::exit(1);
        })
        .block_on(async_main());
}

async fn async_main() {
    if let Err(reason) = keys::prepare() {
        eprintln!("harness-keys: {reason}");
        std::process::exit(1);
    }
    let cli = parse_cli(&std::env::args().collect::<Vec<_>>()).unwrap_or_else(|e| {
        eprintln!("parsing arguments error: {e}");
        std::process::exit(2);
    });
    let tool_files = cli.tool_files;
    // Best-effort, non-blocking: warns when web_tool dependencies drift.
    let web_runner_for_check = std::env::var_os("WEB_TOOL_UV")
        .map(Into::into)
        .unwrap_or_else(|| std::path::PathBuf::from("uv"));
    update_check::schedule(web_runner_for_check, config::workspace_dir_string());
    let custom_tools = load_custom_tools(&tool_files).unwrap_or_else(|e| {
        eprintln!("loading custom tools error: {e}");
        std::process::exit(2);
    });
    for spec in &custom_tools {
        println!(
            "custom tool: {} <- {} ({})",
            spec.name, spec.executable, spec.file
        );
    }
    CUSTOM_TOOLS.write().await.extend(custom_tools);
    // The Python web tool is workspace code. Refuse to run it if its
    // source/lock/entrypoint changes during this harness session.
    tools::web::snapshot_integrity();

    if config::is_cloud_model(&config::current_model()) {
        println!(
            "NOTE: model {:?} is a cloud model — prompts, tool outputs, and any data a tool reads are sent off this machine. Select a LOCAL model in the model selector if that is not intended.",
            config::current_model()
        );
    }
    // One banner per provider that needs a key, straight from the
    // registry: adding a provider adds its banner here for free.
    for spec in providers::REGISTRY {
        let Some(key_env) = spec.key_env else {
            continue;
        };
        let tag = spec.group_name.to_lowercase();
        if keys::provider_key_available(key_env) {
            println!(
                "{tag}: {key_env} is set — a {} model sends prompts and tool outputs to {}",
                spec.display, spec.host
            );
        } else {
            println!(
                "{tag}: {key_env} is not set — {} models stay in the model selector and refuse to run until harness-keys or the environment provides it",
                spec.display
            );
        }
    }
    println!("workspace: {}", config::workspace_dir_string());
    let (rag_candidates, rag_skipped) = tools::rag::scan_catalog();
    for (file, reason) in &rag_skipped {
        eprintln!("rag: skipping {file}: {reason}");
    }
    if rag_candidates.is_empty() {
        println!(
            "rag: no *.rag.db corpora in workspace (drop one in and it appears on the next run)"
        );
    } else {
        println!(
            "rag: {} corpus(es) registered as tools: {}",
            rag_candidates.len(),
            rag_candidates
                .iter()
                .map(|c| format!("{} ({} chunks)", c.tool_name, c.chunks))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }

    let ollama = Ollama::default();
    let mut local_chat: Vec<String> = Vec::new();
    match config::installed_models(&ollama).await {
        Ok(installed) => {
            local_chat = installed.local.clone();
            let mut names = installed.local;
            names.extend(installed.extra_cloud);
            if names.is_empty() {
                println!(
                    "local models: Ollama listed no chat models; embedding models stay out of the selector"
                );
            } else {
                println!("local models: {}", names.join(", "));
            }
        }
        Err(err) => eprintln!("local models: {err}"),
    }
    // A first-time launch can sit on a default model that cannot run (no
    // local model pulled, or a cloud model with no key). Say so once, with
    // the two ways out — the zero-cost path first.
    {
        let model = config::current_model();
        let key_available = crate::providers::for_model(&model)
            .key_env
            .map(crate::keys::provider_key_available)
            .unwrap_or(false);
        if let Some(reason) = config::model_blocked(&model, key_available, &local_chat) {
            println!("NOTE: the selected model {model} cannot run yet — {reason}.");
            println!(
                "  zero-cost: install Ollama (https://ollama.com) and `ollama pull <chat model>`, then choose it in the page's model menu."
            );
            println!(
                "  cloud: start with --setup-keys to store a provider API key in the encrypted keys file."
            );
        }
    }
    match config::installed_decision_models(&ollama).await {
        Ok(decision) => {
            config::set_initial_decision_model(&decision);
            let mut names = decision.local;
            names.extend(decision.extra_cloud);
            if names.is_empty() {
                println!(
                    "decision models: no local decision models listed (cloud decision models remain in the decision tab)"
                );
            } else {
                println!("decision models: {}", names.join(", "));
            }
        }
        Err(err) => eprintln!("decision models: {err}"),
    }
    let db_env = std::env::var_os("HARNESS_DB_PATH");
    let xdg_data = std::env::var_os("XDG_DATA_HOME");
    let home = std::env::var_os("HOME");
    // A plain start has no history passphrase anywhere, so history (and
    // the project memory beside it) is session-only: opened in memory,
    // never touching harness.db on disk, gone at exit. An explicit
    // --history or HARNESS_DB_PATH is still honored, with the caveat.
    let startup_mode = crate::keys::startup_mode();
    let plain_session = startup_mode == crate::keys::StartupMode::PlainSession;
    let explicit_history = cli.history_path.is_some() || db_env.is_some();
    let history_location = if history::session_only_location(
        startup_mode,
        cli.history_path.as_deref(),
        db_env.as_deref(),
    ) {
        history::HistoryLocation {
            path: std::path::PathBuf::from(":memory:"),
            messages: vec![
                "history: session-only (no keys file and no HARNESS_DB_KEY) — recording to memory for this launch, nothing is saved to disk.".to_string(),
            ],
        }
    } else {
        history::locate_history(history::HistoryLocateInput {
            workspace: config::WORKSPACE_DIR.as_path(),
            cli_path: cli.history_path.as_deref(),
            env_path: db_env.as_deref(),
            xdg_data_home: xdg_data.as_deref(),
            home: home.as_deref(),
        })
        .unwrap_or_else(|error| {
            eprintln!("{error}");
            std::process::exit(1);
        })
    };
    if plain_session && explicit_history {
        println!(
            "history: the explicit database path is honored, but this session has no history passphrase — the file is encrypted under this session's random key and will not reopen on a later start."
        );
    }
    for message in &history_location.messages {
        println!("{message}");
    }
    // Live model catalogs, once per launch, best-effort: each spec that
    // declares an endpoint is fetched (the Ollama daemon's cloud list
    // needs no key; xAI and Reflection use the keys already loaded), and
    // any failure leaves that spec's built-in list in place. The fetch
    // sends no prompts.
    for spec in providers::REGISTRY {
        match providers::fetch_live_catalog(spec, &ollama.url_str()).await {
            Ok(models) => {
                providers::set_live_catalog(spec.id, models.clone());
                println!(
                    "{}: live model catalog fetched ({} models)",
                    spec.display,
                    models.len()
                );
            }
            Err(reason) => {
                println!(
                    "{}: live catalog unavailable ({reason}) — offering the built-in list",
                    spec.display
                );
            }
        }
    }
    let history_path = history_location.path.to_str().unwrap_or_else(|| {
        eprintln!(
            "history: database path {} is not text. Set HARNESS_DB_PATH to a text path.",
            history_location.path.display()
        );
        std::process::exit(1);
    });
    let history = HistoryDb::open(history_path);
    if history.recording() {
        if history_path == ":memory:" {
            println!("history: recording sessions to memory (SQLCipher), this session only");
        } else {
            println!(
                "history: recording sessions to {} (SQLCipher)",
                history_location.path.display()
            );
        }
    }
    let memory_path = memory::path_beside(history_path);
    let memory = memory::MemoryDb::open(&memory_path);
    if memory.recording() {
        if memory_path == ":memory:" {
            println!("memory: project memory is session-only (memory)");
        } else {
            println!("memory: project memory at {memory_path} (SQLCipher)");
        }
    }
    // The tool policy loads from the persisted file (when present) so the
    // last user selection survives restarts. `project_mem` is always off
    // until turned on this launch.
    let (enabled_tools, approve_calls, approve_outputs) = tools::startup_tool_policy().await;
    if let Some(path) = tools::tool_policy_path() {
        println!("tools: tool policy persists to {}", path.display());
    }
    let state = config::AppState {
        ollama,
        web_runner: std::env::var_os("WEB_TOOL_UV")
            .map(Into::into)
            .unwrap_or_else(|| "uv".into()),
        semaphore: Arc::new(Semaphore::new(1)),
        enabled_tools: Arc::new(std::sync::RwLock::new(enabled_tools)),
        approve_calls: Arc::new(std::sync::RwLock::new(approve_calls)),
        approve_outputs: Arc::new(std::sync::RwLock::new(approve_outputs)),
        pending: Arc::new(Mutex::new(HashMap::new())),
        run_counter: Arc::new(AtomicU64::new(1)),
        runs: Arc::new(Mutex::new(HashMap::new())),
        stop_flags: Arc::new(Mutex::new(HashMap::new())),
            stop_next: Arc::new(Mutex::new(None)),
        history,
        memory,
        review_run_cmd: Arc::new(std::sync::atomic::AtomicBool::new(
            config::REVIEW_RUN_CMD_DEFAULT,
        )),
        tool_policy_path: tools::tool_policy_path(),
    };

    let app = Router::new()
        .route("/", get(index_html))
        .route("/generate", post(generate_handler))
        .route(
            "/render",
            post(render_handler).layer(axum::extract::DefaultBodyLimit::max(
                RENDER_BODY_LIMIT_BYTES,
            )),
        )
        .route(
            "/approve",
            post(approve_handler).layer(axum::extract::DefaultBodyLimit::max(
                RENDER_BODY_LIMIT_BYTES,
            )),
        )
        .route(
            "/diff",
            post(diff_handler).layer(axum::extract::DefaultBodyLimit::max(DIFF_BODY_LIMIT_BYTES)),
        )
        .route("/stop", post(stop_handler))
        .route("/context-window", get(context_window_handler))
        .route("/model", post(model_handler))
        .route("/default-model", post(default_model_handler))
        .route("/reasoning-effort", post(reasoning_effort_handler))
        .route("/tools", post(tools_handler))
        .route("/test-tool", post(crate::server::test_tool_handler))
        .route("/run-cmd-review", post(run_cmd_review_handler))
        .route("/role", post(role_handler))
        .route("/decision", post(decision_handler))
        .route("/decision/model", post(decision_model_handler))
        .route("/config", get(config_handler))
        .route("/workspace", get(server::workspace_handler))
        .route("/history", get(history_list_handler))
        .route("/history/page", get(history_page_handler))
        .route("/memory", get(server::memory_get_handler))
        .route("/memory/projects", post(server::memory_create_handler))
        .route("/memory/select", post(server::memory_select_handler))
        .route("/memory/description", post(server::memory_description_handler))
        .route("/memory/delete", post(server::memory_delete_handler))
        .route("/history/events/{hid}", get(history_event_handler))
        .route("/history/{id}", get(history_get_handler))
        .route("/history/{id}/rounds", get(history_rounds_handler))
        .route("/history/{id}", delete(history_delete_handler))
        // Every route needs the launch token and a loopback Host: the
        // harness runs shell commands, so "it binds to localhost" is not
        // an authorization boundary on its own.
        .layer(axum::middleware::from_fn(auth::guard))
        .with_state(state);

    // Intentionally localhost-only: this endpoint executes shell commands.
    let addr = SocketAddr::from(([127, 0, 0, 1], config::PORT));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|error| {
            eprintln!("could not start HTTP server at http://{addr}: {error}");
            std::process::exit(1);
        });
    let launch_url = format!(
        "http://127.0.0.1:{}/?t={}",
        config::PORT,
        config::harness_token()
    );
    println!("LLM server running at {launch_url}");
    open_default_browser(&launch_url);
    println!(
        "auth: every request needs this launch token (header {}); the harness only answers to loopback hosts",
        auth::TOKEN_HEADER
    );
    install_shutdown_handler();
    axum::serve(listener, app).await.unwrap();
}

/// `xdg-open` uses the desktop's default browser. The URL is the same line
/// already printed. A failure there still leaves that line.
fn browser_open_command(url: &str) -> (&'static str, &str) {
    ("xdg-open", url)
}

fn open_default_browser(url: &str) {
    let (program, _) = browser_open_command(url);
    let url = url.to_string();
    std::thread::spawn(move || match std::process::Command::new(program).arg(&url).status() {
        Ok(status) if status.success() => {}
        Ok(status) => eprintln!("could not open the default browser ({status})"),
        Err(error) => eprintln!("could not open the default browser: {error}"),
    });
}

#[cfg(test)]
mod browser_open_tests {
    #[test]
    fn browser_open_uses_xdg_open_and_the_launch_url() {
        let (program, url) = super::browser_open_command("http://127.0.0.1:3239/?t=abc");
        assert_eq!(program, "xdg-open");
        assert_eq!(url, "http://127.0.0.1:3239/?t=abc");
    }
}

/// Stop the harness on Ctrl-C (or SIGTERM) — and take the running tool
/// processes with it. A tool process lives in its own process group, so
/// it does not receive the terminal's signal on its own.
#[cfg(unix)]
fn install_shutdown_handler() {
    tokio::spawn(async {
        let mut interrupt =
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt()) {
                Ok(stream) => stream,
                Err(_) => return,
            };
        let mut terminate =
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(stream) => stream,
                Err(_) => return,
            };
        tokio::select! {
            _ = interrupt.recv() => {}
            _ = terminate.recv() => {}
        }
        tools::capture::kill_all_groups();
        std::process::exit(130);
    });
}

#[cfg(not(unix))]
fn install_shutdown_handler() {}
