//! Text diffs for the approval dialog and for history edit clips.
//!
//! [`similar`] computes the line diff. A replaced line also carries inline
//! word or character spans so a long shell chain does not light up from
//! end to end. The page receives structured records (`equal`, `insert`,
//! `delete`) and paints them with `textContent`. Nothing here runs a
//! command or writes a file. A file diff only reads the target, and only
//! when the whole command is one quoted heredoc written by `cat` or `tee`.
use serde::Serialize;
use serde_json::{Map, Value};
use similar::{ChangeTag, TextDiff};
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};

/// Largest input, per side, that is diffed line by line. Larger text gets
/// a one-line note. The same cap bounds a file read.
pub(crate) const MAX_DIFF_BYTES: usize = 256 * 1024;
/// Largest line count, per side, that is diffed.
const MAX_DIFF_LINES: usize = 4_000;
/// Unchanged lines kept on each side of a change.
const CONTEXT_LINES: usize = 3;
/// Lines sent to the page after context is collapsed.
const MAX_EMIT_LINES: usize = 400;
/// Characters kept from one emitted line. The rest is marked.
const MAX_LINE_CHARS: usize = 1_000;
/// Changed lines named in a history clip, and characters kept from each.
const CLIP_LINES: usize = 3;
const CLIP_CHARS: usize = 40;
/// A character diff is used when a replaced line has no whitespace and
/// both sides stay under this length.
const MAX_CHAR_DIFF_CHARS: usize = 2_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    Equal,
    Insert,
    Delete,
}

impl Op {
    fn as_str(self) -> &'static str {
        match self {
            Op::Equal => "equal",
            Op::Insert => "insert",
            Op::Delete => "delete",
        }
    }
}

#[derive(Debug, Clone)]
struct Span {
    op: Op,
    text: String,
}

#[derive(Debug, Clone)]
struct RawLine {
    op: Op,
    text: String,
    spans: Option<Vec<Span>>,
    skipped: Option<u32>,
}

/// One line of a diff, ready for the page.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct DiffLine {
    pub op: &'static str,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spans: Option<Vec<DiffSpan>>,
    /// Unchanged lines omitted at this point. `text` is empty.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<u32>,
}

/// A highlighted piece inside a changed line.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct DiffSpan {
    pub op: &'static str,
    pub text: String,
}

/// A bounded line diff. `note` is set when the inputs were not diffed, or
/// when later changes were left out of `lines`. Counts cover the whole
/// diff, including lines that were not sent.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct TextDiffView {
    pub added: u32,
    pub removed: u32,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub lines: Vec<DiffLine>,
}

/// Compact history clip: `+N/-M` and the first few changed lines.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(crate) struct EditClip {
    pub summary: String,
    pub added: u32,
    pub removed: u32,
}

/// Before/after for one literal file write. `diff` is absent when the
/// file is binary, too large, or not a regular file; `content` is the
/// complete proposed text for a file that does not exist yet (shown as
/// one highlighted block, not a diff) and is absent when a diff is
/// present or when neither can be shown. The command has not been run.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct FileDiffView {
    pub path: String,
    /// `write` replaces the file. `append` adds the heredoc after it.
    pub mode: &'static str,
    pub note: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<TextDiffView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

struct LiteralWrite {
    path: String,
    append: bool,
    body: String,
}

/// Diff two texts. Equal inputs produce an empty line list. Inputs past
/// the cap produce a note and no lines.
pub(crate) fn diff_text(before: &str, after: &str) -> TextDiffView {
    let before = normalize_newlines(before);
    let after = normalize_newlines(after);
    if before == after {
        return empty_view();
    }
    if let Some(note) = size_note(&before, &after) {
        return TextDiffView {
            added: 0,
            removed: 0,
            truncated: false,
            note: Some(note),
            lines: Vec::new(),
        };
    }
    let ops = line_ops(&before, &after);
    let added = count_op(&ops, Op::Insert);
    let removed = count_op(&ops, Op::Delete);
    if added == 0 && removed == 0 {
        return empty_view();
    }
    let collapsed = collapse_context(&ops);
    let (emitted, truncated) = take_emit(&collapsed);
    let mut note = None;
    if truncated {
        note = Some("Later changes were left out of this diff.".to_string());
    }
    TextDiffView {
        added,
        removed,
        truncated,
        note,
        lines: emitted.into_iter().map(emit_line).collect(),
    }
}

/// History clip for one edit. `None` when the two texts are the same.
pub(crate) fn edit_clip(before: &str, after: &str) -> Option<EditClip> {
    let before = normalize_newlines(before);
    let after = normalize_newlines(after);
    if before == after {
        return None;
    }
    if size_note(&before, &after).is_some() {
        return Some(EditClip {
            summary: "too large to diff".to_string(),
            added: 0,
            removed: 0,
        });
    }
    let ops = line_ops(&before, &after);
    let added = count_op(&ops, Op::Insert);
    let removed = count_op(&ops, Op::Delete);
    if added == 0 && removed == 0 {
        return None;
    }
    Some(EditClip {
        summary: summary_text(added, removed, &ops),
        added,
        removed,
    })
}

fn empty_view() -> TextDiffView {
    TextDiffView {
        added: 0,
        removed: 0,
        truncated: false,
        note: None,
        lines: Vec::new(),
    }
}

fn normalize_newlines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

fn line_count(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    let mut n = text.split('\n').count();
    if text.ends_with('\n') {
        n -= 1;
    }
    n
}

fn size_note(before: &str, after: &str) -> Option<String> {
    if before.len() > MAX_DIFF_BYTES || after.len() > MAX_DIFF_BYTES {
        return Some(format!(
            "Too large to diff (above {MAX_DIFF_BYTES} bytes)."
        ));
    }
    if line_count(before) > MAX_DIFF_LINES || line_count(after) > MAX_DIFF_LINES {
        return Some(format!(
            "Too large to diff (above {MAX_DIFF_LINES} lines)."
        ));
    }
    None
}

fn line_ops(before: &str, after: &str) -> Vec<RawLine> {
    let diff = TextDiff::from_lines(before, after);
    let mut lines = Vec::new();
    for op in diff.ops() {
        for change in diff.iter_inline_changes(op) {
            lines.push(line_from_change(&change));
        }
    }
    refine_unspaced(&mut lines);
    lines
}

fn line_from_change(change: &similar::InlineChange<'_, str>) -> RawLine {
    let line_op = match change.tag() {
        ChangeTag::Equal => Op::Equal,
        ChangeTag::Insert => Op::Insert,
        ChangeTag::Delete => Op::Delete,
    };
    let mut text = String::new();
    let mut spans = Vec::new();
    for (emphasized, value) in change.iter_strings_lossy() {
        let piece = value.trim_end_matches(['\n', '\r']);
        if piece.is_empty() {
            continue;
        }
        let span_op = if emphasized && line_op != Op::Equal {
            line_op
        } else {
            Op::Equal
        };
        push_span(&mut spans, span_op, piece);
        text.push_str(piece);
    }
    if line_op == Op::Equal || !spans.iter().any(|span| span.op == Op::Equal) {
        spans.clear();
    }
    RawLine {
        op: line_op,
        text,
        spans: if spans.is_empty() { None } else { Some(spans) },
        skipped: None,
    }
}

/// A replaced line with no spaces is highlighted character by character.
/// Word splitting has nothing to grab onto, and a one-character edit in a
/// long token would otherwise mark the whole line.
fn refine_unspaced(lines: &mut [RawLine]) {
    let mut i = 0;
    while i < lines.len() {
        if lines[i].op == Op::Equal {
            i += 1;
            continue;
        }
        let start = i;
        while i < lines.len() && lines[i].op != Op::Equal {
            i += 1;
        }
        let deletes: Vec<usize> = (start..i).filter(|&n| lines[n].op == Op::Delete).collect();
        let inserts: Vec<usize> = (start..i).filter(|&n| lines[n].op == Op::Insert).collect();
        for (left, right) in deletes.into_iter().zip(inserts) {
            let old = lines[left].text.clone();
            let new = lines[right].text.clone();
            if old.chars().any(char::is_whitespace) || new.chars().any(char::is_whitespace) {
                continue;
            }
            if old.chars().count() > MAX_CHAR_DIFF_CHARS || new.chars().count() > MAX_CHAR_DIFF_CHARS
            {
                continue;
            }
            if let Some((old_spans, new_spans)) = char_spans(&old, &new) {
                lines[left].spans = Some(old_spans);
                lines[right].spans = Some(new_spans);
            }
        }
    }
}

fn char_spans(old: &str, new: &str) -> Option<(Vec<Span>, Vec<Span>)> {
    let diff = TextDiff::from_chars(old, new);
    let mut old_spans = Vec::new();
    let mut new_spans = Vec::new();
    for change in diff.iter_all_changes() {
        let piece = change.value();
        if piece.is_empty() {
            continue;
        }
        match change.tag() {
            ChangeTag::Equal => {
                push_span(&mut old_spans, Op::Equal, piece);
                push_span(&mut new_spans, Op::Equal, piece);
            }
            ChangeTag::Delete => push_span(&mut old_spans, Op::Delete, piece),
            ChangeTag::Insert => push_span(&mut new_spans, Op::Insert, piece),
        }
    }
    if !old_spans.iter().any(|span| span.op == Op::Equal)
        && !new_spans.iter().any(|span| span.op == Op::Equal)
    {
        return None;
    }
    if old_spans.iter().all(|span| span.op == Op::Equal)
        && new_spans.iter().all(|span| span.op == Op::Equal)
    {
        return None;
    }
    Some((old_spans, new_spans))
}

fn push_span(spans: &mut Vec<Span>, op: Op, text: &str) {
    if text.is_empty() {
        return;
    }
    if let Some(last) = spans.last_mut()
        && last.op == op
    {
        last.text.push_str(text);
        return;
    }
    spans.push(Span {
        op,
        text: text.to_string(),
    });
}

fn count_op(lines: &[RawLine], op: Op) -> u32 {
    lines.iter().filter(|line| line.op == op && line.skipped.is_none()).count() as u32
}

fn collapse_context(lines: &[RawLine]) -> Vec<RawLine> {
    if lines.iter().all(|line| line.op == Op::Equal) {
        return Vec::new();
    }
    let mut keep = vec![false; lines.len()];
    for (index, line) in lines.iter().enumerate() {
        if line.op == Op::Equal {
            continue;
        }
        let start = index.saturating_sub(CONTEXT_LINES);
        let end = (index + CONTEXT_LINES + 1).min(lines.len());
        for slot in &mut keep[start..end] {
            *slot = true;
        }
    }
    let mut out = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        if keep[index] {
            out.push(lines[index].clone());
            index += 1;
            continue;
        }
        let start = index;
        while index < lines.len() && !keep[index] {
            index += 1;
        }
        let skipped = (index - start) as u32;
        if skipped > 0 {
            out.push(RawLine {
                op: Op::Equal,
                text: String::new(),
                spans: None,
                skipped: Some(skipped),
            });
        }
    }
    out
}

fn take_emit(lines: &[RawLine]) -> (Vec<RawLine>, bool) {
    if lines.len() <= MAX_EMIT_LINES {
        return (lines.to_vec(), false);
    }
    (lines[..MAX_EMIT_LINES].to_vec(), true)
}

fn emit_line(line: RawLine) -> DiffLine {
    if let Some(skipped) = line.skipped {
        return DiffLine {
            op: Op::Equal.as_str(),
            text: String::new(),
            spans: None,
            skipped: Some(skipped),
        };
    }
    let (text, cut) = clip_chars(&line.text, MAX_LINE_CHARS);
    let spans = if cut {
        None
    } else {
        line.spans.map(|spans| {
            spans
                .into_iter()
                .map(|span| DiffSpan {
                    op: span.op.as_str(),
                    text: visible(&span.text),
                })
                .collect()
        })
    };
    let mut shown = visible(&text);
    if cut {
        shown.push('…');
    }
    DiffLine {
        op: line.op.as_str(),
        text: shown,
        spans,
        skipped: None,
    }
}

fn summary_text(added: u32, removed: u32, lines: &[RawLine]) -> String {
    let mut out = format!("+{added}/-{removed}");
    let mut shown = 0usize;
    let mut extra = false;
    for line in lines {
        if line.op == Op::Equal || line.skipped.is_some() {
            continue;
        }
        if shown >= CLIP_LINES {
            extra = true;
            break;
        }
        let mark = if line.op == Op::Delete { "-" } else { "+" };
        let (clipped, cut) = clip_chars(&line.text, CLIP_CHARS);
        out.push(' ');
        out.push_str(mark);
        out.push(' ');
        out.push_str(&visible(&clipped));
        if cut {
            out.push_str("...");
        }
        shown += 1;
    }
    if extra {
        out.push_str(" …");
    }
    out
}

fn clip_chars(text: &str, max: usize) -> (String, bool) {
    let count = text.chars().count();
    if count <= max {
        return (text.to_string(), false);
    }
    (text.chars().take(max).collect(), true)
}

/// Bidi and C0/C1 controls are written out so a command or a file cannot
/// reorder the diff. Tabs stay. The page still assigns the result with
/// `textContent`.
pub(crate) fn visible(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        let code = ch as u32;
        let control = (code <= 0x1F && ch != '\t')
            || (0x7F..=0x9F).contains(&code)
            || (0x202A..=0x202E).contains(&code)
            || (0x2066..=0x2069).contains(&code)
            || code == 0x200E
            || code == 0x200F;
        if control {
            out.push_str(&format!("\\u{code:04x}"));
        } else {
            out.push(ch);
        }
    }
    out
}

/// A before/after for a command that is nothing but a quoted heredoc
/// write. Any other command, including `sed -i`, a pipe, an unquoted
/// heredoc, or a redirect of command output, returns `None`. The file is
/// only read. It is not created, truncated, or executed.
pub(crate) fn file_diff_for_command(command: &str) -> Option<FileDiffView> {
    let write = parse_literal_write(command)?;
    Some(file_diff_view(&write))
}

fn file_diff_view(write: &LiteralWrite) -> FileDiffView {
    let mode = if write.append { "append" } else { "write" };
    let path_note = visible(&write.path);
    if write.body.len() > MAX_DIFF_BYTES {
        return FileDiffView {
            path: path_note.clone(),
            mode,
            note: format!(
                "The text this command would write is {} bytes, above the {MAX_DIFF_BYTES} byte diff cap. No line diff. The command has not run.",
                write.body.len()
            ),
            diff: None,
            content: None,
        };
    }
    let resolved = resolve_literal_path(&write.path);
    match read_target(&resolved) {
        TargetRead::Missing => {
            let diff = diff_text("", &write.body);
            FileDiffView {
                path: path_note.clone(),
                mode,
                note: format!(
                    "{path_note} does not exist yet. The lines below are the text this command would write. The command has not run."
                ),
                diff: Some(diff),
                content: None,
            }
        }
        TargetRead::Text(existing) => {
            let after = if write.append {
                let mut combined = existing.clone();
                combined.push_str(&write.body);
                if combined.len() > MAX_DIFF_BYTES {
                    return FileDiffView {
                        path: path_note.clone(),
                        mode,
                        note: format!(
                            "{path_note} plus the appended text is {} bytes, above the {MAX_DIFF_BYTES} byte diff cap. No line diff. The command has not run.",
                            combined.len()
                        ),
                        diff: None,
                        content: None,
                    };
                }
                combined
            } else {
                write.body.clone()
            };
            let diff = diff_text(&existing, &after);
            let verb = if write.append {
                format!("Appended text for {path_note}, after the file as it is now.")
            } else {
                format!("Before and after for {path_note}. This is the file as it is now.")
            };
            FileDiffView {
                path: path_note,
                mode,
                note: format!("{verb} The command has not run."),
                diff: Some(diff),
                content: None,
            }
        }
        TargetRead::TooBig(bytes) => FileDiffView {
            path: path_note.clone(),
            mode,
            note: format!(
                "{path_note} is {bytes} bytes, above the {MAX_DIFF_BYTES} byte diff cap. No line diff. The command has not run."
            ),
            diff: None,
            content: None,
        },
        TargetRead::Binary(bytes) => FileDiffView {
            path: path_note.clone(),
            mode,
            note: format!(
                "{path_note} is not UTF-8 text ({bytes} bytes). No line diff. The command has not run."
            ),
            diff: None,
            content: None,
        },
        TargetRead::NotFile => FileDiffView {
            path: path_note.clone(),
            mode,
            note: format!(
                "{path_note} is not a regular file. No line diff. The command has not run."
            ),
            diff: None,
            content: None,
        },
        TargetRead::Failed(kind) => FileDiffView {
            path: path_note.clone(),
            mode,
            note: format!(
                "{path_note} could not be read ({}). No line diff. The command has not run.",
                io_phrase(kind)
            ),
            diff: None,
            content: None,
        },
    }
}

enum TargetRead {
    Missing,
    Text(String),
    TooBig(u64),
    Binary(u64),
    NotFile,
    Failed(ErrorKind),
}

fn resolve_literal_path(path: &str) -> PathBuf {
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        crate::config::WORKSPACE_DIR.join(candidate)
    }
}

fn read_target(path: &Path) -> TargetRead {
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == ErrorKind::NotFound => return TargetRead::Missing,
        Err(error) => return TargetRead::Failed(error.kind()),
    };
    if !meta.is_file() {
        return TargetRead::NotFile;
    }
    if meta.len() > MAX_DIFF_BYTES as u64 {
        return TargetRead::TooBig(meta.len());
    }
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) => return TargetRead::Failed(error.kind()),
    };
    let mut buf = Vec::new();
    if file.take(MAX_DIFF_BYTES as u64 + 1).read_to_end(&mut buf).is_err() {
        return TargetRead::Failed(ErrorKind::Other);
    }
    if buf.len() > MAX_DIFF_BYTES {
        return TargetRead::TooBig(buf.len() as u64);
    }
    if buf.contains(&0) {
        return TargetRead::Binary(buf.len() as u64);
    }
    match String::from_utf8(buf) {
        Ok(text) => TargetRead::Text(text),
        Err(error) => TargetRead::Binary(error.as_bytes().len() as u64),
    }
}

fn io_phrase(kind: ErrorKind) -> &'static str {
    match kind {
        ErrorKind::NotFound => "not found",
        ErrorKind::PermissionDenied => "permission denied",
        ErrorKind::IsADirectory => "a directory",
        _ => "could not be read",
    }
}

/// The whole command is `cat > path`, `cat >> path`, or `tee path`, with a
/// single-quoted heredoc and nothing after the closing delimiter.
fn parse_literal_write(command: &str) -> Option<LiteralWrite> {
    if command.contains('\0') {
        return None;
    }
    let command = command.replace("\r\n", "\n");
    if command.contains('\r') {
        return None;
    }
    let (head, rest) = command.split_once('\n')?;
    let mut cursor = skip_ws(head);
    let (tool, next) = take_ident(cursor)?;
    cursor = next;
    let append = match tool {
        "cat" => {
            cursor = skip_ws(cursor);
            if let Some(next) = cursor.strip_prefix(">>") {
                cursor = next;
                true
            } else {
                let next = cursor.strip_prefix('>')?;
                cursor = next;
                false
            }
        }
        "tee" => false,
        _ => return None,
    };
    cursor = skip_ws(cursor);
    let (path, next) = read_path(cursor)?;
    cursor = skip_ws(next);
    let next = cursor.strip_prefix("<<")?;
    cursor = skip_ws(next);
    let next = cursor.strip_prefix('\'')?;
    let end = next.find('\'')?;
    let delim = &next[..end];
    if !valid_delim(delim) {
        return None;
    }
    cursor = skip_ws(&next[end + 1..]);
    if !cursor.is_empty() {
        return None;
    }
    let body = heredoc_body(rest, delim)?;
    Some(LiteralWrite { path, append, body })
}

fn skip_ws(text: &str) -> &str {
    text.trim_start_matches([' ', '\t'])
}

fn take_ident(text: &str) -> Option<(&str, &str)> {
    let text = skip_ws(text);
    let end = text
        .find(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_')
        .unwrap_or(text.len());
    if end == 0 {
        return None;
    }
    Some((&text[..end], &text[end..]))
}

fn read_path(text: &str) -> Option<(String, &str)> {
    let text = skip_ws(text);
    if let Some(rest) = text.strip_prefix('\'') {
        let end = rest.find('\'')?;
        let path = &rest[..end];
        if !valid_quoted_path(path) {
            return None;
        }
        return Some((path.to_string(), &rest[end + 1..]));
    }
    let end = text
        .find(|ch: char| {
            ch.is_whitespace()
                || matches!(ch, '<' | '>' | ';' | '|' | '&' | '`' | '$' | '(' | ')' | '\'' | '"')
        })
        .unwrap_or(text.len());
    if end == 0 {
        return None;
    }
    let path = &text[..end];
    if !path.chars().all(|ch| {
        ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '/' | '-' | '+' | '@' | ',' | '=')
    }) {
        return None;
    }
    if !valid_quoted_path(path) {
        return None;
    }
    Some((path.to_string(), &text[end..]))
}

fn valid_quoted_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.starts_with('-')
        && !path.ends_with('/')
        && path != "."
        && !path.contains('\n')
        && !path.contains('\0')
        && !path.contains('~')
}

fn valid_delim(delim: &str) -> bool {
    !delim.is_empty()
        && delim.len() <= 32
        && delim
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn heredoc_body(rest: &str, delim: &str) -> Option<String> {
    let mut lines: Vec<&str> = rest.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let at = lines.iter().position(|line| *line == delim)?;
    if at + 1 != lines.len() {
        return None;
    }
    lines.pop();
    if lines.is_empty() {
        Some(String::new())
    } else {
        let mut body = lines.join("\n");
        body.push('\n');
        Some(body)
    }
}

/// Attach `edit_diffs` to approval and tool-result events. The database
/// row is unchanged; this runs when history is sent to the page. A clip is
/// omitted when the two texts are the same, so the page can keep its older
/// text clip for that one case.
pub(crate) fn annotate_history_edits(events: &mut [Value]) {
    let planned = plan_edit_clips(events);
    for (index, clips) in planned {
        if clips.is_empty() {
            continue;
        }
        let Some(payload) = events[index].get_mut("payload").and_then(Value::as_object_mut) else {
            continue;
        };
        payload.insert(
            "edit_diffs".to_string(),
            serde_json::to_value(clips).unwrap_or(Value::Null),
        );
    }
}

struct CallSlot {
    name: String,
    command: String,
    /// Empty when the call is not a shell command. The page treats that as
    /// "no limit was shown", which is not an edit.
    timeout_phrase: String,
    noted: bool,
}

struct PreviewSlot {
    name: String,
    index: usize,
    paired: bool,
}

fn plan_edit_clips(events: &[Value]) -> Vec<(usize, Vec<EditClip>)> {
    let mut by_round: std::collections::BTreeMap<i64, (Vec<CallSlot>, Vec<PreviewSlot>, u32)> =
        std::collections::BTreeMap::new();
    let mut planned = Vec::new();
    for (index, event) in events.iter().enumerate() {
        let round = event.get("round").and_then(Value::as_i64).unwrap_or(0);
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        let payload = event.get("payload").cloned().unwrap_or(Value::Null);
        let state = by_round.entry(round).or_default();
        match kind {
            "tool_call" => state.0.push(CallSlot {
                name: payload.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                command: payload
                    .get("arguments")
                    .and_then(|args| args.get("command"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                timeout_phrase: timeout_phrase(payload.get("arguments")),
                noted: false,
            }),
            "approval" => {
                if payload.get("decision").and_then(Value::as_str) == Some("redirect") {
                    state.2 += 1;
                }
                if let Some(clips) = approval_clips(&mut state.0, &payload) {
                    planned.push((index, clips));
                }
            }
            "tool_preview" => state.1.push(PreviewSlot {
                name: payload.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                index,
                paired: false,
            }),
            "tool_result" => {
                if let Some(clips) = result_clips(events, state, &payload) {
                    planned.push((index, clips));
                }
            }
            _ => {}
        }
    }
    planned
}

fn approval_clips(calls: &mut [CallSlot], payload: &Value) -> Option<Vec<EditClip>> {
    if payload.get("decision").and_then(Value::as_str) != Some("approve") {
        return None;
    }
    let tool = payload.get("tool").and_then(Value::as_str).unwrap_or("");
    let chosen_timeout = payload
        .get("command_timeout")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty());
    let chosen_command = payload.get("command").and_then(Value::as_str);
    let has_command = chosen_command.is_some_and(|text| !text.trim().is_empty());
    if chosen_timeout.is_none() && !has_command {
        return None;
    }
    let call = calls.iter_mut().rev().find(|call| !call.noted && call.name == tool)?;
    call.noted = true;
    let mut clips = Vec::new();
    if has_command
        && chosen_command != Some(call.command.as_str())
        && let Some(clip) = edit_clip(&call.command, chosen_command.unwrap_or(""))
    {
        clips.push(clip);
    }
    if let Some(chosen) = chosen_timeout
        && !call.timeout_phrase.is_empty()
        && call.timeout_phrase != chosen
        && let Some(clip) = edit_clip(&timeout_line(&call.timeout_phrase), &timeout_line(chosen))
    {
        clips.push(clip);
    }
    if clips.is_empty() { None } else { Some(clips) }
}

fn result_clips(
    events: &[Value],
    state: &mut (Vec<CallSlot>, Vec<PreviewSlot>, u32),
    payload: &Value,
) -> Option<Vec<EditClip>> {
    let name = payload.get("name").and_then(Value::as_str).unwrap_or("");
    let submitted_raw = payload.get("output").and_then(Value::as_str).unwrap_or("");
    let submitted = submitted_review_text(name, submitted_raw);
    let source = unpaired_preview_text(events, &mut state.1, name);
    let changed = source
        .as_ref()
        .is_some_and(|source| !same_tool_text(source, &submitted));
    // A redirect whose text matches a preview has no line diff. The page
    // keeps the older text clip for that case.
    let bare = if state.2 > 0 {
        state.2 -= 1;
        !changed
    } else {
        false
    };
    if changed {
        return edit_clip(source.as_deref().unwrap_or(""), &submitted).map(|clip| vec![clip]);
    }
    if bare && source.is_none() {
        return edit_clip("", &submitted).map(|clip| vec![clip]);
    }
    None
}

fn unpaired_preview_text(
    events: &[Value],
    previews: &mut [PreviewSlot],
    name: &str,
) -> Option<String> {
    let preview = previews
        .iter_mut()
        .rev()
        .find(|preview| !preview.paired && preview.name == name)?;
    preview.paired = true;
    let index = preview.index;
    let preview_name = preview.name.clone();
    let output = events
        .get(index)
        .and_then(|event| event.get("payload"))
        .and_then(|payload| payload.get("output"))
        .and_then(Value::as_str)
        .unwrap_or("");
    Some(reviewable_tool_text(&preview_name, output))
}

fn timeout_phrase(args: Option<&Value>) -> String {
    let Some(args) = args else {
        return String::new();
    };
    if args.get("command").and_then(Value::as_str).is_none() {
        return String::new();
    }
    let raw = args.get("timeout").and_then(Value::as_str).unwrap_or("");
    match raw.trim().to_ascii_lowercase().as_str() {
        "" | "none" | "default" => "none".to_string(),
        "30s" => "30s".to_string(),
        "20m" => "20m".to_string(),
        _ => raw.trim().to_string(),
    }
}

fn timeout_line(phrase: &str) -> String {
    match phrase {
        "30s" => "Timeout: 30s".to_string(),
        "20m" => "Timeout: 20 minutes".to_string(),
        "none" | "" => "Timeout: none".to_string(),
        other => format!("Timeout: {other}"),
    }
}

fn same_tool_text(left: &str, right: &str) -> bool {
    normalize_newlines(left) == normalize_newlines(right)
}

fn reviewable_tool_text(name: &str, output: &str) -> String {
    let trimmed = output.trim();
    if !trimmed.starts_with('{') {
        return output.to_string();
    }
    let Ok(value) = serde_json::from_str::<Value>(output) else {
        return output.to_string();
    };
    let Some(map) = value.as_object() else {
        return output.to_string();
    };
    let Some(stdout) = map.get("stdout").and_then(Value::as_str) else {
        return output.to_string();
    };
    if name == "run_cmd" {
        return output.to_string();
    }
    if name == "web_fetch" {
        if stdout.trim().is_empty() {
            return "Web fetch returned no page text.".to_string();
        }
        return stdout.to_string();
    }
    if name == "web_search" {
        return search_review_text(map);
    }
    stdout.to_string()
}

fn search_review_text(value: &Map<String, Value>) -> String {
    let stdout = value.get("stdout").and_then(Value::as_str).unwrap_or("");
    let stderr = value.get("stderr").and_then(Value::as_str).unwrap_or("");
    let code = value.get("exit_code").and_then(Value::as_i64);
    let code_missing = !value.contains_key("exit_code") || value.get("exit_code").is_some_and(Value::is_null);
    if !stdout.trim().is_empty() {
        if code == Some(0) || stderr.trim().is_empty() {
            return stdout.to_string();
        }
        return format!("{stdout}\nstderr:\n{stderr}");
    }
    let note = if code == Some(0) {
        "Web tool returned no content."
    } else {
        "Web tool retrieval failed."
    };
    if stderr.trim().is_empty() {
        return note.to_string();
    }
    let shown = if code_missing {
        "None".to_string()
    } else {
        format!("Some({})", code.unwrap_or(0))
    };
    format!("{note}\nstderr:\n{stderr}\nexit code: {shown}")
}

fn submitted_review_text(name: &str, output: &str) -> String {
    if name == "run_cmd" || !output.trim().starts_with('{') {
        return output.to_string();
    }
    let Ok(value) = serde_json::from_str::<Value>(output) else {
        return output.to_string();
    };
    let Some(map) = value.as_object() else {
        return output.to_string();
    };
    if name == "web_search" {
        return map
            .get("results")
            .and_then(Value::as_str)
            .unwrap_or(output)
            .to_string();
    }
    if (name == "web_fetch" || name == "read_pdf" || name.ends_with("_search"))
        && let Some(content) = map.get("content").and_then(Value::as_str)
    {
        return content.to_string();
    }
    output.to_string()
}

#[cfg(test)]
mod diff_tests {
    use super::*;

    fn line_text(view: &TextDiffView, op: &str) -> Vec<String> {
        view.lines
            .iter()
            .filter(|line| line.op == op && line.skipped.is_none())
            .map(|line| line.text.clone())
            .collect()
    }

    #[test]
    fn identical_text_has_no_lines() {
        let view = diff_text("same\nstill\n", "same\nstill\n");
        assert_eq!(view.added, 0);
        assert_eq!(view.removed, 0);
        assert!(view.lines.is_empty());
        assert!(edit_clip("same", "same").is_none());
    }

    #[test]
    fn a_replaced_line_marks_the_changed_word() {
        let view = diff_text(
            "The filename is sample.txt",
            "The filename is sample.md",
        );
        assert_eq!(view.removed, 1);
        assert_eq!(view.added, 1);
        let deleted = view.lines.iter().find(|line| line.op == "delete").unwrap();
        let inserted = view.lines.iter().find(|line| line.op == "insert").unwrap();
        let spans = deleted.spans.as_ref().expect("inline spans");
        assert!(spans.iter().any(|span| span.op == "equal" && span.text.contains("filename")));
        assert!(spans.iter().any(|span| span.op == "delete" && span.text.contains("txt")));
        let spans = inserted.spans.as_ref().unwrap();
        assert!(spans.iter().any(|span| span.op == "insert" && span.text.contains("md")));
        assert_eq!(
            spans.iter().map(|span| span.text.as_str()).collect::<String>(),
            inserted.text
        );
    }

    #[test]
    fn a_long_chained_command_highlights_the_changed_words() {
        let old = "cargo test --lib && cargo clippy && cargo fmt --check";
        let new = "cargo test --lib && cargo clippy -- -D warnings && cargo fmt --check";
        let view = diff_text(old, new);
        assert_eq!(view.removed, 1);
        assert_eq!(view.added, 1);
        let inserted = view.lines.iter().find(|line| line.op == "insert").unwrap();
        let spans = inserted.spans.as_ref().expect("word spans on the chain");
        assert!(
            spans.iter().any(|span| span.op == "equal" && span.text.contains("cargo test")),
            "{spans:?}"
        );
        assert!(
            spans.iter().any(|span| span.op == "insert" && span.text.contains("warnings")),
            "{spans:?}"
        );
        assert!(
            spans.iter().any(|span| span.op == "equal" && span.text.contains("fmt")),
            "{spans:?}"
        );
    }

    #[test]
    fn a_token_without_spaces_is_highlighted_by_character() {
        let view = diff_text("tokenABCDEF", "tokenXYZ");
        let deleted = view.lines.iter().find(|line| line.op == "delete").unwrap();
        let spans = deleted.spans.as_ref().unwrap();
        assert!(spans.iter().any(|span| span.op == "equal" && span.text == "token"));
        assert!(spans.iter().any(|span| span.op == "delete" && span.text == "ABCDEF"));
        let inserted = view.lines.iter().find(|line| line.op == "insert").unwrap();
        let spans = inserted.spans.as_ref().unwrap();
        assert!(spans.iter().any(|span| span.op == "insert" && span.text == "XYZ"));
    }

    #[test]
    fn unchanged_context_collapses_around_a_change() {
        let mut before = String::new();
        let mut after = String::new();
        for _ in 0..30 {
            before.push_str("same\n");
            after.push_str("same\n");
        }
        before.push_str("old value\n");
        after.push_str("new value\n");
        for _ in 0..30 {
            before.push_str("same\n");
            after.push_str("same\n");
        }
        let view = diff_text(&before, &after);
        assert!(view.lines.len() < 20, "{}", view.lines.len());
        let skipped: u32 = view.lines.iter().filter_map(|line| line.skipped).sum();
        assert!(skipped >= 40, "{skipped}");
        assert_eq!(line_text(&view, "delete"), vec!["old value".to_string()]);
        assert_eq!(line_text(&view, "insert"), vec!["new value".to_string()]);
    }

    #[test]
    fn bidi_controls_are_written_out() {
        let view = diff_text("echo safe", "echo \u{202A}safe");
        let inserted = view.lines.iter().find(|line| line.op == "insert").unwrap();
        assert!(inserted.text.contains("\\u202a"), "{}", inserted.text);
        assert!(!inserted.text.contains('\u{202A}'));
    }

    #[test]
    fn oversized_text_is_a_note_not_a_diff() {
        let huge = "x".repeat(MAX_DIFF_BYTES + 1);
        let view = diff_text("short", &huge);
        assert!(view.lines.is_empty());
        assert!(view.note.unwrap().contains("Too large to diff"));
        let clip = edit_clip("short", &huge).unwrap();
        assert_eq!(clip.summary, "too large to diff");
    }

    #[test]
    fn the_history_clip_names_counts_and_the_first_changed_lines() {
        let clip = edit_clip(
            "printf model-ok",
            "echo one\necho two\necho three\necho four\necho five",
        )
        .unwrap();
        assert_eq!(clip.added, 5);
        assert_eq!(clip.removed, 1);
        assert_eq!(
            clip.summary,
            "+5/-1 - printf model-ok + echo one + echo two …"
        );
        let timeout = edit_clip("Timeout: 30s", "Timeout: none").unwrap();
        assert_eq!(timeout.summary, "+1/-1 - Timeout: 30s + Timeout: none");
    }

    #[test]
    fn a_long_changed_line_in_the_clip_is_cut() {
        let clip = edit_clip("short", &"y".repeat(CLIP_CHARS + 5)).unwrap();
        assert!(clip.summary.contains("..."), "{}", clip.summary);
        assert!(!clip.summary.contains(&"y".repeat(CLIP_CHARS + 1)));
    }

    #[test]
    fn quoted_heredoc_writes_are_recognized_and_other_shell_is_not() {
        let write = parse_literal_write("cat > notes.txt << 'EOF'\nhello\nEOF\n").unwrap();
        assert_eq!(write.path, "notes.txt");
        assert!(!write.append);
        assert_eq!(write.body, "hello\n");

        let append = parse_literal_write("cat >>'notes.txt' <<'END'\nmore\nEND").unwrap();
        assert!(append.append);
        assert_eq!(append.body, "more\n");

        let tee = parse_literal_write("tee 'my file.txt' << 'EOF'\nhello\nEOF").unwrap();
        assert_eq!(tee.path, "my file.txt");

        assert!(parse_literal_write("cat > notes.txt << EOF\nhello\nEOF").is_none());
        assert!(parse_literal_write("sed -i 's/a/b/' notes.txt").is_none());
        assert!(parse_literal_write("echo hi > notes.txt").is_none());
        assert!(parse_literal_write("cat file | tee notes.txt << 'EOF'\nhi\nEOF").is_none());
        assert!(parse_literal_write("cat > \"$FILE\" << 'EOF'\nhi\nEOF").is_none());
        assert!(parse_literal_write("cat > notes.txt << 'EOF'\nhello\nEOF\necho after").is_none());
        assert!(parse_literal_write("cat > notes.txt << 'EOF' && true\nhello\nEOF").is_none());
        assert!(parse_literal_write("cat > ~/secret << 'EOF'\nhi\nEOF").is_none());
    }

    #[test]
    fn a_new_file_diff_is_all_inserts_and_does_not_create_the_file() {
        let path = std::env::temp_dir().join(format!("harness-diff-new-{}-{}.txt", std::process::id(), unique()));
        let command = format!("cat > {} << 'EOF'\nhello\nEOF\n", path.display());
        let view = file_diff_for_command(&command).unwrap();
        assert!(!path.exists(), "a diff must not create the target");
        assert_eq!(view.mode, "write");
        assert!(view.note.contains("does not exist yet"));
        assert!(view.note.contains("has not run"));
        let diff = view.diff.unwrap();
        assert_eq!(diff.removed, 0);
        assert!(diff.added >= 1);
        assert!(line_text(&diff, "insert").iter().any(|line| line == "hello"));
    }

    #[test]
    fn an_existing_file_is_only_read() {
        let path = std::env::temp_dir().join(format!("harness-diff-read-{}-{}.txt", std::process::id(), unique()));
        std::fs::write(&path, "old line\n").unwrap();
        let before = std::fs::read(&path).unwrap();
        let command = format!("cat > {} << 'EOF'\nnew line\nEOF\n", path.display());
        let view = file_diff_for_command(&command).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(view.note.contains("has not run"));
        let diff = view.diff.unwrap();
        assert_eq!(line_text(&diff, "delete"), vec!["old line".to_string()]);
        assert_eq!(line_text(&diff, "insert"), vec!["new line".to_string()]);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn append_diffs_against_the_file_plus_the_body() {
        let path = std::env::temp_dir().join(format!("harness-diff-append-{}-{}.txt", std::process::id(), unique()));
        std::fs::write(&path, "old\n").unwrap();
        let command = format!("cat >> {} << 'EOF'\nnew\nEOF\n", path.display());
        let view = file_diff_for_command(&command).unwrap();
        assert_eq!(view.mode, "append");
        let diff = view.diff.unwrap();
        assert_eq!(line_text(&diff, "equal"), vec!["old".to_string()]);
        assert_eq!(line_text(&diff, "insert"), vec!["new".to_string()]);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "old\n");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn binary_and_huge_files_are_a_summary() {
        let path = std::env::temp_dir().join(format!("harness-diff-bin-{}-{}.txt", std::process::id(), unique()));
        std::fs::write(&path, b"hello\0SECRET").unwrap();
        let command = format!("cat > {} << 'EOF'\nnew\nEOF\n", path.display());
        let view = file_diff_for_command(&command).unwrap();
        let encoded = serde_json::to_string(&view).unwrap();
        assert!(view.diff.is_none());
        assert!(view.note.contains("not UTF-8"));
        assert!(!encoded.contains("SECRET"));
        let _ = std::fs::remove_file(&path);

        let big = std::env::temp_dir().join(format!("harness-diff-big-{}-{}.txt", std::process::id(), unique()));
        std::fs::write(&big, vec![b'a'; MAX_DIFF_BYTES + 8]).unwrap();
        let command = format!("cat > {} << 'EOF'\nnew\nEOF\n", big.display());
        let view = file_diff_for_command(&command).unwrap();
        assert!(view.diff.is_none());
        assert!(view.note.contains("above the"));
        assert!(!view.note.contains(&"a".repeat(80)));
        let _ = std::fs::remove_file(&big);
    }

    #[test]
    fn a_directory_and_an_unrecognized_command_do_not_invent_a_diff() {
        let dir = std::env::temp_dir().join(format!("harness-diff-dir-{}-{}", std::process::id(), unique()));
        std::fs::create_dir(&dir).unwrap();
        let command = format!("cat > {} << 'EOF'\nnew\nEOF\n", dir.display());
        let view = file_diff_for_command(&command).unwrap();
        assert!(view.diff.is_none());
        assert!(view.note.contains("not a regular file"));
        let _ = std::fs::remove_dir(&dir);

        let sentinel = std::env::temp_dir().join(format!("harness-diff-skip-{}-{}.txt", std::process::id(), unique()));
        std::fs::write(&sentinel, "SECRET").unwrap();
        assert!(file_diff_for_command(&format!("sed -i 's/a/b/' {}", sentinel.display())).is_none());
        assert!(file_diff_for_command(&format!("echo hi > {}", sentinel.display())).is_none());
        assert_eq!(std::fs::read_to_string(&sentinel).unwrap(), "SECRET");
        let _ = std::fs::remove_file(&sentinel);
    }

    #[test]
    fn a_proposed_body_over_the_cap_does_not_read_the_file() {
        let path = std::env::temp_dir().join(format!("harness-diff-body-{}-{}.txt", std::process::id(), unique()));
        std::fs::write(&path, "SECRET-FILE").unwrap();
        let body = "y".repeat(MAX_DIFF_BYTES + 4);
        let command = format!("cat > {} << 'EOF'\n{body}\nEOF\n", path.display());
        let view = file_diff_for_command(&command).unwrap();
        let encoded = serde_json::to_string(&view).unwrap();
        assert!(view.diff.is_none());
        assert!(view.note.contains("would write"));
        assert!(!encoded.contains("SECRET-FILE"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn history_clips_follow_command_timeout_and_output_edits() {
        let mut events = vec![
            serde_json::json!({
                "type": "tool_call",
                "round": 1,
                "payload": { "name": "run_cmd", "arguments": { "command": "printf model-ok", "timeout": "30s", "task": "printing" } }
            }),
            serde_json::json!({
                "type": "approval",
                "round": 1,
                "payload": {
                    "decision": "approve",
                    "tool": "run_cmd",
                    "command": "echo one\necho two\necho three\necho four\necho five",
                    "command_timeout": "none"
                }
            }),
            serde_json::json!({
                "type": "tool_preview",
                "round": 1,
                "payload": { "name": "run_cmd", "output": "The filename is sample.txt" }
            }),
            serde_json::json!({
                "type": "tool_result",
                "round": 1,
                "payload": { "name": "run_cmd", "output": "The filename is sample.md" }
            }),
        ];
        annotate_history_edits(&mut events);
        let clips = &events[1]["payload"]["edit_diffs"];
        assert_eq!(clips[0]["summary"], "+5/-1 - printf model-ok + echo one + echo two …");
        assert_eq!(clips[1]["summary"], "+1/-1 - Timeout: 30s + Timeout: none");
        assert_eq!(
            events[3]["payload"]["edit_diffs"][0]["summary"],
            "+1/-1 - The filename is sample.txt + The filename is sample.md"
        );

        let mut same = vec![
            serde_json::json!({
                "type": "tool_call",
                "round": 1,
                "payload": { "name": "run_cmd", "arguments": { "command": "printf model-ok", "timeout": "30s" } }
            }),
            serde_json::json!({
                "type": "approval",
                "round": 1,
                "payload": { "decision": "approve", "tool": "run_cmd", "command": "printf model-ok", "command_timeout": "30s" }
            }),
            serde_json::json!({
                "type": "tool_preview",
                "round": 1,
                "payload": { "name": "run_cmd", "output": "The filename is sample.txt" }
            }),
            serde_json::json!({
                "type": "tool_result",
                "round": 1,
                "payload": { "name": "run_cmd", "output": "The filename is sample.txt" }
            }),
        ];
        annotate_history_edits(&mut same);
        assert!(same[1]["payload"].get("edit_diffs").is_none());
        assert!(same[3]["payload"].get("edit_diffs").is_none());
    }

    #[test]
    fn a_bare_redirect_clips_the_submitted_text_as_inserts() {
        let mut events = vec![
            serde_json::json!({
                "type": "approval",
                "round": 2,
                "payload": { "decision": "redirect", "tool": "run_cmd", "text": "look at docs" }
            }),
            serde_json::json!({
                "type": "tool_result",
                "round": 2,
                "payload": { "name": "run_cmd", "output": "updated instructions" }
            }),
        ];
        annotate_history_edits(&mut events);
        assert_eq!(
            events[1]["payload"]["edit_diffs"][0]["summary"],
            "+1/-0 + updated instructions"
        );
    }

    #[test]
    fn review_text_matches_the_page_for_fetch_and_search() {
        let fetch = r#"{"stdout":"  ","stderr":""}"#;
        assert_eq!(
            reviewable_tool_text("web_fetch", fetch),
            "Web fetch returned no page text."
        );
        assert_eq!(
            reviewable_tool_text("run_cmd", r#"{"stdout":"hidden"}"#),
            r#"{"stdout":"hidden"}"#
        );
        let failed = r#"{"stdout":"","stderr":"boom","exit_code":1}"#;
        assert_eq!(
            reviewable_tool_text("web_search", failed),
            "Web tool retrieval failed.\nstderr:\nboom\nexit code: Some(1)"
        );
        let submitted = r#"{"url":"https://example.com","content":"Social\nSpring"}"#;
        assert_eq!(submitted_review_text("web_fetch", submitted), "Social\nSpring");
        assert_eq!(
            submitted_review_text("run_cmd", r#"{"content":"nope"}"#),
            r#"{"content":"nope"}"#
        );
    }

    fn unique() -> u64 {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(1);
        N.fetch_add(1, Ordering::Relaxed)
    }
}
