// shellformat.test.js — display-only shell prettifier. Assert behavior
// and data, never display wording: the parts join back to the input byte
// for byte, quoted separators never split, and the raw view the toggle
// restores is the byte-identical source.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
    constructor(tag) {
        this.tagName = tag;
        this.style = {};
        this.children = [];
        this.className = '';
        this._text = '';
        this.type = '';
        this.onclick = null;
        this.classList = {
            toggle: (name, force) => {
                const names = String(this.className || '').split(/\s+/).filter(Boolean);
                const has = names.includes(name);
                const on = force === undefined ? !has : !!force;
                const next = names.filter(part => part !== name);
                if (on) next.push(name);
                this.className = next.join(' ');
            },
            contains: (name) => String(this.className || '').split(/\s+/).includes(name),
        };
    }
    get textContent() {
        if (this.children.length) return this.children.map(child => child.textContent || '').join('');
        return this._text;
    }
    set textContent(value) {
        this.children = [];
        this._text = value == null ? '' : String(value);
    }
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
    remove() {
        if (this.parentNode) {
            const list = this.parentNode.children;
            const at = list.indexOf(this);
            if (at >= 0) list.splice(at, 1);
        }
    }
    cloneNode() {
        const copy = new Element(this.tagName);
        copy.className = this.className;
        copy._text = this._text;
        copy.style = Object.assign({}, this.style);
        for (const child of this.children) copy.appendChild(child.cloneNode(true));
        return copy;
    }
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
};
const sandbox = {
    document,
    WeakMap, Uint32Array, Map, JSON, Math, Object, Array, String, Number, Error,
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout() {},
    window: { innerHeight: 800, scrollY: 0, scrollTo() {} },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(__dirname + '/core.js', 'utf8'), sandbox);
const evaluate = (code) => vm.runInContext(code, sandbox);

// The parts join back to the input byte for byte: the formatter only
// inserts whitespace at the breaks, so nothing can be hidden or forged
// by prettifying.
const samples = [
    'ls -la && git commit -m "two words" | tee log.txt',
    "echo 'a | b && c' && echo done",
    'cat file | grep -v x || echo none; rm -f t',
    'echo a\\&&b',
    'single command with no connectors',
    'printf "%s" "\\u202E"',
];
for (const sample of samples) {
    const parts = evaluate(`shellCommandParts(${JSON.stringify(sample)})`);
    assert.equal(
        parts.map(part => part.connector + part.text).join(''),
        sample,
        `parts must rejoin byte-identically: ${JSON.stringify(sample)}`
    );
}

// Quoted connectors stay inside their segment.
assert.equal(evaluate(`shellCommandParts("echo 'a | b' && echo done").length`), 2);
assert.equal(evaluate(`shellCommandParts('echo "x && y"; ls').length`), 2);
// A backslash-escaped connector does not split.
assert.equal(evaluate(`shellCommandParts("echo a\\\\&&b").length`), 1);

// A command with no connectors is unchanged apart from edge whitespace.
assert.equal(
    evaluate(`prettyShellForDisplay("  git status  ")`),
    'git status'
);
// Connectors move to continuation lines; the values stay.
const pretty = evaluate(`prettyShellForDisplay("ls && echo hi | wc")`);
assert.equal(pretty, 'ls\n  && echo hi\n  | wc');

// The raw two-argument composition is byte-identical to the raw view:
// display-only pretty must never enter the copy/curate text.
const args = { command: 'ls && echo a | wc', task: 'counting' };
const raw = evaluate(`formatToolCallText('run_cmd', ${JSON.stringify(args)})`);
const rawFromPretty = evaluate(`formatToolCallText('run_cmd', ${JSON.stringify(args)}, false)`);
assert.equal(rawFromPretty, raw);
const prettyCall = evaluate(`formatToolCallText('run_cmd', ${JSON.stringify(args)}, true)`);
assert.ok(prettyCall.includes('command:\nls\n  && echo a\n  | wc'), prettyCall);
assert.ok(prettyCall.includes(raw.split('Arguments: ')[1]), 'the Arguments block is unchanged');

// paintShellView: the raw child is byte-identical and the toggle flips
// which view is visible.
evaluate(`
    var __container = document.createElement('div');
    paintShellView(__container, 'RAW TEXT && one', 'RAW TEXT\\n  && one');
`);
assert.equal(evaluate(`__container.children[0].className`), 'view-toggle');
assert.equal(evaluate(`__container.children[1].className`), 'shell-pretty');
assert.equal(evaluate(`__container.children[2].className`), 'shell-raw');
assert.equal(evaluate(`__container.children[2].textContent`), 'RAW TEXT && one');
assert.equal(evaluate(`__container.children[1].children[0].textContent`), 'RAW TEXT\n  && one');
assert.equal(evaluate(`__container.children[2].style.display`), 'none');
assert.equal(evaluate(`__container.children[1].style.display`), '');
evaluate(`__container.children[0].onclick()`);
assert.equal(evaluate(`__container.children[2].style.display`), '');
assert.equal(evaluate(`__container.children[2].textContent`), 'RAW TEXT && one');
evaluate(`__container.children[0].onclick()`);
assert.equal(evaluate(`__container.children[2].style.display`), 'none');

console.log('shell format tests passed');
