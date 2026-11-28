const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function element() {
    return {
        style: {},
        children: [],
        textContent: '',
        appendChild(child) { this.children.push(child); return child; },
    };
}

const sandbox = {
    document: { createElement: element, body: { scrollHeight: 0 } },
    window: { innerHeight: 0, scrollY: 0, scrollTo() {} },
    getSession() { return undefined; }, // History replay has left the live registry.
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(__dirname + '/rounds.js', 'utf8'), sandbox);

const replay = { id: 'hist-1', nodes: { container: element(), rounds: new Map() } };
const round = sandbox.ensureRound(replay, 1, 'test-model');
const labels = [];
(function walk(el) {
    if (el && el.textContent) labels.push(el.textContent);
    for (const child of (el && el.children) || []) walk(child);
})(round.sec);
assert.deepEqual(labels.filter(text => text.startsWith('copy') || text.startsWith('curate')), [
    'copy\nselected', 'copy\nfull', 'curate\nselected', 'curate\nfull'
]);
round.condensed = true;
round.body.style.display = 'none';
round.preview.style.display = '';
round.toggle.onclick();
assert.equal(round.condensed, false);
assert.equal(round.body.style.display, '');
assert.equal(round.preview.style.display, 'none');
assert.equal(round.toggle.textContent, 'click to condense');
assert.equal(round.condenseLink.style.display, 'none');
round.toggle.onclick();
assert.equal(round.condensed, true);
assert.equal(round.body.style.display, 'none');
assert.equal(round.condenseLink.style.display, 'none');

// A bottom-link condense reveals a shortened history card only when the
// collapse leaves it outside the usable viewport. The head link never does.
const scrollCalls = [];
sandbox.window.innerHeight = 800;
sandbox.window.scrollY = 5000;
sandbox.window.scrollBy = (x, dy) => {
    scrollCalls.push(dy);
    sandbox.window.scrollY += dy;
};
sandbox.document.body.scrollHeight = 10000;
sandbox.document.getElementById = id => id === 'controlDashboard'
    ? { getBoundingClientRect: () => ({ bottom: 180 }) }
    : null;
const history = {
    id: 'hist-reveal',
    historyView: true,
    data: { rounds: { 1: { model: '' } }, order: [1] },
    nodes: { container: element(), rounds: new Map() },
};
const historyRound = sandbox.ensureRound(history, 1, 'test-model');
historyRound.totalLines = 100;
let cardRect = { top: -500, bottom: -200, left: 0, right: 400, width: 400, height: 300 };
historyRound.sec.getBoundingClientRect = () => cardRect;
historyRound.toggle.onclick();
assert.equal(historyRound.condensed, true);
assert.deepEqual(scrollCalls, [-680], 'bottom condense brings the off-screen card below the dashboard');

scrollCalls.length = 0;
cardRect = { top: -500, bottom: -200, left: 0, right: 400, width: 400, height: 300 };
sandbox.setRoundCondensed(historyRound, false);
historyRound.condensed = false;
historyRound.condenseLink.onclick();
assert.equal(historyRound.condensed, true);
assert.deepEqual(scrollCalls, [], 'head condense keeps the current viewing position');

scrollCalls.length = 0;
cardRect = { top: 200, bottom: 500, left: 0, right: 400, width: 400, height: 300 };
sandbox.setRoundCondensed(historyRound, false);
historyRound.condensed = false;
historyRound.toggle.onclick();
assert.deepEqual(scrollCalls, [], 'a still-visible condensed card does not move the viewport');

scrollCalls.length = 0;
cardRect = { top: -500, bottom: -200, left: 0, right: 400, width: 400, height: 300 };
historyRound.toggle.onclick();
assert.equal(historyRound.condensed, false);
assert.deepEqual(scrollCalls, [], 'expanding from the bottom keeps the existing behavior');

// Rendering defaults and Text/Rendered controls are identical for all callers.
const renderedSession = { id: 'rendered', nodes: { container: element(), rounds: new Map() },
    data: { rounds: {}, order: [] } };
let highlighted = 0;
let mathRendered = 0;
sandbox.highlightRendered = () => highlighted++;
sandbox.renderMath = () => mathRendered++;
const formatted = '<table><tr><td>53</td></tr></table>';
sandbox.showRenderedResponse(renderedSession, 1, formatted);
const renderedRound = renderedSession.nodes.rounds.get(1);
assert.equal(renderedRound.showingRendered, true);
assert.equal(renderedRound.contentEl.style.display, 'none');
assert.equal(renderedRound.renderedEl.innerHTML, formatted);
assert.equal(renderedSession.data.rounds[1].contentHtml, formatted);
assert.equal(highlighted, 1);
assert.equal(mathRendered, 1);
renderedRound.viewToggle.onclick();
assert.equal(renderedRound.showingRendered, false);
renderedRound.viewToggle.onclick();
assert.equal(renderedRound.showingRendered, true);
