// stream.js — NDJSON event handling routed to the owning session, plus the
// generate() entry point and run timer. Needs core.js, tabs.js, rounds.js,
// prompt.js, approval.js, storage.js (persistDebounced).
        function formatUsd(value) {
            if (typeof value !== 'number' || !(value > 0)) return '';
            const digits = value >= 0.01 ? 4 : 6;
            return ' · $' + value.toFixed(digits);
        }
        function doneFooter(s, ev) {
            const d = document.createElement('div');
            d.className = 'done';
            d.textContent = '── End of chain: ' + ev.rounds + ' round(s) · '
                + ev.total_prompt_tokens + ' prompt + ' + ev.total_completion_tokens + ' completion'
                + (ev.total_reasoning_tokens ? ' + ' + ev.total_reasoning_tokens + ' reasoning' : '')
                + ' tokens'
                + (typeof formatUsd === 'function' ? formatUsd(ev.total_cost_usd) : '')
                + ' · wall ' + fmtMs(ev.wall_ms)
                + (ev.max_rounds_hit ? ' · reached max tool rounds' : '') + ' ──';
            return d;
        }
        // History replay only. The live result body is the text the model
        // receives, and the heading already shows how long the call took.
        function appendExitCodeNote(parent, ev, live) {
            if (live || !ev || ev.exit_code == null || ev.exit_code === '') return null;
            const note = document.createElement('div');
            note.className = 'metrics';
            note.textContent = 'exit code: ' + ev.exit_code;
            parent.appendChild(note);
            return note;
        }
        function removeEl(el) {
            if (!el) return;
            if (el.parentNode && typeof el.parentNode.removeChild === 'function') {
                try { el.parentNode.removeChild(el); return; } catch (e) {}
            }
            if (typeof el.remove === 'function') el.remove();
        }
        function paintShown(el, text) {
            if (!el) return;
            if (typeof fillCommented === 'function') fillCommented(el, text);
            else el.textContent = text == null ? '' : String(text);
        }
        // Thinking and the answer mention the comment tag. They are not
        // places a person can insert one, so they stay unhighlighted.
        function paintPlain(el, text) {
            if (!el) return;
            if (typeof fillPlain === 'function') fillPlain(el, text);
            else el.textContent = text == null ? '' : String(text);
        }
        // live=false replays recorded history: same rendering, but no timer,
        // no persistence, no session finalization, no scrolling.
        function pendingHids(s) {
            if (!s.pendingHids) s.pendingHids = [];
            return s.pendingHids;
        }
        function takePendingHid(s, round, kind) {
            const q = s.pendingHids || [];
            for (let i = 0; i < q.length; i++) {
                if (q[i].round === round && q[i].kind === kind) return q.splice(i, 1)[0].hid;
            }
            return 0;
        }
        function refreshThinkingHid(s, n) {
            const ref = s.nodes && s.nodes.rounds && s.nodes.rounds.get(n);
            const data = s.data && s.data.rounds && s.data.rounds[n];
            if (!ref || !data || !data.thinkingHid || !ref.det || !ref.det.querySelector) return;
            const label = ref.det.querySelector('.thinking-label');
            if (label && String(label.textContent).indexOf('HID:') < 0) {
                label.textContent = label.textContent + ' · HID: ' + data.thinkingHid;
            }
        }
        function refreshContentHid(s, n) {
            const ref = s.nodes && s.nodes.rounds && s.nodes.rounds.get(n);
            const data = s.data && s.data.rounds && s.data.rounds[n];
            if (!ref || !data || !data.contentHid || !ref.contentEl) return;
            if (ref.contentHidNote) return;
            const note = document.createElement('div');
            note.className = 'metrics';
            note.textContent = '▶ RESPONSE HID: ' + data.contentHid;
            if (ref.contentEl.parentNode) ref.contentEl.parentNode.insertBefore(note, ref.contentEl);
            ref.contentHidNote = note;
        }
        function applyBlockHid(s, ev) {
            const hid = Number(ev.hid);
            if (!hid || hid < 1) return;
            const kind = ev.kind || '';
            const round = ev.round || 0;
            if (kind === 'prompt') { s.promptHid = hid; return; }
            if (kind === 'thinking' || kind === 'content') {
                const data = roundData(s, round);
                if (kind === 'thinking') { data.thinkingHid = hid; refreshThinkingHid(s, round); }
                else { data.contentHid = hid; refreshContentHid(s, round); }
                return;
            }
            const data = s.data && s.data.rounds && s.data.rounds[round];
            const list = data && (kind === 'tool_call' ? data.toolCalls
                : kind === 'tool_preview' ? (data.toolPreviews || (data.toolPreviews = []))
                : kind === 'tool_result' ? data.toolResults : null);
            if (list) {
                for (let i = list.length - 1; i >= 0; i--) {
                    if (list[i] && !list[i].hid) { list[i].hid = hid; return; }
                }
            }
            pendingHids(s).push({ round: round, kind: kind, hid: hid });
        }
        function eventHid(s, ev, kind) {
            const direct = Number(ev && ev.hid);
            if (direct > 0) return direct;
            return takePendingHid(s, ev.round || 0, kind);
        }
        function handleEvent(sid, ev, live) {
            if (live === undefined) live = true;
            const s = getSession(sid);
            if (!s) return;
    const output = s.nodes.container;
    if (ev.type === 'block_hid') {
        applyBlockHid(s, ev);
    } else if (ev.type === 'prompt') {
        if (ev.hid) s.promptHid = Number(ev.hid);
    } else if (ev.type === 'run_started') {
        s.runId = ev.run_id;
        if (typeof validCommentTag === 'function') {
            const tag = validCommentTag(ev.comment_tag);
            if (tag) s.commentTag = tag;
        }
    } else if (ev.type === 'history_status') {
        if (!cachedConfig) cachedConfig = {};
        cachedConfig.history_recording = !!ev.recording;
        cachedConfig.history_error = ev.message || '';
        if (typeof applyHistoryGate === 'function') applyHistoryGate(cachedConfig);
        if (live && !ev.recording) {
            const d = document.createElement('div');
            d.className = 'error';
            d.textContent = 'Session history is unavailable (' + (ev.message || 'history is unavailable') + '). This run is continuing without a permanent record.';
            output.appendChild(d);
        }
    } else if (ev.type === 'round_start') {
        // Previous round finished streaming before this one starts:
        // condense it now (if long). The incoming round stays live.
        if (ev.round > 1) finalizeRound(sid, ev.round - 1);
        ensureRound(s, ev.round, ev.model);
        roundData(s, ev.round).model = ev.model || roundData(s, ev.round).model;
        if (live) setActivityIcon('think');
    } else if (ev.type === 'thinking_delta') {
        const r = ensureRound(s, ev.round);
        const data = roundData(s, ev.round);
        data.thinking += ev.text;
        if (ev.hid) { data.thinkingHid = Number(ev.hid); refreshThinkingHid(s, ev.round); }
        paintPlain(r.thinkingBody, displaySessionText(s, data.thinking));
        r.det.open = true;
        if (live) setActivityIcon('think');
    } else if (ev.type === 'content_delta') {
        const r = ensureRound(s, ev.round);
        const data = roundData(s, ev.round);
        data.content += ev.text;
        if (ev.hid) { data.contentHid = Number(ev.hid); refreshContentHid(s, ev.round); }
        paintPlain(r.contentEl, displaySessionText(s, data.content));
        if (live) setActivityIcon('think');
    } else if (ev.type === 'tool_call') {
        const r = ensureRound(s, ev.round);
        const d = document.createElement('div');
        d.className = 'tool';
        const callHid = eventHid(s, ev, 'tool_call');
        const rawCallText = (typeof formatToolCallText === 'function')
            ? formatToolCallText(ev.name, ev.arguments)
            : ('▶ TOOL CALL → ' + ev.name);
        const shownCall = typeof withHid === 'function' ? withHid(rawCallText, callHid) : rawCallText;
        const rawPretty = (typeof formatToolCallText === 'function')
            ? formatToolCallText(ev.name, ev.arguments, true) : shownCall;
        if (typeof paintShellView === 'function' && ev.arguments && typeof ev.arguments.command === 'string') {
            // A shell call gets the pretty/raw dual view: the readable
            // command by default, the byte-identical raw one click away.
            // The raw block is the copy/curate source (rawBodyText strips
            // the pretty block and the toggle).
            paintShellView(d, shownCall, typeof withHid === 'function' ? withHid(rawPretty, callHid) : rawPretty);
        } else {
            paintShown(d, shownCall);
        }
        r.body.appendChild(d);
        const callData = roundData(s, ev.round);
        const callItem = { kind: 'call', name: ev.name, arguments: ev.arguments, hid: callHid || undefined };
        callData.toolCalls.push(callItem);
        rememberEvidence(callData, callItem);
        if (typeof rememberToolDom === 'function') rememberToolDom(callItem, { node: d });
        // Paused at the approval gate until the user decides: not busy.
        if (live) setActivityIcon('idle');
        if (live && ev.name === 'web_fetch') {
            s.statusText = 'Fetching page for review…';
            if (s.id === activeSid) setStatus(s.statusText);
        }
    } else if (ev.type === 'tool_preview') {
        const r = ensureRound(s, ev.round);
        const d = document.createElement('div');
        d.className = 'tool tool-preview';
        const data = roundData(s, ev.round);
        if (!data.toolPreviews) data.toolPreviews = [];
        const previewHid = eventHid(s, ev, 'tool_preview');
        const previewItem = { kind: 'preview', name: ev.name, output: ev.output, duration_ms: ev.duration_ms, exit_code: ev.exit_code, provisional: !!ev.provisional, hid: previewHid || undefined };
        data.toolPreviews.push(previewItem);
        rememberEvidence(data, previewItem);
        const previewHead = (typeof withHid === 'function' ? withHid : (t) => t)('▶ ' + originalPreviewLabel(ev.name) + ' (before review, ' + ev.duration_ms + ' ms)', previewHid);
        if (ev.name === 'web_fetch' && typeof renderWebFetchPreview === 'function') {
            renderWebFetchPreview(d, text => displaySessionText(s, text), previewItem, previewHead);
        } else {
            paintShown(d, previewHead + '\n' + displaySessionText(s, ev.output));
        }
        r.body.appendChild(d);
        if (typeof rememberToolDom === 'function') rememberToolDom(previewItem, { node: d, note: appendExitCodeNote(r.body, ev, live) });
        else appendExitCodeNote(r.body, ev, live);
        // Fetch done; waiting on the user's stage-two review: not busy.
        if (live) setActivityIcon('idle');
    } else if (ev.type === 'content_html') {
        // Both live responses and history replay use the same rendered view.
        showRenderedResponse(s, ev.round, ev.html);
            } else if (ev.type === 'tool_approval_request') {
                ensureRound(s, ev.round);
                if (live) { showApprovalModal(ev); setActivityIcon('idle'); }
            } else if (ev.type === 'approval') {
                // Recorded user decisions (replay only — live approvals use
                // the modal). Displayed as margin notes, never re-executed.
                if (!live) {
                    const r = ensureRound(s, ev.round);
                    if (s.historyView && typeof noteHistoryApproval === 'function') {
                        const editedCall = noteHistoryApproval(roundData(s, ev.round), ev);
                        const editedNode = editedCall && typeof toolDomFields === 'function' ? toolDomFields(editedCall).node : null;
                        if (editedNode && typeof toolCallDiffText === 'function' && typeof replaceWithLineDiff === 'function') {
                            const diff = toolCallDiffText(editedCall);
                            const show = text => displaySessionText(s, text);
                            replaceWithLineDiff(editedNode, show(diff.before), show(diff.after));
                        }
                    }
                    const d = document.createElement('div');
                    d.className = 'metrics';
                    const actor = ev.auto ? 'auto-approved ' : 'user ';
                    const submitted = ev.decision === 'web_result' || ev.decision === 'pdf_result' || ev.decision === 'rag_result'
                        || (ev.auto && ev.decision === 'cmd_result');
                    paintPlain(d, '◈ ' + actor + (submitted
                        ? (ev.auto ? 'results for ' : 'submitted results for ') + ev.tool + ' (see tool output)'
                        : ev.decision === 'answer'
                        ? 'answered ' + (ev.tool || 'questions') + ': ' + displaySessionText(s, JSON.stringify(ev.answers, null, 2))
                        : ev.decision === 'redirect'
                        ? 'redirected ' + (ev.tool || 'tool') + ': ' + displaySessionText(s, ev.text || '')
                        : (ev.auto ? '' : 'approved ') + (ev.tool || 'tool') + (ev.command_timeout ? ' · time limit ' + ev.command_timeout : '')));
                    r.body.appendChild(d);
                }
            } else if (ev.type === 'tool_result') {
        const r = ensureRound(s, ev.round);
        const d = document.createElement('div');
        d.className = 'tool tool-result';
        const resultData = roundData(s, ev.round);
        const resultHid = eventHid(s, ev, 'tool_result');
        const resultHead = (typeof withHid === 'function' ? withHid : (t) => t)('▶ TOOL RESULT (' + ev.duration_ms + ' ms)', resultHid);
        const resultItem = { kind: 'result', name: ev.name, output: ev.output, duration_ms: ev.duration_ms, hid: resultHid || undefined };
        const show = text => displaySessionText(s, text);
        let exitCode = ev.exit_code;
        let plan = null;
        if (!live && s.historyView && typeof historyResultPlan === 'function') {
            plan = historyResultPlan(resultData, ev);
            // One block. An unedited result replaces the preview. An edited
            // result is that same block with the old line, then the new line.
            if (plan.preview && (plan.suppress || plan.edited)) {
                const held = typeof toolDomFields === 'function' ? toolDomFields(plan.preview) : {};
                removeEl(held.node);
                removeEl(held.note);
                if ((exitCode == null || exitCode === '') && plan.preview.exit_code != null) exitCode = plan.preview.exit_code;
            }
        }
        if (plan && plan.suppress && ev.name === 'web_fetch' && plan.preview && typeof renderWebFetchPreview === 'function') {
            d.className = 'tool tool-result';
            renderWebFetchPreview(d, show, { name: ev.name, output: plan.preview.output, duration_ms: ev.duration_ms }, resultHead);
        } else if (plan && plan.edited && typeof renderLineDiff === 'function') {
            d.className = 'tool tool-result';
            const head = document.createElement('div');
            head.className = 'tool-window-head';
            head.textContent = resultHead;
            d.appendChild(head);
            const diff = document.createElement('div');
            diff.className = 'tool-diff';
            renderLineDiff(diff, show(plan.source || ''), show(plan.submitted == null ? '' : plan.submitted));
            d.appendChild(diff);
        } else if (ev.name === 'web_fetch' && typeof renderWebFetchResult === 'function') {
            const index = (resultData.toolResults || []).filter(item => item.name === 'web_fetch').length;
            const stderr = typeof webFetchStderrAt === 'function' ? webFetchStderrAt(resultData.toolPreviews, index) : '';
            renderWebFetchResult(d, show, resultItem, stderr);
        } else {
            const shown = plan && plan.suppress && plan.submitted != null ? plan.submitted : ev.output;
            paintShown(d, resultHead + '\n' + show(shown));
        }
        r.body.appendChild(d);
        appendExitCodeNote(r.body, { exit_code: exitCode }, live);
        resultData.toolResults.push({ name: ev.name, output: ev.output, duration_ms: ev.duration_ms, hid: resultHid || undefined });
        rememberEvidence(resultData, resultItem);
        // Tool finished; the model is consuming the result again.
        if (live) setActivityIcon('think');
        // No-cap transparency notice: huge outputs are kept verbatim and can
        // make the tab heavy; JSON exports exclude them, HTML includes them.
        if (ev.output && ev.output.length > 500000) {
            const w = document.createElement('div');
            w.className = 'metrics';
            w.textContent = 'note: large tool output (' + ev.output.length + ' chars) kept in this tab and in history. Export HTML if browser storage cannot hold it.';
            r.body.appendChild(w);
        }
    } else if (ev.type === 'metrics') {
        const r = ensureRound(s, ev.round);
        // A window remount replays metrics for display only. Totals were
        // already counted when the round first streamed.
        if (!(s.scroll && s.scroll.silent)) {
            s.data.totals.prompt += ev.prompt_tokens || 0;
            s.data.totals.completion += ev.completion_tokens || 0;
        }
        const m = document.createElement('div');
        m.className = 'metrics';
        m.textContent = 'tokens: prompt ' + ev.prompt_tokens + ' / completion ' + ev.completion_tokens
            + (ev.reasoning_tokens ? ' / reasoning ' + ev.reasoning_tokens : '')
            + (ev.cached_tokens ? ' · cached ' + ev.cached_tokens : '')
            + (ev.reasoning_effort ? ' · effort ' + ev.reasoning_effort : '')
            + (typeof formatUsd === 'function' ? formatUsd(ev.cost_usd) : '')
            + ' · total ' + ev.total_ms.toFixed(1) + 'ms · load ' + ev.load_ms.toFixed(1) + 'ms'
            + ' · prompt_eval ' + ev.prompt_eval_ms.toFixed(1) + 'ms · eval ' + ev.eval_ms.toFixed(1) + 'ms'
            + ' · ' + ev.tps.toFixed(1) + ' tok/s (' + ev.model + ')';
                r.body.appendChild(m);
                roundData(s, ev.round).metrics = ev;
                if (live && sid === activeSid) tick();
    } else if (ev.type === 'context_budget' || ev.type === 'notice' || ev.type === 'protocol_correction') {
        const message = ev.type === 'protocol_correction' ? (ev.text || '') : (ev.message || '');
        const budget = ev.type === 'context_budget'
            || (ev.type === 'notice' && String(message).indexOf('Context budget from the harness:') === 0);
        if (budget && typeof rememberContextBudget === 'function') {
            // A live notice from an older build has no round. It is emitted
            // at the end of the round that crossed the mark.
            let n = ev.round > 0 ? ev.round : 0;
            if (!(n > 0) && s.data && s.data.order && s.data.order.length) n = s.data.order[s.data.order.length - 1];
            if (n > 0) rememberContextBudget(s, n, message);
        } else {
            const d = document.createElement('div');
            d.className = 'metrics';
            d.textContent = ev.type === 'protocol_correction'
                ? '◈ Harness instruction: ' + message
                : '◈ ' + message;
            // Silent remount keeps the note inside the round so the next
            // shift takes it with that round instead of stacking copies.
            const host = (s.scroll && s.scroll.silent && ev.round) ? ensureRound(s, ev.round).body : output;
            host.appendChild(d);
        }
    } else if (ev.type === 'error') {
        const message = ev.message || 'The run stopped.';
        s.runError = message;
        const d = document.createElement('div');
        d.className = 'error';
        d.textContent = 'Error: ' + message;
        const host = (s.scroll && s.scroll.silent && ev.round) ? ensureRound(s, ev.round).body : output;
        host.appendChild(d);
        // An empty round is promoted to the Response tab when the run ends.
        // Put the sentence there so a stopped Ollama server is not a blank page.
        const order = s.data && s.data.order;
        const last = order && order.length ? order[order.length - 1] : null;
        const round = last != null && s.nodes.rounds ? s.nodes.rounds.get(last) : null;
        if (round && round.contentEl && !String(round.contentEl.textContent || '').trim()) {
            round.contentEl.textContent = message;
            const data = roundData(s, last);
            if (data && !String(data.content || '').trim()) data.content = message;
        }
    } else if (ev.type === 'done') {
        // Condense every round except the last: the final answer
        // response always stays fully displayed.
        for (let n = 1; n < ev.rounds; n++) finalizeRound(sid, n);
        s.data.wallMs = ev.wall_ms;
        s.data.doneInfo = { rounds: ev.rounds, max_rounds_hit: ev.max_rounds_hit };
        output.appendChild(doneFooter(s, ev));
        if (live) finishSession(s, 'done', ev);
    }
    if (live) {
        persistDebounced();
        maybeScroll();
        if (typeof maintainScrollTail === 'function') maintainScrollTail(s);
    }
}
function rememberEvidence(data, item) {
    if (!data.evidence) data.evidence = [];
    data.evidence.push(item);
}
function syncStopBtn() {
    const on = runningSid !== null;
    document.getElementById('stopBtn').style.display = on ? '' : 'none';
    document.getElementById('runBtn').style.display = on ? 'none' : '';
}
async function stopRun() {
    setActivityIcon('done');
    try {
        const res = await apiFetch('/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        if (!res.ok) setStatus('Stop failed: ' + await res.text());
    } catch (e) {
        setStatus('Stop failed: ' + e.message);
    }
}
document.getElementById('stopBtn').onclick = () => stopRun();
function tick() {
    const s = getSession(runningSid || activeSid);
    if (!s || s.status !== 'running') return;
    const el = Date.now() - t0;
    s.statusText = 'Running… ' + fmtMs(el) + ' · prompt tokens ' + s.data.totals.prompt + ' · completion tokens ' + s.data.totals.completion;
    if (s.id === activeSid) setStatus(s.statusText);
}
const CONTEXT_GUIDE_KEY = 'harness.context.guide.v1';
const CONTEXT_LIMIT_MAX = 10000000;
let contextLimitOpen = false;
let contextLimitResolve = null;
function loadContextGuides() {
    try {
        const raw = localStorage.getItem(CONTEXT_GUIDE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
        return {};
    }
}
function loadContextGuide(model) {
    const value = loadContextGuides()[model];
    return typeof value === 'string' ? value : '';
}
function saveContextGuide(model, text) {
    if (!model) return;
    const guides = loadContextGuides();
    guides[model] = text;
    try { localStorage.setItem(CONTEXT_GUIDE_KEY, JSON.stringify(guides)); } catch (e) {}
}
function currentModelName() {
    const toggle = document.getElementById('modelToggle');
    return toggle && toggle.textContent ? String(toggle.textContent).trim() : '';
}
function parseContextTokenCount(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!/^[1-9][0-9]*$/.test(text)) return null;
    const n = Number(text);
    if (!Number.isSafeInteger(n) || n < 1 || n > CONTEXT_LIMIT_MAX) return null;
    return n;
}
function contextBudgetChoice(providerTokens, action, rawText) {
    if (typeof providerTokens === 'number' && providerTokens > 0) {
        return { start: true, limit: null };
    }
    if (action === 'cancel') return { start: false, limit: null };
    if (action === 'skip') return { start: true, limit: null };
    if (action === 'use') {
        const limit = parseContextTokenCount(rawText);
        if (limit == null) return { start: false, limit: null, invalid: true };
        return { start: true, limit: limit };
    }
    return { start: false, limit: null };
}
function closeContextLimit(choice) {
    contextLimitOpen = false;
    const overlay = document.getElementById('contextOverlay');
    if (overlay) overlay.style.display = 'none';
    const resolve = contextLimitResolve;
    contextLimitResolve = null;
    if (resolve) resolve(choice);
}
function askContextLimit() {
    if (typeof openModelMenu === 'function') openModelMenu(false);
    const model = currentModelName();
    const input = document.getElementById('contextLimitInput');
    const error = document.getElementById('contextLimitError');
    if (input) input.value = loadContextGuide(model);
    if (error) error.textContent = '';
    const overlay = document.getElementById('contextOverlay');
    if (overlay) overlay.style.display = '';
    contextLimitOpen = true;
    if (input && typeof input.focus === 'function') input.focus();
    return new Promise(resolve => { contextLimitResolve = resolve; });
}
function submitContextLimit(action) {
    const model = currentModelName();
    const input = document.getElementById('contextLimitInput');
    const error = document.getElementById('contextLimitError');
    const raw = input ? input.value : '';
    const choice = contextBudgetChoice(null, action, raw);
    if (choice.invalid) {
        // The count is data, not prose: the error states the accepted
        // range so the operator can fix it. The dialog stays open.
        if (error) error.textContent = 'Enter a token count from 1 to ' + CONTEXT_LIMIT_MAX + '.';
        return;
    }
    if (choice.start && choice.limit != null) saveContextGuide(model, String(choice.limit));
    closeContextLimit(choice);
}
function wireContextLimit() {
    const use = document.getElementById('contextUse');
    const skip = document.getElementById('contextSkip');
    const cancel = document.getElementById('contextCancel');
    if (use) use.onclick = () => submitContextLimit('use');
    if (skip) skip.onclick = () => submitContextLimit('skip');
    if (cancel) cancel.onclick = () => submitContextLimit('cancel');
    // Escape cancels the guide dialog: nothing has started yet.
    if (typeof trapOverlayFocus === 'function') {
        trapOverlayFocus(document.getElementById('contextOverlay'), () => submitContextLimit('cancel'));
    }
}
wireContextLimit();
async function resolveContextLimit() {
    const res = await apiFetch('/context-window');
    if (!res.ok) throw new Error(await res.text() || ('HTTP ' + res.status));
    const body = await res.json();
    const tokens = body && typeof body.tokens === 'number' && body.tokens > 0 ? body.tokens : null;
    if (tokens != null) return contextBudgetChoice(tokens, 'skip', '');
    return askContextLimit();
}
async function generate() {
    if (runningSid !== null || contextLimitOpen) return;
    let s = activeSession();
    const box = document.getElementById('prompt');
    if (s && s.status === 'running') return;
    const typed = box ? String(box.value || '') : '';
    if (!typed.trim()) {
        if (s && s.status === 'fresh') setStatus('Please enter a prompt.');
        return;
    }
    // The provider window decides whether a typed guide is needed. Ask
    // before creating anything: cancelling leaves the draft untouched.
    let contextLimit = null;
    try {
        const choice = await resolveContextLimit();
        if (!choice.start) return;
        contextLimit = choice.limit;
    } catch (e) {
        setStatus('Context window check failed: ' + e.message);
        return;
    }
    const prompt = box ? String(box.value || '').trim() : '';
    if (!prompt) { setStatus('Please enter a prompt.'); return; }
    // A finished chain can still hold a typed or pasted draft. Generate
    // opens that draft as its own fresh tab, then starts the run.
    if (!s || s.status !== 'fresh') {
        s = createSession(prompt);
        if (typeof composerDraft !== 'undefined') composerDraft = '';
        if (!s || s.status !== 'fresh') return;
    }
    await refreshConfig();
    const unrecorded = cachedConfig && cachedConfig.history_recording === false;
    const allowBox = document.getElementById('allowUnrecorded');
    if (unrecorded && !(allowBox && allowBox.checked)) {
        setStatus('Session history is unavailable. Allow an unrecorded run to start this session without a permanent record.');
        return;
    }
    // History, config, docs, tools, work, and credits can stay open beside
    // the prompt. The run itself belongs on the session column.
    if (typeof showSession === 'function' && (
        (typeof historyActive !== 'undefined' && historyActive) ||
        (typeof configActive !== 'undefined' && configActive) ||
        (typeof docsActive !== 'undefined' && docsActive) ||
        (typeof toolsActive !== 'undefined' && toolsActive) ||
        (typeof workActive !== 'undefined' && workActive) ||
        (typeof creditsActive !== 'undefined' && creditsActive)
    )) showSession(s.id);
    s.prompt = prompt;
    s.status = 'running';
    s.statusText = 'Starting…';
    runningSid = s.id;
    // The side lane belongs to Thinking, Waiting, and tool approvals
    // once the run starts. The prompt editor returns to the column.
    if (typeof setPromptExpanded === 'function') setPromptExpanded(false);
    if (typeof syncRunDock === 'function') syncRunDock();
    if (typeof persist === 'function') {
        try { persist(); } catch (e) {}
    }
    box.disabled = true;
    hideApprovalModal();
    renderTabBar();
    t0 = Date.now();
    setStatus(s.statusText);
    setActivityIcon('think');
    if (timerId) clearInterval(timerId);
    timerId = setInterval(tick, 250);
    // Filenames for the history hover list, parsed from the ---- markers.
    // Content itself already travels inside `prompt`.
    const uploadedFiles = [];
    try {
        const re = /^---- Uploaded File '(.*)' ----$/gm;
        let m;
        while ((m = re.exec(prompt)) !== null) uploadedFiles.push(m[1]);
    } catch (e) {}
    try {
        const res = await apiFetch('/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign(
                { prompt, uploaded_files: uploadedFiles, allow_unrecorded: !!unrecorded },
                contextLimit ? { context_limit: contextLimit } : {}
            ))
        });
        if (!res.ok) throw new Error(await res.text() || ('HTTP ' + res.status));
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            if (buf.length > 1000000 && s.id === activeSid) setStatus('Streaming large tool output without truncation (' + buf.length + ' chars buffered)…');
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (!line) continue;
                try { handleEvent(s.id, JSON.parse(line)); }
                catch (e) {
                    const d = document.createElement('div');
                    d.className = 'error';
                    d.textContent = 'Bad event: ' + line.slice(0, 200);
                    s.nodes.container.appendChild(d);
                }
            }
        }
        if (buf.trim()) { try { handleEvent(s.id, JSON.parse(buf.trim())); } catch (e) {} }
        if (s.status === 'running') finishSession(s, s.runError ? 'error' : 'done', null);
    } catch (err) {
        const d = document.createElement('div');
        d.className = 'error';
        d.textContent = 'Error: ' + err.message;
        s.nodes.container.appendChild(d);
        if (s.status === 'running') finishSession(s, 'error', null);
    } finally {
        if (timerId) { clearInterval(timerId); timerId = null; }
        if (runningSid === s.id) runningSid = null;
        // A stop (or any abrupt end) during an approval leaves the modal
        // orphaned — the run it belonged to is gone either way.
        hideApprovalModal();
        renderTabBar();
        if (s.id === activeSid) setStatus(s.statusText);
        if (typeof syncRunDock === 'function') syncRunDock();
    }
}
