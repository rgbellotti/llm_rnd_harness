const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// The context-budget dialog. Assert behavior and data, never display
// wording: the choice parsing, the open/close state machine, the guide
// persistence, and that an invalid count keeps the dialog open.
class Element {
    constructor() {
        this.style = {};
        this.value = '';
        this.textContent = '';
    }
    focus() { this.focused = true; }
}
const elements = new Map();
const store = {};
const document = {
    getElementById(id) {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
    }
};
const sandbox = {
    document,
    localStorage: {
        getItem: key => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
        setItem: (key, value) => { store[key] = String(value); }
    },
    console
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(__dirname + '/stream.js', 'utf8'), sandbox);

function choiceFields(choice) {
    return { start: choice.start, limit: choice.limit, invalid: choice.invalid === true };
}
assert.deepEqual(choiceFields(sandbox.contextBudgetChoice(500000, 'use', '')), { start: true, limit: null, invalid: false });
assert.deepEqual(choiceFields(sandbox.contextBudgetChoice(null, 'cancel', '32768')), { start: false, limit: null, invalid: false });
assert.deepEqual(choiceFields(sandbox.contextBudgetChoice(null, 'skip', '')), { start: true, limit: null, invalid: false });
assert.deepEqual(choiceFields(sandbox.contextBudgetChoice(null, 'use', '32768')), { start: true, limit: 32768, invalid: false });
assert.equal(sandbox.contextBudgetChoice(null, 'use', '').invalid, true);
assert.equal(sandbox.contextBudgetChoice(null, 'use', '0').invalid, true);
assert.equal(sandbox.contextBudgetChoice(null, 'use', '10000001').invalid, true);
assert.equal(sandbox.contextBudgetChoice(null, 'use', '12k').invalid, true);

document.getElementById('modelToggle').textContent = 'lfm3:1.7b';
const limitOpen = () => vm.runInContext('contextLimitOpen', sandbox);
(async () => {
    const pending = sandbox.askContextLimit();
    assert.equal(limitOpen(), true);
    assert.equal(document.getElementById('contextOverlay').style.display, '');
    sandbox.submitContextLimit('cancel');
    const cancelled = await pending;
    assert.equal(cancelled.start, false);
    assert.equal(limitOpen(), false);

    const skipped = sandbox.askContextLimit();
    sandbox.submitContextLimit('skip');
    assert.deepEqual(choiceFields(await skipped), { start: true, limit: null, invalid: false });

    const used = sandbox.askContextLimit();
    document.getElementById('contextLimitInput').value = '8192';
    sandbox.submitContextLimit('use');
    assert.deepEqual(choiceFields(await used), { start: true, limit: 8192, invalid: false });
    assert.equal(sandbox.loadContextGuide('lfm3:1.7b'), '8192');

    const again = sandbox.askContextLimit();
    assert.equal(document.getElementById('contextLimitInput').value, '8192');
    document.getElementById('contextLimitInput').value = 'nope';
    sandbox.submitContextLimit('use');
    // An invalid count is refused: the dialog stays open with a visible
    // error, and nothing resolves.
    assert.equal(limitOpen(), true);
    assert.ok(document.getElementById('contextLimitError').textContent.length > 0);
    sandbox.submitContextLimit('cancel');
    await again;
    console.log('context budget dialog tests passed');
})().catch(err => {
    console.error(err);
    process.exit(1);
});
