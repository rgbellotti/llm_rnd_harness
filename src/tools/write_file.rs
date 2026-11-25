//! `write_file` — create, overwrite, or edit one file, with a reviewed
//! preview of exactly what will be written.
//!
//! This is the model's code-writing tool. `run_cmd` stays for utility
//! work; a file written through this tool carries its path and its
//! content as structured arguments, so the approval dialog can show the
//! real before/after — syntax-highlighted content for a new file, a
//! red/green line diff for an edit — without ever parsing shell text.
//!
//! Modes:
//! - `write` — `content` is the complete new file (create or replace).
//! - `edit` — `edits` are ordered search/replace pairs applied to the
//!   existing file's text. Each `search` must match exactly once; a
//!   failed pair refuses the call before any dialog, so the model can
//!   correct it.
//!
//! The preview is computed at parse time from the file's current bytes;
//! the write is atomic (temp file + rename) and re-checked at execute:
//! if the file changed after the preview was built, nothing is written.
//! The tool's result text is harness-generated and goes to the model
//! without a second review.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::diff::{FileDiffView, TextDiffView, diff_text};

pub(crate) const TOOL_NAME: &str = "write_file";

/// Content and per-file bytes accepted by the tool. The preview diff
/// caps well below this (see `diff.rs`); this is the write-side bound.
const MAX_CONTENT_BYTES: usize = 1024 * 1024;

/// A read of an existing file accepted for preview/editing.
const MAX_BEFORE_BYTES: usize = 2 * 1024 * 1024;

const MAX_PATH_BYTES: usize = 1024;

/// One search/replace pair for `edit` mode.
pub(crate) struct EditPair {
    pub search: String,
    pub replace: String,
}

#[derive(Debug)]
pub(crate) struct WriteFileRequest {
    /// The path as the model wrote it (shown in the dialog).
    pub display_path: String,
    /// Where it resolves (also shown: `../` routing is allowed, so the
    /// dialog must say where the bytes land).
    pub resolved: PathBuf,
    /// `write` or `edit`.
    pub mode: &'static str,
    /// The file's text as it stands now. `None` when it does not exist
    /// (or is not text, in `write` mode).
    pub before: Option<String>,
    /// The complete file text after this call.
    pub after: String,
    /// `edit` mode only: the number of pairs applied.
    pub replacements: usize,
}

pub(crate) struct WriteOutcome {
    pub text: String,
    pub ok: bool,
}

impl WriteFileRequest {
    pub fn parse(args: &Value) -> Result<Self, String> {
        let path = args
            .get("path")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        validate_path(&path)?;
        let resolved = resolve_path(&path);

        let mode = args
            .get("mode")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let mode = match mode.as_str() {
            "write" => "write",
            "edit" => "edit",
            // Tolerate a missing mode: content means write, edits mean edit.
            "" => {
                if args.get("edits").is_some_and(|e| e.as_array().is_some_and(|a| !a.is_empty())) {
                    "edit"
                } else {
                    "write"
                }
            }
            other => return Err(format!("mode {other:?} is not \"write\" or \"edit\"")),
        };

        let before = read_existing(&resolved)?;

        if mode == "write" {
            let content = args
                .get("content")
                .and_then(|value| value.as_str())
                .ok_or_else(|| "content is required in write mode".to_string())?;
            if content.len() > MAX_CONTENT_BYTES {
                return Err(format!(
                    "content is {} bytes, above the {MAX_CONTENT_BYTES} byte limit for write_file",
                    content.len()
                ));
            }
            if before.is_some() && before.as_deref().is_some_and(|text| !text.is_empty()) {
                // Replacing an existing file is the point of write mode;
                // the diff shows what changes.
            }
            return Ok(WriteFileRequest {
                display_path: path,
                resolved,
                mode,
                before,
                after: content.to_string(),
                replacements: 0,
            });
        }

        // edit mode: apply ordered search/replace pairs to the existing
        // text. Each search must match exactly once (the modern edit-tool
        // convention): zero or several matches refuse the call before any
        // dialog, so the model can correct the search text.
        let before_text = before.ok_or_else(|| {
            format!("edit mode needs an existing file; {path} does not exist")
        })?;
        let pairs = parse_pairs(args)?;
        let mut working = before_text.clone();
        for (index, pair) in pairs.iter().enumerate() {
            let matches = working.matches(&pair.search).count();
            if matches != 1 {
                return Err(format!(
                    "edit {} of {}: the search text matched {matches} times in {path}; each search must match exactly once",
                    index + 1,
                    pairs.len()
                ));
            }
            working = working.replacen(&pair.search, &pair.replace, 1);
        }
        if working.len() > MAX_CONTENT_BYTES {
            return Err(format!(
                "the edited file would be {} bytes, above the {MAX_CONTENT_BYTES} byte limit",
                working.len()
            ));
        }
        Ok(WriteFileRequest {
            display_path: path,
            resolved,
            mode,
            before: Some(before_text),
            after: working,
            replacements: pairs.len(),
        })
    }

    /// The reviewed preview: the exact before/after of this call. Display
    /// only — the write is of `after`, unchanged. A new file previews as
    /// the proposed text itself (`content`), since there is no
    /// before-state to diff against; edits and replacements preview as a
    /// line diff.
    pub fn preview(&self) -> FileDiffView {
        let shown = crate::diff::visible(&self.display_path);
        let resolved_note = crate::diff::visible(&self.resolved.display().to_string());
        let tail = if resolved_note == shown {
            String::new()
        } else {
            format!(" (resolves to {resolved_note})")
        };
        let before = self.before.as_deref().unwrap_or("");
        let mut diff: Option<TextDiffView> = None;
        let mut content: Option<String> = None;
        let note = match (self.before.is_some(), self.mode) {
            (false, _) => {
                // A new file has no before-state: an all-insert diff would
                // be noise. The preview is the proposed text itself.
                if self.after.len() > crate::diff::MAX_DIFF_BYTES {
                    format!(
                        "New file {shown}{tail} is {} bytes, above the {} byte preview cap. No content preview. The call has not run.",
                        self.after.len(),
                        crate::diff::MAX_DIFF_BYTES
                    )
                } else {
                    content = Some(self.after.clone());
                    format!(
                        "New file {shown}{tail}. The text below is the text this call would write. The call has not run."
                    )
                }
            }
            (true, "edit") => {
                diff = Some(diff_text(before, &self.after));
                format!(
                    "Edit of {shown}{tail}: {} search/replacements, with the changed lines marked. The call has not run.",
                    self.replacements
                )
            }
            (true, _) => {
                diff = Some(diff_text(before, &self.after));
                format!(
                    "Before and after for {shown}{tail}. This call replaces the file. The call has not run."
                )
            }
        };
        FileDiffView {
            path: shown,
            mode: "write",
            note,
            diff,
            content,
        }
    }

    /// Write `after` atomically, refusing if the file changed since the
    /// preview was built. The result text is harness-generated.
    pub fn execute(&self) -> WriteOutcome {
        // The approval saw `before` -> `after`. If the file no longer
        // matches what the preview described, the approval does not cover
        // what would be written: refuse and let the human look again.
        let current = read_existing(&self.resolved).unwrap_or(None);
        if current != self.before {
            return WriteOutcome {
                ok: false,
                text: format!(
                    "{} changed on disk after the preview was built. Nothing was written; review the file again.",
                    self.display_path
                ),
            };
        }
        let parent = self.resolved.parent().map(Path::to_path_buf);
        if let Some(parent) = parent
            && let Err(error) = std::fs::create_dir_all(&parent)
        {
            return WriteOutcome {
                ok: false,
                text: format!("could not create {}: {error}", self.display_path),
            };
        }
        if let Err(error) = write_atomic(&self.resolved, self.after.as_bytes()) {
            return WriteOutcome {
                ok: false,
                text: format!("could not write {}: {error}", self.display_path),
            };
        }
        let added = self.after.lines().count();
        let (added_n, removed_n) = match &self.before {
            None => (added, 0),
            Some(before) => {
                let diff = diff_text(before, &self.after);
                (diff.added as usize, diff.removed as usize)
            }
        };
        let ok = true;
        let text = if self.mode == "edit" {
            format!(
                "Edited {}: {} replacements, +{} -{} lines.",
                self.display_path, self.replacements, added_n, removed_n
            )
        } else if self.before.is_none() {
            format!(
                "Created {} ({} bytes, {} lines).",
                self.display_path,
                self.after.len(),
                added
            )
        } else {
            format!(
                "Replaced {} ({} bytes, +{} -{} lines).",
                self.display_path,
                self.after.len(),
                added_n,
                removed_n
            )
        };
        WriteOutcome { ok, text }
    }
}

fn validate_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("path is required".to_string());
    }
    if path.len() > MAX_PATH_BYTES {
        return Err(format!("path is longer than {MAX_PATH_BYTES} bytes"));
    }
    if path.contains('\0') || path.contains('\n') || path.contains('\r') {
        return Err("path contains a NUL or a newline".to_string());
    }
    if path.ends_with('/') {
        return Err("path must name a file, not a directory".to_string());
    }
    Ok(())
}

/// Relative paths resolve against the workspace; `../` and absolute paths
/// are allowed (run_cmd runs anywhere too), and the preview note always
/// states the resolved location.
fn resolve_path(path: &str) -> PathBuf {
    let as_path = Path::new(path);
    if as_path.is_absolute() {
        as_path.to_path_buf()
    } else {
        crate::config::WORKSPACE_DIR.as_path().join(as_path)
    }
}

/// Read the current text of the target. `Ok(None)` when it does not
/// exist; an error when it is unreadable, over the size bound, or not
/// UTF-8 text.
fn read_existing(path: &Path) -> Result<Option<String>, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("could not read {}: {error}", path.display())),
    };
    if bytes.len() > MAX_BEFORE_BYTES {
        return Err(format!(
            "{} is {} bytes, above the {MAX_BEFORE_BYTES} byte limit for write_file",
            path.display(),
            bytes.len()
        ));
    }
    match String::from_utf8(bytes) {
        Ok(text) => Ok(Some(text)),
        Err(_) => Err(format!(
            "{} is not a UTF-8 text file; write_file writes text files",
            path.display()
        )),
    }
}

fn parse_pairs(args: &Value) -> Result<Vec<EditPair>, String> {
    let Some(items) = args.get("edits").and_then(|value| value.as_array()) else {
        return Err("edits is required in edit mode".to_string());
    };
    if items.is_empty() {
        return Err("edits is empty".to_string());
    }
    let mut pairs = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let search = item
            .get("search")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let replace = item
            .get("replace")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if search.is_empty() {
            return Err(format!("edit {} has an empty search", index + 1));
        }
        if search.len() > 64 * 1024 || replace.len() > MAX_CONTENT_BYTES {
            return Err(format!("edit {} is too large", index + 1));
        }
        pairs.push(EditPair {
            search: search.to_string(),
            replace: replace.to_string(),
        });
    }
    Ok(pairs)
}

/// Write through a temp file in the same directory and rename over the
/// target, so a failed write never leaves a half-written file.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut temp = path.as_os_str().to_owned();
    temp.push(".harness-write-tmp");
    let temp = PathBuf::from(temp);
    std::fs::write(&temp, bytes)?;
    std::fs::rename(&temp, path)
}

pub(crate) fn tool_info() -> ollama_rs::generation::tools::ToolInfo {
    let schema = serde_json::json!({
        "type": "function",
        "function": {
            "name": TOOL_NAME,
            "description": crate::model_voice::WRITE_FILE_DESCRIPTION,
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "The file to write, e.g. `src/new.rs`. Parent directories are created. ../ and absolute paths resolve as written."
                    },
                    "mode": {
                        "type": "string",
                        "enum": ["write", "edit"],
                        "description": "write: content is the complete new file (create or replace). edit: apply the search/replacement pairs to the existing file."
                    },
                    "content": {
                        "type": "string",
                        "description": "mode write: the complete file text to write."
                    },
                    "edits": {
                        "type": "array",
                        "description": "mode edit: ordered search/replacement pairs. Each search must match exactly once in the file as it stands; a failed pair refuses the call.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "search": { "type": "string", "description": "Exact text to find once in the file." },
                                "replace": { "type": "string", "description": "The text that replaces it." }
                            },
                            "required": ["search", "replace"],
                            "additionalProperties": false
                        }
                    }
                },
                "required": ["path", "mode"],
                "additionalProperties": false
            }
        }
    });
    serde_json::from_value(schema).expect("write_file schema")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "write-file-test-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn request(path: &str, args: Value) -> WriteFileRequest {
        let mut with_path = args;
        with_path["path"] = Value::String(path.to_string());
        WriteFileRequest::parse(&with_path).unwrap()
    }

    #[test]
    fn write_mode_creates_the_file_byte_for_byte() {
        let dir = temp_dir("write");
        let target = dir.join("deep/nested/new.rs");
        let content = "fn main() {\n    println!(\"hi\");\n}\n";
        let req = request(
            target.to_str().unwrap(),
            serde_json::json!({"mode": "write", "content": content}),
        );
        assert_eq!(req.mode, "write");
        assert!(req.before.is_none());
        let preview = req.preview();
        assert_eq!(preview.mode, "write");
        // A new file previews as the proposed text itself, not a diff.
        assert!(preview.diff.is_none());
        let content = preview.content.as_deref().expect("new-file content preview");
        assert_eq!(content, "fn main() {\n    println!(\"hi\");\n}\n");
        assert!(preview.note.contains("would write"), "{}", preview.note);
        let outcome = req.execute();
        assert!(outcome.ok, "{}", outcome.text);
        assert!(outcome.text.contains("new.rs"), "{}", outcome.text);
        // The invariant: the bytes on disk are the bytes approved.
        assert_eq!(std::fs::read(&target).unwrap(), content.as_bytes());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_mode_replaces_and_the_preview_shows_the_change() {
        let dir = temp_dir("replace");
        let target = dir.join("a.py");
        std::fs::write(&target, "line one\nline two\n").unwrap();
        let req = request(
            target.to_str().unwrap(),
            serde_json::json!({"mode": "write", "content": "line one\nline THREE\n"}),
        );
        let diff = req.preview().diff.unwrap();
        assert_eq!(diff.added, 1);
        assert_eq!(diff.removed, 1);
        let outcome = req.execute();
        assert!(outcome.ok, "{}", outcome.text);
        assert!(outcome.text.contains("a.py"), "{}", outcome.text);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "line one\nline THREE\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn edit_mode_applies_pairs_in_order() {
        let dir = temp_dir("edit");
        let target = dir.join("app.ts");
        std::fs::write(&target, "let x = 1;\nlet y = x + 1;\n").unwrap();
        let req = request(
            target.to_str().unwrap(),
            serde_json::json!({"mode": "edit", "edits": [
                {"search": "let x = 1;", "replace": "const x = 2;"},
                {"search": "let y = x + 1;", "replace": "const y = x + 1;"},
            ]}),
        );
        assert_eq!(req.replacements, 2);
        assert_eq!(req.after, "const x = 2;\nconst y = x + 1;\n");
        let outcome = req.execute();
        assert!(outcome.ok, "{}", outcome.text);
        assert!(outcome.text.contains("2 replacements"), "{}", outcome.text);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), req.after);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn edit_mode_refuses_a_search_that_is_not_unique() {
        let dir = temp_dir("unique");
        let target = dir.join("dup.txt");
        std::fs::write(&target, "same\nsame\n").unwrap();
        let err = WriteFileRequest::parse(&serde_json::json!({
            "path": target.to_str().unwrap(),
            "mode": "edit",
            "edits": [{"search": "same", "replace": "different"}]
        }))
        .unwrap_err();
        // The error is the model's to fix: it reports the match count.
        assert!(err.contains("2 times"), "{err}");
        assert!(err.contains("exactly once"), "{err}");
        // Nothing was written.
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "same\nsame\n");
        // A missing file is also a parse-time refusal, not a dialog.
        let missing = WriteFileRequest::parse(&serde_json::json!({
            "path": dir.join("none.txt").to_str().unwrap(),
            "mode": "edit",
            "edits": [{"search": "a", "replace": "b"}]
        }))
        .unwrap_err();
        assert!(missing.contains("does not exist"), "{missing}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_changed_after_the_preview_is_refused() {
        let dir = temp_dir("toctou");
        let target = dir.join("race.txt");
        std::fs::write(&target, "approved before\n").unwrap();
        let req = request(
            target.to_str().unwrap(),
            serde_json::json!({"mode": "write", "content": "approved after\n"}),
        );
        // Someone else edits the file between preview and accept.
        std::fs::write(&target, "changed under\n").unwrap();
        let outcome = req.execute();
        assert!(!outcome.ok, "{}", outcome.text);
        assert!(outcome.text.contains("changed on disk"), "{}", outcome.text);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "changed under\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn paths_are_validated_but_dot_dot_routes_are_allowed() {
        assert!(WriteFileRequest::parse(&serde_json::json!({"path": "", "mode": "write", "content": ""})).is_err());
        assert!(WriteFileRequest::parse(&serde_json::json!({"path": "a\nb.txt", "mode": "write", "content": ""})).is_err());
        assert!(WriteFileRequest::parse(&serde_json::json!({"path": "dir/", "mode": "write", "content": ""})).is_err());
        // ../ routing resolves as written, and the preview says where.
        let req = WriteFileRequest::parse(&serde_json::json!({
            "path": "sibling/through/../target.txt",
            "mode": "write",
            "content": "x"
        }))
        .unwrap();
        let note = req.preview().note;
        assert!(note.contains("target.txt"), "{note}");
        assert!(note.contains("resolves to"), "{note}");
    }

    #[test]
    fn an_over_cap_new_file_previews_with_no_content() {
        let dir = temp_dir("cap");
        let target = dir.join("big.rs");
        let content = "x".repeat(crate::diff::MAX_DIFF_BYTES + 1);
        let req = request(
            target.to_str().unwrap(),
            serde_json::json!({"mode": "write", "content": content}),
        );
        let preview = req.preview();
        // Above the preview cap: neither a diff nor a content block —
        // the note says why, and nothing has run.
        assert!(preview.diff.is_none());
        assert!(preview.content.is_none());
        assert!(preview.note.contains("preview cap"), "{}", preview.note);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
