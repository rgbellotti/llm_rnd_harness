//! `run_sudo_cmd_relay`: the model proposes one root command and the
//! person runs it themselves, then pastes the terminal output back.
//!
//! Nothing executes inside the harness, so there is no password to store,
//! wipe, or forward. This is the successor to `run_sudo_cmd`, which stayed
//! wired to an askpass password flow and is left deprecated (unregistered).

pub(crate) const TOOL_NAME: &str = "run_sudo_cmd_relay";

/// Root command relay tool. The words the model reads are in `model_voice`.
/// The tool loop never calls this body: it intercepts the name and opens a
/// single approval dialog that shows the command and collects the pasted
/// output. The body exists only so the schema macro can describe the call.
#[ollama_rs::function]
pub(crate) async fn run_sudo_cmd_relay(
    command: String,
    task: String,
) -> Result<String, Box<dyn std::error::Error + Sync + Send>> {
    let _ = (command, task);
    Ok("run_sudo_cmd_relay is a relay: the harness does not run the command.".to_string())
}

pub(crate) fn tool_info() -> ollama_rs::generation::tools::ToolInfo {
    use ollama_rs::generation::tools::ToolInfo;
    let info = ToolInfo::new::<_, run_sudo_cmd_relay>();
    let mut value = serde_json::to_value(&info).expect("run_sudo_cmd_relay schema");
    value["function"]["description"] =
        serde_json::Value::String(crate::model_voice::RUN_SUDO_RELAY_DESCRIPTION.to_string());
    let properties = value["function"]["parameters"]["properties"]
        .as_object_mut()
        .expect("run_sudo_cmd_relay parameter properties");
    for (name, description) in [
        ("command", crate::model_voice::RUN_SUDO_RELAY_COMMAND),
        ("task", crate::model_voice::RUN_SUDO_RELAY_TASK),
    ] {
        let property = properties
            .get_mut(name)
            .unwrap_or_else(|| panic!("run_sudo_cmd_relay schema missing {name}"));
        property["description"] = serde_json::Value::String(description.to_string());
    }
    serde_json::from_value(value).expect("run_sudo_cmd_relay schema with model voice")
}
