// historypagination.test.js — the history list fetches one 20-run page at
// a time and keeps its place while a recorded transcript is opened.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { document } = require('./testdom.js').createDom();

const makeRuns = count => Array.from({ length: count }, (_, index) => ({
    id: 'run-' + String(count - index).padStart(2, '0'),
    title: 'session ' + (count - index),
    status: 'done',
    created_at: 1700000000000 - index,
    rounds: 1,
    model: 'model',
    totals_prompt: 1,
    totals_completion: 1,
    wall_ms: 1,
    tool_names: '[]',
    uploaded_files: '[]',
    comment_tag: '',
}));
const pageResponse = (runs, limit, offset) => ({
    ok: true,
    json: async () => ({
        runs: runs.slice(offset, offset + limit),
        total: runs.length,
        limit,
        offset,
    }),
});
const descendants = (root, predicate) => {
    const found = [];
    for (const child of root.children || []) {
        if (predicate(child)) found.push(child);
        found.push(...descendants(child, predicate));
    }
    return found;
};

let runs = makeRuns(45);
const requests = [];
const sandbox = {
    document,
    sessions: [],
    historyBannerKind: '',
    cachedConfig: { history_recording: true },
    localStorage: {
        getItem: () => null,
        setItem: () => {},
    },
    setStatus: () => {},
    renderTabBar: () => {},
    deactivatePanes: () => {},
    archivePrompt: () => {},
    splitChainView: () => {},
    exportMenu: () => document.createElement('div'),
    apiFetch: async (url, options = {}) => {
        requests.push(url);
        if (url.startsWith('/history/page?')) {
            const query = new URL(url, 'http://harness').searchParams;
            const limit = Number(query.get('limit'));
            const offset = Number(query.get('offset'));
            return pageResponse(runs, limit, offset);
        }
        const roundMatch = url.match(/^\/history\/([^/]+)\/rounds\?/);
        if (roundMatch) {
            const run = runs.find(item => item.id === roundMatch[1]) || makeRuns(1)[0];
            return {
                ok: true,
                json: async () => ({
                    run: Object.assign({}, run, { prompt: 'prompt' }),
                    events: [],
                    max_round: 0,
                }),
            };
        }
        return { ok: false, text: async () => 'unexpected request' };
    },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(__dirname + '/history.js', 'utf8'), sandbox);
const evaluate = code => vm.runInContext(code, sandbox);
const historyView = () => document.getElementById('historyView');
const rows = () => historyView().children.filter(child => child.classList.contains('hist-row'));
const pagination = () => descendants(historyView(), child => child.classList.contains('history-pagination'))[0];
const summary = () => descendants(historyView(), child => child.classList.contains('history-page-summary'))[0];

(async () => {
    await evaluate('renderHistoryList()');
    assert.equal(requests[0], '/history/page?limit=20&offset=0');
    assert.equal(rows().length, 20);
    assert.ok(summary(), 'the page range is displayed');
    let nav = pagination();
    assert.equal(nav.children.length, 5, 'first, previous, position, next, last');
    assert.equal(nav.children[0].hidden, true, 'first is hidden on page one');
    assert.equal(nav.children[1].hidden, true, 'previous is hidden on page one');
    assert.equal(nav.children[3].hidden, false);
    assert.equal(nav.children[4].hidden, false);

    await nav.children[3].onclick();
    assert.equal(requests[1], '/history/page?limit=20&offset=20');
    assert.equal(evaluate('historyListPage'), 1);
    assert.equal(rows().length, 20);
    nav = pagination();
    assert.equal(nav.children[0].hidden, false);
    assert.equal(nav.children[1].hidden, false);
    assert.equal(nav.children[3].hidden, false);
    assert.equal(nav.children[4].hidden, false);

    await nav.children[3].onclick();
    assert.equal(requests[2], '/history/page?limit=20&offset=40');
    assert.equal(rows().length, 5);
    nav = pagination();
    assert.equal(nav.children[3].hidden, true, 'next is hidden on the final page');
    assert.equal(nav.children[4].hidden, true, 'last is hidden on the final page');
    await nav.children[0].onclick();
    assert.equal(requests[requests.length - 1], '/history/page?limit=20&offset=0');
    assert.equal(evaluate('historyListPage'), 0);
    nav = pagination();
    await nav.children[4].onclick();
    assert.equal(requests[requests.length - 1], '/history/page?limit=20&offset=40');
    assert.equal(evaluate('historyListPage'), 2);
    nav = pagination();
    await nav.children[1].onclick();
    assert.equal(requests[requests.length - 1], '/history/page?limit=20&offset=20');

    // Opening a transcript and using its back action returns to the same
    // summary page instead of jumping to the newest sessions.
    await evaluate("openHistory('run-44')");
    const head = historyView().children[0];
    const actions = head.children.find(child => child.classList.contains('menu-row'));
    await actions.children[0].onclick();
    assert.equal(requests[requests.length - 1], '/history/page?limit=20&offset=20');
    assert.equal(evaluate('historyListPage'), 1);
    assert.equal(rows().length, 20);

    // Opening the tab normally starts at the first page.
    await evaluate('showHistory()');
    assert.equal(evaluate('historyListPage'), 0);
    assert.equal(requests[requests.length - 1], '/history/page?limit=20&offset=0');

    // A slower earlier response must not overwrite a newer page.
    const pending = [];
    sandbox.apiFetch = url => new Promise(resolve => pending.push({ url, resolve }));
    const earlier = evaluate('renderHistoryList()');
    evaluate('historyListPage = 1');
    const later = evaluate('renderHistoryList()');
    pending[1].resolve(pageResponse(makeRuns(45), 20, 20));
    await later;
    pending[0].resolve(pageResponse(makeRuns(45), 20, 0));
    await earlier;
    assert.equal(evaluate('historyListPage'), 1);
    assert.equal(rows().length, 20);
    assert.equal(rows()[0].children[1].textContent.startsWith('session 25'), true);

    // Deleting the only row on a page can leave that offset empty. The
    // list clamps to the new final page and reads it in the same action.
    runs = makeRuns(21);
    requests.length = 0;
    sandbox.apiFetch = async (url, options = {}) => {
        requests.push(url);
        if (url.startsWith('/history/page?')) {
            const query = new URL(url, 'http://harness').searchParams;
            return pageResponse(runs, Number(query.get('limit')), Number(query.get('offset')));
        }
        return { ok: false, text: async () => 'unexpected request' };
    };
    await evaluate('historyListPage = 1; renderHistoryList()');
    assert.equal(rows().length, 1);
    runs = runs.slice(0, 20);
    requests.length = 0;
    await evaluate('renderHistoryList()');
    assert.deepEqual(requests, [
        '/history/page?limit=20&offset=20',
        '/history/page?limit=20&offset=0',
    ]);
    assert.equal(evaluate('historyListPage'), 0);
    assert.equal(rows().length, 20);

    // An empty database has no pagination controls.
    runs = [];
    await evaluate('renderHistoryList()');
    assert.equal(rows().length, 0);
    assert.equal(pagination(), undefined);

    console.log('historypagination.test.js OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
