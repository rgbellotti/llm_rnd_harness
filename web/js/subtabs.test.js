// subtabs.test.js — completion-time split of a chain into Response and
// Diagnostics panes. Loads rounds.js and subtabs.js alone on a fake DOM;
// the streaming pipeline is not involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const read = name => fs.readFileSync(__dirname + '/' + name, 'utf8');

class Element {
    constructor(tag) {
        this.tag = tag; this.children = []; this.style = {};
        this.attributes = {}; this.value = ''; this.hidden = false;
        this.textContent = '';
        this._classes = new Set();
        const self = this;
        this.classList = {
            add: c => self._classes.add(c),
            remove: (...cs) => cs.forEach(c => self._classes.delete(c)),
            toggle: (c, force) => { const on = force === undefined ? !self._classes.has(c) : !!force; if (on) self._classes.add(c); else self._classes.delete(c); return on; },
            contains: c => self._classes.has(c),
        };
        this._listeners = {};
    }
    set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get className() { return [...this._classes].join(' '); }
    get firstChild() { return this.children[0] || null; }
    appendChild(child) {
        if (child.parentNode && child.parentNode.children) {
            const at = child.parentNode.children.indexOf(child);
            if (at >= 0) child.parentNode.children.splice(at, 1);
        }
        this.children.push(child);
        child.parentNode = this;
        return child;
    }
    setAttribute(k, v) { this.attributes[k] = v; }
    getAttribute(k) { return this.attributes[k]; }
    addEventListener(type, fn) { this._listeners[type] = fn; }
    click() { const fn = this.onclick || this._listeners.click; if (fn) fn({ stopPropagation: () => {} }); this.focus(); }
    cloneNode() {
        const copy = new Element(this.tag);
        copy._classes = new Set(this._classes);
        copy.textContent = this.textContent;
        for (const child of this.children) copy.appendChild(child.cloneNode());
        return copy;
    }
    querySelector(sel) {
        const want = String(sel).replace(/^\./, '');
        const walk = el => { for (const c of el.children) { if (c._classes.has(want)) return c; const found = walk(c); if (found) return found; } return null; };
        return walk(this);
    }
    querySelectorAll(sel) {
        const want = String(sel).replace(/^\./, '');
        const out = [];
        const walk = el => { for (const c of el.children) { if (c._classes.has(want)) out.push(c); walk(c); } };
        walk(this);
        return out;
    }
    contains(el) { return this.children.includes(el) || this.children.some(c => c.contains && c.contains(el)); }
    focus() {}
}
const document = {
    getElementById() { return null; },
    createElement(tag) { return new Element(tag); },
    createDocumentFragment() { return new Element('#fragment'); },
    addEventListener() {},
};
const sandbox = {
    document,
    getComputedStyle: () => ({ paddingLeft: '0', paddingRight: '0' }),
    window: {},
    navigator: {},
};
vm.createContext(sandbox);
vm.runInContext(read('core.js') + read('rounds.js') + read('subtabs.js'), sandbox);
const evaluate = code => vm.runInContext(code, sandbox);

const deepText = el => (el.textContent || '') + el.children.map(deepText).join('');

// Build a fake session with one finished round whose body holds the answer.
const container = document.createElement('div');
const promptRound = document.createElement('div');
promptRound.className = 'round prompt-archive';
promptRound.textContent = 'PROMPT (archived): hello';
const roundSec = document.createElement('div');
roundSec.className = 'round';
const body = document.createElement('div');
body.className = 'round-body';
const thinking = document.createElement('details');
thinking.className = 'thinking';
thinking.textContent = 'thinking trace';
const contentEl = document.createElement('div');
contentEl.className = 'content';
contentEl.textContent = 'the final answer';
const renderedEl = document.createElement('div');
renderedEl.className = 'rendered-body';
renderedEl.style.display = 'none';
const metrics = document.createElement('div');
metrics.className = 'metrics';
metrics.textContent = 'tokens: 12';
body.appendChild(thinking);
body.appendChild(contentEl);
body.appendChild(renderedEl);
body.appendChild(metrics);
roundSec.appendChild(body);
container.appendChild(promptRound);
container.appendChild(roundSec);
const viewToggle = document.createElement('button');
const rounds = new Map();
rounds.set(1, { sec: roundSec, body, preview: document.createElement('div'), toggle: document.createElement('button'), det: thinking, thinkingBody: thinking, contentEl, renderedEl, viewToggle, showingRendered: false, condensed: false, finalized: false, totalLines: 0 });
const data = { rounds: { 1: { content: 'the final answer', thinking: '', contentHtml: '', toolCalls: [], toolResults: [], metrics: null } }, order: [1] };
const s = { id: 'tab-split-1', num: 1, prompt: 'hello', status: 'done', statusText: '', data, nodes: { container, rounds } };
sandbox.splitSession = s;

assert.equal(evaluate('splitChainView(splitSession)'), true);

// The split is a pure reorganization: no nodes vanish, none are duplicated.
assert.equal(container.children.length, 3); // tab bar + 2 panes
assert.equal(container.children[0].className, 'sub-tabs');
const tabButtons = container.children[0].children;
assert.equal(tabButtons[0].textContent, 'Response');
assert.equal(tabButtons[1].textContent, 'Diagnostics');

const refs = evaluate('splitSession.nodes.subtabs');
const responseButtons = refs.responsePane.querySelectorAll('.copy-btn');
assert.deepEqual(responseButtons.map(btn => btn.textContent), [
    'copy\nselected', 'copy\nfull', 'curate\nselected', 'curate\nfull'
]);
// Answer landed in the Response pane; steps stayed in Diagnostics.
assert.ok(refs && refs.responsePane && refs.diagnosticsPane);
assert.ok(deepText(refs.responsePane).includes('the final answer'), deepText(refs.responsePane));
assert.ok(deepText(refs.diagnosticsPane).includes('PROMPT (archived)'), deepText(refs.diagnosticsPane));
assert.ok(deepText(refs.diagnosticsPane).includes('thinking trace'), deepText(refs.diagnosticsPane));
assert.ok(!deepText(refs.diagnosticsPane).includes('the final answer'), 'answer moved out of diagnostics');

// Response is the default active pane.
assert.equal(refs.responsePane.hidden, false);
assert.equal(refs.diagnosticsPane.hidden, true);
assert.ok(refs.responseTab._classes.has('sub-tab-active'));

// Toggling shows/hides the panes without duplicating content.
refs.diagnosticsTab.click();
assert.equal(refs.diagnosticsPane.hidden, false);
assert.equal(refs.responsePane.hidden, true);
assert.ok(refs.diagnosticsTab._classes.has('sub-tab-active'));
assert.ok(!refs.responseTab._classes.has('sub-tab-active'));
refs.responseTab.click();
assert.equal(refs.responsePane.hidden, false);
assert.equal(refs.diagnosticsPane.hidden, true);

// Idempotency: calling splitChainView again does not nest panes.
evaluate('splitChainView(splitSession)');
assert.equal(container.children.length, 3);

// Diagnostics cards use the tinted window. The Response pane stays open.
const longText = Array.from({ length: 20 }, (_, i) => 'line ' + i).join('\n');
const diagBox = document.createElement('div');
const diagRound = document.createElement('div');
diagRound.className = 'round';
const diagBody = document.createElement('div');
diagBody.className = 'round-body';
diagBody.style.display = 'none';
const trace = document.createElement('div');
trace.className = 'thinking';
const thinkingHead = document.createElement('div');
thinkingHead.className = 'thinking-head';
const thinkingBody = document.createElement('div');
thinkingBody.className = 'thinking-body';
thinkingBody.textContent = longText;
trace.appendChild(thinkingHead);
trace.appendChild(thinkingBody);
const tool = document.createElement('div');
tool.className = 'tool tool-result';
tool.textContent = longText;
const answer = document.createElement('div');
answer.className = 'content';
answer.textContent = 'full rendered answer';
const rendered = document.createElement('div');
rendered.className = 'rendered-body';
diagBody.appendChild(trace);
diagBody.appendChild(tool);
diagBody.appendChild(answer);
diagBody.appendChild(rendered);
diagRound.appendChild(diagBody);
diagBox.appendChild(diagRound);
const preview = document.createElement('div');
preview.style.display = '';
const diagRounds = new Map();
diagRounds.set(1, {
    sec: diagRound, body: diagBody, preview, toggle: document.createElement('button'),
    det: trace, thinkingBody, contentEl: answer, renderedEl: rendered,
    viewToggle: document.createElement('button'), showingRendered: false,
    condensed: true, finalized: true, totalLines: 20
});
const diagSession = {
    id: 'tab-split-2', num: 2, prompt: 'scan', status: 'done', statusText: '',
    data: { rounds: { 1: { content: 'full rendered answer', thinking: longText, contentHtml: '', toolCalls: [], toolResults: [], metrics: null } }, order: [1] },
    nodes: { container: diagBox, rounds: diagRounds }
};
sandbox.diagSession = diagSession;
assert.equal(evaluate('splitChainView(diagSession)'), true);
const diagRefs = diagSession.nodes.subtabs;
assert.equal(diagBody.style.display, '');
assert.equal(diagBody.className.includes('round-condensed'), true);
assert.equal(preview.style.display, 'none');
assert.equal(trace.className.includes('diag-condensed'), true);
assert.ok(trace.children.some(child => child.className.includes('round-expand-hit')));
assert.equal(tool.className.includes('tool-condensed'), true);
assert.equal(String(diagRefs.responsePane.querySelector('.response-body').className).includes('round-condensed'), false);
assert.equal(String(diagRefs.responsePane.querySelector('.response-body').className).includes('diag-condensed'), false);
assert.ok(deepText(diagRefs.responsePane).includes('full rendered answer'));
const thinkingHit = trace.children.find(child => child.className.includes('round-expand-hit'));
thinkingHit.onclick();
assert.equal(trace.className.includes('diag-condensed'), false);
const thinkingCondense = thinkingHead.children.find(child => child.textContent === 'click to condense');
assert.ok(thinkingCondense);
assert.equal(thinkingCondense.style.display, '');
thinkingCondense.onclick();
assert.equal(trace.className.includes('diag-condensed'), true);
assert.equal(thinkingCondense.style.display, 'none');

console.log('subtabs.test.js OK');
