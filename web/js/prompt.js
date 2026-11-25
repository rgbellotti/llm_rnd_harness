// prompt.js — the expanding prompt box: auto-fit, counters, clipboard
// copy, Save, and file upload with ==== delimiters. Ctrl+V still pastes.
// Single source of truth: the box mirrors into the session on every edit.
// Needs core.js, tabs.js. download() arrives later in storage.js.
// --- Prompt-box clip ---------------------------------------------------
// Long prompts (a continued session assembles hundreds of lines) clip the
// textarea to 8 scrollable lines by default, with an always-visible
// head-strip toggle next to the box. Editing still works: the box scrolls
// under the caret and the whole value stays intact.
let promptClipped = true;
function promptIsLong(v) { return (v || '').split('\n').length > PROMPT_CLIP_LINES; }
function fitPromptBox() {
    const box = document.getElementById('prompt');
    const strip = document.getElementById('promptClipStrip');
    const btn = document.getElementById('clipPromptBtn');
    // The side lane is the wide curation view: the box fills that tile
    // instead of clipping to eight lines.
    const docked = document.body && document.body.classList && document.body.classList.contains('prompt-docked');
    if (docked) {
        if (strip) strip.style.display = 'none';
        if (box.classList) box.classList.remove('prompt-clipped');
        box.style.overflowY = 'auto';
        box.style.height = 'auto';
        return;
    }
    if (promptIsLong(box.value)) {
        if (strip) strip.style.display = '';
        if (btn) btn.textContent = promptClipped ? 'show full prompt' : 'clip prompt (8 lines)';
        if (promptClipped) {
            box.classList.add('prompt-clipped');
            box.style.height = '';
            box.style.overflowY = '';
            return;
        }
        box.classList.remove('prompt-clipped');
    } else {
        if (strip) strip.style.display = 'none';
        box.classList.remove('prompt-clipped');
    }
    box.style.overflowY = 'hidden';
    box.style.height = 'auto';
    box.style.height = box.scrollHeight + 'px';
}
document.getElementById('clipPromptBtn').onclick = () => {
    promptClipped = !promptClipped;
    fitPromptBox();
};
function updatePromptCount() {
    const v = document.getElementById('prompt').value || '';
    const lines = v === '' ? 0 : v.split('\n').length;
    document.getElementById('editorCount').textContent =
        v.length + ' chars · ' + lines + ' lines';
}
function refreshPromptBox() {
    fitPromptBox();
    updatePromptCount();
}
document.getElementById('prompt').addEventListener('input', () => {
    // The box is the source of truth while composing: mirror it into
    // the session so tab switches, renders, and restores never wipe
    // unsent text (e.g. toggling expand right after uploading).
    commitComposerEdit();
    schedulePromptSnapshot();
});
function mirrorPromptToSession() {
    const box = document.getElementById('prompt');
    const value = box ? (box.value || '') : '';
    const s = typeof activeSession === 'function' ? activeSession() : null;
    if (s && s.status === 'fresh') {
        s.prompt = value;
        if (typeof persistDebounced === 'function') persistDebounced();
        return;
    }
    // A finished chain keeps its submitted prompt. Edits stay in the
    // composer until New tab or Generate opens a fresh one.
    if (typeof composerDraft !== 'undefined') composerDraft = value;
}
function commitComposerEdit() {
    mirrorPromptToSession();
    if (typeof syncPromptUI === 'function') syncPromptUI();
    else if (typeof refreshPromptBox === 'function') refreshPromptBox();
}
const CTX_COMPACTED = '[ctx compacted]';
let lastProviderPrune = { previews: 0, compacted: 0, memory: 0 };
function providerPruneNote() {
    const parts = [];
    if (lastProviderPrune.previews || lastProviderPrune.compacted) {
        parts.push('Before-review captures and [ctx compacted] blocks are omitted from the provider copy. Their HIDs skip; the history view keeps everything.');
    }
    if (lastProviderPrune.memory) {
        parts.push('Project memory actions were omitted. The hot block is injected separately.');
    }
    return parts.length ? (' ' + parts.join(' ')) : '';
}
function isContextHeaderLine(line) {
    return line.startsWith('==== ') && line.endsWith(' ====') && line.length > '====  ===='.length;
}
function splitProviderDraft(text) {
    const marker = '==== PROMPT ====';
    const idx = text.lastIndexOf(marker);
    if (idx < 0) return { head: text, tail: '' };
    if (idx > 0 && text.charAt(idx - 1) !== '\n') return { head: text, tail: '' };
    const after = text.slice(idx + marker.length);
    if (after.indexOf('==== ') >= 0) return { head: text, tail: '' };
    return { head: text.slice(0, idx).replace(/[\n\r]+$/, ''), tail: text.slice(idx) };
}
function joinProviderHeadTail(head, tail) {
    if (!tail) return head;
    if (!head) return tail;
    let out = head;
    if (!out.endsWith('\n')) out += '\n';
    if (!out.endsWith('\n\n')) out += '\n';
    return out + tail;
}
function pruneProviderChain(text, counts) {
    const src = String(text || '');
    const starts = [];
    let offset = 0;
    const lines = src.split(/(\n)/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].replace(/\r$/, '');
        if (isContextHeaderLine(line)) starts.push(offset);
        offset += lines[i].length;
    }
    if (!starts.length) return src;
    let out = starts[0] > 0 ? src.slice(0, starts[0]) : '';
    for (let i = 0; i < starts.length; i++) {
        const start = starts[i];
        const end = i + 1 < starts.length ? starts[i + 1] : src.length;
        const block = src.slice(start, end);
        const nl = block.indexOf('\n');
        const header = nl < 0 ? block : block.slice(0, nl + 1);
        const body = nl < 0 ? '' : block.slice(nl + 1);
        if (header.indexOf('TOOL CALL project_mem') >= 0) {
            counts.memory = (counts.memory || 0) + 1;
            if (!counts.pendingCalls) counts.pendingCalls = [];
            counts.pendingCalls.push(true);
            continue;
        }
        if (header.indexOf('TOOL CALL ') >= 0) {
            if (!counts.pendingCalls) counts.pendingCalls = [];
            counts.pendingCalls.push(false);
        }
        if (header.indexOf('TOOL RESULT') >= 0) {
            const pending = counts.pendingCalls || [];
            const memoryResult = pending.length ? pending.shift() : false;
            if (memoryResult) {
                counts.memory = (counts.memory || 0) + 1;
                continue;
            }
        }
        // A block the person compacted during curation is withheld. The
        // provider copy drops it entirely — the marker never reaches the
        // model. The box keeps it for HID recall.
        if (body.trim() === CTX_COMPACTED) {
            counts.compacted = (counts.compacted || 0) + 1;
            continue;
        }
        // Raw originals never reach the model, even pasted by hand.
        if (header.indexOf('before review') >= 0) {
            counts.previews = (counts.previews || 0) + 1;
            continue;
        }
        out += block;
    }
    return out;
}
function pruneProviderPrompt(text) {
    const src = String(text || '');
    const split = splitProviderDraft(src);
    const counts = { previews: 0, compacted: 0, memory: 0 };
    const pruned = pruneProviderChain(split.head, counts);
    lastProviderPrune = counts;
    if (!counts.previews && !counts.compacted && !counts.memory) return src;
    return joinProviderHeadTail(pruned, split.tail);
}
let lastCompactMiss = 0;
function contextHeader(label, hid) {
    const n = Number(hid);
    return (n > 0) ? ('==== ' + label + ' HID: ' + Math.floor(n) + ' ====') : ('==== ' + label + ' ====');
}
function compactBody(compact, kind, hid, text) {
    if (!compact || !compact[kind]) return text;
    if (!(Number(hid) > 0)) { lastCompactMiss += 1; return text; }
    return CTX_COMPACTED;
}
function hidAbove(text, index) {
    const head = String(text || '').slice(0, index);
    const marks = head.match(/HID:\s*(\d+)/g);
    if (!marks || !marks.length) return 0;
    const n = Number(marks[marks.length - 1].replace(/HID:\s*/, ''));
    return n > 0 ? n : 0;
}
function blockSpanAt(text, index) {
    const src = String(text || '');
    const before = src.slice(0, index);
    let headerAt = before.lastIndexOf('==== ');
    while (headerAt > 0 && src.charAt(headerAt - 1) !== '\n') {
        headerAt = src.lastIndexOf('==== ', headerAt - 1);
    }
    if (headerAt < 0) return null;
    if (headerAt > 0 && src.charAt(headerAt - 1) !== '\n') return null;
    const headerEnd = src.indexOf('\n', headerAt);
    if (headerEnd < 0) return null;
    const next = src.indexOf('\n==== ', headerEnd);
    return { headerStart: headerAt, headerEnd: headerEnd, bodyStart: headerEnd + 1, bodyEnd: next < 0 ? src.length : next };
}
function historyEventBody(doc) {
    const payload = (doc && doc.payload) || {};
    const tag = (doc && doc.comment_tag) || '';
    const show = (value) => (typeof maskCommentTags === 'function' ? maskCommentTags(value, tag) : (value == null ? '' : String(value)));
    const type = (doc && doc.type) || '';
    if (type === 'tool_result') return show(contextToolOutput(payload.output || ''));
    if (type === 'tool_preview') {
        const preview = { name: payload.name, output: payload.output };
        const body = typeof previewContextText === 'function' ? previewContextText(preview) : (payload.output || '');
        return show(body);
    }
    if (type === 'tool_call') {
        try { return JSON.stringify(payload.arguments, null, 2); } catch (e) { return String(payload.arguments); }
    }
    if (type === 'prompt' || type === 'thinking_delta' || type === 'thinking' || type === 'content_delta' || type === 'content') {
        return show(payload.text || '');
    }
    if (payload.output != null) return show(String(payload.output));
    if (payload.text != null) return show(String(payload.text));
    if (payload.message != null) return show(String(payload.message));
    try { return JSON.stringify(payload, null, 2); } catch (e) { return ''; }
}
function replacePromptRange(box, start, end, insert, status) {
    const value = box.value || '';
    if (!writePromptSnapshot(value)) {
        setStatus('Could not save a restore copy. The prompt was left in place.');
        return false;
    }
    box.value = value.slice(0, start) + insert + value.slice(end);
    const at = start + insert.length;
    if (box.selectionStart != null) { box.selectionStart = at; box.selectionEnd = at; }
    commitComposerEdit();
    setStatus(status);
    return true;
}
async function recallCompactedRange(box, start, end) {
    const hid = hidAbove(box.value || '', start);
    if (!hid) { setStatus('No HID above this marker. The body cannot be recalled.'); return; }
    if (typeof apiFetch !== 'function') { setStatus('History recall is not available on this screen.'); return; }
    setStatus('Recalling history event ' + hid + '…');
    try {
        const res = await apiFetch('/history/events/' + hid);
        if (!res.ok) throw new Error((await res.text()) || ('HTTP ' + res.status));
        const doc = await res.json();
        const body = historyEventBody(doc);
        replacePromptRange(box, start, end, body, 'Restored history event ' + hid + '.');
    } catch (err) {
        setStatus('Could not recall HID ' + hid + ': ' + (err && err.message ? err.message : err));
    }
}
function compactPromptSelection() {
    const box = typeof promptBoxEditable === 'function' ? promptBoxEditable() : document.getElementById('prompt');
    if (!box) { setStatus('The prompt box is not available on this screen.'); return; }
    const value = box.value || '';
    if (!value) { setStatus('The prompt is empty.'); return; }
    let start = box.selectionStart == null ? value.length : box.selectionStart;
    let end = box.selectionEnd == null ? start : box.selectionEnd;
    if (start > end) { const swap = start; start = end; end = swap; }
    if (start !== end) {
        const selected = value.slice(start, end);
        if (selected.trim() === CTX_COMPACTED) { recallCompactedRange(box, start, end); return; }
        const hid = hidAbove(value, start);
        const note = hid
            ? 'Replaced the selection with [ctx compacted]. HID ' + hid + ' still addresses the body.'
            : 'Replaced the selection with [ctx compacted]. No HID above it — this drop cannot be recalled.';
        replacePromptRange(box, start, end, CTX_COMPACTED, note);
        return;
    }
    const span = blockSpanAt(value, start);
    if (!span) { setStatus('Select the text to compact, or place the cursor in a context block.'); return; }
    const body = value.slice(span.bodyStart, span.bodyEnd).replace(/\s+$/, '');
    if (body === CTX_COMPACTED) { recallCompactedRange(box, span.bodyStart, span.bodyStart + CTX_COMPACTED.length); return; }
    const hid = hidAbove(value, span.bodyStart);
    if (!hid) { setStatus('This block has no HID. Left the body in place so the drop stays recallable.'); return; }
    const insert = CTX_COMPACTED + (span.bodyEnd < value.length && value.charAt(span.bodyEnd) === '\n' ? '' : '\n');
    replacePromptRange(box, span.bodyStart, span.bodyEnd, CTX_COMPACTED + '\n', 'Compacted the block at HID ' + hid + '. Restore can put the prompt back.');
}
document.getElementById('compactPromptBtn').onclick = () => compactPromptSelection();
function savePromptAs() {
    const box = document.getElementById('prompt');
    const text = box ? (box.value || '') : '';
    if (!text) { setStatus('The prompt is empty.'); return; }
    const selector = (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function')
        ? window.showSaveFilePicker : null;
    if (selector) {
        selector({
            suggestedName: 'prompt.txt',
            types: [{ description: 'Text', accept: { 'text/plain': ['.txt'] } }]
        }).then(handle => handle.createWritable()).then(writable => {
            return writable.write(text).then(() => writable.close());
        }).then(() => {
            setStatus('Saved the prompt.');
        }).catch(e => {
            if (e && e.name === 'AbortError') return;
            if (typeof download === 'function') {
                download('prompt.txt', text, 'text/plain;charset=utf-8');
                setStatus('Saved the prompt.');
                return;
            }
            setStatus('Could not save the prompt.');
        });
        return;
    }
    if (typeof download === 'function') {
        download('prompt.txt', text, 'text/plain;charset=utf-8');
        setStatus('Saved the prompt.');
        return;
    }
    setStatus('Could not save the prompt.');
}
const savePromptBtn = document.getElementById('savePromptBtn');
if (savePromptBtn) savePromptBtn.onclick = savePromptAs;
// One prompt snapshot. Autosave and Clear write it. Restore puts it back
// and leaves it stored. The key name stays so an older clear is still readable.
const PROMPT_UNDO_KEY = 'harness.prompt.undo';
const PROMPT_AUTOSAVE_KEY = 'harness.prompt.autosave';
const PROMPT_SNAPSHOT_MS = 3000;
let promptSnapshotT = null;
function promptAutosaveEnabled() {
    try {
        if (typeof localStorage !== 'undefined' && localStorage.getItem(PROMPT_AUTOSAVE_KEY) === '0') return false;
    } catch (e) {}
    return true;
}
function setPromptAutosave(on) {
    const enabled = !!on;
    try {
        if (typeof localStorage !== 'undefined' && localStorage.setItem) {
            localStorage.setItem(PROMPT_AUTOSAVE_KEY, enabled ? '1' : '0');
        }
    } catch (e) {}
    if (!enabled && promptSnapshotT && typeof clearTimeout === 'function') {
        clearTimeout(promptSnapshotT);
        promptSnapshotT = null;
    }
}
function promptBoxEditable() {
    if (typeof runningSid !== 'undefined' && runningSid !== null) {
        setStatus('A run is active. Stop it before changing the prompt.');
        return null;
    }
    const s = typeof activeSession === 'function' ? activeSession() : null;
    if (s && s.status === 'running') {
        setStatus('A run is active. Stop it before changing the prompt.');
        return null;
    }
    const box = document.getElementById('prompt');
    if (!box || box.disabled) {
        setStatus('The prompt box is not available on this screen.');
        return null;
    }
    return box;
}
function readPromptUndo() {
    try {
        if (typeof localStorage === 'undefined' || !localStorage.getItem) return '';
        return localStorage.getItem(PROMPT_UNDO_KEY) || '';
    } catch (e) { return ''; }
}
// An empty box must not erase a snapshot. Clear, Generate, and a fresh
// page all leave the last non-empty prompt in place.
function writePromptSnapshot(text) {
    if (!text) return false;
    try {
        if (typeof localStorage === 'undefined' || !localStorage.setItem) return false;
        if ((localStorage.getItem(PROMPT_UNDO_KEY) || '') === text) return true;
        localStorage.setItem(PROMPT_UNDO_KEY, text);
        return true;
    } catch (e) { return false; }
}
function flushPromptSnapshot() {
    if (!promptAutosaveEnabled()) return;
    const box = document.getElementById('prompt');
    const text = box ? (box.value || '') : '';
    if (!text) return;
    writePromptSnapshot(text);
}
function schedulePromptSnapshot() {
    if (!promptAutosaveEnabled()) return;
    if (typeof setTimeout !== 'function') {
        flushPromptSnapshot();
        return;
    }
    if (promptSnapshotT && typeof clearTimeout === 'function') clearTimeout(promptSnapshotT);
    promptSnapshotT = setTimeout(() => {
        promptSnapshotT = null;
        flushPromptSnapshot();
    }, PROMPT_SNAPSHOT_MS);
}
if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('pagehide', flushPromptSnapshot);
    window.addEventListener('visibilitychange', () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') flushPromptSnapshot();
    });
}
function clearPromptBox() {
    const box = promptBoxEditable();
    if (!box) return;
    const text = box.value || '';
    if (!text) { setStatus('Prompt is already empty.'); return; }
    if (!writePromptSnapshot(text)) {
        setStatus('Could not save a restore copy. The prompt was left in place.');
        return;
    }
    box.value = '';
    mirrorPromptToSession();
    refreshPromptBox();
    setStatus('Prompt cleared. Restore can put it back.');
}
function restorePromptBox() {
    const box = promptBoxEditable();
    if (!box) return;
    const saved = readPromptUndo();
    if (!saved) { setStatus('Nothing to restore.'); return; }
    box.value = saved;
    commitComposerEdit();
    setStatus('Restored the prompt.');
}
const clearPromptBtn = document.getElementById('clearPromptBtn');
if (clearPromptBtn) clearPromptBtn.onclick = () => clearPromptBox();
const restorePromptBtn = document.getElementById('restorePromptBtn');
if (restorePromptBtn) restorePromptBtn.onclick = () => restorePromptBox();
document.getElementById('uploadBtn').onclick = () => document.getElementById('fileInput').click();
function uploadMarkerName(name) {
    // The marker line is what the model parses. A filename containing a
    // quote or a newline could close the marker early and forge extra
    // structure out of the name, so those characters never reach it.
    // The name is data, not prose: keep it recognizable, bounded, and
    // marker-safe. Status messages still show the original name.
    return String(name == null ? '' : name)
        .replace(/['\r\n\x00-\x1f\x7f]/g, '_')
        .slice(0, 128);
}
document.getElementById('fileInput').addEventListener('change', async (e) => {
    const files = Array.prototype.slice.call(e.target.files || [], 0, UPLOAD_MAX_FILES);
    if (!files.length) return;
    const box = document.getElementById('prompt');
    const at = box.selectionStart == null ? box.value.length : box.selectionStart;
    let insert = '';
    const skipped = [];
    for (const f of files) {
        if (f.size > UPLOAD_MAX_BYTES) { skipped.push(f.name + ' (over 1MB)'); continue; }
        let text = '';
        try { text = await f.text(); }
        catch (err) { skipped.push(f.name + ' (unreadable)'); continue; }
        if (text.indexOf('\0') >= 0) { skipped.push(f.name + ' (binary, not text)'); continue; }
        const safeName = uploadMarkerName(f.name);
        insert += '---- Uploaded File \'' + safeName + '\' ----\n' + text.replace(/\n+$/, '')
            + '\n---- EOF \'' + safeName + '\' ----\n';
    }
    if (insert) {
        box.value = box.value.slice(0, at) + insert + box.value.slice(at);
        // Mirror BEFORE expanding: setPromptExpanded re-renders,
        // which reloads the box from the session — expanding first
        // would wipe big inserts (the >12-line path) back to stale.
        commitComposerEdit();
        // Big inserts deserve the big box: expand so the text shows
        // at full display size instead of hiding behind a scrollbar.
        if (box.value.split('\n').length > 12 && typeof setPromptExpanded === 'function') setPromptExpanded(true);
    }
    e.target.value = '';
    const done = files.length - skipped.length;
    setStatus('Inserted ' + done + ' file(s) into the prompt.'
        + (skipped.length ? ' Skipped: ' + skipped.join(', ') + '.' : '')
        + ' Review and prune before sending.');
});
// Drop a trailing status line written by older builds. Current tools
// keep that status on the history event instead of in the output.
function contextToolOutput(text) {
    const body = text == null ? '' : String(text);
    return body.replace(/\nexit code: -?\d+ \(\d+ ms\)\s*$/, '');
}
function roundPlainText(s, n, compact, opts) {
    if (!s) return '';
    const omitMemory = !!(opts && opts.omitMemory);
    // `full` is the export/history mode: before-review originals ride
    // along. The model-bound lineage (the default, used by Continue,
    // Compact continue, and Curate) omits them entirely — the model
    // only ever sees the one current tool call and the one final tool
    // result per step.
    const full = !!(opts && opts.full);
    const show = (text) => (typeof displaySessionText === 'function' ? displaySessionText(s, text) : (text == null ? '' : String(text)));
    const rounds = s.data && s.data.rounds;
    const r = (rounds && rounds[n]) || {};
    let out = '';
    if (r.thinking) out += contextHeader('THINKING (round ' + n + ')', r.thinkingHid) + '\n' + compactBody(compact, 'thinking', r.thinkingHid, show(r.thinking)) + '\n';
    if (r.content) out += contextHeader('RESPONSE (round ' + n + ')', r.contentHid) + '\n' + show(r.content) + '\n';
    for (const tc of (r.toolCalls || [])) {
        if (omitMemory && tc && tc.name === 'project_mem') continue;
        let args = '';
        try { args = JSON.stringify(tc.arguments, null, 2); } catch (e) { args = String(tc.arguments); }
        // The person may have replaced the command (or timeout) in the
        // approval dialog. The model is sent the call that actually ran:
        // one block, the current version, so the result that follows is
        // explained. History keeps both versions.
        if (tc && (tc.commandEdited || tc.limitEdited)) {
            let obj = {};
            try {
                const parsed = JSON.parse(JSON.stringify(tc.arguments));
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed;
            } catch (e) { obj = {}; }
            if (tc.commandEdited) obj.command = tc.chosenCommand;
            if (tc.limitEdited) obj.timeout = tc.chosenTimeout;
            try { args = JSON.stringify(obj, null, 2); } catch (e) { args = String(obj); }
        }
        out += contextHeader('TOOL CALL ' + tc.name + ' (round ' + n + ')', tc.hid) + '\n' + compactBody(compact, 'call', tc.hid, args) + '\n';
    }
    if (full) {
        for (const preview of (r.toolPreviews || [])) {
            const previewBody = (typeof previewContextText === 'function')
                ? previewContextText(preview)
                : (preview && preview.output != null ? preview.output : '');
            const label = (typeof originalPreviewLabel === 'function') ? originalPreviewLabel(preview.name) : (preview.name || '');
            out += contextHeader(label + ' (before review, round ' + n + ')', preview.hid) + '\n' + compactBody(compact, 'preview', preview.hid, show(previewBody)) + '\n';
        }
    }
    for (const tr of (r.toolResults || [])) {
        if (omitMemory && tr && tr.name === 'project_mem') continue;
        // Exit status stays out of this transcript. History shows it
        // as its own line, and the result heading already shows the
        // duration. Older rows may still end with "exit code: N (N ms)";
        // that trailer is dropped here so a continuation does not put
        // it back into the next prompt. The launch marker is translated
        // here so a built context or an export shows the comment as
        // user_comment.
        out += contextHeader('TOOL RESULT (round ' + n + ')', tr.hid) + '\n' + compactBody(compact, 'result', tr.hid, show(contextToolOutput(tr.output))) + '\n';
    }
    // The sentence the harness appended to the next model request.
    // Metrics stay out of this transcript; this line is the fill mark,
    // kept so a later reader can see how much text crossed that percent.
    // Budget notifications are part of the model lineage: they tell the
    // model how to pace the task against the context window.
    const budgets = r.contextBudgets || [];
    for (let i = 0; i < budgets.length; i++) {
        const line = show(budgets[i]);
        if (!String(line).trim()) continue;
        out += contextHeader('CONTEXT BUDGET (round ' + n + ')') + '\n' + line + '\n';
    }
    // NOTE: METRICS and TOTALS are deliberately excluded here.
    // Token counts and wall times are efficiency metadata for
    // exports/archives, not model-bound context. The context-budget
    // block above is the sentence the harness sent the model.
    return out;
}
function rootDraftNote(s) {
    if (!sessionHasRootOutput(s)) return '';
    return ' This draft includes root output — prune it before sending.';
}
function sessionHasRootOutput(s) {
    const rounds = s && s.data && s.data.rounds;
    if (!rounds) return false;
    const withheld = 'Root output withheld from history by the reviewer.';
    for (const key of Object.keys(rounds)) {
        const round = rounds[key] || {};
        if ((round.toolResults || []).some(item => item && item.name === 'run_sudo_cmd')) return true;
        if ((round.toolCalls || []).some(item => item && item.name === 'run_sudo_cmd') && (round.toolResults || []).some(item => item && item.name === 'run_sudo_cmd')) return true;
        if ((round.toolPreviews || []).some(item => item && item.name === 'run_sudo_cmd' && !item.provisional && item.output && item.output !== withheld)) return true;
    }
    return false;
}
function sessionToPlainText(s, compact, opts) {
    if (!s) return '';
    lastCompactMiss = 0;
    const show = (text) => (typeof displaySessionText === 'function' ? displaySessionText(s, text) : (text == null ? '' : String(text)));
    let out = contextHeader('PROMPT', s.promptHid) + '\n' + show(s.prompt || '') + '\n';
    const order = (s.data && s.data.order) || [];
    for (const n of order) out += roundPlainText(s, n, compact, opts);
    return out;
}
function compactDegree(name) {
    if (name === 'results') return { result: 1 };
    if (name === 'calls') return { result: 1, call: 1 };
    return { result: 1, call: 1, thinking: 1 };
}
function continueCompacted(degree, source, note) {
    const s = source || (typeof activeSession === 'function' ? activeSession() : null);
    if (!s) { setStatus('No active tab to build from.'); return; }
    const load = typeof withFullSession === 'function' ? withFullSession : (session, fn) => fn(session);
    load(s, full => {
        const text = sessionToPlainText(full, compactDegree(degree), { omitMemory: true });
        const miss = lastCompactMiss
            ? (' ' + lastCompactMiss + ' block(s) had no history id and were left intact.')
            : '';
        continueInNewSession(text, s.id, (note || 'Compacted context') + miss);
    });
}
// A prompt the user is still writing sits under the last ==== PROMPT ====
// header. Curated blocks land above that header so the draft stays put.
function splitDraftPrompt(value) {
    const src = String(value || '').replace(/\s+$/, '');
    const marker = '==== PROMPT ====';
    const idx = src.lastIndexOf(marker);
    if (idx < 0) return null;
    if (idx > 0 && src.charAt(idx - 1) !== '\n') return null;
    const after = src.slice(idx + marker.length);
    if (after.indexOf('==== ') >= 0) return null;
    return { before: src.slice(0, idx).replace(/\s+$/, ''), draft: after.replace(/^\n/, '') };
}
function withoutTrailingPrompt(text) {
    return String(text || '').replace(/\n*==== PROMPT ====\s*$/, '').replace(/\s+$/, '');
}
function appendCurated(block) {
    if (typeof runningSid !== 'undefined' && runningSid !== null) {
        setStatus('A run is active. Stop it before adding to the prompt.');
        return;
    }
    const piece = String(block || '').replace(/\s+$/, '');
    if (!piece) { setStatus('Nothing to add to the prompt.'); return; }
    let s = typeof activeSession === 'function' ? activeSession() : null;
    let created = false;
    if (!s || s.status !== 'fresh') {
        if (typeof createSession !== 'function') { setStatus('Nothing to add to the prompt.'); return; }
        createSession();
        created = true;
        s = typeof activeSession === 'function' ? activeSession() : s;
    }
    const box = document.getElementById('prompt');
    if (!box) return;
    const value = created ? '' : (box.value || '');
    const split = splitDraftPrompt(value);
    if (split) {
        const head = split.before;
        const body = withoutTrailingPrompt(piece);
        box.value = (head ? head + '\n\n' : '') + body + '\n\n==== PROMPT ====\n' + split.draft;
    } else if (!String(value).trim()) {
        box.value = piece + (piece.endsWith('\n') ? '' : '\n');
    } else {
        box.value = String(value).replace(/\s+$/, '') + '\n\n' + piece + '\n';
    }
    if (typeof mirrorPromptToSession === 'function') mirrorPromptToSession();
    const long = String(box.value).split('\n').length > 12;
    if (long && typeof setPromptExpanded === 'function') setPromptExpanded(true);
    else if (typeof refreshPromptBox === 'function') refreshPromptBox();
    // A wide screen keeps history on the right and the prompt on the left.
    // A narrow screen leaves history so the appended prompt is visible.
    const keepHistory = typeof historyActive !== 'undefined' && historyActive
        && typeof promptLaneWide === 'function' && promptLaneWide();
    if (keepHistory) {
        if (typeof reopenHistoryPane === 'function') reopenHistoryPane();
    } else if (!created && typeof historyActive !== 'undefined' && historyActive && s && typeof showSession === 'function') {
        showSession(s.id);
    }
    setStatus('Added to the prompt. Prune before sending.' + providerPruneNote());
}
function curateSelection() {
    lastProviderPrune = { previews: 0, compacted: 0, memory: 0 };
    const text = (typeof pageSelectionText === 'function' ? pageSelectionText() : '').trim();
    if (!text) { setStatus('Nothing selected.'); return; }
    appendCurated(text);
}
function curateRound(s, n) {
    const load = (full) => {
        const text = pruneProviderPrompt(roundPlainText(full, n));
        if (!String(text).trim()) { setStatus('Nothing to add to the prompt.'); return; }
        appendCurated(text);
    };
    if (s && s.data && s.data.rounds && s.data.rounds[n] && String(roundPlainText(s, n)).trim()) load(s);
    else if (typeof withFullSession === 'function') withFullSession(s, load);
    else load(s);
}
function curateResponse(s, n) {
    const load = (full) => {
        const rounds = full && full.data && full.data.rounds;
        const r = (rounds && rounds[n]) || {};
        const show = (text) => (typeof displaySessionText === 'function' ? displaySessionText(full, text) : (text == null ? '' : String(text)));
        if (!r.content) { setStatus('Nothing to add to the prompt.'); return; }
        appendCurated('==== RESPONSE (round ' + n + ') ====\n' + show(r.content) + '\n');
    };
    if (s && s.data && s.data.rounds && s.data.rounds[n] && s.data.rounds[n].content) load(s);
    else if (typeof withFullSession === 'function') withFullSession(s, load);
    else load(s);
}
function curatePromptText(s) {
    if (!s) return;
    const show = (text) => (typeof displaySessionText === 'function' ? displaySessionText(s, text) : (text == null ? '' : String(text)));
    const text = show(s.prompt || '');
    if (!String(text).trim()) { setStatus('Nothing to add to the prompt.'); return; }
    appendCurated('==== PROMPT ====\n' + text + '\n');
}
function curateActiveSession() {
    const s = typeof activeSession === 'function' ? activeSession() : null;
    if (!s) { setStatus('No active tab to add.'); return; }
    const load = (full) => {
        const text = sessionToPlainText(full);
        if (!String(text).trim()) { setStatus('Nothing to add to the prompt.'); return; }
        appendCurated(continuationPrompt(text));
    };
    if (typeof withFullSession === 'function') withFullSession(s, load);
    else load(s);
}
// A windowed chain keeps only the rounds on screen. Export and continue
// stay synchronous when every round is still in memory; otherwise the full
// transcript is read from session history first.
function withFullSession(s, fn) {
    if (typeof sessionNeedsFullHistory === 'function' && sessionNeedsFullHistory(s) && typeof fullSession === 'function') {
        fullSession(s).then(fn).catch(err => setStatus('Could not load the full transcript: ' + (err && err.message ? err.message : err)));
        return;
    }
    fn(s);
}
function exportPlainText() {
    const s = activeSession();
    if (!s) { setStatus('No active tab to export.'); return; }
    withFullSession(s, full => {
        if (typeof download === 'function') download('harness-tab-' + s.num + '.txt', sessionToPlainText(full, null, { full: true }), 'text/plain');
        exportDirty = false;
    });
}
// --- Continue targets -------------------------------------------------
// The plain-text chain assembled from a source travels identically in
// both cases (sessionToPlainText); only the destination differs. Shared
// tail: land the assembled context in the prompt of the new tab.
// Context carried across the clear-confirm: non-empty means the overlay's
// Yes button clears AND continues with this text.
let pendingContinuation = '';
function setClearOverlayHint(text) {
    const p = document.querySelector('#clearOverlay p.hint');
    if (p) p.textContent = text;
}
function resetClearHint() {
    setClearOverlayHint('Are you sure you want to clear the session? The session data hasn\'t been exported yet — all tabs and their prompt/response history will be discarded.');
}
// Assembled context ends with a fresh ==== PROMPT ==== header so the
// user's next prompt reads as its own section — across continued
// sessions the model sees each step cleanly delineated in one run.
function continuationPrompt(out) {
    const base = pruneProviderPrompt(out || '').replace(/\s+$/, '');
    return base + '\n\n==== PROMPT ====\n';
}
function applyContinuation(out) {
    const ns = activeSession();
    const box = document.getElementById('prompt');
    box.value = continuationPrompt(out);
    mirrorPromptToSession();
    refreshPromptBox();
    setPromptExpanded(true);
    exportDirty = false;
    return ns;
}
function otherUnexportedTabs(sourceSid) {
    // The source's own content travels inside the continuation prompt;
    // only sibling tabs with unexported work would actually be lost.
    return sessions.some(t => t.id !== sourceSid
        && ((t.prompt || '').trim() !== '' || t.data.order.length > 0));
}
// Layered: existing tabs stay untouched, the context opens in a new one.
function continueInNewTab() {
    const s = activeSession();
    if (!s) { setStatus('No active tab to build from.'); return; }
    if (runningSid !== null) return;
    withFullSession(s, full => {
        if (runningSid !== null) return;
        const out = sessionToPlainText(full, null, { omitMemory: true });
        const fromNum = s.num;
        createSession();
        const ns = applyContinuation(out);
        setStatus('Context assembled from tab #' + fromNum + ' into tab #' + ns.num + ' — prune before sending.' + providerPruneNote() + rootDraftNote(full));
        renderTabBar();
    });
}
// Fresh workspace: current tabs are cleared so the follow-up run is a
// clean, standalone delineation in the history db. Sibling tabs holding
// unexported work get the standard clear-confirm before anything is
// discarded; the source's content rides inside the assembled prompt.
function continueInNewSession(out, sourceSid, note) {
    if (runningSid !== null) {
        setStatus('A run is active — stop it before continuing elsewhere.');
        return;
    }
    if (out === undefined) {
        const s = activeSession();
        if (!s) { setStatus('No active tab to build from.'); return; }
        withFullSession(s, full => continueInNewSession(sessionToPlainText(full, null, { omitMemory: true }), s.id, 'Context assembled from tab #' + s.num));
        return;
    }
    if (otherUnexportedTabs(sourceSid) && exportDirty) {
        pendingContinuation = out;
        setClearOverlayHint('Are you sure you want to clear the session? Existing tabs are discarded — but the assembled context is carried into the new session. Unexported work in other tabs cannot be recovered.');
        document.getElementById('clearOverlay').style.display = 'flex';
        return;
    }
    const rootNote = (typeof getSession === 'function' && sourceSid) ? rootDraftNote(getSession(sourceSid)) : '';
    doClearSession();
    const ns = applyContinuation(out);
    setStatus((note || 'Context assembled') + ' into a fresh session (tab #' + ns.num + ') — prune before sending.' + providerPruneNote() + rootNote);
    renderTabBar();
}
function continueSession() { continueInNewSession(); }
function bindCompactContinue() {
    const wire = (id, degree) => {
        const btn = document.getElementById(id);
        if (btn) btn.onclick = () => continueCompacted(degree);
    };
    wire('compactResultsBtn', 'results');
    wire('compactCallsBtn', 'calls');
    wire('compactCapturesBtn', 'captures');
    wire('compactBulkyBtn', 'bulky');
}
bindCompactContinue();
const curateSessionBtn = document.getElementById('curateSessionBtn');
if (curateSessionBtn) curateSessionBtn.onclick = () => curateActiveSession();
function closeExportMenus() {
    if (!document.querySelectorAll) return;
    const pops = document.querySelectorAll('.export-pop');
    for (let i = 0; i < pops.length; i++) {
        pops[i].hidden = true;
        const parent = pops[i].parentNode;
        const toggle = parent && parent.querySelector ? parent.querySelector('.export-toggle') : null;
        if (toggle && toggle.setAttribute) toggle.setAttribute('aria-expanded', 'false');
    }
}
function bindExportMenu(menu) {
    if (!menu || menu._exportBound || !menu.querySelector) return;
    const btn = menu.querySelector('.export-toggle');
    const pop = menu.querySelector('.export-pop');
    if (!btn || !pop) return;
    menu._exportBound = true;
    btn.onclick = (ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        const open = !!pop.hidden;
        closeExportMenus();
        pop.hidden = !open;
        if (btn.setAttribute) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    if (pop.addEventListener) {
        pop.addEventListener('click', (ev) => {
            const target = ev && ev.target;
            if (target && target.closest && target.closest('button')) closeExportMenus();
        });
    }
}
function exportMenu(items, label) {
    const wrap = document.createElement('div');
    wrap.className = 'export-menu';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'export-toggle';
    btn.textContent = label || 'Export';
    if (label) btn.title = label === 'Compact continue'
        ? 'Continue as a compacted session. Headers keep HID. Chosen bodies become [ctx compacted].'
        : (btn.title || '');
    if (btn.setAttribute) {
        btn.setAttribute('aria-haspopup', 'true');
        btn.setAttribute('aria-expanded', 'false');
    }
    const pop = document.createElement('div');
    pop.className = 'export-pop';
    pop.hidden = true;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const choice = document.createElement('button');
        choice.type = 'button';
        choice.textContent = item.label;
        if (item.title) choice.title = item.title;
        choice.onclick = () => { if (item.onclick) item.onclick(); };
        pop.appendChild(choice);
    }
    wrap.appendChild(btn);
    wrap.appendChild(pop);
    bindExportMenu(wrap);
    return wrap;
}
function installExportMenus() {
    if (!document.querySelectorAll) return;
    const menus = document.querySelectorAll('.export-menu');
    for (let i = 0; i < menus.length; i++) bindExportMenu(menus[i]);
    if (document.addEventListener && !installExportMenus.bound) {
        installExportMenus.bound = true;
        document.addEventListener('click', (ev) => {
            const target = ev && ev.target;
            if (target && target.closest && target.closest('.export-menu')) return;
            closeExportMenus();
        });
    }
}
installExportMenus();
