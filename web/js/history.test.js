// history.test.js — interrupted rows say so, and the boot note points at
// the newest saved transcript that this page did not restore.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const banner = { style: { display: 'none' }, textContent: '' };
const document = { getElementById: id => (id === 'historyBanner' ? banner : null) };
const mem = new Map();
const sandbox = {
    document,
    sessions: [],
    historyBannerKind: '',
    localStorage: {
        getItem: key => mem.has(key) ? mem.get(key) : null,
        setItem: (key, value) => mem.set(key, String(value)),
    },
    cachedConfig: { history_recording: true },
    apiFetch: async () => ({
        ok: true,
        json: async () => [
            { id: 'run-done', title: 'finished', status: 'done', created_at: 3 },
            { id: 'run-1-1793996977405', title: '==== PROMPT ====', status: 'aborted', created_at: 2, rounds: 6, model: 'beam:cloud' },
        ],
    }),
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(__dirname + '/history.js', 'utf8'), sandbox);
const evaluate = code => vm.runInContext(code, sandbox);

assert.equal(evaluate(`historyStatusLabel('aborted')`), 'interrupted');
assert.equal(evaluate(`historyStatusLabel('done')`), 'done');
assert.equal(
    evaluate(`historyRowLabel({ title: '==== PROMPT ====', status: 'aborted', rounds: 6, model: 'beam:cloud' }, 'today')`),
    '==== PROMPT ==== — today · interrupted · saved transcript — open to read it · 6 round(s) · beam:cloud'
);
assert.equal(
    evaluate(`historyRowLabel({ title: 'notes', status: 'done', rounds: 1, model: '' }, 'today')`),
    'notes — today · done · 1 round(s)'
);

(async () => {
    await evaluate('noteInterruptedRun()');
    assert.equal(banner.style.display, '');
    assert.match(banner.textContent, /==== PROMPT ====/);
    assert.match(banner.textContent, /Open history/);
    assert.equal(evaluate('historyBannerKind'), 'interrupted');

    banner.style.display = 'none';
    banner.textContent = '';
    sandbox.sessions = [{ runId: 'run-1-1793996977405' }];
    await evaluate('noteInterruptedRun()');
    assert.equal(banner.style.display, 'none');

    sandbox.sessions = [];
    evaluate('rememberInterruptedNote()');
    assert.equal(banner.style.display, 'none');
    assert.equal(mem.get('harness.interrupted.seen'), 'run-1-1793996977405');
    banner.style.display = 'none';
    await evaluate('noteInterruptedRun()');
    assert.equal(banner.style.display, 'none');

    sandbox.cachedConfig = { history_recording: false };
    mem.delete('harness.interrupted.seen');
    await evaluate('noteInterruptedRun()');
    assert.equal(banner.style.display, 'none');

    console.log('history.test.js OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
