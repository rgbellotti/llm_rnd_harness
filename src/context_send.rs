//! The copy of a prompt that is sent to a provider.
//!
//! History and the prompt box keep what the person wrote. This module
//! builds the provider copy: the same chain, without material the model
//! is not supposed to read. The generated context already contains only
//! the model-bound lineage (one current tool call and one final tool
//! result per step); this pass removes what curation added or kept:
//!
//! - A before-review capture is the raw tool output from before
//!   approval. It is never sent: the whole block is omitted, so the
//!   copy's HID sequence may skip. The history view keeps it.
//! - A block whose body is `[ctx compacted]` was withheld by the person
//!   during curation. The block is omitted entirely — the model never
//!   sees the marker, only the surviving narrative.
//! - `project_mem` calls and their results stay out of the copy; hot
//!   memory is injected separately at the next session start.
//!
//! `CONTEXT BUDGET` blocks are part of the lineage: they are the
//! harness's pacing notifications (20/40/60/80/90/96% fill) and stay in
//! the copy. This run appends its own fresh budget line as the last
//! message, which leaves the cached prefix unchanged until that suffix.
//!
//! The draft under the last bare `==== PROMPT ====` marker is the
//! person's next instruction and is never rewritten.

/// The marker the prompt editor writes when a block body is withheld.
pub(crate) const COMPACTED_MARKER: &str = "[ctx compacted]";

/// The provider-facing prompt and what was removed from it.
pub(crate) struct ProviderPrompt {
    pub text: String,
    pub withheld_previews: usize,
    /// Blocks the person compacted (`[ctx compacted]` bodies) during
    /// curation. They are dropped with no placeholder; their HIDs skip.
    pub omitted_compacted: usize,
    /// `project_mem` calls and their results. History keeps them. A
    /// continued prompt does not replay them; hot memory is injected
    /// separately at the next session start.
    pub omitted_memory: usize,
}

impl ProviderPrompt {
    /// Operator note when the provider copy differs from the prompt box.
    /// `None` when nothing was removed.
    pub(crate) fn notice(&self) -> Option<String> {
        if self.withheld_previews == 0
            && self.omitted_compacted == 0
            && self.omitted_memory == 0
        {
            return None;
        }
        let mut message = String::new();
        if self.withheld_previews > 0 || self.omitted_compacted > 0 {
            message.push_str(&format!(
                "Provider context omitted {previews} before-review capture(s) and {compacted} [ctx compacted] block(s). Their HIDs skip in the copy; the history view keeps everything. Paste text into the prompt draft if the model must see a capture.",
                previews = self.withheld_previews,
                compacted = self.omitted_compacted,
            ));
        }
        if self.omitted_memory > 0 {
            if !message.is_empty() {
                message.push(' ');
            }
            message.push_str(&format!(
                "Omitted {n} project memory action(s). The hot block is injected separately; memory tool chatter is not replayed.",
                n = self.omitted_memory
            ));
        }
        Some(message)
    }
}

/// The text a provider should see. Unchanged when the prompt has no
/// before-review capture, no compacted block, and no memory action.
pub(crate) fn prepare_provider_prompt(text: &str) -> ProviderPrompt {
    let (head, tail) = split_draft(text);
    let mut withheld_previews = 0;
    let mut omitted_compacted = 0;
    let mut omitted_memory = 0;
    let pruned = prune_chain(
        head,
        &mut withheld_previews,
        &mut omitted_compacted,
        &mut omitted_memory,
    );
    if withheld_previews == 0 && omitted_compacted == 0 && omitted_memory == 0 {
        return ProviderPrompt {
            text: text.to_string(),
            withheld_previews: 0,
            omitted_compacted: 0,
            omitted_memory: 0,
        };
    }
    ProviderPrompt {
        text: join_head_tail(&pruned, tail),
        withheld_previews,
        omitted_compacted,
        omitted_memory,
    }
}

/// The editor's draft sits under the last bare `==== PROMPT ====` when
/// nothing after that marker is another chain header. That tail is the
/// person's next instruction and is not rewritten.
fn split_draft(text: &str) -> (&str, &str) {
    const MARKER: &str = "==== PROMPT ====";
    let Some(idx) = text.rfind(MARKER) else {
        return (text, "");
    };
    if idx > 0 && !text[..idx].ends_with('\n') {
        return (text, "");
    }
    let after = &text[idx + MARKER.len()..];
    if after.contains("==== ") {
        return (text, "");
    }
    (text[..idx].trim_end_matches(['\n', '\r']), &text[idx..])
}

fn join_head_tail(head: &str, tail: &str) -> String {
    if tail.is_empty() {
        return head.to_string();
    }
    if head.is_empty() {
        return tail.to_string();
    }
    let mut out = head.to_string();
    if !out.ends_with('\n') {
        out.push('\n');
    }
    if !out.ends_with("\n\n") {
        out.push('\n');
    }
    out.push_str(tail);
    out
}

fn prune_chain(
    text: &str,
    withheld_previews: &mut usize,
    omitted_compacted: &mut usize,
    omitted_memory: &mut usize,
) -> String {
    let starts = header_starts(text);
    if starts.is_empty() {
        return text.to_string();
    }
    let mut out = String::new();
    if starts[0] > 0 {
        out.push_str(&text[..starts[0]]);
    }
    // Tool results follow their calls in order. A project_mem result is
    // dropped with its call so a mixed round keeps the other tools. The
    // pairing bookkeeping runs before any other drop, so a compacted
    // call still reserves its slot in the queue.
    let mut pending_calls: Vec<bool> = Vec::new();
    for (index, start) in starts.iter().copied().enumerate() {
        let end = starts.get(index + 1).copied().unwrap_or(text.len());
        let block = &text[start..end];
        let (header, body) = split_header(block);
        if is_memory_call(header) {
            *omitted_memory += 1;
            pending_calls.push(true);
            continue;
        }
        if is_tool_call(header) {
            pending_calls.push(false);
        }
        if is_tool_result(header) {
            // Results follow calls in order. Pop from the front, not the
            // back, or the first result is paired with the last call.
            let memory_result = if pending_calls.is_empty() {
                false
            } else {
                pending_calls.remove(0)
            };
            if memory_result {
                *omitted_memory += 1;
                continue;
            }
        }
        // A block the person compacted during curation is withheld. The
        // model never sees the marker: the block is omitted entirely and
        // the copy's HID sequence simply skips.
        if body.trim() == COMPACTED_MARKER {
            *omitted_compacted += 1;
            continue;
        }
        // Before-review captures (raw originals) never reach the model,
        // even when pasted into the box by hand. No placeholder is left.
        if is_before_review(header) {
            *withheld_previews += 1;
            continue;
        }
        out.push_str(block);
    }
    out
}

fn header_starts(text: &str) -> Vec<usize> {
    let mut starts = Vec::new();
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\n', '\r']);
        if is_header_line(bare) {
            starts.push(offset);
        }
        offset += line.len();
    }
    starts
}

fn is_header_line(line: &str) -> bool {
    line.starts_with("==== ") && line.ends_with(" ====") && line.len() > "====  ====".len()
}

fn split_header(block: &str) -> (&str, &str) {
    match block.find('\n') {
        Some(pos) => (&block[..=pos], &block[pos + 1..]),
        None => (block, ""),
    }
}

fn is_before_review(header: &str) -> bool {
    header.contains("before review")
}

fn is_tool_call(header: &str) -> bool {
    header.contains("TOOL CALL ")
}

fn is_memory_call(header: &str) -> bool {
    header.contains("TOOL CALL project_mem")
}

fn is_tool_result(header: &str) -> bool {
    header.contains("TOOL RESULT")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_prompt_is_unchanged() {
        let prepared = prepare_provider_prompt("List the files.\n");
        assert_eq!(prepared.text, "List the files.\n");
        assert_eq!(prepared.withheld_previews, 0);
        assert_eq!(prepared.omitted_compacted, 0);
        assert!(prepared.notice().is_none());
    }

    #[test]
    fn a_before_review_capture_is_dropped_entirely() {
        let prompt = "\
==== COMMAND OUTPUT ORIGINAL (before review, round 1) HID: 14 ====
stdout:
secret-capture
==== TOOL RESULT (round 1) HID: 15 ====
approved line
==== PROMPT ====
continue from the approved line
";
        let prepared = prepare_provider_prompt(prompt);
        assert!(
            !prepared.text.contains("secret-capture"),
            "{}",
            prepared.text
        );
        assert!(!prepared.text.contains("before review"), "{}", prepared.text);
        assert!(!prepared.text.contains("HID: 14"), "{}", prepared.text);
        assert!(
            !prepared.text.contains(COMPACTED_MARKER),
            "{}",
            prepared.text
        );
        assert!(prepared.text.contains("approved line"), "{}", prepared.text);
        assert!(
            prepared.text.contains("continue from the approved line"),
            "{}",
            prepared.text
        );
        assert_eq!(prepared.withheld_previews, 1);
        assert_eq!(prepared.omitted_compacted, 0);
        assert!(prepared.notice().is_some());
    }

    #[test]
    fn a_capture_without_hid_is_omitted() {
        let prompt = "\
==== FETCH ORIGINAL (before review, round 2) ====
raw page
==== TOOL RESULT (round 2) ====
submitted page
";
        let prepared = prepare_provider_prompt(prompt);
        assert!(!prepared.text.contains("raw page"), "{}", prepared.text);
        assert!(
            !prepared.text.contains("before review"),
            "{}",
            prepared.text
        );
        assert!(
            prepared.text.contains("submitted page"),
            "{}",
            prepared.text
        );
        assert_eq!(prepared.withheld_previews, 1);
    }

    #[test]
    fn a_compacted_block_is_dropped_entirely() {
        let prompt = "\
==== TOOL CALL run_cmd (round 1) HID: 9 ====
[ctx compacted]
==== TOOL RESULT (round 1) HID: 10 ====
trimmed
";
        let prepared = prepare_provider_prompt(prompt);
        assert!(
            !prepared.text.contains(COMPACTED_MARKER),
            "{}",
            prepared.text
        );
        assert!(!prepared.text.contains("HID: 9"), "{}", prepared.text);
        assert!(prepared.text.contains("trimmed"), "{}", prepared.text);
        assert_eq!(prepared.omitted_compacted, 1);
        assert!(prepared.notice().is_some());
    }

    #[test]
    fn a_context_budget_block_is_kept_for_pacing() {
        let prompt = "\
==== CONTEXT BUDGET (round 3) ====
Context budget from the harness: the last request used 9 of 10 tokens.
==== RESPONSE (round 3) HID: 4 ====
done
==== PROMPT ====
next step
";
        let prepared = prepare_provider_prompt(prompt);
        assert!(prepared.text.contains("9 of 10"), "{}", prepared.text);
        assert!(prepared.text.contains("done"), "{}", prepared.text);
        assert!(
            prepared.text.contains("==== PROMPT ====\nnext step\n"),
            "{}",
            prepared.text
        );
        assert!(prepared.notice().is_none());
    }

    #[test]
    fn compacted_calls_between_memory_and_results_keep_pairing() {
        let prompt = "\
==== TOOL CALL project_mem (round 1) HID: 4 ====
{\"action\":\"set_hot\"}
==== TOOL CALL run_cmd (round 1) HID: 5 ====
[ctx compacted]
==== TOOL RESULT (round 1) HID: 6 ====
saved hot memory
==== TOOL RESULT (round 1) HID: 7 ====
/tmp
==== PROMPT ====
next
";
        let prepared = prepare_provider_prompt(prompt);
        assert_eq!(prepared.omitted_memory, 2, "{}", prepared.text);
        assert_eq!(prepared.omitted_compacted, 1, "{}", prepared.text);
        assert!(!prepared.text.contains("project_mem"), "{}", prepared.text);
        assert!(
            !prepared.text.contains("saved hot memory"),
            "{}",
            prepared.text
        );
        assert!(
            !prepared.text.contains(COMPACTED_MARKER),
            "{}",
            prepared.text
        );
        assert!(prepared.text.contains("/tmp"), "{}", prepared.text);
    }

    #[test]
    fn project_memory_actions_are_not_sent() {
        let prompt = "\
==== TOOL CALL run_cmd (round 1) HID: 4 ====
pwd
==== TOOL CALL project_mem (round 1) HID: 5 ====
{\"action\":\"set_hot\"}
==== TOOL RESULT (round 1) HID: 6 ====
/tmp
==== TOOL RESULT (round 1) HID: 7 ====
saved hot memory
==== PROMPT ====
next
";
        let prepared = prepare_provider_prompt(prompt);
        assert_eq!(prepared.omitted_memory, 2, "{}", prepared.text);
        assert!(prepared.text.contains("pwd"), "{}", prepared.text);
        assert!(prepared.text.contains("/tmp"), "{}", prepared.text);
        assert!(!prepared.text.contains("project_mem"), "{}", prepared.text);
        assert!(!prepared.text.contains("saved hot memory"), "{}", prepared.text);
        assert!(prepared.notice().unwrap().contains("project memory"));
    }

    #[test]
    fn the_draft_is_not_rewritten_even_if_it_mentions_a_capture() {
        let prompt = "\
==== TOOL RESULT (round 1) HID: 2 ====
kept
==== PROMPT ====
Please look at the before review notes I pasted: secret-draft
";
        let prepared = prepare_provider_prompt(prompt);
        assert_eq!(prepared.text, prompt);
        assert!(prepared.text.contains("secret-draft"));
    }
}
