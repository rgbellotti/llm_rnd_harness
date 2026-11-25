const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
    constructor(tag) {
        this.tagName = tag;
        this.style = {};
        this.children = [];
        this.parentNode = null;
        this.className = '';
        this._text = '';
        this.value = '';
        this.classList = {
            toggle: (name, force) => {
                const names = String(this.className || '').split(/\s+/).filter(Boolean);
                const has = names.includes(name);
                const on = force === undefined ? !has : !!force;
                const next = names.filter(part => part !== name);
                if (on) next.push(name);
                this.className = next.join(' ');
            },
            contains: (name) => String(this.className || '').split(/\s+/).includes(name)
        };
    }
    get textContent() {
        if (this.children.length) return this.children.map(child => child.textContent || '').join('');
        return this._text;
    }
    set textContent(value) {
        this._text = value == null ? '' : String(value);
        this.children = [];
    }
    appendChild(child) {
        if (child && child.parentNode && child.parentNode !== this && typeof child.parentNode.removeChild === 'function') {
            child.parentNode.removeChild(child);
        }
        if (child) child.parentNode = this;
        this.children.push(child);
        return child;
    }
    removeChild(child) {
        const index = this.children.indexOf(child);
        if (index >= 0) this.children.splice(index, 1);
        if (child) child.parentNode = null;
        return child;
    }
    remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
    }
    replaceChildren(...nodes) {
        this.children = [];
        for (const node of nodes) this.appendChild(node);
    }
    querySelector(selector) {
        const want = String(selector || '').replace(/^\./, '');
        const walk = node => {
            for (const child of node.children || []) {
                const names = String(child.className || '').split(/\s+/);
                if (names.includes(want)) return child;
                const found = walk(child);
                if (found) return found;
            }
            return null;
        };
        return walk(this);
    }
    cloneNode(deep) {
        const copy = new Element(this.tagName);
        copy.className = this.className;
        copy._text = this._text;
        copy.style = Object.assign({}, this.style);
        if (deep) {
            for (const child of this.children) copy.appendChild(child.cloneNode(true));
        }
        return copy;
    }
    setAttribute() {}
}

const elements = new Map();
const document = {
    getElementById(id) {
        if (!elements.has(id)) elements.set(id, new Element('div'));
        return elements.get(id);
    },
    createElement(tag) { return new Element(tag); },
    querySelector() { return null; },
    body: new Element('body'),
    documentElement: new Element('html'),
};
const sandbox = {
    document,
    WeakMap,
    Uint32Array,
    Map,
    JSON,
    Math,
    Object,
    Array,
    String,
    Number,
    Error,
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout() {},
    window: { innerHeight: 800, scrollY: 0, scrollTo() {} },
    setActivityIcon() {},
    setStatus() {},
    fetch: async () => ({ ok: true, text: async () => '' }),
};
vm.createContext(sandbox);
const load = name => vm.runInContext(fs.readFileSync(__dirname + '/' + name, 'utf8'), sandbox);
const evaluate = code => vm.runInContext(code, sandbox);
load('core.js');

function lineOps(before, after) {
    return evaluate(
        'diffLines(' + JSON.stringify(before) + ', ' + JSON.stringify(after) + ')'
        + '.map(op => op.op + ":" + op.line).join("\\n")'
    );
}

assert.equal(
    lineOps('The filename is sample.txt', 'The filename is sample.md'),
    'del:The filename is sample.txt\nadd:The filename is sample.md'
);
assert.equal(lineOps('same\nstill', 'same\nstill'), 'eq:same\neq:still');
assert.equal(
    lineOps('keep\nThe filename is sample.txt\nend', 'keep\nThe filename is sample.md\nend'),
    'eq:keep\ndel:The filename is sample.txt\nadd:The filename is sample.md\neq:end'
);
assert.equal(
    lineOps(
        'The location is Ohio.\nThe date is Mar 10.\nThe theme is Spring.',
        'The location is Ohio.\nThe date is March 10.\nThe theme is Spring.'
    ),
    'eq:The location is Ohio.\ndel:The date is Mar 10.\nadd:The date is March 10.\neq:The theme is Spring.'
);
const wide = Array.from({ length: 1201 }, () => 'x').join('\n');
assert.equal(evaluate('diffLines(' + JSON.stringify(wide) + ', ' + JSON.stringify(wide + '\ny') + ')'), null);

const sample = new Element('div');
sandbox.renderLineDiff(sample, 'The filename is sample.txt', 'The filename is sample.md');
assert.equal(sample.children[0].className, 'diff-line diff-del');
assert.equal(sample.children[0].textContent, 'The filename is sample.txt');
assert.equal(sample.children[1].className, 'diff-line diff-add');
assert.equal(sample.children[1].textContent, 'The filename is sample.md');
const place = new Element('div');
sandbox.renderLineDiff(
    place,
    'The location is Ohio.\nThe date is Mar 10.\nThe theme is Spring.',
    'The location is Ohio.\nThe date is March 10.\nThe theme is Spring.'
);
assert.equal(
    place.children.map(node => node.className + '|' + node.textContent).join('\n'),
    [
        'diff-line|The location is Ohio.',
        'diff-line diff-del|The date is Mar 10.',
        'diff-line diff-add|The date is March 10.',
        'diff-line|The theme is Spring.'
    ].join('\n')
);
const added = new Element('div');
sandbox.renderLineDiff(added, '', 'new instructions');
assert.equal(added.children.length, 1);
assert.equal(added.children[0].className, 'diff-line diff-add');
assert.equal(added.children[0].textContent, 'new instructions');
const huge = new Element('div');
sandbox.renderLineDiff(huge, wide, wide + '\nextra');
assert.match(huge.children[0].textContent, /too large to mark line by line/);
assert.equal(huge.children[1].textContent, wide + '\nextra');

const structured = new Element('div');
sandbox.renderStructuredDiff(structured, {
    added: 1,
    removed: 1,
    lines: [
        { op: 'equal', text: 'keep' },
        { op: 'equal', skipped: 12 },
        {
            op: 'delete',
            text: 'cargo test && cargo clippy',
            spans: [
                { op: 'equal', text: 'cargo test && cargo ' },
                { op: 'delete', text: 'clippy' }
            ]
        },
        {
            op: 'insert',
            text: 'cargo test && cargo fmt',
            spans: [
                { op: 'equal', text: 'cargo test && cargo ' },
                { op: 'insert', text: 'fmt' }
            ]
        }
    ]
});
assert.equal(structured.children[0].className, 'diff-line');
assert.equal(structured.children[0].textContent, 'keep');
assert.equal(structured.children[1].className, 'diff-skip');
assert.equal(structured.children[1].textContent, '… 12 unchanged lines …');
assert.equal(structured.children[2].className, 'diff-line diff-del');
assert.equal(structured.children[2].textContent, 'cargo test && cargo clippy');
assert.equal(structured.children[2].children[1].className, 'diff-inline');
assert.equal(structured.children[2].children[1].textContent, 'clippy');
assert.equal(structured.children[3].children[1].textContent, 'fmt');
assert.equal(structured.children[3].className, 'diff-line diff-add');
const hostile = new Element('div');
sandbox.renderStructuredDiff(hostile, {
    added: 1,
    removed: 0,
    note: 'file <script>alert(1)</script>',
    lines: [{ op: 'insert', text: '<img onerror="alert(1)"> \u202Asafe' }]
});
assert.equal(hostile.children[0].textContent, 'file <script>alert(1)</script>');
assert.equal(hostile.children[1].textContent, '<img onerror="alert(1)"> \\u202asafe');
assert.equal(hostile.innerHTML, undefined);
evaluate(`
    clipped = { toolCalls: [{ name: 'run_cmd', arguments: { command: 'printf model-ok', timeout: '30s' } }] };
    noteHistoryApproval(clipped, {
        decision: 'approve', tool: 'run_cmd', command_timeout: 'none',
        command: 'echo one\\necho two\\necho three\\necho four\\necho five',
        edit_diffs: [
            { summary: '+5/-1 - printf model-ok + echo one + echo two …', added: 5, removed: 1 },
            { summary: '+1/-1 - Timeout: 30s + Timeout: none', added: 1, removed: 1 }
        ]
    });
`);
assert.equal(
    evaluate('roundEditListings(clipped).join("|")'),
    '+5/-1 - printf model-ok + echo one + echo two …|+1/-1 - Timeout: 30s + Timeout: none'
);

const noted = new Element('div');
sandbox.renderLineDiff(
    noted,
    'The location is Ohio.\nSocial\nThe theme is Spring.',
    'The location is Ohio.\nSocial Contacts\nThe theme is Spring.\n<user_comment>\nchanged Social\n</user_comment>'
);
assert.equal(
    noted.children.map(node => {
        const kind = String(node.className).includes('diff-del') ? 'del'
            : String(node.className).includes('diff-add') ? 'add' : 'eq';
        return kind + ':' + node.textContent;
    }).join('\n'),
    [
        'eq:The location is Ohio.',
        'del:Social',
        'add:Social Contacts',
        'eq:The theme is Spring.',
        'add:<user_comment>',
        'add:changed Social',
        'add:</user_comment>'
    ].join('\n')
);
function commentMarks(node) {
    const found = [];
    const walk = current => {
        if (!current) return;
        if (String(current.className || '').split(/\s+/).includes('user-comment')) found.push(current);
        for (const child of current.children || []) walk(child);
    };
    walk(node);
    return found;
}
assert.deepEqual(commentMarks(noted.children[4]).map(node => node.textContent), ['<user_comment>']);
assert.deepEqual(commentMarks(noted.children[5]).map(node => node.textContent), ['changed Social']);
assert.deepEqual(commentMarks(noted.children[6]).map(node => node.textContent), ['</user_comment>']);
assert.equal(commentMarks(noted.children[0]).length, 0);
const inline = new Element('div');
sandbox.renderLineDiff(inline, 'keep', 'keep <user_comment>note</user_comment> tail');
assert.equal(inline.children[1].textContent, 'keep <user_comment>note</user_comment> tail');
assert.deepEqual(commentMarks(inline.children[1]).map(node => node.textContent), ['<user_comment>note</user_comment>']);
const plainNote = new Element('div');
sandbox.fillCommented(plainNote, 'files\n<user_comment>\nkeep pngs\n</user_comment>');
assert.equal(plainNote.textContent, 'files\n<user_comment>\nkeep pngs\n</user_comment>');
assert.deepEqual(commentMarks(plainNote).map(node => node.textContent), ['<user_comment>\nkeep pngs\n</user_comment>']);

assert.equal(
    evaluate('reviewableToolText("web_fetch", JSON.stringify({ stdout: "page", stderr: "" }))'),
    'page'
);
assert.equal(
    evaluate('reviewableToolText("web_fetch", JSON.stringify({ stdout: "  ", stderr: "" }))'),
    'Web fetch returned no page text.'
);
assert.equal(
    evaluate('reviewableToolText("run_cmd", JSON.stringify({ stdout: "hidden" }))'),
    '{"stdout":"hidden"}'
);
assert.equal(
    evaluate('reviewableToolText("web_search", JSON.stringify({ stdout: "hits", stderr: "boom", exit_code: 1 }))'),
    'hits\nstderr:\nboom'
);
assert.equal(
    evaluate('reviewableToolText("web_search", JSON.stringify({ stdout: "", stderr: "boom", exit_code: 1 }))'),
    'Web tool retrieval failed.\nstderr:\nboom\nexit code: Some(1)'
);
assert.equal(
    evaluate('reviewableToolText("web_search", JSON.stringify({ stdout: "", stderr: "boom", exit_code: null }))'),
    'Web tool retrieval failed.\nstderr:\nboom\nexit code: None'
);
assert.equal(
    evaluate('reviewableToolText("web_search", JSON.stringify({ stdout: "", stderr: "", exit_code: 0 }))'),
    'Web tool returned no content.'
);
assert.equal(
    evaluate('submittedReviewText("web_fetch", JSON.stringify({ url: "https://example.com", content: "Social\\nSpring" }))'),
    'Social\nSpring'
);
assert.equal(
    evaluate('submittedReviewText("web_search", JSON.stringify({ query: "q", max_results: 5, results: "hit one\\nhit two" }))'),
    'hit one\nhit two'
);
assert.equal(
    evaluate('submittedReviewText("read_pdf", JSON.stringify({ path: "a.pdf", content: "page" }))'),
    'page'
);
assert.equal(
    evaluate('submittedReviewText("docs_search", JSON.stringify({ query: "q", content: "chunk" }))'),
    'chunk'
);
assert.equal(
    evaluate('submittedReviewText("run_cmd", JSON.stringify({ content: "nope" }))'),
    '{"content":"nope"}'
);
assert.equal(evaluate('submittedReviewText("web_fetch", "plain page")'), 'plain page');
evaluate(`
    fetchPlan = historyResultPlan(
        { toolPreviews: [{ name: 'web_fetch', output: JSON.stringify({ stdout: 'Social\\nSpring', stderr: '' }) }] },
        { name: 'web_fetch', output: JSON.stringify({ url: 'https://example.com', content: 'Social Contacts\\nSpring' }) }
    );
    fetchSame = historyResultPlan(
        { toolPreviews: [{ name: 'web_fetch', output: JSON.stringify({ stdout: 'page body', stderr: '' }) }] },
        { name: 'web_fetch', output: JSON.stringify({ url: 'https://example.com', content: 'page body' }) }
    );
`);
assert.equal(evaluate('fetchPlan.edited'), true);
assert.equal(evaluate('fetchPlan.source'), 'Social\nSpring');
assert.equal(evaluate('fetchPlan.submitted'), 'Social Contacts\nSpring');
assert.equal(evaluate('fetchSame.suppress'), true);
assert.equal(evaluate('fetchSame.edited'), false);

evaluate(`
    samePlan = historyResultPlan(
        { toolPreviews: [{ name: 'run_cmd', output: 'The filename is sample.txt' }] },
        { name: 'run_cmd', output: 'The filename is sample.txt' }
    );
    editData = { toolPreviews: [{ name: 'run_cmd', output: 'The filename is sample.txt' }] };
    editPlan = historyResultPlan(editData, { name: 'run_cmd', output: 'The filename is sample.md' });
    bareData = { redirectArmed: 1, toolPreviews: [] };
    barePlan = historyResultPlan(bareData, { name: 'run_cmd', output: 'updated instructions' });
    bothData = { redirectArmed: 1, toolPreviews: [{ name: 'run_cmd', output: 'old' }] };
    bothPlan = historyResultPlan(bothData, { name: 'run_cmd', output: 'new' });
`);
assert.equal(evaluate('samePlan.suppress'), true);
assert.equal(evaluate('samePlan.edited'), false);
assert.equal(evaluate('editPlan.edited'), true);
assert.equal(evaluate('editPlan.suppress'), false);
assert.equal(evaluate('editPlan.source'), 'The filename is sample.txt');
assert.equal(evaluate('editData.toolPreviews[0].outputEdited'), true);
assert.equal(evaluate('barePlan.edited'), true);
assert.equal(evaluate('barePlan.source'), '');
assert.equal(evaluate('bareData.bareRedirects'), 1);
assert.equal(evaluate('bothPlan.edited'), true);
assert.equal(evaluate('bothData.bareRedirects || 0'), 0);
assert.equal(evaluate('bothData.toolPreviews[0].outputEdited'), true);

evaluate(`
    changed = { toolCalls: [{ name: 'run_cmd', arguments: { command: 'ls', timeout: '30s' } }] };
    changedCall = noteHistoryApproval(changed, { decision: 'approve', tool: 'run_cmd', command_timeout: 'none' });
    kept = { toolCalls: [{ name: 'run_cmd', arguments: { command: 'ls' } }] };
    keptCall = noteHistoryApproval(kept, { decision: 'approve', tool: 'run_cmd', command_timeout: 'none' });
`);
assert.equal(evaluate('changedCall.limitEdited'), true);
assert.equal(evaluate('changedCall.chosenTimeout'), 'none');
assert.equal(evaluate('keptCall'), null);
assert.equal(evaluate('!!kept.toolCalls[0].limitEdited'), false);
assert.equal(evaluate('kept.toolCalls[0].limitNoted'), true);
evaluate(`
    swapped = { toolCalls: [{ name: 'run_cmd', arguments: { command: 'printf model-ok', task: 'printing the model command' } }] };
    swappedCall = noteHistoryApproval(swapped, { decision: 'approve', tool: 'run_cmd', command_timeout: 'none', command: 'printf person-ok', note: 'narrower check' });
    sameCommand = { toolCalls: [{ name: 'run_cmd', arguments: { command: 'printf model-ok' } }] };
    sameCommandCall = noteHistoryApproval(sameCommand, { decision: 'approve', tool: 'run_cmd', command: 'printf model-ok', note: 'same command' });
`);
assert.equal(evaluate('swappedCall.commandEdited'), true);
assert.equal(evaluate('swappedCall.chosenCommand'), 'printf person-ok');
assert.equal(evaluate('!!swappedCall.limitEdited'), false);
assert.equal(evaluate('sameCommandCall'), null);
assert.equal(evaluate('sameCommand.toolCalls[0].limitNoted'), true);
assert.equal(evaluate('!!sameCommand.toolCalls[0].commandEdited'), false);
assert.equal(evaluate('roundEditCount({ toolCalls: [{ limitEdited: true, commandEdited: true }] })'), 1);
assert.equal(
    evaluate(`roundToolSummaryGroups({ toolCalls: [
        { name: 'run_cmd' }, { name: 'web_search' }, { name: 'run_cmd' }
    ] }).map(group => group.label).join('|')`),
    'run_cmd: 2|web_search: 1|edits: 0'
);
assert.equal(
    evaluate(`roundToolSummaryGroups({ toolCalls: [
        { name: 'run_cmd', arguments: { task: 'listing files' } },
        { name: 'web_search', arguments: { query: 'sample' } },
        { name: 'run_cmd', arguments: { task: ' compiling\\nthe driver ' } }
    ] }).map(item => item.label + '=' + (item.tasks ? item.tasks.join('/') : '-')).join('|')`),
    'run_cmd: 2=listing files/compiling the driver|web_search: 1=sample|edits: 0=-'
);
assert.equal(
    evaluate(`roundToolSummaryGroups({ toolCalls: [
        { name: 'web_fetch', arguments: { url: 'https://example.com/a' } },
        { name: 'read_pdf', arguments: { path: '/tmp/docs/spec.pdf' } },
        { name: 'ask_user', arguments: { questions: [{ question: 'Which file?' }, { question: '  Continue? ' }] } },
        { name: 'godot_docs_search', arguments: { query: 'TileMap' } }
    ] }).map(item => item.label + '=' + (item.tasks ? item.tasks.join('/') : '-')).join('|')`),
    'web_fetch: 1=https://example.com/a|read_pdf: 1=spec.pdf|ask_user: 1=Which file?/Continue?|godot_docs_search: 1=TileMap|edits: 0=-'
);
assert.equal(
    evaluate(`roundMetaLines({
        model: 'grok-4.7', prompt_tokens: 3, completion_tokens: 4,
        reasoning_tokens: 1, cached_tokens: 2, reasoning_effort: 'high',
        cost_usd: 0.0123, total_ms: 10, load_ms: 1, prompt_eval_ms: 2, eval_ms: 3, tps: 4
    }, { totals: { prompt: 9, completion: 8 }, wallMs: 1500, doneInfo: { rounds: 2, max_rounds_hit: true } }).join('|')`),
    'model: grok-4.7|tokens: prompt 3 / completion 4 / reasoning 1|cached: 2|effort: high|cost: $0.0123|total: 10.0ms|load: 1.0ms|prompt_eval: 2.0ms|eval: 3.0ms|4.0 tok/s|session tokens: 9 prompt + 8 completion|wall: 1.50s|rounds: 2|reached max tool rounds'
);
assert.equal(evaluate('roundMetaLines(null, { totals: { prompt: 0, completion: 0 } }).length'), 0);
assert.equal(evaluate('roundToolSummaryGroups({ bareRedirects: 1 }).map(group => group.label).join("|")'), 'edits: 1');
assert.equal(evaluate('roundToolSummaryGroups({ toolCalls: [] }).length'), 0);
assert.equal(evaluate('editListing("")'), '(0 lines)');
assert.equal(evaluate('editListing("printf person-ok")'), '(1 line) printf person-ok');
assert.equal(evaluate('editListing("hello\\n")'), '(1 line) hello');
assert.equal(evaluate('editListing("echo one\\necho two\\necho three\\necho four\\necho five")'), '(5 lines) echo one...');
assert.equal(evaluate('editListing("abcdefghijklmnopqrstuvwxyz0123")'), '(1 line) abcdefghijklmnopqrstuvwxyz0123');
assert.equal(evaluate('editListing("abcdefghijklmnopqrstuvwxyz01234")'), '(1 line) abcdefghijklmnopqrstuvwxyz0123...');
assert.equal(
    evaluate('editListing("abcdefghijklmnopqrstuvwxyz0123\\nmore")'),
    '(2 lines) abcdefghijklmnopqrstuvwxyz0123...'
);
assert.equal(evaluate('editListing("😀".repeat(31))'), '(1 line) ' + '😀'.repeat(30) + '...');
assert.equal(evaluate('editListing("\\nsecond")'), '(2 lines) second...');
assert.equal(evaluate('editListing("\\n\\n   \\nhello there")'), '(4 lines) hello there...');
assert.equal(evaluate('editListing("   \\nhello")'), '(2 lines) hello...');
assert.equal(evaluate('editListing("   hello")'), '(1 line)    hello');
assert.equal(
    evaluate('editListing("\\n\\n" + "abcdefghijklmnopqrstuvwxyz0123456789")'),
    '(3 lines) abcdefghijklmnopqrstuvwxyz0123...'
);
assert.equal(evaluate('editListing("\\n   ")'), '(2 lines) ...');
evaluate(`
    listed = { toolCalls: [{ name: 'run_cmd', arguments: { command: 'printf model-ok', timeout: '30s', task: 'printing' } }] };
    noteHistoryApproval(listed, { decision: 'approve', tool: 'run_cmd', command_timeout: 'none', command: 'echo one\\necho two\\necho three\\necho four\\necho five' });
`);
assert.equal(
    evaluate('roundEditListings(listed).join("|")'),
    '(5 lines) echo one...|(1 line) Timeout: none'
);
assert.equal(
    evaluate(`roundToolSummaryGroups(listed).map(item => item.label + '=' + (item.tasks ? item.tasks.join('/') : '-')).join('|')`),
    'run_cmd: 1=printing|edits: 1=(5 lines) echo one.../(1 line) Timeout: none'
);
evaluate(`
    pageEdit = { toolPreviews: [{ name: 'run_cmd', output: 'The filename is sample.txt' }] };
    historyResultPlan(pageEdit, { name: 'run_cmd', output: 'The filename is sample.md' });
    bareListed = { redirectArmed: 1, toolPreviews: [] };
    historyResultPlan(bareListed, { name: 'run_cmd', output: 'updated instructions' });
    onlyLimit = { toolCalls: [{ name: 'run_cmd', arguments: { command: 'ls', timeout: '30s' } }] };
    noteHistoryApproval(onlyLimit, { decision: 'approve', tool: 'run_cmd', command_timeout: 'none' });
`);
assert.equal(evaluate('roundEditListings(pageEdit).join("|")'), '(1 line) The filename is sample.md');
assert.equal(evaluate('roundEditListings(bareListed).join("|")'), '(1 line) updated instructions');
assert.equal(evaluate('roundEditListings(onlyLimit).join("|")'), '(1 line) Timeout: none');
assert.equal(
    evaluate(`roundToolSummaryGroups({ bareRedirects: 1 }).map(item => item.label + '=' + (item.tasks ? item.tasks.join('/') : '-')).join('|')`),
    'edits: 1=No edit recorded.'
);

load('rounds.js');
load('stream.js');

function mount(key, historyView) {
    sandbox[key] = {
        id: key,
        historyView: !!historyView,
        nodes: { container: new Element('div'), rounds: new Map() },
        data: { rounds: {}, order: [], totals: { prompt: 0, completion: 0 } },
    };
    evaluate('sessions.push(' + key + ')');
    return sandbox[key];
}
function replay(id, ev) {
    sandbox.handleEvent(id, ev, false);
}
function withClass(root, name) {
    const found = [];
    const walk = node => {
        if (!node) return;
        const names = String(node.className || '').split(/\s+/);
        if (names.includes(name)) found.push(node);
        for (const child of node.children || []) walk(child);
    };
    walk(root);
    return found;
}

const same = mount('histSame', true);
replay('histSame', { type: 'tool_call', round: 1, name: 'run_cmd', arguments: { command: 'printf sample', task: 'printing a name' } });
replay('histSame', { type: 'tool_preview', round: 1, name: 'run_cmd', output: 'The filename is sample.txt', duration_ms: 4, exit_code: 0 });
replay('histSame', { type: 'tool_result', round: 1, name: 'run_cmd', output: 'The filename is sample.txt', duration_ms: 4 });
const sameBody = same.nodes.rounds.get(1).body;
assert.equal(withClass(sameBody, 'tool-preview').length, 0);
assert.equal(withClass(sameBody, 'tool-result').length, 1);
assert.match(withClass(sameBody, 'tool-result')[0].textContent, /TOOL RESULT \(4 ms\)/);
assert.match(withClass(sameBody, 'tool-result')[0].textContent, /The filename is sample\.txt/);
assert.equal(withClass(sameBody, 'diff-del').length, 0);
const sameNotes = withClass(sameBody, 'metrics').map(node => node.textContent);
assert.deepEqual(sameNotes, ['exit code: 0']);

const edited = mount('histEdit', true);
replay('histEdit', { type: 'tool_preview', round: 1, name: 'run_cmd', output: 'The filename is sample.txt', duration_ms: 5, exit_code: 0 });
replay('histEdit', { type: 'tool_result', round: 1, name: 'run_cmd', output: 'The filename is sample.md', duration_ms: 5, exit_code: 0 });
const editBody = edited.nodes.rounds.get(1).body;
assert.equal(withClass(editBody, 'tool-preview').length, 0);
assert.equal(withClass(editBody, 'tool-result').length, 1);
const result = withClass(editBody, 'tool-result')[0];
assert.match(result.textContent, /TOOL RESULT \(5 ms\)/);
assert.doesNotMatch(result.textContent, /\(edited/);
assert.doesNotMatch(result.textContent, /before review/);
const deleted = withClass(result, 'diff-del');
const addedLines = withClass(result, 'diff-add');
assert.equal(deleted.length, 1);
assert.equal(deleted[0].textContent, 'The filename is sample.txt');
assert.equal(addedLines.length, 1);
assert.equal(addedLines[0].textContent, 'The filename is sample.md');
const diffHost = withClass(result, 'tool-diff')[0];
assert.ok(diffHost.children.indexOf(deleted[0]) + 1 === diffHost.children.indexOf(addedLines[0]));
assert.deepEqual(withClass(editBody, 'metrics').map(node => node.textContent), ['exit code: 0']);

const placeHist = mount('histPlace', true);
replay('histPlace', {
    type: 'tool_preview', round: 1, name: 'run_cmd', duration_ms: 2, exit_code: 0,
    output: 'The location is Ohio.\nThe date is Mar 10.\nThe theme is Spring.'
});
replay('histPlace', {
    type: 'tool_result', round: 1, name: 'run_cmd', duration_ms: 2, exit_code: 0,
    output: 'The location is Ohio.\nThe date is March 10.\nThe theme is Spring.'
});
const placeBody = placeHist.nodes.rounds.get(1).body;
assert.equal(withClass(placeBody, 'tool-preview').length, 0);
const placeDiff = withClass(placeBody, 'tool-diff')[0];
assert.equal(
    placeDiff.children.map(node => {
        const kind = String(node.className).includes('diff-del') ? 'del'
            : String(node.className).includes('diff-add') ? 'add' : 'eq';
        return kind + ':' + node.textContent;
    }).join('\n'),
    'eq:The location is Ohio.\ndel:The date is Mar 10.\nadd:The date is March 10.\neq:The theme is Spring.'
);

const fetchCapture = JSON.stringify({
    stdout: 'page body', stderr: 'warn', exit_code: 0, duration_ms: 3, raw_body: '<p>page</p>'
});
const fetched = mount('histFetch', true);
replay('histFetch', { type: 'tool_preview', round: 1, name: 'web_fetch', output: fetchCapture, duration_ms: 3, exit_code: 0 });
replay('histFetch', { type: 'tool_result', round: 1, name: 'web_fetch', output: 'page body', duration_ms: 3 });
const fetchBody = fetched.nodes.rounds.get(1).body;
assert.equal(withClass(fetchBody, 'tool-preview').length, 0);
const fetchResult = withClass(fetchBody, 'tool-result')[0];
assert.match(fetchResult.textContent, /TOOL RESULT \(3 ms\)/);
assert.doesNotMatch(fetchResult.textContent, /before review/);
assert.match(fetchResult.textContent, /page body/);
assert.match(fetchResult.textContent, /warn/);
assert.match(fetchResult.textContent, /<p>page<\/p>/);
assert.deepEqual(withClass(fetchBody, 'metrics').map(node => node.textContent), ['exit code: 0']);

const fetchStdout = 'The location is Ohio.\nSocial\nThe theme is Spring.';
const fetchContent = 'The location is Ohio.\nSocial Contacts\nThe theme is Spring.\n<abc123def456>\nchanged Social\n</abc123def456>';
const fetchEdited = mount('histFetchEdit', true);
fetchEdited.commentTag = 'abc123def456';
replay('histFetchEdit', {
    type: 'tool_preview', round: 1, name: 'web_fetch', duration_ms: 6, exit_code: 0,
    output: JSON.stringify({ stdout: fetchStdout, stderr: 'warn', exit_code: 0, raw_body: '<p>SECRET-HTML</p>' })
});
replay('histFetchEdit', {
    type: 'tool_result', round: 1, name: 'web_fetch', duration_ms: 6, exit_code: 0,
    output: JSON.stringify({ url: 'https://www.rust-lang.org/', content: fetchContent })
});
const fetchEditBody = fetchEdited.nodes.rounds.get(1).body;
assert.equal(withClass(fetchEditBody, 'tool-preview').length, 0);
const fetchEdit = withClass(fetchEditBody, 'tool-result')[0];
assert.equal(withClass(fetchEdit, 'tool-diff').length, 1);
assert.doesNotMatch(fetchEdit.textContent, /SECRET-HTML/);
assert.doesNotMatch(fetchEdit.textContent, /"url"/);
const fetchOps = withClass(fetchEdit, 'tool-diff')[0].children.map(node => {
    const kind = String(node.className).includes('diff-del') ? 'del'
        : String(node.className).includes('diff-add') ? 'add' : 'eq';
    return kind + ':' + node.textContent;
});
assert.equal(fetchOps.join('\n'), [
    'eq:The location is Ohio.',
    'del:Social',
    'add:Social Contacts',
    'eq:The theme is Spring.',
    'add:<user_comment>',
    'add:changed Social',
    'add:</user_comment>'
].join('\n'));
const fetchDel = withClass(fetchEdit, 'diff-del')[0];
const fetchAdd = withClass(fetchEdit, 'diff-add').find(node => node.textContent === 'Social Contacts');
assert.equal(fetchDel.parentNode.children.indexOf(fetchDel) + 1, fetchDel.parentNode.children.indexOf(fetchAdd));
assert.deepEqual(commentMarks(withClass(fetchEdit, 'tool-diff')[0].children[5]).map(node => node.textContent), ['changed Social']);

const searchStdout = 'hit one\nhit two';
const searchResults = searchStdout + '\n<abc123def456>\nAddition search options found externally\n</abc123def456>';
const searchEdited = mount('histSearchEdit', true);
searchEdited.commentTag = 'abc123def456';
replay('histSearchEdit', {
    type: 'tool_preview', round: 1, name: 'web_search', duration_ms: 7, exit_code: 0,
    output: JSON.stringify({ stdout: searchStdout, stderr: '', exit_code: 0 })
});
replay('histSearchEdit', {
    type: 'tool_result', round: 1, name: 'web_search', duration_ms: 7,
    output: JSON.stringify({ query: 'general_ollama_rs', max_results: 5, results: searchResults })
});
const searchEdit = withClass(searchEdited.nodes.rounds.get(1).body, 'tool-result')[0];
assert.equal(withClass(searchEdited.nodes.rounds.get(1).body, 'tool-preview').length, 0);
assert.doesNotMatch(searchEdit.textContent, /max_results/);
assert.equal(
    withClass(searchEdit, 'tool-diff')[0].children.map(node => {
        const kind = String(node.className).includes('diff-del') ? 'del'
            : String(node.className).includes('diff-add') ? 'add' : 'eq';
        return kind + ':' + node.textContent;
    }).join('\n'),
    [
        'eq:hit one',
        'eq:hit two',
        'add:<user_comment>',
        'add:Addition search options found externally',
        'add:</user_comment>'
    ].join('\n')
);
assert.equal(withClass(searchEdit, 'diff-del').length, 0);

const searchSame = mount('histSearchSame', true);
replay('histSearchSame', {
    type: 'tool_preview', round: 1, name: 'web_search', duration_ms: 4, exit_code: 0,
    output: JSON.stringify({ stdout: 'hit one\nhit two', stderr: '', exit_code: 0 })
});
replay('histSearchSame', {
    type: 'tool_result', round: 1, name: 'web_search', duration_ms: 4,
    output: JSON.stringify({ query: 'q', max_results: 5, results: 'hit one\nhit two' })
});
const searchSameBody = searchSame.nodes.rounds.get(1).body;
assert.equal(withClass(searchSameBody, 'tool-preview').length, 0);
assert.equal(withClass(searchSameBody, 'tool-diff').length, 0);
assert.match(withClass(searchSameBody, 'tool-result')[0].textContent, /hit one\nhit two/);
assert.doesNotMatch(withClass(searchSameBody, 'tool-result')[0].textContent, /max_results/);
assert.deepEqual(
    commentMarks(withClass(searchEdit, 'tool-diff')[0].children[3]).map(node => node.textContent),
    ['Addition search options found externally']
);

const sameFetch = mount('histFetchSame', true);
replay('histFetchSame', {
    type: 'tool_preview', round: 1, name: 'web_fetch', duration_ms: 3, exit_code: 0,
    output: JSON.stringify({ stdout: 'page body', stderr: 'warn', exit_code: 0, raw_body: '<p>page</p>' })
});
replay('histFetchSame', {
    type: 'tool_result', round: 1, name: 'web_fetch', duration_ms: 3,
    output: JSON.stringify({ url: 'https://example.com', content: 'page body' })
});
const sameFetchBody = sameFetch.nodes.rounds.get(1).body;
assert.equal(withClass(sameFetchBody, 'tool-preview').length, 0);
assert.equal(withClass(sameFetchBody, 'tool-diff').length, 0);
assert.match(withClass(sameFetchBody, 'tool-result')[0].textContent, /page body/);
assert.match(withClass(sameFetchBody, 'tool-result')[0].textContent, /<p>page<\/p>/);

const notedResult = mount('histNote', true);
notedResult.commentTag = 'abc123def456';
const notedText = 'stdout:\nfiles\n<abc123def456>\nkeep pngs\n</abc123def456>';
replay('histNote', { type: 'tool_preview', round: 1, name: 'run_cmd', output: notedText, duration_ms: 4, exit_code: 0 });
replay('histNote', { type: 'tool_result', round: 1, name: 'run_cmd', output: notedText, duration_ms: 4, exit_code: 0 });
const notedBody = notedResult.nodes.rounds.get(1).body;
assert.equal(withClass(notedBody, 'tool-preview').length, 0);
assert.equal(withClass(notedBody, 'tool-diff').length, 0);
const notedTool = withClass(notedBody, 'tool-result')[0];
assert.equal(commentMarks(notedTool).length, 1);
assert.equal(commentMarks(notedTool)[0].textContent, '<user_comment>\nkeep pngs\n</user_comment>');
assert.match(notedTool.textContent, /stdout:\nfiles/);

const redirected = mount('histRedirect', true);
replay('histRedirect', { type: 'tool_call', round: 1, name: 'run_cmd', arguments: { command: 'ls', task: 'listing' } });
replay('histRedirect', { type: 'approval', round: 1, decision: 'redirect', tool: 'run_cmd', text: 'look at docs instead' });
replay('histRedirect', { type: 'tool_result', round: 1, name: 'run_cmd', output: 'updated instructions', duration_ms: 1 });
const redirectResult = withClass(redirected.nodes.rounds.get(1).body, 'tool-result')[0];
assert.equal(withClass(redirectResult, 'diff-add').length, 1);
assert.equal(withClass(redirectResult, 'diff-add')[0].textContent, 'updated instructions');
assert.equal(withClass(redirectResult, 'diff-del').length, 0);

const limited = mount('histLimit', true);
replay('histLimit', {
    type: 'tool_call', round: 1, name: 'run_cmd',
    arguments: { command: 'ls', task: 'listing files', timeout: '30s' }
});
replay('histLimit', { type: 'approval', round: 1, decision: 'approve', tool: 'run_cmd', command_timeout: 'none' });
const limitBody = limited.nodes.rounds.get(1).body;
assert.equal(withClass(limitBody, 'diff-del').some(node => node.textContent === 'Timeout: 30s'), true);
assert.equal(withClass(limitBody, 'diff-add').some(node => node.textContent === 'Timeout: none'), true);
const limitCall = withClass(limitBody, 'tool')[0];
const timeoutDel = withClass(limitCall, 'diff-del').find(node => node.textContent === 'Timeout: 30s');
const timeoutAdd = withClass(limitCall, 'diff-add').find(node => node.textContent === 'Timeout: none');
assert.equal(limitCall.children.indexOf(timeoutDel) + 1, limitCall.children.indexOf(timeoutAdd));

const untouched = mount('histUntouched', true);
replay('histUntouched', { type: 'tool_call', round: 1, name: 'run_cmd', arguments: { command: 'ls', task: 'listing files' } });
replay('histUntouched', { type: 'approval', round: 1, decision: 'approve', tool: 'run_cmd', command_timeout: 'none' });
const untouchedCall = withClass(untouched.nodes.rounds.get(1).body, 'tool')[0];
assert.match(untouchedCall.textContent, /Timeout: none/);
assert.equal(withClass(untouchedCall, 'diff-del').length, 0);

const swappedView = mount('histCmd', true);
replay('histCmd', {
    type: 'tool_call', round: 1, name: 'run_cmd',
    arguments: { command: 'printf model-ok', task: 'printing the model command' }
});
replay('histCmd', {
    type: 'approval', round: 1, decision: 'approve', tool: 'run_cmd',
    command_timeout: 'none', command: 'printf person-ok', note: 'narrower check'
});
const swappedNode = withClass(swappedView.nodes.rounds.get(1).body, 'tool')[0];
const cmdDel = withClass(swappedNode, 'diff-del').find(node => node.textContent.includes('printf model-ok'));
const cmdAdd = withClass(swappedNode, 'diff-add').find(node => node.textContent.includes('printf person-ok'));
assert.ok(cmdDel);
assert.ok(cmdAdd);
assert.equal(swappedNode.children.indexOf(cmdDel) + 1, swappedNode.children.indexOf(cmdAdd));
assert.equal(withClass(swappedNode, 'diff-del').filter(node => node.textContent.startsWith('Timeout:')).length, 0);

const plain = mount('liveReplay', false);
replay('liveReplay', { type: 'tool_preview', round: 1, name: 'run_cmd', output: 'stdout:\nok\n', duration_ms: 4, exit_code: 3 });
replay('liveReplay', { type: 'tool_result', round: 1, name: 'run_cmd', output: 'stdout:\nok\n', duration_ms: 4, exit_code: 0 });
const plainBody = plain.nodes.rounds.get(1).body;
assert.equal(withClass(plainBody, 'tool-preview').length, 1);
assert.equal(withClass(plainBody, 'tool-result').length, 1);
assert.deepEqual(
    withClass(plainBody, 'metrics').map(node => node.textContent),
    ['exit code: 3', 'exit code: 0']
);

const folded = mount('histFold', true);
replay('histFold', { type: 'tool_call', round: 1, name: 'run_cmd', arguments: { command: 'ls', task: 'listing files' } });
replay('histFold', { type: 'tool_call', round: 1, name: 'run_cmd', arguments: { command: 'pwd', task: 'showing the directory' } });
evaluate('rawBodyText = () => Array.from({ length: 20 }, (_, i) => "row " + i).join("\\n")');
sandbox.finalizeRound('histFold', 1);
const fold = folded.nodes.rounds.get(1);
assert.match(fold.body.className, /round-condensed/);
assert.equal(fold.body.style.display, '');
assert.equal(fold.preview.style.display, 'none');
assert.match(fold.toggle.textContent, /click to expand/);
assert.match(fold.toolSummary.className, /round-tools-on/);
assert.deepEqual(
    fold.toolSummary.children.map(node => node.querySelector('.round-tool-name').textContent),
    ['run_cmd: 2', 'edits: 0', 'meta']
);
const foldTasks = fold.toolSummary.children[0].querySelector('.round-tool-tasks');
assert.deepEqual(foldTasks.children.map(node => node.textContent), ['listing files', 'showing the directory']);
assert.equal(fold.toolSummary.children[1].querySelector('.round-tool-tasks'), null);
assert.deepEqual(
    fold.toolSummary.children[2].querySelector('.round-tool-tasks').children.map(node => node.textContent),
    ['No metadata recorded.']
);
assert.equal(fold.expandHit.parentNode, fold.body);
assert.equal(fold.condenseLink.style.display, 'none');
assert.equal(fold.condenseLink.textContent, 'click to condense');
fold.expandHit.onclick();
assert.equal(fold.condensed, false);
assert.equal(fold.body.className, 'round-body');
assert.equal(fold.toolSummary.className, 'round-tools');
assert.equal(fold.condenseLink.style.display, '');
assert.match(fold.toggle.textContent, /click to condense/);
fold.toggle.onclick();
assert.match(fold.body.className, /round-condensed/);
assert.match(fold.toolSummary.className, /round-tools-on/);
assert.equal(fold.condenseLink.style.display, 'none');
assert.match(fold.toggle.textContent, /click to expand/);

const short = mount('histShort', true);
replay('histShort', { type: 'tool_call', round: 1, name: 'web_search', arguments: { query: 'sample' } });
evaluate('rawBodyText = () => "only a little"');
sandbox.finalizeRound('histShort', 1);
const brief = short.nodes.rounds.get(1);
assert.equal(brief.body.className, 'round-body');
assert.equal(brief.condensed, false);
assert.equal(brief.toolSummary.className, 'round-tools');
assert.equal(brief.toolSummary.children.length, 0);
assert.equal(brief.condenseLink.style.display, 'none');
assert.equal(brief.body.className.includes('round-condensed'), false);

const live = mount('liveFold', false);
replay('liveFold', { type: 'tool_call', round: 1, name: 'run_cmd', arguments: { command: 'ls', task: 'listing files' } });
evaluate('rawBodyText = () => Array.from({ length: 70 }, (_, i) => "row " + i).join("\\n")');
sandbox.finalizeRound('liveFold', 1);
const liveRound = live.nodes.rounds.get(1);
assert.equal(liveRound.body.style.display, 'none');

const down = mount('ollamaDown', false);
replay('ollamaDown', { type: 'round_start', round: 1, model: 'beam:cloud' });
replay('ollamaDown', { type: 'error', message: 'Ollama is not reachable at http://127.0.0.1:11434. Start the server and generate again.' });
const downRound = down.nodes.rounds.get(1);
assert.equal(down.runError, 'Ollama is not reachable at http://127.0.0.1:11434. Start the server and generate again.');
assert.equal(downRound.contentEl.textContent, down.runError);
assert.match(withClass(down.nodes.container, 'error')[0].textContent, /Ollama is not reachable/);
assert.equal(liveRound.preview.style.display, '');
assert.equal(liveRound.body.className, 'round-body');
assert.equal(liveRound.toolSummary.className, 'round-tools');

const cmdFold = mount('histCmdFold', true);
replay('histCmdFold', { type: 'tool_call', round: 1, name: 'run_cmd', arguments: { command: 'printf model-ok', task: 'printing', timeout: '30s' } });
replay('histCmdFold', {
    type: 'approval', round: 1, decision: 'approve', tool: 'run_cmd',
    command_timeout: 'none', command: 'echo one\necho two\necho three\necho four\necho five',
    edit_diffs: [
        { summary: '+5/-1 - printf model-ok + echo one + echo two …', added: 5, removed: 1 },
        { summary: '+1/-1 - Timeout: 30s + Timeout: none', added: 1, removed: 1 }
    ]
});
evaluate('rawBodyText = () => Array.from({ length: 20 }, (_, i) => "row " + i).join("\\n")');
sandbox.finalizeRound('histCmdFold', 1);
const cmdFoldRound = cmdFold.nodes.rounds.get(1);
const cmdEditTip = cmdFoldRound.toolSummary.children[1].querySelector('.round-tool-tasks');
assert.deepEqual(
    cmdEditTip.children.map(node => node.textContent),
    ['+5/-1 - printf model-ok + echo one + echo two …', '+1/-1 - Timeout: 30s + Timeout: none']
);
assert.equal(evaluate('scrollJumpNear(0, 10, 0, 0, 72, "down")'), true);
assert.equal(evaluate('scrollJumpNear(0, -10, 0, 0, 72, "down")'), false);
assert.equal(evaluate('scrollJumpNear(0, -10, 0, 0, 72, "up")'), true);
assert.equal(evaluate('scrollJumpNear(0, 10, 0, 0, 72, "up")'), false);
assert.equal(evaluate('scrollJumpNear(0, 0, 0, 0, 72, "down")'), true);
assert.equal(evaluate('scrollJumpNear(80, 10, 0, 0, 72, "down")'), false);
assert.equal(evaluate('scrollJumpNear(0, 80, 0, 0, 72, "up")'), false);
assert.equal(evaluate('scrollJumpDelta("start", 800, -1200, 800, 22, -1310)'), -1314);
assert.equal(evaluate('scrollJumpDelta("end", 800, -400, 2400, 22, 2522)'), 1726);
assert.equal(evaluate('scrollJumpDelta("start", 800, 900, 2000, 22, 10)'), 122);
assert.equal(evaluate('scrollJumpDelta("end", 800, 0, 30, 22, 5000)'), 8);
assert.equal(evaluate('scrollJumpDelta("end", 800, 0, 2000, 22, null)'), 1204);
assert.equal(evaluate('scrollJumpDelta("start", 800, -1200, 800, 22, -1310, 180)'), -1494);

Element.prototype.getBoundingClientRect = function () {
    if (this._rect) return this._rect;
    const cls = String(this.className || '');
    if (cls.includes('scroll-jump-down')) return { top: 760, bottom: 782, left: 172, right: 228, width: 56, height: 22 };
    if (cls.includes('scroll-jump-up')) return { top: 6, bottom: 28, left: 172, right: 228, width: 56, height: 22 };
    return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
};
document.querySelector = (sel) => (
    sel === 'meta[name="scroll-arrow"]'
        ? { getAttribute: () => 'data:image/png;base64,abc' }
        : null
);
const jumpPanel = document.createElement('div');
jumpPanel.className = 'round-body';
jumpPanel.isConnected = true;
// Middle of a tall panel: both edges are off the 800px viewport.
jumpPanel._rect = { top: -120, bottom: 1880, left: 0, right: 400, width: 400, height: 2000 };
sandbox.refreshScrollJumps(jumpPanel);
const jumps = jumpPanel._scrollJumps;
assert.ok(jumps, 'a tall expanded window grows jump links');
assert.equal(jumps.up.hidden, false);
assert.equal(jumps.down.hidden, false);
assert.equal(jumps.up.style.top, '142px');
assert.equal(jumps.down.style.top, '876px');
assert.equal(jumps.down.href, '#' + jumps.end.id);
assert.equal(jumps.up.children[0].src, 'data:image/png;base64,abc');
assert.equal(String(jumps.down.children[0].className).includes('scroll-jump-icon'), true);
sandbox.onScrollJumpMouse({ clientX: 200, clientY: 40 });
assert.equal(jumps.up.classList.contains('is-near'), true);
assert.equal(jumps.down.classList.contains('is-near'), false);
sandbox.onScrollJumpMouse({ clientX: 200, clientY: 0 });
assert.equal(jumps.up.classList.contains('is-near'), false);
sandbox.onScrollJumpMouse({ clientX: 200, clientY: 740 });
assert.equal(jumps.down.classList.contains('is-near'), true);
assert.equal(jumps.up.classList.contains('is-near'), false);
sandbox.onScrollJumpMouse({ clientX: 200, clientY: 800 });
assert.equal(jumps.down.classList.contains('is-near'), false);
// Start of the text is on screen, so the upward arrow stays hidden.
jumpPanel._rect = { top: 12, bottom: 2012, left: 0, right: 400, width: 400, height: 2000 };
sandbox.refreshScrollJumps(jumpPanel);
assert.equal(jumps.up.hidden, true);
assert.equal(jumps.down.hidden, false);
sandbox.onScrollJumpMouse({ clientX: 200, clientY: 40 });
assert.equal(jumps.up.classList.contains('is-near'), false);
// Neighbors: one line of the previous card above this header, and the
// next card's header plus the first line of its text.
const jumpCard = document.createElement('div');
jumpCard.className = 'round';
const jumpHead = document.createElement('div');
jumpHead.className = 'round-head';
jumpHead._rect = { top: -200, bottom: -128, left: 0, right: 400, width: 400, height: 72 };
jumpCard.appendChild(jumpHead);
jumpCard.appendChild(jumpPanel);
const prevCard = document.createElement('div');
prevCard.className = 'round';
prevCard._rect = { top: -430, bottom: -210, left: 0, right: 400, width: 400, height: 220 };
const nextCard = document.createElement('div');
nextCard.className = 'round';
const nextBody = document.createElement('div');
nextBody.className = 'round-body';
nextBody._rect = { top: 1960, bottom: 3000, left: 0, right: 400, width: 400, height: 1040 };
nextCard.appendChild(nextBody);
jumpCard.previousElementSibling = prevCard;
jumpCard.nextElementSibling = nextCard;
let jumpedBy = null;
sandbox.window.scrollBy = (x, y) => {
    jumpedBy = y;
    const r = jumpPanel._rect;
    jumpPanel._rect = {
        top: r.top - y, bottom: r.bottom - y, left: r.left, right: r.right, width: r.width, height: r.height
    };
};
jumpPanel._rect = { top: -120, bottom: 1880, left: 0, right: 400, width: 400, height: 2000 };
sandbox.refreshScrollJumps(jumpPanel);
jumps.down.onclick({ preventDefault() {} });
assert.equal(jumpedBy, 1186);
assert.equal(jumps.down.hidden, true);
assert.equal(jumps.up.hidden, false);
sandbox.onScrollJumpMouse({ clientX: 200, clientY: 740 });
assert.equal(jumps.down.classList.contains('is-near'), false);
jumpPanel._rect = { top: -120, bottom: 1880, left: 0, right: 400, width: 400, height: 2000 };
sandbox.refreshScrollJumps(jumpPanel);
jumps.up.onclick({ preventDefault() {} });
assert.equal(jumpedBy, -236);
assert.equal(jumps.up.hidden, true);
assert.equal(jumps.down.hidden, false);
jumpPanel.className = 'round-body round-condensed';
sandbox.refreshScrollJumps(jumpPanel);
assert.equal(jumps.up.hidden, true);
assert.equal(jumps.down.hidden, true);
const shortPanel = document.createElement('div');
shortPanel.className = 'tool';
shortPanel.isConnected = true;
shortPanel._rect = { top: 10, bottom: 200, left: 0, right: 400, width: 400, height: 190 };
sandbox.refreshScrollJumps(shortPanel);
assert.equal(shortPanel._scrollJumps.up.hidden, true);
assert.equal(shortPanel._scrollJumps.down.hidden, true);
// A body that fits in the window never offers a page jump, even when an
// edge is clipped or scrollHeight overshoots clientHeight. That click
// lands on the neighbor, not on this card.
const scrolled = document.createElement('div');
scrolled.className = 'tool';
scrolled.isConnected = true;
scrolled._rect = { top: 40, bottom: 430, left: 0, right: 400, width: 400, height: 390 };
scrolled.scrollHeight = 2000;
scrolled.clientHeight = 390;
scrolled.scrollTop = 80;
sandbox.refreshScrollJumps(scrolled);
assert.equal(scrolled._scrollJumps.up.hidden, true);
assert.equal(scrolled._scrollJumps.down.hidden, true);
const clippedShort = document.createElement('div');
clippedShort.className = 'round-body';
clippedShort.isConnected = true;
clippedShort._rect = { top: -80, bottom: 320, left: 0, right: 400, width: 400, height: 400 };
sandbox.refreshScrollJumps(clippedShort);
assert.equal(clippedShort._scrollJumps.up.hidden, true);
assert.equal(clippedShort._scrollJumps.down.hidden, true);

// The control bar covers y=0. The top arrow hangs below that bar, and
// its lower semicircle is measured from the icon, not from the window edge.
const bar = document.getElementById('controlDashboard');
bar._rect = { top: 0, bottom: 180, left: 0, right: 800, width: 800, height: 180 };
const covered = document.createElement('div');
covered.className = 'round-body';
covered.isConnected = true;
covered._rect = { top: -120, bottom: 1880, left: 0, right: 400, width: 400, height: 2000 };
sandbox.refreshScrollJumps(covered);
const coveredJumps = covered._scrollJumps;
assert.equal(coveredJumps.up.hidden, false);
assert.equal(coveredJumps.up.style.top, '322px');
assert.equal(coveredJumps.down.style.top, '876px');
coveredJumps.up._rect = { top: 202, bottom: 224, left: 172, right: 228, width: 56, height: 22 };
sandbox.refreshScrollJumps(covered);
sandbox.onScrollJumpMouse({ clientX: 200, clientY: 40 });
assert.equal(coveredJumps.up.classList.contains('is-near'), false);
sandbox.onScrollJumpMouse({ clientX: 200, clientY: 190 });
assert.equal(coveredJumps.up.classList.contains('is-near'), false);
sandbox.onScrollJumpMouse({ clientX: 200, clientY: 230 });
assert.equal(coveredJumps.up.classList.contains('is-near'), true);
covered._rect = { top: 40, bottom: 2012, left: 0, right: 400, width: 400, height: 1972 };
sandbox.refreshScrollJumps(covered);
assert.equal(coveredJumps.up.hidden, false);
assert.equal(coveredJumps.up.style.top, '162px');
covered._rect = { top: 200, bottom: 2012, left: 0, right: 400, width: 400, height: 1812 };
sandbox.refreshScrollJumps(covered);
assert.equal(coveredJumps.up.hidden, true);
let coveredBy = null;
const prevScrollBy = sandbox.window.scrollBy;
sandbox.window.scrollBy = (x, y) => { coveredBy = y; };
covered._rect = { top: -120, bottom: 1880, left: 0, right: 400, width: 400, height: 2000 };
sandbox.refreshScrollJumps(covered);
coveredJumps.up.onclick({ preventDefault() {} });
assert.equal(coveredBy, -326);
sandbox.window.scrollBy = prevScrollBy;
bar._rect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };

// A round that holds both a Tool Call and a Tool Result does not grow its
// own arrow. The long result owns the down arrow. The call, which fits,
// does not.
const pair = document.createElement('div');
pair.className = 'round-body';
pair.isConnected = true;
pair._rect = { top: -40, bottom: 2200, left: 0, right: 400, width: 400, height: 2240 };
const callWin = document.createElement('div');
callWin.className = 'tool';
callWin.isConnected = true;
callWin._rect = { top: 40, bottom: 280, left: 0, right: 400, width: 400, height: 240 };
const resultWin = document.createElement('div');
resultWin.className = 'tool tool-result';
resultWin.isConnected = true;
resultWin._rect = { top: 300, bottom: 2200, left: 0, right: 400, width: 400, height: 1900 };
pair.appendChild(callWin);
pair.appendChild(resultWin);
sandbox.refreshScrollJumps(pair);
assert.equal(pair._scrollJumps.up.hidden, true);
assert.equal(pair._scrollJumps.down.hidden, true);
assert.equal(callWin._scrollJumps.up.hidden, true);
assert.equal(callWin._scrollJumps.down.hidden, true);
assert.equal(resultWin._scrollJumps.up.hidden, true);
assert.equal(resultWin._scrollJumps.down.hidden, false);

// Highlighting is display-only: the text stays byte-identical, and only
// lines without inline change spans carry the language class (word-marked
// lines keep their marking).
{
    const box = document.createElement('div');
    sandbox.renderStructuredDiff(box, {
        lines: [
            { op: 'insert', text: 'fn main() {' },
            { op: 'eq', text: 'run(x);', spans: [{ op: 'eq', text: 'run(' }, { op: 'insert', text: 'x' }, { op: 'eq', text: ');' }] },
            { op: 'delete', text: '}' },
        ],
    }, 'rust');
    const first = box.children[0];
    assert.equal(first.textContent, 'fn main() {');
    assert.equal(first.children.length, 1);
    assert.equal(first.children[0].className, 'language-rust');
    assert.equal(first.children[0].textContent, 'fn main() {');
    const second = box.children[1];
    assert.equal(second.textContent, 'run(x);');
    assert.equal(second.children.length, 3);
    const plainBox = document.createElement('div');
    sandbox.renderStructuredDiff(plainBox, { lines: [{ op: 'eq', text: 'x' }] }, '');
    assert.equal(plainBox.children[0].children.length, 0);
    // languageForPath maps the bundled grammars and nothing else.
    assert.equal(sandbox.languageForPath('/tmp/build.rs'), 'rust');
    assert.equal(sandbox.languageForPath('script.py'), 'python');
    assert.equal(sandbox.languageForPath('run.sh'), 'bash');
    assert.equal(sandbox.languageForPath('main.go'), 'go');
    assert.equal(sandbox.languageForPath('a.cpp'), 'cpp');
    assert.equal(sandbox.languageForPath('app.ts'), 'typescript');
    assert.equal(sandbox.languageForPath('App.kt'), 'kotlin');
    assert.equal(sandbox.languageForPath('Main.java'), 'java');
    assert.equal(sandbox.languageForPath('init.lua'), 'lua');
    assert.equal(sandbox.languageForPath('thing.pl'), 'perl');
    assert.equal(sandbox.languageForPath('page.html'), 'html');
    assert.equal(sandbox.languageForPath('feed.xml'), 'xml');
    assert.equal(sandbox.languageForPath('sheet.css'), 'css');
    assert.equal(sandbox.languageForPath('package.json'), 'json');
    assert.equal(sandbox.languageForPath('notes.txt'), '');
    assert.equal(sandbox.languageForPath('noext'), '');
}

// A new-file write preview is the proposed text itself: one code block
// with the language class, not a diff. Behavior and data, not wording.
{
    const host = new Element('div');
    sandbox.renderFileContent(host, 'fn main() {}\n', 'rust');
    assert.equal(host.children.length, 1);
    assert.equal(host.children[0].tagName, 'pre');
    assert.equal(host.children[0].className, 'file-content');
    assert.equal(host.children[0].children.length, 1);
    assert.equal(host.children[0].children[0].tagName, 'code');
    assert.equal(host.children[0].children[0].className, 'language-rust');
    assert.equal(host.children[0].children[0].textContent, 'fn main() {}\n');
    // No language: the same text, no language class, still safe.
    sandbox.renderFileContent(host, 'plain text', '');
    assert.equal(host.children[0].children[0].className, '');
    assert.equal(host.children[0].children[0].textContent, 'plain text');
    // Comment tags take the house comment painting: per-line spans
    // instead of a code block, so the markers stay visible.
    sandbox.renderFileContent(host, 'before <user_comment>tag</user_comment> after', 'rust');
    assert.equal(host.children[0].tagName, 'span');
    assert.equal(host.children[0].className, 'diff-line');
    // The painted line carries the comment span, not raw text.
    assert.ok(host.children[0].children.length > 0);
}
