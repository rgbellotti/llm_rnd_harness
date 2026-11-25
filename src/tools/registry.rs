//! File-based custom tools: JSON spec loading, argv expansion, execution.
//!
//! Specs load once at startup (`--tools`); each produces a [`ToolInfo`]
//! indistinguishable on the wire from the compiled-in tool.
use ollama_rs::generation::tools::ToolInfo;
use serde::Deserialize;

use crate::tools::capture::CapturedText;
use std::{
    collections::HashSet,
    path::Path,
    time::{Duration, SystemTime},
};

/// The retired askpass root tool. Nothing registers it any more
/// (`run_sudo_cmd_relay` replaced it), but the name stays reserved so a
/// custom spec cannot take it over: the model's own habit of asking for it
/// would then reach a tool the harness never reviewed.
pub(crate) const RETIRED_RUN_SUDO_CMD: &str = "run_sudo_cmd";

/// Build the wire registration for one validated file-loaded tool.
pub(crate) fn file_tool_info(
    name: &str,
    description: &str,
    parameters: &serde_json::Value,
) -> Result<ToolInfo, String> {
    serde_json::from_value(serde_json::json!({
        "type": "function",
        "function": { "name": name, "description": description, "parameters": parameters }
    }))
    .map_err(|e| format!("parameters schema rejected: {e}"))
}

/// On-disk JSON spec for one custom tool (see `examples/parse_tool.json`).
/// Loaded at startup via `cargo run -- --tools <file>...`; no recompilation.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct CustomToolFile {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) executable: String,
    pub(crate) argv: Vec<String>,
    /// Verbatim JSON Schema for the tool's parameters, registered as-is.
    pub(crate) parameters: serde_json::Value,
}

/// Metadata snapshot of a registered executable. It is not a
/// cryptographic hash, but it detects the common cross-tool attack:
/// replace the script/binary in the workspace after registration and let
/// a later approved tool call execute it. A changed inode, size, or
/// modification time is refused.
#[derive(Debug, Clone)]
struct ExecutableStamp {
    len: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
}

impl ExecutableStamp {
    fn capture(path: &Path) -> Result<Self, String> {
        let meta = std::fs::metadata(path)
            .map_err(|e| format!("executable not found or unreadable: {e}"))?;
        if !meta.is_file() {
            return Err("executable is not a regular file".to_string());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Ok(Self {
                len: meta.len(),
                modified: meta.modified().ok(),
                dev: meta.dev(),
                ino: meta.ino(),
            })
        }
        #[cfg(not(unix))]
        {
            Ok(Self {
                len: meta.len(),
                modified: meta.modified().ok(),
            })
        }
    }

    fn matches(&self, path: &Path) -> bool {
        let Ok(meta) = std::fs::metadata(path) else {
            return false;
        };
        if !meta.is_file() || meta.len() != self.len || meta.modified().ok() != self.modified {
            return false;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            meta.dev() == self.dev && meta.ino() == self.ino
        }
        #[cfg(not(unix))]
        true
    }
}

#[derive(Debug, Clone)]
pub(crate) struct CustomToolSpec {
    /// Source filename (for /config display and error messages).
    pub(crate) file: String,
    /// Where this entry came from: "file" (--tools at startup).
    /// Shown in the config tab so "is it registered?" is always answerable.
    pub(crate) origin: String,
    pub(crate) name: String,
    pub(crate) executable: String,
    pub(crate) argv: Vec<String>,
    /// Snapshot used to refuse execution if the registered executable was
    /// replaced or modified after startup.
    executable_stamp: ExecutableStamp,
    /// Pre-built registration payload — the same struct the `run_cmd`
    /// macro path produces, so custom tools are indistinguishable on the wire.
    pub(crate) info: ToolInfo,
}

pub(crate) fn valid_tool_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Extract `{placeholder}` keys from one argv entry.
pub(crate) fn argv_placeholders(entry: &str) -> Result<Vec<String>, String> {
    let mut keys = Vec::new();
    let mut rest = entry;
    while let Some(open) = rest.find('{') {
        let Some(close_rel) = rest[open..].find('}') else {
            return Err(format!("unmatched '{{' in argv entry: {entry}"));
        };
        let key = &rest[open + 1..open + close_rel];
        if key.is_empty()
            || !key
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err(format!(
                "bad placeholder '{{{key}}}' in argv entry: {entry}"
            ));
        }
        keys.push(key.to_string());
        rest = &rest[open + close_rel + 1..];
    }
    Ok(keys)
}

/// Fill an argv template from the model's JSON arguments. Entries without
/// placeholders pass through literally (flags, subcommands, …).
pub(crate) fn expand_argv(
    template: &[String],
    args: &serde_json::Value,
) -> Result<Vec<String>, String> {
    let map = args
        .as_object()
        .ok_or_else(|| "tool arguments must be a JSON object".to_string())?;
    let mut out = Vec::with_capacity(template.len());
    for entry in template {
        let mut expanded = String::with_capacity(entry.len());
        let mut rest = entry.as_str();
        loop {
            let Some(open) = rest.find('{') else {
                expanded.push_str(rest);
                break;
            };
            let close_rel = rest[open..]
                .find('}')
                .ok_or_else(|| format!("unmatched '{{' in argv entry: {entry}"))?;
            let key = &rest[open + 1..open + close_rel];
            let val = map
                .get(key)
                .ok_or_else(|| format!("missing argument '{key}' for argv entry: {entry}"))?;
            expanded.push_str(&rest[..open]);
            match val {
                serde_json::Value::String(s) => expanded.push_str(s),
                serde_json::Value::Null => {}
                _ => expanded.push_str(&val.to_string()),
            }
            rest = &rest[open + close_rel + 1..];
        }
        out.push(expanded);
    }
    Ok(out)
}

pub(crate) fn load_custom_tools(files: &[String]) -> Result<Vec<CustomToolSpec>, String> {
    let mut specs = Vec::new();
    let mut names = HashSet::new();
    for f in files {
        let text = std::fs::read_to_string(f).map_err(|e| format!("{f}: cannot read file: {e}"))?;
        let parsed: CustomToolFile =
            serde_json::from_str(&text).map_err(|e| format!("{f}: invalid JSON: {e}"))?;
        if !valid_tool_name(&parsed.name) {
            return Err(format!(
                "{f}: bad tool name {:?} (use letters, digits, '_' or '-')",
                parsed.name
            ));
        }
        if parsed.name == crate::tools::web::SEARCH
            || parsed.name == crate::tools::web::FETCH
            || parsed.name == crate::tools::pdf::READ
            || parsed.name == crate::tools::run_cmd::TOOL_NAME
            || parsed.name == RETIRED_RUN_SUDO_CMD
            || parsed.name == crate::tools::write_file::TOOL_NAME
            || parsed.name == crate::tools::ask_user::TOOL_NAME
            || parsed.name == crate::tools::view_img::TOOL_NAME
        {
            return Err(format!("{f}: tool name '{}' is reserved", parsed.name));
        }
        // Generated RAG tools are `<corpus>_search`; a custom tool with the
        // same name would be silently unreachable (and ambiguous in the
        // model-visible list).
        if crate::tools::rag::corpora()
            .iter()
            .any(|corpus| corpus.tool_name == parsed.name)
        {
            return Err(format!(
                "{f}: tool name '{}' collides with a registered RAG corpus tool",
                parsed.name
            ));
        }
        if !names.insert(parsed.name.clone()) {
            return Err(format!("{f}: duplicate tool name {:?}", parsed.name));
        }
        if parsed.description.trim().is_empty() {
            return Err(format!("{f}: description must not be empty"));
        }
        if parsed.argv.is_empty() {
            return Err(format!("{f}: argv must list at least the program"));
        }
        // Execution spawns argv[0]: it must be the validated executable or
        // validation gives false confidence about what actually runs.
        if parsed.argv[0] != parsed.executable {
            return Err(format!(
                "{f}: argv[0] {:?} must equal executable {:?}",
                parsed.argv[0], parsed.executable
            ));
        }
        let canonical = std::fs::canonicalize(&parsed.executable)
            .map_err(|e| format!("{f}: executable not found: {} ({e})", parsed.executable))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(md) = std::fs::metadata(&canonical)
                && md.permissions().mode() & 0o111 == 0
            {
                return Err(format!(
                    "{f}: not executable (chmod +x): {}",
                    parsed.executable
                ));
            }
        }
        let executable = canonical.to_string_lossy().into_owned();
        let executable_stamp =
            ExecutableStamp::capture(&canonical).map_err(|e| format!("{f}: {e}"))?;
        let mut argv = parsed.argv.clone();
        // Execution uses the exact canonical path that was validated. This
        // removes cwd/symlink ambiguity between startup and later runs.
        argv[0] = executable.clone();
        let props = parsed
            .parameters
            .get("properties")
            .and_then(|p| p.as_object())
            .ok_or_else(|| {
                format!("{f}: parameters must be an object with a 'properties' object")
            })?;
        if let Some(t) = parsed.parameters.get("type")
            && t != "object"
        {
            return Err(format!("{f}: parameters.type must be \"object\""));
        }
        let mut used_keys = std::collections::HashSet::new();
        for entry in &parsed.argv {
            for key in argv_placeholders(entry)? {
                if !props.contains_key(&key) {
                    return Err(format!(
                        "{f}: argv placeholder '{{{key}}}' has no matching parameters.properties entry"
                    ));
                }
                used_keys.insert(key);
            }
        }
        // The inverse check: a required model argument that never reaches
        // argv silently drops data (e.g. literal "input" instead of "{input}").
        if let Some(required) = parsed.parameters.get("required").and_then(|r| r.as_array()) {
            for req in required {
                if let Some(name) = req.as_str()
                    && !used_keys.contains(name)
                {
                    return Err(format!(
                        "{f}: required parameter '{name}' is never referenced by an argv placeholder"
                    ));
                }
            }
        }
        // Build the exact wire struct via JSON round-trip (no schemars import
        // needed — ToolInfo deserializes from its own serialized shape).
        let info = file_tool_info(&parsed.name, &parsed.description, &parsed.parameters)
            .map_err(|e| format!("{f}: {e}"))?;
        specs.push(CustomToolSpec {
            file: f.clone(),
            origin: "file".to_string(),
            name: parsed.name,
            executable,
            argv,
            executable_stamp,
            info,
        });
    }
    Ok(specs)
}

/// Execute an approved custom tool: expand argv, spawn, capture. Same shape
/// as `run_cmd` output; same timeout; deny-list intentionally not applied
/// (registered by the operator = trusted) but approval still gates every call.
pub(crate) async fn run_custom_tool(spec: &CustomToolSpec, argv: Vec<String>) -> CapturedText {
    const CUSTOM_TOOL_TIMEOUT: Duration = Duration::from_secs(30);
    let executable = Path::new(&spec.executable);
    if !spec.executable_stamp.matches(executable) {
        return CapturedText {
            text: format!(
                "Refusing to run custom tool '{}': its executable changed after registration ({}). \
                 Restart the harness after changing a registered tool.",
                spec.name, spec.executable
            ),
            exit_code: None,
        };
    }
    // Use the canonical path that was validated at startup, not the
    // model-visible template's argv[0].
    let captured = crate::tools::capture::run(
        executable,
        &argv[1..],
        &crate::config::WORKSPACE_DIR,
        CUSTOM_TOOL_TIMEOUT,
        crate::config::MAX_TOOL_OUTPUT_BYTES,
    )
    .await;
    if let Some(error) = captured.spawn_error {
        return CapturedText {
            text: format!(
                "Failed to launch tool '{}' ({}): {error}\nIs the executable still present and runnable?",
                spec.name, spec.executable
            ),
            exit_code: None,
        };
    }
    let exit_code = if captured.timed_out {
        None
    } else {
        captured.exit_code
    };
    let mut combined = format!("tool: {}\n", spec.name);
    if !captured.stdout.is_empty() {
        combined.push_str(&format!("stdout:\n{}\n", captured.stdout));
    }
    if !captured.stderr.is_empty() {
        combined.push_str(&format!("stderr:\n{}\n", captured.stderr));
    }
    if captured.stdout.is_empty() && captured.stderr.is_empty() {
        combined.push_str("(command produced no output)\n");
    }
    if let Some(note) = captured.timeout_note(CUSTOM_TOOL_TIMEOUT.as_secs()) {
        combined.push_str(&format!("{note}\n"));
    }
    CapturedText {
        text: crate::tools::truncate_tool_output(combined),
        exit_code,
    }
}

#[cfg(test)]
mod custom_tool_tests {
    use super::*;
    use crate::config::parse_tool_files;

    fn spec_json(name: &str) -> serde_json::Value {
        serde_json::json!({
            "name": name,
            "description": "test tool",
            "executable": "/bin/echo",
            "argv": ["/bin/echo", "{input}"],
            "parameters": {
                "type": "object",
                "properties": { "input": { "type": "string" } },
                "required": ["input"]
            }
        })
    }

    fn write_tmp(dir: &std::path::Path, name: &str, body: &str) -> String {
        let p = dir.join(name);
        std::fs::write(&p, body).unwrap();
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn loads_valid_spec_and_builds_wire_info() {
        let dir = std::env::temp_dir().join("harness_tool_test");
        std::fs::create_dir_all(&dir).unwrap();
        let f = write_tmp(&dir, "ok.json", &spec_json("parse_tool").to_string());
        let specs = load_custom_tools(&[f]).unwrap();
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].name, "parse_tool");
        let wire = serde_json::to_value(&specs[0].info).unwrap();
        assert_eq!(wire["type"], "function");
        assert_eq!(wire["function"]["name"], "parse_tool");
        assert_eq!(
            wire["function"]["parameters"]["properties"]["input"]["type"],
            "string"
        );
    }

    #[test]
    fn rejects_reserved_duplicate_and_dangling() {
        let dir = std::env::temp_dir().join("harness_tool_test");
        std::fs::create_dir_all(&dir).unwrap();
        let reserved = write_tmp(&dir, "reserved.json", &spec_json("run_cmd").to_string());
        assert!(load_custom_tools(&[reserved]).is_err());
        let pdf_reserved = write_tmp(
            &dir,
            "pdf_reserved.json",
            &spec_json(crate::tools::pdf::READ).to_string(),
        );
        assert!(load_custom_tools(&[pdf_reserved]).is_err());
        let question_reserved = write_tmp(
            &dir,
            "question_reserved.json",
            &spec_json(crate::tools::ask_user::TOOL_NAME).to_string(),
        );
        assert!(load_custom_tools(&[question_reserved]).is_err());
        // The root tool is reserved too: a custom spec with that name
        // would register a duplicate and never execute (dispatch always
        // prefers the builtin).
        let sudo_reserved = write_tmp(
            &dir,
            "sudo_reserved.json",
            &spec_json(RETIRED_RUN_SUDO_CMD).to_string(),
        );
        assert!(load_custom_tools(&[sudo_reserved]).is_err());

        let bad_argv = write_tmp(
            &dir,
            "dangling.json",
            &serde_json::json!({
                "name": "dangling",
                "description": "x",
                "executable": "/bin/echo",
                "argv": ["/bin/echo", "{missing}"],
                "parameters": { "type": "object", "properties": {} }
            })
            .to_string(),
        );
        assert!(load_custom_tools(&[bad_argv]).is_err());

        let a = write_tmp(&dir, "dup_a.json", &spec_json("dup").to_string());
        let b = write_tmp(&dir, "dup_b.json", &spec_json("dup").to_string());
        assert!(load_custom_tools(&[a, b]).is_err());

        let noexe = write_tmp(
            &dir,
            "noexe.json",
            &serde_json::json!({
                "name": "noexe",
                "description": "x",
                "executable": "/nonexistent/tool",
                "argv": ["/nonexistent/tool"],
                "parameters": { "type": "object", "properties": {} }
            })
            .to_string(),
        );
        assert!(load_custom_tools(&[noexe]).is_err());
    }

    #[test]
    fn rejects_argv_exe_mismatch_and_unused_required() {
        let dir = std::env::temp_dir().join("harness_tool_test");
        std::fs::create_dir_all(&dir).unwrap();
        // argv[0] must equal executable: what is validated is what runs.
        let mismatch = write_tmp(
            &dir,
            "mismatch.json",
            &serde_json::json!({
                "name": "mismatch",
                "description": "x",
                "executable": "/bin/echo",
                "argv": ["/bin/other", "{input}"],
                "parameters": {
                    "type": "object",
                    "properties": { "input": { "type": "string" } },
                    "required": ["input"]
                }
            })
            .to_string(),
        );
        assert!(load_custom_tools(&[mismatch]).is_err());

        // Required param never referenced by argv (e.g. literal "input").
        let unused = write_tmp(
            &dir,
            "unused.json",
            &serde_json::json!({
                "name": "unused",
                "description": "x",
                "executable": "/bin/echo",
                "argv": ["/bin/echo", "input"],
                "parameters": {
                    "type": "object",
                    "properties": { "input": { "type": "string" } },
                    "required": ["input"]
                }
            })
            .to_string(),
        );
        assert!(load_custom_tools(&[unused]).is_err());
    }

    #[test]
    fn expands_argv_templates() {
        let template = vec![
            "/bin/echo".to_string(),
            "--input".to_string(),
            "{input}".to_string(),
            "--count".to_string(),
            "{count}".to_string(),
        ];
        let args = serde_json::json!({ "input": "a b", "count": 3 });
        assert_eq!(
            expand_argv(&template, &args).unwrap(),
            vec!["/bin/echo", "--input", "a b", "--count", "3"]
        );
        let missing = serde_json::json!({ "input": "x" });
        assert!(expand_argv(&template, &missing).is_err());
    }

    #[test]
    fn parses_tool_files_cli() {
        let argv: Vec<String> = ["prog", "--tools", "a.json", "b.json"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(parse_tool_files(&argv).unwrap(), vec!["a.json", "b.json"]);
        let bare: Vec<String> = ["prog".to_string()].into();
        assert!(parse_tool_files(&bare).unwrap().is_empty());
        let direct: Vec<String> = ["prog", "--", "--tools", "a.json"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(parse_tool_files(&direct).unwrap(), vec!["a.json"]);
        let bad: Vec<String> = ["prog", "--bogus"].iter().map(|s| s.to_string()).collect();
        assert!(parse_tool_files(&bad).is_err());
    }

    #[tokio::test]
    async fn executes_script_and_captures_output() {
        let dir = std::env::temp_dir().join("harness_tool_test");
        std::fs::create_dir_all(&dir).unwrap();
        let f = write_tmp(&dir, "echo.json", &spec_json("echo_tool").to_string());
        let specs = load_custom_tools(&[f]).unwrap();
        let argv = expand_argv(&specs[0].argv, &serde_json::json!({ "input": "hello" })).unwrap();
        let out = run_custom_tool(&specs[0], argv).await;
        assert!(out.text.contains("tool: echo_tool"), "{}", out.text);
        assert!(out.text.contains("hello"), "{}", out.text);
        assert!(!out.text.contains("exit code:"), "{}", out.text);
        assert_eq!(out.exit_code, Some(0));
    }

    #[tokio::test]
    async fn refuses_to_run_a_tool_replaced_after_registration() {
        let dir = std::env::temp_dir().join("harness_tool_test");
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("replace_me.sh");
        std::fs::write(&script, "#!/bin/sh\necho original\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let spec = serde_json::json!({
            "name": "replace_me",
            "description": "test tool",
            "executable": script.to_string_lossy(),
            "argv": [script.to_string_lossy(), "{input}"],
            "parameters": {
                "type": "object",
                "properties": { "input": { "type": "string" } },
                "required": ["input"]
            }
        });
        let f = write_tmp(&dir, "replace_me.json", &spec.to_string());
        let specs = load_custom_tools(&[f]).unwrap();
        std::fs::write(&script, "#!/bin/sh\necho replaced\n").unwrap();
        // The two writes can share one timestamp. The registration check
        // compares that timestamp, so move it forward explicitly.
        let file = std::fs::File::open(&script).unwrap();
        file.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(2))
            .unwrap();
        let argv = expand_argv(&specs[0].argv, &serde_json::json!({"input": "x"})).unwrap();
        let out = run_custom_tool(&specs[0], argv).await;
        assert!(
            out.text.contains("changed after registration"),
            "{}",
            out.text
        );
        assert!(out.exit_code.is_none());
    }

    #[tokio::test]
    async fn oversized_outputs_carry_an_explicit_truncation_marker() {
        let dir = std::env::temp_dir().join("harness_tool_test");
        std::fs::create_dir_all(&dir).unwrap();
        // The oversized bytes come from the command itself: a multi-megabyte
        // argv would hit E2BIG before the tool even launches.
        let spec = serde_json::json!({
            "name": "big_tool",
            "description": "test tool",
            "executable": "/bin/sh",
            "argv": ["/bin/sh", "-c",
                "head -c 4200000 /dev/zero | tr '\\0' y"],
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        });
        let f = write_tmp(&dir, "big.json", &spec.to_string());
        let specs = load_custom_tools(&[f]).unwrap();
        let argv = expand_argv(&specs[0].argv, &serde_json::json!({})).unwrap();
        let out = run_custom_tool(&specs[0], argv).await;
        assert!(out.text.contains("[tool output truncated:"), "{}", out.text);
        assert!(!out.text.contains("exit code:"), "{}", out.text);
        assert!(
            out.text.len() < crate::config::MAX_TOOL_OUTPUT_BYTES + 512,
            "truncated result exceeds the cap: {}",
            out.text.len()
        );
    }
}
