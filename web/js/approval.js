// approval.js — the tool-approval modal: two-step alternate flow plus the
// /approve POST. Global (one run at a time); survives tab switches.
// Needs core.js, tabs.js.
// Same words as the config view. A quiet line at the top of every approval,
// and the same line again under an output review, where the text about to
// be submitted can carry sensitive data. The approve button stays unlabeled.
function cloudEgressLabel() {
    return 'CLOUD — prompts and tool outputs leave this machine';
}
function modelIsCloud() {
    return typeof cachedConfig !== 'undefined' && !!(cachedConfig && cachedConfig.model_cloud);
}
function applyCloudEgressLabel() {
    const cloud = modelIsCloud();
    const note = document.getElementById('approvalCloud');
    if (note) {
        note.textContent = cloud ? cloudEgressLabel() : '';
        note.style.display = cloud ? '' : 'none';
    }
    const submit = document.getElementById('webSubmit');
    if (submit) submit.textContent = (pendingReview && pendingReview.kind === 'relay')
        ? 'Submit output to model'
        : 'Approve & submit content';
    const foot = document.getElementById('approvalCloudFoot');
    if (!foot) return;
    const reviewing = submit && submit.style.display !== 'none';
    const showFoot = cloud && reviewing;
    foot.textContent = showFoot ? cloudEgressLabel() : '';
    foot.style.display = showFoot ? '' : 'none';
}
let pendingApprovalId = null;
let approvalBusy = false;
let pendingInteraction = null;
let pendingReview = null;
let questionControls = [];
// True after the open dialog has already been placed in the wide left pane.
// Later icon ticks must not pull the reader off the stderr tab.
let approvalWasDocked = false;
// Stage-one run_cmd can replace the shell text. The note is for the model.
let commandEditAvailable = false;
let pendingShellCommand = '';
let pendingFileDiff = null;
let commandDiffTimer = null;
let commandDiffGen = 0;
let acceptHint = '';
let pendingRound = null;
let pendingImageRegion = null;
// Crop-and-send on the selected region. False is the safe default:
// the full image is attached and the region is described in the tool
// result. True rides the approve POST only together with a region.
let pendingImageCrop = false;

// Approval text is model-controlled. Show bidi/control characters
// explicitly instead of letting the browser's bidi algorithm reorder a
// command or a source URL. Newlines and tabs in a raw command are kept
// visible; other C0/C1 controls are escaped.
function safeDisplay(value) {
    return String(value == null ? '' : value)
        .replace(/[\u202A-\u202E\u2066-\u2069\u200E\u200F]/g, ch =>
            '\\u' + ch.codePointAt(0).toString(16).padStart(4, '0'))
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ch =>
            '\\u' + ch.codePointAt(0).toString(16).padStart(4, '0'));
}

function paintApprovalCommand(ev) {
    const cmd = document.getElementById('approvalCmd');
    const hasCommand = ev.arguments && typeof ev.arguments.command === 'string';
    if (hasCommand && typeof paintShellView === 'function') {
        // Dual view: the pretty command by default, the byte-identical
        // raw composition one click away. The submitted payload and the
        // Edit Command box use the raw command regardless of the view.
        paintShellView(cmd, approvalCommandText(ev), approvalCommandText(ev, true));
        return;
    }
    cmd.textContent = approvalCommandText(ev);
}
function approvalCommandText(ev, pretty) {
    let args = '';
    try { args = JSON.stringify(ev.arguments, null, 2); } catch (e) { args = String(ev.arguments); }
    let shown = '▶ ' + safeDisplay(ev.name) + '\n';
    const command = ev.arguments && typeof ev.arguments.command === 'string'
        ? ev.arguments.command
        : null;
    const task = ev.arguments && typeof ev.arguments.task === 'string'
        ? ev.arguments.task.trim()
        : '';
    if (task) shown += 'task: ' + safeDisplay(task) + '\n';
    if (command !== null && typeof runCmdTimeoutPhrase === 'function') {
        const limit = runCmdTimeoutPhrase(ev.arguments);
        if (limit === '30s') shown += 'timeout: 30s (stops after 30 seconds)\n';
        else if (limit === '20m') shown += 'timeout: 20m (stops after 20 minutes)\n';
        else if (limit === 'none') shown += 'timeout: none (no time limit; Stop run still ends it)\n';
        else if (limit) shown += 'timeout: ' + safeDisplay(limit) + ' (unrecognized; the command will not run)\n';
    }
    if (command !== null) {
        // Show the actual command (not only its JSON-escaped form) so
        // embedded newlines cannot hide a second command. The pretty
        // variant only rearranges the command's own whitespace at the
        // top-level connectors; the raw block is the byte-identical truth
        // the dialog submits and the Edit Command box edits.
        shown += pretty
            ? 'command:\n' + safeDisplay(prettyShellForDisplay(command)) + '\n\narguments:\n'
            : 'raw command:\n' + safeDisplay(command) + '\n\narguments:\n';
    }
    shown += safeDisplay(args);
    if (ev.executable) {
        shown += '\n\nexecutable: ' + safeDisplay(ev.executable);
    }
    if (Array.isArray(ev.argv) && ev.argv.length) {
        shown += '\nargv: ' + safeDisplay(JSON.stringify(ev.argv));
    }
    return shown;
}
function sessionForApproval() {
    try {
        if (typeof getSession !== 'function') return null;
        const sid = typeof runningSid === 'undefined' ? null : runningSid;
        return getSession(sid);
    } catch (e) {
        return null;
    }
}
function thinkingForApproval(round) {
    const s = sessionForApproval();
    const rounds = s && s.data && s.data.rounds;
    if (!rounds) return { text: '', round: null, current: false };
    const current = rounds[round];
    if (current && typeof current.thinking === 'string' && current.thinking.trim()) {
        return { text: current.thinking, round: round, current: true };
    }
    const order = Array.isArray(s.data.order) ? s.data.order : [];
    for (let i = order.length - 1; i >= 0; i--) {
        const n = order[i];
        const entry = rounds[n];
        if (entry && typeof entry.thinking === 'string' && entry.thinking.trim()) {
            return { text: entry.thinking, round: n, current: false };
        }
    }
    return { text: '', round: null, current: false };
}
function fillApprovalThinking(round) {
    const box = document.getElementById('approvalThinking');
    const note = document.getElementById('approvalThinkingNote');
    if (!box) return;
    const found = thinkingForApproval(round);
    if (!found.text) {
        box.textContent = '';
        if (note) note.textContent = 'No thinking text has been recorded in this session.';
        return;
    }
    box.textContent = safeDisplay(found.text);
    if (note) {
        note.textContent = found.current
            ? 'Thinking from round ' + found.round + ', before this tool call.'
            : 'Latest thinking is from round ' + found.round + '. This round did not include thinking.';
    }
}
function showApprovalContext(which) {
    if (which !== 'thinking' && which !== 'stderr') which = 'action';
    const panes = [
        ['action', 'approvalActionTab', 'approvalActionPane'],
        ['thinking', 'approvalThinkingTab', 'approvalThinkingPane'],
        ['stderr', 'approvalStderrTab', 'approvalStderrPane']
    ];
    for (const [name, tabId, paneId] of panes) {
        const on = which === name;
        const tab = document.getElementById(tabId);
        const pane = document.getElementById(paneId);
        // The stderr button's own display is separate: empty stderr hides
        // the button, and this switch only selects among the panes.
        if (tab) {
            tab.className = 'sub-tab' + (on ? ' sub-tab-active' : '');
            tab.setAttribute('aria-selected', on ? 'true' : 'false');
        }
        if (pane) pane.style.display = on ? '' : 'none';
    }
}
function setFetchStderr(text) {
    const tab = document.getElementById('approvalStderrTab');
    const pre = document.getElementById('approvalStderr');
    const dialog = document.getElementById('approvalDialog');
    const body = typeof text === 'string' ? text : '';
    const show = body.trim().length > 0;
    if (pre) pre.textContent = show ? safeDisplay(body) : '';
    if (tab) tab.style.display = show ? '' : 'none';
    if (dialog) {
        const parts = String(dialog.className || '').split(/\s+/).filter(part => part && part !== 'has-stderr');
        if (show) parts.push('has-stderr');
        dialog.className = parts.join(' ');
    }
    if (!show) {
        const pane = document.getElementById('approvalStderrPane');
        if (pane && pane.style.display !== 'none') showApprovalContext('action');
    }
}
function readCommentTag(tag) {
    if (typeof validCommentTag === 'function') return validCommentTag(tag);
    return (typeof tag === 'string' && /^[0-9a-fA-F]{12}$/.test(tag)) ? tag.toLowerCase() : '';
}
function currentCommentTag() {
    const session = sessionForApproval();
    const own = session && readCommentTag(session.commentTag);
    if (own) return own;
    if (typeof cachedConfig !== 'undefined' && cachedConfig) return readCommentTag(cachedConfig.comment_tag);
    return '';
}
function setAddCommentVisible(on) {
    const display = on ? '' : 'none';
    for (const id of ['approvalTextTools', 'addCommentBtn', 'approvalTextTop', 'approvalTextBottom', 'approvalTextAll']) {
        const el = document.getElementById(id);
        if (el) el.style.display = display;
    }
}
// Top and bottom move the caret. Select all highlights the output and
// leaves the start of that selection in view.
function placeApprovalText(where) {
    const box = document.getElementById('approvalText');
    if (!box || box.style.display === 'none') return;
    const value = String(box.value || '');
    let start = 0;
    let end = 0;
    if (where === 'bottom') start = end = value.length;
    else if (where === 'all') end = value.length;
    try { box.focus(); } catch (e) {}
    if (typeof box.setSelectionRange === 'function') {
        try { box.setSelectionRange(start, end); } catch (e) {}
    }
    box.selectionStart = start;
    box.selectionEnd = end;
    if (where === 'bottom') {
        box.scrollTop = typeof box.scrollHeight === 'number' ? box.scrollHeight : 0;
    } else {
        box.scrollTop = 0;
    }
}
// Inserts this launch's marker at the caret and leaves the caret between
// the tags. The textarea is what gets submitted; nothing else wraps it.
function commentBox() {
    const note = document.getElementById('approvalCommandNote');
    if (note && note.style.display !== 'none') return note;
    return document.getElementById('approvalText');
}
function insertCommentTag() {
    const box = commentBox();
    if (!box) return;
    const tag = currentCommentTag();
    if (!tag) return;
    const open = '<' + tag + '>';
    const close = '</' + tag + '>';
    const value = String(box.value || '');
    const start = typeof box.selectionStart === 'number' ? box.selectionStart : value.length;
    const end = typeof box.selectionEnd === 'number' ? box.selectionEnd : start;
    box.value = value.slice(0, start) + open + close + value.slice(end);
    const caret = start + open.length;
    if (typeof box.setSelectionRange === 'function') {
        try { box.setSelectionRange(caret, caret); } catch (e) {}
    } else {
        box.selectionStart = caret;
        box.selectionEnd = caret;
    }
    try { box.focus(); } catch (e) {}
}
function wideScreen() {
    try {
        return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(min-width: 1920px)').matches;
    } catch (e) {
        return false;
    }
}
// The session column stays on the right for the whole live run. The tool
// dialog still docks only while it is open. syncApprovalDock must not call
// back into here.
function syncRunDock() {
    const wide = wideScreen();
    let live = false;
    try {
        live = typeof runningSid !== 'undefined' && runningSid !== null;
    } catch (e) {
        live = false;
    }
    const body = document.body;
    if (body && body.classList) {
        // run-live is the narrow-screen bottom line. run-docked is the wide lane.
        body.classList.toggle('run-live', live);
        body.classList.toggle('run-docked', !!(live && wide));
    }
    let waiting = false;
    try {
        waiting = typeof activityIconMode !== 'undefined' && activityIconMode === 'tool';
    } catch (e) {
        waiting = false;
    }
    const laneText = waiting ? 'Waiting for response...' : 'Thinking...';
    const label = document.getElementById('runLaneText');
    if (label) label.textContent = laneText;
    else {
        const note = document.getElementById('runLaneNote');
        if (note) note.textContent = laneText;
    }
    syncApprovalDock();
}
function syncApprovalDock() {
    const overlay = document.getElementById('approvalOverlay');
    // Keyboard reachability: Tab stays inside the dialog. No Escape
    // action is registered on purpose — an approval is a decision, and
    // no keystroke makes it for the operator.
    if (typeof trapOverlayFocus === 'function') trapOverlayFocus(overlay, null);
    const open = !!(overlay && overlay.style.display && overlay.style.display !== 'none');
    const dock = open && wideScreen();
    const body = document.body;
    if (body && body.classList) body.classList.toggle('approval-docked', dock);
    if (dock && !approvalWasDocked) showApprovalContext('action');
    approvalWasDocked = dock;
}
function showApprovalModal(ev) {
    pendingApprovalId = ev.approval_id;
    approvalBusy = false;
    pendingInteraction = ev.interaction || null;
    pendingReview = ev.review || null;
    acceptHint = '';
    commandEditAvailable = !!(
        ev && ev.name === 'run_cmd' && ev.arguments && typeof ev.arguments.command === 'string'
        && !(pendingReview && (pendingReview.preview || pendingReview.kind === 'cmd'))
    );
    pendingRound = ev && ev.round;
    pendingShellCommand = commandEditAvailable ? ev.arguments.command : '';
    pendingFileDiff = ev && ev.file_diff ? ev.file_diff : null;
    commandDiffGen += 1;
    if (commandDiffTimer != null && typeof clearTimeout === 'function') clearTimeout(commandDiffTimer);
    commandDiffTimer = null;
    const commandEdit = document.getElementById('approvalCommandEdit');
    const commandNote = document.getElementById('approvalCommandNote');
    if (commandEdit) commandEdit.value = '';
    if (commandNote) commandNote.value = '';
    document.getElementById('webSubmit').style.display = 'none';
    document.getElementById('approvalDialog').className = 'modal';
    setFetchStderr('');
    document.getElementById('approvalText').placeholder = 'Type alternate instructions…';
    document.getElementById('questionFields').style.display = 'none';
    document.getElementById('questionSubmit').style.display = 'none';
    document.getElementById('approvalCmd').style.display = '';
    document.getElementById('approvalHint').textContent = 'Review the tool call before accepting or sending alternate instructions.';
    document.getElementById('approvalTitle').textContent = 'Tool approval required (round ' + ev.round + ')';
    // Provenance: where the call came from (e.g. the command was copied
    // out of a page the model just read).
    showProvenance(ev.provenance);
    paintApprovalCommand(ev);
    setupApprovalImage(ev);
    document.getElementById('approvalText').value = '';
    document.getElementById('approvalError').textContent = '';
    hideRawBody();
    setAddCommentVisible(false);
    showApprovalContext('action');
    fillApprovalThinking(ev.round);
    document.getElementById('approvalOverlay').style.display = 'flex';
    setApprovalMode('accept');
    document.getElementById('approvalAccept').disabled = false;
    document.getElementById('approvalRedirect').disabled = false;
    if (pendingInteraction) showQuestionFields(pendingInteraction);
    else if (pendingReview) {
        if (pendingReview.kind === 'relay') {
            // A proposed root command: nothing runs here. Show the command,
            // and wait for the person to paste the terminal output back.
            showRelayFields(pendingReview);
        } else if (pendingReview.preview) {
            // Stage two (search, fetch, PDF, RAG, or command output): the
            // text is here to edit before submitting it to the model.
            showReviewFields(pendingReview);
        } else {
            // Stage one (fetch/search/PDF/RAG execute): standard
            // accept/redirect dialog, tuned for what accepting will
            // actually do, with any URL-safety notices surfaced next to
            // the hint.
            document.getElementById('approvalHint').textContent =
                (pendingReview.kind === 'pdf'
                    ? 'Accepting extracts the PDF text locally. A second review dialog then opens — only content approved there reaches the model.'
                    : pendingReview.kind === 'rag'
                    ? 'Accepting runs the embedding query and opens a review of the retrieved chunks — only content approved there reaches the model.'
                    : pendingReview.kind === 'fetch'
                    ? 'Accepting runs the page fetch immediately. A second review dialog then opens — only content approved there reaches the model.'
                    : pendingReview.kind === 'search'
                    ? 'Accepting runs the search. A second review dialog then opens — only the text approved there reaches the model.'
                    : 'Accepting runs the tool. A second review dialog then opens — only the text approved there reaches the model.')
                + (+(pendingReview.notices || []).length
                    ? '\n⚠ ' + pendingReview.notices.map(safeDisplay).join('\n')
                    : '');
        }
    } else if (ev.name === 'run_cmd' && ev.output_review) {
        document.getElementById('approvalHint').textContent =
            'Accepting runs the command. A second review dialog then opens with its output — only the text approved there reaches the model.';
    }
    // Every decision waits for the person at the keyboard. A call can sit
    // while they look up what it does; Stop or a disconnect ends the run.
    const hintEl = document.getElementById('approvalHint');
    hintEl.textContent = hintEl.textContent + ' The dialog stays open until you decide.';
    const s = getSession(runningSid);
    if (s) { const waitingFor = !pendingReview ? 'tool approval' : pendingReview.preview ? 'reviewed content' : pendingReview.kind === 'pdf' ? 'the PDF read' : pendingReview.kind === 'rag' ? 'the corpus search' : pendingReview.kind === 'search' ? 'the search' : 'web results'; s.statusText = 'Waiting for ' + waitingFor + ' (round ' + ev.round + ')…'; if (s.id === activeSid) setStatus(s.statusText); }
    fillApprovalEffort(ev);
    fillApprovalTimeout(ev);
    clearCommandDiff();
    showFileDiff(pendingFileDiff);
    applyCloudEgressLabel();
    syncApprovalDock();
    // The open dialog is the moment a closed tab is most likely. Write the
    // tab now, ahead of the two-second debounce.
    if (typeof persist === 'function') {
        try { persist(); } catch (e) {}
    }
}
// Two-step flows. Edit Command opens the shell box for this run_cmd.
// Alternate Tool Call opens the message box for any tool call. Accept
// stays hidden once either box is open, so typed text cannot be approved
// over by accident. The add-comment insert stays on output reviews only.
function setCommandEditVisible(on) {
    const edit = document.getElementById('approvalCommandEdit');
    const note = document.getElementById('approvalCommandNote');
    const hint = document.getElementById('approvalCommandNoteHint');
    if (edit) edit.style.display = on ? '' : 'none';
    if (note) note.style.display = on ? '' : 'none';
    if (hint) hint.style.display = on ? '' : 'none';
}
function syncAlternateButton(label) {
    const button = document.getElementById('approvalAlternate');
    if (!button) return;
    const text = label || 'Edit Command';
    button.textContent = text;
    button.style.display = commandEditAvailable ? '' : 'none';
    button.title = text === 'Run command'
        ? 'Run this command. The note is for the model and is not passed to the shell.'
        : 'Edit this shell command and run your version. A note can tell the model why. The note is not passed to the shell.';
}
function setApprovalMode(mode) {
    const box = document.getElementById('approvalText');
    const accept = document.getElementById('approvalAccept');
    const alt = document.getElementById('approvalRedirect');
    const back = document.getElementById('approvalBack');
    const hint = document.getElementById('approvalHint');
    if (mode === 'command') {
        if (hint && !acceptHint) acceptHint = hint.textContent;
        setCommandEditVisible(true);
        box.style.display = 'none';
        accept.style.display = 'none';
        alt.style.display = 'none';
        back.style.display = '';
        syncAlternateButton('Run command');
        if (document.getElementById('approvalAlternate')) {
            document.getElementById('approvalAlternate').style.display = '';
        }
        setAddCommentVisible(false);
        clearCommandDiff();
        if (hint) hint.textContent = 'Edit the command, then run it. The note tells the model about the change and is not passed to the shell. A diff of your command against the model\'s command appears under the box. The dialog stays open until you decide.';
        document.getElementById('approvalError').textContent = '';
        const edit = document.getElementById('approvalCommandEdit');
        setTimeout(() => { try { if (edit) edit.focus(); } catch (e) {} }, 50);
        return;
    }
    setCommandEditVisible(false);
    commandDiffGen += 1;
    if (commandDiffTimer != null && typeof clearTimeout === 'function') clearTimeout(commandDiffTimer);
    commandDiffTimer = null;
    clearCommandDiff();
    showFileDiff(pendingFileDiff);
    if (mode === 'alternate') {
        box.style.display = '';
        box.value = '';
        document.getElementById('approvalError').textContent = '';
        accept.style.display = 'none';
        alt.style.display = '';
        alt.textContent = 'Send to model';
        back.style.display = '';
        syncAlternateButton('Edit Command');
        if (document.getElementById('approvalAlternate')) {
            document.getElementById('approvalAlternate').style.display = 'none';
        }
        setAddCommentVisible(false);
        setTimeout(() => { try { box.focus(); } catch (e) {} }, 50);
    } else {
        box.style.display = 'none';
        box.value = '';
        accept.style.display = '';
        alt.style.display = '';
        alt.textContent = 'Alternate Tool Call';
        back.style.display = 'none';
        syncAlternateButton('Edit Command');
        setAddCommentVisible(false);
        if (hint && acceptHint) {
            hint.textContent = acceptHint;
            acceptHint = '';
        }
    }
}
// Show (or clear) the provenance warnings next to the command: they say
// where the call came from, e.g. that the command appears in a page the
// model has just read.
function hideRawBody() {
    const wrap = document.getElementById('rawBodyWrap');
    if (wrap) wrap.style.display = 'none';
    const box = document.getElementById('rawBodyBox');
    if (box) box.textContent = '';
    const tabs = document.getElementById('fetchReviewTabs');
    if (tabs) tabs.style.display = 'none';
}
function showFetchReviewPane(which) {
    const raw = which === 'raw';
    const textTab = document.getElementById('fetchTextTab');
    const rawTab = document.getElementById('fetchRawTab');
    const box = document.getElementById('approvalText');
    const wrap = document.getElementById('rawBodyWrap');
    if (textTab) {
        textTab.className = 'sub-tab' + (raw ? '' : ' sub-tab-active');
        textTab.setAttribute('aria-selected', raw ? 'false' : 'true');
    }
    if (rawTab) {
        rawTab.className = 'sub-tab' + (raw ? ' sub-tab-active' : '');
        rawTab.setAttribute('aria-selected', raw ? 'true' : 'false');
    }
    if (box) box.style.display = raw ? 'none' : '';
    setAddCommentVisible(!raw);
    if (wrap) wrap.style.display = raw ? '' : 'none';
    if (!raw && box) {
        try { box.focus(); } catch (e) {}
    }
}
function showProvenance(notes) {
    const box = document.getElementById('approvalProvenance');
    const list = Array.isArray(notes) ? notes.filter(n => typeof n === 'string' && n.trim()) : [];
    if (!box) return;
    if (!list.length) {
        box.textContent = '';
        box.style.display = 'none';
        return;
    }
    box.textContent = '⚠ ' + list.map(safeDisplay).join('\n\n');
    box.style.display = '';
}
function fillApprovalEffort(ev) {
    const row = document.getElementById('approvalEffortRow');
    const hint = document.getElementById('approvalEffortHint');
    const select = document.getElementById('approvalEffort');
    const effort = ev && typeof ev.reasoning_effort === 'string' ? ev.reasoning_effort : '';
    const known = effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh';
    if (row) row.style.display = known ? '' : 'none';
    if (hint) hint.style.display = known ? '' : 'none';
    if (select && known) select.value = effort;
}
function approvalEffortField() {
    const row = document.getElementById('approvalEffortRow');
    const select = document.getElementById('approvalEffort');
    if (!row || row.style.display === 'none' || !select || !select.value) return null;
    return select.value;
}
function withApprovalEffort(body) {
    const effort = approvalEffortField();
    if (effort) body.reasoning_effort = effort;
    return body;
}
// Stage-one run_cmd only. The select is this command's limit. An
// omitted or unrecognized model value opens on none, so Accept runs
// the command with no time limit unless the person selects one.
function fillApprovalTimeout(ev) {
    const row = document.getElementById('approvalTimeoutRow');
    const hint = document.getElementById('approvalTimeoutHint');
    const select = document.getElementById('approvalTimeout');
    const stageTwo = !!(pendingReview && (pendingReview.preview || pendingReview.kind === 'cmd'));
    const command = !!(ev && ev.name === 'run_cmd' && ev.arguments && typeof ev.arguments.command === 'string');
    const show = command && !stageTwo;
    if (row) row.style.display = show ? '' : 'none';
    if (hint) {
        hint.style.display = show ? '' : 'none';
    }
    if (select && show) {
        const phrase = typeof runCmdTimeoutPhrase === 'function'
            ? runCmdTimeoutPhrase(ev.arguments)
            : '';
        select.value = phrase === '30s' || phrase === '20m' ? phrase : 'none';
    }
}
function approvalTimeoutField() {
    const row = document.getElementById('approvalTimeoutRow');
    const select = document.getElementById('approvalTimeout');
    if (!row || row.style.display === 'none' || !select || !select.value) return null;
    return select.value;
}
function withApprovalTimeout(body, action) {
    if (action !== 'approve') return body;
    const limit = approvalTimeoutField();
    if (limit) body.command_timeout = limit;
    return body;
}
// The command box is this run_cmd only. A hidden box means Accept runs
// the model's command. The note is sent as text and never reaches the shell.
function withApprovalCommand(body, action) {
    if (action !== 'approve') return body;
    const edit = document.getElementById('approvalCommandEdit');
    if (!edit || edit.style.display === 'none') return body;
    body.command = edit.value;
    const note = document.getElementById('approvalCommandNote');
    if (note && note.value.trim()) body.text = note.value;
    return body;
}
function clearDiffBox(noteId, boxId) {
    const note = document.getElementById(noteId);
    const box = document.getElementById(boxId);
    if (note) {
        note.textContent = '';
        note.style.display = 'none';
    }
    if (!box) return;
    box.style.display = 'none';
    if (typeof clearNode === 'function') clearNode(box);
    else box.textContent = '';
}
function clearCommandDiff() {
    clearDiffBox('approvalCommandDiffNote', 'approvalCommandDiff');
}
function paintDiffBox(noteId, boxId, noteText, diff, language) {
    const note = document.getElementById(noteId);
    const box = document.getElementById(boxId);
    const shown = typeof diffVisible === 'function' ? diffVisible(noteText || '') : String(noteText || '');
    if (note) {
        note.textContent = shown;
        note.style.display = shown ? '' : 'none';
    }
    if (!box) return;
    if (typeof clearNode === 'function') clearNode(box);
    else box.textContent = '';
    const hasLines = !!(diff && Array.isArray(diff.lines) && diff.lines.length);
    const hasNote = !!(diff && typeof diff.note === 'string' && diff.note);
    if ((hasLines || hasNote) && typeof renderStructuredDiff === 'function') {
        renderStructuredDiff(box, diff, language || '');
        box.style.display = '';
        return;
    }
    box.style.display = 'none';
}
function setApprovalWide(on) {
    const dialog = document.getElementById('approvalDialog');
    if (dialog && dialog.classList) dialog.classList.toggle('approval-wide', !!on);
    const toggle = document.getElementById('approvalWideBtn');
    if (toggle) toggle.textContent = on ? 'compact view' : 'wide view';
}
function showFileDiff(view) {
    const wideBtn = document.getElementById('approvalWideBtn');
    if (!view || typeof view.note !== 'string' || !view.note) {
        clearDiffBox('approvalFileDiffNote', 'approvalFileDiff');
        setApprovalWide(false);
        if (wideBtn) wideBtn.style.display = 'none';
        return;
    }
    // A file write deserves the screen: the wide dialog is the default
    // here rather than the half-pane, with a toggle back to compact.
    if (wideBtn) wideBtn.style.display = '';
    setApprovalWide(true);
    const language = typeof languageForPath === 'function' ? languageForPath(view.path) : '';
    if (typeof view.content === 'string') {
        // A new file: there is no before-state to diff against. Show the
        // proposed text itself, syntax-highlighted for its language.
        const note = document.getElementById('approvalFileDiffNote');
        if (note) {
            note.textContent = typeof diffVisible === 'function' ? diffVisible(view.note) : view.note;
            note.style.display = '';
        }
        const box = document.getElementById('approvalFileDiff');
        if (box && typeof renderFileContent === 'function') {
            renderFileContent(box, view.content, language);
            box.style.display = '';
        }
        return;
    }
    paintDiffBox('approvalFileDiffNote', 'approvalFileDiff', view.note, view.diff || null, language);
}
function showCommandDiff(diff) {
    const unchanged = diff && !diff.note && !(diff.lines && diff.lines.length) && !diff.added && !diff.removed;
    const hint = unchanged
        ? 'No difference from the model\'s command.'
        : 'Difference from the model\'s command. Changed words are marked inside a changed line. This does not run the command.';
    paintDiffBox('approvalCommandDiffNote', 'approvalCommandDiff', hint, unchanged ? null : diff);
}
function scheduleCommandDiff() {
    if (commandDiffTimer != null && typeof clearTimeout === 'function') clearTimeout(commandDiffTimer);
    commandDiffTimer = setTimeout(refreshCommandDiff, 200);
}
async function refreshCommandDiff() {
    commandDiffTimer = null;
    const edit = document.getElementById('approvalCommandEdit');
    if (!commandEditAvailable || !edit || edit.style.display === 'none') return;
    const after = String(edit.value);
    const before = String(pendingShellCommand || '');
    if (after === before) {
        clearCommandDiff();
        showFileDiff(pendingFileDiff);
        return;
    }
    const gen = ++commandDiffGen;
    const note = document.getElementById('approvalCommandDiffNote');
    if (note) {
        note.textContent = 'Comparing the edited command with the model\'s command…';
        note.style.display = '';
    }
    const fetchDiff = typeof apiFetch === 'function' ? apiFetch : null;
    if (!fetchDiff) {
        if (note) note.textContent = 'The diff could not be loaded. You can still edit the command and run it.';
        return;
    }
    try {
        const res = await fetchDiff('/diff', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ before: before, after: after, file: true })
        });
        if (gen !== commandDiffGen) return;
        if (!edit || edit.style.display === 'none' || String(edit.value) !== after) return;
        if (!res.ok) throw new Error('diff');
        const body = await res.json();
        showCommandDiff(body && body.diff);
        if (body && body.file) showFileDiff(body.file);
        else showFileDiff(null);
    } catch (e) {
        if (gen !== commandDiffGen) return;
        const failed = document.getElementById('approvalCommandDiffNote');
        if (failed) {
            failed.textContent = 'The diff could not be loaded. You can still edit the command and run it.';
            failed.style.display = '';
        }
    }
}
// ---- view_img image preview + drag-select focus region ----
let imageDrag = null;
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function normalizedImageRegion(img, sx, sy, ex, ey) {
    const rect = img.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    const left = Math.min(sx, ex), top = Math.min(sy, ey);
    const w = Math.abs(ex - sx), h = Math.abs(ey - sy);
    const nx = clamp01((left - rect.left) / rect.width);
    const ny = clamp01((top - rect.top) / rect.height);
    const nw = Math.min(w / rect.width, 1 - nx);
    const nh = Math.min(h / rect.height, 1 - ny);
    if (nw < 0.005 || nh < 0.005) return null;
    return { x: nx, y: ny, w: nw, h: nh };
}
function paintImageOverlay(img, overlay, region) {
    // The overlay is hidden from the stylesheet (display: none), so
    // showing it must set an explicit value: clearing the inline style
    // ('') would fall back to the stylesheet rule and keep it hidden.
    if (!region) { overlay.style.display = 'none'; return; }
    overlay.style.display = 'block';
    overlay.style.left = (region.x * 100) + '%';
    overlay.style.top = (region.y * 100) + '%';
    overlay.style.width = (region.w * 100) + '%';
    overlay.style.height = (region.h * 100) + '%';
}
function onImageDragMove(e) {
    if (!imageDrag) return;
    const img = document.getElementById('approvalImage');
    const overlay = document.getElementById('approvalImageOverlay');
    paintImageOverlay(img, overlay, normalizedImageRegion(img, imageDrag.sx, imageDrag.sy, e.clientX, e.clientY));
}
function onImageDragEnd(e) {
    if (!imageDrag) return;
    document.removeEventListener('mousemove', onImageDragMove);
    document.removeEventListener('mouseup', onImageDragEnd);
    const img = document.getElementById('approvalImage');
    const overlay = document.getElementById('approvalImageOverlay');
    pendingImageRegion = normalizedImageRegion(img, imageDrag.sx, imageDrag.sy, e.clientX, e.clientY);
    paintImageOverlay(img, overlay, pendingImageRegion);
    // The mode row appears with a region. The chosen mode is sticky
    // across re-drags of the same dialog; a degenerate drag hides it
    // again and returns to the safe default.
    showRegionControls(!!pendingImageRegion);
    imageDrag = null;
}
// Highlight is the default: the region is described in the tool result
// and the full image is attached. Crop mode sends only the selected
// pixels, cut server-side from the same normalized image.
function setRegionMode(crop) {
    pendingImageCrop = !!crop;
    const highlightBtn = document.getElementById('regionModeHighlight');
    const cropBtn = document.getElementById('regionModeCrop');
    if (highlightBtn) highlightBtn.className = 'region-mode' + (pendingImageCrop ? '' : ' region-mode-on');
    if (cropBtn) cropBtn.className = 'region-mode' + (pendingImageCrop ? ' region-mode-on' : '');
}
function showRegionControls(show) {
    const row = document.getElementById('regionModeRow');
    const clearBtn = document.getElementById('clearRegionBtn');
    if (row) row.style.display = show ? 'flex' : 'none';
    if (clearBtn) clearBtn.style.display = show ? '' : 'none';
    if (!show) setRegionMode(false);
}
function setupApprovalImage(ev) {
    const wrap = document.getElementById('approvalImageWrap');
    const img = document.getElementById('approvalImage');
    const overlay = document.getElementById('approvalImageOverlay');
    const meta = document.getElementById('approvalImageMeta');
    const clearBtn = document.getElementById('clearRegionBtn');
    if (!wrap || !img || !overlay || !meta || !clearBtn) return;
    pendingImageRegion = null;
    setRegionMode(false);
    const image = ev && ev.image;
    if (!image || typeof image.data_url !== 'string') {
        wrap.style.display = 'none';
        img.src = '';
        overlay.style.display = 'none';
        showRegionControls(false);
        return;
    }
    img.src = image.data_url;
    meta.textContent = safeDisplay(String(image.path || '')) + '\n'
        + String(image.width) + '\u00d7' + String(image.height)
        + (image.downscaled ? (' (downscaled from ' + image.original_width + '\u00d7' + image.original_height + ')') : '')
        + '\nsha256: ' + String(image.sha256 || '')
        + '\n' + String(image.png_byte_size || '') + ' bytes (PNG)';
    wrap.style.display = '';
    overlay.style.display = 'none';
    showRegionControls(false);
}
function attachImageDrag() {
    const img = document.getElementById('approvalImage');
    const clearBtn = document.getElementById('clearRegionBtn');
    if (!img || !clearBtn || typeof img.addEventListener !== 'function') return;
    img.addEventListener('mousedown', function (e) {
        if (img.getAttribute('src') == null || img.getAttribute('src') === '') return;
        e.preventDefault();
        imageDrag = { sx: e.clientX, sy: e.clientY };
        document.addEventListener('mousemove', onImageDragMove);
        document.addEventListener('mouseup', onImageDragEnd);
    });
    clearBtn.onclick = function () {
        pendingImageRegion = null;
        const overlay = document.getElementById('approvalImageOverlay');
        paintImageOverlay(img, overlay, null);
        showRegionControls(false);
    };
    const highlightBtn = document.getElementById('regionModeHighlight');
    const cropBtn = document.getElementById('regionModeCrop');
    if (highlightBtn) highlightBtn.onclick = () => setRegionMode(false);
    if (cropBtn) cropBtn.onclick = () => setRegionMode(true);
}
attachImageDrag();

function hideApprovalModal() {
    document.getElementById('approvalOverlay').style.display = 'none';
    pendingApprovalId = null;
    approvalBusy = false;
    pendingInteraction = null;
    pendingReview = null;
    fillApprovalEffort(null);
    fillApprovalTimeout(null);
    questionControls = [];
    document.getElementById('questionFields').replaceChildren();
    showProvenance(null);
    hideRawBody();
    setFetchStderr('');
    const cloudNote = document.getElementById('approvalCloud');
    if (cloudNote) {
        cloudNote.textContent = '';
        cloudNote.style.display = 'none';
    }
    const cloudFoot = document.getElementById('approvalCloudFoot');
    if (cloudFoot) {
        cloudFoot.textContent = '';
        cloudFoot.style.display = 'none';
    }
    setAddCommentVisible(false);
    commandEditAvailable = false;
    pendingShellCommand = '';
    pendingFileDiff = null;
    commandDiffGen += 1;
    if (commandDiffTimer != null && typeof clearTimeout === 'function') clearTimeout(commandDiffTimer);
    commandDiffTimer = null;
    clearCommandDiff();
    showFileDiff(null);
    acceptHint = '';
    pendingRound = null;
    pendingImageRegion = null;
    setupApprovalImage(null);
    clearRelayExtras();
    setCommandEditVisible(false);
    syncAlternateButton('Edit Command');
    showApprovalContext('action');
    syncApprovalDock();
}
async function decideApproval(action) {
    if (!pendingApprovalId || approvalBusy) return;
    const err = document.getElementById('approvalError');
    const text = document.getElementById('approvalText').value;
    if (action === 'redirect' && !text.trim()) {
        err.textContent = 'Type alternate instructions first, or go back to accept.';
        return;
    }
    approvalBusy = true;
    const submittedId = pendingApprovalId;
    document.getElementById('approvalAccept').disabled = true;
    document.getElementById('approvalRedirect').disabled = true;
    err.textContent = 'Sending…';
    const payload = withApprovalCommand(withApprovalTimeout(withApprovalEffort({ approval_id: submittedId, action, text }), action), action);
    if (action === 'approve' && pendingImageRegion) {
        payload.image_region = pendingImageRegion;
        // The crop flag rides only with a region; highlight mode leaves
        // it off so the server sees the safe default.
        if (pendingImageCrop) payload.image_crop = true;
    }
    let body = JSON.stringify(payload);
    try {
        const res = await apiFetch('/approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body
        });
        body = '';
        if (!res.ok) throw new Error(await res.text() || ('HTTP ' + res.status));
        if (pendingApprovalId === submittedId) hideApprovalModal();
        // 'approve' executes the tool (spin as a wheel until the result
        // event arrives); alternates resume the model instead.
        setActivityIcon(action === 'approve' ? 'tool' : 'think');
    } catch (e) {
        body = '';
        if (pendingApprovalId !== submittedId) return;
        err.textContent = 'Error: ' + e.message;
        document.getElementById('approvalAccept').disabled = false;
        document.getElementById('approvalRedirect').disabled = false;
        approvalBusy = false;
    }
}
document.getElementById('approvalAccept').onclick = () => decideApproval('approve');
// The file-write preview can use the whole screen; the toggle returns
// the dialog to its half-pane width.
const approvalWideBtn = document.getElementById('approvalWideBtn');
if (approvalWideBtn) approvalWideBtn.onclick = () => {
    const dialog = document.getElementById('approvalDialog');
    const wide = dialog && dialog.classList
        ? dialog.classList.toggle('approval-wide')
        : false;
    approvalWideBtn.textContent = wide ? 'compact view' : 'wide view';
};
const commandDiffBox = document.getElementById('approvalCommandEdit');
if (commandDiffBox && typeof commandDiffBox.addEventListener === 'function') {
    commandDiffBox.addEventListener('input', scheduleCommandDiff);
}
const approvalAlternateBtn = document.getElementById('approvalAlternate');
if (approvalAlternateBtn) approvalAlternateBtn.onclick = () => {
    if (approvalBusy) return;
    const edit = document.getElementById('approvalCommandEdit');
    if (!edit || edit.style.display === 'none') {
        if (edit) edit.value = pendingShellCommand;
        const note = document.getElementById('approvalCommandNote');
        if (note) note.value = '';
        setApprovalMode('command');
        return;
    }
    if (!edit.value.trim()) {
        document.getElementById('approvalError').textContent = 'Enter the command to run, or go back.';
        return;
    }
    decideApproval('approve');
};
document.getElementById('approvalRedirect').onclick = () => {
    // First click reveals the box and retires Accept; second click
    // (box visible) sends what was typed.
    if (document.getElementById('approvalText').style.display === 'none' && !approvalBusy) {
        setApprovalMode('alternate');
        return;
    }
    decideApproval('redirect');
};
document.getElementById('approvalBack').onclick = () => {
    if (!approvalBusy) setApprovalMode('accept');
};
document.getElementById('approvalStop').onclick = async () => {
    if (approvalBusy) return;
    approvalBusy = true;
    document.getElementById('approvalError').textContent = 'Stopping…';
    await stopRun();
    approvalBusy = false;
    hideApprovalModal();
};

function showQuestionFields(request) {
    document.getElementById('approvalTitle').textContent = safeDisplay((request.kind === 'note' ? 'Note: ' : '') + request.title);
    document.getElementById('approvalHint').textContent = safeDisplay(request.message || 'Choose an answer for each question, or provide your own.');
    document.getElementById('approvalCmd').style.display = 'none';
    for (const id of ['approvalAccept', 'approvalRedirect', 'approvalAlternate', 'approvalBack', 'approvalText']) {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    }
    setCommandEditVisible(false);
    setAddCommentVisible(false);
    const fields = document.getElementById('questionFields');
    fields.replaceChildren();
    fields.style.display = '';
    questionControls = request.questions.map((question, index) => {
        const field = document.createElement('fieldset');
        const legend = document.createElement('legend');
        legend.textContent = safeDisplay(question.question);
        field.appendChild(legend);
        const radios = [];
        const otherText = document.createElement('textarea');
        otherText.spellcheck = false;
        otherText.placeholder = 'Provide your own answer…';
        otherText.setAttribute('aria-label', 'Your answer: ' + question.question);
        otherText.style.display = 'none';
        question.options.concat([{ label: 'Other: (provide your own answer)' }]).forEach((option, choice) => {
            const label = document.createElement('label');
            label.className = 'question-choice';
            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'user-question-' + index;
            radio.value = String(choice);
            const text = document.createElement('span');
            text.textContent = safeDisplay(option.label + (option.recommended ? ' (recommended)' : ''));
            if (option.description) {
                const detail = document.createElement('small');
                detail.textContent = safeDisplay(option.description);
                text.appendChild(detail);
            }
            radio.onchange = () => {
                const other = choice === question.options.length;
                otherText.style.display = other ? '' : 'none';
                if (other) otherText.focus();
            };
            label.append(radio, text);
            field.appendChild(label);
            radios.push(radio);
        });
        field.appendChild(otherText);
        fields.appendChild(field);
        return { question, radios, otherText };
    });
    const submit = document.getElementById('questionSubmit');
    submit.style.display = '';
    submit.disabled = false;
    const first = questionControls[0]?.radios[0];
    if (first) first.focus();
}

function collectQuestionAnswers(controls) {
    return controls.map(({ question, radios, otherText }) => {
        const selected = radios.findIndex(radio => radio.checked);
        if (selected < 0) throw new Error('Choose an answer for: ' + question.question);
        const other = selected === question.options.length;
        if (other && !otherText.value.trim()) throw new Error('Provide your answer for: ' + question.question);
        return { id: question.id, choice: other ? null : selected, text: other ? otherText.value : '' };
    });
}

async function submitQuestionAnswers() {
    if (!pendingApprovalId || !pendingInteraction || approvalBusy) return;
    const err = document.getElementById('approvalError');
    let answers;
    try { answers = collectQuestionAnswers(questionControls); }
    catch (e) { err.textContent = e.message; return; }
    const submittedId = pendingApprovalId;
    approvalBusy = true;
    document.getElementById('questionSubmit').disabled = true;
    err.textContent = 'Sending…';
    try {
        const res = await apiFetch('/approve', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(withApprovalEffort({ approval_id: submittedId, action: 'answer', answers }))
        });
        if (!res.ok) throw new Error(await res.text() || ('HTTP ' + res.status));
        // The stream may already have opened the next question dialog.
        if (pendingApprovalId === submittedId) hideApprovalModal();
        setActivityIcon('think'); // answers go straight into the next round
    } catch (e) {
        if (pendingApprovalId !== submittedId) return;
        err.textContent = 'Error: ' + e.message;
        document.getElementById('questionSubmit').disabled = false;
        approvalBusy = false;
    }
}
document.getElementById('questionSubmit').onclick = submitQuestionAnswers;

// Reset the one piece of relay state that outlives its dialog: the copy
// button from the previous root-command proposal.
function clearRelayExtras() {
    const relayCopy = document.getElementById('relayCopyBtn');
    if (relayCopy) relayCopy.style.display = 'none';
}
function showRelayCopyCommand(command) {
    const btn = document.getElementById('relayCopyBtn');
    if (!btn) return;
    btn.textContent = 'copy command';
    btn.style.display = '';
    btn.onclick = () => copyText(String(command == null ? '' : command), btn);
}
function showRelayFields(request) {
    document.getElementById('approvalDialog').className = 'modal web-input';
    document.getElementById('approvalTitle').textContent =
        'Root command — run it yourself (round ' + (pendingRound == null ? '' : pendingRound) + ')';
    document.getElementById('approvalHint').textContent =
        'The harness will not run this command and never asks for or handles a password. Copy the command, run it in your own terminal as admin, then paste the terminal output below to send it back to the model.';
    for (const id of ['approvalAccept', 'approvalRedirect', 'approvalAlternate', 'approvalBack']) {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    }
    setCommandEditVisible(false);
    setAddCommentVisible(true);
    showRelayCopyCommand(request && request.command);
    const box = document.getElementById('approvalText');
    box.spellcheck = false;
    box.style.display = '';
    box.value = '';
    box.placeholder = 'Paste the terminal output here…';
    box.setAttribute('aria-label', 'Paste the terminal output from running the root command');
    const submit = document.getElementById('webSubmit');
    submit.textContent = 'Submit output to model';
    submit.style.display = '';
    submit.disabled = false;
    setFetchStderr('');
}
function showReviewFields(request) {
    document.getElementById('approvalDialog').className = 'modal web-input';
    const isPdf = request.kind === 'pdf';
    const isRag = request.kind === 'rag';
    const isSearch = request.kind === 'search';
    const isCmd = request.kind === 'cmd';
    const isFetch = request.kind === 'fetch';
    const pdfName = isPdf ? safeDisplay(String(request.path || '').split(/[\\/]/).pop() || 'the PDF') : '';
    const ragQuery = isRag ? ('“' + safeDisplay(String(request.query || '').slice(0, 60)) + (String(request.query || '').length > 60 ? '…' : '') + '”') : '';
    document.getElementById('approvalTitle').textContent = isPdf
        ? 'Review extracted text (' + pdfName + ')'
        : isRag
        ? 'Review retrieved chunks — ' + ragQuery
        : isSearch
        ? 'Review search results'
        : isCmd
        ? 'Review command output'
        : 'Review fetched page content';
    document.getElementById('approvalHint').textContent = isPdf
        ? 'The PDF text was extracted and is shown below. Edit or trim noisy parts before approving — only the submitted text reaches the model.'
        : isRag
        ? 'The corpus returned the chunks below. Edit or trim them before approving — only the submitted text reaches the model.'
        : isSearch
        ? 'The search has run and its results are shown below. Edit or trim them before approving — only the submitted text reaches the model.'
        : isCmd
        ? 'The command has run and its output is shown below. Edit or trim it before approving — only the submitted text reaches the model.'
        : 'The Extracted text tab is document.body after JavaScript, captured at DOMContentLoaded. It is rendered DOM text. A load that times out before DOMContentLoaded is marked partial in that text. The Original HTML tab shows the HTTP response body (capped at 256 KiB) when a document was received. Page-load notes, when the fetch recorded any, are on the stderr tab next to Action and Thinking. That tab is not submitted. Review or edit the extracted text, then approve and submit it to the model.';
    for (const id of ['approvalAccept', 'approvalRedirect', 'approvalAlternate', 'approvalBack']) {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    }
    setCommandEditVisible(false);
    const box = document.getElementById('approvalText');
    box.spellcheck = false;
    box.style.display = '';
    box.value = request.preview || '';
    box.placeholder = isPdf
        ? 'Reviewed PDF text (or an explicit retrieval-error report)'
        : isRag
        ? 'Curated RAG results (or an explicit no-results report)'
        : isSearch
        ? 'Curated search results (or an explicit no-results report)'
        : isCmd
        ? 'Command output to send (or an explicit note that it produced nothing useful)'
        : 'Curated page content or an explicit retrieval-error report';
    box.setAttribute('aria-label', isPdf
        ? 'Review and edit the extracted PDF text'
        : isRag
        ? 'Review and edit the retrieved RAG chunks'
        : isSearch
        ? 'Review and edit the search results'
        : isCmd
        ? 'Review and edit the command output'
        : 'Review and edit fetched page content');
    const submit = document.getElementById('webSubmit');
    submit.textContent = 'Approve & submit content';
    submit.style.display = '';
    submit.disabled = false;
    const rawWrap = document.getElementById('rawBodyWrap');
    const rawBox = document.getElementById('rawBodyBox');
    const tabs = document.getElementById('fetchReviewTabs');
    if (rawWrap && rawBox && isFetch && typeof request.raw_body === 'string') {
        rawBox.textContent = safeDisplay(request.raw_body);
        if (tabs) tabs.style.display = '';
        showFetchReviewPane('text');
    } else {
        if (rawBox) rawBox.textContent = '';
        if (rawWrap) rawWrap.style.display = 'none';
        if (tabs) tabs.style.display = 'none';
        box.focus();
    }
    setFetchStderr(isFetch ? request.stderr : '');
    setAddCommentVisible(true);
}
document.getElementById('fetchTextTab').onclick = () => showFetchReviewPane('text');
document.getElementById('fetchRawTab').onclick = () => showFetchReviewPane('raw');
document.getElementById('approvalActionTab').onclick = () => showApprovalContext('action');
document.getElementById('approvalThinkingTab').onclick = () => showApprovalContext('thinking');
const approvalStderrTab = document.getElementById('approvalStderrTab');
if (approvalStderrTab) approvalStderrTab.onclick = () => showApprovalContext('stderr');

// A wheel notch over the review window stays in that window. The dialog is
// position:fixed, so a notch the text cannot absorb would otherwise move the
// session behind it and leave the review text still.
function wheelPixels(event, delta, view) {
    if (event.deltaMode === 1) return delta * 16;
    if (event.deltaMode === 2) return delta * (view || 400);
    return delta;
}
function overflowScrolls(value) {
    return value === 'auto' || value === 'scroll' || value === 'overlay';
}
function applyApprovalWheel(node, event) {
    if (!node || node.nodeType !== 1 || typeof getComputedStyle !== 'function') return false;
    const style = getComputedStyle(node);
    let used = false;
    const dy = wheelPixels(event, event.deltaY || 0, node.clientHeight);
    const dx = wheelPixels(event, event.deltaX || 0, node.clientWidth);
    if (dy && overflowScrolls(style.overflowY) && node.scrollHeight > node.clientHeight + 1) {
        const max = node.scrollHeight - node.clientHeight;
        const next = Math.min(max, Math.max(0, node.scrollTop + dy));
        if (next !== node.scrollTop) {
            node.scrollTop = next;
            used = true;
        }
    }
    if (dx && overflowScrolls(style.overflowX) && node.scrollWidth > node.clientWidth + 1) {
        const max = node.scrollWidth - node.clientWidth;
        const next = Math.min(max, Math.max(0, node.scrollLeft + dx));
        if (next !== node.scrollLeft) {
            node.scrollLeft = next;
            used = true;
        }
    }
    return used;
}
function confineApprovalWheel(event) {
    const dialog = document.getElementById('approvalDialog');
    if (!dialog) return;
    let node = event.target;
    if (node && node.nodeType !== 1) node = node.parentElement;
    while (node && node !== dialog) {
        if (applyApprovalWheel(node, event)) {
            event.preventDefault();
            return;
        }
        node = node.parentElement;
    }
    event.preventDefault();
}
const approvalDialogEl = document.getElementById('approvalDialog');
if (approvalDialogEl && typeof approvalDialogEl.addEventListener === 'function') {
    approvalDialogEl.addEventListener('wheel', confineApprovalWheel, { passive: false });
}
if (typeof window !== 'undefined' && window.matchMedia) {
    try {
        const wideQuery = window.matchMedia('(min-width: 1920px)');
        if (typeof wideQuery.addEventListener === 'function') {
            wideQuery.addEventListener('change', () => {
                syncRunDock();
                if (typeof syncPromptDock === 'function') syncPromptDock();
            });
        }
    } catch (e) {}
}

async function submitWebResults() {
    if (!pendingApprovalId || !pendingReview || approvalBusy) return;
    const text = document.getElementById('approvalText').value;
    const err = document.getElementById('approvalError');
    if (!text.trim()) {
        err.textContent = pendingReview.kind === 'cmd'
            ? 'Enter the command output, or an explicit note that it produced nothing useful.'
            : pendingReview.kind === 'relay'
            ? 'Paste the terminal output, or a note that the command produced nothing.'
            : 'Enter results, page content, or an explicit error/no-results report.';
        return;
    }
    const submittedId = pendingApprovalId;
    approvalBusy = true;
    document.getElementById('webSubmit').disabled = true;
    err.textContent = 'Sending…';
    try {
        const res = await apiFetch('/approve', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(withApprovalEffort({ approval_id: submittedId, action: 'web_result', text }))
        });
        if (!res.ok) throw new Error(await res.text() || ('HTTP ' + res.status));
        if (pendingApprovalId === submittedId) hideApprovalModal();
        setActivityIcon('think'); // reviewed content goes into the next round
    } catch (e) {
        if (pendingApprovalId !== submittedId) return;
        err.textContent = 'Error: ' + e.message;
        document.getElementById('webSubmit').disabled = false;
        approvalBusy = false;
    }
}
document.getElementById('webSubmit').onclick = submitWebResults;
const addCommentBtn = document.getElementById('addCommentBtn');
if (addCommentBtn) addCommentBtn.onclick = insertCommentTag;
const approvalTextTop = document.getElementById('approvalTextTop');
if (approvalTextTop) approvalTextTop.onclick = () => placeApprovalText('top');
const approvalTextBottom = document.getElementById('approvalTextBottom');
if (approvalTextBottom) approvalTextBottom.onclick = () => placeApprovalText('bottom');
const approvalTextAll = document.getElementById('approvalTextAll');
if (approvalTextAll) approvalTextAll.onclick = () => placeApprovalText('all');
