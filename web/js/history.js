// history.js — permanent session recall from the SQLCipher history file.
// Replayed runs render through the same builders and are never attached
// as live tabs. Curate copies the text into the prompt only when asked.
// On a wide screen that prompt stays in the left lane while this view
// is open. A narrow screen still hides it until the user goes back.
// Needs core.js, tabs.js, rounds.js, stream.js (handleEvent live=false,
// doneFooter), storage.js (download, sessionToJson, archiveDoc), prompt.js
// (sessionToPlainText, exportMenu, appendCurated). View flag `historyActive`
// lives in tabs.js alongside configActive.

function historyUploadedList(run) {
    try {
        const list = JSON.parse(run.uploaded_files || '[]');
        return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
}
function historyStatusLabel(status) {
    return status === 'aborted' ? 'interrupted' : (status || '');
}
function historyRowLabel(run, when) {
    const statusLabel = historyStatusLabel(run.status);
    const reopen = run.status === 'aborted' ? ' · saved transcript — open to read it' : '';
    return (run.title || 'untitled') + ' — ' + when + ' · ' + statusLabel + reopen
        + ' · ' + run.rounds + ' round(s)' + (run.model ? ' · ' + run.model : '');
}
// Newest interrupted run that this page did not restore. The note is shown
// until history is opened, then remembered so a later launch stays quiet.
// The recording-failure banner takes the same element when history cannot
// be written.
let announcedInterruptedId = '';
const HISTORY_PAGE_SIZE = 20;
let historyListPage = 0;
let historyListRequest = 0;
function seenInterruptedId() {
    try { return localStorage.getItem('harness.interrupted.seen') || ''; } catch (e) { return ''; }
}
function rememberInterruptedNote() {
    if (!announcedInterruptedId) return;
    try { localStorage.setItem('harness.interrupted.seen', announcedInterruptedId); } catch (e) {}
    announcedInterruptedId = '';
    if (typeof historyBannerKind !== 'undefined' && historyBannerKind === 'interrupted') {
        historyBannerKind = '';
        const banner = document.getElementById('historyBanner');
        if (banner) {
            banner.style.display = 'none';
            banner.textContent = '';
        }
    }
}
async function noteInterruptedRun() {
    const banner = document.getElementById('historyBanner');
    if (!banner || banner.style.display !== 'none') return;
    if (typeof cachedConfig !== 'undefined' && cachedConfig && cachedConfig.history_recording === false) return;
    let runs;
    try {
        const res = await apiFetch('/history');
        if (!res.ok) return;
        runs = await res.json();
    } catch (e) { return; }
    if (!Array.isArray(runs)) return;
    const interrupted = runs.find(run => run && run.status === 'aborted');
    if (!interrupted || interrupted.id === seenInterruptedId()) return;
    const openHere = typeof sessions !== 'undefined' && sessions.some(s => s && s.runId === interrupted.id);
    if (openHere) return;
    announcedInterruptedId = interrupted.id;
    if (typeof historyBannerKind !== 'undefined') historyBannerKind = 'interrupted';
    const title = interrupted.title || 'untitled';
    banner.textContent = 'A run was interrupted ("' + title + '"). It is saved. Open history to read the transcript.';
    banner.style.display = '';
}

async function showHistory() {
    rememberInterruptedNote();
    if (typeof deactivatePanes === 'function') deactivatePanes();
    else {
        configActive = false;
        creditsActive = false;
        document.getElementById('configView').style.display = 'none';
        const credits = document.getElementById('creditsView');
        if (credits) credits.style.display = 'none';
    }
    historyActive = true;
    document.getElementById('output').style.display = 'none';
    const hv = document.getElementById('historyView');
    hv.style.display = '';
    setStatus('');
    // renderTabBar parks or hides the composer for this width.
    renderTabBar();
    historyListPage = 0;
    await renderHistoryList();
}
// createSession closes this view. Curate on a wide screen opens it
// again without reloading the transcript already on screen.
function reopenHistoryPane() {
    if (typeof deactivatePanes === 'function') deactivatePanes();
    else {
        configActive = false;
        creditsActive = false;
        const cv = document.getElementById('configView');
        if (cv) cv.style.display = 'none';
        const credits = document.getElementById('creditsView');
        if (credits) credits.style.display = 'none';
    }
    historyActive = true;
    const output = document.getElementById('output');
    if (output) output.style.display = 'none';
    const hv = document.getElementById('historyView');
    if (hv) hv.style.display = '';
    if (typeof renderTabBar === 'function') renderTabBar();
}

function scrollHistoryListHead() {
    const head = document.getElementById('history-list-head');
    if (head && typeof scrollBlockBelowDashboard === 'function') scrollBlockBelowDashboard(head);
}
async function changeHistoryPage(next) {
    if (!Number.isInteger(next) || next < 0) return;
    historyListPage = next;
    await renderHistoryList();
    scrollHistoryListHead();
}
function appendHistoryPagination(parent, total, pageCount) {
    if (!total) return;
    const nav = document.createElement('nav');
    nav.className = 'history-pagination';
    nav.setAttribute('aria-label', 'Session history pages');
    const first = document.createElement('button');
    first.type = 'button';
    first.className = 'tab-btn';
    first.textContent = 'First';
    first.hidden = historyListPage === 0;
    first.onclick = () => changeHistoryPage(0);
    const previous = document.createElement('button');
    previous.type = 'button';
    previous.className = 'tab-btn';
    previous.textContent = '← Previous';
    previous.hidden = historyListPage === 0;
    previous.onclick = () => changeHistoryPage(historyListPage - 1);
    const position = document.createElement('span');
    position.className = 'history-page-position';
    position.setAttribute('aria-live', 'polite');
    position.textContent = 'Page ' + (historyListPage + 1) + ' of ' + pageCount;
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'tab-btn';
    next.textContent = 'Next →';
    next.hidden = historyListPage >= pageCount - 1;
    next.onclick = () => changeHistoryPage(historyListPage + 1);
    const last = document.createElement('button');
    last.type = 'button';
    last.className = 'tab-btn';
    last.textContent = 'Last';
    last.hidden = historyListPage >= pageCount - 1;
    last.onclick = () => changeHistoryPage(pageCount - 1);
    nav.appendChild(first);
    nav.appendChild(previous);
    nav.appendChild(position);
    nav.appendChild(next);
    nav.appendChild(last);
    parent.appendChild(nav);
}
async function renderHistoryList() {
    const request = ++historyListRequest;
    if (typeof clearHistoryScroll === 'function') clearHistoryScroll();
    const hv = document.getElementById('historyView');
    hv.innerHTML = '<div class="round"><p>Loading history…</p></div>';
    let page;
    try {
        const offset = historyListPage * HISTORY_PAGE_SIZE;
        const res = await apiFetch('/history/page?limit=' + HISTORY_PAGE_SIZE + '&offset=' + offset);
        if (!res.ok) throw new Error(await res.text() || ('HTTP ' + res.status));
        page = await res.json();
        if (request !== historyListRequest) return;
        if (!page || !Array.isArray(page.runs) || !Number.isSafeInteger(page.total) || page.total < 0) {
            throw new Error('Unexpected history page response.');
        }
    } catch (e) {
        if (request !== historyListRequest) return;
        hv.innerHTML = '';
        const d = document.createElement('div');
        d.className = 'error';
        d.textContent = 'Could not load history: ' + e.message + ' (is history enabled on the server?)';
        hv.appendChild(d);
        return;
    }
    const runs = page.runs;
    const total = page.total;
    const pageCount = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
    // A deletion can remove the last row of the current page. Re-read the
    // new final page rather than leaving an empty page with Previous active.
    if (historyListPage >= pageCount) {
        historyListPage = pageCount - 1;
        return renderHistoryList();
    }
    hv.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'round';
    head.id = 'history-list-head';
    const paneTitle = document.createElement('h2');
    paneTitle.className = 'pane-title';
    paneTitle.textContent = 'Session history (' + total + ' recorded)';
    hv.appendChild(paneTitle);
    const summary = document.createElement('div');
    summary.className = 'metrics history-page-summary';
    summary.setAttribute('aria-live', 'polite');
    const first = total ? historyListPage * HISTORY_PAGE_SIZE + 1 : 0;
    const last = total ? Math.min(total, first + runs.length - 1) : 0;
    summary.textContent = total ? 'Showing ' + first + '–' + last + ' of ' + total : '';
    head.appendChild(summary);
    const hint = document.createElement('div');
    hint.className = 'metrics';
    hint.textContent = 'Opening a session does not send it to the model. Curate appends its text into the prompt, or export a copy. On a wide screen the prompt stays open beside this list.';
    head.appendChild(hint);
    hv.appendChild(head);
    if (!runs.length) {
        const p = document.createElement('div');
        p.className = 'metrics';
        p.textContent = 'No recorded sessions yet. Finished runs are stored automatically.';
        hv.appendChild(p);
        return;
    }
    for (const run of runs) {
        const row = document.createElement('div');
        row.className = 'hist-row';
        const files = historyUploadedList(run);
        const icon = document.createElement('span');
        icon.className = 'hist-fileicon';
        icon.textContent = files.length ? '📄' : '📝';
        icon.title = files.length ? ('Uploaded files:\n' + files.join('\n')) : 'No uploaded files';
        row.appendChild(icon);
        const link = document.createElement('a');
        link.href = '#';
        link.className = 'hist-link';
        const when = new Date(run.created_at).toLocaleString();
        link.textContent = historyRowLabel(run, when);
        if (run.status === 'aborted') row.className = 'hist-row hist-interrupted';
        link.onclick = (e) => { e.preventDefault(); openHistory(run.id); };
        row.appendChild(link);
        const del = document.createElement('button');
        del.className = 'copy-btn';
        del.type = 'button';
        del.textContent = '🗑';
        del.title = 'Delete this recorded session';
        del.setAttribute('aria-label', 'Delete this recorded session');
        del.onclick = () => {
            // Inline confirm (not confirm()): native dialogs can be
            // suppressed by browser settings, silently deleting nothing —
            // or worse, confusing the outcome. Text anchors here instead.
            if (row.nextSibling && row.nextSibling.classList
                && row.nextSibling.classList.contains('hist-confirm')) return;
            const box = document.createElement('div');
            box.className = 'hist-confirm';
            box.appendChild(document.createTextNode('Delete "' + run.title + '"? This frees disk space and cannot be undone. '));
            const no = document.createElement('a');
            no.href = '#';
            no.textContent = 'cancel';
            no.onclick = (e) => { e.preventDefault(); box.remove(); };
            box.appendChild(no);
            row.after(box);
            box.appendChild(document.createTextNode(' · '));
            const yes = document.createElement('a');
            yes.href = '#';
            yes.textContent = 'confirm';
            yes.onclick = async (e) => {
                e.preventDefault();
                try {
                    const res = await apiFetch('/history/' + encodeURIComponent(run.id), { method: 'DELETE' });
                    if (!res.ok) throw new Error(await res.text() || ('HTTP ' + res.status));
                } catch (err) {
                    setStatus('Delete failed: ' + err.message);
                    return;
                }
                renderHistoryList();
            };
            box.appendChild(yes);
            
        };
        row.appendChild(del);
        hv.appendChild(row);
    }
    appendHistoryPagination(hv, total, pageCount);
}

async function openHistory(id) {
    const hv = document.getElementById('historyView');
    hv.innerHTML = '<div class="round"><p>Loading session…</p></div>';
    let doc;
    try {
        const tail = (typeof SCROLL_WINDOW === 'number') ? SCROLL_WINDOW : 8;
        const res = await apiFetch('/history/' + encodeURIComponent(id) + '/rounds?tail=' + tail);
        if (!res.ok) throw new Error(await res.text() || ('HTTP ' + res.status));
        doc = await res.json();
    } catch (e) {
        hv.innerHTML = '';
        const d = document.createElement('div');
        d.className = 'error';
        d.textContent = 'Could not open session: ' + e.message;
        hv.appendChild(d);
        return;
    }
    const run = doc.run;
    const s = {
        id: 'hist-' + run.id,
        num: 0,
        prompt: run.prompt || '',
        status: 'done',
        statusText: '',
        createdAt: new Date(run.created_at).toISOString(),
        toolsOverride: (() => { try { return JSON.parse(run.tool_names || '[]'); } catch (e) { return null; } })(),
        commentTag: typeof validCommentTag === 'function' ? (validCommentTag(run.comment_tag) || '') : '',
        data: { rounds: {}, order: [], totals: { prompt: run.totals_prompt || 0, completion: run.totals_completion || 0 }, wallMs: run.wall_ms || 0, doneInfo: null },
        runId: run.id,
        historyView: true,
        nodes: { container: document.createElement('div'), rounds: new Map() }
    };
    const maxRound = doc.max_round || 0;
    const windowed = maxRound > ((typeof SCROLL_WINDOW === 'number') ? SCROLL_WINDOW : 8);
    if (windowed) {
        // Replay adds metrics into totals. Silence that here so a tail
        // slice does not change the totals stored on the run.
        s.scroll = {
            heights: {}, follow: true, busy: false, gen: 0, maxRound: maxRound, silent: true,
            from: doc.from || 1, to: doc.to || maxRound, engaged: true, recorded: true,
            painting: false, paintFrom: doc.from || 1, paintTo: doc.to || maxRound,
            adjusting: false, guardUntil: 0, lastY: 0
        };
    }
    // Temporarily registered so getSession/finalizeRound resolve; removed
    // before returning — never persisted, never a live tab.
    sessions.push(s);
    try {
        archivePrompt(s);
        for (const e of (doc.events || [])) {
            // Pre-rename runs stored these as 'thinking'/'content'; current
            // runs store the wire names. Accept both so old rows replay.
            const t = e.type === 'thinking' ? 'thinking_delta'
                : e.type === 'content' ? 'content_delta' : e.type;
            let payload = e.payload || {};
            if (t === 'content_html') {
                // DB rows are only as trustworthy as the file they live in:
                // replay goes through the same allowlist sanitizer as
                // browser-storage restore before touching innerHTML.
                const clean = sanitizeRendered(payload.html, false);
                if (!clean) continue;
                payload = { html: clean };
            }
            handleEvent(s.id, Object.assign({ type: t, round: e.round, hid: e.hid }, payload), false);
        }
        const order = s.data.order;
        for (let i = 0; i < order.length - 1; i++) finalizeRound(s.id, order[i]);
        for (const n of order) {
            const r = s.nodes.rounds.get(n);
            if (r) r.finalized = true;
        }
        if (windowed && s.scroll) {
            s.scroll.silent = false;
            if (typeof engageHistoryWindow === 'function') engageHistoryWindow(s);
        }
    } finally {
        const at = sessions.indexOf(s);
        if (at >= 0) sessions.splice(at, 1);
    }
    splitChainView(s);
    hv.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'round history-session-head';
    const ht = document.createElement('div');
    ht.className = 'round-head';
    const h = document.createElement('h3');
    h.textContent = '◉ ' + run.title;
    ht.appendChild(h);
    head.appendChild(ht);
    const meta = document.createElement('div');
    meta.className = 'metrics';
    meta.textContent = new Date(run.created_at).toLocaleString() + ' · ' + historyStatusLabel(run.status)
        + (run.status === 'aborted' ? ' · saved transcript' : '')
        + ' · ' + run.model + ' · ' + s.data.totals.prompt + ' prompt + ' + s.data.totals.completion + ' completion tokens';
    head.appendChild(meta);
    const actions = document.createElement('div');
    actions.className = 'menu-row';
    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = '← all sessions';
    back.onclick = () => renderHistoryList();
    actions.appendChild(back);
    actions.appendChild(exportMenu([
        { label: 'Text', title: 'This session as context blocks, including before-review originals', onclick: () => withHistorySource(s, full => download('harness-history-' + run.id.slice(-8) + '.txt', sessionToPlainText(full, null, { full: true }), 'text/plain')) },
        { label: 'HTML', title: 'Full archive, including tool outputs', onclick: () => withHistorySource(s, full => download('harness-history-' + run.id.slice(-8) + '.html', archiveDoc([full]), 'text/html')) },
        { label: 'JSON', title: 'This session, without tool outputs', onclick: () => withHistorySource(s, full => download('harness-history-' + run.id.slice(-8) + '.json',
            JSON.stringify(sessionToJson(full, full.toolsOverride || s.toolsOverride), null, 2))) }
    ]));
    const curate = document.createElement('button');
    curate.type = 'button';
    curate.textContent = 'Curate';
    curate.title = 'Append this recorded session into the prompt as context blocks';
    curate.onclick = () => withHistorySource(s, full => {
        const text = sessionToPlainText(full);
        if (!String(text).trim()) { setStatus('Nothing to add to the prompt.'); return; }
        appendCurated(continuationPrompt(text));
    });
    actions.appendChild(curate);
    const ct = document.createElement('button');
    ct.type = 'button';
    ct.textContent = 'Continue in new session';
    ct.onclick = () => {
        // Fresh workspace (cleared, with unexported-tab confirm): the
        // replayed run's context becomes the standalone continuation.
        withHistorySource(s, full => continueInNewSession(sessionToPlainText(full, null, { omitMemory: true }), 'hist-' + run.id,
            'Context assembled from history'));
    };
    actions.appendChild(ct);
    if (typeof exportMenu === 'function' && typeof continueCompacted === 'function') {
        actions.appendChild(exportMenu([
            { label: 'Tool results', title: 'Headers keep HID. Tool result bodies become [ctx compacted].', onclick: () => withHistorySource(s, full => continueCompacted('results', full, 'Compacted context from history')) },
            { label: 'Results and calls', title: 'Also compact tool call arguments.', onclick: () => withHistorySource(s, full => continueCompacted('calls', full, 'Compacted context from history')) },
            { label: 'Also thinking', title: 'Also compact thinking. Responses and the prompt stay full.', onclick: () => withHistorySource(s, full => continueCompacted('bulky', full, 'Compacted context from history')) }
        ], 'Compact continue'));
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '❌ Delete';
    del.title = 'Delete this recorded session';
    del.style = 'margin-left: 12%;';
    del.onclick = () => {
        // Inline confirm (not confirm()): native dialogs can be
        // suppressed by browser settings — text anchors here instead.
        if (hv.querySelector('.hist-confirm')) return;
        const box = document.createElement('div');
        box.className = 'hist-confirm';
        box.appendChild(document.createTextNode('Delete this currently opened entry? This frees disk space and cannot be undone. '));
        const no = document.createElement('a');
        no.href = '#';
        no.textContent = 'cancel';
        no.onclick = (e) => { e.preventDefault(); box.remove(); };
        box.appendChild(no);
        box.appendChild(document.createTextNode(' · '));
        const yes = document.createElement('a');
        yes.href = '#';
        yes.textContent = 'confirm';
        yes.onclick = async (e) => {
            e.preventDefault();
            try {
                const res = await apiFetch('/history/' + encodeURIComponent(run.id), { method: 'DELETE' });
                if (!res.ok) throw new Error(await res.text() || ('HTTP ' + res.status));
            } catch (err) {
                setStatus('Delete failed: ' + err.message);
                return;
            }
            renderHistoryList();
        };
        box.appendChild(yes);
        head.after(box);
    };
    actions.appendChild(del);
    head.appendChild(actions);
    hv.appendChild(head);
    hv.appendChild(s.nodes.container);
    if (typeof refreshHistoryScrollJumps === 'function') refreshHistoryScrollJumps(s);
    if (windowed && typeof settleHistoryWindow === 'function') settleHistoryWindow(s);
    if (s.scroll) s.scroll.follow = false;
    if (typeof holdScroll === 'function') holdScroll(s);
    if (typeof resetScrollers === 'function') resetScrollers(hv);
    // Title, metadata, and export sit under the control bar. Scrolling
    // the history view to the viewport top hides that row behind the bar.
    if (typeof scrollBlockBelowDashboard === 'function') scrollBlockBelowDashboard(head);
    else if (typeof hv.scrollIntoView === 'function') {
        try { hv.scrollIntoView({ block: 'start', inline: 'nearest' }); }
        catch (e) { try { hv.scrollIntoView(true); } catch (err) {} }
    }
}

// "Back" path for the history button: return to the live workspace.
function withHistorySource(s, fn) {
    if (typeof sessionNeedsFullHistory === 'function' && sessionNeedsFullHistory(s) && typeof fullSession === 'function') {
        fullSession(s).then(fn).catch(err => setStatus('Could not load the full transcript: ' + (err && err.message ? err.message : err)));
        return;
    }
    fn(s);
}
function goBackToSession() {
    if (typeof clearHistoryScroll === 'function') clearHistoryScroll();
    if (activeSid && getSession(activeSid)) showSession(activeSid);
    else {
        if (typeof deactivatePanes === 'function') deactivatePanes();
        else {
            historyActive = false;
            document.getElementById('historyView').style.display = 'none';
        }
        createSession();
    }
}
