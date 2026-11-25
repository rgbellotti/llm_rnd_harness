// testdom.js — the shared fake DOM for the *.test.js suites.
//
// One Element class, one document, one contract, instead of seventeen
// per-file copies drifting apart. A test file uses it like this:
//
//     const { document, elements } = require('./testdom.js');
//     const sandbox = { document, ... };
//
// Node-only helper: it is NOT part of the page bundle (page.rs lists
// the app scripts explicitly) and run_tests.sh executes *.test.js only.
//
// Deliberate differences from a real DOM, and why they stay:
//
// - getElementById auto-creates an orphan element for an id it has
//   never seen. Most suites exercise dialogs whose ids live in
//   index.html, and the orphan is the stand-in for that markup. Without
//   it, every test would have to build the real page first.
//
// - An element that is ASSIGNED an id — `el.id = 'x'`, or
//   setAttribute('id', 'x') — takes over the registry slot. Lookups
//   after that find the real, attached element, however deep it sits.
//   This is the fix for the old friction: render functions that build
//   their own containers (the work pane's skeleton, the tools pane's
//   inner tabs) used to need freshly created elements bound into a map
//   by hand, and the binding was forgotten exactly when a re-render
//   replaced them. Adoption makes the registry point at the newest
//   element carrying the id, always.
//
// - Clearing a subtree (innerHTML = '') does not unregister ids. The
//   next render re-assigns them and re-adopts, which is the same
//   lifecycle the real DOM gives a rebuilt view.

function createDom() {
    const elements = new Map();

    class Element {
        constructor(tag) {
            this.tag = tag;
            this.tagName = tag;
            this.style = {};
            this.children = [];
            this.value = '';
            this.checked = false;
            this.dataset = {};
            this.placeholder = '';
            this.className = '';
            this._id = '';
            this._html = '';
            this._listeners = {};
        }
        // Assigning an id adopts the element: the registry slot points
        // at the newest holder. Changing or clearing it releases the old
        // slot. A duplicate id is invalid HTML; the last one wins.
        get id() {
            return this._id;
        }
        set id(value) {
            const next = value == null ? '' : String(value);
            if (next === this._id) return;
            if (this._id && elements.get(this._id) === this) {
                elements.delete(this._id);
            }
            this._id = next;
            if (next) elements.set(next, this);
        }
        get innerHTML() {
            return this._html;
        }
        set innerHTML(value) {
            this._html = value == null ? '' : String(value);
            this.children = [];
        }
        get classList() {
            const self = this;
            const tokens = () => String(self.className || '').split(/\s+/).filter(Boolean);
            return {
                contains: token => tokens().includes(token),
                add: token => {
                    if (!tokens().includes(token)) {
                        self.className = [...tokens(), token].join(' ');
                    }
                },
                remove: token => {
                    self.className = tokens()
                        .filter(existing => existing !== token)
                        .join(' ');
                },
                toggle: (token, force) => {
                    const on = force === undefined ? !tokens().includes(token) : !!force;
                    const next = tokens().filter(existing => existing !== token);
                    if (on) next.push(token);
                    self.className = next.join(' ');
                    return on;
                },
            };
        }
        appendChild(child) {
            this.children.push(child);
            return child;
        }
        append(...children) {
            this.children.push(...children);
        }
        replaceChildren(...children) {
            this.children = children;
        }
        setAttribute(name, value) {
            if (name === 'id') {
                this.id = value;
                return;
            }
            this[name] = value;
        }
        getAttribute(name) {
            if (name === 'id') return this._id;
            return this[name];
        }
        removeAttribute(name) {
            if (name === 'id') {
                this.id = '';
                return;
            }
            delete this[name];
        }
        addEventListener(type, fn) {
            (this._listeners[type] = this._listeners[type] || []).push(fn);
        }
        removeEventListener(type, fn) {
            this._listeners[type] = (this._listeners[type] || []).filter(
                existing => existing !== fn
            );
        }
        getBoundingClientRect() {
            return { left: 0, top: 0, width: 100, height: 100 };
        }
        focus() {
            this.focused = true;
        }
        setSelectionRange(start, end) {
            this.selectionStart = start;
            this.selectionEnd = end;
        }
    }

    const document = {
        // Adopt-or-auto-create: a dynamically built element that was
        // assigned this id answers; an id never created stands in as an
        // orphan the way index.html markup would.
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, new Element('div'));
            return elements.get(id);
        },
        createElement(tag) {
            return new Element(tag);
        },
        createTextNode(text) {
            const node = new Element('#text');
            node.textContent = String(text);
            return node;
        },
        addEventListener() {},
        removeEventListener() {},
    };

    return { document, elements, Element };
}

module.exports = { createDom };
