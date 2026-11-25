const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
    constructor(tag) {
        this.tagName = tag;
        this.style = {};
        this.children = [];
        this._text = '';
        this.className = '';
        this.classList = { toggle() {}, add() {}, remove() {} };
        this.value = '';
        this.checked = false;
    }
    get textContent() {
        if (this.children.length) return this.children.map(child => child.textContent || '').join('');
        return this._text;
    }
    set textContent(value) {
        this._text = value == null ? '' : String(value);
        this.children = [];
    }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { this.children.push(...children); }
    setAttribute() {}
    focus() {}
    set innerHTML(value) { if (!value) this.children = []; }
    get innerHTML() { return ''; }
}

const elements = new Map();
const mem = new Map();
let quota = false;
const document = {
    getElementById(id) {
        if (!elements.has(id)) elements.set(id, new Element('div'));
        return elements.get(id);
    },
    createElement(tag) { return new Element(tag); },
    querySelector() { return null; },
    body: new Element('body'),
};
const leaveListeners = {};
const localStorage = {
    getItem(key) { return mem.has(key) ? mem.get(key) : null; },
    setItem(key, value) {
        const text = String(value);
        if (quota && text.includes('RAW-TOO-BIG')) throw new Error('QuotaExceededError');
        mem.set(key, text);
    },
    removeItem(key) { mem.delete(key); },
};
const sandbox = {
    document,
    localStorage,
    window: {
        innerHeight: 800,
        scrollY: 0,
        scrollTo() {},
        addEventListener(type, fn) { leaveListeners[type] = fn; },
    },
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout() {},
    fetch: async () => ({ ok: false, text: async () => 'missing' }),
    syncStopBtn() {},
    syncPromptUI() {},
    syncModelMenu() {},
    syncActivityIcon() {},
    setActivityIcon() {},
    hideApprovalModal() {},
    showApprovalModal() {},
    maybeScroll() {},
    Map,
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    Error,
};
vm.createContext(sandbox);
const load = (name) => vm.runInContext(fs.readFileSync(__dirname + '/' + name, 'utf8'), sandbox);
load('core.js');
// formatToolCallText renders the call's own data — the task phrase and
// the chosen timeout — and omits what the call did not set. The label
// wording around those values is display surface and may change freely.
const withTask = sandbox.formatToolCallText('run_cmd', {
    command: 'ls', task: 'looking for relevant files',
});
assert.ok(withTask.includes('looking for relevant files'), 'a set task appears');
assert.ok(withTask.includes('ls'), 'the command appears');
const bare = sandbox.formatToolCallText('run_cmd', { command: 'ls' });
assert.ok(withTask.length > bare.length, 'a set task adds a line; an unset one adds none');
assert.ok(
    sandbox.formatToolCallText('run_cmd', { command: 'ls', timeout: '30s' }).includes('30s'),
    'a short timeout appears as chosen'
);
const humanized = sandbox.formatToolCallText('run_cmd', {
    command: 'make', task: 'compiling the driver', timeout: '20m',
});
assert.ok(humanized.includes('20'), 'the chosen duration is reflected');
assert.ok(
    sandbox.formatToolCallText('run_cmd', {
        command: 'curl -O https://example.com/a.deb', timeout: 'none',
    }).includes('none'),
    'no-timeout appears as chosen'
);
load('tabs.js');
load('rounds.js');
load('stream.js');
load('storage.js');
// Restore should not re-render markdown or condense in this test.
sandbox.restoreRenderedResponse = () => {};
sandbox.finalizeRound = () => {};
sandbox.splitChainView = () => {};
sandbox.buildPromptSection = () => document.createElement('div');

function session(extra) {
    return Object.assign({
        id: 'tab-1', num: 1, prompt: 'look around', status: 'done', statusText: 'done',
        createdAt: '2026-01-01T00:00:00.000Z', runId: 'run-7-1',
        data: {
            order: [1],
            totals: { prompt: 3, completion: 4 },
            wallMs: 12,
            doneInfo: null,
            rounds: {
                1: {
                    model: 'local', thinking: 'hmm', content: 'ok', contentHtml: '', metrics: null,
                    toolCalls: [{ name: 'run_cmd', arguments: { command: 'ls' } }],
                    toolResults: [{ name: 'run_cmd', output: 'file.txt', duration_ms: 4 }],
                    toolPreviews: [{ name: 'run_cmd', output: 'RAW ls', duration_ms: 4 }],
                    evidence: [
                        { kind: 'call', name: 'run_cmd', arguments: { command: 'ls' } },
                        { kind: 'preview', name: 'run_cmd', output: 'RAW ls', duration_ms: 4 },
                        { kind: 'result', name: 'run_cmd', output: 'file.txt', duration_ms: 4 },
                    ],
                },
            },
        },
    }, extra);
}

const evaluate = (code) => vm.runInContext(code, sandbox);
function roundText() {
    return evaluate(`sessions[0].nodes.rounds.get(1).body.children.map(child => child.textContent).join('\\n')`);
}
sandbox.fixture = session();
evaluate(`sessions = [fixture]; storeEnabled = true; seq = 1; persist(); sessions = []; restoreResult = restore();`);
assert.equal(sandbox.restoreResult, true);
assert.equal(evaluate('sessions[0].runId'), 'run-7-1');
assert.equal(evaluate('sessions[0].data.rounds[1].toolResults[0].output'), 'file.txt');
// The JSON export records the model the run actually used (the newest
// round's model), never a serve-time placeholder.
assert.equal(evaluate('sessionToJson(sessions[0]).model'), 'local');
assert.equal(evaluate('sessionToJson({ num: 1, data: { order: [], rounds: {}, totals: {} }, status: "fresh" }).model'), '');
const texts = roundText();
// The round renders the run's own data (the preview and result text of
// the fixture), in order. Section headers and labels are display
// wording.
assert.ok(texts.includes('RAW ls'), 'the preview text appears');
assert.ok(texts.includes('file.txt'), 'the result text appears');
assert.ok(texts.indexOf('RAW ls') < texts.indexOf('file.txt'), 'the preview renders before the result');

// A save from before evidence existed still restores the three arrays.
mem.clear();
const older = session();
delete older.data.rounds[1].evidence;
sandbox.fixture = older;
evaluate(`sessions = [fixture]; persist(); sessions = []; restoreResult = restore();`);
assert.equal(sandbox.restoreResult, true);
const olderText = roundText();
// The legacy save (no evidence array) still restores the three blocks:
// its preview and result data both render.
assert.ok(olderText.includes('RAW ls'), 'legacy preview data renders');
assert.ok(olderText.includes('file.txt'), 'legacy result data renders');

// Oversized tool text stays out of browser storage and is marked for history.
quota = true;
const huge = session();
huge.data.rounds[1].toolPreviews[0].output = 'RAW-TOO-BIG';
huge.data.rounds[1].evidence[1].output = 'RAW-TOO-BIG';
sandbox.fixture = huge;
evaluate(`sessions = [fixture]; persist();`);
const stored = mem.get('harness.tabs.v1');
assert.ok(!stored.includes('RAW-TOO-BIG'), stored.slice(0, 200));
const parsed = JSON.parse(stored);
assert.equal(parsed.tabs[0].toolsInHistory, true);
assert.equal(parsed.tabs[0].runId, 'run-7-1');
evaluate(`sessions = []; restoreResult = restore();`);
assert.equal(sandbox.restoreResult, true);
assert.equal(evaluate('sessions[0].toolsInHistory'), true);
assert.equal(roundText().includes('RAW-TOO-BIG'), false);

// The history row fills the tool text back into the restored tab.
(async () => {
    sandbox.apiFetch = async (url) => {
        assert.match(url, /\/history\/run-7-1$/);
        return {
            ok: true,
            json: async () => ({
                run: { comment_tag: 'abc123def456' },
                events: [
                    { type: 'tool_call', round: 1, payload: { name: 'run_cmd', arguments: { command: 'ls' } } },
                    { type: 'tool_preview', round: 1, payload: { name: 'run_cmd', output: 'from-history', duration_ms: 9 } },
                    { type: 'tool_result', round: 1, payload: { name: 'run_cmd', output: 'file.txt\n<abc123def456>keep</abc123def456>', duration_ms: 9 } },
                ],
            }),
        };
    };
    await evaluate('rehydrateTools(sessions[0])');
    const filled = roundText();
    assert.match(filled, /from-history/);
    assert.match(filled, /file\.txt/);
    assert.match(filled, /<user_comment>/);
    assert.equal(filled.includes('abc123def456'), false);
    assert.equal(evaluate('sessions[0].data.rounds[1].toolResults.some(item => String(item.output).includes("abc123def456"))'), true);
    assert.equal(evaluate('sessions[0].toolsInHistory'), false);
    assert.equal(evaluate('sessions[0].commentTag'), 'abc123def456');
    assert.equal(
        evaluate('maskCommentTags("files\\n<abc123def456>\\nkeep pngs\\n</abc123def456>", "abc123def456")'),
        'files\n<user_comment>\nkeep pngs\n</user_comment>'
    );
    assert.equal(evaluate('maskCommentTags("files", "")'), 'files');
    assert.equal(evaluate('maskCommentTags("files", "not-a-tag")'), 'files');
    assert.equal(evaluate('commentTagOf({ commentTag: "" })'), '');
    assert.equal(evaluate('commentTagOf({ commentTag: "abc123def456" })'), 'abc123def456');
    // The launch marker is 20 hex characters on this build; runs recorded
    // before the length change carry 12, so both replay their stored tag.
    // Near-miss lengths and non-hex text are not markers.
    assert.equal(evaluate('validCommentTag("0123456789abcdef0123")'), '0123456789abcdef0123');
    assert.equal(evaluate('validCommentTag("0123456789ABCDEF0123")'), '0123456789abcdef0123');
    assert.equal(evaluate('validCommentTag("abc123def456")'), 'abc123def456');
    assert.equal(evaluate('validCommentTag("0123456789abcdef012")'), '');
    assert.equal(evaluate('validCommentTag("0123456789abcdef01234")'), '');
    assert.equal(evaluate('validCommentTag("0123456789abcde")'), '');
    assert.equal(evaluate('validCommentTag("<user_comment>")'), '');
    assert.equal(
        evaluate('maskCommentTags("out\\n<0123456789abcdef0123>\\nkeep\\n</0123456789abcdef0123>", "0123456789abcdef0123")'),
        'out\n<user_comment>\nkeep\n</user_comment>'
    );
    evaluate('cachedConfig = { comment_tag: "abc123def456" }; fallbackTag = commentTagOf({});');
    assert.equal(sandbox.fallbackTag, 'abc123def456');
    const tagged = session({ commentTag: 'abc123def456' });
    tagged.data.rounds[1].toolResults[0].output = 'files\n<abc123def456>\nkeep pngs\n</abc123def456>';
    tagged.data.rounds[1].evidence[2].output = tagged.data.rounds[1].toolResults[0].output;
    tagged.data.rounds[1].thinking = 'see <abc123def456> and the rest of the thought';
    sandbox.fixture = tagged;
    evaluate('sessions = [fixture]; persist(); const saved = JSON.parse(localStorage.getItem("harness.tabs.v1")); savedTag = saved.tabs[0].commentTag; savedOutput = saved.tabs[0].data.rounds[1].toolResults[0].output; sessions = []; restore();');
    assert.equal(sandbox.savedTag, 'abc123def456');
    assert.equal(sandbox.savedOutput, 'files\n<abc123def456>\nkeep pngs\n</abc123def456>');
    assert.equal(evaluate('sessions[0].commentTag'), 'abc123def456');
    assert.equal(evaluate('sessions[0].data.rounds[1].toolResults[0].output'), 'files\n<abc123def456>\nkeep pngs\n</abc123def456>');
    const maskedText = roundText();
    assert.match(maskedText, /<user_comment>/);
    assert.equal(maskedText.includes('abc123def456'), false);
    const thinkingBody = evaluate('sessions[0].nodes.rounds.get(1).thinkingBody');
    assert.match(thinkingBody.textContent, /<user_comment> and the rest of the thought/);
    const commentClass = (el, found) => {
        if (!found) found = [];
        if (!el) return found;
        if (String(el.className || '').split(/\s+/).includes('user-comment')) found.push(el);
        for (const child of el.children || []) commentClass(child, found);
        return found;
    };
    assert.equal(commentClass(thinkingBody).length, 0);
    assert.ok(commentClass(evaluate('sessions[0].nodes.rounds.get(1).body')).length > 0);

    sandbox.applyHistoryGate({ history_recording: false, history_error: 'database path x is a symlink' });
    assert.match(document.getElementById('historyBanner').textContent, /symlink/);
    assert.equal(document.getElementById('unrecordedLabel').style.display, '');
    sandbox.applyHistoryGate({ history_recording: true, history_error: null });
    assert.equal(document.getElementById('historyBanner').style.display, 'none');
    assert.equal(document.getElementById('unrecordedLabel').style.display, 'none');
    evaluate(`historyBannerKind = 'interrupted'; document.getElementById('historyBanner').style.display = ''; document.getElementById('historyBanner').textContent = 'kept';`);
    sandbox.applyHistoryGate({ history_recording: true, history_error: null });
    assert.equal(document.getElementById('historyBanner').textContent, 'kept');
    assert.equal(document.getElementById('historyBanner').style.display, '');
    sandbox.applyHistoryGate({ history_recording: false, history_error: 'disk full' });
    assert.match(document.getElementById('historyBanner').textContent, /disk full/);
    assert.equal(typeof leaveListeners.pagehide, 'function');
    assert.equal(typeof leaveListeners.beforeunload, 'function');
    assert.equal(typeof leaveListeners.visibilitychange, 'function');
    evaluate('runningSid = "live"');
    const leaving = { preventDefault() { this.prevented = true; }, returnValue: undefined };
    leaveListeners.beforeunload(leaving);
    assert.equal(leaving.prevented, true);
    assert.match(String(leaving.returnValue), /history/);
    evaluate('runningSid = null');
    const idleLeave = { preventDefault() { this.prevented = true; }, returnValue: undefined };
    leaveListeners.beforeunload(idleLeave);
    assert.equal(idleLeave.prevented, undefined);
    document.visibilityState = 'hidden';
    leaveListeners.visibilitychange();

    const fetchCapture = JSON.stringify({
        stdout: 'page body',
        stderr: 'refused request: font\n',
        raw_body: '<html>secret-script-token</html>'
    });
    const submitted = JSON.stringify({ url: 'https://example.com', content: 'approved page' });
    const fetchSession = session({ id: 'tab-fetch', num: 4, runId: 'run-fetch-1' });
    fetchSession.data.rounds[1].toolCalls = [{ name: 'web_fetch', arguments: { url: 'https://example.com' } }];
    fetchSession.data.rounds[1].toolPreviews = [{ name: 'web_fetch', output: fetchCapture, duration_ms: 8 }];
    fetchSession.data.rounds[1].toolResults = [{ name: 'web_fetch', output: submitted, duration_ms: 8 }];
    fetchSession.data.rounds[1].evidence = [
        { kind: 'call', name: 'web_fetch', arguments: { url: 'https://example.com' } },
        { kind: 'preview', name: 'web_fetch', output: fetchCapture, duration_ms: 8 },
        { kind: 'result', name: 'web_fetch', output: submitted, duration_ms: 8 },
    ];
    sandbox.fixture = fetchSession;
    evaluate('sessions = [fixture]; persist(); sessions = []; restore();');
    evaluate(`function deepText(node) {
        let out = node.textContent || '';
        for (const child of (node.children || [])) out += '\\n' + deepText(child);
        return out;
    }
    fetchNodes = sessions[0].nodes.rounds.get(1).body.children;
    fetchPreview = fetchNodes.find(node => node.className && node.className.indexOf('tool-preview') >= 0);
    fetchResult = fetchNodes.find(node => node.className && node.className.indexOf('tool-result') >= 0);`);
    assert.match(evaluate('deepText(fetchPreview)'), /Captured text/);
    assert.match(evaluate('deepText(fetchPreview)'), /page body/);
    assert.match(evaluate('deepText(fetchPreview)'), /refused request: font/);
    assert.match(evaluate('deepText(fetchPreview)'), /secret-script-token/);
    assert.equal(evaluate('deepText(fetchPreview)').includes('"stderr"'), false);
    assert.equal(evaluate('fetchPreview.children[2].textContent'), 'page body');
    assert.equal(evaluate('fetchPreview.children[2].style.display'), '');
    assert.equal(evaluate('fetchPreview.children[3].style.display'), 'none');
    evaluate('fetchPreview.children[1].children[1].onclick()');
    assert.equal(evaluate('fetchPreview.children[3].style.display'), '');
    assert.match(evaluate('fetchPreview.children[3].textContent'), /refused request: font/);
    assert.match(evaluate('deepText(fetchResult)'), /Output/);
    assert.match(evaluate('deepText(fetchResult)'), /approved page/);
    assert.equal(evaluate('fetchResult.children[2].style.display'), '');
    assert.equal(evaluate('fetchResult.children[3].style.display'), 'none');
    evaluate(`handleEvent(sessions[0].id, { type: 'tool_preview', round: 2, name: 'web_fetch', output: ${JSON.stringify(fetchCapture)}, duration_ms: 3 }, false);
        handleEvent(sessions[0].id, { type: 'tool_result', round: 2, name: 'web_fetch', output: ${JSON.stringify(submitted)}, duration_ms: 3 }, false);
        replayNodes = sessions[0].nodes.rounds.get(2).body.children;
        replayPreview = replayNodes.find(node => node.className.indexOf('tool-preview') >= 0);
        replayResult = replayNodes.find(node => node.className.indexOf('tool-result') >= 0);`);
    assert.equal(evaluate('replayPreview.children[2].textContent'), 'page body');
    assert.match(evaluate('replayResult.children[2].textContent'), /approved page/);
    assert.equal(evaluate('replayResult.children[3].style.display'), 'none');
    assert.equal(evaluate(`previewContextText({ name: 'web_fetch', output: ${JSON.stringify(fetchCapture)} })`), 'page body');
    evaluate(`handleEvent(sessions[0].id, { type: 'tool_preview', round: 3, name: 'run_cmd', output: 'stdout:\\nok\\n', duration_ms: 4, exit_code: 3 }, false);
        handleEvent(sessions[0].id, { type: 'tool_result', round: 3, name: 'run_cmd', output: 'stdout:\\nok\\n', duration_ms: 4, exit_code: 0 }, false);
        handleEvent(sessions[0].id, { type: 'tool_result', round: 4, name: 'run_cmd', output: 'stdout:\\nok\\n', duration_ms: 4, exit_code: 7 }, true);
        histNodes = sessions[0].nodes.rounds.get(3).body.children;
        liveNodes = sessions[0].nodes.rounds.get(4).body.children;
        histNotes = histNodes.filter(node => node.className === 'metrics' && node.textContent.indexOf('exit code:') === 0).map(node => node.textContent);
        liveNotes = liveNodes.filter(node => node.className === 'metrics' && node.textContent.indexOf('exit code:') === 0);`);
    assert.equal(evaluate('histNotes.join("|")'), 'exit code: 3|exit code: 0');
    assert.equal(evaluate('histNodes.find(node => node.className.indexOf("tool-result") >= 0).textContent.includes("exit code:")'), false);
    assert.equal(evaluate('sessions[0].data.rounds[3].toolResults[0].output'), 'stdout:\nok\n');
    assert.equal(evaluate('liveNotes.length'), 0);
    const pageMem = new Map();
    sandbox.sessionStorage = {
        getItem: key => pageMem.has(key) ? pageMem.get(key) : null,
        setItem: (key, value) => { pageMem.set(key, String(value)); },
    };
    assert.equal(evaluate('sameTabResume("token-a")'), false);
    assert.equal(evaluate('sameTabResume("token-a")'), true);
    assert.equal(evaluate('sameTabResume("token-b")'), false);
    assert.equal(evaluate('sameTabResume("")'), false);
    evaluate(`sessions[0].data.rounds[1].toolPreviews.push({ name: 'run_sudo_cmd', output: 'RAW-ROOT-SECRET', provisional: true, duration_ms: 1 });
        sessions[0].data.rounds[1].evidence.push({ kind: 'preview', name: 'run_sudo_cmd', output: 'RAW-ROOT-SECRET', provisional: true, duration_ms: 1 });
        storeEnabled = true; persist();`);
    const sudoStored = mem.get('harness.tabs.v1');
    assert.ok(!sudoStored.includes('RAW-ROOT-SECRET'), 'provisional root output was persisted');
    const keptArchive = sandbox.archiveDoc([{
        num: 1, prompt: 'root',
        data: { totals: { prompt: 0, completion: 0 }, order: [1], rounds: {
            1: { toolPreviews: [{ name: 'run_sudo_cmd', output: 'uid=0', duration_ms: 1 }], toolCalls: [], toolResults: [] }
        } }
    }]);
    assert.match(keptArchive, /This file contains root output/);
    const withheldArchive = sandbox.archiveDoc([{
        num: 1, prompt: 'root',
        data: { totals: { prompt: 0, completion: 0 }, order: [1], rounds: {
            1: { toolPreviews: [{ name: 'run_sudo_cmd', output: 'Root output withheld from history by the reviewer.', duration_ms: 1 }], toolCalls: [], toolResults: [] }
        } }
    }]);
    assert.equal(withheldArchive.includes('This file contains root output'), false);
    console.log('storage restore and history gate tests passed');
})().catch((error) => { console.error(error); process.exit(1); });
