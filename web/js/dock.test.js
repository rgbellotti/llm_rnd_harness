// dock.test.js — a live run on a wide screen keeps run-docked after the
// tool dialog closes. The dialog class is separate and only while open.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
    constructor() {
        this.style = {};
        this.className = '';
        this.textContent = '';
        this.children = [];
        const names = new Set();
        this.classList = {
            toggle: (name, on) => {
                if (on) names.add(name);
                else names.delete(name);
                this.className = [...names].join(' ');
                return !!on;
            },
            contains: name => names.has(name),
        };
    }
    setAttribute() {}
    appendChild(child) { this.children.push(child); return child; }
}
const elements = new Map();
const document = {
    getElementById(id) {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
    },
    createElement() { return new Element(); },
    body: new Element(),
};
let wide = true;
const sandbox = {
    document,
    runningSid: null,
    activityIconMode: 'idle',
    getSession: () => null,
    setTimeout: fn => fn(),
    setActivityIcon() {},
    fetch: null,
    window: {
        matchMedia() {
            return { matches: wide, addEventListener() {} };
        },
    },
};
sandbox.apiFetch = (...args) => sandbox.fetch(...args);
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(__dirname + '/approval.js', 'utf8'), sandbox);
const evaluate = code => vm.runInContext(code, sandbox);
const body = document.body;
const note = () => {
    const label = elements.get('runLaneText');
    if (label && label.textContent) return label.textContent;
    return document.getElementById('runLaneNote').textContent;
};
const overlay = document.getElementById('approvalOverlay');

evaluate(`runningSid = 'live'; activityIconMode = 'think'; syncRunDock()`);
assert.equal(body.classList.contains('run-docked'), true);
assert.equal(body.classList.contains('approval-docked'), false);
assert.equal(note(), 'Thinking...');

evaluate(`activityIconMode = 'tool'; syncRunDock()`);
assert.equal(body.classList.contains('run-docked'), true);
assert.equal(note(), 'Waiting for response...');

overlay.style.display = 'flex';
evaluate('syncRunDock()');
assert.equal(body.classList.contains('run-docked'), true);
assert.equal(body.classList.contains('approval-docked'), true);
assert.equal(note(), 'Waiting for response...');
assert.equal(document.getElementById('approvalActionPane').style.display, '');
evaluate(`showApprovalContext('stderr')`);
evaluate('syncRunDock()');
assert.equal(document.getElementById('approvalStderrPane').style.display, '');
assert.equal(document.getElementById('approvalActionPane').style.display, 'none');

overlay.style.display = 'none';
evaluate('syncRunDock()');
assert.equal(body.classList.contains('run-docked'), true);
assert.equal(body.classList.contains('approval-docked'), false);

evaluate('runningSid = null; syncRunDock()');
assert.equal(body.classList.contains('run-docked'), false);
assert.equal(body.classList.contains('approval-docked'), false);

wide = false;
evaluate(`runningSid = 'live'; activityIconMode = 'think'; syncRunDock()`);
assert.equal(body.classList.contains('run-docked'), false);
assert.equal(body.classList.contains('run-live'), true, 'a narrow live run keeps the bottom line');
assert.equal(note(), 'Thinking...');
evaluate(`activityIconMode = 'tool'; syncRunDock()`);
assert.equal(note(), 'Waiting for response...');
overlay.style.display = 'flex';
evaluate('syncRunDock()');
assert.equal(body.classList.contains('approval-docked'), false);
assert.equal(body.classList.contains('run-live'), true);
evaluate('runningSid = null; syncRunDock()');
assert.equal(body.classList.contains('run-live'), false);

console.log('dock.test.js OK');
