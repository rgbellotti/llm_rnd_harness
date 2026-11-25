// storage.js — tab persistence, restore, JSON/HTML exports, and session
// teardown. Browser storage keeps tool calls, raw previews, and tool
// results with the tab so a refresh shows the same evidence. A tab that
// does not fit keeps its run id and reloads that tool text from history.
// Needs core.js, tabs.js, rounds.js, stream.js (handleEvent, for rehydrate).
function leanSession(s, keepTools) {
    if (keepTools === undefined) keepTools = true;
    const rounds = {};
    for (const n of s.data.order) {
        const r = s.data.rounds[n];
        if (!r) continue;
        if (r.evicted) {
            rounds[n] = { evicted: true, model: r.model || '', metrics: r.metrics || null, contextBudgets: r.contextBudgets || [] };
            continue;
        }
        const round = { model: r.model, thinking: r.thinking, content: r.content, contentHtml: r.contentHtml, metrics: r.metrics, thinkingHid: r.thinkingHid || null, contentHid: r.contentHid || null, contextBudgets: r.contextBudgets || [] };
        if (keepTools) {
            round.toolCalls = r.toolCalls || [];
            round.toolResults = r.toolResults || [];
            round.toolPreviews = persistablePreviews(r.toolPreviews);
            round.evidence = persistablePreviews(r.evidence);
        }
        rounds[n] = round;
    }
    return { id: s.id, num: s.num, prompt: s.prompt, promptHid: s.promptHid || null, status: s.status === 'running' ? 'error' : s.status,
        statusText: s.statusText, createdAt: s.createdAt, runId: s.runId || null,
        commentTag: s.commentTag || '',
        toolsInHistory: !keepTools && !!s.runId, toolsDropped: !keepTools && !s.runId,
        windowed: !!(s.scroll && s.scroll.engaged),
        data: { rounds, order: s.data.order.slice(),
        totals: { ...s.data.totals }, wallMs: s.data.wallMs, doneInfo: s.data.doneInfo } };
}
function persistablePreviews(list) {
    return (list || []).filter(item => !(item && item.provisional && item.name === 'run_sudo_cmd'));
}
function writeSessions(keepTools) {
    localStorage.setItem(STORE_KEY, JSON.stringify({ version: 1, tabs: sessions.map(s => leanSession(s, keepTools)), seq }));
}
function persist() {
    if (!storeEnabled) return;
    try { writeSessions(true); return; } catch (e) {}
    // The tool text did not fit. Keep every tab, and restore that text
    // from history on the next load when the run was recorded.
    try { writeSessions(false); return; } catch (e) {}
    if (sessions.length > 1) {
        sessions.shift();
        renderTabBar();
        try { writeSessions(true); return; } catch (e) {}
        try { writeSessions(false); } catch (e) {}
    }
}
let persistT = null;
function persistDebounced() {
    if (!storeEnabled) return;
    if (persistT) clearTimeout(persistT);
    persistT = setTimeout(() => { persistT = null; persist(); }, 2000);
}
// A refresh can land inside the two-second debounce. Write the tab,
// including tool evidence and its history id, before the page goes away.
// beforeunload also asks the browser to confirm while a run is open.
if (typeof window !== 'undefined' && window.addEventListener) {
    const flushPersist = () => {
        if (persistT) { clearTimeout(persistT); persistT = null; }
        persist();
    };
    window.addEventListener('pagehide', flushPersist);
    window.addEventListener('visibilitychange', () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') flushPersist();
    });
    window.addEventListener('beforeunload', (event) => {
        flushPersist();
        let live = false;
        try { live = typeof runningSid !== 'undefined' && runningSid !== null; } catch (e) { live = false; }
        if (!live || !event) return;
        event.preventDefault();
        event.returnValue = 'A run is still open. The transcript stays in history if this tab closes.';
    });
}
// A refresh of this tab keeps the working set. sessionStorage dies with
// the window, and a new harness launch has a new token, so both start clean.
const PAGE_LIVE_KEY = 'harness.page.live';
function sameTabResume(token) {
    const current = typeof token === 'string' ? token : '';
    let previous = '';
    try {
        if (typeof sessionStorage === 'undefined' || !sessionStorage.getItem) return false;
        previous = sessionStorage.getItem(PAGE_LIVE_KEY) || '';
        if (current) sessionStorage.setItem(PAGE_LIVE_KEY, current);
    } catch (e) { return false; }
    return !!current && previous === current;
}
function restore() {
    let raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { return false; }
    if (!raw) return false;
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return false; }
    if (!parsed || !Array.isArray(parsed.tabs)) return false;
    seq = parsed.seq || 0;
    sessions = [];
    for (const L of parsed.tabs.slice(-MAX_TABS)) {
        const s = {
            id: L.id || ('tab-restore-' + Math.random().toString(36).slice(2)),
            num: L.num || (++seq),
            prompt: L.prompt || '',
            promptHid: L.promptHid || null,
            // Only interrupted runs ('running') become 'error'. A
            // brand-new blank session restores as 'fresh' so refresh
            // works as a harmless sanity check with Generate intact.
            status: (L.status === 'done' || L.status === 'error' || L.status === 'fresh') ? L.status : 'error',
            statusText: L.statusText || '',
            createdAt: L.createdAt || new Date().toISOString(),
            runId: L.runId || null,
            commentTag: typeof L.commentTag === 'string' ? L.commentTag : '',
            toolsInHistory: !!L.toolsInHistory,
            toolsDropped: !!L.toolsDropped,
            deferSplit: !!(L.windowed && L.runId),
            data: { rounds: {}, order: Array.isArray(L.data && L.data.order) ? L.data.order : [],
                totals: (L.data && L.data.totals) || { prompt: 0, completion: 0 },
                wallMs: (L.data && L.data.wallMs) || 0, doneInfo: (L.data && L.data.doneInfo) || null },
            nodes: { container: document.createElement('div'), rounds: new Map() }
        };
        // Rebuild the round, including tool calls, previews, and results
        // saved with the tab. A tab marked toolsInHistory fills those in
        // afterwards from the permanent record.
        // The prompt stays in the prompt box. The column under the
        // controls stays empty until a run prints its rounds.
        const order = s.data.order.length ? s.data.order : Object.keys((L.data && L.data.rounds) || {}).map(Number);
        if (s.deferSplit) {
            s.scroll = {
                heights: {}, follow: true, busy: false, gen: 0,
                maxRound: (s.data.doneInfo && s.data.doneInfo.rounds) || 0,
                silent: false, from: 1, to: 0, engaged: true, recorded: true,
                painting: false, adjusting: false, guardUntil: 0, lastY: 0
            };
        }
        for (const n of order) {
            const lr = (L.data && L.data.rounds && L.data.rounds[n]) || {};
            if (lr.evicted || s.deferSplit) {
                s.data.rounds[n] = lr.evicted
                    ? { evicted: true, model: lr.model || '', metrics: lr.metrics || null, contextBudgets: lr.contextBudgets || [] }
                    : { model: lr.model || '', thinking: lr.thinking || '', content: lr.content || '', contentHtml: lr.contentHtml || '',
                        thinkingHid: lr.thinkingHid || null, contentHid: lr.contentHid || null,
                        toolCalls: lr.toolCalls || [], toolResults: lr.toolResults || [], toolPreviews: lr.toolPreviews || [],
                        evidence: lr.evidence || [], metrics: lr.metrics || null, contextBudgets: lr.contextBudgets || [] };
                continue;
            }
            const r = ensureRound(s, n, lr.model || '');
            if (lr.thinking) {
                if (typeof fillPlain === 'function') fillPlain(r.thinkingBody, displaySessionText(s, lr.thinking));
                else r.thinkingBody.textContent = displaySessionText(s, lr.thinking);
                r.det.open = true;
            }
            if (lr.content) {
                if (typeof fillPlain === 'function') fillPlain(r.contentEl, displaySessionText(s, lr.content));
                else r.contentEl.textContent = displaySessionText(s, lr.content);
            }
            if (lr.metrics) {
                const m = lr.metrics;
                const md = document.createElement('div');
                md.className = 'metrics';
                md.textContent = 'tokens: prompt ' + (m.prompt_tokens || 0) + ' / completion ' + (m.completion_tokens || 0)
                    + (m.reasoning_tokens ? ' / reasoning ' + m.reasoning_tokens : '')
                    + (m.reasoning_effort ? ' · effort ' + m.reasoning_effort : '')
                    + (typeof formatUsd === 'function' ? formatUsd(m.cost_usd) : '')
                    + ' (' + (m.model || '') + ')';
                r.body.appendChild(md);
            }
            s.data.rounds[n] = { model: lr.model || '', thinking: lr.thinking || '', content: lr.content || '', contentHtml: '',
                thinkingHid: lr.thinkingHid || null, contentHid: lr.contentHid || null,
                toolCalls: lr.toolCalls || [], toolResults: lr.toolResults || [], toolPreviews: lr.toolPreviews || [],
                evidence: lr.evidence || [], metrics: lr.metrics || null, contextBudgets: lr.contextBudgets || [] };
            appendStoredTools(r, s.data.rounds[n], commentTagOf(s));
            if (typeof paintContextBudgetNotes === 'function') paintContextBudgetNotes(r, s.data.rounds[n].contextBudgets);
        }
        for (const n of order) {
            if (s.deferSplit) break;
            const lr = (L.data && L.data.rounds && L.data.rounds[n]) || {};
            if (lr.contentHtml) {
                // Browser storage is mutable: sanitize cached HTML before insertion.
                const html = sanitizeRendered(lr.contentHtml, false);
                if (html) showRenderedResponse(s, n, html);
                else restoreRenderedResponse(s, n);
            } else if (lr.content) {
                restoreRenderedResponse(s, n);
            }
        }
        s.data.order = order.slice();
        if (s.toolsDropped) {
            const note = document.createElement('div');
            note.className = 'error';
            note.textContent = 'Tool evidence did not fit in browser storage, and this tab has no history id, so that tool text was not restored.';
            s.nodes.container.appendChild(note);
        }
        if (s.data.doneInfo) {
            const d = document.createElement('div');
            d.className = 'done';
            d.textContent = '── End of chain: ' + s.data.doneInfo.rounds + ' round(s) · '
                + s.data.totals.prompt + ' prompt + ' + s.data.totals.completion + ' completion tokens'
                + ' · wall ' + fmtMs(s.data.wallMs) + ' ──';
            s.nodes.container.appendChild(d);
        }
        sessions.push(s);
    }
    // Condense restored long rounds (all but last per session) and split
    // each restored chain into Response/Diagnostics panes.
    for (const s of sessions) {
        const order = s.data.order;
        for (let i = 0; i < order.length - 1; i++) finalizeRound(s.id, order[i]);
        for (const n of order) {
            const r = s.nodes.rounds.get(n);
            if (r) r.finalized = true;
        }
        if (!s.deferSplit) splitChainView(s);
    }
            if (sessions.length) {
                activeSid = sessions[sessions.length - 1].id;
                seq = Math.max(seq, ...sessions.map(s => s.num));
                if (typeof deactivatePanes === 'function') deactivatePanes();
                else {
                    configActive = false;
                    historyActive = false;
                    creditsActive = false;
                    document.getElementById('configView').style.display = 'none';
                    document.getElementById('historyView').style.display = 'none';
                    const credits = document.getElementById('creditsView');
                    if (credits) credits.style.display = 'none';
                }
                document.getElementById('prompt').style.display = '';
                document.getElementById('bottom_row_buttons').style.display = '';
        const output = document.getElementById('output');
        output.style.display = '';
        output.innerHTML = '';
        output.appendChild(getSession(activeSid).nodes.container);
        setStatus(getSession(activeSid).statusText || '');
    }
    for (const s of sessions) {
        if (s.deferSplit && typeof restoreScrollTail === 'function') restoreScrollTail(s);
    }
    return sessions.length > 0;
}

// Tool blocks in the order they were recorded. `evidence` is that order.
// Older saves have the three arrays and no evidence list; those render
// calls, then previews, then results.
function paintStoredText(el, text) {
    if (!el) return;
    if (typeof fillCommented === 'function') fillCommented(el, text);
    else el.textContent = text == null ? '' : String(text);
}
function appendStoredTools(r, data, tag) {
    const show = (text) => (typeof maskCommentTags === 'function' ? maskCommentTags(text, tag) : (text == null ? '' : String(text)));
    const evidence = Array.isArray(data.evidence) && data.evidence.length ? data.evidence : null;
    const grouped = []
        .concat((data.toolCalls || []).map(c => ({ kind: 'call', name: c.name, arguments: c.arguments, hid: c.hid })))
        .concat((data.toolPreviews || []).map(p => ({ kind: 'preview', name: p.name, output: p.output, duration_ms: p.duration_ms, hid: p.hid })))
        .concat((data.toolResults || []).map(res => ({ kind: 'result', name: res.name, output: res.output, duration_ms: res.duration_ms, hid: res.hid })));
    const items = evidence || grouped;
    let fetchResultIndex = 0;
    for (const item of items) {
        const d = document.createElement('div');
        if (item.kind === 'preview' && item.name === 'web_fetch' && typeof renderWebFetchPreview === 'function') {
            d.className = 'tool tool-preview';
            renderWebFetchPreview(d, show, item);
        } else if (item.kind === 'preview') {
            d.className = 'tool tool-preview';
            paintStoredText(d, (typeof withHid === 'function' ? withHid('▶ ' + originalPreviewLabel(item.name) + ' (before review, ' + item.duration_ms + ' ms)', item.hid) : ('▶ ' + originalPreviewLabel(item.name) + ' (before review, ' + item.duration_ms + ' ms)')) + '\n' + show(item.output));
        } else if (item.kind === 'result' && item.name === 'web_fetch' && typeof renderWebFetchResult === 'function') {
            d.className = 'tool tool-result';
            const stderr = typeof webFetchStderrAt === 'function' ? webFetchStderrAt(data.toolPreviews, fetchResultIndex) : '';
            fetchResultIndex += 1;
            renderWebFetchResult(d, show, item, stderr);
        } else if (item.kind === 'result') {
            d.className = 'tool tool-result';
            paintStoredText(d, (typeof withHid === 'function' ? withHid('▶ TOOL RESULT (' + item.duration_ms + ' ms)', item.hid) : ('▶ TOOL RESULT (' + item.duration_ms + ' ms)')) + '\n' + show(item.output));
        } else {
            d.className = 'tool';
            const rawCallText = (typeof formatToolCallText === 'function')
                ? formatToolCallText(item.name, item.arguments)
                : ('▶ TOOL CALL → ' + item.name);
            const shownCall = typeof withHid === 'function' ? withHid(rawCallText, item.hid) : rawCallText;
            if (typeof paintShellView === 'function' && item.arguments && typeof item.arguments.command === 'string') {
                // Same dual view as the live path: pretty command shown,
                // the raw text kept as the copy/curate source.
                paintShellView(d, shownCall, typeof withHid === 'function' ? withHid(formatToolCallText(item.name, item.arguments, true), item.hid) : formatToolCallText(item.name, item.arguments, true));
            } else {
                paintStoredText(d, shownCall);
            }
        }
        r.body.appendChild(d);
    }
}

function rehydrateStoredTools() {
    for (const s of sessions) {
        // A windowed tab reloads its tail, tools included, from the round API.
        if (s.scroll && s.scroll.engaged) continue;
        if (s.toolsInHistory && s.runId) rehydrateTools(s);
    }
}
async function rehydrateTools(s) {
    let doc;
    try {
        const res = await apiFetch('/history/' + encodeURIComponent(s.runId));
        if (!res.ok) throw new Error(await res.text() || ('HTTP ' + res.status));
        doc = await res.json();
    } catch (e) {
        const d = document.createElement('div');
        d.className = 'error';
        d.textContent = 'Tool evidence for this tab is in session history but could not be loaded: ' + e.message;
        s.nodes.container.appendChild(d);
        return;
    }
    if (doc.run && typeof validCommentTag === 'function') {
        const tag = validCommentTag(doc.run.comment_tag);
        if (tag) s.commentTag = tag;
    }
    for (const event of (doc.events || [])) {
        if (event.type !== 'tool_call' && event.type !== 'tool_preview' && event.type !== 'tool_result' && event.type !== 'context_budget') continue;
        handleEvent(s.id, Object.assign({ type: event.type, round: event.round }, event.payload || {}), false);
    }
    s.toolsInHistory = false;
    const order = s.data.order || [];
    for (let i = 0; i < order.length; i++) {
        const round = s.nodes.rounds.get(order[i]);
        if (round) round.finalized = false;
        if (i < order.length - 1) finalizeRound(s.id, order[i]);
    }
    persist();
}

// Older saved tabs contain only raw responses. Reuse the server's existing
// markdown conversion and sanitizer; this does not call Ollama or alter history.
async function restoreRenderedResponse(s, n) {
    const content = s.data.rounds[n].content;
    try {
        const response = await apiFetch('/render', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });
        if (!response.ok) return;
        const result = await response.json();
        if (getSession(s.id) !== s || s.data.rounds[n].content !== content) return;
        if (typeof result.html === 'string' && result.html) {
            showRenderedResponse(s, n, result.html);
            persistDebounced();
        }
    } catch (e) { /* Keep the original response readable if rendering is unavailable. */ }
}

// ---------- exports ----------
function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function archiveHasRootOutput(items) {
    const withheld = 'Root output withheld from history by the reviewer.';
    for (const s of items || []) {
        const rounds = s && s.data && s.data.rounds;
        if (!rounds) continue;
        for (const key of Object.keys(rounds)) {
            const previews = rounds[key] && rounds[key].toolPreviews;
            if ((previews || []).some(p => p && p.name === 'run_sudo_cmd' && !p.provisional && p.output && p.output !== withheld)) return true;
        }
    }
    return false;
}
function toolNames() {
    if (cachedConfig && Array.isArray(cachedConfig.tools))
        return cachedConfig.tools.map(t => (t.function && t.function.name) || '?');
    return ['run_cmd', 'ask_user', 'web_search', 'web_fetch'];
}
function sessionExportModel(s) {
    // The export records the model the run actually used: the newest
    // round's model. A fresh tab with no rounds records the empty
    // string — never a serve-time placeholder, which could be a model
    // the session never ran under.
    const order = s.data && s.data.order ? s.data.order : [];
    for (let i = order.length - 1; i >= 0; i--) {
        const r = (s.data.rounds || {})[order[i]] || {};
        if (r.model) return r.model;
    }
    return '';
}
function sessionToJson(s, toolsOverride) {
    // Lean skeletal format: prompt + thinking + responses + metrics,
    // plus the registered tool names (definitions live in the
    // startup JSON files, not the browser). Tool outputs deliberately
    // excluded (observation only). Restore accepts v1 and v2.
    // toolsOverride lets history replays record their original tool set.
    const rounds = s.data.order.map(n => {
        const r = s.data.rounds[n] || {};
        const show = (text) => (typeof displaySessionText === 'function' ? displaySessionText(s, text) : (text == null ? '' : String(text)));
        return { round: n, model: r.model || '', thinking: show(r.thinking || ''), content: show(r.content || ''), metrics: r.metrics || null, contextBudgets: r.contextBudgets || [] };
    });
    const showPrompt = (typeof displaySessionText === 'function' ? displaySessionText(s, s.prompt) : (s.prompt || ''));
    return { version: 2, tab: s.num, title: tabTitle(s), model: sessionExportModel(s), prompt: showPrompt,
        createdAt: s.createdAt, status: s.status, tools: toolsOverride || toolNames(), rounds,
        totals: { ...s.data.totals }, wallMs: s.data.wallMs, done: s.data.doneInfo };
}
function escHtml(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escHtmlCommented(text) {
    const value = text == null ? '' : String(text);
    if (typeof commentParts !== 'function' || (value.indexOf('<user_comment>') < 0 && value.indexOf('</user_comment>') < 0)) {
        return escHtml(value);
    }
    const parts = commentParts(value, { open: false });
    let html = '';
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part.text) continue;
        const escaped = escHtml(part.text);
        html += part.comment ? '<span class="user-comment">' + escaped + '</span>' : escaped;
    }
    return html;
}
// Static-export sanitizer mirroring the server allowlist (markdown.rs):
// stored contentHtml is server-cleaned, but exports open as file:// where a
// poisoned history row would run. Strip everything outside the small subset.
function sanitizeRendered(html, renderMathOutput = true) {
    try {
        const allow = new Set(['ul','ol','li','table','thead','tbody','tr','th','td','a','b','strong','i','em','code','pre','br','p','span','h1','h2','h3','h4']);
        const allowedAttributes = new Set(['href', 'title', 'class', 'rel']);
        const safeHref = (raw) => {
            const value = String(raw || '').trim();
            if (!value) return null;
            // URL parsers ignore tabs/newlines in a scheme, so remove all
            // C0/C1/space characters before deciding which scheme it is.
            const compact = value.replace(/[\u0000-\u0020\u007F-\u009F]/g, '');
            if (!compact) return null;
            let parsed;
            try { parsed = new URL(compact, 'https://harness.invalid/'); }
            catch (e) { return null; }
            return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? value : null;
        };
        const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
        const clean = (node) => {
            for (const child of Array.from(node.childNodes)) {
                if (child.nodeType === 8) { child.remove(); continue; }
                if (child.nodeType === 3) continue;
                if (child.nodeType !== 1) { child.remove(); continue; }
                const tag = child.tagName.toLowerCase();
                if (!allow.has(tag)) {
                    // Unwrap text content of disallowed tags (no innerHTML passthrough).
                    const text = document.createTextNode(child.textContent || '');
                    node.replaceChild(text, child);
                    continue;
                }
                // Attribute allowlist: no event handlers, style, ids,
                // ping, srcdoc, or other active/passive exfiltration hooks.
                for (const attr of Array.from(child.attributes)) {
                    const n = attr.name.toLowerCase();
                    if (!allowedAttributes.has(n)) { child.removeAttribute(attr.name); continue; }
                    if (n === 'class') {
                        const mathClass = (tag === 'p' && child.getAttribute('class') === 'math-display')
                            || (tag === 'span' && child.getAttribute('class') === 'math-inline');
                        const keep = mathClass || ((tag === 'code' || tag === 'pre')
                            && String(child.getAttribute('class') || '').split(/\s+/)
                                .filter(Boolean).every(t => t.startsWith('language-')));
                        if (!keep) child.removeAttribute(attr.name);
                    }
                }
                if (tag === 'a') {
                    const safe = safeHref(child.getAttribute('href'));
                    if (safe === null) child.removeAttribute('href');
                    else child.setAttribute('href', safe);
                }
                clean(child);
            }
        };
        clean(doc.body);
        if (renderMathOutput && typeof renderMath === 'function') renderMath(doc.body);
        return doc.body.innerHTML;
    } catch (e) { return ''; }
}
function archivedFetchPreview(preview, show) {
    if (preview && preview.name === 'web_fetch' && typeof parseFetchCapture === 'function') {
        const cap = parseFetchCapture(preview.output);
        if (cap) {
            let text = show(cap.stdout);
            if (String(cap.stderr).trim()) text += '\n\nstderr:\n' + show(cap.stderr);
            if (cap.rawBody) text += '\n\nOriginal HTML:\n' + show(cap.rawBody);
            return text;
        }
    }
    return show(preview ? preview.output : '');
}
function archiveDoc(list) {
    // Rich static snapshot builder shared by Export HTML and history replay
    // downloads: everything incl. tool outputs, no server calls.
    // Takes the list so history replays can export without live tabs.
    const items = list || sessions;
    let body = '';
    for (const s of items) {
        body += '<section class="tab"><h2>Tab #' + s.num + ' — ' + escHtml((s.prompt || 'untitled').split('\n')[0].slice(0, 80)) + '</h2>\n';
        const show = (text) => (typeof displaySessionText === 'function' ? displaySessionText(s, text) : (text == null ? '' : String(text)));
        body += '<div class="round"><div class="round-head"><h3>◉ PROMPT (archived)</h3></div><button onclick="copyArchive(this)">copy</button><pre>' + escHtmlCommented(show(s.prompt)) + '</pre></div>\n';
        for (const n of s.data.order) {
            const r = s.data.rounds[n] || {};
            const renderedBlock = r.contentHtml ? '<div class="rendered">rendered view:<br>' + sanitizeRendered(r.contentHtml) + '</div>' : '';
            const budgets = (r.contextBudgets || []).filter(Boolean).map(line => '◈ ' + show(line)).join('\n');
            const headText = ['thinking:', show(r.thinking || ''), '', 'response:', show(r.content || '')].join('\n');
            const tools = (r.toolCalls || []).map((c, i) => {
                const res = (r.toolResults || [])[i];
                return 'TOOL CALL → ' + c.name + '\n' + JSON.stringify(c.arguments)
                    + (res ? '\nTOOL RESULT (' + res.duration_ms + ' ms)\n' + show(res.output) : '\n(no result captured)');
            }).join('\n\n');
            const m = r.metrics ? ('tokens: prompt ' + r.metrics.prompt_tokens + ' / completion ' + r.metrics.completion_tokens + ' · ' + (r.metrics.tps || 0).toFixed(1) + ' tok/s (' + escHtml(r.metrics.model || '') + ')') : '';
            const previews = (r.toolPreviews || []).map(p => originalPreviewLabel(p.name) + ' (before review, ' + p.duration_ms + ' ms)\n' + archivedFetchPreview(p, show)).join('\n\n');
            const toolText = (previews ? '\n\n' + previews : '') + (tools ? '\n\n' + tools : '');
            const combined = (budgets ? budgets + '\n\n' : '') + headText + toolText + (m ? '\n\n' + m : '');
            const lines = combined.split('\n').length;
            // Thinking and the response are plain. Highlighting stays on the
            // tool text, where a person can actually place a comment.
            // The budget sentence is the fill mark the harness sent the model.
            const inner = '<button onclick="copyArchive(this)">copy</button><pre>' + (budgets ? escHtml(budgets) + escHtml('\n\n') : '') + escHtml(headText) + escHtmlCommented(toolText) + (m ? escHtml('\n\n' + m) : '') + '</pre>';
            body += '<div class="round"><h3>▶ MODEL (round ' + n + ')' + (r.model ? ' · ' + escHtml(r.model) : '') + '</h3>' + renderedBlock;
            if (lines > 60) body += '<details><summary>click to expand (' + lines + ' lines)</summary>' + inner + '</details>';
            else body += inner;
            body += '</div>\n';
        }
        body += '<p class="done">tab totals: ' + s.data.totals.prompt + ' prompt + ' + s.data.totals.completion + ' completion · wall ' + fmtMs(s.data.wallMs) + '</p></section>\n';
    }
    if (!body) body = '<p>No tabs yet.</p>';
    const doc = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Harness archive</title><style>'
        + 'body{font-family:system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;background:#223344;color:#aaaa77}'
        + 'pre{white-space:pre-wrap;background:#112233;padding:1rem;border-radius:6px;font-size:.85rem}'
        + '.round{border-top:2px solid #334455;margin-top:1rem;padding-top:.5rem}.round h3{color:#caca8a;font-size:.95rem}'
        + '.tab{border:1px solid #334455;border-radius:8px;padding:1rem;margin:1rem 0;background:#1a2a3a}'
        + 'button{background:#051117;color:#acac79;border:1px solid #334455;border-radius:4px;padding:.2rem .6rem;cursor:pointer}'
        + '.rendered table{border-collapse:collapse;width:100%;font-size:.85rem;margin:.5rem 0}.rendered th,.rendered td{border:1px solid #334455;padding:.3rem .6rem;text-align:left}.rendered th{background:#0a1a28;color:#caca8a}.rendered ul,.rendered ol{margin:.4rem 0 .4rem 1.4rem}'
        + '.rendered pre{background:#0a1a28;color:#aaaa77;padding:.7rem .9rem;border-radius:6px;overflow-x:auto}'
        + '.rendered code{font-family:ui-monospace,monospace;background:#0a1a28;color:#aaaa77;padding:.15em .4em;border-radius:4px}'
        + '.rendered pre code{display:block;padding:0;border-radius:0;background:transparent;color:inherit}'
        + '.rendered .math-display{text-align:center;overflow-x:auto;margin:.75rem 0}.rendered .math-inline{white-space:nowrap}'
        + '.rendered .token.comment,.rendered .token.prolog,.rendered .token.doctype,.rendered .token.cdata{color:#8292a2;font-style:italic}'
        + '.rendered .token.punctuation{color:#a0b0c0}.rendered .token.property,.rendered .token.tag,.rendered .token.constant,.rendered .token.symbol,.rendered .token.deleted{color:#f92672}'
        + '.rendered .token.boolean,.rendered .token.number{color:#ae81ff}.rendered .token.selector,.rendered .token.attr-name,.rendered .token.string,.rendered .token.char,.rendered .token.builtin,.rendered .token.inserted{color:#a6e22e}'
        + '.rendered .token.operator,.rendered .token.entity,.rendered .token.url,.rendered .token.variable{color:#f8f8f2}.rendered .token.atrule,.rendered .token.attr-value,.rendered .token.keyword{color:#e6db74}'
        + '.rendered .token.function,.rendered .token.class-name{color:#66d9ef}.rendered .token.regex,.rendered .token.important{color:#fd971f}'
        + 'details summary{cursor:pointer;color:#7ab0d0}.done{color:#caca8a}'
        + '.user-comment{background:rgba(224,192,128,.38);border-radius:2px;box-decoration-break:clone}'
        + (typeof archiveDarkHighlightCss === 'function' ? archiveDarkHighlightCss() : '')
        // The closing tag is split so this source can be inlined in the
        // page script. A literal end tag would end that script early.
        + '</style><script>function copyArchive(btn){var t=btn&&btn.nextElementSibling?btn.nextElementSibling.textContent:"";var ta=document.createElement("textarea");ta.value=t;ta.setAttribute("readonly","");ta.style.position="fixed";ta.style.left="0";ta.style.top="0";document.body.appendChild(ta);ta.focus();ta.select();var ok=false;try{ok=document.execCommand("copy");}catch(e){}ta.remove();if(!ok&&navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(t);}<' + '/script></head><body>'
        + '<h1>Harness archive (static snapshot — no server needed)</h1>'
        + '<p>Tabs: ' + items.length + ' · tools: ' + escHtml(toolNames().join(', ')) + ' · exported ' + new Date().toISOString() + ' · tool outputs included here (JSON exports exclude them).'
        + (archiveHasRootOutput(items) ? ' This file contains root output.' : '')
        + '</p>'
        + body + '</body></html>';
    return doc;
}
async function sessionsForExport(list) {
    if (typeof fullSession !== 'function') return list;
    const out = [];
    for (const s of list) out.push(await fullSession(s));
    return out;
}
async function exportHtml() {
    const list = await sessionsForExport(sessions);
    download('harness-archive-' + new Date().toISOString().slice(0, 10) + '.json'.replace('.json', '.html'), archiveDoc(list), 'text/html');
}
document.getElementById('dlTabBtn').onclick = async () => {
    const s = activeSession();
    if (!s) return;
    await refreshConfig();
    const full = (typeof fullSession === 'function') ? await fullSession(s) : s;
    download('harness-tab-' + s.num + '.json', JSON.stringify(sessionToJson(full), null, 2));
    exportDirty = false;
};
document.getElementById('exportAllBtn').onclick = async () => {
    await refreshConfig();
    const list = await sessionsForExport(sessions);
    download('harness-all-tabs.json', JSON.stringify(list.map(sessionToJson), null, 2));
    exportDirty = false;
};
document.getElementById('clearConfirm').onclick = () => {
    document.getElementById('clearOverlay').style.display = 'none';
    resetClearHint();
    const carried = pendingContinuation;
    pendingContinuation = '';
    doClearSession();
    if (carried) {
        const ns = applyContinuation(carried);
        setStatus('Started a fresh session with the assembled context (tab #' + ns.num + ') — prune before sending.' + (typeof providerPruneNote === 'function' ? providerPruneNote() : ''));
        renderTabBar();
    }
};
document.getElementById('clearCancel').onclick = () => {
    document.getElementById('clearOverlay').style.display = 'none';
    pendingContinuation = '';
    resetClearHint();
};
// Keyboard reachability for the clear confirm: Escape cancels.
if (typeof trapOverlayFocus === 'function') {
    trapOverlayFocus(document.getElementById('clearOverlay'), () => {
        document.getElementById('clearCancel').onclick();
    });
}
document.getElementById('exportHtmlBtn').onclick = async () => { await refreshConfig(); await exportHtml(); exportDirty = false; };
document.getElementById('exportTxtBtn').onclick = () => { exportPlainText(); };
const __continueBtn = document.getElementById('continueSessionBtn');
if (__continueBtn) __continueBtn.onclick = () => { continueSession(); };
const __continueTabBtn = document.getElementById('continueTabBtn');
if (__continueTabBtn) __continueTabBtn.onclick = () => { continueInNewTab(); };
document.getElementById('storeToggle').onchange = (e) => {
    storeEnabled = e.target.checked;
    if (storeEnabled) persist();
};
document.getElementById('clearStoreBtn').onclick = () => {
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    document.getElementById('pruneNote').textContent = 'Saved tabs cleared.';
};
