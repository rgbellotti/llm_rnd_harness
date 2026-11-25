// vim.js — optional Vim keys for the harness textareas.
// On by default. The config checkbox stores the choice in this browser
// under localStorage key harness.vim ('0' is off, anything else is on).
// One document listener covers the prompt, the curation box, and textareas
// created later. A clipped prompt keeps the caret in view: setSelectionRange
// during a key does not scroll the box, so the handler sets scrollTop itself.
// That target is a measured caret. Counting hard newlines ignores wrapping
// and jumps the view above the caret. Same-line insert edits leave scrollTop alone.
//
// The caret is the textarea's gap caret. The block drawn in normal and visual
// sits on the character after that gap. $ is after the last character of the
// line. Copy, cut, paste, arrows, Backspace, and Delete stay browser keys.
//
// Geometry: do not rebuild a DOM mirror of the text before the caret on each
// key. A line index plus monospace arithmetic covers unwrapped ASCII. Wrapped
// text uses one persistent mirror, updated when the text or width changes,
// and a Range query against that already-laid-out node. Mouse drags coalesce
// to one query per frame. Undo stores patches, not copies of the whole box,
// and refuses a snapshot above VIM_UNDO_SNAP_MAX.

const VIM_STORE_KEY = 'harness.vim';
const VIM_JJ_MS = 200;
const VIM_COUNT_MAX = 9999;
const VIM_UNDO_MAX = 50;
const VIM_UNDO_BYTES = 2 * 1024 * 1024;
const VIM_UNDO_SNAP_MAX = 512 * 1024;
const VIM_PASS = {
    ArrowLeft: true, ArrowRight: true, ArrowUp: true, ArrowDown: true,
    Home: true, End: true, PageUp: true, PageDown: true,
    Backspace: true, Delete: true, Tab: true,
    Shift: true, Control: true, Alt: true, Meta: true,
    CapsLock: true, ContextMenu: true, Dead: true, Process: true, Unidentified: true
};
const VIM_NUMPAD = {
    Numpad0: '0', Numpad1: '1', Numpad2: '2', Numpad3: '3', Numpad4: '4',
    Numpad5: '5', Numpad6: '6', Numpad7: '7', Numpad8: '8', Numpad9: '9',
    NumpadEnter: 'Enter', NumpadMultiply: '*', NumpadAdd: '+',
    NumpadSubtract: '-', NumpadDecimal: '.'
};

let vimEnabled = false;
let vimInstalled = false;
let vimMode = 'normal';
let vimPending = '';
let vimFocused = false;
let vimBox = null;
let vimAnchor = 0;
let vimHead = 0;
let vimPreferredCol = null;
let vimJjPending = false;
let vimJjTimer = null;
let vimJjBox = null;
let vimCaretBox = null;
let vimBlockNode = null;
let vimCount = 0;
let vimCounting = false;
let vimOp = '';
let vimOpCount = 1;
let vimObj = '';
let vimFind = '';
let vimFindCount = 1;
let vimLastFind = null;
let vimSearch = null;
let vimLastSearch = null;
let vimRegister = '';
let vimRegisterLine = false;
let vimUndoStack = [];
let vimRedoStack = [];
let vimInsertSnap = null;
let vimSuppressUndo = false;
let vimLastChange = null;
let vimBlockFrame = 0;
let vimMeasureCache = null;
let vimIndexCache = null;
let vimMetricsCache = null;
let vimMirror = null;
let vimMirrorText = null;
let vimMirrorKey = '';

function vimEditingEnabled() { return vimEnabled; }

function vimLoadPref() {
    vimEnabled = true;
    try {
        if (typeof localStorage !== 'undefined' && localStorage.getItem(VIM_STORE_KEY) === '0') vimEnabled = false;
    } catch (e) { vimEnabled = true; }
}

function vimCancelOp() {
    vimOp = '';
    vimOpCount = 1;
    vimObj = '';
    vimFind = '';
    vimPending = '';
    vimSearch = null;
    vimCount = 0;
    vimCounting = false;
}

function vimSetEnabled(on) {
    vimEnabled = !!on;
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(VIM_STORE_KEY, vimEnabled ? '1' : '0');
        }
    } catch (e) {}
    vimPreferredCol = null;
    vimClearJj();
    vimCancelOp();
    vimFocused = !!vimActiveTextarea();
    if (vimFocused) vimBox = vimActiveTextarea();
    vimMode = vimFocused ? 'insert' : 'normal';
    if (!vimEnabled) vimDropMirror();
    vimSyncBoxes();
    vimSyncChrome();
}

function vimSyncBoxes() {
    const lane = document.getElementById('vimLaneBox');
    if (lane) lane.checked = vimEnabled;
    const cfg = document.getElementById('vim-editing');
    if (cfg) cfg.checked = vimEnabled;
}

function vimIsTextarea(el) {
    if (!el || typeof el.tagName !== 'string') return false;
    if (el.tagName.toUpperCase() !== 'TEXTAREA') return false;
    if (el.readOnly || el.disabled) return false;
    return true;
}

function vimActiveTextarea() {
    if (typeof document === 'undefined') return null;
    const el = document.activeElement;
    return vimIsTextarea(el) ? el : null;
}

function vimPassKey(key) {
    if (VIM_PASS[key]) return true;
    return /^F\d{1,2}$/.test(key || '');
}

function vimNormalizeKey(key) {
    return VIM_NUMPAD[key] || key || '';
}

function vimEat(e) {
    if (!e) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
}

function vimSelStart(el) {
    return typeof el.selectionStart === 'number' ? el.selectionStart : 0;
}

function vimSelEnd(el) {
    return typeof el.selectionEnd === 'number' ? el.selectionEnd : vimSelStart(el);
}

function vimHeadOf(el) {
    if (vimMode === 'visual' || vimMode === 'visual-line') return vimHead;
    const start = vimSelStart(el);
    const end = vimSelEnd(el);
    if (start === end) return start;
    if (el.selectionDirection === 'backward') return start;
    return end;
}

function vimBump(el) {
    if (!el) return;
    const gen = (vimTextGen(el) || 0) + 1;
    if (typeof el === 'object') {
        try { el._vimGen = gen; } catch (e) {}
    }
    if (vimIndexCache && vimIndexCache.el === el) vimIndexCache = null;
    vimMeasureCache = null;
    vimMirrorKey = '';
}

function vimTextGen(el) {
    return el && typeof el._vimGen === 'number' ? el._vimGen : 0;
}

function vimLineBounds(value, pos) {
    const n = value.length;
    if (pos < 0) pos = 0;
    if (pos > n) pos = n;
    const start = pos === 0 ? 0 : value.lastIndexOf('\n', pos - 1) + 1;
    let end = value.indexOf('\n', pos);
    if (end < 0) end = n;
    return { start: start, end: end };
}

function vimEnsureIndex(el) {
    const value = el.value || '';
    const gen = vimTextGen(el);
    const cached = vimIndexCache;
    if (cached && cached.el === el && cached.gen === gen && cached.len === value.length && cached.starts) {
        return cached;
    }
    let count = 1;
    for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) === 10) count++;
    const starts = new Uint32Array(count);
    let line = 1;
    for (let i = 0; i < value.length; i++) {
        if (value.charCodeAt(i) === 10) starts[line++] = i + 1;
    }
    vimIndexCache = { el: el, gen: gen, len: value.length, starts: starts, count: count, simple: null };
    return vimIndexCache;
}

function vimLineNo(index, pos) {
    const starts = index.starts;
    let lo = 0;
    let hi = index.count - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= pos) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

function vimPlace(el, start, end) {
    const n = (el.value || '').length;
    if (start < 0) start = 0;
    if (end < 0) end = 0;
    if (start > n) start = n;
    if (end > n) end = n;
    if (start > end) {
        const swap = start;
        start = end;
        end = swap;
    }
    try {
        if (typeof el.setSelectionRange === 'function') el.setSelectionRange(start, end);
        else {
            el.selectionStart = start;
            el.selectionEnd = end;
        }
    } catch (e) {
        el.selectionStart = start;
        el.selectionEnd = end;
    }
    vimReveal(el);
}

function vimPx(value) {
    const n = parseFloat(value);
    return n > 0 ? n : 0;
}

function vimLinePx(el) {
    if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return 0;
    let computed;
    try { computed = window.getComputedStyle(el); } catch (e) { return 0; }
    if (!computed) return 0;
    const line = vimPx(computed.lineHeight);
    if (line) return line;
    const font = vimPx(computed.fontSize);
    return font ? font * 1.4 : 0;
}

function vimLineCaretTop(el, pos) {
    const linePx = vimLinePx(el);
    if (!linePx) return null;
    const value = el.value || '';
    const n = Math.min(Math.max(pos, 0), value.length);
    let lines = 0;
    for (let i = 0; i < n; i++) if (value.charCodeAt(i) === 10) lines++;
    let pad = 0;
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        try { pad = vimPx(window.getComputedStyle(el).paddingTop); } catch (e) { pad = 0; }
    }
    return pad + lines * linePx;
}

const VIM_FONT_PROPS = [
    'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'fontFamily',
    'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'tabSize'
];

// Copy the glyph-shaping properties of the textarea onto an overlay node so
// a character it renders lines up with the textarea's own glyph. Shared by
// the measurement mirror and the Vim block cursor.
function vimApplyFont(node, computed) {
    const style = node && node.style;
    if (!style) return;
    for (let i = 0; i < VIM_FONT_PROPS.length; i++) {
        const name = VIM_FONT_PROPS[i];
        const value = computed[name];
        if (value) style[name] = value;
    }
}

// The computed background of a textarea that lets the page show through.
// A silhouette glyph drawn in this color would be invisible, so the block
// cursor falls back to a solid fill when it is transparent.
function vimIsTransparent(color) {
    if (!color || color === 'transparent') return true;
    return color.indexOf('rgba(0, 0, 0, 0') === 0;
}

function vimStyleMirror(node, el, computed) {
    const style = node.style;
    if (!style) return;
    style.position = 'fixed';
    style.visibility = 'hidden';
    style.left = '0';
    style.top = '0';
    style.height = 'auto';
    style.minHeight = '0';
    style.maxHeight = 'none';
    style.overflow = 'hidden';
    style.pointerEvents = 'none';
    style.boxSizing = 'border-box';
    style.border = '0';
    style.width = el.clientWidth + 'px';
    style.paddingTop = computed.paddingTop || '0';
    style.paddingRight = computed.paddingRight || '0';
    style.paddingBottom = computed.paddingBottom || '0';
    style.paddingLeft = computed.paddingLeft || '0';
    vimApplyFont(node, computed);
    style.whiteSpace = el.wrap === 'off' ? 'pre' : (computed.whiteSpace || 'pre-wrap');
    if (computed.overflowWrap) style.overflowWrap = computed.overflowWrap;
    if (computed.wordBreak) style.wordBreak = computed.wordBreak;
}

function vimDropMirror() {
    vimMirrorKey = '';
    if (vimMirrorText) vimMirrorText.nodeValue = '';
    if (vimMirror && vimMirror.parentNode && typeof vimMirror.parentNode.removeChild === 'function') {
        vimMirror.parentNode.removeChild(vimMirror);
    }
}

function vimEnsureMirror(el, computed) {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
    if (typeof document.createTextNode !== 'function') return null;
    if (!document.body || typeof document.body.appendChild !== 'function') return null;
    if (!vimMirror) {
        vimMirror = document.createElement('div');
        if (typeof vimMirror.setAttribute === 'function') vimMirror.setAttribute('aria-hidden', 'true');
        vimMirrorText = document.createTextNode('');
        vimMirror.appendChild(vimMirrorText);
    }
    const value = el.value || '';
    const key = [
        el.clientWidth, vimTextGen(el), value.length,
        computed.fontSize, computed.fontFamily, computed.lineHeight,
        computed.paddingTop, computed.paddingLeft, computed.paddingRight,
        computed.whiteSpace, computed.overflowWrap, computed.tabSize, el.wrap
    ].join('\0');
    vimStyleMirror(vimMirror, el, computed);
    if (vimMirrorKey !== key) {
        vimMirrorText.nodeValue = value;
        vimMirrorKey = key;
    }
    if (vimMirror.parentNode !== document.body) document.body.appendChild(vimMirror);
    return vimMirror;
}

function vimCharMetrics(el, computed) {
    const fontSize = vimPx(computed.fontSize) || 14;
    const linePx = vimPx(computed.lineHeight) || fontSize * 1.4;
    const padLeft = vimPx(computed.paddingLeft);
    const padRight = vimPx(computed.paddingRight);
    const padTop = vimPx(computed.paddingTop);
    const inner = el.clientWidth - padLeft - padRight;
    const tabSize = parseInt(computed.tabSize, 10) || 8;
    const anywhere = computed.overflowWrap === 'anywhere' || computed.overflowWrap === 'break-word' || computed.wordBreak === 'break-all';
    const key = [computed.fontSize, computed.fontFamily, computed.fontWeight, computed.letterSpacing, linePx].join('\0');
    if (vimMetricsCache && vimMetricsCache.key === key && vimMetricsCache.charW > 0) {
        return {
            charW: vimMetricsCache.charW, linePx: linePx, padLeft: padLeft, padRight: padRight,
            padTop: padTop, inner: inner, tabSize: tabSize, anywhere: anywhere
        };
    }
    if (typeof document.createRange !== 'function' || typeof document.createElement !== 'function') return null;
    if (!document.body || typeof document.body.appendChild !== 'function') return null;
    const probe = document.createElement('div');
    vimStyleMirror(probe, el, computed);
    const sample = 'MMMMMMMMMM';
    const sampleNode = document.createTextNode(sample);
    probe.appendChild(sampleNode);
    document.body.appendChild(probe);
    const range = document.createRange();
    let width = 0;
    try {
        range.setStart(sampleNode, 0);
        range.setEnd(sampleNode, sample.length);
        if (typeof range.getBoundingClientRect === 'function') {
            const rect = range.getBoundingClientRect();
            if (rect && rect.width > 0) width = rect.width / sample.length;
        }
    } catch (e) { width = 0; }
    if (probe.parentNode && typeof probe.parentNode.removeChild === 'function') probe.parentNode.removeChild(probe);
    if (!(width > 0)) return null;
    vimMetricsCache = { key: key, charW: width };
    return {
        charW: width, linePx: linePx, padLeft: padLeft, padRight: padRight,
        padTop: padTop, inner: inner, tabSize: tabSize, anywhere: anywhere
    };
}

function vimIndexSimple(el, index, metrics) {
    if (!metrics || !(metrics.charW > 0) || !(metrics.inner > 0)) return false;
    const cols = Math.max(1, Math.floor(metrics.inner / metrics.charW));
    if (index.simple && index.simpleCols === cols) return index.simple === 'plain';
    const value = el.value || '';
    let plain = true;
    for (let line = 0; line < index.count; line++) {
        const start = index.starts[line];
        const end = line + 1 < index.count ? index.starts[line + 1] - 1 : value.length;
        if (end - start > cols) { plain = false; break; }
        for (let i = start; i < end; i++) {
            const c = value.charCodeAt(i);
            if (c === 9 || c > 126) { plain = false; break; }
        }
        if (!plain) break;
    }
    index.simple = plain ? 'plain' : 'rich';
    index.simpleCols = cols;
    return plain;
}

function vimArithmeticCaret(el, pos, computed) {
    const metrics = vimCharMetrics(el, computed);
    if (!metrics) return null;
    const index = vimEnsureIndex(el);
    if (!vimIndexSimple(el, index, metrics)) return null;
    const lineNo = vimLineNo(index, pos);
    const col = Math.max(0, pos - index.starts[lineNo]);
    return {
        top: metrics.padTop + lineNo * metrics.linePx,
        left: metrics.padLeft + col * metrics.charW,
        width: metrics.charW,
        height: metrics.linePx
    };
}

function vimMeasureWithRange(el, pos, computed) {
    if (typeof document.createRange !== 'function') return null;
    const host = vimEnsureMirror(el, computed);
    if (!host || !vimMirrorText || typeof host.getBoundingClientRect !== 'function') return null;
    const value = vimMirrorText.nodeValue || '';
    const at = pos < 0 ? 0 : (pos > value.length ? value.length : pos);
    const range = document.createRange();
    const next = value.charAt(at);
    const glyph = next && next !== '\n' && next !== '\r';
    try {
        range.setStart(vimMirrorText, at);
        range.setEnd(vimMirrorText, glyph ? at + 1 : at);
    } catch (e) {
        return null;
    }
    if (typeof range.getBoundingClientRect !== 'function') return null;
    const rect = range.getBoundingClientRect();
    const box = host.getBoundingClientRect();
    if (!rect || !box || typeof rect.top !== 'number' || typeof box.top !== 'number') return null;
    let top = rect.top - box.top;
    let left = rect.left - box.left;
    let width = rect.width;
    let height = rect.height;
    if (!(height > 0)) return null;
    if (!(width > 0)) {
        const metrics = vimCharMetrics(el, computed);
        width = metrics && metrics.charW ? metrics.charW : 8;
    }
    return { top: top, left: left, width: width, height: height };
}

function vimMeasureCaretRaw(el, pos) {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
    if (typeof document.createTextNode !== 'function') return null;
    if (!document.body || typeof document.body.appendChild !== 'function') return null;
    if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return null;
    if (typeof el.clientWidth !== 'number' || el.clientWidth < 8) return null;
    let computed;
    try { computed = window.getComputedStyle(el); } catch (e) { return null; }
    if (!computed) return null;
    const fast = vimArithmeticCaret(el, pos, computed);
    if (fast) return fast;
    return vimMeasureWithRange(el, pos, computed);
}

function vimMeasureCaret(el, pos) {
    const gen = vimTextGen(el);
    const width = typeof el.clientWidth === 'number' ? el.clientWidth : 0;
    const hit = vimMeasureCache;
    if (hit && hit.el === el && hit.pos === pos && hit.gen === gen && hit.width === width) return hit.metrics;
    const metrics = vimMeasureCaretRaw(el, pos);
    vimMeasureCache = { el: el, pos: pos, gen: gen, width: width, metrics: metrics };
    return metrics;
}

function vimHasLayout(el) {
    return !!(el && typeof el.clientWidth === 'number' && el.clientWidth >= 8);
}

function vimCaretTop(el, pos) {
    const measured = vimMeasureCaret(el, pos);
    if (measured && typeof measured.top === 'number') return measured.top;
    // A live box can wrap. A newline count then scrolls above the caret.
    // Tests with no layout still use that estimate.
    if (vimHasLayout(el)) return null;
    return vimLineCaretTop(el, pos);
}

function vimScrollTarget(scrollTop, client, full, caretTop, linePx, padPx) {
    let next = scrollTop;
    const slack = linePx > 0 ? linePx : 0;
    if (caretTop < scrollTop) next = caretTop;
    else if (caretTop + slack > scrollTop + client) next = caretTop + slack - client;
    if (next < 0) next = 0;
    const max = full > client ? full - client : 0;
    if (next > max) next = max;
    const firstBand = (padPx > 0 ? padPx : 0) + slack;
    if (next > 0 && firstBand > 0 && caretTop < firstBand) next = 0;
    return next;
}

function vimReveal(el) {
    if (!el || typeof el.scrollTop !== 'number') return;
    const client = el.clientHeight;
    const full = el.scrollHeight;
    if (typeof client !== 'number' || typeof full !== 'number' || !(client > 0)) return;
    if (full <= client + 1) return;
    const pos = (vimMode === 'visual' || vimMode === 'visual-line') ? vimHead : vimSelEnd(el);
    const caretTop = vimCaretTop(el, pos);
    if (typeof caretTop !== 'number') return;
    let padPx = 0;
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        try { padPx = vimPx(window.getComputedStyle(el).paddingTop); } catch (e) { padPx = 0; }
    }
    const next = vimScrollTarget(el.scrollTop, client, full, caretTop, vimLinePx(el), padPx);
    if (next !== el.scrollTop) el.scrollTop = next;
}

function vimGo(el, pos, keepCol) {
    const n = (el.value || '').length;
    if (pos < 0) pos = 0;
    if (pos > n) pos = n;
    if (!keepCol) vimPreferredCol = null;
    if (vimMode === 'visual' || vimMode === 'visual-line') {
        vimHead = pos;
        if (vimMode === 'visual-line') {
            const value = el.value || '';
            const a = vimLineBounds(value, vimAnchor);
            const b = vimLineBounds(value, vimHead);
            let start = Math.min(a.start, b.start);
            let end = Math.max(a.end, b.end);
            if (end < value.length) end += 1;
            vimPlace(el, start, end);
        } else {
            vimPlace(el, Math.min(vimAnchor, vimHead), Math.max(vimAnchor, vimHead));
        }
    } else {
        vimPlace(el, pos, pos);
    }
}

function vimHorizontal(el, dir) {
    const value = el.value || '';
    const pos = vimHeadOf(el);
    const bounds = vimLineBounds(value, pos);
    let next = pos + dir;
    if (next < bounds.start) next = bounds.start;
    if (next > bounds.end) next = bounds.end;
    vimGo(el, next, false);
}

function vimStepVertical(value, pos, dir, col) {
    const bounds = vimLineBounds(value, pos);
    if (dir < 0) {
        if (bounds.start === 0) return pos;
        const prev = vimLineBounds(value, bounds.start - 1);
        return prev.start + Math.min(col, prev.end - prev.start);
    }
    if (bounds.end >= value.length) return pos;
    const next = vimLineBounds(value, bounds.end + 1);
    return next.start + Math.min(col, next.end - next.start);
}

function vimVertical(el, dir) {
    const value = el.value || '';
    const pos = vimHeadOf(el);
    const bounds = vimLineBounds(value, pos);
    if (vimPreferredCol == null) vimPreferredCol = pos - bounds.start;
    const steps = Math.abs(dir);
    const sign = dir < 0 ? -1 : 1;
    let next = pos;
    for (let i = 0; i < steps; i++) next = vimStepVertical(value, next, sign, vimPreferredCol);
    vimGo(el, next, true);
}

function vimIsWord(ch) {
    return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '_';
}

function vimIsSpace(ch) {
    return ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v';
}

function vimIsBlank(ch) {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function vimWordForward(value, pos) {
    const n = value.length;
    if (pos >= n) return n;
    let i = pos;
    if (vimIsSpace(value[i])) {
        while (i < n && vimIsSpace(value[i])) i++;
        return i;
    }
    if (vimIsWord(value[i])) {
        while (i < n && vimIsWord(value[i])) i++;
    } else {
        while (i < n && !vimIsWord(value[i]) && !vimIsSpace(value[i])) i++;
    }
    while (i < n && vimIsSpace(value[i])) i++;
    return i;
}

function vimWordBackward(value, pos) {
    if (pos <= 0) return 0;
    let i = pos - 1;
    while (i > 0 && vimIsSpace(value[i])) i--;
    if (vimIsSpace(value[i])) return 0;
    const word = vimIsWord(value[i]);
    while (i > 0) {
        const prev = value[i - 1];
        if (vimIsSpace(prev) || vimIsWord(prev) !== word) break;
        i--;
    }
    return i;
}

function vimBigForward(value, pos) {
    const n = value.length;
    if (pos >= n) return n;
    let i = pos;
    while (i < n && vimIsBlank(value[i])) i++;
    if (i === pos) while (i < n && !vimIsBlank(value[i])) i++;
    while (i < n && vimIsBlank(value[i])) i++;
    return i;
}

function vimBigBackward(value, pos) {
    if (pos <= 0) return 0;
    let i = pos - 1;
    while (i > 0 && vimIsBlank(value[i])) i--;
    if (vimIsBlank(value[i])) return 0;
    while (i > 0 && !vimIsBlank(value[i - 1])) i--;
    return i;
}

function vimWordEnd(value, pos, big) {
    const n = value.length;
    if (pos >= n) return pos;
    let i = pos + 1;
    while (i < n && (big ? vimIsBlank(value[i]) : vimIsSpace(value[i]))) i++;
    if (i >= n) return n;
    if (!big && vimIsWord(value[i])) {
        while (i + 1 < n && vimIsWord(value[i + 1])) i++;
    } else if (!big) {
        while (i + 1 < n && !vimIsWord(value[i + 1]) && !vimIsSpace(value[i + 1])) i++;
    } else {
        while (i + 1 < n && !vimIsBlank(value[i + 1])) i++;
    }
    return i;
}

function vimSameToken(a, b) {
    if (!a || !b || vimIsSpace(a) || vimIsSpace(b)) return false;
    return vimIsWord(a) === vimIsWord(b);
}

function vimWordEndBack(value, pos) {
    if (pos <= 0) return 0;
    let i = pos - 1;
    while (i > 0 && vimIsSpace(value[i])) i--;
    if (i < 0 || vimIsSpace(value[i])) return 0;
    // Still inside the word under the cursor: skip it, then land on the
    // last character of the word before that.
    if (!vimIsSpace(value[pos]) && vimSameToken(value[i], value[pos])) {
        while (i > 0 && vimSameToken(value[i - 1], value[i])) i--;
        i--;
        while (i > 0 && vimIsSpace(value[i])) i--;
        if (i < 0 || vimIsSpace(value[i])) return 0;
    }
    return i;
}

function vimRepeatMotion(value, pos, count, fn) {
    let i = pos;
    const n = count > 0 ? count : 1;
    for (let step = 0; step < n; step++) i = fn(value, i);
    return i;
}

function vimFirstNonBlank(value, pos) {
    const bounds = vimLineBounds(value, pos);
    let i = bounds.start;
    while (i < bounds.end && (value[i] === ' ' || value[i] === '\t')) i++;
    return i;
}

function vimLineStartAt(value, line1) {
    if (line1 <= 1) return 0;
    let line = 1;
    for (let i = 0; i < value.length; i++) {
        if (value.charCodeAt(i) === 10) {
            line++;
            if (line === line1) return i + 1;
        }
    }
    return value.length;
}

function vimFindChar(value, pos, ch, count, dir, till) {
    const bounds = vimLineBounds(value, pos);
    let found = -1;
    let left = count > 0 ? count : 1;
    if (dir > 0) {
        for (let i = pos + 1; i < bounds.end; i++) {
            if (value[i] === ch) {
                found = till ? i - 1 : i;
                left--;
                if (left === 0) return found;
            }
        }
    } else {
        for (let i = pos - 1; i >= bounds.start; i--) {
            if (value[i] === ch) {
                found = till ? i + 1 : i;
                left--;
                if (left === 0) return found;
            }
        }
    }
    return pos;
}

function vimMatchBracket(value, pos) {
    const pairs = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{' };
    const bounds = vimLineBounds(value, pos);
    let i = pos;
    let ch = value[i];
    if (!pairs[ch]) {
        for (let j = pos; j < bounds.end; j++) {
            if (pairs[value[j]]) { i = j; ch = value[j]; break; }
        }
    }
    if (!pairs[ch]) return pos;
    const goal = pairs[ch];
    const step = '([{'.indexOf(ch) >= 0 ? 1 : -1;
    let depth = 1;
    for (let j = i + step; j >= 0 && j < value.length; j += step) {
        const c = value[j];
        if (c === ch) depth++;
        else if (c === goal) {
            depth--;
            if (depth === 0) return j;
        }
    }
    return pos;
}

function vimBlankLine(value, pos) {
    const bounds = vimLineBounds(value, pos);
    for (let i = bounds.start; i < bounds.end; i++) {
        if (value[i] !== ' ' && value[i] !== '\t') return false;
    }
    return true;
}

function vimParagraph(value, pos, dir) {
    const steps = Math.abs(dir) || 1;
    const sign = dir < 0 ? -1 : 1;
    let i = pos;
    for (let s = 0; s < steps; s++) {
        if (sign > 0) {
            let j = vimLineBounds(value, i).end;
            j = j < value.length ? j + 1 : value.length;
            if (!vimBlankLine(value, i)) {
                while (j < value.length && !vimBlankLine(value, j)) {
                    const nb = vimLineBounds(value, j);
                    j = nb.end < value.length ? nb.end + 1 : value.length;
                }
            }
            while (j < value.length && vimBlankLine(value, j)) {
                const nb = vimLineBounds(value, j);
                j = nb.end < value.length ? nb.end + 1 : value.length;
            }
            i = j;
        } else {
            if (i <= 0) { i = 0; break; }
            let j = vimLineBounds(value, i).start;
            if (j > 0) j = vimLineBounds(value, j - 1).start;
            while (j > 0 && vimBlankLine(value, j)) j = vimLineBounds(value, j - 1).start;
            while (j > 0) {
                const prev = vimLineBounds(value, j - 1);
                if (vimBlankLine(value, prev.start)) break;
                j = prev.start;
            }
            i = j;
        }
    }
    return i;
}

function vimNotify(el) {
    if (typeof el.dispatchEvent !== 'function') return;
    try {
        let event = null;
        if (typeof InputEvent === 'function') event = new InputEvent('input', { bubbles: true });
        else if (typeof Event === 'function') event = new Event('input', { bubbles: true });
        if (event) el.dispatchEvent(event);
    } catch (e) {}
}

function vimTrimUndo() {
    while (vimUndoStack.length > VIM_UNDO_MAX) vimUndoStack.shift();
    let bytes = 0;
    for (let i = 0; i < vimUndoStack.length; i++) {
        bytes += vimUndoStack[i].old.length + vimUndoStack[i].text.length;
    }
    while (vimUndoStack.length > 1 && bytes > VIM_UNDO_BYTES) {
        const dropped = vimUndoStack.shift();
        bytes -= dropped.old.length + dropped.text.length;
    }
}

function vimPushUndo(start, old, text, caret) {
    if (vimSuppressUndo) return;
    vimUndoStack.push({ start: start, old: old, text: text, caret: caret });
    vimRedoStack = [];
    vimTrimUndo();
}

function vimBreaksLine(value, start, end, text) {
    if (text && text.indexOf('\n') >= 0) return true;
    return end > start && value.slice(start, end).indexOf('\n') >= 0;
}

function vimReplace(el, start, end, text) {
    const value = el.value || '';
    const n = value.length;
    if (start < 0) start = 0;
    if (end < start) end = start;
    if (start > n) start = n;
    if (end > n) end = n;
    // A same-line insert (the j chord, a pending-j delete) must not scroll.
    // The newline-count estimate jumps a wrapped prompt; restoring the
    // previous scrollTop also undoes a resize listener that resets it.
    const keepScroll = vimMode === 'insert' && !vimBreaksLine(value, start, end, text);
    const savedScroll = keepScroll ? el.scrollTop : null;
    if (vimMode !== 'insert') vimPushUndo(start, value.slice(start, end), text, vimSelStart(el));
    if (typeof el.setRangeText === 'function') {
        el.setRangeText(text, start, end, 'end');
    } else {
        el.value = value.slice(0, start) + text + value.slice(end);
        vimPlace(el, start + text.length, start + text.length);
    }
    vimBump(el);
    vimNotify(el);
    if (keepScroll) {
        if (typeof savedScroll === 'number') el.scrollTop = savedScroll;
        return;
    }
    vimReveal(el);
}

function vimBeginInsertSnap(el) {
    if (vimInsertSnap) return;
    const value = el.value || '';
    if (value.length > VIM_UNDO_SNAP_MAX) {
        vimInsertSnap = { skip: true };
        return;
    }
    vimInsertSnap = { value: value, caret: vimSelStart(el) };
}

function vimCommitInsert(el) {
    const snap = vimInsertSnap;
    vimInsertSnap = null;
    if (!snap || snap.skip || !el) return;
    const after = el.value || '';
    if (snap.value === after) return;
    const before = snap.value;
    let a = 0;
    const min = Math.min(before.length, after.length);
    while (a < min && before.charCodeAt(a) === after.charCodeAt(a)) a++;
    let b = 0;
    while (b < min - a && before.charCodeAt(before.length - 1 - b) === after.charCodeAt(after.length - 1 - b)) b++;
    vimPushUndo(a, before.slice(a, before.length - b), after.slice(a, after.length - b), snap.caret);
}

function vimUndo(el) {
    vimCommitInsert(el);
    const entry = vimUndoStack.pop();
    if (!entry) return;
    const value = el.value || '';
    const end = entry.start + entry.text.length;
    if (value.slice(entry.start, end) !== entry.text) {
        vimUndoStack.push(entry);
        return;
    }
    vimSuppressUndo = true;
    vimMode = 'normal';
    vimReplace(el, entry.start, end, entry.old);
    vimSuppressUndo = false;
    vimRedoStack.push(entry);
    const caret = entry.caret < 0 ? 0 : entry.caret;
    vimPlace(el, caret, caret);
}

function vimRedo(el) {
    const entry = vimRedoStack.pop();
    if (!entry) return;
    const value = el.value || '';
    const end = entry.start + entry.old.length;
    if (value.slice(entry.start, end) !== entry.old) return;
    vimSuppressUndo = true;
    vimReplace(el, entry.start, end, entry.text);
    vimSuppressUndo = false;
    vimUndoStack.push(entry);
    vimPlace(el, entry.start + entry.text.length, entry.start + entry.text.length);
}

function vimYank(text, linewise) {
    vimRegister = text;
    vimRegisterLine = !!linewise;
    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            const pending = navigator.clipboard.writeText(text);
            if (pending && typeof pending.catch === 'function') pending.catch(function () {});
        }
    } catch (e) {}
}

function vimRemember(fn) { vimLastChange = fn; }

function vimOpenLine(el, above) {
    const value = el.value || '';
    const bounds = vimLineBounds(value, vimHeadOf(el));
    const at = above ? bounds.start : bounds.end;
    vimBeginInsertSnap(el);
    vimMode = 'insert';
    vimCancelOp();
    vimPreferredCol = null;
    vimReplace(el, at, at, '\n');
    // setRangeText leaves the caret after the inserted break. O must sit on
    // the new blank line. An explicit place also lets the browser scroll to
    // that caret instead of a hard-newline guess.
    const caret = above ? at : Math.min(at + 1, (el.value || '').length);
    vimPlace(el, caret, caret);
    vimRemember(function () { vimOpenLine(el, above); });
}

function vimClearJj() {
    vimJjPending = false;
    vimJjBox = null;
    if (vimJjTimer != null && typeof clearTimeout === 'function') clearTimeout(vimJjTimer);
    vimJjTimer = null;
}

function vimDeleteSelection(el) {
    const start = vimSelStart(el);
    const end = vimSelEnd(el);
    if (start === end) return false;
    const text = (el.value || '').slice(start, end);
    vimYank(text, text.indexOf('\n') >= 0);
    vimMode = 'normal';
    vimCancelOp();
    vimPreferredCol = null;
    vimReplace(el, start, end, '');
    return true;
}

function vimDeleteChar(el, count, before) {
    const value = el.value || '';
    const pos = vimSelStart(el);
    const n = count > 0 ? count : 1;
    if (before) {
        const bounds = vimLineBounds(value, pos);
        const len = Math.min(n, pos - bounds.start);
        if (len <= 0) return;
        vimYank(value.slice(pos - len, pos), false);
        vimMode = 'normal';
        vimCancelOp();
        vimPreferredCol = null;
        vimReplace(el, pos - len, pos, '');
        return;
    }
    if (pos >= value.length) return;
    const len = Math.min(n, value.length - pos);
    if (len <= 0) return;
    vimYank(value.slice(pos, pos + len), false);
    vimMode = 'normal';
    vimCancelOp();
    vimPreferredCol = null;
    vimReplace(el, pos, pos + len, '');
}

function vimLineSpan(value, pos, count) {
    const first = vimLineBounds(value, pos);
    let last = first;
    let left = Math.max(1, count) - 1;
    while (left > 0 && last.end < value.length) {
        last = vimLineBounds(value, last.end + 1);
        left--;
    }
    let start = Math.min(first.start, last.start);
    let end = Math.max(first.end, last.end);
    if (end < value.length) end += 1;
    else if (start > 0) start -= 1;
    return { start: start, end: end };
}

function vimDeleteLine(el, count) {
    const value = el.value || '';
    if (!value && (!count || count <= 1)) {
        vimMode = 'normal';
        vimCancelOp();
        return;
    }
    const span = vimLineSpan(value, vimHeadOf(el), count || 1);
    vimYank(value.slice(span.start, span.end), true);
    vimMode = 'normal';
    vimCancelOp();
    vimPreferredCol = null;
    vimReplace(el, span.start, span.end, '');
}

function vimAppend(el) {
    const value = el.value || '';
    const start = vimSelStart(el);
    const end = vimSelEnd(el);
    const at = start === end ? Math.min(start + 1, value.length) : end;
    vimBeginInsertSnap(el);
    vimMode = 'insert';
    vimCancelOp();
    vimPreferredCol = null;
    vimPlace(el, at, at);
}

function vimEatPendingJ(el) {
    const pos = vimSelStart(el);
    if (pos !== vimSelEnd(el) || pos < 1) return;
    if ((el.value || '')[pos - 1] !== 'j') return;
    vimReplace(el, pos - 1, pos, '');
}

function vimEditingCaret(el) {
    const start = vimSelStart(el);
    const end = vimSelEnd(el);
    if (start === end) return start;
    if (el.selectionDirection === 'backward') return start;
    return end;
}

function vimLeaveInsert(el) {
    vimCommitInsert(el);
    vimMode = 'normal';
    // Stay on the character the user was editing. A one-character retreat,
    // or a stale preferred column, reads as the caret jumping on Esc.
    const pos = vimEditingCaret(el);
    vimPreferredCol = null;
    vimPlace(el, pos, pos);
}

function vimTakeCount() {
    const n = vimCounting ? vimCount : 0;
    vimCount = 0;
    vimCounting = false;
    return n;
}

function vimPushCount(key) {
    const digit = key.charCodeAt(0) - 48;
    vimCount = Math.min(VIM_COUNT_MAX, vimCount * 10 + digit);
    vimCounting = true;
}

function vimMotionPos(el, kind, count, given, extra) {
    const value = el.value || '';
    const from = vimHeadOf(el);
    const n = count > 0 ? count : 1;
    let pos = from;
    let linewise = false;
    let inclusive = false;
    if (kind === 'h') pos = vimRepeatMotion(value, from, n, function (v, p) {
        const b = vimLineBounds(v, p);
        return p > b.start ? p - 1 : p;
    });
    else if (kind === 'l') pos = vimRepeatMotion(value, from, n, function (v, p) {
        const b = vimLineBounds(v, p);
        return p < b.end ? p + 1 : p;
    });
    else if (kind === 'j' || kind === 'k') {
        const sign = kind === 'j' ? 1 : -1;
        const bounds = vimLineBounds(value, from);
        const col = vimPreferredCol == null ? from - bounds.start : vimPreferredCol;
        pos = from;
        for (let i = 0; i < n; i++) pos = vimStepVertical(value, pos, sign, col);
        linewise = true;
    } else if (kind === 'w') pos = vimRepeatMotion(value, from, n, vimWordForward);
    else if (kind === 'W') pos = vimRepeatMotion(value, from, n, vimBigForward);
    else if (kind === 'b') pos = vimRepeatMotion(value, from, n, vimWordBackward);
    else if (kind === 'B') pos = vimRepeatMotion(value, from, n, vimBigBackward);
    else if (kind === 'e') { pos = vimRepeatMotion(value, from, n, function (v, p) { return vimWordEnd(v, p, false); }); inclusive = true; }
    else if (kind === 'E') { pos = vimRepeatMotion(value, from, n, function (v, p) { return vimWordEnd(v, p, true); }); inclusive = true; }
    else if (kind === 'ge') { pos = vimRepeatMotion(value, from, n, vimWordEndBack); inclusive = true; }
    else if (kind === '0') pos = vimLineBounds(value, from).start;
    else if (kind === '^' || kind === '_') pos = vimFirstNonBlank(value, from);
    else if (kind === '$') {
        let linePos = from;
        for (let i = 1; i < n; i++) {
            const b = vimLineBounds(value, linePos);
            if (b.end >= value.length) break;
            linePos = b.end + 1;
        }
        pos = vimLineBounds(value, linePos).end;
    } else if (kind === 'gg') {
        pos = given ? vimLineStartAt(value, n) : 0;
        linewise = true;
    } else if (kind === 'G') {
        pos = given ? vimLineStartAt(value, n) : value.length;
        linewise = true;
    } else if (kind === 'f' || kind === 't' || kind === 'F' || kind === 'T') {
        const dir = kind === 'F' || kind === 'T' ? -1 : 1;
        const till = kind === 't' || kind === 'T';
        pos = vimFindChar(value, from, extra, n, dir, till);
        inclusive = true;
    } else if (kind === '%') { pos = vimMatchBracket(value, from); inclusive = true; }
    else if (kind === '{') { pos = vimParagraph(value, from, -n); linewise = true; }
    else if (kind === '}') { pos = vimParagraph(value, from, n); linewise = true; }
    else if (kind === '+') {
        pos = from;
        for (let i = 0; i < n; i++) pos = vimStepVertical(value, pos, 1, 0);
        pos = vimFirstNonBlank(value, pos);
    } else if (kind === '-') {
        pos = from;
        for (let i = 0; i < n; i++) pos = vimStepVertical(value, pos, -1, 0);
        pos = vimFirstNonBlank(value, pos);
    }
    return { from: from, pos: pos, linewise: linewise, inclusive: inclusive, kind: kind };
}

function vimApplyRange(el, op, start, end, linewise) {
    const value = el.value || '';
    if (start < 0) start = 0;
    if (end > value.length) end = value.length;
    if (end < start) end = start;
    const text = value.slice(start, end);
    if (op === 'y') {
        vimYank(text, linewise);
        vimMode = 'normal';
        vimPlace(el, start, start);
        return;
    }
    if (!text && op !== 'c') return;
    vimYank(text, linewise);
    if (op === 'c') vimBeginInsertSnap(el);
    vimMode = op === 'c' ? 'insert' : 'normal';
    vimPreferredCol = null;
    vimReplace(el, start, end, '');
    if (op === 'c') vimPlace(el, start, start);
}

function vimApplyMotion(el, op, motion) {
    const value = el.value || '';
    if (motion.linewise) {
        const a = vimLineBounds(value, motion.from);
        const b = vimLineBounds(value, motion.pos);
        let start = Math.min(a.start, b.start);
        let end = Math.max(a.end, b.end);
        if (end < value.length) end += 1;
        else if (start > 0) start -= 1;
        vimApplyRange(el, op, start, end, true);
        return;
    }
    let start = Math.min(motion.from, motion.pos);
    let end = Math.max(motion.from, motion.pos);
    if (motion.inclusive) {
        if (motion.pos >= motion.from) end = Math.min(value.length, motion.pos + 1);
        else {
            start = motion.pos;
            end = Math.min(value.length, motion.from + 1);
        }
    }
    vimApplyRange(el, op, start, end, false);
}

function vimRunMotion(el, kind, extra) {
    // A count typed before the operator is already in vimOpCount. G/gg must
    // still see that a count was given, or 2dG would jump to the end.
    const given = vimCounting || !!(vimOp && vimOpCount > 1);
    const typed = vimTakeCount();
    const motionCount = vimOp ? Math.max(1, vimOpCount * (typed || 1)) : (typed || 1);
    const op = vimOp;
    vimOp = '';
    vimOpCount = 1;
    vimObj = '';
    if (op) {
        const motion = vimMotionPos(el, kind, motionCount, given, extra);
        vimApplyMotion(el, op, motion);
        vimRemember(function () {
            const again = vimMotionPos(el, kind, motionCount, true, extra);
            vimApplyMotion(el, op, again);
        });
        return;
    }
    if (kind === 'j' || kind === 'k') vimVertical(el, kind === 'j' ? motionCount : -motionCount);
    else if (kind === 'h') vimHorizontal(el, -motionCount);
    else if (kind === 'l') vimHorizontal(el, motionCount);
    else {
        const motion = vimMotionPos(el, kind, motionCount, given, extra);
        const keep = kind === 'j' || kind === 'k';
        vimGo(el, motion.pos, keep);
    }
}

function vimTextObject(value, pos, around, kind) {
    const n = value.length;
    if (kind === 'w' || kind === 'W') {
        const big = kind === 'W';
        const isSpace = big ? vimIsBlank : vimIsSpace;
        const isTok = big ? function (ch) { return ch && !vimIsBlank(ch); } : vimIsWord;
        if (pos >= n) return null;
        let i = pos;
        if (!isTok(value[i])) {
            if (!around) {
                let s = i;
                while (s > 0 && isSpace(value[s - 1])) s--;
                let e = i;
                while (e < n && isSpace(value[e])) e++;
                return s === e ? null : { start: s, end: e };
            }
            while (i < n && !isTok(value[i])) i++;
            if (i >= n) return null;
        }
        let s = i;
        while (s > 0 && isTok(value[s - 1])) s--;
        let e = i;
        while (e < n && isTok(value[e])) e++;
        if (around) {
            let t = e;
            while (t < n && isSpace(value[t]) && value[t] !== '\n') t++;
            if (t === e && s > 0) {
                while (s > 0 && isSpace(value[s - 1]) && value[s - 1] !== '\n') s--;
            } else e = t;
        }
        return { start: s, end: e };
    }
    if (kind === '"' || kind === "'" || kind === '`') {
        let open = -1;
        for (let i = pos; i >= 0; i--) if (value[i] === kind) { open = i; break; }
        if (open < 0) return null;
        let close = value.indexOf(kind, Math.max(open + 1, pos + (value[pos] === kind ? 1 : 0)));
        if (close < 0) close = value.indexOf(kind, open + 1);
        if (close < 0) return null;
        return around ? { start: open, end: close + 1 } : { start: open + 1, end: close };
    }
    const mate = { '(': ')', ')': '(', 'b': ')', '[': ']', ']': '[', '{': '}', '}': '{', 'B': '}' };
    const openCh = kind === 'b' ? '(' : kind === 'B' ? '{' : ('([{'.indexOf(kind) >= 0 ? kind : mate[kind]);
    const closeCh = mate[openCh] || mate[kind];
    if (!openCh || !closeCh) return null;
    let depth = 0;
    let open = -1;
    for (let i = pos; i >= 0; i--) {
        if (value[i] === closeCh) depth++;
        else if (value[i] === openCh) {
            if (depth === 0) { open = i; break; }
            depth--;
        }
    }
    if (open < 0) return null;
    depth = 0;
    let close = -1;
    for (let i = open + 1; i < n; i++) {
        if (value[i] === openCh) depth++;
        else if (value[i] === closeCh) {
            if (depth === 0) { close = i; break; }
            depth--;
        }
    }
    if (close < 0) return null;
    return around ? { start: open, end: close + 1 } : { start: open + 1, end: close };
}

function vimFinishObject(el, kind) {
    const around = vimObj === 'a';
    const op = vimOp;
    vimObj = '';
    vimOp = '';
    const span = vimTextObject(el.value || '', vimHeadOf(el), around, kind);
    if (!span) return;
    vimApplyRange(el, op, span.start, span.end, false);
    vimRemember(function () {
        const again = vimTextObject(el.value || '', vimHeadOf(el), around, kind);
        if (again) vimApplyRange(el, op, again.start, again.end, false);
    });
}

function vimPaste(el, before) {
    if (!vimRegister) return;
    const value = el.value || '';
    const pos = vimHeadOf(el);
    if (vimRegisterLine) {
        const bounds = vimLineBounds(value, pos);
        let text = vimRegister;
        if (text.charAt(text.length - 1) !== '\n') text += '\n';
        let at = before ? bounds.start : bounds.end;
        if (!before && bounds.end >= value.length) {
            vimReplace(el, value.length, value.length, '\n' + text.slice(0, -1));
        } else {
            if (!before) at = bounds.end + 1;
            vimReplace(el, at, at, text);
        }
        return;
    }
    const at = before ? pos : Math.min(pos + 1, value.length);
    vimReplace(el, at, at, vimRegister);
    const caret = at + vimRegister.length;
    vimPlace(el, caret, caret);
}

function vimJoin(el, count) {
    const value = el.value || '';
    const lines = Math.max(2, count || 2);
    const first = vimLineBounds(value, vimHeadOf(el));
    let end = first.end;
    let got = 1;
    while (got < lines && end < value.length) {
        end = vimLineBounds(value, end + 1).end;
        got++;
    }
    if (end === first.end) return;
    const parts = value.slice(first.start, end).split('\n');
    const text = parts.map(function (part, i) {
        if (i === 0) return part.replace(/\s+$/, '');
        return part.replace(/^\s+/, '');
    }).join(' ');
    vimReplace(el, first.start, end, text);
}

function vimShift(el, count, outdent) {
    const value = el.value || '';
    const n = Math.max(1, count || 1);
    const first = vimLineBounds(value, vimHeadOf(el));
    let end = first.end;
    for (let i = 1; i < n && end < value.length; i++) end = vimLineBounds(value, end + 1).end;
    const lines = value.slice(first.start, end).split('\n').map(function (line) {
        if (outdent) return line.replace(/^( {1,2}|\t)/, '');
        return '  ' + line;
    });
    vimReplace(el, first.start, end, lines.join('\n'));
}

function vimToggleCase(el, count) {
    const value = el.value || '';
    const pos = vimSelStart(el);
    const n = count > 0 ? count : 1;
    let i = pos;
    let out = '';
    while (i < value.length && out.length < n && value[i] !== '\n') {
        const ch = value[i];
        const up = ch.toUpperCase();
        const lo = ch.toLowerCase();
        out += (ch === lo && ch !== up) ? up : lo;
        i++;
    }
    if (!out) return;
    vimReplace(el, pos, i, out);
    vimPlace(el, i, i);
}

function vimDoReplace(el, ch) {
    vimPending = '';
    const value = el.value || '';
    const pos = vimSelStart(el);
    if (pos >= value.length || value[pos] === '\n') return;
    const n = Math.min(vimFindCount || 1, value.length - pos);
    let end = pos;
    let text = '';
    while (end < pos + n && end < value.length && value[end] !== '\n') {
        text += ch;
        end++;
    }
    if (!text) return;
    vimReplace(el, pos, end, text);
    vimPlace(el, end - 1, end - 1);
    vimRemember(function () { vimFindCount = text.length; vimDoReplace(el, ch); });
}

function vimSearchAt(value, query, from, backward) {
    if (!query) return -1;
    const ignore = query.toLowerCase() === query;
    const q = ignore ? query.toLowerCase() : query;
    const match = function (i) {
        if (i < 0 || i + q.length > value.length) return false;
        if (!ignore) return value.slice(i, i + q.length) === q;
        for (let k = 0; k < q.length; k++) {
            if (value.charAt(i + k).toLowerCase() !== q.charAt(k)) return false;
        }
        return true;
    };
    if (!backward) {
        for (let i = from + 1; i + q.length <= value.length; i++) if (match(i)) return i;
        for (let i = 0; i <= from && i + q.length <= value.length; i++) if (match(i)) return i;
    } else {
        const start = Math.min(from - 1, value.length - q.length);
        for (let i = start; i >= 0; i--) if (match(i)) return i;
        for (let i = value.length - q.length; i > from; i--) if (match(i)) return i;
    }
    return -1;
}

function vimSearchMove(el, backward, count) {
    if (!vimLastSearch || !vimLastSearch.query) return;
    const value = el.value || '';
    let pos = vimHeadOf(el);
    const n = count > 0 ? count : 1;
    const dir = backward ? !vimLastSearch.backward : vimLastSearch.backward;
    for (let i = 0; i < n; i++) {
        const found = vimSearchAt(value, vimLastSearch.query, pos, dir);
        if (found < 0) return;
        pos = found;
    }
    vimGo(el, pos, false);
}

function vimWordUnder(value, pos) {
    if (!value) return '';
    let i = Math.min(pos, value.length - 1);
    if (i < 0 || !vimIsWord(value[i])) return '';
    let s = i;
    while (s > 0 && vimIsWord(value[s - 1])) s--;
    let e = i + 1;
    while (e < value.length && vimIsWord(value[e])) e++;
    return value.slice(s, e);
}

function vimHalfPage(el, dir) {
    const linePx = vimLinePx(el) || 20;
    const client = typeof el.clientHeight === 'number' ? el.clientHeight : 0;
    const lines = client > linePx ? Math.max(1, Math.floor(client / linePx / 2)) : 8;
    vimVertical(el, dir < 0 ? -lines : lines);
}

function vimEnterVisual(el, line) {
    const start = vimSelStart(el);
    const end = vimSelEnd(el);
    if (el.selectionDirection === 'backward') {
        vimAnchor = end;
        vimHead = start;
    } else {
        vimAnchor = start;
        vimHead = end;
    }
    vimMode = line ? 'visual-line' : 'visual';
    vimCancelOp();
    if (line) vimGo(el, vimHead, true);
}

function vimClearBlockCaret(el) {
    if (!el) return;
    if (el.classList && typeof el.classList.remove === 'function') el.classList.remove('vim-block');
    if (el.style) el.style.caretColor = '';
}

function vimHideBlock() {
    if (!vimBlockNode || !vimBlockNode.style) return;
    vimBlockNode.style.display = 'none';
}

function vimEnsureBlock() {
    if (vimBlockNode) return vimBlockNode;
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
    if (!document.body || typeof document.body.appendChild !== 'function') return null;
    const node = document.createElement('div');
    node.id = 'vimBlockCaret';
    if (typeof node.setAttribute === 'function') node.setAttribute('aria-hidden', 'true');
    document.body.appendChild(node);
    vimBlockNode = node;
    return node;
}

function vimShowBlock(el) {
    const node = vimEnsureBlock();
    if (!node || !node.style) return false;
    if (typeof el.getBoundingClientRect !== 'function') return false;
    if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return false;
    const pos = (vimMode === 'visual' || vimMode === 'visual-line') ? vimHead : vimSelEnd(el);
    const metrics = vimMeasureCaret(el, pos);
    if (!metrics) return false;
    let rect;
    let computed;
    try {
        rect = el.getBoundingClientRect();
        computed = window.getComputedStyle(el);
    } catch (e) {
        return false;
    }
    if (!rect || !computed) return false;
    const borderLeft = vimPx(computed.borderLeftWidth);
    const borderTop = vimPx(computed.borderTopWidth);
    const borderRight = vimPx(computed.borderRightWidth);
    const borderBottom = vimPx(computed.borderBottomWidth);
    const scrollLeft = typeof el.scrollLeft === 'number' ? el.scrollLeft : 0;
    const scrollTop = typeof el.scrollTop === 'number' ? el.scrollTop : 0;
    let x = rect.left + borderLeft + metrics.left - scrollLeft;
    let y = rect.top + borderTop + metrics.top - scrollTop;
    const viewLeft = rect.left + borderLeft;
    const viewTop = rect.top + borderTop;
    const viewRight = rect.right - borderRight;
    const viewBottom = rect.bottom - borderBottom;
    if (y + metrics.height <= viewTop || y >= viewBottom || x >= viewRight || x + metrics.width <= viewLeft) {
        return false;
    }
    let width = metrics.width;
    let height = metrics.height;
    if (x < viewLeft) {
        width -= viewLeft - x;
        x = viewLeft;
    }
    if (y < viewTop) {
        height -= viewTop - y;
        y = viewTop;
    }
    if (x + width > viewRight) width = viewRight - x;
    if (y + height > viewBottom) height = viewBottom - y;
    if (!(width > 1) || !(height > 1)) return false;
    const style = node.style;
    // Inverse-video silhouette: the block fills with the text color and
    // shows the character in the background color, so the glyph stays
    // visible inside the block instead of being masked. A transparent
    // background would hide the glyph, so keep the block solid then.
    const value = el.value || '';
    const raw = value.charAt(pos);
    const ch = (raw === '\n' || raw === '\r' || raw === '\t' || raw === '') ? ' ' : raw;
    const background = computed.backgroundColor || '';
    const showGlyph = !vimIsTransparent(background);
    vimApplyFont(node, computed);
    style.display = 'block';
    style.position = 'fixed';
    style.pointerEvents = 'none';
    style.zIndex = '70';
    style.boxSizing = 'border-box';
    style.margin = '0';
    style.padding = '0';
    style.border = '0';
    style.left = Math.round(x) + 'px';
    style.top = Math.round(y) + 'px';
    style.width = Math.round(width) + 'px';
    style.height = Math.round(height) + 'px';
    style.overflow = 'hidden';
    style.textAlign = 'left';
    style.textIndent = '0';
    style.whiteSpace = 'pre';
    style.lineHeight = Math.round(height) + 'px';
    style.background = computed.color || '';
    style.color = showGlyph ? background : 'transparent';
    node.textContent = ch;
    return true;
}

function vimSyncCaret() {
    const block = !!(vimEnabled && vimFocused && vimBox && vimMode !== 'insert');
    if (vimCaretBox && vimCaretBox !== vimBox) vimClearBlockCaret(vimCaretBox);
    if (!block) {
        vimClearBlockCaret(vimBox);
        vimClearBlockCaret(vimCaretBox);
        vimCaretBox = null;
        vimHideBlock();
        return;
    }
    if (vimBox.classList && typeof vimBox.classList.add === 'function') vimBox.classList.add('vim-block');
    vimCaretBox = vimBox;
    if (vimShowBlock(vimBox)) {
        if (vimBox.style) vimBox.style.caretColor = 'transparent';
    } else {
        vimHideBlock();
        if (vimBox.style) vimBox.style.caretColor = '';
    }
}

function vimBadgeName() {
    if (vimSearch) return (vimSearch.backward ? '?' : '/') + vimSearch.query;
    if (vimFind) return vimFind;
    if (vimObj) return vimObj;
    if (vimOp) return vimOp;
    if (vimPending === 'g' || vimPending === 'r') return vimPending;
    if (vimMode === 'visual-line') return 'visual line';
    return vimMode;
}

function vimSyncChrome() {
    vimSyncCaret();
    if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
    const badge = document.getElementById('vimMode');
    if (!badge) return;
    const show = !!(vimEnabled && vimFocused);
    if (badge.style) badge.style.display = show ? '' : 'none';
    badge.textContent = '';
    if (!show) return;
    badge.textContent = 'vim ' + vimBadgeName();
    vimPositionBadge(badge);
}

function vimPositionBadge(badge) {
    const box = vimBox;
    if (!box || !badge.style || typeof box.getBoundingClientRect !== 'function') return;
    let rect;
    try { rect = box.getBoundingClientRect(); } catch (e) { return; }
    if (!rect || rect.width < 8 || rect.height < 8) return;
    const viewW = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth : 0;
    if (!viewW) return;
    badge.style.top = Math.round(rect.top + 4) + 'px';
    badge.style.right = Math.max(4, Math.round(viewW - rect.right)) + 'px';
    badge.style.bottom = 'auto';
    badge.style.left = 'auto';
}

function vimScheduleBlock() {
    if (typeof requestAnimationFrame !== 'function') {
        vimSyncCaret();
        return;
    }
    if (vimBlockFrame) return;
    vimBlockFrame = requestAnimationFrame(function () {
        vimBlockFrame = 0;
        if (!vimEnabled || !vimFocused || vimMode === 'insert') return;
        vimSyncCaret();
    });
}

function vimOnScroll() {
    if (!vimEnabled || !vimFocused) return;
    if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
        const badge = document.getElementById('vimMode');
        if (badge && badge.style && badge.style.display !== 'none') vimPositionBadge(badge);
    }
    vimScheduleBlock();
}

function vimOnCaretSettle(e) {
    if (!vimEnabled || !vimFocused || vimMode === 'insert') return;
    if (e && e.target && vimIsTextarea(e.target) && e.target !== vimBox) return;
    vimScheduleBlock();
}

function vimOnInsert(el, e) {
    const key = vimNormalizeKey(e.key || '');
    if (key === 'Escape') {
        vimEat(e);
        vimClearJj();
        vimLeaveInsert(el);
        vimSyncChrome();
        return;
    }
    if ((key === 'd' || key === 'x') && vimSelStart(el) !== vimSelEnd(el)) {
        vimEat(e);
        vimClearJj();
        // The insert snapshot already covers this deletion.
        vimSuppressUndo = true;
        vimDeleteSelection(el);
        vimSuppressUndo = false;
        vimMode = 'insert';
        vimSyncChrome();
        return;
    }
    if (key === 'j') {
        vimEat(e);
        if (vimJjPending && vimJjBox === el) {
            vimClearJj();
            vimEatPendingJ(el);
            vimCommitInsert(el);
            vimMode = 'normal';
            vimPreferredCol = null;
            vimSyncChrome();
            return;
        }
        const start = vimSelStart(el);
        const end = vimSelEnd(el);
        vimReplace(el, start, end, 'j');
        vimJjPending = true;
        vimJjBox = el;
        if (typeof setTimeout === 'function') {
            vimJjTimer = setTimeout(function () {
                vimJjTimer = null;
                vimJjPending = false;
                vimJjBox = null;
            }, VIM_JJ_MS);
        }
        vimSyncChrome();
        return;
    }
    vimClearJj();
}

function vimOnSearch(el, e, key) {
    vimEat(e);
    if (key === 'Escape') {
        vimSearch = null;
        vimSyncChrome();
        return;
    }
    if (key === 'Enter') {
        const query = vimSearch.query;
        const backward = vimSearch.backward;
        vimSearch = null;
        if (query) {
            vimLastSearch = { query: query, backward: backward };
            vimSearchMove(el, false, vimTakeCount() || 1);
        }
        vimSyncChrome();
        return;
    }
    if (key === 'Backspace') {
        vimSearch.query = vimSearch.query.slice(0, -1);
        vimSyncChrome();
        return;
    }
    if (key.length === 1) vimSearch.query += key;
    vimSyncChrome();
}

function vimFinishFind(el, ch) {
    const kind = vimFind;
    const count = vimFindCount || 1;
    vimFind = '';
    vimLastFind = { kind: kind, ch: ch };
    if (vimOp) {
        vimCounting = true;
        vimCount = count;
        vimOpCount = 1;
        vimRunMotion(el, kind, ch);
    } else {
        const motion = vimMotionPos(el, kind, count, true, ch);
        vimGo(el, motion.pos, false);
    }
    vimSyncChrome();
}

function vimTryCtrl(el, e, key) {
    if (e.metaKey || e.altKey || e.shiftKey) return false;
    if (vimMode === 'insert') return false;
    if (key === 'd' || key === 'u') {
        vimEat(e);
        vimCancelOp();
        vimHalfPage(el, key === 'd' ? 1 : -1);
        vimSyncChrome();
        return true;
    }
    if (key === 'r' && vimMode === 'normal') {
        vimEat(e);
        vimCancelOp();
        vimRedo(el);
        vimSyncChrome();
        return true;
    }
    return false;
}

function vimCommand(el, key) {
    if (vimObj) {
        vimFinishObject(el, key);
        vimSyncChrome();
        return;
    }
    if ((key >= '1' && key <= '9') || (key === '0' && vimCounting)) {
        vimPushCount(key);
        vimSyncChrome();
        return;
    }
    if (vimOp && (key === 'i' || key === 'a') && key !== vimOp) {
        vimObj = key;
        vimSyncChrome();
        return;
    }
    if (vimOp && key === vimOp && (key === 'd' || key === 'c' || key === 'y')) {
        const count = Math.max(1, vimOpCount * (vimTakeCount() || 1));
        const op = vimOp;
        vimOp = '';
        if (op === 'd') vimDeleteLine(el, count);
        else if (op === 'c') {
            const value = el.value || '';
            const span = vimLineSpan(value, vimHeadOf(el), count);
            let end = span.end;
            if (end > span.start && value.charAt(end - 1) === '\n') end -= 1;
            vimBeginInsertSnap(el);
            vimYank(value.slice(span.start, span.end), true);
            vimMode = 'insert';
            vimReplace(el, span.start, end, '');
            vimPlace(el, span.start, span.start);
        } else {
            const span = vimLineSpan(el.value || '', vimHeadOf(el), count);
            vimYank((el.value || '').slice(span.start, span.end), true);
            vimMode = 'normal';
        }
        vimRemember(function () {
            if (op === 'd') vimDeleteLine(el, count);
            else if (op === 'y') {
                const span = vimLineSpan(el.value || '', vimHeadOf(el), count);
                vimYank((el.value || '').slice(span.start, span.end), true);
            }
        });
        vimSyncChrome();
        return;
    }
    if (vimOp && (key === '>' || key === '<') && key === vimOp) {
        const count = Math.max(1, vimOpCount * (vimTakeCount() || 1));
        vimOp = '';
        vimShift(el, count, key === '<');
        vimSyncChrome();
        return;
    }
    const motions = {
        h: 1, j: 1, k: 1, l: 1, w: 1, b: 1, e: 1, W: 1, B: 1, E: 1,
        '0': 1, '^': 1, '$': 1, '_': 1, '%': 1, '{': 1, '}': 1, '+': 1, '-': 1,
        G: 1
    };
    if (vimOp && (motions[key] || key === 'g' || key === 'f' || key === 'F' || key === 't' || key === 'T')) {
        if (key === 'g' || key === 'f' || key === 'F' || key === 't' || key === 'T') {
            if (key === 'g') vimPending = 'g';
            else {
                vimFind = key;
                vimFindCount = Math.max(1, vimOpCount * (vimTakeCount() || 1));
            }
            vimSyncChrome();
            return;
        }
        vimRunMotion(el, key);
        vimSyncChrome();
        return;
    }
    if (vimOp && !motions[key]) vimCancelOp();
    if (vimSelStart(el) !== vimSelEnd(el) && (key === 'd' || key === 'x' || key === 'c' || key === 'y')) {
        if (key === 'y') {
            const start = vimSelStart(el);
            const end = vimSelEnd(el);
            vimYank((el.value || '').slice(start, end), false);
            vimMode = 'normal';
            vimPlace(el, start, start);
        } else if (key === 'c') {
            const start = vimSelStart(el);
            vimDeleteSelection(el);
            vimBeginInsertSnap(el);
            vimMode = 'insert';
            vimPlace(el, start, start);
        } else vimDeleteSelection(el);
        vimSyncChrome();
        return;
    }
    if (key === 'd' || key === 'c' || key === 'y' || key === '>' || key === '<') {
        vimOp = key;
        vimOpCount = vimTakeCount() || 1;
        vimSyncChrome();
        return;
    }
    if (key === 'f' || key === 'F' || key === 't' || key === 'T') {
        vimFind = key;
        vimFindCount = vimTakeCount() || 1;
        vimSyncChrome();
        return;
    }
    if (key === 'r') {
        vimPending = 'r';
        vimFindCount = vimTakeCount() || 1;
        vimSyncChrome();
        return;
    }
    if (key === 'g') {
        vimPending = 'g';
        vimSyncChrome();
        return;
    }
    if (motions[key] || key === '0') {
        vimRunMotion(el, key);
        vimSyncChrome();
        return;
    }
    if (key === 'n' || key === 'N') {
        vimSearchMove(el, key === 'N', vimTakeCount());
        vimSyncChrome();
        return;
    }
    if (key === '/' || key === '?') {
        vimSearch = { backward: key === '?', query: '' };
        vimSyncChrome();
        return;
    }
    if (key === '*') {
        const word = vimWordUnder(el.value || '', vimHeadOf(el));
        if (word) {
            vimLastSearch = { query: word, backward: false };
            vimSearchMove(el, false, vimTakeCount() || 1);
        }
        vimSyncChrome();
        return;
    }
    if (key === '#') {
        const word = vimWordUnder(el.value || '', vimHeadOf(el));
        if (word) {
            vimLastSearch = { query: word, backward: true };
            vimSearchMove(el, false, vimTakeCount() || 1);
        }
        vimSyncChrome();
        return;
    }
    if (key === 'x' || key === 'X') {
        const n = vimTakeCount() || 1;
        vimDeleteChar(el, n, key === 'X');
        vimRemember(function () { vimDeleteChar(el, n, key === 'X'); });
        vimSyncChrome();
        return;
    }
    if (key === 's') {
        const n = vimTakeCount() || 1;
        vimDeleteChar(el, n, false);
        vimBeginInsertSnap(el);
        vimMode = 'insert';
        vimSyncChrome();
        return;
    }
    if (key === ';' || key === ',') {
        if (vimLastFind) {
            const flip = { f: 'F', F: 'f', t: 'T', T: 't' };
            const use = key === ',' ? (flip[vimLastFind.kind] || vimLastFind.kind) : vimLastFind.kind;
            const n = vimTakeCount() || 1;
            if (vimOp) {
                vimCounting = true;
                vimCount = n;
                vimOpCount = 1;
                vimRunMotion(el, use, vimLastFind.ch);
            } else {
                const motion = vimMotionPos(el, use, n, true, vimLastFind.ch);
                vimGo(el, motion.pos, false);
            }
        }
        vimSyncChrome();
        return;
    }
    if (key === 'D' || key === 'C') {
        const op = key === 'D' ? 'd' : 'c';
        vimOp = op;
        vimOpCount = vimTakeCount() || 1;
        vimRunMotion(el, '$');
        vimSyncChrome();
        return;
    }
    if (key === 'S') {
        vimOp = 'c';
        vimOpCount = vimTakeCount() || 1;
        key = 'c';
        vimCommand(el, 'c');
        return;
    }
    if (key === 'p' || key === 'P') {
        const before = key === 'P';
        const n = vimTakeCount() || 1;
        for (let i = 0; i < n; i++) vimPaste(el, before);
        vimRemember(function () { for (let i = 0; i < n; i++) vimPaste(el, before); });
        vimSyncChrome();
        return;
    }
    if (key === 'J') {
        const n = vimTakeCount();
        vimJoin(el, n || 2);
        vimRemember(function () { vimJoin(el, n || 2); });
        vimSyncChrome();
        return;
    }
    if (key === '~') {
        const n = vimTakeCount() || 1;
        vimToggleCase(el, n);
        vimRemember(function () { vimToggleCase(el, n); });
        vimSyncChrome();
        return;
    }
    if (key === 'u') {
        vimUndo(el);
        vimSyncChrome();
        return;
    }
    if (key === '.') {
        const again = vimLastChange;
        vimTakeCount();
        if (again) again();
        vimSyncChrome();
        return;
    }
    if (key === 'i') {
        if (vimMode === 'visual' || vimMode === 'visual-line') vimPlace(el, vimHead, vimHead);
        vimBeginInsertSnap(el);
        vimMode = 'insert';
        vimCancelOp();
        vimPreferredCol = null;
        vimSyncChrome();
        return;
    }
    if (key === 'a') {
        vimAppend(el);
        vimSyncChrome();
        return;
    }
    if (key === 'A') {
        const bounds = vimLineBounds(el.value || '', vimHeadOf(el));
        vimBeginInsertSnap(el);
        vimMode = 'insert';
        vimCancelOp();
        vimPreferredCol = null;
        vimPlace(el, bounds.end, bounds.end);
        vimSyncChrome();
        return;
    }
    if (key === 'I') {
        const at = vimFirstNonBlank(el.value || '', vimHeadOf(el));
        vimBeginInsertSnap(el);
        vimMode = 'insert';
        vimCancelOp();
        vimPreferredCol = null;
        vimPlace(el, at, at);
        vimSyncChrome();
        return;
    }
    if (key === 'v') {
        if (vimMode === 'visual') {
            vimPlace(el, vimHead, vimHead);
            vimMode = 'normal';
        } else vimEnterVisual(el, false);
        vimSyncChrome();
        return;
    }
    if (key === 'V') {
        if (vimMode === 'visual-line') {
            vimPlace(el, vimHead, vimHead);
            vimMode = 'normal';
        } else vimEnterVisual(el, true);
        vimSyncChrome();
        return;
    }
    if (key === 'o' || key === 'O') {
        vimOpenLine(el, key === 'O');
        vimSyncChrome();
        return;
    }
    vimTakeCount();
    vimSyncChrome();
}

function vimOnKeyDown(e) {
    if (!vimEnabled || !e || e.isComposing || e.keyCode === 229) return;
    const el = e.target;
    if (!vimIsTextarea(el)) return;
    vimBox = el;
    vimFocused = true;
    const key = vimNormalizeKey(e.key || '');
    if (e.ctrlKey || e.metaKey || e.altKey) {
        if (vimTryCtrl(el, e, key)) return;
        if (vimMode === 'insert') vimClearJj();
        return;
    }
    if (vimMode === 'insert') {
        vimOnInsert(el, e);
        return;
    }
    if (vimSearch) {
        vimOnSearch(el, e, key);
        return;
    }
    if (vimFind) {
        if (key === 'Escape') {
            vimEat(e);
            vimFind = '';
            vimSyncChrome();
            return;
        }
        if (!vimPassKey(key) && key.length === 1) {
            vimEat(e);
            vimFinishFind(el, key);
            return;
        }
        vimFind = '';
    }
    if (vimPending === 'r') {
        if (key === 'Escape') {
            vimEat(e);
            vimPending = '';
            vimSyncChrome();
            return;
        }
        if (!vimPassKey(key) && key.length === 1) {
            vimEat(e);
            vimDoReplace(el, key);
            vimSyncChrome();
            return;
        }
        vimPending = '';
    }
    if (vimPassKey(key)) {
        vimPreferredCol = null;
        vimCancelOp();
        if (vimMode === 'visual' || vimMode === 'visual-line') vimMode = 'normal';
        vimSyncChrome();
        return;
    }
    vimEat(e);
    if (key === 'Escape') {
        vimCancelOp();
        if (vimMode === 'visual' || vimMode === 'visual-line') {
            vimPlace(el, vimHead, vimHead);
            vimMode = 'normal';
        }
        vimSyncChrome();
        return;
    }
    if (vimPending === 'g') {
        vimPending = '';
        if (key === 'g' || key === 'e' || key === 'E') {
            vimRunMotion(el, key === 'g' ? 'gg' : ('g' + key));
            vimSyncChrome();
            return;
        }
    }
    vimCommand(el, key);
}

function vimOnFocusIn(e) {
    if (!e || !vimIsTextarea(e.target)) return;
    if (vimInsertSnap && vimBox && vimBox !== e.target) vimCommitInsert(vimBox);
    vimBox = e.target;
    vimFocused = true;
    vimMode = 'insert';
    vimCancelOp();
    vimPreferredCol = null;
    vimClearJj();
    vimBeginInsertSnap(e.target);
    vimSyncChrome();
}

function vimOnFocusOut(e) {
    if (!e || !e.target || typeof e.target.tagName !== 'string') return;
    if (e.target.tagName.toUpperCase() !== 'TEXTAREA') return;
    if (vimInsertSnap) vimCommitInsert(e.target);
    vimFocused = false;
    vimBox = null;
    vimMode = 'normal';
    vimCancelOp();
    vimPreferredCol = null;
    vimClearJj();
    vimSyncChrome();
}

function vimOnMouseDown(e) {
    if (!vimEnabled || !e || !e.target || typeof e.target.tagName !== 'string') return;
    if (e.target.tagName.toUpperCase() !== 'TEXTAREA') return;
    vimPreferredCol = null;
    vimCancelOp();
    vimClearJj();
    if (vimMode === 'visual' || vimMode === 'visual-line') vimMode = 'normal';
    vimSyncChrome();
}

function vimOnInput(e) {
    if (!e || !e.target || typeof e.target.tagName !== 'string') return;
    if (e.target.tagName.toUpperCase() !== 'TEXTAREA') return;
    vimBump(e.target);
    if (!vimEnabled || (vimMode !== 'visual' && vimMode !== 'visual-line')) return;
    vimMode = 'normal';
    vimHead = vimSelStart(e.target);
    vimSyncChrome();
}

function installVimKeys() {
    if (vimInstalled) return;
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    vimInstalled = true;
    vimLoadPref();
    document.addEventListener('keydown', vimOnKeyDown, true);
    document.addEventListener('focusin', vimOnFocusIn, true);
    document.addEventListener('focusout', vimOnFocusOut, true);
    document.addEventListener('mousedown', vimOnMouseDown, true);
    document.addEventListener('input', vimOnInput, true);
    document.addEventListener('scroll', vimOnScroll, true);
    document.addEventListener('keyup', vimOnCaretSettle, true);
    document.addEventListener('mouseup', vimOnCaretSettle, true);
    document.addEventListener('selectionchange', vimOnCaretSettle, true);
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('scroll', vimOnScroll);
        window.addEventListener('resize', vimOnScroll);
    }
    vimSyncChrome();
    const lane = document.getElementById('vimLaneBox');
    if (lane) {
        lane.checked = vimEnabled;
        lane.onchange = function () { vimSetEnabled(lane.checked); };
    }
}
installVimKeys();