//! The single compiled-in tool: model-controlled shell execution behind the
//! human-in-the-loop approval gate. Everything else registers from files.
use std::path::Path;
use std::time::Instant;

use crate::tools::capture::CapturedText;

// -------------------------------------------------------
// Tool – the macro turns this into a unit struct that implements Tool
// (`pub(crate)` so the struct is visible to [`crate::stream`]).
// -------------------------------------------------------

/// The registered shell-tool name. Dispatch, the registry's reserved
/// list, and the rewrite checks agree through this constant; the macro
/// below derives the same name from the fn it documents.
pub(crate) const TOOL_NAME: &str = "run_cmd";

/// Shell command tool. The words the model reads are in `model_voice`.
#[ollama_rs::function]
pub(crate) async fn run_cmd(
    command: String,
    task: String,
    timeout: Option<String>,
) -> Result<String, Box<dyn std::error::Error + Sync + Send>> {
    // The phrase and the limit are for the person approving the call.
    let _ = task;
    Ok(capture_approved(command, timeout).await.text)
}

/// How long a single shell command may run when the call does not ask for longer.
const TOOL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Budget for a compile, download, install, or similar long command.
pub(crate) const LONG_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20 * 60);

/// Missing `timeout` deserializes as an error on the generated params
/// struct. The schema marks it optional, so fill null before parsing and
/// treat that as no time limit.
pub(crate) fn normalize_run_cmd_args(args: &mut serde_json::Value) {
    if let Some(map) = args.as_object_mut()
        && !map.contains_key("timeout")
    {
        map.insert("timeout".to_string(), serde_json::Value::Null);
    }
}

/// Resolve the model-supplied limit. `Ok(None)` means no time limit.
/// An unrecognized value does not run the command.
pub(crate) fn command_timeout(raw: Option<&str>) -> Result<Option<std::time::Duration>, String> {
    let text = raw.unwrap_or("").trim().to_ascii_lowercase();
    match text.as_str() {
        "" | "none" | "default" => Ok(None),
        "30s" => Ok(Some(TOOL_TIMEOUT)),
        "20m" => Ok(Some(LONG_TIMEOUT)),
        other => Err(crate::model_voice::unrecognized_timeout(other)),
    }
}

/// Run one approved command and keep its exit status beside the text.
/// An unrecognized `timeout` is returned as text and the shell is not started.
pub(crate) async fn capture_approved(command: String, timeout: Option<String>) -> CapturedText {
    match command_timeout(timeout.as_deref()) {
        Ok(limit) => execute(command, limit).await,
        Err(message) => CapturedText {
            text: message,
            exit_code: None,
        },
    }
}

/// Run one approved shell command: bounded capture, formatted transcript.
/// The timeout is a parameter so tests do not have to wait for the
/// production value.
///
/// The formatted text is what the model sees. The process status stays
/// on [`CapturedText::exit_code`] so a history view can show it without
/// putting it into the next prompt. A spawn failure or a timeout has no
/// exit code; the text itself is the explanation.
///
/// There is no deny-list here any more: a substring filter caught
/// accidents but was trivially bypassed (`rm -fr`, `rm --recursive
/// --force`, `find … -delete`), so it gave false confidence. The
/// human-in-the-loop gate is the control — nothing runs that you have
/// not read and approved.
async fn execute(command: String, timeout: Option<std::time::Duration>) -> CapturedText {
    if let Some(token) = crate::tools::elevation::elevation_token(&command) {
        return CapturedText {
            text: crate::model_voice::run_cmd_elevation_blocked(token),
            exit_code: None,
        };
    }
    // Async spawn + timeout so one `sleep 60` can't hang the Tokio
    // executor or the NDJSON stream forever. The capture is bounded at
    // the source (see `tools::capture`): output past the cap is cut
    // while the command runs and the process group is killed, so a
    // runaway `yes` cannot grow the capture without limit.

    let start = Instant::now();
    let captured = crate::tools::capture::run_for(
        Path::new("bash"),
        &["-c".to_string(), command],
        &crate::config::WORKSPACE_DIR,
        timeout,
        crate::config::MAX_TOOL_OUTPUT_BYTES,
    )
    .await;
    let elapsed_ms = start.elapsed().as_millis() as u64;

    if let Some(error) = captured.spawn_error {
        return CapturedText {
            text: format!("Failed to run command: {error} ({elapsed_ms} ms)"),
            exit_code: None,
        };
    }
    if captured.timed_out {
        let limit = match timeout {
            Some(limit) if limit == LONG_TIMEOUT => "20m".to_string(),
            Some(limit) if limit.as_secs() >= 1 && limit.subsec_nanos() == 0 => {
                format!("{}s", limit.as_secs())
            }
            Some(limit) => format!("{}ms", limit.as_millis()),
            None => "none".to_string(),
        };
        return CapturedText {
            text: crate::model_voice::tool_timed_out(&limit, elapsed_ms),
            exit_code: None,
        };
    }

    let exit_code = captured.exit_code;
    let stdout = captured.stdout;
    let stderr = captured.stderr;
    let mut combined = String::new();
    if !stdout.is_empty() {
        combined.push_str(&format!("stdout:\n{stdout}\n"));
    }
    if !stderr.is_empty() {
        combined.push_str(&format!("stderr:\n{stderr}\n"));
    }
    if combined.is_empty() {
        combined = "(command produced no output)".to_string();
    }

    CapturedText {
        text: crate::tools::truncate_tool_output(combined),
        exit_code,
    }
}

/// Schema the model sees. The function macro needs a doc comment, so the
/// sentences are written over that comment from [`crate::model_voice`].
pub(crate) fn tool_info() -> ollama_rs::generation::tools::ToolInfo {
    use ollama_rs::generation::tools::ToolInfo;
    let info = ToolInfo::new::<_, run_cmd>();
    let mut value = serde_json::to_value(&info).expect("run_cmd schema");
    value["function"]["description"] =
        serde_json::Value::String(crate::model_voice::RUN_CMD_DESCRIPTION.to_string());
    let properties = value["function"]["parameters"]["properties"]
        .as_object_mut()
        .expect("run_cmd parameter properties");
    for (name, description) in [
        ("command", crate::model_voice::RUN_CMD_COMMAND),
        ("task", crate::model_voice::RUN_CMD_TASK),
        ("timeout", crate::model_voice::RUN_CMD_TIMEOUT),
    ] {
        let property = properties
            .get_mut(name)
            .unwrap_or_else(|| panic!("run_cmd schema missing {name}"));
        property["description"] = serde_json::Value::String(description.to_string());
    }
    serde_json::from_value(value).expect("run_cmd schema with model voice")
}

#[cfg(test)]
mod run_cmd_tests {
    use super::*;
    use ollama_rs::generation::tools::Tool;

    /// Call the tool the way the tool loop does: through its `Tool`
    /// implementation with JSON-decoded parameters.
    async fn call(command: &str) -> String {
        let mut tool = run_cmd;
        let mut args = serde_json::json!({
            "command": command,
            "task": "checking the harness"
        });
        normalize_run_cmd_args(&mut args);
        let params: <run_cmd as Tool>::Params = serde_json::from_value(args).unwrap();
        tool.call(params).await.unwrap()
    }

    #[test]
    fn task_is_a_required_string_on_the_tool_schema() {
        let info = tool_info();
        let value = serde_json::to_value(&info).unwrap();
        let params = &value["function"]["parameters"];
        assert_eq!(params["properties"]["command"]["type"], "string");
        assert_eq!(params["properties"]["task"]["type"], "string");
        // Identity with the voice constants: editing those sentences does not
        // fail this test. Required fields and types stay here.
        assert_eq!(
            value["function"]["description"],
            crate::model_voice::RUN_CMD_DESCRIPTION
        );
        assert_eq!(
            params["properties"]["command"]["description"],
            crate::model_voice::RUN_CMD_COMMAND
        );
        assert_eq!(
            params["properties"]["task"]["description"],
            crate::model_voice::RUN_CMD_TASK
        );
        assert_eq!(
            params["properties"]["timeout"]["description"],
            crate::model_voice::RUN_CMD_TIMEOUT
        );
        let required = params["required"].as_array().expect("required");
        assert!(required.iter().any(|item| item == "command"));
        assert!(required.iter().any(|item| item == "task"));
        assert!(!required.iter().any(|item| item == "timeout"));
        let missing = serde_json::from_value::<<run_cmd as Tool>::Params>(
            serde_json::json!({ "command": "printf hi" }),
        );
        assert!(missing.is_err());
        let mut omitted = serde_json::json!({
            "command": "printf hi",
            "task": "checking the harness"
        });
        normalize_run_cmd_args(&mut omitted);
        let parsed = serde_json::from_value::<<run_cmd as Tool>::Params>(omitted);
        assert!(parsed.is_ok());
    }

    #[test]
    fn timeout_values_are_none_30s_or_20m() {
        assert_eq!(command_timeout(None).unwrap(), None);
        assert_eq!(command_timeout(Some("")).unwrap(), None);
        assert_eq!(command_timeout(Some("default")).unwrap(), None);
        assert_eq!(command_timeout(Some("none")).unwrap(), None);
        assert_eq!(command_timeout(Some("30s")).unwrap(), Some(TOOL_TIMEOUT));
        assert_eq!(command_timeout(Some(" 20M ")).unwrap(), Some(LONG_TIMEOUT));
        assert!(command_timeout(Some("turbo")).is_err());
    }

    #[tokio::test]
    async fn the_task_phrase_is_not_passed_to_the_shell() {
        let out = call("printf hello").await;
        assert!(out.contains("stdout:\nhello"), "{out}");
        assert!(!out.contains("checking the harness"), "{out}");
    }

    #[tokio::test]
    async fn runs_a_command_and_reports_its_output() {
        let out = call("printf hello").await;
        assert!(out.contains("stdout:\nhello"), "{out}");
        assert!(!out.contains("exit code:"), "{out}");
        let captured = capture_approved("printf hello".to_string(), None).await;
        assert_eq!(captured.exit_code, Some(0));
        assert!(!captured.text.contains("exit code:"), "{}", captured.text);
    }

    #[tokio::test]
    async fn reports_stderr_and_a_failing_exit_code() {
        let captured = execute("printf oops >&2; exit 3".to_string(), Some(TOOL_TIMEOUT)).await;
        assert!(captured.text.contains("stderr:\noops"), "{}", captured.text);
        assert!(!captured.text.contains("exit code:"), "{}", captured.text);
        assert_eq!(captured.exit_code, Some(3));
    }

    #[tokio::test]
    async fn an_empty_failure_keeps_the_code_off_the_model_text() {
        let captured = execute("exit 3".to_string(), Some(TOOL_TIMEOUT)).await;
        assert_eq!(captured.text, "(command produced no output)");
        assert_eq!(captured.exit_code, Some(3));
    }

    #[tokio::test]
    async fn no_deny_list_silently_blocks_commands() {
        // There is no deny-list any more: the approval gate is the
        // control. A dangerous command reaches the shell as written.
        let out = call("printf 'rm -rf /'").await;
        assert!(out.contains("rm -rf /"), "{out}");
        assert!(!out.contains("Blocked"), "{out}");
    }

    #[tokio::test]
    async fn a_command_over_the_cap_is_cut_with_an_explicit_marker() {
        // The capture is bounded while the command runs: the output is
        // cut at the cap and the marker says where it stopped.
        let out = call("yes y").await;
        assert!(
            out.contains(crate::tools::capture::TRUNCATED_MARKER),
            "{out}"
        );
        assert!(
            out.len() < crate::config::MAX_TOOL_OUTPUT_BYTES + 512,
            "capture exceeded the cap: {}",
            out.len()
        );
    }

    #[tokio::test]
    async fn a_hanging_command_times_out_instead_of_blocking_the_run() {
        // Short timeout so the suite does not wait out the production one.
        // sleep 30 would exit 0 if the limit did not stop it.
        let started = std::time::Instant::now();
        let out = execute(
            "sleep 30".to_string(),
            Some(std::time::Duration::from_millis(300)),
        )
        .await;
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "the 300ms limit did not stop the command"
        );
        assert!(out.exit_code.is_none());
        assert!(!out.text.is_empty());
    }

    #[tokio::test]
    async fn an_unrecognized_timeout_does_not_run_the_command() {
        let mut tool = run_cmd;
        let params: <run_cmd as Tool>::Params = serde_json::from_value(serde_json::json!({
            "command": "printf hello",
            "task": "checking the harness",
            "timeout": "turbo"
        }))
        .unwrap();
        let out = tool.call(params).await.unwrap();
        assert!(!out.contains("hello"), "{out}");
    }

    #[tokio::test]
    async fn no_timeout_lets_a_short_command_finish() {
        let out = execute("sleep 0.4; printf done".to_string(), None).await;
        assert!(out.text.contains("done"), "{}", out.text);
        assert!(!out.text.contains("timed out"), "{}", out.text);
        assert_eq!(out.exit_code, Some(0));
    }
}
