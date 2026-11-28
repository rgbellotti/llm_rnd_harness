// vim.test.js — small Vim mode for harness textareas. Loads vim.js, then
// tabs.js to confirm the config checkbox is a browser preference.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(__dirname + '/vim.js', 'utf8');
const tabsSource = fs.readFileSync(__dirname + '/tabs.js', 'utf8');

function makeEl(tag) {
    const node = {
        tagName: String(tag || 'div').toUpperCase(),
        style: {},
        children: [],
        value: '',
        checked: false,
        disabled: false,
        readOnly: false,
        id: '',
        className: '',
        type: '',
        title: '',
        textContent: '',
        appendChild(child) { this.children.push(child); return child; },
        append(...children) { this.children.push(...children); }
    };
    Object.defineProperty(node, 'innerHTML', {
        configurable: true,
        get() { return ''; },
        set(value) { if (!value) node.children = []; }
    });
    return node;
}

function load(store) {
    const timers = [];
    let nextTimer = 1;
    const listeners = [];
    const saved = store || {};
    const badge = makeEl('div');
    badge.id = 'vimMode';
    badge.style.display = 'none';
    const configView = makeEl('div');
    configView.id = 'configView';
    const docsView = makeEl('div');
    docsView.id = 'docsView';
    const document = {
        activeElement: null,
        getElementById(id) {
            if (id === 'vimMode') return badge;
            if (id === 'configView') return configView;
            if (id === 'docsView') return docsView;
            return null;
        },
        createElement(tag) { return makeEl(tag); },
        createTextNode(text) { const n = makeEl('text'); n.textContent = text; return n; },
        addEventListener(type, fn) { listeners.push({ type, fn }); }
    };
    const sandbox = {
        document,
        localStorage: {
            getItem(k) { return Object.prototype.hasOwnProperty.call(saved, k) ? saved[k] : null; },
            setItem(k, v) { saved[k] = String(v); },
            removeItem(k) { delete saved[k]; }
        },
        setTimeout(fn) {
            const id = nextTimer++;
            timers.push({ id, fn });
            return id;
        },
        clearTimeout(id) {
            const i = timers.findIndex(t => t.id === id);
            if (i >= 0) timers.splice(i, 1);
        },
        runningSid: null
    };
    const ctx = vm.createContext(sandbox);
    vm.runInContext(source, ctx);
    function box(value, pos) {
        const el = makeEl('textarea');
        el.value = value;
        el.selectionStart = pos;
        el.selectionEnd = pos;
        el.selectionDirection = 'none';
        el.setSelectionRange = function (start, end) {
            this.selectionStart = start;
            this.selectionEnd = end;
        };
        el.setRangeText = function (text, start, end) {
            this.value = this.value.slice(0, start) + text + this.value.slice(end);
            const caret = start + text.length;
            this.selectionStart = caret;
            this.selectionEnd = caret;
            for (const listener of listeners) {
                if (listener.type === 'input') listener.fn({ target: this });
            }
        };
        return el;
    }
    function press(el, key, extra) {
        const event = Object.assign({
            key: key,
            target: el,
            ctrlKey: false,
            metaKey: false,
            altKey: false,
            shiftKey: false,
            isComposing: false,
            defaultPrevented: false,
            stopped: false,
            preventDefault() { this.defaultPrevented = true; },
            stopPropagation() { this.stopped = true; }
        }, extra || {});
        sandbox.vimOnKeyDown(event);
        return event;
    }
    function flushTimers() {
        const due = timers.splice(0, timers.length);
        for (const timer of due) timer.fn();
    }
    function listener(type) {
        return listeners.find(item => item.type === type);
    }
    return { sandbox, ctx, badge, configView, docsView, saved, box, press, flushTimers, listener };
}

function classes(el) {
    const names = new Set();
    el.classList = {
        add(name) { names.add(name); },
        remove(name) { names.delete(name); },
        contains(name) { return names.has(name); }
    };
    return el;
}

function caret(el) {
    assert.equal(el.selectionStart, el.selectionEnd);
    return el.selectionStart;
}

// Stored preference is read when the script loads. A missing key is on.
{
    const on = load({});
    assert.equal(on.sandbox.vimEditingEnabled(), true);
    const explicit = load({ 'harness.vim': '1' });
    assert.equal(explicit.sandbox.vimEditingEnabled(), true);
    const off = load({ 'harness.vim': '0' });
    assert.equal(off.sandbox.vimEditingEnabled(), false);
}
{
    const timers = [];
    const sandbox = {
        document: { addEventListener() {}, getElementById() { return null; } },
        localStorage: { getItem() { throw new Error('denied'); } },
        setTimeout(fn) { timers.push(fn); return 1; },
        clearTimeout() {}
    };
    vm.runInContext(source, vm.createContext(sandbox));
    assert.equal(sandbox.vimEditingEnabled(), true);
}

const harness = load({});
const { sandbox, badge, box, press, flushTimers, listener, configView, docsView, saved, ctx } = harness;
const evaluate = code => vm.runInContext(code, ctx);

assert.equal(typeof sandbox.vimOnKeyDown, 'function');
assert.equal(sandbox.vimEditingEnabled(), true);

// An explicit off leaves the textarea to the browser.
sandbox.vimSetEnabled(false);
assert.equal(saved['harness.vim'], '0');
{
    const el = box('ab\ncd', 0);
    const event = press(el, 'j');
    assert.equal(event.defaultPrevented, false);
    assert.equal(caret(el), 0);
    assert.equal(el.value, 'ab\ncd');
    assert.equal(badge.style.display, 'none');
}

sandbox.vimSetEnabled(true);
assert.equal(saved['harness.vim'], '1');
assert.equal(sandbox.vimEditingEnabled(), true);

// Motions. The caret sits between characters, so $ is after the last
// character of the line and h/l stay inside the line.
{
    const text = 'abcde\nfg\nhijkl';
    const el = box(text, 2);
    press(el, 'j');
    assert.equal(caret(el), 8);
    press(el, 'j');
    assert.equal(caret(el), 11);
    press(el, 'k');
    assert.equal(caret(el), 8);
    press(el, 'k');
    assert.equal(caret(el), 2);
    press(el, 'h');
    assert.equal(caret(el), 1);
    press(el, '0');
    assert.equal(caret(el), 0);
    press(el, 'h');
    assert.equal(caret(el), 0);
    press(el, '$');
    assert.equal(caret(el), 5);
    press(el, 'l');
    assert.equal(caret(el), 5);
    press(el, 'l');
    assert.equal(caret(el), 5);
    // Second line: 0 and $ stay on that line.
    el.selectionStart = el.selectionEnd = 4;
    // 'fg' is indexes 6 and 7. Move there first.
    el.selectionStart = el.selectionEnd = 7;
    press(el, '0');
    assert.equal(caret(el), 6);
    press(el, '$');
    assert.equal(caret(el), 8);
    press(el, 'G');
    assert.equal(caret(el), text.length);
    press(el, 'G');
    assert.equal(caret(el), text.length);
    press(el, 'g');
    assert.equal(badge.textContent, 'vim g');
    press(el, 'g');
    assert.equal(caret(el), 0);
    assert.equal(badge.textContent, 'vim normal');
    press(el, 'g');
    press(el, 'j');
    assert.equal(caret(el), 6);
    assert.equal(badge.textContent, 'vim normal');
    press(el, 'g');
    press(el, 'G');
    assert.equal(caret(el), text.length);
}

// A leading newline is its own line. j from the start enters the next one.
{
    const el = box('\nabc', 0);
    press(el, 'k');
    assert.equal(caret(el), 0);
    press(el, 'j');
    assert.equal(caret(el), 1);
}

// Words, including a punctuation run and a line break.
{
    const el = box('one two  three', 0);
    press(el, 'w');
    assert.equal(caret(el), 4);
    press(el, 'w');
    assert.equal(caret(el), 9);
    press(el, 'b');
    assert.equal(caret(el), 4);
    press(el, 'l');
    press(el, 'b');
    assert.equal(caret(el), 4);
    press(el, 'b');
    assert.equal(caret(el), 0);
    const punct = box('foo, bar', 0);
    press(punct, 'w');
    assert.equal(caret(punct), 3);
    press(punct, 'w');
    assert.equal(caret(punct), 5);
    press(punct, 'b');
    assert.equal(caret(punct), 3);
    press(punct, 'b');
    assert.equal(caret(punct), 0);
    const lines = box('one\ntwo', 0);
    press(lines, 'w');
    assert.equal(caret(lines), 4);
    press(lines, 'b');
    assert.equal(caret(lines), 0);
}

// Open a line, then insert. jj and Esc leave insert.
// Esc on a caret at column 0 leaves insert without moving that caret,
// so the next command starts in normal mode.
function leaveInsert() {
    press(box('x', 0), 'Escape');
}
{
    const el = box('ab\ncd', 1);
    press(el, 'o');
    assert.equal(el.value, 'ab\n\ncd');
    assert.equal(caret(el), 3);
    assert.equal(badge.textContent, 'vim insert');
    leaveInsert();
    const below = box('ab\ncd', 3);
    press(below, 'O');
    assert.equal(below.value, 'ab\n\ncd');
    assert.equal(caret(below), 3);
    assert.equal(badge.textContent, 'vim insert');
    leaveInsert();
    const above = box('ab\ncd', 1);
    press(above, 'O');
    assert.equal(above.value, '\nab\ncd');
    assert.equal(caret(above), 0);
    leaveInsert();
    const empty = box('', 0);
    press(empty, 'o');
    assert.equal(empty.value, '\n');
    assert.equal(caret(empty), 1);
    leaveInsert();
    const emptyAbove = box('', 0);
    press(emptyAbove, 'O');
    assert.equal(emptyAbove.value, '\n');
    assert.equal(caret(emptyAbove), 0);
}

// setRangeText does not emit input in this browser. The prompt box
// mirrors on input, so an open still has to dispatch one.
{
    leaveInsert();
    sandbox.Event = function Event(type) { this.type = type; };
    const el = box('ab', 2);
    const notes = [];
    el.setRangeText = function (text, start, end) {
        this.value = this.value.slice(0, start) + text + this.value.slice(end);
        const caret = start + text.length;
        this.selectionStart = this.selectionEnd = caret;
    };
    el.dispatchEvent = function (event) { notes.push(event.type); };
    press(el, 'o');
    assert.deepEqual(notes, ['input']);
    assert.equal(el.value, 'ab\n');
    assert.equal(caret(el), 3);
}

{
    leaveInsert();
    const el = box('hi', 2);
    press(el, 'i');
    assert.equal(badge.textContent, 'vim insert');
    const typed = press(el, 'a');
    assert.equal(typed.defaultPrevented, false);
    assert.equal(el.value, 'hi');
    press(el, 'j');
    assert.equal(el.value, 'hij');
    assert.equal(caret(el), 3);
    assert.equal(badge.textContent, 'vim insert');
    const between = press(el, 'z');
    assert.equal(between.defaultPrevented, false);
    press(el, 'j');
    assert.equal(el.value, 'hijj');
    assert.equal(badge.textContent, 'vim insert');
    press(el, 'j');
    assert.equal(el.value, 'hij');
    assert.equal(caret(el), 3);
    assert.equal(badge.textContent, 'vim normal');
    press(el, 'i');
    press(el, 'j');
    assert.equal(el.value, 'hijj');
    flushTimers();
    assert.equal(badge.textContent, 'vim insert');
    press(el, 'j');
    assert.equal(el.value, 'hijjj');
    assert.equal(badge.textContent, 'vim insert');
    const esc = box('hij', 3);
    press(esc, 'i');
    press(esc, 'Escape');
    assert.equal(esc.value, 'hij');
    assert.equal(caret(esc), 3);
    assert.equal(badge.textContent, 'vim normal');
    const chord = box('', 0);
    press(chord, 'i');
    press(chord, 'j');
    assert.equal(chord.value, 'j');
    press(chord, 'j');
    assert.equal(chord.value, '');
    assert.equal(caret(chord), 0);
    assert.equal(badge.textContent, 'vim normal');
}

// Visual selection is the textarea selection. A native edit leaves visual.
{
    const el = box('hello world', 0);
    press(el, 'v');
    assert.equal(badge.textContent, 'vim visual');
    press(el, 'w');
    assert.equal(el.selectionStart, 0);
    assert.equal(el.selectionEnd, 6);
    assert.equal(el.value.slice(0, 6), 'hello ');
    press(el, 'v');
    assert.equal(caret(el), 6);
    assert.equal(badge.textContent, 'vim normal');
    const line = box('hello', 0);
    press(line, 'v');
    press(line, 'l');
    assert.equal(line.selectionStart, 0);
    assert.equal(line.selectionEnd, 1);
    press(line, 'Escape');
    assert.equal(caret(line), 1);
    assert.equal(badge.textContent, 'vim normal');
    const backward = box('hello', 0);
    backward.selectionStart = 1;
    backward.selectionEnd = 4;
    backward.selectionDirection = 'backward';
    press(backward, 'v');
    press(backward, 'l');
    assert.equal(backward.selectionStart, 2);
    assert.equal(backward.selectionEnd, 4);
    assert.equal(backward.selectionDirection, 'backward');
    press(backward, 'Escape');
    const shifted = box('hello world\nnext', 0);
    press(shifted, 'v');
    const shift = press(shifted, 'Shift');
    assert.equal(shift.defaultPrevented, false);
    assert.equal(badge.textContent, 'vim visual');
    press(shifted, '$', { shiftKey: true });
    assert.equal(shifted.selectionStart, 0);
    assert.equal(shifted.selectionEnd, 11);
    assert.equal(badge.textContent, 'vim visual');
    press(shifted, 'Escape');
    const shiftedEnd = box('one\ntwo\nthree', 0);
    press(shiftedEnd, 'v');
    press(shiftedEnd, 'Shift');
    press(shiftedEnd, 'G', { shiftKey: true });
    assert.equal(shiftedEnd.selectionStart, 0);
    assert.equal(shiftedEnd.selectionEnd, shiftedEnd.value.length);
    assert.equal(badge.textContent, 'vim visual');
    press(shiftedEnd, 'Escape');
    const native = box('hello', 0);
    press(native, 'v');
    listener('input').fn({ target: native });
    assert.equal(badge.textContent, 'vim normal');
}

// Unmapped printing keys are swallowed. Browser editing keys are not.
{
    const el = box('hello', 1);
    const x = press(el, 'x');
    assert.equal(x.defaultPrevented, true);
    assert.equal(el.value, 'hllo');
    assert.equal(caret(el), 1);
    const y = press(el, 'y');
    assert.equal(y.defaultPrevented, true);
    assert.equal(el.value, 'hllo');
    const back = press(el, 'Backspace');
    assert.equal(back.defaultPrevented, false);
    assert.equal(back.stopped, false);
    const copy = press(el, 'c', { ctrlKey: true });
    assert.equal(copy.defaultPrevented, false);
    assert.equal(copy.stopped, false);
    const enter = press(el, 'Enter');
    assert.equal(enter.defaultPrevented, true);
    assert.equal(el.value, 'hllo');
    press(el, 'i');
    const inserted = press(el, 'Enter');
    assert.equal(inserted.defaultPrevented, false);
    const run = press(el, 'Enter', { ctrlKey: true });
    assert.equal(run.defaultPrevented, false);
    assert.equal(run.stopped, false);
    const arrow = press(el, 'ArrowLeft');
    assert.equal(arrow.defaultPrevented, false);
}

// Read-only fields, other elements, and a textarea created after install.
{
    const locked = box('ab\ncd', 0);
    locked.readOnly = true;
    const event = press(locked, 'j');
    assert.equal(event.defaultPrevented, false);
    assert.equal(caret(locked), 0);
    const div = makeEl('div');
    const ignored = press(div, 'j');
    assert.equal(ignored.defaultPrevented, false);
    leaveInsert();
    const later = box('ab\ncd', 0);
    press(later, 'j');
    assert.equal(caret(later), 3);
}

// The mode label follows focus and a click leaves visual mode.
{
    const el = box('hello', 0);
    listener('focusin').fn({ target: el });
    assert.equal(badge.style.display, '');
    assert.equal(badge.textContent, 'vim insert');
    press(el, 'Escape');
    assert.equal(badge.textContent, 'vim normal');
    press(el, 'v');
    assert.equal(badge.textContent, 'vim visual');
    listener('mousedown').fn({ target: el });
    assert.equal(badge.textContent, 'vim normal');
    listener('focusout').fn({ target: el });
    assert.equal(badge.style.display, 'none');
    assert.equal(badge.textContent, '');
    const quiet = box('hello', 0);
    quiet.readOnly = true;
    listener('focusin').fn({ target: quiet });
    assert.equal(badge.style.display, 'none');
}

// The prompt starts in insert on focus. Esc and jj enter the motion keys.
// Normal and visual mark the box for a block caret. Insert clears it.
{
    const el = classes(box('ab\ncd', 1));
    el.id = 'prompt';
    listener('focusin').fn({ target: el });
    assert.equal(badge.textContent, 'vim insert');
    assert.equal(el.classList.contains('vim-block'), false);
    const typed = press(el, 'z');
    assert.equal(typed.defaultPrevented, false);
    press(el, 'Escape');
    assert.equal(badge.textContent, 'vim normal');
    assert.equal(el.classList.contains('vim-block'), true);
    assert.equal(caret(el), 1);
    press(el, 'j');
    assert.equal(caret(el), 4);
    press(el, 'v');
    assert.equal(badge.textContent, 'vim visual');
    assert.equal(el.classList.contains('vim-block'), true);
    press(el, 'i');
    assert.equal(el.classList.contains('vim-block'), false);
    press(el, 'j');
    press(el, 'j');
    assert.equal(el.value, 'ab\ncd');
    assert.equal(caret(el), 4);
    assert.equal(badge.textContent, 'vim normal');
    assert.equal(el.classList.contains('vim-block'), true);
    listener('focusout').fn({ target: el });
    assert.equal(el.classList.contains('vim-block'), false);
}

// A clipped prompt scrolls with the caret. Layout is absent here, so the
// fallback counts newlines. G lands on the last line and gg returns to the top.
{
    const lines = [];
    for (let i = 0; i < 40; i++) lines.push('line ' + i + ' of the continued prompt');
    const text = lines.join('\n');
    const el = box(text, 0);
    el.id = 'prompt';
    el.className = 'prompt-clipped';
    el.scrollTop = 0;
    el.clientHeight = 160;
    el.scrollHeight = 800;
    sandbox.window = {
        innerWidth: 800,
        getComputedStyle() {
            return {
                lineHeight: '20px', fontSize: '14px',
                paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px',
                whiteSpace: 'pre-wrap'
            };
        }
    };
    press(el, 'j');
    assert.equal(caret(el), text.indexOf('\n') + 1);
    assert.equal(el.scrollTop, 0);
    press(el, 'G');
    assert.equal(caret(el), text.length);
    assert.equal(el.scrollTop, 640);
    press(el, 'g');
    press(el, 'g');
    assert.equal(caret(el), 0);
    assert.equal(el.scrollTop, 0);
    for (let i = 0; i < 12; i++) press(el, 'j');
    assert.ok(el.scrollTop > 0);
    const plain = box('ab\ncd', 0);
    press(plain, 'j');
    assert.equal(caret(plain), 3);
    delete sandbox.window;
}

// Upward Visual motion keeps the active end on vimHead. Otherwise native
// textarea scrolling follows the stationary lower anchor and stops at the
// selection's bottom edge instead of following the cursor upward.
{
    const lines = [];
    for (let i = 0; i < 40; i++) lines.push('line ' + i + ' of the continued prompt');
    const text = lines.join('\n');
    const el = box(text, text.indexOf('line 20'));
    el.scrollTop = 240;
    el.clientHeight = 160;
    el.scrollHeight = 800;
    sandbox.window = {
        getComputedStyle() {
            return {
                lineHeight: '20px', fontSize: '14px',
                paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px',
                whiteSpace: 'pre-wrap'
            };
        }
    };
    evaluate('vimPreferredCol = null');
    press(el, 'v');
    for (let i = 0; i < 10; i++) press(el, 'k');
    assert.equal(el.selectionStart, text.indexOf('line 10'));
    assert.equal(el.selectionEnd, text.indexOf('line 20'));
    assert.equal(el.selectionDirection, 'backward');
    assert.equal(el.scrollTop, 200, 'upward Visual motion scrolls with vimHead');
    for (let i = 0; i < 10; i++) press(el, 'j');
    assert.equal(el.selectionStart, text.indexOf('line 20'));
    assert.equal(el.selectionEnd, text.indexOf('line 20'));
    assert.equal(el.selectionDirection, 'forward');
    assert.ok(el.scrollTop > 200, 'downward Visual motion still reveals the cursor');
    delete sandbox.window;
}

// d deletes a highlighted selection. dd deletes the caret's line.
// One d, then the gap, leaves the text alone. x deletes that character.
{
    leaveInsert();
    const highlighted = box('hello world', 0);
    highlighted.selectionStart = 0;
    highlighted.selectionEnd = 5;
    press(highlighted, 'd');
    assert.equal(highlighted.value, ' world');
    assert.equal(caret(highlighted), 0);
    assert.equal(badge.textContent, 'vim normal');
    const visual = box('hello world', 0);
    press(visual, 'v');
    press(visual, 'w');
    press(visual, 'd');
    assert.equal(visual.value, 'world');
    assert.equal(caret(visual), 0);
    assert.equal(badge.textContent, 'vim normal');
    const mid = box('one\ntwo\nthree', 4);
    press(mid, 'd');
    assert.equal(mid.value, 'one\ntwo\nthree');
    assert.equal(badge.textContent, 'vim d');
    press(mid, 'd');
    assert.equal(mid.value, 'one\nthree');
    assert.equal(caret(mid), 4);
    const first = box('one\ntwo', 1);
    press(first, 'd');
    press(first, 'd');
    assert.equal(first.value, 'two');
    assert.equal(caret(first), 0);
    const last = box('one\ntwo', 5);
    press(last, 'd');
    press(last, 'd');
    assert.equal(last.value, 'one');
    assert.equal(caret(last), 3);
    const only = box('only', 1);
    press(only, 'd');
    press(only, 'd');
    assert.equal(only.value, '');
    assert.equal(caret(only), 0);
    const lone = box('keep', 1);
    press(lone, 'd');
    assert.equal(badge.textContent, 'vim d');
    flushTimers();
    assert.equal(lone.value, 'keep');
    assert.equal(badge.textContent, 'vim d');
    press(lone, 'Escape');
    assert.equal(lone.value, 'keep');
    assert.equal(badge.textContent, 'vim normal');
    press(lone, 'x');
    assert.equal(lone.value, 'kep');
    assert.equal(caret(lone), 1);
    const typing = box('ab', 2);
    press(typing, 'i');
    const typed = press(typing, 'd');
    assert.equal(typed.defaultPrevented, false);
    const replacing = box('hello', 0);
    press(replacing, 'i');
    replacing.selectionStart = 1;
    replacing.selectionEnd = 4;
    const removed = press(replacing, 'd');
    assert.equal(removed.defaultPrevented, true);
    assert.equal(replacing.value, 'ho');
    assert.equal(caret(replacing), 1);
    assert.equal(badge.textContent, 'vim insert');
}

// x deletes the character under the cursor, or a selection.
// a appends after the cursor and enters insert.
{
    leaveInsert();
    const el = box('hello', 1);
    press(el, 'x');
    assert.equal(el.value, 'hllo');
    assert.equal(caret(el), 1);
    assert.equal(badge.textContent, 'vim normal');
    const end = box('hello', 5);
    press(end, 'x');
    assert.equal(end.value, 'hello');
    assert.equal(caret(end), 5);
    const selected = box('hello', 0);
    selected.selectionStart = 1;
    selected.selectionEnd = 4;
    press(selected, 'x');
    assert.equal(selected.value, 'ho');
    assert.equal(caret(selected), 1);
    assert.equal(badge.textContent, 'vim normal');
    const append = box('hello', 1);
    press(append, 'a');
    assert.equal(append.value, 'hello');
    assert.equal(caret(append), 2);
    assert.equal(badge.textContent, 'vim insert');
    leaveInsert();
    const after = box('hello', 5);
    press(after, 'a');
    assert.equal(caret(after), 5);
    assert.equal(badge.textContent, 'vim insert');
    leaveInsert();
    const range = box('hello', 0);
    range.selectionStart = 1;
    range.selectionEnd = 4;
    press(range, 'a');
    assert.equal(range.value, 'hello');
    assert.equal(caret(range), 4);
    assert.equal(badge.textContent, 'vim insert');
    const typing = box('ab', 1);
    press(typing, 'i');
    const typed = press(typing, 'x');
    assert.equal(typed.defaultPrevented, false);
    const replacing = box('hello', 0);
    press(replacing, 'i');
    replacing.selectionStart = 1;
    replacing.selectionEnd = 4;
    const removed = press(replacing, 'x');
    assert.equal(removed.defaultPrevented, true);
    assert.equal(replacing.value, 'ho');
    assert.equal(caret(replacing), 1);
    assert.equal(badge.textContent, 'vim insert');
}

// Counts, operators, and the motions a native session actually uses.
// Operator-pending waits until Esc or a motion. It does not expire.
{
    leaveInsert();
    const down = box('aa\nbb\ncc\ndd', 0);
    press(down, '2');
    press(down, 'j');
    assert.equal(caret(down), down.value.indexOf('cc'));
    const words = box('one two three', 0);
    press(words, '2');
    press(words, 'w');
    assert.equal(caret(words), 8);
    press(words, 'b');
    assert.equal(caret(words), 4);
    const end = box('one two', 0);
    press(end, 'e');
    assert.equal(caret(end), 2);
    press(end, 'g');
    press(end, 'e');
    assert.equal(caret(end), 0);
    const big = box('one two,three', 0);
    press(big, 'W');
    assert.equal(caret(big), 4);
    press(big, 'E');
    assert.equal(caret(big), 12);
    const indent = box('  code', 4);
    press(indent, '^');
    assert.equal(caret(indent), 2);
    const find = box('abcba', 0);
    press(find, 'f');
    press(find, 'b');
    assert.equal(caret(find), 1);
    press(find, ';');
    assert.equal(caret(find), 3);
    press(find, ',');
    assert.equal(caret(find), 1);
    const pair = box('(ab)', 0);
    press(pair, '%');
    assert.equal(caret(pair), 3);
    const paras = box('aa\n\nbb', 0);
    press(paras, '}');
    assert.equal(caret(paras), 4);
    const lines = box('one\ntwo\nthree\nfour', 0);
    press(lines, '2');
    press(lines, 'd');
    press(lines, 'd');
    assert.equal(lines.value, 'three\nfour');
    assert.equal(caret(lines), 0);
    const word = box('one two', 0);
    press(word, 'd');
    press(word, 'w');
    assert.equal(word.value, 'two');
    assert.equal(caret(word), 0);
    const tail = box('hello', 1);
    press(tail, 'D');
    assert.equal(tail.value, 'h');
    const inner = box('say hello world', 5);
    press(inner, 'd');
    press(inner, 'i');
    press(inner, 'w');
    assert.equal(inner.value, 'say  world');
    const yank = box('one\ntwo', 1);
    press(yank, 'y');
    press(yank, 'y');
    assert.equal(yank.value, 'one\ntwo');
    press(yank, 'p');
    assert.equal(yank.value, 'one\none\ntwo');
    const undone = box('hello', 1);
    press(undone, 'x');
    assert.equal(undone.value, 'hllo');
    press(undone, 'u');
    assert.equal(undone.value, 'hello');
    assert.equal(caret(undone), 1);
    press(undone, 'r');
    press(undone, 'a');
    assert.equal(undone.value, 'hallo');
    const search = box('One two one', 0);
    press(search, '/');
    press(search, 'o');
    press(search, 'n');
    press(search, 'e');
    press(search, 'Enter');
    assert.equal(caret(search), 8);
    press(search, 'n');
    assert.equal(caret(search), 0);
    const jumped = box('a\nb\nc', 0);
    press(jumped, '2');
    press(jumped, 'G');
    assert.equal(caret(jumped), 2);
    const append = box('hi', 0);
    press(append, 'A');
    assert.equal(caret(append), 2);
    assert.equal(badge.textContent, 'vim insert');
    leaveInsert();
    const bol = box('  hi', 4);
    press(bol, 'I');
    assert.equal(caret(bol), 2);
    assert.equal(badge.textContent, 'vim insert');
}

// A large prompt must not be copied into a DOM node on each caret query.
// Unwrapped ASCII uses the line index. The font probe is a ten-character sample.
{
    leaveInsert();
    const lengths = [];
    const orig = sandbox.document.createTextNode;
    sandbox.document.createTextNode = function (text) {
        lengths.push(String(text).length);
        return orig.call(sandbox.document, text);
    };
    sandbox.document.body = {
        children: [],
        appendChild(child) { this.children.push(child); return child; },
        removeChild(child) { return child; }
    };
    sandbox.document.createRange = function () {
        return {
            setStart() {},
            setEnd() {},
            getBoundingClientRect() {
                return { top: 2, left: 4, width: 80, height: 16, right: 84, bottom: 18 };
            }
        };
    };
    sandbox.window = {
        innerWidth: 800,
        getComputedStyle() {
            return {
                lineHeight: '20px', fontSize: '14px', fontFamily: 'monospace', fontWeight: '400',
                paddingTop: '0px', paddingRight: '8px', paddingBottom: '0px', paddingLeft: '8px',
                whiteSpace: 'pre-wrap', overflowWrap: 'normal', tabSize: '8', letterSpacing: 'normal',
                borderLeftWidth: '0px', borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px',
                color: '#aaa'
            };
        }
    };
    const lines = [];
    for (let i = 0; i < 400; i++) lines.push('line ' + i + ' short');
    const text = lines.join('\n');
    const el = box(text, 0);
    el.clientWidth = 420;
    el.clientHeight = 160;
    el.scrollHeight = 8000;
    el.scrollTop = 0;
    const first = sandbox.vimMeasureCaret(el, 0);
    const afterProbe = lengths.length;
    sandbox.vimMeasureCaret(el, 6);
    assert.ok(first && first.top === 0, 'arithmetic caret has a top');
    assert.ok(lengths.every(function (n) { return n <= 10; }), 'no prefix copy into a text node');
    assert.equal(lengths.length, afterProbe, 'a second query does not build another probe');
    sandbox.document.createTextNode = orig;
    delete sandbox.document.body;
    delete sandbox.document.createRange;
    delete sandbox.window;
}

// Insert-mode j and o must not scroll from a hard-newline count. A live
// box has width; measurement is absent here, so a guess would jump upward.
{
    leaveInsert();
    sandbox.window = {
        getComputedStyle() {
            return {
                lineHeight: '20px', fontSize: '14px',
                paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px',
                whiteSpace: 'pre-wrap'
            };
        }
    };
    const typing = box('alpha\nbeta\ngamma', 0);
    typing.clientWidth = 320;
    typing.clientHeight = 40;
    typing.scrollHeight = 800;
    typing.scrollTop = 480;
    press(typing, 'i');
    press(typing, 'j');
    assert.equal(typing.value, 'jalpha\nbeta\ngamma');
    assert.equal(typing.scrollTop, 480);
    press(typing, 'j');
    assert.equal(typing.value, 'alpha\nbeta\ngamma');
    assert.equal(badge.textContent, 'vim normal');
    assert.equal(typing.scrollTop, 480);
    assert.equal(caret(typing), 0);
    const opened = box('alpha\nbeta\ngamma', 6);
    opened.clientWidth = 320;
    opened.clientHeight = 40;
    opened.scrollHeight = 800;
    opened.scrollTop = 400;
    press(opened, 'o');
    assert.equal(opened.value, 'alpha\nbeta\n\ngamma');
    assert.equal(caret(opened), 11);
    assert.equal(opened.scrollTop, 400);
    press(opened, 'Escape');
    assert.equal(caret(opened), 11);
    press(opened, 'j');
    assert.equal(caret(opened), 12);
    press(opened, 'k');
    assert.equal(caret(opened), 11);
    press(opened, 'k');
    assert.equal(caret(opened), 6);
    delete sandbox.window;
}

// A column used by j must not stick across insert. Esc and jj stay put.
{
    leaveInsert();
    const el = box('abcdef\nxy', 5);
    press(el, 'h');
    press(el, 'l');
    press(el, 'j');
    assert.equal(caret(el), 9);
    press(el, 'i');
    press(el, 'j');
    press(el, 'j');
    assert.equal(badge.textContent, 'vim normal');
    assert.equal(caret(el), 9);
    press(el, 'k');
    assert.equal(caret(el), 2);
}

sandbox.vimSetEnabled(false);
assert.equal(saved['harness.vim'], '0');
{
    const el = box('ab\ncd', 0);
    const event = press(el, 'j');
    assert.equal(event.defaultPrevented, false);
    assert.equal(caret(el), 0);
    assert.equal(badge.style.display, 'none');
}

// Config checkbox: on while a run is live, and it drives the same pref.
sandbox.runningSid = 'live';
sandbox.vimSetEnabled(true);
vm.runInContext(tabsSource, ctx);
evaluate('cachedConfig = ' + JSON.stringify({
    model: 'local-test', model_cloud: false, max_tool_rounds: null,
    workspace_dir: '/tmp', custom_files: [], system_prompt: 'prompt',
    enabled_tools: [], review_run_cmd: false,
    tools: [], tool_meta: []
}) + '; renderConfig()');

function findId(node, id) {
    if (!node) return null;
    if (node.id === id) return node;
    for (const child of node.children || []) {
        const found = findId(child, id);
        if (found) return found;
    }
    return null;
}
const vimToggle = findId(configView, 'vim-editing');
const reviewToggle = findId(configView, 'review-run-cmd');
evaluate('renderDocs()');
assert.ok(vimToggle, 'config checkbox');
assert.equal(vimToggle.checked, true);
assert.ok(!vimToggle.disabled);
assert.equal(reviewToggle.disabled, true);
assert.equal(findId(configView, 'vim-editing-help'), null);
function helpText(node) {
    let text = node && node.textContent ? node.textContent : '';
    for (const child of (node && node.children) || []) text += helpText(child);
    return text;
}
const vimHelp = helpText(docsView);
// The help text is wording the user rewrites freely: assert the
// rendering behavior, never the sentences.
assert.ok(vimHelp.length > 0, 'the docs render help text');
assert.ok(!vimHelp.includes('`'), 'backticks must render as code, not text');
const helpCodes = [];
function walkHelpCode(node) {
    if (node && node.tagName === 'CODE') helpCodes.push(node.textContent);
    for (const child of (node && node.children) || []) walkHelpCode(child);
}
walkHelpCode(docsView);
assert.ok(helpCodes.length > 0, 'code spans render as code elements');
vimToggle.checked = false;
vimToggle.onchange();
assert.equal(sandbox.vimEditingEnabled(), false);
assert.equal(saved['harness.vim'], '0');
{
    const el = box('ab\ncd', 0);
    const event = press(el, 'j');
    assert.equal(event.defaultPrevented, false);
    assert.equal(caret(el), 0);
}
vimToggle.checked = true;
vimToggle.onchange();
assert.equal(saved['harness.vim'], '1');
{
    const el = box('ab\ncd', 0);
    press(el, 'j');
    assert.equal(caret(el), 3);
}

// The label stays inside the box. A box low on a narrow page used to
// draw it above the border. Returning to a wide screen moves the box
// into the left lane; syncPromptDock measures after that move.
{
    const el = box('lane', 0);
    el.rect = { left: 16, top: 220, right: 1184, bottom: 520, width: 1168, height: 300 };
    el.getBoundingClientRect = function () { return this.rect; };
    sandbox.window = { innerWidth: 1200 };
    sandbox.placed = el;
    evaluate('vimEnabled = true; vimFocused = true; vimMode = "insert"; vimBox = placed; vimSyncChrome();');
    assert.equal(badge.textContent, 'vim insert');
    assert.equal(badge.style.top, '224px');
    assert.notEqual(badge.style.top, '198px');
    assert.equal(badge.style.right, '16px');
    assert.equal(badge.style.left, 'auto');
    assert.equal(badge.style.bottom, 'auto');
    el.rect = { left: 12, top: 8, right: 940, bottom: 900, width: 928, height: 892 };
    sandbox.window.innerWidth = 2000;
    evaluate('syncPromptDock()');
    assert.equal(badge.style.top, '12px');
    assert.equal(badge.style.right, '1060px');
    const parked = badge.style.right;
    el.rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    evaluate('vimPositionBadge(document.getElementById("vimMode"));');
    assert.equal(badge.style.right, parked);
}

console.log('vim textarea tests passed');
