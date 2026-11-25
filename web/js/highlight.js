// highlight.js — Prism highlighting for rendered model code blocks.
// Needs vendored Prism (window.Prism) loaded before use at runtime.
// Tool outputs never pass through here — plain textContent only.
function highlightRendered(root) {
    try {
        if (!root || !window.Prism || !Prism.highlightElement) return;
        const blocks = root.querySelectorAll('pre code[class*="language-"]');
        for (const el of blocks) {
            try { Prism.highlightElement(el); } catch (e) {}
        }
    } catch (e) {}
}

// The server emits escaped TeX in allowlisted placeholders. KaTeX creates
// MathML locally; model-provided HTML never enters the math renderer.
function renderMath(root) {
    if (!root || !window.katex) return;
    for (const el of root.querySelectorAll('.math-display, .math-inline')) {
        const source = el.textContent || '';
        try {
            katex.render(source, el, {
                displayMode: el.classList.contains('math-display'),
                output: 'mathml',
                throwOnError: false,
                trust: false,
            });
        } catch (e) { el.textContent = source; }
    }
}
