// archive.test.js — long archived prompts use the tinted round window
// (clipped body, click-anywhere expand, "click to condense" once open).
// Loads tabs.js alone: archivePrompt has no other live dependencies
// (copyText fires only on click).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
    constructor(tag) {
        this.tag = tag;
        this.style = {};
        this.children = [];
        this.textContent = '';
        const cls = new Set();
        this.classList = {
            add: c => cls.add(c),
            contains: c => cls.has(c),
            toggle: c => { if (cls.has(c)) { cls.delete(c); return false; } cls.add(c); return true; },
        };
    }
    appendChild(child) { this.children.push(child); return child; }
    insertBefore(node) { this.children.unshift(node); return node; }
    get firstChild() { return this.children[0]; }
}
const fakeDocument = {
    createElement: tag => new Element(tag),
    body: new Element('body'),
};
const sandbox = { document: fakeDocument, copyText: () => {}, apiFetch: async () => ({ ok: true, json: async () => ({}) }) };
const ctx = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(__dirname + '/tabs.js', 'utf8'), ctx);

(async () => {
    // Short prompt: no toggle at all.
    const short = { prompt: 'one\ntwo', nodes: { container: new Element('div'), rounds: new Map() } };
    sandbox.src = short;
    vm.runInContext('archivePrompt(src)', ctx);
    const shortHead = short.nodes.container.children[0].children[0];
    const shortBody = short.nodes.container.children[0].children[1];
    assert.equal(shortBody.classList.contains('prompt-condensed'), false);
    assert.equal(shortBody.classList.contains('round-condensed'), false);
    // Head holds exactly the h3 heading and the copy button.
    assert.equal(shortHead.children.length, 2);
    assert.equal(shortHead.children[0].textContent, '◉ PROMPT (archived)');

    // Long prompt: the same tinted window as a history round.
    const lines = [];
    for (let i = 0; i < 20; i++) lines.push('assembled context line ' + i);
    const s = { prompt: lines.join('\n'), nodes: { container: new Element('div'), rounds: new Map() } };
    sandbox.src = s;
    vm.runInContext('archivePrompt(src)', ctx);
    const sec = s.nodes.container.children[0];
    const head = sec.children[0];
    const body = sec.children[1];
    assert.equal(body.classList.contains('round-body'), true);
    assert.equal(body.classList.contains('round-condensed'), true, 'long prompts start condensed');
    assert.equal(body.classList.contains('prompt-condensed'), false);
    assert.equal(body.textContent, s.prompt);
    const hit = body.children[0];
    assert.equal(hit.className, 'round-expand-hit');
    assert.equal(hit.title, 'click to expand');
    const tg = head.children[2];
    assert.equal(tg.textContent, 'click to condense');
    assert.equal(tg.style.display, 'none');
    const bottom = sec.children[2];
    assert.match(bottom.textContent, /click to expand/);
    hit.onclick();
    assert.equal(body.classList.contains('round-condensed'), false, 'clicking the window expands');
    assert.equal(tg.style.display, '');
    assert.equal(tg.textContent, 'click to condense');
    assert.equal(bottom.textContent, 'click to condense');
    tg.onclick();
    assert.equal(body.classList.contains('round-condensed'), true, 'click to condense re-condenses');
    assert.equal(tg.style.display, 'none');
    assert.match(bottom.textContent, /click to expand/);
    console.log('Archived prompt condense/expand tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
