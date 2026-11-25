// scroll.js — continual scroll for long chains.
// A round is one block. Once a recorded run is longer than SCROLL_WINDOW
// rounds, the page keeps that many mounted and drops the rest from the
// DOM and from the heavy strings in memory. Scrolling to an edge shifts
// the window by SCROLL_SHIFT rounds and loads the gap from session
// history. The round still streaming stays in memory: its text is written
// to the database only after that round's stream finishes.
// Needs rounds.js, stream.js (handleEvent). storage.js and history.js
// call back into this file.

const SCROLL_WINDOW = 8;
const SCROLL_SHIFT = 4;
const SCROLL_ESTIMATE = 280;
const SCROLL_EDGE = 240;
const SCROLL_SKIP = { done: 1, run_started: 1, history_status: 1, prompt: 1 };

let historyScrollSession = null;
let scrollListenerOn = false;

function tailRange(maxRound) {
    const to = maxRound > 0 ? maxRound : 0;
    if (to <= 0) return { from: 0, to: 0 };
    return { from: Math.max(1, to - SCROLL_WINDOW + 1), to: to };
}

function shiftRange(from, to, maxRound, direction) {
    from = Math.max(1, from | 0);
    to = Math.max(from, to | 0);
    maxRound = Math.max(to, maxRound | 0);
    if (direction < 0) {
        if (from <= 1) return { from: from, to: Math.min(to, from + SCROLL_WINDOW - 1) };
        const nextFrom = Math.max(1, from - SCROLL_SHIFT);
        let nextTo = nextFrom + SCROLL_WINDOW - 1;
        if (nextTo > maxRound) nextTo = maxRound;
        if (nextTo - nextFrom + 1 > SCROLL_WINDOW) nextTo = nextFrom + SCROLL_WINDOW - 1;
        return { from: nextFrom, to: nextTo };
    }
    if (to >= maxRound) return { from: from, to: to };
    let nextTo = Math.min(maxRound, to + SCROLL_SHIFT);
    let nextFrom = nextTo - SCROLL_WINDOW + 1;
    if (nextFrom < 1) nextFrom = 1;
    if (nextTo - nextFrom + 1 > SCROLL_WINDOW) nextFrom = nextTo - SCROLL_WINDOW + 1;
    return { from: nextFrom, to: nextTo };
}

function scrollState(s) {
    if (!s.scroll) {
        s.scroll = {
            heights: {}, follow: true, busy: false, gen: 0, maxRound: 0, silent: false,
            from: 1, to: 0, engaged: false, recorded: false, painting: false,
            paintFrom: 1, paintTo: 0, adjusting: false, guardUntil: 0, lastY: 0
        };
    }
    return s.scroll;
}

function sessionMaxRound(s) {
    let max = (s.scroll && s.scroll.maxRound) || 0;
    const order = (s.data && s.data.order) || [];
    for (const n of order) if (n > max) max = n;
    const doneRounds = s.data && s.data.doneInfo && s.data.doneInfo.rounds;
    if (doneRounds > max) max = doneRounds;
    return max;
}

function scrollRecordingOk(s) {
    if (!s || !s.runId) return false;
    if (s.scroll && s.scroll.recorded) return true;
    if (typeof cachedConfig !== 'undefined' && cachedConfig && cachedConfig.history_recording === false) return false;
    return true;
}

function sessionNeedsFullHistory(s) {
    return !!(s && s.runId && s.scroll && s.scroll.engaged);
}

function isHotRound(s, n) {
    if (!s || s.status !== 'running') return false;
    const order = (s.data && s.data.order) || [];
    return order.length > 0 && order[order.length - 1] === n;
}

function roundShouldAttach(s, n) {
    if (!s || !s.scroll || !s.scroll.engaged) return true;
    if (s.scroll.painting) return n >= s.scroll.paintFrom && n <= s.scroll.paintTo;
    if (s.scroll.follow !== false) return true;
    return n >= s.scroll.from && n <= s.scroll.to;
}

function clearHistoryScroll() {
    historyScrollSession = null;
}

function scrollTargetSession() {
    // History covers the live output. A short history view has nothing to
    // window, and must not move the hidden live chain.
    if (typeof historyActive !== 'undefined' && historyActive) return historyScrollSession;
    if (typeof getSession === 'function' && typeof activeSid !== 'undefined') return getSession(activeSid);
    return null;
}

function elementShown(el) {
    if (!el || !el.getBoundingClientRect) return false;
    if (!el.isConnected) return false;
    return el.offsetWidth > 0 || el.offsetHeight > 0;
}

function withSession(s, fn) {
    let pushed = false;
    if (typeof sessions !== 'undefined' && Array.isArray(sessions)
        && typeof getSession === 'function' && !getSession(s.id)) {
        sessions.push(s);
        pushed = true;
    }
    try { return fn(); }
    finally {
        if (pushed) {
            const at = sessions.indexOf(s);
            if (at >= 0) sessions.splice(at, 1);
        }
    }
}

function makeSpacer(which, text) {
    const el = document.createElement('div');
    el.className = 'scroll-spacer scroll-spacer-' + which;
    el.style.height = '0px';
    const note = document.createElement('div');
    note.className = 'scroll-spacer-note';
    note.style.display = 'none';
    note.textContent = text;
    el.appendChild(note);
    return el;
}

function findDirectChild(parent, className) {
    if (!parent || !parent.children) return null;
    for (const child of parent.children) {
        const cls = child.classList;
        if (cls && cls.contains && cls.contains(className)) return child;
        if (typeof child.className === 'string' && child.className.split(/\s+/).indexOf(className) >= 0) return child;
    }
    return null;
}

function chainParent(s) {
    if (s.nodes && s.nodes.subtabs && s.nodes.subtabs.diagnosticsPane) return s.nodes.subtabs.diagnosticsPane;
    return s.nodes.container;
}

function orderedRoundSecs(s) {
    const out = [];
    if (!s.nodes || !s.nodes.rounds) return out;
    const nums = [];
    for (const n of s.nodes.rounds.keys()) nums.push(n);
    nums.sort((a, b) => a - b);
    for (const n of nums) {
        const ref = s.nodes.rounds.get(n);
        if (ref && ref.sec) out.push(ref.sec);
    }
    return out;
}

function ensureScrollChain(s) {
    if (s.nodes.chain) return s.nodes.chain;
    const chain = document.createElement('div');
    chain.className = 'scroll-chain';
    const top = makeSpacer('top', 'Earlier rounds stay in session history. Scroll up to load them.');
    const bottom = makeSpacer('bottom', 'Later rounds stay in session history. Scroll down to load them.');
    chain.appendChild(top);
    chain.appendChild(bottom);
    const rounds = orderedRoundSecs(s).filter(sec => sec.parentNode);
    if (rounds.length) {
        rounds[0].parentNode.insertBefore(chain, rounds[0]);
        for (const sec of rounds) chain.insertBefore(sec, bottom);
    } else {
        const parent = chainParent(s);
        const footer = findDirectChild(parent, 'done');
        if (footer) parent.insertBefore(chain, footer);
        else parent.appendChild(chain);
    }
    s.nodes.chain = chain;
    s.nodes.spacerTop = top;
    s.nodes.spacerNoteTop = top.firstChild || top.children[0];
    s.nodes.spacerBottom = bottom;
    s.nodes.spacerNoteBottom = bottom.firstChild || bottom.children[0];
    return chain;
}

function placeRoundElement(s, n, sec) {
    if (!s.nodes || !s.nodes.chain) {
        s.nodes.container.appendChild(sec);
        return;
    }
    const bottom = s.nodes.spacerBottom;
    let before = bottom;
    let nextN = Infinity;
    if (s.nodes.rounds) {
        for (const [rn, ref] of s.nodes.rounds) {
            if (rn > n && rn < nextN && ref.sec && ref.sec.parentNode === s.nodes.chain) {
                nextN = rn;
                before = ref.sec;
            }
        }
    }
    s.nodes.chain.insertBefore(sec, before || null);
}

function setSpacer(el, note, px) {
    if (!el) return;
    const h = Math.max(0, Math.round(px || 0));
    el.style.height = h ? (h + 'px') : '0px';
    // The note is hidden from the stylesheet (display: none), so showing
    // it needs an explicit value — clearing the inline style would fall
    // back to the stylesheet rule and keep it hidden.
    if (note) note.style.display = h ? 'block' : 'none';
}

function knownHeight(s, n) {
    const h = s.scroll && s.scroll.heights && s.scroll.heights[n];
    return h > 0 ? h : SCROLL_ESTIMATE;
}

function updateSpacers(s) {
    const sc = s.scroll;
    if (!sc || !s.nodes || !s.nodes.spacerTop) return;
    let above = 0;
    for (let n = 1; n < sc.from; n++) above += knownHeight(s, n);
    let below = 0;
    for (let n = sc.to + 1; n <= sc.maxRound; n++) below += knownHeight(s, n);
    setSpacer(s.nodes.spacerTop, s.nodes.spacerNoteTop, sc.engaged ? above : 0);
    setSpacer(s.nodes.spacerBottom, s.nodes.spacerNoteBottom, sc.engaged ? below : 0);
}

function rememberHeight(s, n, sec) {
    if (!sec || !(sec.offsetHeight > 0)) return;
    scrollState(s).heights[n] = sec.offsetHeight;
}

function evictRoundData(s, n) {
    if (isHotRound(s, n)) return;
    const r = s.data && s.data.rounds && s.data.rounds[n];
    if (!r || r.evicted) return;
    s.data.rounds[n] = { evicted: true, model: r.model || '', metrics: r.metrics || null, contextBudgets: r.contextBudgets || [] };
}

function reviveRound(s, n) {
    const prev = s.data.rounds[n];
    s.data.rounds[n] = {
        model: (prev && prev.model) || '',
        thinking: '', content: '', contentHtml: '',
        toolCalls: [], toolResults: [], toolPreviews: [], evidence: [],
        metrics: (prev && prev.metrics) || null,
        contextBudgets: (prev && prev.contextBudgets) || []
    };
    if (s.data.order.indexOf(n) < 0) {
        s.data.order.push(n);
        s.data.order.sort((a, b) => a - b);
    }
}

function unmountRound(s, n) {
    const ref = s.nodes.rounds.get(n);
    if (!ref) return;
    rememberHeight(s, n, ref.sec);
    if (isHotRound(s, n)) {
        // Streaming updates this same node. Detach it; do not drop the text.
        if (ref.sec && ref.sec.parentNode) ref.sec.parentNode.removeChild(ref.sec);
        return;
    }
    if (ref.sec && ref.sec.parentNode) ref.sec.parentNode.removeChild(ref.sec);
    s.nodes.rounds.delete(n);
    evictRoundData(s, n);
}

function mountedNumbers(s) {
    const nums = [];
    if (!s.nodes || !s.nodes.rounds) return nums;
    for (const [n, ref] of s.nodes.rounds) {
        if (ref && ref.sec && ref.sec.parentNode) nums.push(n);
    }
    nums.sort((a, b) => a - b);
    return nums;
}

function roundNeedsLoad(s, n) {
    const ref = s.nodes.rounds.get(n);
    if (ref && ref.sec && ref.sec.parentNode) return false;
    const data = s.data.rounds[n];
    if (data && !data.evicted) return false;
    return true;
}

function wireType(type) {
    if (type === 'thinking') return 'thinking_delta';
    if (type === 'content') return 'content_delta';
    return type;
}

function replayHistoryEvents(s, events, silent) {
    const sc = scrollState(s);
    const prev = sc.silent;
    if (silent) sc.silent = true;
    try {
        withSession(s, () => {
            for (const e of events || []) {
                const t = wireType(e.type);
                if (silent && SCROLL_SKIP[t]) continue;
                if (silent && !(e.round > 0)) continue;
                let payload = e.payload || {};
                if (t === 'content_html') {
                    const clean = (typeof sanitizeRendered === 'function')
                        ? sanitizeRendered(payload.html, false)
                        : payload.html;
                    if (!clean) continue;
                    payload = { html: clean };
                }
                handleEvent(s.id, Object.assign({ type: t, round: e.round, hid: e.hid }, payload), false);
            }
        });
    } finally {
        sc.silent = prev;
    }
}

function eventsForMissing(s, events) {
    const skip = new Set();
    for (const e of events || []) {
        const n = e.round || 0;
        if (n > 0 && !roundNeedsLoad(s, n)) skip.add(n);
    }
    return (events || []).filter(e => {
        const n = e.round || 0;
        return n > 0 && !skip.has(n);
    });
}

function mountRoundFromData(s, n) {
    const existing = s.nodes.rounds.get(n);
    if (existing && existing.sec && existing.sec.parentNode) return;
    if (existing && existing.sec) {
        placeRoundElement(s, n, existing.sec);
        return;
    }
    const data = s.data.rounds[n];
    if (!data || data.evicted) return;
    const r = ensureRound(s, n, data.model || '');
    const show = (text) => (typeof displaySessionText === 'function' ? displaySessionText(s, text) : (text == null ? '' : String(text)));
    if (data.thinking) {
        r.thinkingBody.textContent = show(data.thinking);
        r.det.open = true;
    }
    if (data.content) r.contentEl.textContent = show(data.content);
    if (typeof appendStoredTools === 'function') appendStoredTools(r, data, (typeof commentTagOf === 'function' ? commentTagOf(s) : ''));
    if (data.metrics) {
        const m = data.metrics;
        const md = document.createElement('div');
        md.className = 'metrics';
        md.textContent = 'tokens: prompt ' + (m.prompt_tokens || 0) + ' / completion ' + (m.completion_tokens || 0)
            + (m.reasoning_tokens ? ' / reasoning ' + m.reasoning_tokens : '')
            + (m.cached_tokens ? ' · cached ' + m.cached_tokens : '')
            + (m.reasoning_effort ? ' · effort ' + m.reasoning_effort : '')
            + (typeof formatUsd === 'function' ? formatUsd(m.cost_usd) : '')
            + ' (' + (m.model || '') + ')';
        r.body.appendChild(md);
    }
    if (data.contextBudgets && data.contextBudgets.length && typeof paintContextBudgetNotes === 'function') {
        paintContextBudgetNotes(r, data.contextBudgets);
    }
    if (data.contentHtml && typeof showRenderedResponse === 'function') showRenderedResponse(s, n, data.contentHtml);
}

function condenseWindow(s, from, to) {
    const sc = scrollState(s);
    withSession(s, () => {
        for (let n = from; n <= to; n++) {
            const ref = s.nodes.rounds.get(n);
            if (!ref) continue;
            const hot = s.status === 'running' && isHotRound(s, n);
            if (!hot && n < sc.maxRound) finalizeRound(s.id, n);
            else if (!hot) ref.finalized = true;
        }
    });
}

function pageScrollHeight() {
    const body = document && document.body;
    const root = document && document.documentElement;
    const a = (body && body.scrollHeight) || 0;
    const b = (root && root.scrollHeight) || 0;
    return a > b ? a : b;
}

// Follow mode has to land on the tail even when the top spacer just pushed
// the transcript more than a screen away. maybeScroll only sticks when the
// viewport is already near the bottom, so it leaves the reader in that spacer.
function pinFollow(s) {
    if (!s || !s.scroll || s.scroll.follow === false) return;
    if (typeof window === 'undefined' || typeof window.scrollTo !== 'function') return;
    if (!document || !document.body) return;
    const sc = s.scroll;
    sc.adjusting = true;
    try { window.scrollTo(0, pageScrollHeight()); }
    catch (e) {}
    sc.lastY = window.scrollY || 0;
    sc.adjusting = false;
}

function collapseLeavingRounds(s, from, to) {
    if (typeof finalizeRound !== 'function') return;
    withSession(s, () => {
        for (const n of mountedNumbers(s)) {
            if (n < from || n > to) {
                if (s.status === 'running' && isHotRound(s, n)) continue;
                finalizeRound(s.id, n);
            }
        }
    });
}

function paintWindow(s, from, to, events) {
    const sc = scrollState(s);
    if (to < from) return;
    sc.painting = true;
    sc.paintFrom = from;
    sc.paintTo = to;
    try {
        ensureScrollChain(s);
        const keep = mountedNumbers(s).filter(n => n >= from && n <= to);
        const anchor = keep.length ? s.nodes.rounds.get(keep[0]) : null;
        const anchorEl = anchor && anchor.sec;
        const anchorTop = (anchorEl && anchorEl.getBoundingClientRect) ? anchorEl.getBoundingClientRect().top : null;
        // Measure the condensed block. An expanded tool round is several
        // screens taller than the preview that comes back on the next load.
        collapseLeavingRounds(s, from, to);
        for (const n of mountedNumbers(s)) {
            if (n < from || n > to) unmountRound(s, n);
        }
        const replay = eventsForMissing(s, events);
        const revive = new Set();
        for (const e of replay) if (e.round > 0) revive.add(e.round);
        for (const n of revive) reviveRound(s, n);
        if (replay.length) replayHistoryEvents(s, replay, true);
        for (let n = from; n <= to; n++) mountRoundFromData(s, n);
        sc.from = from;
        sc.to = to;
        if (to > sc.maxRound) sc.maxRound = to;
        sc.engaged = sc.maxRound > SCROLL_WINDOW;
        condenseWindow(s, from, to);
        for (const n of mountedNumbers(s)) rememberHeight(s, n, s.nodes.rounds.get(n).sec);
        updateSpacers(s);
        // Live follow pins after this returns. Anchoring here is for a
        // reader who scrolled away from the tail.
        if (sc.follow === false && anchorEl && anchorEl.isConnected && anchorTop != null && typeof window !== 'undefined' && window.scrollBy) {
            const shift = anchorEl.getBoundingClientRect().top - anchorTop;
            if (shift) {
                sc.adjusting = true;
                window.scrollBy(0, shift);
                sc.lastY = window.scrollY || 0;
                sc.adjusting = false;
            }
        }
    } finally {
        sc.painting = false;
    }
}

async function fetchRoundWindow(runId, from, to, tail) {
    let url = '/history/' + encodeURIComponent(runId) + '/rounds?';
    if (tail) url += 'tail=' + encodeURIComponent(tail);
    else url += 'from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to);
    const res = await apiFetch(url);
    if (!res.ok) throw new Error(await res.text() || ('HTTP ' + res.status));
    return res.json();
}

async function shiftWindow(s, from, to) {
    const sc = scrollState(s);
    if (!s.runId || sc.busy) return;
    if (from === sc.from && to === sc.to) return;
    const gen = ++sc.gen;
    sc.busy = true;
    try {
        let events = [];
        let missing = false;
        for (let n = from; n <= to; n++) {
            if (roundNeedsLoad(s, n)) { missing = true; break; }
        }
        if (missing) {
            const doc = await fetchRoundWindow(s.runId, from, to, 0);
            if (gen !== sc.gen) return;
            if (doc && doc.max_round > sc.maxRound) sc.maxRound = doc.max_round;
            events = (doc && doc.events) || [];
        }
        if (gen !== sc.gen) return;
        paintWindow(s, from, to, events);
        sc.guardUntil = Date.now() + 350;
    } catch (err) {
        if (typeof setStatus === 'function') setStatus('Could not load rounds: ' + (err && err.message ? err.message : err));
    } finally {
        if (gen === sc.gen) sc.busy = false;
    }
}

function maintainScrollTail(s) {
    if (!scrollRecordingOk(s)) return;
    const sc = scrollState(s);
    sc.maxRound = sessionMaxRound(s);
    if (sc.maxRound <= SCROLL_WINDOW) return;
    ensureScrollListener();
    if (!sc.engaged) {
        sc.engaged = true;
        sc.from = 1;
        sc.to = sc.maxRound;
    }
    if (sc.follow === false) {
        sc.painting = true;
        sc.paintFrom = sc.from;
        sc.paintTo = sc.to;
        try {
            for (const n of mountedNumbers(s)) {
                if (n < sc.from || n > sc.to) unmountRound(s, n);
            }
        } finally {
            sc.painting = false;
        }
        updateSpacers(s);
        return;
    }
    const range = tailRange(sc.maxRound);
    if (s.nodes.chain && range.from === sc.from && range.to === sc.to) updateSpacers(s);
    else paintWindow(s, range.from, range.to, []);
    pinFollow(s);
}

function edgeVisible(el, edge) {
    if (!elementShown(el) || typeof window === 'undefined') return false;
    const rect = el.getBoundingClientRect();
    if (edge === 'top') return rect.bottom > -SCROLL_EDGE && rect.top < window.innerHeight * 0.5;
    return rect.top < window.innerHeight + SCROLL_EDGE && rect.bottom > window.innerHeight * 0.5;
}

function onWindowScroll() {
    const s = scrollTargetSession();
    if (!s || !s.scroll || !s.scroll.engaged) return;
    const sc = s.scroll;
    const y = window.scrollY || 0;
    // A finishing run hides the chain and the page clamps upward. That
    // jump is not the reader leaving follow. Keep lastY on the real position
    // so the next gesture is measured from here.
    if (sc.busy || sc.adjusting || sc.painting || Date.now() < sc.guardUntil || !elementShown(s.nodes.chain || s.nodes.container)) {
        sc.lastY = y;
        return;
    }
    const dy = y - (sc.lastY || 0);
    sc.lastY = y;
    const nearBottom = window.innerHeight + y >= (document.body.scrollHeight || 0) - 250;
    if (nearBottom && sc.to >= sc.maxRound) sc.follow = true;
    else if (dy < -8) sc.follow = false;
    if (!dy) return;
    const wantOlder = dy < 0 && sc.from > 1 && edgeVisible(s.nodes.spacerTop, 'top');
    const wantNewer = dy > 0 && sc.to < sc.maxRound && edgeVisible(s.nodes.spacerBottom, 'bottom');
    if (wantOlder && !wantNewer) {
        if (s.nodes.subtabs && typeof activateChainSub === 'function') activateChainSub(s, 'diagnostics');
        const next = shiftRange(sc.from, sc.to, sc.maxRound, -1);
        if (next.from !== sc.from) shiftWindow(s, next.from, next.to);
    } else if (wantNewer && !wantOlder) {
        const next = shiftRange(sc.from, sc.to, sc.maxRound, 1);
        if (next.to !== sc.to) shiftWindow(s, next.from, next.to);
    }
}

function ensureScrollListener() {
    if (scrollListenerOn || typeof window === 'undefined' || !window.addEventListener) return;
    scrollListenerOn = true;
    window.addEventListener('scroll', onWindowScroll, { passive: true });
}

function holdScroll(s) {
    const sc = scrollState(s);
    sc.guardUntil = Date.now() + 400;
    sc.lastY = (typeof window !== 'undefined' && window.scrollY) || 0;
}

function engageHistoryWindow(s) {
    if (!s || !s.scroll) return;
    ensureScrollChain(s);
    updateSpacers(s);
    ensureScrollListener();
    historyScrollSession = s;
    holdScroll(s);
}

function settleHistoryWindow(s) {
    if (!s || !s.scroll || !s.scroll.engaged) return;
    for (const n of mountedNumbers(s)) {
        const ref = s.nodes.rounds.get(n);
        if (ref) rememberHeight(s, n, ref.sec);
    }
    updateSpacers(s);
    holdScroll(s);
}

function hasClassName(el, name) {
    if (!el) return false;
    if (el.classList && typeof el.classList.contains === 'function') return el.classList.contains(name);
    return typeof el.className === 'string' && el.className.split(/\s+/).indexOf(name) >= 0;
}

function resetScrollers(root) {
    const visit = (el) => {
        if (!el) return;
        if (typeof el.scrollTop === 'number' && el.scrollTop > 0) el.scrollTop = 0;
        if (typeof el.scrollLeft === 'number' && el.scrollLeft > 0) el.scrollLeft = 0;
        const kids = el.children;
        if (!kids) return;
        for (let i = 0; i < kids.length; i++) visit(kids[i]);
    };
    visit(root);
}

function scrollBlockToStart(el) {
    if (!el || typeof el.scrollIntoView !== 'function') return;
    try { el.scrollIntoView({ block: 'start', inline: 'nearest' }); }
    catch (e) {
        try { el.scrollIntoView(true); } catch (err) {}
    }
}

function spacerHeight(s) {
    const el = s && s.nodes && s.nodes.spacerTop;
    if (!el || !el.style || !el.style.height) return 0;
    const n = parseFloat(el.style.height);
    return n > 0 ? n : 0;
}

// The sticky control bar covers the viewport from the top through its
// bottom edge. A landing target has to clear that edge or the session
// title sits underneath it.
function dashboardCover() {
    try {
        if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return 0;
        const bar = document.getElementById('controlDashboard');
        if (!bar || typeof bar.getBoundingClientRect !== 'function') return 0;
        const bottom = bar.getBoundingClientRect().bottom;
        return bottom > 0 ? bottom : 0;
    } catch (e) {
        return 0;
    }
}
// History keeps the title, metadata, and export row ahead of the chain.
// Response and Diagnostics both land there. A live chain has no such
// row, so the sub-tab strip is the top of that view.
function sessionScrollAnchor(pane) {
    let node = pane;
    for (let depth = 0; node && depth < 8; depth++) {
        const parent = node.parentNode;
        if (parent && parent.children) {
            for (let i = 0; i < parent.children.length; i++) {
                if (hasClassName(parent.children[i], 'history-session-head')) return parent.children[i];
            }
        }
        node = parent;
    }
    if (pane && pane.parentNode && pane.parentNode.children) {
        const kids = pane.parentNode.children;
        for (let i = 0; i < kids.length; i++) {
            if (hasClassName(kids[i], 'sub-tabs')) return kids[i];
        }
    }
    return pane;
}
function scrollBlockBelowDashboard(el) {
    if (!el) return;
    const canMeasure = typeof el.getBoundingClientRect === 'function'
        && typeof window !== 'undefined'
        && typeof window.scrollBy === 'function';
    if (!canMeasure) {
        scrollBlockToStart(el);
        return;
    }
    const nudge = () => {
        let delta = 0;
        try { delta = el.getBoundingClientRect().top - dashboardCover(); }
        catch (e) { return false; }
        if (Math.abs(delta) <= 1) return true;
        try { window.scrollBy(0, delta); }
        catch (e) { return false; }
        return true;
    };
    // The second pass catches the bar sticking or unsticking after the move.
    if (!nudge()) scrollBlockToStart(el);
    else nudge();
}
// Opening Response or Diagnostics shows the session header when the
// replay has one, otherwise the sub-tab strip. Either way the block
// sits just under the control bar, not under it and not on the first card.
function revealPaneStart(s, pane) {
    resetScrollers(pane);
    const target = sessionScrollAnchor(pane);
    const sc = s && s.scroll;
    if (sc) {
        sc.follow = false;
        sc.adjusting = true;
        sc.guardUntil = Date.now() + 400;
    }
    scrollBlockBelowDashboard(target);
    if (sc) {
        sc.lastY = (typeof window !== 'undefined' && window.scrollY) || 0;
        sc.adjusting = false;
    }
}

function onSessionShown(s) {
    clearHistoryScroll();
    if (!s || !s.scroll || !s.scroll.engaged) return;
    for (const n of mountedNumbers(s)) rememberHeight(s, n, s.nodes.rounds.get(n).sec);
    updateSpacers(s);
    if (s.scroll.follow !== false) pinFollow(s);
}

async function restoreScrollTail(s) {
    if (!s || !s.runId || typeof apiFetch !== 'function') return;
    const sc = scrollState(s);
    sc.recorded = true;
    sc.follow = true;
    try {
        const doc = await fetchRoundWindow(s.runId, 0, 0, SCROLL_WINDOW);
        sc.maxRound = (doc && doc.max_round) || sc.maxRound;
        const from = (doc && doc.from) || 1;
        const to = (doc && doc.to) || sc.maxRound;
        for (const n of (s.data.order || []).slice()) {
            if (s.toolsInHistory || n < from || n > to) evictRoundData(s, n);
        }
        if (sc.maxRound > SCROLL_WINDOW) paintWindow(s, from, to, (doc && doc.events) || []);
        else {
            sc.engaged = false;
            replayHistoryEvents(s, (doc && doc.events) || [], true);
            condenseWindow(s, 1, sc.maxRound);
        }
        if (!s.nodes.subtabs && typeof splitChainView === 'function') splitChainView(s);
        s.toolsInHistory = false;
        holdScroll(s);
        if (typeof persist === 'function') persist();
    } catch (err) {
        if (typeof setStatus === 'function') setStatus('Could not restore the round window: ' + (err && err.message ? err.message : err));
    }
}

function copyMissingHids(live, replayed) {
    const left = live || [];
    const right = replayed || [];
    for (let i = 0; i < left.length && i < right.length; i++) {
        if (left[i] && right[i] && !left[i].hid && right[i].hid) left[i].hid = right[i].hid;
    }
}
function keptBudgetLines(primary, fallback) {
    const out = [];
    const add = (list) => {
        const items = list || [];
        for (let i = 0; i < items.length; i++) {
            const text = String(items[i] || '').trim();
            if (text && out.indexOf(text) < 0) out.push(text);
        }
    };
    add(primary);
    add(fallback);
    return out;
}
async function fullSession(s) {
    if (!sessionNeedsFullHistory(s)) return s;
    const res = await apiFetch('/history/' + encodeURIComponent(s.runId));
    if (!res.ok) throw new Error(await res.text() || ('HTTP ' + res.status));
    const doc = await res.json();
    const built = {
        id: 'full-' + s.runId,
        num: s.num,
        prompt: s.prompt || (doc.run && doc.run.prompt) || '',
        status: s.status,
        statusText: s.statusText || '',
        createdAt: s.createdAt,
        runId: s.runId,
        commentTag: s.commentTag || '',
        toolsOverride: s.toolsOverride || null,
        data: {
            rounds: {}, order: [],
            totals: { prompt: 0, completion: 0 },
            wallMs: (s.data && s.data.wallMs) || 0,
            doneInfo: (s.data && s.data.doneInfo) || null
        },
        nodes: { container: document.createElement('div'), rounds: new Map() },
        scroll: { silent: true, engaged: false, follow: true, heights: {}, maxRound: 0 }
    };
    if (doc.run && typeof validCommentTag === 'function') {
        const tag = validCommentTag(doc.run.comment_tag);
        if (tag) built.commentTag = tag;
    }
    replayHistoryEvents(built, doc.events || [], true);
    for (const e of (doc.events || [])) {
        if (e.type === 'prompt' && e.hid) { built.promptHid = e.hid; break; }
    }
    if (s.promptHid && !built.promptHid) built.promptHid = s.promptHid;
    for (const n of ((s.data && s.data.order) || [])) {
        const r = s.data.rounds[n];
        if (!r || r.evicted) continue;
        const replayed = built.data.rounds[n] || {};
        built.data.rounds[n] = {
            model: r.model || '', thinking: r.thinking || '', content: r.content || '', contentHtml: r.contentHtml || '',
            thinkingHid: r.thinkingHid || replayed.thinkingHid || null,
            contentHid: r.contentHid || replayed.contentHid || null,
            toolCalls: r.toolCalls || [], toolResults: r.toolResults || [], toolPreviews: r.toolPreviews || [],
            evidence: r.evidence || [], metrics: r.metrics || null,
            contextBudgets: keptBudgetLines(r.contextBudgets, replayed.contextBudgets)
        };
        copyMissingHids(built.data.rounds[n].toolCalls, replayed.toolCalls);
        copyMissingHids(built.data.rounds[n].toolResults, replayed.toolResults);
        copyMissingHids(built.data.rounds[n].toolPreviews, replayed.toolPreviews);
        if (built.data.order.indexOf(n) < 0) {
            built.data.order.push(n);
            built.data.order.sort((a, b) => a - b);
        }
    }
    if (s.data && s.data.totals) {
        built.data.totals = { prompt: s.data.totals.prompt || 0, completion: s.data.totals.completion || 0 };
    }
    built.data.wallMs = (s.data && s.data.wallMs) || 0;
    built.data.doneInfo = (s.data && s.data.doneInfo) || built.data.doneInfo;
    return built;
}
