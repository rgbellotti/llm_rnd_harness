// Test tab frontend: the manual allowlist, the write_file field
// controls, and the array-field parsing. Behavior and data only,
// never display wording.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
    constructor(tag) { this.tag = tag; this.style = {}; this.children = []; this.value = ''; this.dataset = {}; this.placeholder = ''; this._listeners = {}; this._id = ''; }
    get id() { return this._id; }
    set id(value) {
        const next = value == null ? '' : String(value);
        if (next === this._id) return;
        if (this._id && elements.get(this._id) === this) elements.delete(this._id);
        this._id = next;
        if (next) elements.set(next, this);
    }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { this.children.push(...children); }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(name, fn) { (this._listeners[name] = this._listeners[name] || []).push(fn); }
    set innerHTML(value) { this.children = []; }
    querySelector(selector) {
        const tag = selector.replace(/^\./, '');
        for (const child of this.children) {
            if (child.tag === tag || String(child.className || '').split(/\s+/).includes(tag)) return child;
            const nested = child.querySelector && child.querySelector(selector);
            if (nested) return nested;
        }
        return null;
    }
}
const elements = new Map();
const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element('div')); return elements.get(id); },
    createElement(tag) { return new Element(tag); }
};
const sandbox = { document, cachedConfig: null, apiFetch: async () => { throw new Error('no fetch in this test'); } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(__dirname + '/tooltest.js', 'utf8'), sandbox);
const evaluate = code => vm.runInContext(code, sandbox);

// The manual allowlist mirrors the server's: the reviewable tools and
// the corpus searches, never the shell tools.
sandbox.cachedConfig = { tools: [
    { function: { name: 'run_cmd' } },
    { function: { name: 'run_sudo_cmd' } },
    { function: { name: 'web_fetch' } },
    { function: { name: 'web_search' } },
    { function: { name: 'read_pdf' } },
    { function: { name: 'write_file' } },
    { function: { name: 'fixtrail_search' } },
] };
const names = evaluate('testableTools().map(t => t.function.name)');
assert.deepEqual(names.sort(), ['fixtrail_search', 'read_pdf', 'web_fetch', 'web_search', 'write_file']);
assert.ok(!names.includes('run_cmd'), 'shell tools stay out of manual testing');
assert.ok(!names.includes('run_sudo_cmd'), 'shell tools stay out of manual testing');

// write_file's schema fields render as the right control kinds:
// enum -> select with the enum values, content -> textarea,
// edits -> textarea, path -> text input.
const tags = name => evaluate(`fieldForProperty(${JSON.stringify(name)}, ${JSON.stringify(specs[name])}).children.map(c => c.tag)`);
const specs = {
    mode: { type: 'string', enum: ['write', 'edit'] },
    content: { type: 'string', description: 'the complete file text' },
    edits: { type: 'array', items: { type: 'object' } },
    path: { type: 'string' },
};
assert.ok(tags('mode').includes('select'), 'mode renders as a select');
const options = evaluate(`(() => {
    const f = fieldForProperty('mode', { type: 'string', enum: ['write', 'edit'] });
    const sel = f.children.find(c => c.tag === 'select');
    return sel.children.map(o => o.value);
})()`);
assert.deepEqual(options, ['write', 'edit'], 'mode offers write and edit');
assert.ok(tags('content').includes('textarea'), 'content renders as a textarea');
assert.ok(tags('edits').includes('textarea'), 'edits renders as a textarea');
assert.ok(tags('path').includes('input'), 'path renders as a text input');

// The array field parses JSON for the request, leaves empty out, and
// rejects invalid JSON with the field named in the error. (Field-by-
// field: deepStrictEqual is realm-sensitive across the vm boundary.)
const parsed = evaluate(`parseArrayField('edits', '[{"search":"a","replace":"b"}]')`);
assert.equal(parsed.length, 1);
assert.equal(parsed[0].search, 'a');
assert.equal(parsed[0].replace, 'b');
assert.equal(evaluate(`parseArrayField('edits', '')`), undefined);
assert.throws(() => evaluate(`parseArrayField('edits', 'not json')`), /edits is not valid JSON/);

// The form opens on web_fetch when it is testable, else on the first
// testable tool.
assert.equal(evaluate('defaultTestableTool(testableTools())'), 'web_fetch');
sandbox.cachedConfig = { tools: [
    { function: { name: 'web_search' } },
    { function: { name: 'read_pdf' } },
] };
assert.equal(evaluate('defaultTestableTool(testableTools())'), 'web_search');

// write_file's path field opens prefilled with the workspace directory,
// normalized to one trailing separator. The prefill is write_file's
// alone, and a value saved earlier in the visit wins over it.
sandbox.cachedConfig = { workspace_dir: '/proj/root//' };
evaluate('toolTestState.tool = "write_file"; toolTestState.values = {}');
const pathWrap = evaluate('fieldForProperty("path", { type: "string" })');
assert.equal(pathWrap.children[1].value, '/proj/root/');
evaluate('toolTestState.tool = "read_pdf"; toolTestState.values = {}');
const pdfPath = evaluate('fieldForProperty("path", { type: "string" })');
assert.equal(pdfPath.children[1].value, '');
evaluate('toolTestState.tool = "write_file"; toolTestState.values = { path: "kept.txt" }');
const kept = evaluate('fieldForProperty("path", { type: "string" })');
assert.equal(kept.children[1].value, 'kept.txt');

// The dedicated diagnostics panel uses the existing raw execution JSON.
// Browser stderr is shown even on exit 0 because refused subresources can
// explain a page with missing content; a quiet successful run has no panel.
const diagnostic = raw => evaluate('toolTestDiagnostics(' + JSON.stringify({ tool: 'web_fetch', raw: JSON.stringify(raw) }) + ')');
assert.equal(
    diagnostic({ stdout: '', stderr: 'fetch failed: net::ERR_CONNECTION_RESET', exit_code: 1 }),
    'fetch failed: net::ERR_CONNECTION_RESET\nexit code: 1'
);
assert.equal(
    diagnostic({ stdout: 'Hello', stderr: 'refused websocket: wss://example.com', exit_code: 0 }),
    'refused websocket: wss://example.com'
);
assert.equal(diagnostic({ stdout: 'Hello', stderr: '', exit_code: 0 }), '');
assert.equal(diagnostic({ stdout: '', stderr: '', exit_code: null }), 'exit code: unavailable');
assert.equal(evaluate('toolTestDiagnostics({ error: "provide one HTTP(S) url" })'), 'provide one HTTP(S) url');
assert.equal(evaluate('toolTestDiagnostics({ raw: "not json" })'), '');
assert.equal(evaluate('toolTestDiagnostics({ tool: "web_search", raw: ' + JSON.stringify(JSON.stringify({ stderr: 'search failed', exit_code: 1 })) + ' })'), '');

const descendants = (node, predicate) => {
    const found = [];
    for (const child of node.children || []) {
        if (predicate(child)) found.push(child);
        found.push(...descendants(child, predicate));
    }
    return found;
};

(async () => {
    sandbox.cachedConfig = { tools: [{ function: {
        name: 'web_fetch',
        parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
    } }] };
    evaluate('toolTestState = { tool: "web_fetch", values: {} }; renderToolTest()');
    const view = elements.get('toolTestView');
    const panel = descendants(view, node => node.id === 'tt-diagnostics')[0];
    const panelText = descendants(view, node => node.id === 'tt-diagnostics-text')[0];
    const run = descendants(view, node => node.tag === 'button' && node.textContent === 'Run tool')[0];
    const url = descendants(view, node => node.id === 'tt-url')[0];
    assert.ok(panel && panelText && run && url, 'manual test renders the result and diagnostics controls');
    assert.equal(panel.hidden, true, 'no empty diagnostics box before a run');
    url.value = 'https://example.com/';

    sandbox.apiFetch = async () => ({
        ok: true,
        json: async () => ({
            tool: 'web_fetch',
            preview: 'Web fetch returned no page text.',
            raw: JSON.stringify({ stdout: '', stderr: 'fetch failed: connection reset', exit_code: 1 }),
        }),
    });
    await run._listeners.click[0]();
    assert.equal(panel.hidden, false, 'failed fetch reveals diagnostics');
    assert.equal(panelText.textContent, 'fetch failed: connection reset\nexit code: 1');

    let release;
    sandbox.apiFetch = () => new Promise(resolve => { release = resolve; });
    const pending = run._listeners.click[0]();
    assert.equal(panel.hidden, true, 'starting the next fetch clears stale diagnostics immediately');
    assert.equal(panelText.textContent, '');
    release({
        ok: true,
        json: async () => ({
            tool: 'web_fetch',
            preview: 'Hello',
            raw: JSON.stringify({ stdout: 'Hello', stderr: '', exit_code: 0 }),
        }),
    });
    await pending;
    assert.equal(panel.hidden, true, 'quiet successful fetch leaves diagnostics hidden');

    sandbox.apiFetch = async () => ({ ok: false, statusText: 'Bad Request', json: async () => ({ tool: 'web_fetch', error: 'provide one HTTP(S) url' }) });
    await run._listeners.click[0]();
    assert.equal(panel.hidden, false, 'request-level errors use the same panel');
    assert.equal(panelText.textContent, 'Error: provide one HTTP(S) url');

    console.log('== tooltest.test.js ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
