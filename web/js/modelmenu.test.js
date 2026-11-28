// modelmenu.test.js — the header's model selector: groups render from the
// serialized data attribute, options disable while a run is in flight,
// and switching swaps the model via /model. Loads modelmenu.js alone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
    constructor(tag) {
        this.tag = tag; this.children = []; this.style = {}; this.dataset = {};
        this.attributes = {}; this.value = ''; this.disabled = false;
        this._classes = new Set();
        this.textContent = ''; this.focused = false;
        const self = this;
        this.classList = {
            add: c => self._classes.add(c),
            remove: c => self._classes.delete(c),
            contains: c => self._classes.has(c),
            toggle: (c, force) => { const on = force === undefined ? !self._classes.has(c) : !!force; if (on) self._classes.add(c); else self._classes.delete(c); return on; },
        };
        this._listeners = {};
    }
    set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get className() { return [...this._classes].join(' '); }
    appendChild(c) { this.children.push(c); return c; }
    append(...cs) { this.children.push(...cs); }
    setAttribute(k, v) { this.attributes[k] = v; }
    getAttribute(k) { return this.attributes[k]; }
    addEventListener(type, fn) { this._listeners[type] = fn; }
    click() { this._listeners.click && this._listeners.click({ stopPropagation: () => {} }); }
    querySelector(sel) {
        const want = sel.replace(/^\./, '');
        const walk = el => { for (const c of el.children) { if (c._classes && c._classes.has(want)) return c; const found = walk(c); if (found) return found; } return null; };
        return walk(this);
    }
    querySelectorAll(sel) {
        const want = sel.replace(/^\./, '');
        const out = [];
        const walk = el => { for (const c of el.children) { if (c._classes && c._classes.has(want)) out.push(c); walk(c); } };
        walk(this);
        return out;
    }
    contains(el) { return this.children.includes(el) || this.children.some(c => c.contains && c.contains(el)); }
    focus() { this.focused = true; }
}
const elements = new Map();
const documentListeners = {};
const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element(id === 'modelToggle' ? 'button' : 'div')); return elements.get(id); },
    createElement(tag) { return new Element(tag); },
    createTextNode(text) { const t = new Element('#text'); t.textContent = text; return t; },
    createDocumentFragment() { return new Element('#fragment'); },
    addEventListener(type, fn) { documentListeners[type] = fn; },
};
const groups = [
    { group: 'OLLAMA', models: ['beam:cloud', 'gemma4:31b-cloud', 'glm-5.3:cloud', 'minimax-m3.1-flash:cloud'] },
    { group: 'LOCAL', models: ['llama3.2:3b', 'qwen2.5:1.5b'] },
];
const menu = elements.set('modelMenu', new Element('div')).get('modelMenu');
menu.getAttributeMap = null; // not needed; getAttribute reads attributes below
menu.attributes['data-groups'] = JSON.stringify(groups);
menu.hidden = true;
const toggle = elements.set('modelToggle', new Element('button')).get('modelToggle');
toggle.textContent = 'beam:cloud';
const statusLog = [];
let refreshConfigCalls = 0;
const sandbox = {
    document,
    runningSid: null,
    apiFetch: (...a) => sandbox.fetch(...a),
    setStatus: text => statusLog.push(text),
    refreshConfig: () => { refreshConfigCalls += 1; },
    fetch: null,
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(__dirname + '/modelmenu.js', 'utf8'), sandbox);
const evaluate = code => vm.runInContext(code, sandbox);

const page = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const sessionOptions = page.match(/<details class="menu">([\s\S]*?)<\/details>/);
assert.ok(sessionOptions, 'the dashboard has a session options submenu');
assert.doesNotMatch(sessionOptions[1], /id="grokKeyNote"/, 'provider-key copy is not shown');
assert.doesNotMatch(sessionOptions[1], /class="menu-hint"/, 'explanatory paragraphs are not shown');
assert.match(sessionOptions[1], /id="effortLabel"/, 'the reasoning label remains');
assert.match(sessionOptions[1], /id="effortSelect"/, 'the reasoning selector remains');
assert.match(sessionOptions[1], /id="effortNote"/, 'unsupported providers have a status note');
const css = fs.readFileSync(__dirname + '/../style.css', 'utf8');
assert.match(css, /\.effort-note\s*\{[^}]*color:\s*var\(--h-menu-label/, 'the provider note is muted');

(async () => {
    // Groups render; the current model carries the active mark.
    const options = sandbox.document.getElementById('modelMenu').querySelectorAll('.model-option');
    assert.equal(options.length, 6);
    const groupLabels = sandbox.document.getElementById('modelMenu').querySelectorAll('.menu-group-label').map(label => label.textContent);
    assert.deepEqual(groupLabels, ['OLLAMA', 'LOCAL']);
    const active = sandbox.document.getElementById('modelMenu').querySelectorAll('.model-option').filter(o => o.dataset.model === 'beam:cloud');
    assert.equal(active.length, 1);
    assert.ok(active[0]._classes.has('active'));
    // Escape closes the menu; clicking the toggle reopens it.
    toggle.click();
    assert.equal(menu.hidden, false);
    evaluate('cachedConfig = { reasoning_effort: "xhigh", grok_key: true }; applyReasoningControls()');
    assert.equal(sandbox.document.getElementById('effortSelect').value, 'xhigh');
    assert.equal(sandbox.document.getElementById('effortSelect').disabled, true);
    assert.equal(sandbox.document.getElementById('effortNote').textContent, 'currently unsupported (model default used).');
    documentListeners.keydown({ key: 'Escape' });
    assert.equal(menu.hidden, true);
    // While a run is in flight every option is disabled.
    evaluate('runningSid = "run-1"; syncModelMenu()');
    for (const o of sandbox.document.getElementById('modelMenu').querySelectorAll('.model-option')) assert.equal(o.disabled, true);
    assert.equal(toggle.disabled, true);
    // ...and back to enabled once it settles.
    evaluate('runningSid = null; syncModelMenu()');
    for (const o of sandbox.document.getElementById('modelMenu').querySelectorAll('.model-option')) assert.equal(o.disabled, false);
    assert.equal(toggle.disabled, false);
    // Switching posts /model and updates the toggle text.
    sandbox.fetch = async (url, options) => {
        assert.equal(url, '/model');
        assert.equal(JSON.parse(options.body).model, 'llama3.2:3b');
        return { ok: true, status: 200, json: async () => ({ model: 'llama3.2:3b' }) };
    };
    await evaluate(`switchModel('llama3.2:3b')`);
    assert.equal(toggle.textContent, 'llama3.2:3b');
    assert.equal(refreshConfigCalls, 1);
    assert.equal(statusLog[statusLog.length - 1], 'Model switched to llama3.2:3b');
    assert.equal(menu.hidden, true);
    // A 409 (server-side busy guard) keeps the menu open with a note.
    sandbox.fetch = async () => ({ status: 409, text: async () => 'A run is in flight' });
    await evaluate(`switchModel('beam:cloud')`);
    const err = sandbox.document.getElementById('modelMenuError');
    assert.equal(err.style.display, '');
    assert.match(err.textContent, /run is in flight/i);
    // An empty LOCAL group says so, and still renders the cloud models.
    evaluate(`
        modelMenuBuilt = false;
        const menu = document.getElementById('modelMenu');
        menu.children.length = 0;
        menu.setAttribute('data-groups', JSON.stringify([
            { group: 'OLLAMA', models: ['beam:cloud'] },
            { group: 'LOCAL', models: [] },
            { group: 'GROK', models: ['grok-4.7'] },
            { group: 'REFLECTION', models: ['Beam-1.0-501B-A23B'] },
            { group: 'OPENCODE', models: ['opencode/grok-4.7'] }
        ]));
        buildModelMenu();
    `);
    const hints = sandbox.document.getElementById('modelMenu').querySelectorAll('.model-menu-hint');
    assert.ok(hints.some(hint => hint.textContent === 'No local chat models listed.'));
    assert.equal(
        sandbox.document.getElementById('modelMenu').querySelectorAll('.model-option').length,
        4
    );
    const effort = sandbox.document.getElementById('effortSelect');
    const effortLabel = sandbox.document.getElementById('effortLabel');
    const effortNote = sandbox.document.getElementById('effortNote');
    toggle.textContent = 'beam:cloud';
    evaluate('syncModelMenu()');
    assert.equal(effort.disabled, true);
    assert.equal(effortLabel.textContent, 'Reasoning effort');
    assert.equal(effortNote.textContent, 'currently unsupported (model default used).');
    toggle.textContent = 'grok-4.7';
    evaluate('syncModelMenu()');
    assert.equal(effort.disabled, false);
    assert.equal(effortLabel.textContent, 'Grok reasoning effort');
    assert.equal(effortNote.textContent, '');
    toggle.textContent = 'Beam-1.0-501B-A23B';
    evaluate('syncModelMenu()');
    assert.equal(effort.disabled, false);
    assert.equal(effortLabel.textContent, 'Beam reasoning effort');
    assert.equal(effortNote.textContent, '');
    toggle.textContent = 'opencode/grok-4.7';
    evaluate('syncModelMenu()');
    assert.equal(effort.disabled, true);
    assert.equal(effortLabel.textContent, 'Reasoning effort');
    assert.equal(
        effortNote.textContent,
        'currently unsupported (model default used). Reasoning adjustment available directly in OpenCode.'
    );
    let unsupportedEffortRequests = 0;
    sandbox.fetch = async () => { unsupportedEffortRequests += 1; };
    await evaluate('switchEffort("high")');
    assert.equal(unsupportedEffortRequests, 0, 'disabled providers do not post effort changes');
    sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => ({ model: 'grok-4.7' }) });
    await evaluate('switchModel("grok-4.7")');
    assert.equal(effort.disabled, false, 'a model switch updates the control immediately');
    assert.equal(effortLabel.textContent, 'Grok reasoning effort');
    // "Make Default" appears only when the current model differs from the
    // saved default, and posts /default-model.
    evaluate('cachedConfig = { default_model: "beam:cloud" }');
    toggle.textContent = 'grok-4.7';
    evaluate('syncModelMenu()');
    assert.equal(evaluate('defaultLinkEl ? defaultLinkEl.textContent : null'), 'Make Default');
    sandbox.fetch = async (url, options) => {
        assert.equal(url, '/default-model');
        assert.equal(JSON.parse(options.body).model, 'grok-4.7');
        return { ok: true, status: 200, json: async () => ({ default_model: 'grok-4.7' }) };
    };
    await evaluate('defaultLinkEl.onclick({ preventDefault() {} })');
    assert.equal(evaluate('cachedConfig.default_model'), 'grok-4.7');
    // current === default now, so the link is gone.
    evaluate('syncModelMenu()');
    assert.equal(evaluate('defaultLinkEl'), null);
    console.log('modelmenu.test.js OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
