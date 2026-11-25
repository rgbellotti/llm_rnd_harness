//! Detect standalone textual call envelopes for a bounded protocol retry.
//! Detection never turns response text into executable tool calls.
use ollama_rs::generation::tools::ToolInfo;
use serde_json::Value;

pub(crate) use crate::model_voice::PROTOCOL_CORRECTION as CORRECTION;

/// Only complete, standalone call envelopes for registered tools qualify.
/// Prose, partial JSON, raw arguments, and unknown tool names do not.
pub(crate) fn textual_tool_call(content: &str, tools: &[ToolInfo]) -> bool {
    let mut source = content.trim();
    if source.starts_with("```") {
        let Some((tag, body)) = source.split_once('\n') else {
            return false;
        };
        if !matches!(tag.trim(), "```" | "```json") {
            return false;
        }
        let Some(body) = body.trim_end().strip_suffix("```") else {
            return false;
        };
        source = body.trim();
    } else if let Some(body) = source.strip_prefix("<tool_call>") {
        let Some(body) = body.strip_suffix("</tool_call>") else {
            return false;
        };
        source = body.trim();
    }
    let Ok(value) = serde_json::from_str::<Value>(source) else {
        return false;
    };
    let calls = if let Some(object) = value.as_object() {
        if object.len() == 1 && object.contains_key("tool_calls") {
            let Some(calls) = object["tool_calls"].as_array() else {
                return false;
            };
            calls.clone()
        } else {
            vec![value]
        }
    } else if let Some(calls) = value.as_array() {
        calls.clone()
    } else {
        return false;
    };
    !calls.is_empty()
        && calls.iter().all(|call| {
            let Some(object) = call.as_object() else {
                return false;
            };
            let function = if let Some(function) = object.get("function") {
                if object
                    .keys()
                    .any(|key| !matches!(key.as_str(), "function" | "type" | "id" | "index"))
                {
                    return false;
                }
                function
            } else {
                call
            };
            let Some(function) = function.as_object() else {
                return false;
            };
            if function
                .keys()
                .any(|key| !matches!(key.as_str(), "name" | "arguments" | "parameters" | "index"))
            {
                return false;
            }
            let Some(name) = function.get("name").and_then(Value::as_str) else {
                return false;
            };
            let Some(arguments) = function
                .get("arguments")
                .or_else(|| function.get("parameters"))
            else {
                return false;
            };
            let valid_arguments = arguments.is_object()
                || arguments
                    .as_str()
                    .and_then(|s| serde_json::from_str::<Value>(s).ok())
                    .is_some_and(|v| v.is_object());
            valid_arguments && tools.iter().any(|tool| tool.function.name == name)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_only_standalone_registered_call_envelopes() {
        let tools = crate::tools::builtin_tools();
        for content in [
            r#"{"name":"ask_user","arguments":{"questions":[]}}"#,
            r#"{"function":{"name":"ask_user","arguments":{}}}"#,
            r#"{"tool_calls":[{"function":{"name":"run_cmd","arguments":{"command":"pwd"}}}]}"#,
            "```json\n{\"name\":\"ask_user\",\"parameters\":{}}\n```",
            "<tool_call>{\"name\":\"ask_user\",\"arguments\":\"{}\"}</tool_call>",
        ] {
            assert!(textual_tool_call(content, &tools), "{content}");
        }
        for content in [
            "Example: {\"name\":\"ask_user\",\"arguments\":{}}",
            r#"{"name":"unknown","arguments":{}}"#,
            r#"{"name":"ask_user","arguments":null}"#,
            r#"{"questions":[],"kind":"question","title":"Plan"}"#,
            r#"{"name":"ask_user","arguments":{},"explanation":"an example"}"#,
            r#"{"name":"ask_user","arguments":{"question":"incomplete"}"#,
            "```json\n{\"name\":\"ask_user\",\"arguments\":{}}\n```\nThis is an example.",
            "[]",
            "Here is your answer.",
        ] {
            assert!(!textual_tool_call(content, &tools), "{content}");
        }
    }
}
