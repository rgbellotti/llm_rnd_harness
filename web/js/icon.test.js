// icon.test.js — activity icon lifecycle: think/tool map to the two CSS
// animations, busy->done finishes the running cycle before going static
// and fading out (icon-hidden), and the tab's status drives resting
// visibility. Loads icon.js alone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const classes = new Set();
let iterationHandler = null;
const img = {
    classList: {
        add: c => classes.add(c),
        remove: (...cs) => cs.forEach(c => classes.delete(c)),
        contains: c => classes.has(c),
    },
    setAttribute() {},
    addEventListener(type, fn) { if (type === 'animationiteration') iterationHandler = fn; },
};
const fakeDocument = { getElementById: id => (id === 'deltaIcon' ? img : null) };
let pendingTimer = null;
const sandbox = {
    document: fakeDocument,
    runningSid: null,
    activeSession: () => ({ status: 'fresh' }),
    setTimeout: (fn) => { pendingTimer = fn; return 1; },
    clearTimeout: () => { pendingTimer = null; },
};
const ctx = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(__dirname + '/icon.js', 'utf8'), ctx);
const evaluate = code => vm.runInContext(code, ctx);

// Boot: static icon, visible, no animation classes.
assert.equal(classes.size, 0);
assert.equal(evaluate('activityIconMode'), 'idle');

// Model working: flip.
evaluate(`setActivityIcon('think')`);
assert.equal(evaluate('activityIconMode'), 'think');
assert.ok(classes.has('flip') && !classes.has('wheel'));

// Mode switch restarts in tool mode.
evaluate(`setActivityIcon('tool')`);
assert.ok(classes.has('wheel') && !classes.has('flip'));

// Back to thinking.
evaluate(`setActivityIcon('think')`);
assert.ok(classes.has('flip') && !classes.has('wheel'));

// Same-mode call is a no-op (no class churn).
evaluate(`setActivityIcon('think')`);
assert.equal(classes.has('flip'), true);

// Mid-run pause (approval gate): static visible, no fade armed.
evaluate(`setActivityIcon('idle')`);
assert.equal(classes.has('flip'), false);
assert.equal(classes.has('icon-hidden'), false);
assert.equal(evaluate('iconFinishPending'), false);

// True completion: keeps flipping until the cycle ends, then hides.
evaluate(`setActivityIcon('think')`);
evaluate(`setActivityIcon('done')`);
assert.ok(classes.has('flip'), 'icon keeps flipping until the cycle ends');
assert.equal(evaluate('iconFinishPending'), true);

// ...and the animationiteration event finishes and fades it.
assert.ok(iterationHandler, 'icon.js wires animationiteration');
iterationHandler();
assert.equal(classes.has('flip'), false, 'cycle finished: static');
assert.ok(classes.has('icon-hidden'), 'response complete: faded out');

// Fallback timer finishes the icon when animationiteration never fires
// (e.g. reduced motion).
evaluate(`setActivityIcon('think')`);
evaluate(`setActivityIcon('done')`);
assert.equal(typeof pendingTimer, 'function', 'done schedules a fallback');
pendingTimer();
assert.equal(classes.has('flip'), false);
assert.ok(classes.has('icon-hidden'));

// Fresh activity during the pending finish cancels it and shows the icon.
evaluate(`setActivityIcon('think')`);
evaluate(`setActivityIcon('done')`);
evaluate(`setActivityIcon('think')`); // new work before the cycle ended
assert.ok(classes.has('flip'));
assert.equal(classes.has('icon-hidden'), false);
assert.equal(evaluate('iconFinishPending'), false);

// Tab status drives resting visibility: a spent tab hides the icon, a
// fresh tab shows it.
sandbox.activeSession = () => ({ status: 'done' });
evaluate(`setActivityIcon('idle'); syncActivityIcon()`);
assert.ok(classes.has('icon-hidden'), 'done tab: expired');
sandbox.activeSession = () => ({ status: 'fresh' });
evaluate(`syncActivityIcon()`);
assert.equal(classes.has('icon-hidden'), false, 'fresh tab: visible again');
// While a run is in flight, sync shows the icon regardless of tab status.
sandbox.activeSession = () => ({ status: 'done' });
sandbox.runningSid = 'run-1';
evaluate(`syncActivityIcon()`);
assert.equal(classes.has('icon-hidden'), false, 'running: visible');

console.log('icon.test.js OK');
