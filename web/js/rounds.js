// rounds.js — per-round display: DOM sections, condense/expand, thinking
// and rendered views, per-round data capture. Needs core.js, tabs.js.
function ensureRound(s, n, model) {
    const R = s.nodes.rounds;
    if (R.has(n)) return R.get(n);
    const sec = document.createElement('div');
    sec.className = 'round';
    const head = document.createElement('div');
    head.className = 'round-head';
    const h = document.createElement('h3');
    h.textContent = '▶ MODEL (round ' + n + ')' + (model ? ' · ' + model : '');
    head.appendChild(h);
    const toolSummary = document.createElement('div');
    toolSummary.className = 'round-tools';
    head.appendChild(toolSummary);
    // Shown in the tool-count slot only while a history window is expanded.
    const condenseLink = document.createElement('button');
    condenseLink.className = 'toggle-link round-head-condense';
    condenseLink.type = 'button';
    condenseLink.style.display = 'none';
    condenseLink.textContent = 'click to condense';
    condenseLink.onclick = () => toggleRound(s, n);
    head.appendChild(condenseLink);
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
    copyBtn.title = 'Copy this whole round';
    copyBtn.onclick = () => copyText(rawBodyText({ body }), copyBtn);
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
    curateBtn.title = 'Append this round to the prompt. Thinking, the response, and each tool call or result keep their context labels.';
    curateBtn.onclick = () => { if (typeof curateRound === 'function') curateRound(s, n); };
    const actions = document.createElement('span');
    actions.className = 'round-actions';
    actions.appendChild(selCopy);
    actions.appendChild(copyBtn);
    actions.appendChild(selCurate);
    actions.appendChild(curateBtn);
    head.appendChild(actions);
    sec.appendChild(head);
    const body = document.createElement('div');
    body.className = 'round-body';
    sec.appendChild(body);
    const det = document.createElement('div');
    det.className = 'thinking';
    const thinkingHead = document.createElement('div');
    thinkingHead.className = 'thinking-head';
    const sum = document.createElement('div');
    sum.className = 'thinking-label';
    sum.textContent = 'thinking (streaming when the model provides it)';
    thinkingHead.appendChild(sum);
    det.appendChild(thinkingHead);
    const tb = document.createElement('div');
    tb.className = 'thinking-body';
    det.appendChild(tb);
    body.appendChild(det);
    const content = document.createElement('div');
    content.className = 'content';
    body.appendChild(content);
    const rendered = document.createElement('div');
    rendered.className = 'rendered-body';
    rendered.style.display = 'none';
    body.appendChild(rendered);
    const viewToggle = document.createElement('button');
    viewToggle.className = 'view-toggle';
    viewToggle.type = 'button';
    viewToggle.style.display = 'none';
    viewToggle.textContent = 'view rendered';
    body.appendChild(viewToggle);
    // Covers a condensed history window. The tint stays visible through it,
    // and a click expands the round. Hidden unless that window is condensed.
    const expandHit = document.createElement('button');
    expandHit.className = 'round-expand-hit';
    expandHit.type = 'button';
    expandHit.title = 'click to expand';
    if (typeof expandHit.setAttribute === 'function') expandHit.setAttribute('aria-label', 'click to expand');
    expandHit.onclick = (event) => {
        if (event && event.preventDefault) event.preventDefault();
        toggleRound(s, n);
    };
    body.appendChild(expandHit);
    const preview = document.createElement('div');
    preview.className = 'round-preview';
    preview.style.display = 'none';
    sec.appendChild(preview);
    const toggle = document.createElement('button');
    toggle.className = 'toggle-link';
    toggle.type = 'button';
    toggle.style.display = 'none';
    toggle.textContent = 'click to expand';
    // History replays are removed from the live-session registry after
    // rendering, but their DOM and controls remain mounted in the history tab.
    // Only this bottom link reveals the card after a condense; the head link
    // keeps the reader's current viewing position.
    toggle.onclick = () => toggleRound(s, n, true);
    sec.appendChild(toggle);
    const attach = typeof roundShouldAttach !== 'function' || roundShouldAttach(s, n);
    if (attach) {
        if (typeof placeRoundElement === 'function') placeRoundElement(s, n, sec);
        else s.nodes.container.appendChild(sec);
    }
    const ref = { sec, body, preview, toggle, det, thinkingBody: tb, contentEl: content, renderedEl: rendered, viewToggle, toolSummary, condenseLink, expandHit, showingRendered: false, condensed: false, finalized: false, totalLines: 0 };
    viewToggle.onclick = () => {
        if (ref.showingRendered) {
            ref.renderedEl.style.display = 'none';
            ref.contentEl.style.display = '';
            viewToggle.textContent = 'view rendered';
            ref.showingRendered = false;
        } else {
            ref.contentEl.style.display = 'none';
            ref.renderedEl.style.display = '';
            viewToggle.textContent = 'view as text';
            ref.showingRendered = true;
        }
    };
    R.set(n, ref);
    return ref;
}
// Shared by live streaming, restored tabs, and history replay. Keep raw text
// intact for copying while always opening formatted responses in rendered view.
function showRenderedResponse(s, n, html) {
    const r = ensureRound(s, n);
    // The server already sanitizes ContentHtml, but storage/history can be
    // poisoned by a writer with access to this machine. If the client
    // sanitizer is available, apply it again before touching innerHTML.
    const safe = (typeof sanitizeRendered === 'function')
        ? sanitizeRendered(html, false)
        : html;
    r.renderedEl.innerHTML = safe;
    try { highlightRendered(r.renderedEl); } catch (e) {}
    try { renderMath(r.renderedEl); } catch (e) {}
    r.viewToggle.style.display = '';
    r.contentEl.style.display = 'none';
    r.renderedEl.style.display = '';
    r.viewToggle.textContent = 'view as text';
    r.showingRendered = true;
    roundData(s, n).contentHtml = safe;
}

function rawBodyText(r) {
    // Copy/condense operate on raw text only — display-only blocks are
    // stripped so they cannot duplicate or inflate counts: sanitized
    // rendered markdown, raw/pretty toggles and their pretty views
    // (the raw view is the copy source), and the controls themselves.
    const clone = r.body.cloneNode(true);
    const drop = (selector) => {
        if (typeof clone.querySelectorAll === 'function') {
            for (const node of Array.prototype.slice.call(clone.querySelectorAll(selector))) {
                node.remove();
            }
            return;
        }
        const one = clone.querySelector(selector);
        if (one) one.remove();
    };
    drop('.rendered-body');
    drop('.view-toggle');
    drop('.shell-pretty');
    dropCloneControls(clone);
    return clone.textContent || '';
}
function dropCloneControls(node) {
    const kids = node && node.children ? Array.prototype.slice.call(node.children) : [];
    for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        const name = String(child && child.className || '');
        const list = child && child.classList;
        const listed = list && typeof list.contains === 'function'
            && (list.contains('round-expand-hit') || list.contains('round-head-condense'));
        const named = /(^|\s)round-expand-hit(\s|$)/.test(name) || /(^|\s)round-head-condense(\s|$)/.test(name);
        if (listed || named) {
            if (typeof child.remove === 'function') child.remove();
            else if (typeof node.removeChild === 'function') node.removeChild(child);
            continue;
        }
        dropCloneControls(child);
    }
}
function setRoundCondensed(r, on) {
    r.body.className = on ? 'round-body round-condensed' : 'round-body';
}
function showHeadCondense(r, on) {
    if (!r || !r.condenseLink) return;
    r.condenseLink.style.display = on ? '' : 'none';
}
// Collapsing from the link below a long history card can leave the shortened
// card entirely above the viewport. Move back to it only when no usable part
// remains on screen, and keep the card clear of the sticky dashboard.
function revealHistoryCard(card, s) {
    if (!card || typeof card.getBoundingClientRect !== 'function' || typeof window === 'undefined') return;
    const viewH = window.innerHeight || 0;
    if (!(viewH > 0)) return;
    const rect = card.getBoundingClientRect();
    const viewTop = scrollViewportTop();
    if (rect.bottom > viewTop && rect.top < viewH) return;
    if (typeof scrollBlockBelowDashboard === 'function') {
        scrollBlockBelowDashboard(card);
    } else if (typeof window.scrollBy === 'function') {
        try { window.scrollBy(0, rect.top - viewTop); }
        catch (e) {
            if (typeof card.scrollIntoView === 'function') {
                try { card.scrollIntoView({ block: 'start', inline: 'nearest' }); }
                catch (err) { try { card.scrollIntoView(true); } catch (err2) {} }
            }
        }
    } else if (typeof card.scrollIntoView === 'function') {
        try { card.scrollIntoView({ block: 'start', inline: 'nearest' }); }
        catch (e) { try { card.scrollIntoView(true); } catch (err) {} }
    }
    if (s && s.scroll && typeof holdScroll === 'function') holdScroll(s);
}
function appendRoundToolTip(parent, s, label, lines) {
    const span = document.createElement('span');
    span.className = 'round-tool-count has-tasks';
    span.tabIndex = 0;
    const name = document.createElement('span');
    name.className = 'round-tool-name';
    name.textContent = label;
    span.appendChild(name);
    const tip = document.createElement('span');
    tip.className = 'round-tool-tasks';
    if (typeof tip.setAttribute === 'function') tip.setAttribute('role', 'tooltip');
    for (let t = 0; t < lines.length; t++) {
        const row = document.createElement('span');
        row.textContent = typeof displaySessionText === 'function' ? displaySessionText(s, lines[t]) : lines[t];
        tip.appendChild(row);
    }
    span.appendChild(tip);
    parent.appendChild(span);
}
function paintRoundToolSummary(s, n, show) {
    const r = s && s.nodes && s.nodes.rounds.get(n);
    if (!r || !r.toolSummary) return;
    const round = s.data && s.data.rounds ? s.data.rounds[n] : null;
    const visible = !!(show && s.historyView);
    const groups = (visible && typeof roundToolSummaryGroups === 'function')
        ? roundToolSummaryGroups(round)
        : [];
    const metaLines = (visible && typeof roundMetaLines === 'function')
        ? roundMetaLines(round && round.metrics, s.data)
        : [];
    const showMeta = visible && (groups.length > 0 || metaLines.length > 0);
    r.toolSummary.className = (groups.length || showMeta) ? 'round-tools round-tools-on' : 'round-tools';
    if (typeof clearNode === 'function') clearNode(r.toolSummary);
    else r.toolSummary.textContent = '';
    for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        if (group.tasks) {
            const lines = group.tasks.length ? group.tasks : ['No task recorded.'];
            appendRoundToolTip(r.toolSummary, s, group.label, lines);
        } else {
            const span = document.createElement('span');
            span.className = 'round-tool-count';
            const name = document.createElement('span');
            name.className = 'round-tool-name';
            name.textContent = group.label;
            span.appendChild(name);
            r.toolSummary.appendChild(span);
        }
    }
    if (showMeta) {
        appendRoundToolTip(r.toolSummary, s, 'meta', metaLines.length ? metaLines : ['No metadata recorded.']);
    }
}
function toggleRound(s, n, revealAfterCondense) {
    const r = s.nodes.rounds.get(n);
    if (!r) return;
    if (s.historyView) {
        const condensing = !r.condensed;
        if (r.condensed) {
            setRoundCondensed(r, false);
            r.body.style.display = '';
            r.preview.style.display = 'none';
            r.toggle.textContent = 'click to condense';
            r.condensed = false;
            paintRoundToolSummary(s, n, false);
            showHeadCondense(r, true);
        } else {
            setRoundCondensed(r, true);
            r.body.style.display = '';
            r.preview.style.display = 'none';
            r.toggle.textContent = 'click to expand (' + r.totalLines + ' lines total)';
            r.condensed = true;
            paintRoundToolSummary(s, n, true);
            showHeadCondense(r, false);
        }
        refreshScrollJumps(r.body);
        if (condensing && typeof settleHistoryWindow === 'function') settleHistoryWindow(s);
        maybeScroll();
        if (condensing && revealAfterCondense) revealHistoryCard(r.sec, s);
        return;
    }
    if (r.condensed) {
        r.body.style.display = '';
        r.preview.style.display = 'none';
        r.toggle.textContent = 'click to condense';
        r.condensed = false;
    } else {
        r.body.style.display = 'none';
        r.preview.style.display = '';
        r.toggle.textContent = 'click to expand (' + r.totalLines + ' lines total)';
        r.condensed = true;
    }
    maybeScroll();
}
function finalizeRound(sid, n) {
    const s = getSession(sid);
    const r = s && s.nodes.rounds.get(n);
    if (!r || r.finalized) return;
    r.finalized = true;
    const text = rawBodyText(r);
    const newlineCount = text.split('\n').length;
    const cpl = charsPerLine();
    const visual = visualLineCount(text, cpl);
    r.totalLines = visual;
    const limit = s.historyView ? 16 : COLLAPSE_LINES;
    if (newlineCount <= limit && visual <= limit) {
        if (s.historyView) {
            paintRoundToolSummary(s, n, false);
            refreshScrollJumps(r.body);
        }
        if (typeof tintDiagnosticsCards === 'function') tintDiagnosticsCards(r.body);
        return;
    }
    if (s.historyView) {
        setRoundCondensed(r, true);
        r.body.style.display = '';
        r.preview.style.display = 'none';
        r.toggle.style.display = '';
        r.toggle.textContent = 'click to expand (~' + visual + ' lines total)';
        r.condensed = true;
        paintRoundToolSummary(s, n, true);
        showHeadCondense(r, false);
        refreshScrollJumps(r.body);
        if (typeof tintDiagnosticsCards === 'function') tintDiagnosticsCards(r.body);
        return;
    }
    const built = previewForBudget(text, cpl, COLLAPSE_LINES);
    r.preview.textContent = built.preview + '\n… [' + newlineCount + ' text lines / ~' + visual + ' display lines — showing ~' + built.used + ' — click to expand]';
    r.body.style.display = 'none';
    r.preview.style.display = '';
    r.toggle.style.display = '';
    r.toggle.textContent = 'click to expand (~' + visual + ' lines total)';
    r.condensed = true;
    if (typeof tintDiagnosticsCards === 'function') tintDiagnosticsCards(r.body);
}
function roundData(s, n) {
    if (!s.data.rounds[n]) {
        s.data.rounds[n] = { model: '', thinking: '', content: '', contentHtml: '', toolCalls: [], toolResults: [], toolPreviews: [], evidence: [], metrics: null };
        s.data.order.push(n);
    }
    return s.data.rounds[n];
}
function paintContextBudgetNotes(r, messages) {
    if (!r || !r.sec) return;
    const want = (messages || []).filter(line => String(line || '').trim());
    const sec = r.sec;
    const kids = sec.children ? Array.prototype.slice.call(sec.children) : [];
    for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        const cls = String((child && child.className) || '');
        if (/(^|\s)context-budget(\s|$)/.test(cls) && child.parentNode === sec) sec.removeChild(child);
    }
    // The line sits above the round body: it belongs to the round it
    // was computed for, and is repainted, not appended, each time.
    const anchor = r.body && r.body.parentNode === sec ? r.body : null;
    for (let i = 0; i < want.length; i++) {
        const d = document.createElement('div');
        d.className = 'metrics context-budget';
        d.textContent = '◈ ' + want[i];
        if (anchor && typeof sec.insertBefore === 'function') sec.insertBefore(d, anchor);
        else sec.appendChild(d);
    }
}
function rememberContextBudget(s, n, message) {
    const text = String(message || '').trim();
    const roundN = Number(n);
    if (!text || !(roundN > 0) || !s) return;
    const data = roundData(s, roundN);
    if (!Array.isArray(data.contextBudgets)) data.contextBudgets = [];
    if (data.contextBudgets.indexOf(text) < 0) data.contextBudgets.push(text);
    paintContextBudgetNotes(ensureRound(s, roundN), data.contextBudgets);
}
function maybeScroll() {
    try {
        const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 250;
        if (nearBottom) window.scrollTo(0, document.body.scrollHeight);
    } catch (e) {}
}
// Jump arrows for an expanded history round or tool card whose text runs
// past the window. Each arrow is offered only while its own edge of the
// text is off screen. Its click zone is a full-width band with the same
// inward reach the old proximity semicircle had; the centered icon fades
// in anywhere in that band and the whole band performs the jump.
// The sticky control bar covers the top of the window. The top arrow
// and its band hang from the bar's bottom, not from y=0, or the icon is
// painted under the bar and the hover region never meets the pointer.
// A jump lands one line past that edge, so the neighboring round's header
// stays in view and the landing does not look like the end of the session.
// The start landing also clears the control bar.
const SCROLL_JUMP_REACH = 72;
let scrollJumpPanels = [];
let scrollJumpHits = [];
let scrollJumpListen = false;
let scrollJumpMouse = null;
let scrollJumpSeq = 0;
let scrollJumpFrame = 0;
function scrollArrowSrc() {
    try {
        if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return 'scroll_arrow_blue.png';
        const meta = document.querySelector('meta[name="scroll-arrow"]');
        const value = meta && meta.getAttribute ? (meta.getAttribute('content') || '') : '';
        if (value && value.charAt(0) !== '{') return value;
    } catch (e) {}
    return 'scroll_arrow_blue.png';
}
// Bottom edge of #controlDashboard while it is stuck over the page.
// Matches dashboardCover in scroll.js. A bar that fills the viewport
// is ignored so a bad measurement cannot hide every arrow.
function scrollViewportTop() {
    try {
        if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return 0;
        const bar = document.getElementById('controlDashboard');
        if (!bar || typeof bar.getBoundingClientRect !== 'function') return 0;
        const bottom = bar.getBoundingClientRect().bottom;
        if (!(bottom > 1)) return 0;
        const viewH = (typeof window !== 'undefined' && window.innerHeight) || 0;
        if (viewH > 0 && bottom >= viewH - 1) return 0;
        return bottom;
    } catch (e) {
        return 0;
    }
}
function scrollJumpDomOk(panel) {
    return !!(panel
        && typeof panel.appendChild === 'function'
        && typeof panel.getBoundingClientRect === 'function'
        && typeof document !== 'undefined'
        && typeof document.createElement === 'function');
}
function panelCondensed(panel) {
    return /(^|\s)(?:round-condensed|tool-condensed|diag-condensed)(?:\s|$)/.test(String(panel && panel.className || ''));
}
function hasClassToken(el, name) {
    return new RegExp('(^|\\s)' + name + '(?:\\s|$)').test(String(el && el.className || ''));
}
// A Round that holds both a Tool Call and a Tool Result is only the
// frame. Each window owns its own jump. The parent arrow used to paint
// in the call and jump to the result, because the result link was
// positioned against the round.
function splitToolWindows(panel) {
    if (!hasClassToken(panel, 'round-body')) return null;
    const kids = panel.children;
    if (!kids) return null;
    let call = false;
    let result = false;
    const tools = [];
    for (let i = 0; i < kids.length; i++) {
        const kid = kids[i];
        if (!hasClassToken(kid, 'tool')) continue;
        tools.push(kid);
        if (hasClassToken(kid, 'tool-result')) result = true;
        else call = true;
    }
    if (!call || !result) return null;
    return tools;
}
function ensureSplitToolJumps(panel) {
    const tools = splitToolWindows(panel);
    if (!tools) return;
    for (let i = 0; i < tools.length; i++) {
        if (!panelCondensed(tools[i])) ensureScrollJumps(tools[i]);
    }
}
function scrollJumpInBox(mx, my, box) {
    if (!box) return false;
    return mx >= box.left && mx <= box.right && my >= box.top && my <= box.bottom;
}
function setJumpNear(el, on) {
    if (!el) return;
    if (el.classList && typeof el.classList.toggle === 'function') el.classList.toggle('is-near', !!on);
    if (typeof el.setAttribute === 'function') el.setAttribute('aria-hidden', on ? 'false' : 'true');
}
// Top arrow when the start of the text is off screen. Bottom arrow when
// the end is off screen. A panel that does not meet the viewport has
// neither, because there is no visible text edge to hang an icon on.
// A body that fits between the control bar and the window bottom is
// already fully readable, even if it is currently clipped by scroll
// position. An arrow there only jumps to the neighbor. scrollHeight is
// ignored: child margins and a 1px inner gap used to mark a visible
// border as off screen and offer that same neighbor jump.
function scrollTextEdges(panel) {
    const none = { rect: null, viewH: 0, viewTop: 0, showUp: false, showDown: false };
    if (!panel || panelCondensed(panel) || typeof panel.getBoundingClientRect !== 'function') return none;
    // Call and result each carry their own arrow. The round must not
    // offer a second one that covers both windows.
    if (splitToolWindows(panel)) return none;
    const rect = panel.getBoundingClientRect();
    const viewH = (typeof window !== 'undefined' && window.innerHeight) || 0;
    const viewW = (typeof window !== 'undefined' && window.innerWidth) || 0;
    const viewTop = scrollViewportTop();
    if (!(rect.height > 0) || !(rect.width > 0) || !(viewH > 0)) return none;
    const xOn = !(viewW > 0) || (rect.right > 1 && rect.left < viewW - 1);
    // Text under the control bar is not on screen. Using y=0 here hides
    // the top arrow behind the bar.
    const meetsView = rect.bottom > viewTop + 1 && rect.top < viewH - 1 && xOn;
    if (!meetsView) return { rect: rect, viewH: viewH, viewTop: viewTop, showUp: false, showDown: false };
    const room = viewH - viewTop;
    if (rect.height <= room + 1) {
        return { rect: rect, viewH: viewH, viewTop: viewTop, showUp: false, showDown: false };
    }
    const topVisible = rect.top >= viewTop - 1 && rect.top <= viewH + 1;
    const bottomVisible = rect.bottom >= -1 && rect.bottom <= viewH + 1;
    return { rect: rect, viewH: viewH, viewTop: viewTop, showUp: !topVisible, showDown: !bottomVisible };
}
function makeScrollJumpLink(which, label) {
    const link = document.createElement('a');
    link.className = 'scroll-jump scroll-jump-' + which;
    link.hidden = true;
    if (typeof link.setAttribute === 'function') {
        link.setAttribute('aria-label', label);
        link.setAttribute('tabindex', '-1');
        link.setAttribute('aria-hidden', 'true');
    }
    const img = document.createElement('img');
    img.className = 'scroll-jump-icon';
    img.src = scrollArrowSrc();
    img.alt = '';
    img.draggable = false;
    if (typeof img.setAttribute === 'function') {
        img.setAttribute('alt', '');
        img.setAttribute('draggable', 'false');
    }
    link.appendChild(img);
    return link;
}
// The card that owns this text block. History rounds and config tool
// cards are both a .round whose head sits above the scrolling text.
function scrollJumpCard(panel) {
    const parent = panel && panel.parentNode;
    const cls = String(parent && parent.className || '');
    if (/(^|\s)round(?:\s|$)/.test(cls)) return parent;
    return null;
}
function scrollJumpChild(node, kind) {
    const kids = node && node.children;
    if (!kids) return null;
    const re = new RegExp('(^|\\s)' + kind + '(?:\\s|$)');
    for (let i = 0; i < kids.length; i++) {
        if (re.test(String(kids[i].className || ''))) return kids[i];
    }
    return null;
}
function scrollJumpLinePx(panel) {
    try {
        if (panel && typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
            const style = window.getComputedStyle(panel);
            const lh = parseFloat(style && style.lineHeight);
            if (lh > 0) return lh;
            const font = parseFloat(style && style.fontSize);
            if (font > 0) return font * 1.4;
        }
    } catch (e) {}
    return 22;
}
// Viewport Y that should sit against the window edge.
// Start: one line up into the previous card, so this round's header and
// a line of the previous round both clear the top. End: one line down
// into the next card's text, so the next header and its first line clear
// the bottom. Without a neighbor, still step past the text edge.
function scrollJumpNeighbors(panel) {
    const line = scrollJumpLinePx(panel);
    const rect = panel && typeof panel.getBoundingClientRect === 'function'
        ? panel.getBoundingClientRect() : null;
    const card = scrollJumpCard(panel);
    const prev = card && card.previousElementSibling;
    const next = card && card.nextElementSibling;
    let startPeek = null;
    let endPeek = null;
    if (prev && typeof prev.getBoundingClientRect === 'function') {
        const prevRect = prev.getBoundingClientRect();
        if (prevRect && prevRect.height > 0) startPeek = prevRect.bottom - line;
    }
    if (startPeek == null && card) {
        const head = scrollJumpChild(card, 'round-head');
        if (head && typeof head.getBoundingClientRect === 'function') {
            const headRect = head.getBoundingClientRect();
            if (headRect && headRect.height > 0) startPeek = headRect.top;
        }
    }
    if (startPeek == null && rect) startPeek = rect.top - line;
    if (next) {
        const block = scrollJumpChild(next, 'round-body') || scrollJumpChild(next, 'tool');
        if (block && typeof block.getBoundingClientRect === 'function') {
            endPeek = block.getBoundingClientRect().top + line;
        } else {
            const head = scrollJumpChild(next, 'round-head');
            if (head && typeof head.getBoundingClientRect === 'function') {
                endPeek = head.getBoundingClientRect().bottom + line;
            } else if (typeof next.getBoundingClientRect === 'function') {
                endPeek = next.getBoundingClientRect().top + line * 2;
            }
        }
    } else if (rect) {
        endPeek = rect.bottom + line * 3;
    }
    return { line: line, startPeek: startPeek, endPeek: endPeek };
}
// Positive delta scrolls the page down. The text edge stays inside the
// window, so the arrow for the edge just reached hides.
function scrollJumpDelta(edge, viewH, panelTop, panelBottom, line, peek, viewTop) {
    const pad = 4;
    const linePx = line > 0 ? line : 22;
    const topInset = viewTop > 0 ? viewTop : 0;
    if (!(viewH > 0)) return 0;
    if (edge === 'end') {
        const mark = peek == null ? panelBottom : peek;
        let delta = mark - (viewH - pad);
        if (panelBottom - delta < linePx) delta = panelBottom - linePx;
        return delta;
    }
    const mark = peek == null ? panelTop : peek;
    let delta = mark - (topInset + pad);
    if (panelTop - delta > viewH - linePx) delta = panelTop - (viewH - linePx);
    return delta;
}
function scrollJumpBy(panel, edge) {
    if (!panel || typeof panel.getBoundingClientRect !== 'function') return false;
    if (typeof window === 'undefined') return false;
    const rect = panel.getBoundingClientRect();
    const viewH = window.innerHeight || 0;
    const near = scrollJumpNeighbors(panel);
    const peek = edge === 'end' ? near.endPeek : near.startPeek;
    const viewTop = edge === 'end' ? 0 : scrollViewportTop();
    const delta = scrollJumpDelta(edge, viewH, rect.top, rect.bottom, near.line, peek, viewTop);
    if (Math.abs(delta) < 1) return true;
    if (typeof window.scrollBy === 'function') {
        window.scrollBy(0, delta);
        return true;
    }
    if (typeof window.scrollTo === 'function') {
        window.scrollTo(0, (window.scrollY || 0) + delta);
        return true;
    }
    return false;
}
function bindScrollJump(link, anchor, block) {
    link.href = '#' + anchor.id;
    link.onclick = (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        const panel = link.parentNode;
        const edge = block === 'end' ? 'end' : 'start';
        if (!scrollJumpBy(panel, edge) && anchor && typeof anchor.scrollIntoView === 'function') {
            try { anchor.scrollIntoView({ block: block, inline: 'nearest' }); }
            catch (e) {
                try { anchor.scrollIntoView(block !== 'end'); } catch (err) {}
            }
        }
        onScrollJumpFrame();
    };
}
function ensureScrollJumps(panel) {
    if (!scrollJumpDomOk(panel)) return null;
    if (panel._scrollJumps) return panel._scrollJumps;
    scrollJumpSeq += 1;
    const id = 'scroll-jump-' + scrollJumpSeq;
    const start = document.createElement('span');
    start.className = 'scroll-jump-anchor scroll-jump-anchor-start';
    start.id = id + '-start';
    const end = document.createElement('span');
    end.className = 'scroll-jump-anchor scroll-jump-anchor-end';
    end.id = id + '-end';
    const up = makeScrollJumpLink('up', 'Jump to the start of this text');
    const down = makeScrollJumpLink('down', 'Jump to the end of this text');
    bindScrollJump(up, start, 'start');
    bindScrollJump(down, end, 'end');
    panel.appendChild(start);
    panel.appendChild(end);
    panel.appendChild(up);
    panel.appendChild(down);
    panel._scrollJumps = { start: start, end: end, up: up, down: down };
    scrollJumpPanels.push(panel);
    armScrollJumpListeners();
    return panel._scrollJumps;
}
function measureScrollJumps() {
    const hits = [];
    const keep = [];
    const viewH = (typeof window !== 'undefined' && window.innerHeight) || 0;
    for (let i = 0; i < scrollJumpPanels.length; i++) {
        const panel = scrollJumpPanels[i];
        if (!panel || panel.isConnected === false || !panel._scrollJumps) continue;
        keep.push(panel);
        const jumps = panel._scrollJumps;
        const edges = scrollTextEdges(panel);
        const showUp = edges.showUp;
        const showDown = edges.showDown;
        jumps.up.hidden = !showUp;
        jumps.down.hidden = !showDown;
        if (!showUp) setJumpNear(jumps.up, false);
        if (!showDown) setJumpNear(jumps.down, false);
        if (!showUp && !showDown) {
            hits.push({ showUp: false, showDown: false, up: jumps.up, down: jumps.down });
            continue;
        }
        const rect = edges.rect;
        const viewTop = edges.viewTop > 0 ? edges.viewTop : 0;
        const visibleTop = Math.max(rect.top, viewTop);
        const visibleBottom = Math.min(rect.bottom, viewH || rect.bottom);
        const icon = jumps.up.children[0];
        let iconH = icon && icon.offsetHeight > 0 ? icon.offsetHeight : 0;
        if (!iconH && icon && typeof icon.getBoundingClientRect === 'function') {
            const iconBox = icon.getBoundingClientRect();
            iconH = iconBox && iconBox.height > 0 ? iconBox.height : 0;
        }
        if (!iconH) iconH = 22;
        // One arrow-height in from the visible edge. The top edge is the
        // control bar, not the window, so the chevron is not under it.
        const pad = iconH;
        let upTop = visibleTop - rect.top + pad;
        let downTop = visibleBottom - rect.top - iconH - pad;
        if (showUp && showDown && downTop < upTop + iconH + 4) downTop = upTop + iconH + 4;
        // The old proximity area reached inward from the icon. Keep that
        // vertical reach, but use the panel's whole width for hover/click.
        if (showUp) {
            jumps.up.style.top = upTop + 'px';
            jumps.up.style.height = (iconH + SCROLL_JUMP_REACH) + 'px';
        }
        if (showDown) {
            jumps.down.style.top = (downTop - SCROLL_JUMP_REACH) + 'px';
            jumps.down.style.height = (iconH + SCROLL_JUMP_REACH) + 'px';
        }
        // Measure the links after sizing them so hover uses exactly the
        // rectangle the browser makes clickable, including card padding.
        const upBox = showUp ? jumps.up.getBoundingClientRect() : null;
        const downBox = showDown ? jumps.down.getBoundingClientRect() : null;
        hits.push({
            showUp: showUp,
            showDown: showDown,
            up: jumps.up,
            down: jumps.down,
            upBox: upBox,
            downBox: downBox
        });
    }
    scrollJumpPanels = keep;
    scrollJumpHits = hits;
}
function applyScrollJumpNear() {
    const mouse = scrollJumpMouse;
    for (let i = 0; i < scrollJumpHits.length; i++) {
        const hit = scrollJumpHits[i];
        if (!hit || !mouse) {
            if (hit) {
                setJumpNear(hit.up, false);
                setJumpNear(hit.down, false);
            }
            continue;
        }
        const up = hit.showUp && scrollJumpInBox(mouse.x, mouse.y, hit.upBox);
        const down = hit.showDown && scrollJumpInBox(mouse.x, mouse.y, hit.downBox);
        setJumpNear(hit.up, up);
        setJumpNear(hit.down, down);
    }
}
function onScrollJumpMouse(event) {
    if (!event) return;
    scrollJumpMouse = { x: event.clientX, y: event.clientY };
    applyScrollJumpNear();
}
function onScrollJumpFrame() {
    if (scrollJumpFrame) return;
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
        measureScrollJumps();
        applyScrollJumpNear();
        return;
    }
    scrollJumpFrame = window.requestAnimationFrame(() => {
        scrollJumpFrame = 0;
        measureScrollJumps();
        applyScrollJumpNear();
    });
}
function armScrollJumpListeners() {
    if (scrollJumpListen || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    scrollJumpListen = true;
    window.addEventListener('mousemove', onScrollJumpMouse, { passive: true });
    window.addEventListener('scroll', onScrollJumpFrame, { passive: true });
    window.addEventListener('resize', onScrollJumpFrame, { passive: true });
}
function refreshScrollJumps(panel) {
    if (!panel || typeof panel.getBoundingClientRect !== 'function') return;
    if (!panelCondensed(panel)) ensureScrollJumps(panel);
    ensureSplitToolJumps(panel);
    measureScrollJumps();
    applyScrollJumpNear();
}
function refreshHistoryScrollJumps(s) {
    if (!s || !s.nodes || !s.nodes.rounds) return;
    for (const ref of s.nodes.rounds.values()) {
        if (ref && ref.body && !ref.condensed) {
            ensureScrollJumps(ref.body);
            ensureSplitToolJumps(ref.body);
        }
    }
    measureScrollJumps();
    applyScrollJumpNear();
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => {
            measureScrollJumps();
            applyScrollJumpNear();
        });
    }
}
