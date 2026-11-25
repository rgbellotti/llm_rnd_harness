// subtabs.js — chain view split applied once a response completes (or a tab
// is restored/replayed): a "Response" pane promoting the final answer to
// the front, and a "Diagnostics" pane holding everything else in the
// original streaming order. During streaming the layout is exactly as
// before; the split happens only at completion time.
// Needs rounds.js (rawBodyText) and core.js (copyText).
// Same 16-line tinted window the history rounds already use.
const DIAG_WINDOW_LINES = 16;
function diagHasClass(el, name) {
    if (!el) return false;
    if (el.classList && typeof el.classList.contains === 'function' && el.classList.contains(name)) return true;
    return String(el.className || '').split(/\s+/).indexOf(name) >= 0;
}
function diagAddClass(el, name) {
    if (!el || diagHasClass(el, name)) return;
    if (el.classList && typeof el.classList.add === 'function') {
        el.classList.add(name);
        return;
    }
    el.className = (String(el.className || '') + ' ' + name).trim();
}
function diagRemoveClass(el, name) {
    if (!el || !diagHasClass(el, name)) return;
    if (el.classList && typeof el.classList.remove === 'function') {
        el.classList.remove(name);
        return;
    }
    if (el.classList && typeof el.classList.toggle === 'function') {
        el.classList.toggle(name);
        return;
    }
    el.className = String(el.className || '').split(/\s+/).filter(part => part && part !== name).join(' ');
}
function diagDirect(el, name) {
    const kids = el && el.children;
    if (!kids) return null;
    for (let i = 0; i < kids.length; i++) if (diagHasClass(kids[i], name)) return kids[i];
    return null;
}
function diagText(el) {
    return String(el && el.textContent || '').replace(/\n+$/g, '');
}
function diagLong(el) {
    const text = diagText(el);
    if (!text.trim()) return false;
    if (text.split('\n').length > DIAG_WINDOW_LINES) return true;
    if (typeof visualLineCount !== 'function' || typeof charsPerLine !== 'function') return false;
    try { return visualLineCount(text, charsPerLine(el)) > DIAG_WINDOW_LINES; }
    catch (e) { return false; }
}
function diagPlaceBefore(node, sibling) {
    const parent = node && node.parentNode;
    if (!parent || !parent.children) return;
    if (typeof parent.insertBefore === 'function') {
        parent.insertBefore(sibling, node);
        return;
    }
    const at = parent.children.indexOf(node);
    if (at < 0) return;
    parent.children.splice(at, 0, sibling);
    sibling.parentNode = parent;
}
function bindDiagCard(card, condensedClass, head) {
    if (!card || diagDirect(card, 'round-expand-hit')) return;
    const link = document.createElement('button');
    link.className = 'toggle-link round-head-condense';
    link.type = 'button';
    link.textContent = 'click to condense';
    link.style.display = 'none';
    const hit = document.createElement('button');
    hit.className = 'round-expand-hit';
    hit.type = 'button';
    hit.title = 'click to expand';
    if (typeof hit.setAttribute === 'function') hit.setAttribute('aria-label', 'click to expand');
    const setOn = (on) => {
        if (on) diagAddClass(card, condensedClass);
        else diagRemoveClass(card, condensedClass);
        link.style.display = on ? 'none' : '';
        if (typeof refreshScrollJumps === 'function') refreshScrollJumps(card);
    };
    hit.onclick = (event) => {
        if (event && event.preventDefault) event.preventDefault();
        setOn(false);
    };
    link.onclick = () => setOn(true);
    card.appendChild(hit);
    if (head && typeof head.appendChild === 'function') head.appendChild(link);
    else diagPlaceBefore(card, link);
    setOn(true);
}
function tintDiagnosticsCards(root) {
    if (!root) return;
    const found = [];
    const visit = (el) => {
        if (!el) return;
        let kind = '';
        if (diagHasClass(el, 'thinking')) kind = 'thinking';
        else if (diagHasClass(el, 'tool')) kind = 'tool';
        else if (diagHasClass(el, 'error')) kind = 'error';
        if (kind) found.push(el);
        const kids = el.children;
        if (!kids) return;
        for (let i = 0; i < kids.length; i++) visit(kids[i]);
    };
    const kids = root.children;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) visit(kids[i]);
    for (let i = 0; i < found.length; i++) {
        const card = found[i];
        const source = diagHasClass(card, 'thinking') ? (diagDirect(card, 'thinking-body') || card) : card;
        if (!diagLong(source)) continue;
        const condensedClass = diagHasClass(card, 'tool') ? 'tool-condensed' : 'diag-condensed';
        bindDiagCard(card, condensedClass, diagDirect(card, 'thinking-head'));
    }
}
// A live round collapses by hiding its body. Diagnostics shows that same
// text through the tinted window instead.
function openDiagnosticRounds(s) {
    const rounds = s && s.nodes && s.nodes.rounds;
    if (!rounds || typeof rounds.values !== 'function') return;
    for (const r of rounds.values()) {
        if (!r || !r.body || !r.condensed || !r.body.style || r.body.style.display !== 'none') continue;
        if (typeof setRoundCondensed === 'function') setRoundCondensed(r, true);
        r.body.style.display = '';
        if (r.preview && r.preview.style) r.preview.style.display = 'none';
        if (typeof showHeadCondense === 'function') showHeadCondense(r, false);
    }
}
function splitChainView(s) {
    const container = s && s.nodes && s.nodes.container;
    if (!container) return false;
    if (s.nodes.subtabs) return true; // already split
    const order = (s.data && s.data.order) || [];
    if (!order.length || !container.firstChild) return false; // nothing to split yet
    const lastN = order[order.length - 1];
    const r = s.nodes.rounds.get(lastN);

    // Build the split shell: one tab bar, two panes.
    const tabs = document.createElement('div');
    tabs.className = 'sub-tabs';
    tabs.setAttribute('role', 'tablist');
    const responseTab = document.createElement('button');
    responseTab.className = 'sub-tab';
    responseTab.type = 'button';
    responseTab.setAttribute('role', 'tab');
    responseTab.textContent = 'Response';
    const diagnosticsTab = document.createElement('button');
    diagnosticsTab.className = 'sub-tab';
    diagnosticsTab.type = 'button';
    diagnosticsTab.setAttribute('role', 'tab');
    diagnosticsTab.textContent = 'Diagnostics';
    tabs.appendChild(responseTab);
    tabs.appendChild(diagnosticsTab);

    const responsePane = document.createElement('div');
    responsePane.className = 'sub-pane response-pane';
    responsePane.setAttribute('role', 'tabpanel');
    const diagnosticsPane = document.createElement('div');
    diagnosticsPane.className = 'sub-pane diagnostics-pane';
    diagnosticsPane.setAttribute('role', 'tabpanel');

    // First pass: stream everything into the diagnostics pane, unchanged and
    // in streaming order.
    while (container.firstChild) diagnosticsPane.appendChild(container.firstChild);

    // Second pass: rebuild the final answer as the Response pane.
    if (r) {
        const answer = document.createElement('div');
        answer.className = 'round response-answer';
        const head = document.createElement('div');
        head.className = 'round-head';
        const h = document.createElement('h3');
        const answerText = r.contentEl ? String(r.contentEl.textContent || '').trim() : '';
        h.textContent = (s.runError && answerText === s.runError) ? '▶ RUN STOPPED' : '▶ FINAL RESPONSE';
        const body = document.createElement('div');
        body.className = 'round-body response-body';
        body.appendChild(r.contentEl);
        body.appendChild(r.renderedEl);
        head.appendChild(h);
        const selCopy = document.createElement('button');
        selCopy.className = 'copy-btn';
        selCopy.type = 'button';
        selCopy.textContent = 'copy\nselected';
        selCopy.title = 'Copy the highlighted text';
        selCopy.onmousedown = (event) => { if (typeof holdPageSelection === 'function') holdPageSelection(event); };
        selCopy.onclick = () => { if (typeof copySelection === 'function') copySelection(selCopy); };
        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-btn';
        copyBtn.type = 'button';
        copyBtn.textContent = 'copy\nfull';
        copyBtn.title = 'Copy the final response';
        const selCurate = document.createElement('button');
        selCurate.className = 'copy-btn';
        selCurate.type = 'button';
        selCurate.textContent = 'curate\nselected';
        selCurate.title = 'Append the highlighted text to the prompt, with a blank line and no context label';
        selCurate.onmousedown = (event) => { if (typeof holdPageSelection === 'function') holdPageSelection(event); };
        selCurate.onclick = () => { if (typeof curateSelection === 'function') curateSelection(); };
        const curateBtn = document.createElement('button');
        curateBtn.className = 'copy-btn';
        curateBtn.type = 'button';
        curateBtn.textContent = 'curate\nfull';
        curateBtn.title = 'Append this response to the prompt as a context block';
        curateBtn.onclick = () => { if (typeof curateResponse === 'function') curateResponse(s, lastN); };
        const actions = document.createElement('span');
        actions.className = 'round-actions';
        actions.appendChild(selCopy);
        actions.appendChild(copyBtn);
        actions.appendChild(selCurate);
        actions.appendChild(curateBtn);
        head.appendChild(actions);
        answer.appendChild(head);
        answer.appendChild(body);
        responsePane.appendChild(answer);
        copyBtn.onclick = () => copyText(rawBodyText({ body }), copyBtn);
        // Leave a pointer in the vacated round so diagnostics stays navigable.
        if (r.body) {
            const note = document.createElement('div');
            note.className = 'metrics';
            note.textContent = '(final response is in the Response tab)';
            r.body.appendChild(note);
        }
    }

    container.appendChild(tabs);
    container.appendChild(responsePane);
    container.appendChild(diagnosticsPane);
    openDiagnosticRounds(s);
    tintDiagnosticsCards(diagnosticsPane);
    s.nodes.subtabs = { tabs, responseTab, diagnosticsTab, responsePane, diagnosticsPane };
    responseTab.onclick = () => {
        activateChainSub(s, 'response');
        if (typeof revealPaneStart === 'function') revealPaneStart(s, responsePane);
    };
    diagnosticsTab.onclick = () => {
        activateChainSub(s, 'diagnostics');
        const sc = s && s.scroll;
        const win = typeof SCROLL_WINDOW === 'number' ? SCROLL_WINDOW : 8;
        const showStart = () => {
            if (typeof revealPaneStart === 'function') revealPaneStart(s, diagnosticsPane);
        };
        // A long recorded run is opened on its last rounds. Load round 1
        // so the transcript under the session header is the start of the
        // run. The scroll lands on that header, not on the first card.
        if (sc && sc.engaged && sc.from > 1 && typeof shiftWindow === 'function') {
            sc.follow = false;
            const to = Math.max(1, Math.min(sc.maxRound || win, win));
            Promise.resolve(shiftWindow(s, 1, to)).then(showStart, showStart);
            return;
        }
        showStart();
    };
    activateChainSub(s, 'response');
    return true;
}
function activateChainSub(s, which) {
    const refs = s && s.nodes && s.nodes.subtabs;
    if (!refs) return;
    const showResponse = which === 'response';
    refs.responsePane.hidden = !showResponse;
    refs.diagnosticsPane.hidden = showResponse;
    refs.responseTab.classList.toggle('sub-tab-active', showResponse);
    refs.diagnosticsTab.classList.toggle('sub-tab-active', !showResponse);
}
