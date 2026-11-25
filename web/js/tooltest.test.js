// Test tab frontend: the manual allowlist, the write_file field
// controls, and the array-field parsing. Behavior and data only,
// never display wording.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
    constructor(tag) { this.tag = tag; this.style = {}; this.children = []; this.value = ''; this.dataset = {}; this.placeholder = ''; }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { this.children.push(...children); }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(_name, _fn) {}
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

console.log('== tooltest.test.js ok');
