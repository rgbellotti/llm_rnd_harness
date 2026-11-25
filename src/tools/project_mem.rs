//! `project_mem` — read and write the selected project's memory.
//!
//! The project is chosen in the memory tab, not by a tool argument, so a
//! call cannot switch projects. Writes return a short acknowledgement.
//! The full arguments stay in the history transcript. A continued session
//! does not replay those actions; the next session inserts the updated
//! hot block once, beside the system prompt.

use serde_json::Value;

use crate::memory::{MemoryAction, MemoryDb};

pub(crate) const TOOL_NAME: &str = "project_mem";

pub(crate) fn tool_info() -> ollama_rs::generation::tools::ToolInfo {
    let schema = serde_json::json!({
        "type": "function",
        "function": {
            "name": TOOL_NAME,
            "description": crate::model_voice::PROJECT_MEM_DESCRIPTION,
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["recall", "set_hot", "warm_put", "note_put"],
                        "description": "recall reads the selected project. set_hot replaces the short awareness text. warm_put sets or deletes one warm key. note_put sets or deletes one cold note."
                    },
                    "key": {
                        "type": "string",
                        "description": "warm_put: short thought name. note_put: note title. Not used by recall or set_hot."
                    },
                    "body": {
                        "type": "string",
                        "description": "The text to store. An empty body deletes that warm key or cold note, or clears hot memory."
                    },
                    "tags": {
                        "type": "string",
                        "description": "note_put only. Short comma-separated tags. Optional."
                    },
                    "query": {
                        "type": "string",
                        "description": "recall only. Case-insensitive substring filter over warm keys/values and cold titles/bodies/tags. Omit to read the current set."
                    }
                },
                "required": ["action"],
                "additionalProperties": false
            }
        }
    });
    serde_json::from_value(schema).expect("project_mem schema")
}

pub(crate) async fn execute(memory: &MemoryDb, args: &Value) -> String {
    match parse(args) {
        Ok(action) => match memory.apply(action).await {
            Ok(text) => text,
            Err(error) => format!("project_mem: {error}"),
        },
        Err(error) => format!("project_mem: {error}"),
    }
}

fn parse(args: &Value) -> Result<MemoryAction, String> {
    let action = args
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let key = string_field(args, "key");
    let body = string_field(args, "body");
    let tags = string_field(args, "tags");
    let query = string_field(args, "query");
    match action {
        "recall" => Ok(MemoryAction::Recall {
            query: if query.is_empty() { None } else { Some(query) },
        }),
        "set_hot" => Ok(MemoryAction::SetHot { body }),
        "warm_put" => {
            if key.is_empty() {
                return Err("warm_put requires key.".to_string());
            }
            Ok(MemoryAction::WarmPut { key, body })
        }
        "note_put" => {
            if key.is_empty() {
                return Err("note_put requires key.".to_string());
            }
            Ok(MemoryAction::NotePut { key, body, tags })
        }
        "" => Err("action is required. Use recall, set_hot, warm_put, or note_put.".to_string()),
        other => Err(format!(
            "Unknown action \"{other}\". Use recall, set_hot, warm_put, or note_put."
        )),
    }
}

fn string_field(args: &Value, name: &str) -> String {
    args.get(name)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_actions_are_refused_before_any_write() {
        let error = parse(&serde_json::json!({"action": "drop_table"})).unwrap_err();
        assert!(error.contains("Unknown action"), "{error}");
        assert!(parse(&serde_json::json!({"action": "warm_put"})).is_err());
    }

    #[tokio::test]
    async fn a_call_uses_the_selected_project_only() {
        let memory = MemoryDb::open(":memory:");
        memory
            .create_project("image editor", "terminal editor")
            .await
            .unwrap();
        memory.select(Some("image editor")).await.unwrap();
        let saved = execute(
            &memory,
            &serde_json::json!({
                "action": "warm_put",
                "key": "filters",
                "body": "filters are modules"
            }),
        )
        .await;
        assert!(saved.contains("saved warm key"), "{saved}");
        let read = execute(
            &memory,
            &serde_json::json!({"action": "recall", "query": "filters"}),
        )
        .await;
        assert!(read.contains("filters: filters are modules"), "{read}");
    }
}
