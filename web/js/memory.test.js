// memory.test.js — Cold notes are independent full-width cards with
// vertically stacked fields; Hot and Warm keep their existing blocks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { document } = require('./testdom.js').createDom();

const descendants = (root, predicate) => {
    const found = [];
    for (const child of root.children || []) {
        if (predicate(child)) found.push(child);
        found.push(...descendants(child, predicate));
    }
    return found;
};
const byClass = (root, name) => descendants(root, child => child.classList.contains(name));
const sandbox = { document };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(__dirname + '/memory.js', 'utf8'), sandbox);

const payload = {
    recording: true,
    projects: [],
    selected: 'layout-project',
    view: {
        name: 'layout-project',
        description: 'Layout fixture',
        injected: 'hot fixture\nsecond line',
        warm: { summary: 'warm fixture' },
        notes: [
            {
                key: 'LongTitle'.repeat(20),
                tags: 'alpha, beta',
                body: 'first line\nsecond line\n' + 'UnbrokenDetail'.repeat(20),
            },
            { key: 'Second note' },
        ],
    },
};
sandbox.renderMemory(payload);

const view = document.getElementById('memoryView');
const coldNotes = byClass(view, 'memory-cold-notes')[0];
assert.ok(coldNotes, 'Cold notes have their own layout container');
const cards = coldNotes.children;
assert.equal(cards.length, payload.view.notes.length, 'one card per Cold note');
for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const note = payload.view.notes[i];
    assert.equal(card.tag, 'dl');
    assert.deepEqual(card.children.map(child => child.tag), [
        'dt', 'dd', 'dt', 'dd', 'dt', 'dd',
    ], 'each field is a separate label/value row');
    assert.deepEqual(card.children.filter((_, index) => index % 2 === 1).map(child => child.textContent), [
        note.key,
        note.tags || '',
        note.body || '',
    ], 'multiline and unbroken values are preserved');
}
for (const tag of ['table', 'thead', 'tbody', 'tr', 'th', 'td']) {
    assert.equal(descendants(view, child => child.tag === tag).length, 0, 'Cold notes do not use table columns');
}

// The existing Hot and Warm renderers still produce the same two blocks.
assert.deepEqual(byClass(view, 'memory-block').map(block => block.textContent), [
    payload.view.injected,
    JSON.stringify(payload.view.warm, null, 2),
]);

sandbox.renderMemory({ view: { name: 'empty-project', notes: [] } });
const emptyNotes = byClass(document.getElementById('memoryView'), 'memory-cold-notes')[0];
assert.equal(emptyNotes.children.length, 1);
assert.equal(emptyNotes.children[0].tag, 'p');
assert.equal(byClass(emptyNotes, 'memory-cold-note').length, 0);

// The fake DOM cannot lay out text, so guard the width and wrapping contract
// directly in the stylesheet that ships with the page.
const css = fs.readFileSync(__dirname + '/../style.css', 'utf8');
const rule = selector => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = css.match(new RegExp(escaped + '\\s*\\{([^}]*)\\}'));
    assert.ok(match, 'missing style rule: ' + selector);
    return match[1];
};
for (const selector of ['.memory-cold-notes', '.memory-cold-note']) {
    const declarations = rule(selector);
    assert.ok(declarations.includes('display: flex;'), selector + ' is a flex container');
    assert.ok(declarations.includes('flex-direction: column;'), selector + ' stacks vertically');
    assert.ok(declarations.includes('width: 100%;'), selector + ' uses the full available width');
    assert.ok(declarations.includes('min-width: 0;'), selector + ' can shrink inside the card');
}
const values = rule('.memory-cold-note dd');
assert.ok(values.includes('width: 100%;'), 'Cold values use the full card width');
assert.ok(values.includes('white-space: pre-wrap;'), 'Cold values retain line breaks');
assert.ok(values.includes('overflow-wrap: anywhere;'), 'long unbroken values wrap only when needed');
