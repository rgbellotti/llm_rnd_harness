// prism-manual.js — load before vendored Prism core. Disables Prism's
// automatic DOMContentLoaded highlighting: model code arrives dynamically
// via innerHTML, so highlight.js highlights each rendered block on insert.
window.Prism = window.Prism || {};
window.Prism.manual = true;
