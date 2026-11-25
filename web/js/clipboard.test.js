// clipboard.test.js — copy and paste go through the OS clipboard.
// A copy button writes with execCommand('copy') and clipboard.writeText.
// A paste gesture inserts clipboardData into the field. Nothing is kept
// in a page-local clipboard.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Files spliced into the page script must not contain a script end tag.
// The HTML parser would close the inline script and print the rest as text.
for (const name of fs.readdirSync(__dirname)) {
    if (!name.endsWith('.js') || name.endsWith('.test.js')) continue;
    const src = fs.readFileSync(path.join(__dirname, name), 'utf8');
    assert.equal(src.toLowerCase().includes('</script'), false, name);
}
for (const name of fs.readdirSync(path.join(__dirname, '..', 'vendor'))) {
    if (!name.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(__dirname, '..', 'vendor', name), 'utf8');
    assert.equal(src.toLowerCase().includes('</script'), false, name);
}

class Element {
    constructor(tag) {
        this.tagName = tag;
        this.style = {};
        this.children = [];
        this.value = '';
        this.textContent = '';
        this.disabled = false;
        this.readOnly = false;
        this.type = 'text';
        this.parentNode = null;
    }
    appendChild(child) {
        if (child) child.parentNode = this;
        this.children.push(child);
        return child;
    }
    remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
    }
    removeChild(child) {
        const index = this.children.indexOf(child);
        if (index >= 0) this.children.splice(index, 1);
        if (child) child.parentNode = null;
        return child;
    }
    focus() { document.activeElement = this; this.focused = true; }
    select() { this.selected = true; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    setAttribute() {}
    setRangeText(text, start, end) {
        this.value = this.value.slice(0, start) + text + this.value.slice(end);
        this.selectionStart = start + text.length;
        this.selectionEnd = this.selectionStart;
    }
    dispatchEvent(event) { this.lastEvent = event && event.type; }
}
const listeners = {};
const document = {
    activeElement: null,
    body: new Element('body'),
    createElement(tag) { return new Element(tag); },
    addEventListener(type, fn) { listeners[type] = fn; },
    execCommand(cmd) {
        document.lastCommand = cmd;
        document.copied = document.activeElement ? document.activeElement.value : '';
        return cmd === 'copy';
    }
};
let written = null;
let readResult = 'from-os';
const sandbox = {
    document,
    navigator: {
        clipboard: {
            writeText(text) { written = text; return Promise.resolve(); },
            readText() { return Promise.resolve(readResult); }
        }
    },
    Promise,
    Event: function Event(type) { this.type = type; },
    setTimeout() {},
    setStatus(msg) { sandbox.statusMsg = msg; }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(__dirname + '/core.js', 'utf8'), sandbox);

const box = new Element('textarea');
box.value = 'keep SELECTED tail';
box.selectionStart = 5;
box.selectionEnd = 13;
sandbox.insertClipboardText(box, 'PASTED');
assert.equal(box.value, 'keep PASTED tail');
assert.equal(box.lastEvent, 'input');

const pasted = {
    target: box,
    clipboardData: { getData: type => type === 'text/plain' ? 'menu text' : '' },
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }
};
box.value = 'before';
box.selectionStart = 6;
box.selectionEnd = 6;
listeners.paste(pasted);
assert.equal(pasted.defaultPrevented, true);
assert.equal(box.value, 'beforemenu text');

const disabled = new Element('textarea');
disabled.disabled = true;
disabled.value = 'locked';
const blocked = {
    target: disabled,
    clipboardData: { getData: () => 'nope' },
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }
};
listeners.paste(blocked);
assert.equal(blocked.defaultPrevented, false);
assert.equal(disabled.value, 'locked');

const emptyPaste = {
    target: box,
    clipboardData: { getData: () => '' },
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }
};
const beforeEmpty = box.value;
listeners.paste(emptyPaste);
assert.equal(emptyPaste.defaultPrevented, false);
assert.equal(box.value, beforeEmpty);

(async () => {
    const ok = await sandbox.writeOsClipboard('round text');
    assert.equal(ok, true);
    assert.equal(document.copied, 'round text');
    assert.equal(written, 'round text');
    assert.equal(document.body.children.length, 0);

    document.execCommand = () => false;
    written = null;
    const viaApi = await sandbox.writeOsClipboard('api text');
    assert.equal(viaApi, true);
    assert.equal(written, 'api text');

    sandbox.navigator.clipboard.writeText = () => Promise.reject(new Error('blocked'));
    document.execCommand = () => false;
    const failed = await sandbox.writeOsClipboard('nope');
    assert.equal(failed, false);

    const field = new Element('textarea');
    field.value = 'abc';
    field.selectionStart = 3;
    field.selectionEnd = 3;
    readResult = 'os paste';
    assert.equal(await sandbox.pasteIntoField(field), true);
    assert.equal(field.value, 'abcos paste');

    readResult = '';
    assert.equal(await sandbox.pasteIntoField(field), 'empty');

    sandbox.navigator.clipboard.readText = () => Promise.reject(new Error('blocked'));
    const unchanged = field.value;
    assert.equal(await sandbox.pasteIntoField(field), false);
    assert.equal(field.value, unchanged);

    const btn = new Element('button');
    btn.textContent = 'copy';
    document.execCommand = () => true;
    sandbox.navigator.clipboard.writeText = text => { written = text; return Promise.resolve(); };
    await sandbox.copyText('button text', btn);
    assert.equal(btn.textContent, 'copied!');
    assert.equal(written, 'button text');
    console.log('clipboard.test.js OK');
})().catch(err => {
    console.error(err);
    process.exit(1);
});
