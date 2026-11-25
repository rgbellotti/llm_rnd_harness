// continue.test.js — the two continue targets: layered new-tab vs cleared
// new-session, including the clear-confirm hand-off that carries the
// assembled context through the overlay instead of discarding it.
// Loads prompt.js (the decision logic) and storage.js (the wiring) into a
// sandbox with stubbed tabs/session helpers; everything else is recorded.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
    constructor(tag) {
        this.tag = tag;
        this.style = {};
        this.children = [];
        this.value = '';
        this.textContent = '';
        const cls = new Set();
        this.classList = {
            add: c => cls.add(c),
            contains: c => cls.has(c),
            remove: c => cls.delete(c),
            toggle: c => { if (cls.has(c)) { cls.delete(c); return false; } cls.add(c); return true; },
        };
    }
    appendChild(child) { this.children.push(child); return child; }
    focus() { this.focused = true; }
    addEventListener() {}
    setRangeText() {}
    click() { if (this.onclick) this.onclick(); }
}
const elements = new Map();
const hintEl = new Element('p');
const fakeDocument = {
    getElementById(id) {
        if (!elements.has(id)) elements.set(id, new Element('div'));
        return elements.get(id);
    },
    createElement(tag) { return new Element(tag); },
    querySelector(sel) { return sel === '#clearOverlay p.hint' ? hintEl : null; },
    body: new Element('body'),
};
const sandbox = {
    document: fakeDocument,
    historyActive: false,
    configActive: false,
    activeSid: 'a',
    runningSid: null,
    exportDirty: true,
    storeEnabled: false,
    editorSlot: '',
    promptExpanded: false,
    statusMsg: '',
    cleared: false,
    __mirrored: false,
    __nextNum: 2,
    sessions: [
        { id: 'a', num: 1, prompt: 'rich history', status: 'done', data: { rounds: {}, order: [1] } },
        { id: 'z', num: 0, prompt: 'unexported sibling', status: 'done', data: { rounds: {}, order: [] } },
    ],
    activeSession: () => sandbox.sessions.find(s => s.id === sandbox.activeSid) || null,
    getSession: id => sandbox.sessions.find(s => s.id === id) || null,
    createSession() {
        const s = { id: 'b', num: sandbox.__nextNum, prompt: '', status: 'fresh', data: { rounds: {}, order: [] } };
        sandbox.sessions.push(s);
        sandbox.activeSid = s.id;
        return s;
    },
    newSession() {
        if (sandbox.runningSid !== null) return;
        const has = sandbox.sessions.some(s => (s.prompt || '').trim() !== '' || (s.data.order || []).length > 0);
        if (!sandbox.exportDirty || !has) { sandbox.doClearSession(); return; }
        vm.runInContext('resetClearHint(); pendingContinuation = "";', ctx);
        fakeDocument.getElementById('clearOverlay').style.display = 'flex';
    },
    doClearSession() {
        sandbox.cleared = true;
        sandbox.sessions = [];
        sandbox.__nextNum = 1;
        fakeDocument.getElementById('prompt').value = '';
        sandbox.createSession();
    },
    mirrorPromptToSession: () => { sandbox.__mirrored = true; },
    refreshPromptBox: () => {},
    setPromptExpanded: on => { sandbox.promptExpanded = on; },
    renderTabBar: () => {},
    setStatus: m => { sandbox.statusMsg = m; },
    // apiFetch (core.js) is what the app calls; the sandbox has no
    // server, so it is stubbed out.
    apiFetch: async () => ({ ok: true, json: async () => ({}) }),
};
const ctx = vm.createContext(sandbox);
// PROMPT_CLIP_LINES lives in tabs.js; declare it here so prompt.js sees the
// same threshold value the served page has.
vm.runInContext('const PROMPT_CLIP_LINES = 8;', ctx);
vm.runInContext(fs.readFileSync(__dirname + '/prompt.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync(__dirname + '/storage.js', 'utf8'), ctx);
const run = code => vm.runInContext(code, ctx);
const overlay = () => fakeDocument.getElementById('clearOverlay');

(async () => {
    // --- Continue in new tab: layered, workspace untouched -----------------
    run('continueInNewTab()');
    assert.equal(sandbox.cleared, false, 'layered continue must not clear');
    assert.equal(sandbox.sessions.length, 3, 'both prior tabs survive');
    assert.match(sandbox.statusMsg, /tab #1 into tab #2/);
    assert.equal(fakeDocument.getElementById('prompt').value,
        '==== PROMPT ====\nrich history\n\n==== PROMPT ====\n');
    assert.notEqual(overlay().style.display, 'flex', 'no confirm for a layered continue');
    assert.equal(sandbox.promptExpanded, true);
    assert.equal(sandbox.exportDirty, false, 'continuation resets the export flag');
    // Reset for the next scenario.
    sandbox.sessions.splice(2, 1);
    sandbox.activeSid = 'a';
    sandbox.exportDirty = true;

    // --- Continue in new session, no at-risk sibling tabs ------------------
    sandbox.sessions[1].prompt = '';
    run('continueInNewSession()');
    assert.equal(sandbox.cleared, true, 'without unexported siblings it clears directly');
    assert.equal(sandbox.sessions.length, 1, 'one fresh session remains');
    assert.equal(fakeDocument.getElementById('prompt').value,
        '==== PROMPT ====\nrich history\n\n==== PROMPT ====\n');
    assert.match(sandbox.statusMsg, /fresh session \(tab #1\)/);
    sandbox.exportDirty = true;

    // --- Continue in new session with an unexported sibling: confirm gate --
    sandbox.cleared = false;
    sandbox.sessions = [
        { id: 'a', num: 1, prompt: 'rich history', status: 'done', data: { rounds: {}, order: [1] } },
        { id: 'z', num: 0, prompt: 'unexported sibling', status: 'done', data: { rounds: {}, order: [] } },
    ];
    sandbox.__nextNum = 2;
    sandbox.activeSid = 'a';
    run('continueInNewSession()');
    assert.equal(sandbox.cleared, false, 'confirm must come before clearing');
    assert.equal(run('pendingContinuation'), '==== PROMPT ====\nrich history\n', 'context is carried as assembled (header appended on landing)');
    assert.match(String(hintEl.textContent), /carried into the new session/);
    assert.equal(overlay().style.display, 'flex');
    // Decline: nothing clears, carry resets, hint restored.
    fakeDocument.getElementById('clearCancel').onclick();
    assert.equal(sandbox.cleared, false);
    assert.equal(run('pendingContinuation'), '');
    assert.match(String(hintEl.textContent), /hasn't been exported yet/);
    assert.equal(overlay().style.display, 'none');
    // Accept: clears AND lands the carried context in the fresh session.
    run('continueInNewSession()');
    fakeDocument.getElementById('clearConfirm').onclick();
    assert.equal(sandbox.cleared, true);
    assert.match(fakeDocument.getElementById('prompt').value, /==== PROMPT ====\nrich history/);
    assert.match(sandbox.statusMsg, /assembled context \(tab #1\)/);
    assert.equal(run('pendingContinuation'), '');
    // Plain "New session" keeps its own hint and never carries a continuation.
    sandbox.exportDirty = true;
    sandbox.sessions.push({ id: 'w', num: 3, prompt: 'another unexported', status: 'done', data: { rounds: {}, order: [] } });
    run('newSession()');
    assert.equal(run('pendingContinuation'), '');
    assert.match(String(hintEl.textContent), /hasn't been exported yet/);
    assert.equal(overlay().style.display, 'flex');
    fakeDocument.getElementById('clearConfirm').onclick();
    assert.equal(fakeDocument.getElementById('prompt').value, '');
    const continued = run(`sessionToPlainText({
        prompt: 'p',
        data: { order: [1], rounds: { 1: { toolResults: [
            { output: 'stdout:\\nok\\n\\nexit code: 0 (12 ms)' },
            { output: 'read_pdf failed\\nexit code: Some(1)' }
        ] } } }
    })`);
    assert.match(continued, /stdout:\nok/);
    assert.equal(continued.includes('exit code: 0'), false);
    assert.match(continued, /exit code: Some\(1\)/);
    const fresh = run(`sessionToPlainText({
        prompt: 'p',
        data: { order: [1], rounds: { 1: { toolResults: [{ output: 'stdout:\\nok\\n' }] } } }
    })`);
    assert.match(fresh, /stdout:\nok/);
    assert.equal(fresh.includes('exit code:'), false);

    run(`function originalPreviewLabel(name) { return name === 'run_cmd' ? 'COMMAND OUTPUT ORIGINAL' : name; }`);
    const block = run(`roundPlainText({
        prompt: 'p',
        data: { rounds: { 2: {
            thinking: 'hmm',
            content: 'answer',
            toolCalls: [{ name: 'run_cmd', arguments: { command: 'ls' } }],
            toolPreviews: [{ name: 'run_cmd', output: 'listed\\n' }],
            toolResults: [{ output: 'listed\\nexit code: 0 (3 ms)' }]
        } } }
    }, 2)`);
    assert.match(block, /==== THINKING \(round 2\) ====\nhmm\n/);
    assert.match(block, /==== RESPONSE \(round 2\) ====\nanswer\n/);
    assert.match(block, /==== TOOL CALL run_cmd \(round 2\) ====/);
    // The model-bound lineage omits before-review originals entirely.
    assert.doesNotMatch(block, /COMMAND OUTPUT ORIGINAL/);
    assert.match(block, /==== TOOL RESULT \(round 2\) ====\nlisted\n/);
    // Full/export mode keeps them: exports read like the history view.
    const exported = run(`roundPlainText({
        prompt: 'p',
        data: { rounds: { 2: {
            thinking: 'hmm',
            content: 'answer',
            toolCalls: [{ name: 'run_cmd', arguments: { command: 'ls' } }],
            toolPreviews: [{ name: 'run_cmd', output: 'listed\\n' }],
            toolResults: [{ output: 'listed\\n' }]
        } } }
    }, 2, null, { full: true })`);
    assert.match(exported, /COMMAND OUTPUT ORIGINAL \(before review, round 2\) ====\nlisted\n/);
    // An edited call is emitted as its current version: one block, the
    // command and timeout that actually ran, never the original too.
    const editedCall = run(`roundPlainText({
        data: { rounds: { 4: {
            toolCalls: [{ name: 'run_cmd', arguments: { command: 'printf model-ok', timeout: '30s' }, commandEdited: true, chosenCommand: 'printf person-ok', limitEdited: true, chosenTimeout: '5m' }],
            toolResults: [{ output: 'done\\n' }]
        } } }
    }, 4)`);
    assert.match(editedCall, /"command": "printf person-ok"/);
    assert.match(editedCall, /"timeout": "5m"/);
    assert.equal(editedCall.includes('printf model-ok'), false);
    assert.equal((editedCall.match(/TOOL CALL run_cmd/g) || []).length, 1);
    const budgetLine = 'fixture budget sentence 9000/32768';
    const budgetBlock = run(`roundPlainText({
        data: { rounds: { 3: {
            content: 'answer',
            contextBudgets: ['${budgetLine}']
        } } }
    }, 3)`);
    assert.match(budgetBlock, /==== CONTEXT BUDGET \(round 3\) ====\nfixture budget sentence 9000\/32768/);
    const addressed = run(`sessionToPlainText({
        prompt: 'p', promptHid: 10,
        data: { order: [1], rounds: { 1: {
            thinking: 'hmm', thinkingHid: 11,
            content: 'answer', contentHid: 12,
            toolCalls: [{ name: 'run_cmd', hid: 13, arguments: { command: 'ls' } }],
            toolResults: [{ hid: 14, output: 'listed\\n' }]
        } } }
    }, { result: 1, call: 1 })`);
    assert.match(addressed, /==== PROMPT HID: 10 ====/);
    assert.match(addressed, /==== THINKING \(round 1\) HID: 11 ====\nhmm\n/);
    assert.match(addressed, /==== TOOL CALL run_cmd \(round 1\) HID: 13 ====\n\[ctx compacted\]/);
    assert.match(addressed, /==== TOOL RESULT \(round 1\) HID: 14 ====\n\[ctx compacted\]/);
    assert.equal(run('lastCompactMiss'), 0);
    const kept = run(`sessionToPlainText({
        prompt: 'p',
        data: { order: [1], rounds: { 1: { toolResults: [{ output: 'keep me\\n' }] } } }
    }, { result: 1 })`);
    assert.match(kept, /keep me/);
    assert.equal(kept.includes('[ctx compacted]'), false);
    assert.equal(run('lastCompactMiss'), 1);
    assert.equal(block.includes('exit code: 0'), false);
    run(`sessions[0].data.rounds[1] = {
        toolPreviews: [{ name: 'run_cmd', hid: 21, output: 'SECRET-CAPTURE' }],
        toolResults: [{ hid: 22, output: 'approved line' }],
        contextBudgets: ['stale budget 9 of 10']
    };
    sessions[0].data.order = [1];
    sessions[0].prompt = 'rich history';`);
    run('continueInNewTab()');
    const landed = fakeDocument.getElementById('prompt').value;
    assert.equal(landed.includes('SECRET-CAPTURE'), false);
    // Originals are never inserted into the prompt box: no HID for the
    // preview, and no [ctx compacted] placeholder.
    assert.equal(landed.includes('HID: 21'), false);
    assert.equal(landed.includes('[ctx compacted]'), false);
    assert.match(landed, /approved line/);
    // Budget notifications are part of the model lineage and stay.
    assert.match(landed, /stale budget 9 of 10/);
    assert.match(landed, /==== PROMPT ====\n$/);

    const promptBox = fakeDocument.getElementById('prompt');
    sandbox.runningSid = 'live';
    run(`appendCurated('==== RESPONSE (round 1) ====\\nnope\\n')`);
    assert.match(sandbox.statusMsg, /run is active/);
    sandbox.runningSid = null;
    run(`appendCurated('==== THINKING (round 1) ====\\ntrace\\n')`);
    assert.match(promptBox.value, /==== THINKING \(round 1\) ====\ntrace\n/);
    assert.equal(sandbox.activeSession().status, 'fresh');
    promptBox.value = '==== RESPONSE (round 1) ====\nold\n\n==== PROMPT ====\nstay';
    run(`appendCurated('==== THINKING (round 2) ====\\nnext\\n\\n==== PROMPT ====\\n')`);
    assert.equal(promptBox.value, '==== RESPONSE (round 1) ====\nold\n\n==== THINKING (round 2) ====\nnext\n\n==== PROMPT ====\nstay');

    sandbox.historyActive = true;
    sandbox.shown = 0;
    sandbox.reopened = false;
    sandbox.showSession = () => { sandbox.shown += 1; };
    sandbox.promptLaneWide = () => true;
    sandbox.reopenHistoryPane = () => { sandbox.reopened = true; };
    sandbox.activeSession().status = 'fresh';
    run(`appendCurated('==== THINKING (round 4) ====\\nfrom history\\n')`);
    assert.equal(sandbox.shown, 0, 'a wide history stays open');
    assert.equal(sandbox.reopened, true);
    assert.match(promptBox.value, /==== THINKING \(round 4\) ====\nfrom history\n/);
    assert.match(promptBox.value, /==== PROMPT ====\nstay/);
    sandbox.promptLaneWide = () => false;
    sandbox.reopened = false;
    run(`appendCurated('==== RESPONSE (round 5) ====\\nhi\\n')`);
    assert.equal(sandbox.shown, 1, 'a narrow history returns to the prompt');
    assert.equal(sandbox.reopened, false);

    const historySrc = fs.readFileSync(__dirname + '/history.js', 'utf8');
    assert.equal(historySrc.includes('Continue in new tab'), false);
    assert.match(historySrc, /Continue in new session/);
    assert.match(historySrc, /textContent = 'Curate'/);
    console.log('Continue in new tab / new session tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
