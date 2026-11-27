// historyhid.test.js — the history HID sub-tab recalls one stored event by
// numeric id, copies its body, and keeps the Sessions pane intact.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { document } = require('./testdom.js').createDom();

const requests = [];
const copied = [];
const event = {
    hid: 243,
    run_id: 'run-7',
    seq: 4,
    type: 'tool_result',
    round: 2,
    payload: { output: 'files\n<abc123def456>keep</abc123def456>' },
    created_at: 1700000000000,
    comment_tag: 'abc123def456',
    to_model: true,
};
const sandbox = {
    document,
    sessions: [],
    historyBannerKind: '',
    cachedConfig: { history_recording: true },
    localStorage: { getItem: () => null, setItem: () => {} },
    setStatus: () => {},
    renderTabBar: () => {},
    deactivatePanes: () => {},
    historyEventBody: doc => String(doc.payload.output || '').replace(/<abc123def456>/g, '<user_comment>').replace(/<\/abc123def456>/g, '</user_comment>'),
    copyText: (text, button) => { copied.push({ text, button }); },
    apiFetch: async (url, options = {}) => {
        requests.push(url);
        if (url.startsWith('/history/page?')) {
            return { ok: true, json: async () => ({ runs: [], total: 0, limit: 20, offset: 0 }) };
        }
        if (url === '/history/events/243') {
            return { ok: true, status: 200, json: async () => event };
        }
        if (url === '/history/events/999') {
            return { ok: false, status: 404, text: async () => 'No such history event.' };
        }
        return { ok: false, status: 500, text: async () => 'history unavailable' };
    },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(__dirname + '/history.js', 'utf8'), sandbox);
const evaluate = code => vm.runInContext(code, sandbox);
const byId = id => document.getElementById(id);

(async () => {
    await evaluate('showHistory()');
    assert.equal(byId('history-sessions-tab').textContent, 'Sessions');
    assert.equal(byId('history-hid-tab').textContent, 'HID');
    assert.equal(byId('history-sessions-pane').hidden, false);
    assert.equal(byId('history-hid-pane').hidden, true);
    assert.equal(byId('history-hid-input').type, 'number');
    assert.equal(byId('history-hid-input').inputMode, 'numeric');
    assert.equal(byId('history-hid-input').min, '1');
    assert.equal(byId('history-hid-input').step, '1');
    assert.equal(byId('history-hid-result').hidden, true);

    byId('history-hid-tab').onclick();
    assert.equal(byId('history-sessions-pane').hidden, true);
    assert.equal(byId('history-hid-pane').hidden, false);
    assert.equal(byId('history-hid-tab').classList.contains('sub-tab-active'), true);

    for (const value of ['', '0', '-1', '1.5', 'abc', '9007199254740992']) {
        byId('history-hid-input').value = value;
        await evaluate('lookupHistoryHid()');
        assert.match(byId('history-hid-status').textContent, /positive whole-number/);
        assert.equal(byId('history-hid-result').hidden, true);
    }
    assert.equal(requests.some(url => url.startsWith('/history/events/')), false, 'invalid input never reaches the server');

    byId('history-hid-input').value = '243';
    await evaluate('lookupHistoryHid()');
    assert.equal(requests[requests.length - 1], '/history/events/243');
    assert.equal(byId('history-hid-result').hidden, false);
    assert.equal(byId('history-hid-title').textContent, 'HID 243');
    assert.match(byId('history-hid-meta').textContent, /tool_result/);
    assert.match(byId('history-hid-meta').textContent, /round 2/);
    assert.equal(byId('history-hid-text').textContent, 'files\n<user_comment>keep</user_comment>');
    byId('history-hid-copy').onclick();
    assert.equal(copied.length, 1);
    assert.equal(copied[0].text, 'files\n<user_comment>keep</user_comment>');

    byId('history-hid-input').value = '999';
    await evaluate('lookupHistoryHid()');
    assert.equal(byId('history-hid-result').hidden, true);
    assert.match(byId('history-hid-status').textContent, /not found in the history database/);

    // A slower earlier response cannot replace a newer lookup.
    const pending = [];
    sandbox.apiFetch = url => new Promise(resolve => pending.push({ url, resolve }));
    byId('history-hid-input').value = '243';
    const earlier = evaluate('lookupHistoryHid()');
    byId('history-hid-input').value = '999';
    const later = evaluate('lookupHistoryHid()');
    pending[1].resolve({ ok: false, status: 404, text: async () => 'No such history event.' });
    await later;
    pending[0].resolve({ ok: true, status: 200, json: async () => event });
    await earlier;
    assert.match(byId('history-hid-status').textContent, /not found/);
    assert.equal(byId('history-hid-result').hidden, true);

    // The HID pane does not destroy the paginated Sessions pane.
    byId('history-sessions-tab').onclick();
    assert.equal(byId('history-sessions-pane').hidden, false);
    assert.equal(byId('history-hid-pane').hidden, true);
    assert.equal(requests[0], '/history/page?limit=20&offset=0');

    console.log('historyhid.test.js OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
