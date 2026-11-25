// decision.test.js — the decision tab frontend: payload building, cloud
// detection from the decision-model groups, and the rendered form.
// Behavior and data only, never display wording.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
    constructor(tag) { this.tag = tag; this.style = {}; this.children = []; this.value = ''; this.checked = false; this._html = ''; this.attrs = {}; }
    get innerHTML() { return this._html; }
    set innerHTML(value) { this._html = value == null ? '' : String(value); this.children = []; }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this[name] = value; this.attrs[name] = value; }
    getAttribute(name) { return this.attrs[name] != null ? this.attrs[name] : null; }
}
const elements = new Map();
const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element('div')); return elements.get(id); },
    createElement(tag) { return new Element(tag); }
};
const sandbox = { document, cachedConfig: {}, apiFetch: async () => { throw new Error('no fetch in this test'); } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(__dirname + '/core.js', 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(__dirname + '/decision.js', 'utf8'), sandbox);
const evaluate = code => vm.runInContext(code, sandbox);
const plain = value => JSON.parse(JSON.stringify(value));
const findId = (node, id) => {
    if (!node) return null;
    if (node.id === id) return node;
    for (const child of node.children || []) {
        const found = findId(child, id);
        if (found) return found;
    }
    return null;
};

// The decision-model groups the config serves (OLLAMA cloud + LOCAL).
const decisionGroups = JSON.stringify([
    { group: 'OLLAMA', models: ['clef:27b-cloud'] },
    { group: 'LOCAL', models: ['d3:4b'] },
]);
sandbox.cachedConfig = { decision_model: 'd3:4b', decision_models: decisionGroups };

// decisionPayload is pure and shapes the /decision body per kind.
assert.deepEqual(plain(evaluate('decisionPayload("bool", "m", "is it done", 1, 5, "")')), { kind: 'bool', model: 'm', prompt: 'is it done' });
assert.deepEqual(plain(evaluate('decisionPayload("rating", "m", "rate", 2, 9, "")')), { kind: 'rating', model: 'm', prompt: 'rate', min: 2, max: 9 });
assert.deepEqual(plain(evaluate('decisionPayload("choice", "m", "pick", 1, 5, "A\\n B \\n")')), { kind: 'choice', model: 'm', prompt: 'pick', options: ['A', 'B'] });

// Cloud detection follows the group, not the name suffix alone.
assert.equal(evaluate('decisionModelIsCloud("d3:4b")'), false);
assert.equal(evaluate('decisionModelIsCloud("clef:27b-cloud")'), true);

// renderDecision builds the form and preselects the stored decision model.
evaluate('renderDecision()');
const view = document.getElementById('decisionView');
const select = findId(view, 'decisionModel');
assert.ok(select, 'model select rendered');
let optionCount = 0;
let selected = null;
for (const group of select.children || []) {
    for (const option of group.children || []) {
        optionCount += 1;
        if (option.selected) selected = option;
    }
}
assert.equal(optionCount, 2, 'every decision model is listed');
assert.equal(selected.value, 'd3:4b', 'the stored decision model is preselected');

// Sub-tabs swap the type-specific fields.
evaluate('setDecisionKind("choice")');
assert.ok(findId(view, 'decisionOptions'), 'choice options textarea shows');
assert.equal(findId(view, 'decisionMin'), null);
evaluate('setDecisionKind("rating")');
assert.ok(findId(view, 'decisionMin'), 'rating min shows');
assert.ok(findId(view, 'decisionMax'), 'rating max shows');
assert.equal(findId(view, 'decisionOptions'), null);
evaluate('setDecisionKind("bool")');
assert.equal(findId(view, 'decisionMin'), null);
assert.equal(findId(view, 'decisionMax'), null);
assert.equal(findId(view, 'decisionOptions'), null);

console.log('== decision.test.js ok');
