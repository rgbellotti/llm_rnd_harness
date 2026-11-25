// scroll.test.js — window bounds for continual scroll. The DOM wiring is
// covered by the browser; this checks the range math the page shifts by.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const sandbox = { document: { createElement() { return { style: {}, children: [], appendChild(c) { this.children.push(c); return c; } }; } } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(__dirname + '/scroll.js', 'utf8'), sandbox);

function sameRange(actual, from, to) {
    assert.equal(actual.from, from);
    assert.equal(actual.to, to);
}
sameRange(sandbox.tailRange(0), 0, 0);
sameRange(sandbox.tailRange(3), 1, 3);
sameRange(sandbox.tailRange(8), 1, 8);
sameRange(sandbox.tailRange(9), 2, 9);
sameRange(sandbox.tailRange(20), 13, 20);

sameRange(sandbox.shiftRange(13, 20, 20, -1), 9, 16);
sameRange(sandbox.shiftRange(9, 16, 20, -1), 5, 12);
sameRange(sandbox.shiftRange(5, 12, 20, -1), 1, 8);
sameRange(sandbox.shiftRange(1, 8, 20, -1), 1, 8);

sameRange(sandbox.shiftRange(1, 8, 20, 1), 5, 12);
sameRange(sandbox.shiftRange(5, 12, 20, 1), 9, 16);
sameRange(sandbox.shiftRange(9, 16, 20, 1), 13, 20);
sameRange(sandbox.shiftRange(13, 20, 20, 1), 13, 20);

assert.equal(sandbox.sessionNeedsFullHistory({ runId: 'r', scroll: { engaged: true } }), true);
assert.equal(sandbox.sessionNeedsFullHistory({ runId: 'r', scroll: { engaged: false } }), false);
assert.equal(sandbox.sessionNeedsFullHistory({ scroll: { engaged: true } }), false);
assert.equal(sandbox.sessionNeedsFullHistory(null), false);

// Follow pins to the document bottom even when the reader is stranded in the
// top spacer, far past the 250px stick used by maybeScroll.
sandbox.window = {
    scrollY: 40,
    scrollTo(x, y) { this.scrollY = y; }
};
sandbox.document.body = { scrollHeight: 4200 };
sandbox.document.documentElement = { scrollHeight: 4200 };
const following = { scroll: { follow: true, adjusting: false, lastY: 0 } };
sandbox.pinFollow(following);
assert.equal(sandbox.window.scrollY, 4200);
assert.equal(following.scroll.adjusting, false);
assert.equal(following.scroll.lastY, 4200);
sandbox.window.scrollY = 10;
following.scroll.follow = false;
sandbox.pinFollow(following);
assert.equal(sandbox.window.scrollY, 10);

// Response and Diagnostics land on the session header when a replay has
// one, otherwise on the sub-tab strip. A tall unloaded gap does not pull
// the view down onto the first round. The document tail stays put.
sandbox.Date = Date;
const roundSec = {
    parentNode: {},
    seen: null,
    scrollIntoView(arg) { this.seen = arg; },
};
const subTabs = { className: 'sub-tabs', scrollIntoView() { this.seen = true; }, seen: false };
const diag = {
    className: 'sub-pane diagnostics-pane',
    scrollTop: 80,
    scrollLeft: 12,
    children: [],
    parentNode: { children: [subTabs] },
};
const diagSession = {
    scroll: { engaged: true, follow: true, adjusting: false, lastY: 0, guardUntil: 0 },
    nodes: {
        rounds: new Map([[4, { sec: roundSec }]]),
        spacerTop: { style: { height: '900px' } },
    },
};
sandbox.revealPaneStart(diagSession, diag);
assert.equal(diag.scrollTop, 0);
assert.equal(diag.scrollLeft, 0);
assert.equal(diagSession.scroll.follow, false);
assert.equal(roundSec.seen, null);
assert.equal(subTabs.seen, true);
assert.equal(sandbox.window.scrollY, 10);

subTabs.seen = false;
sandbox.revealPaneStart(diagSession, diag);
assert.equal(roundSec.seen, null);
assert.equal(subTabs.seen, true);

const sessionHead = {
    className: 'round history-session-head',
    seen: null,
    scrollIntoView(arg) { this.seen = arg; },
};
diag.parentNode.parentNode = { children: [sessionHead, diag.parentNode] };
subTabs.seen = false;
sandbox.revealPaneStart(diagSession, diag);
assert.equal(sessionHead.seen.block, 'start');
assert.equal(subTabs.seen, false);
assert.equal(roundSec.seen, null);

// The landing clears the control bar. A stuck bar is remeasured after the move.
let scrollY = 400;
const coverOf = () => (scrollY > 32 ? 180 : 212);
sandbox.window.scrollBy = function (x, dy) { scrollY += dy; };
sandbox.document.getElementById = (id) => id === 'controlDashboard'
    ? { getBoundingClientRect: () => ({ bottom: coverOf() }) }
    : null;
sessionHead.getBoundingClientRect = () => ({ top: 40 + (400 - scrollY) });
sessionHead.seen = null;
sandbox.scrollBlockBelowDashboard(sessionHead);
assert.equal(scrollY, 400 + (40 - 180));
assert.equal(sessionHead.seen, null);
