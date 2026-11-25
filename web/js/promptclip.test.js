// promptclip.test.js — the prompt textarea clip: long assembled context
// (e.g. content continued from an earlier session) defaults to 8
// scrollable lines instead of auto-fitting to full height, and the
// adjacent strip toggles show-full/clip on demand.
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
        this.disabled = false;
        const cls = new Set();
        this.classList = {
            add: c => cls.add(c),
            contains: c => cls.has(c),
            remove: c => cls.delete(c),
        };
    }
    appendChild(child) { this.children.push(child); return child; }
    focus() { this.focused = true; }
    addEventListener() {}
    setRangeText() {}
}
const elements = new Map();
const fakeDocument = {
    getElementById(id) {
        if (!elements.has(id)) elements.set(id, new Element('div'));
        return elements.get(id);
    },
    createElement: tag => new Element(tag),
    body: new Element('body'),
};
const sandbox = {
    document: fakeDocument,
    editorSlot: '',
    composerDraft: '',
    activeSession: () => null,
    runningSid: null,
    promptExpanded: false,
    statusMsg: '',
    setStatus: m => { sandbox.statusMsg = m; },
    renderTabBar: () => {},
    persistDebounced: () => {},
};
const ctx = vm.createContext(sandbox);
// PROMPT_CLIP_LINES lives in tabs.js; declare it here so prompt.js sees the
// same threshold value the served page has.
vm.runInContext('const PROMPT_CLIP_LINES = 8;', ctx);
vm.runInContext(fs.readFileSync(__dirname + '/prompt.js', 'utf8'), ctx);
const box = fakeDocument.getElementById('prompt');
const strip = fakeDocument.getElementById('promptClipStrip');
const btn = fakeDocument.getElementById('clipPromptBtn');

(async () => {
    // Long prompt: clipped by default, 8-line territory, toggle visible.
    box.value = Array.from({ length: 12 }, (_, i) => 'context line ' + i).join('\n');
    vm.runInContext('refreshPromptBox()', ctx);
    assert.equal(box.classList.contains('prompt-clipped'), true, 'long prompts default clipped');
    assert.equal(strip.style.display, '', 'clip strip shows for long prompts');
    assert.equal(btn.textContent, 'show full prompt');
    // Clipping never alters the value itself.
    assert.equal(box.value.split('\n').length, 12);

    // Expand through the strip toggle.
    btn.onclick();
    assert.equal(box.classList.contains('prompt-clipped'), false, 'toggle expands');
    assert.equal(btn.textContent, 'clip prompt (8 lines)');
    assert.equal(strip.style.display, '');

    // And back again.
    btn.onclick();
    assert.equal(box.classList.contains('prompt-clipped'), true);
    assert.equal(btn.textContent, 'show full prompt');

    // Short prompts: no strip, no clip class — full auto-fit as before.
    box.value = 'short prompt';
    vm.runInContext('refreshPromptBox()', ctx);
    assert.equal(box.classList.contains('prompt-clipped'), false);
    assert.equal(strip.style.display, 'none');
    // Long again: still defaults to clipped after new content arrives.
    box.value = 'x\n'.repeat(30);
    vm.runInContext('refreshPromptBox()', ctx);
    assert.equal(box.classList.contains('prompt-clipped'), true);

    const mem = new Map();
    sandbox.localStorage = {
        getItem: key => mem.has(key) ? mem.get(key) : null,
        setItem: (key, value) => { mem.set(key, String(value)); },
        removeItem: key => { mem.delete(key); },
    };
    sandbox.session = { status: 'fresh', prompt: 'keep me' };
    sandbox.activeSession = () => sandbox.session;
    sandbox.runningSid = null;
    box.value = 'abcdef';
    box.selectionStart = 1;
    box.selectionEnd = 4;
    box.value = '==== TOOL RESULT (round 1) HID: 9 ====\nlisted\n';
    box.selectionStart = box.value.indexOf('listed');
    box.selectionEnd = box.selectionStart + 'listed'.length;
    await vm.runInContext('document.getElementById("compactPromptBtn").onclick()', ctx);
    assert.match(box.value, /HID: 9/);
    assert.match(box.value, /\[ctx compacted\]/);
    assert.equal(box.value.includes('listed'), false);
    assert.match(sandbox.statusMsg, /HID 9/);
    box.value = '';
    await vm.runInContext('document.getElementById("compactPromptBtn").onclick()', ctx);
    assert.equal(box.value, '');
    assert.match(sandbox.statusMsg, /The prompt is empty/);

    box.value = 'keep me';
    vm.runInContext('clearPromptBox()', ctx);
    assert.equal(box.value, '');
    assert.equal(sandbox.session.prompt, '');
    assert.equal(mem.get('harness.prompt.undo'), 'keep me');
    assert.match(sandbox.statusMsg, /Restore can put it back/);
    vm.runInContext('restorePromptBox()', ctx);
    assert.equal(box.value, 'keep me');
    assert.equal(sandbox.session.prompt, 'keep me');
    assert.equal(mem.get('harness.prompt.undo'), 'keep me', 'restore leaves the snapshot stored');
    box.value = 'newer';
    mem.set('harness.prompt.undo', 'older');
    vm.runInContext('restorePromptBox()', ctx);
    assert.equal(box.value, 'older');
    assert.equal(mem.get('harness.prompt.undo'), 'older', 'restore does not swap the box into the snapshot');
    box.value = '';
    vm.runInContext('flushPromptSnapshot()', ctx);
    assert.equal(mem.get('harness.prompt.undo'), 'older', 'an empty box does not erase the snapshot');
    box.value = 'autosaved';
    sandbox._timer = null;
    sandbox.setTimeout = (fn, ms) => { sandbox._timer = { fn, ms }; return 1; };
    sandbox.clearTimeout = () => { sandbox._timer = null; };
    vm.runInContext('schedulePromptSnapshot()', ctx);
    assert.equal(sandbox._timer.ms, 3000);
    sandbox._timer.fn();
    assert.equal(mem.get('harness.prompt.undo'), 'autosaved');
    mem.set('harness.prompt.autosave', '0');
    box.value = 'should-not-save';
    sandbox._timer = null;
    vm.runInContext('schedulePromptSnapshot()', ctx);
    assert.equal(sandbox._timer, null, 'autosave off does not schedule a copy');
    vm.runInContext('flushPromptSnapshot()', ctx);
    assert.equal(mem.get('harness.prompt.undo'), 'autosaved', 'autosave off does not replace the snapshot');
    vm.runInContext('clearPromptBox()', ctx);
    assert.equal(box.value, '');
    assert.equal(mem.get('harness.prompt.undo'), 'should-not-save', 'clear still stores the box when autosave is off');
    mem.set('harness.prompt.autosave', '1');
    sandbox.session.status = 'done';
    sandbox.session.prompt = 'archived';
    box.disabled = false;
    box.value = 'locked';
    vm.runInContext('clearPromptBox()', ctx);
    assert.equal(box.value, '', 'clear empties the composer on a finished chain');
    assert.equal(sandbox.session.prompt, 'archived', 'clear leaves the submitted prompt on the session');
    assert.match(sandbox.statusMsg, /Restore can put it back/);

    sandbox.session.status = 'fresh';
    sandbox.pageSelectionText = () => 'selected paragraph';
    box.value = 'draft';
    sandbox.session.prompt = 'draft';
    vm.runInContext('curateSelection()', ctx);
    assert.equal(box.value, 'draft\n\nselected paragraph\n');
    assert.equal(box.value.includes('===='), false);
    sandbox.pageSelectionText = () => '   ';
    vm.runInContext('curateSelection()', ctx);
    assert.equal(box.value, 'draft\n\nselected paragraph\n');
    assert.match(sandbox.statusMsg, /Nothing selected/);

    // The pastePromptBox/pasteBtn path is gone: the button never existed
    // in the page, so the feature was unreachable in production and the
    // test exercised dead wiring.
    console.log('Prompt box clip tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
