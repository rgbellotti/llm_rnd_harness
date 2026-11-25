// promptdock.test.js — a wide idle screen keeps the prompt in the side lane,
// including while history is open. A live run keeps that lane for Thinking
// and approvals. A narrow screen still expands and collapses in the column.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
    constructor() {
        this.style = {};
        this.textContent = '';
        this.disabled = false;
        this.children = [];
        const names = new Set();
        this.classList = {
            toggle: (name, on) => {
                const force = on === undefined ? !names.has(name) : !!on;
                if (force) names.add(name); else names.delete(name);
                return force;
            },
            contains: name => names.has(name),
            add: name => { names.add(name); },
            remove: name => { names.delete(name); },
        };
    }
    appendChild(child) { this.children.push(child); return child; }
    getBoundingClientRect() {
        return this.rect || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
}
const elements = new Map();
let wide = false;
const laneListeners = [];
const document = {
    getElementById(id) {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
    },
    createElement() { return new Element(); },
    body: new Element(),
};
const sandbox = {
    document,
    sessions: [],
    activeSid: null,
    runningSid: null,
    activeSession: () => null,
    syncStopBtn() {},
    syncPromptUI() {},
    syncModelMenu() {},
    syncActivityIcon() {},
    refreshPromptBox() { sandbox.refreshed = true; },
    window: {
        matchMedia() {
            return {
                matches: wide,
                addEventListener(_type, fn) { laneListeners.push(fn); },
            };
        },
    },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(__dirname + '/tabs.js', 'utf8'), sandbox);
const evaluate = code => vm.runInContext(code, sandbox);
const body = document.body;
const prompt = document.getElementById('prompt');

evaluate('setPromptExpanded(true)');
assert.equal(prompt.classList.contains('expanded'), true);
assert.equal(document.getElementById('promptTools').style.display, '');
assert.equal(document.getElementById('protocolBox').style.display, '', 'the context submenu stays with the prompt');
assert.equal(body.classList.contains('prompt-docked'), false, 'a narrow screen keeps the box in the column');

evaluate('setPromptExpanded(false)');
assert.equal(prompt.classList.contains('expanded'), false);
assert.equal(document.getElementById('promptTools').style.display, 'none', 'prompt edit still hides Save, Copy, Clear, and Restore');
assert.equal(document.getElementById('protocolBox').style.display, '', 'a narrow startup still shows the context submenu');

wide = true;
evaluate('promptExpanded = false; promptCollapseChosen = false; syncPromptDock()');
assert.equal(body.classList.contains('prompt-docked'), true, 'a wide idle screen opens the lane before prompt edit');

evaluate('historyActive = true; syncPromptDock()');
assert.equal(body.classList.contains('prompt-docked'), true, 'history keeps the lane');
assert.equal(prompt.style.display, '', 'the prompt stays visible beside history');
assert.equal(document.getElementById('bottom_row_buttons').style.display, '');

wide = false;
evaluate('syncPromptDock()');
assert.equal(body.classList.contains('prompt-docked'), false, 'a narrow history still hides the lane');
assert.equal(prompt.style.display, 'none');
assert.equal(document.getElementById('bottom_row_buttons').style.display, '');
assert.equal(document.getElementById('bottom_row_left').style.display, 'none');
assert.equal(document.getElementById('bottom_row_right').style.display, 'none');
assert.equal(document.getElementById('composerActions').style.display, 'none', 'narrow history hides Generate and Upload');
assert.equal(document.getElementById('protocolBox').style.display, 'none', 'narrow history hides the context submenu with the prompt');

evaluate('historyActive = true; promptCollapseChosen = false; setPromptExpanded(false)');
wide = true;
laneListeners[0]();
assert.equal(body.classList.contains('prompt-docked'), true, 'widening history opens the lane');
assert.equal(prompt.classList.contains('expanded'), true);
assert.equal(prompt.style.display, '');
assert.equal(document.getElementById('bottom_row_left').style.display, '');
assert.equal(document.getElementById('bottom_row_right').style.display, '');
assert.equal(document.getElementById('composerActions').style.display, '', 'a wide history keeps Generate and Upload');
wide = false;
evaluate('historyActive = false; setPromptExpanded(true)');
assert.equal(prompt.classList.contains('expanded'), true);
assert.equal(body.classList.contains('prompt-docked'), false);

wide = true;
assert.equal(laneListeners.length > 0, true);
laneListeners[0]();
assert.equal(body.classList.contains('prompt-docked'), true, 'crossing into a wide screen moves the open editor');

sandbox.runningSid = 'live';
laneListeners[0]();
assert.equal(body.classList.contains('prompt-docked'), false, 'a live run keeps the lane');
assert.equal(document.getElementById('composerActions').style.display, 'none', 'a live run hides Generate and Upload; Stop stays on the tab row');
evaluate('setPromptExpanded(true)');
assert.equal(prompt.classList.contains('expanded'), false);
assert.equal(body.classList.contains('prompt-docked'), false);

sandbox.runningSid = null;
wide = true;
evaluate('setPromptExpanded(true)');
assert.equal(body.classList.contains('prompt-docked'), true);
evaluate('historyActive = true; syncPromptDock()');
assert.equal(body.classList.contains('prompt-docked'), true, 'history leaves the recorded session on the right');
assert.equal(prompt.classList.contains('expanded'), true);
evaluate('historyActive = false; syncPromptDock()');
assert.equal(body.classList.contains('prompt-docked'), true);

evaluate('setPromptExpanded(false)');
assert.equal(body.classList.contains('prompt-docked'), true, 'a wide screen keeps the lane without a collapse control');
assert.equal(prompt.classList.contains('expanded'), true);
assert.equal(document.getElementById('promptTools').style.display, '');
assert.equal(evaluate('promptCollapseChosen'), false);

evaluate(`
  activeSession = () => ({ status: 'done', prompt: 'submitted' });
  document.getElementById('prompt').value = 'submitted';
  document.activeElement = null;
  historyActive = false;
  configActive = false;
  creditsActive = false;
  runningSid = null;
  syncPromptUI();
`);
assert.equal(prompt.value, '', 'a finished chain clears the prompt box');
assert.equal(prompt.disabled, false, 'an idle prompt still accepts typing and paste');
assert.equal(document.getElementById('runBtn').disabled, true);
assert.equal(evaluate('activeSession().prompt'), 'submitted');
evaluate(`
  composerDraft = 'pasted from history';
  document.activeElement = null;
  syncPromptUI();
`);
assert.equal(prompt.value, 'pasted from history');
assert.equal(prompt.disabled, false);
assert.equal(document.getElementById('runBtn').disabled, false, 'a pasted draft can generate');
prompt.value = 'typing';
document.activeElement = prompt;
evaluate('syncPromptUI()');
assert.equal(prompt.value, 'typing', 'a focused prompt keeps the text being typed');
document.activeElement = null;
evaluate('composerDraft = ""');
evaluate(`
  activeSession = () => ({ status: 'fresh', prompt: 'draft' });
  syncPromptUI();
`);
assert.equal(prompt.value, 'draft');
assert.equal(prompt.disabled, false);

evaluate(`
  activeSession = () => ({ status: 'fresh', prompt: 'draft' });
  configActive = true;
  creditsActive = false;
  historyActive = false;
  runningSid = null;
  syncPromptUI();
`);
assert.equal(prompt.disabled, false, 'a wide config page keeps the prompt editable');
assert.equal(prompt.value, 'draft');
wide = false;
evaluate('syncPromptUI()');
assert.equal(prompt.disabled, true, 'a narrow config page sets the prompt aside');
evaluate('configActive = false; syncPromptUI()');
assert.equal(prompt.disabled, false);

console.log('promptdock.test.js OK');
