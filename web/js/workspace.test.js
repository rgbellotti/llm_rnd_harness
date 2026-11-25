const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { document, elements } = require('./testdom.js').createDom();

const drain = () => new Promise(resolve => setTimeout(resolve, 0));
const sandbox = {
    document,
    activeSid: 'tab-1',
    runningSid: null,
    // The flash note's clear timer must not run inside the vm.
    setTimeout: () => 1,
    clearTimeout: () => {},
    setStatus: () => {},
    renderTabBar: () => {},
    getSession: () => ({ id: 'tab-1' }),
    showSession: sid => { sandbox.shownSid = sid; },
    // The order pill persists its choice here.
    localStorage: {
        store: {},
        getItem(key) { return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null; },
        setItem(key, value) { this.store[key] = String(value); }
    },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(__dirname + '/workspace.js', 'utf8'), sandbox);
const evaluate = code => vm.runInContext(code, sandbox);

const listing = {
    root: '/tmp/lab',
    entries: [
        { name: 'docs', dir: true, children: [
            { name: 'readme.txt', dir: false },
            { name: 'design', dir: true, children: [
                { name: 'providers.md', dir: false },
            ] },
            { name: 'security', dir: true, children: [
                { name: 'run_sudo_cmd_open_findings.md', dir: false },
            ] },
        ] },
        { name: 'src', dir: true, children: [
            { name: 'main.rs', dir: false },
        ] },
        { name: 'Cargo.toml', dir: false },
        { name: 'Cargo.lock', dir: false },
    ],
    truncated: false,
};

(async () => {
    // ---- opening the pane ----
    let fetched = 0;
    sandbox.apiFetch = async () => { fetched += 1; return { ok: true, json: async () => listing }; };
    // The classic tree order (directories first) for the layout section
    // below; the files-first mode gets its own block further down.
    evaluate('workOrder = "dirs"');
    // The skeleton's created elements adopt their ids in the shared
    // fake DOM, so no hand binding is needed between building the pane
    // and the render that fills it.
    evaluate('ensureWorkSkeleton()');
    sandbox.showWork();
    assert.equal(evaluate('workActive'), true);
    assert.equal(document.getElementById('output').style.display, 'none');
    assert.equal(document.getElementById('workView').style.display, '');
    await drain(); await drain();
    assert.equal(fetched, 1, 'an empty pane fetches the listing');
    assert.ok(elements.get('workTree').children.length > 0, 'the tree rendered');

    // ---- the rendered layout (dirs first) ----
    // Directories come first with a trailing slash, children nested under
    // two-space indents, files after the directories at each level. The
    // copied path of a directory keeps that trailing slash, so a pasted
    // directory is ready for a filename.
    const spans = () => elements.get('workTree').children.filter(el => el.tag === 'span');
    let lines = spans();
    assert.equal(lines[0].getAttribute('data-path'), 'docs/');
    assert.equal(lines[0].textContent, 'docs/');
    assert.equal(lines[0].className.includes('work-dir'), true);
    assert.equal(lines[1].getAttribute('data-path'), 'docs/design/');
    assert.equal(lines[1].textContent, '  design/');
    const providers = lines.find(el => el.getAttribute('data-path') === 'docs/design/providers.md');
    assert.ok(providers, 'a depth-three file is rendered');
    assert.equal(providers.textContent, '    providers.md');
    // A file beside the directories stays under them in this mode.
    const readme = lines.find(el => el.getAttribute('data-path') === 'docs/readme.txt');
    assert.ok(readme, 'a file directly under docs/ is rendered');
    const docsChildren = lines.filter(el => el.getAttribute('data-path').startsWith('docs/'));
    assert.ok(docsChildren.indexOf(readme) > docsChildren.indexOf(providers), 'in dirs-first mode a folder\'s files list after its subdirectories');
    const cargo = lines.find(el => el.getAttribute('data-path') === 'Cargo.toml');
    assert.ok(cargo, 'root-level files are rendered');
    assert.equal(cargo.className.includes('work-dir'), false);

    // A truncated listing says so, in a line that is not an entry.
    evaluate('renderWorkListing(' + JSON.stringify({ root: '/x', entries: [], truncated: true }) + ')');
    const cap = spans()[0];
    assert.equal(cap.className, 'work-cap');
    assert.equal(cap.getAttribute('data-path'), undefined);

    // ---- click-to-copy ----
    evaluate('renderWorkListing(' + JSON.stringify(listing) + ')');
    let copied = null;
    sandbox.writeOsClipboard = text => { copied = String(text); return Promise.resolve(true); };
    // The tree carries one delegated click listener; the span is the target.
    const treeEl = elements.get('workTree');
    const clickTree = event => treeEl._listeners.click[0](event);
    const span = spans().find(el => el.getAttribute('data-path') === 'src/main.rs');
    clickTree({ target: span });
    await drain();
    assert.equal(copied, 'src/main.rs');
    assert.match(elements.get('workNote').textContent, /^copied: src\/main\.rs$/);

    // A directory click copies the trailing slash with it.
    const docs = spans().find(el => el.getAttribute('data-path') === 'docs/');
    clickTree({ target: docs });
    await drain();
    assert.equal(copied, 'docs/');

    // The root path sits in the head row under the pane title — printed
    // verbatim, click copies the absolute directory with the trailing
    // slash. The row holds two actions: refresh and the order pill.
    const workView = elements.get('workView');
    assert.equal(workView.children[0].className, 'pane-title', 'the pane opens with the large title');
    const headRow = workView.children[1];
    assert.equal(headRow.children[0].id, 'workRoot');
    assert.equal(headRow.children[0].textContent, '/tmp/lab');
    assert.equal(headRow.children[1].children.length, 2, 'refresh and order actions in the head row');
    assert.equal(headRow.children[1].children[1].id, 'workOrderBtn');
    document.getElementById('workRoot').onclick();
    await drain();
    assert.equal(copied, '/tmp/lab/');

    // A click while text is selected is a selection, not a copy: the
    // person's own dragged selection is left alone.
    sandbox.window = { getSelection: () => ({ toString: () => 'several selected names' }) };
    copied = null;
    clickTree({ target: span });
    await drain();
    assert.equal(copied, null, 'a text selection is not hijacked into a copy');
    delete sandbox.window;

    // ---- collapse via right-click ----
    // Left-click stays a copy; right-click on a directory with children
    // folds it away, and the hover note names the state so a collapsed
    // folder is never mistaken for an empty one.
    const workTreeEl = elements.get('workTree');
    const contextMenu = event => workTreeEl._listeners.contextmenu[0](event);
    const docsOpen = spans().find(el => el.getAttribute('data-path') === 'docs/');
    assert.equal(docsOpen.title, 'right-click to collapse', 'the expanded state names its action');
    contextMenu({ target: docsOpen, preventDefault() {} });
    assert.equal(
        spans().find(el => el.getAttribute('data-path') === 'docs/design/'),
        undefined,
        'a collapsed directory renders no children'
    );
    const docsShut = spans().find(el => el.getAttribute('data-path') === 'docs/');
    assert.equal(docsShut.title, 'right-click to expand', 'the collapsed state names its action');
    contextMenu({ target: docsShut, preventDefault() {} });
    assert.ok(spans().find(el => el.getAttribute('data-path') === 'docs/design/'), 'a second right-click restores the children');
    // A file has nothing to fold: the handler leaves it alone.
    contextMenu({ target: cargo, preventDefault() {} });
    assert.ok(spans().find(el => el.getAttribute('data-path') === 'Cargo.toml'), 'a file ignores right-click');
    // Right-click never reaches the copy path.
    copied = null;
    contextMenu({ target: docsOpen, preventDefault() {} });
    await drain();
    assert.equal(copied, null, 'right-click is a fold, not a copy');
    contextMenu({ target: spans().find(el => el.getAttribute('data-path') === 'docs/'), preventDefault() {} });
    evaluate('collapsedWorkDirs.clear()');

    // ---- the order pill ----
    // Files first is the shipped default: every level leads with files,
    // so a folder's own documents are never buried under subdirectories.
    evaluate('workOrder = "files"');
    evaluate('renderWorkListing(workListing)');
    lines = spans();
    assert.equal(lines[0].getAttribute('data-path'), 'Cargo.lock', 'root files lead in files-first mode');
    assert.equal(lines[1].getAttribute('data-path'), 'Cargo.toml');
    assert.equal(lines[2].getAttribute('data-path'), 'docs/');
    const docsBlock = lines.filter(el => {
        const p = el.getAttribute('data-path');
        return p.startsWith('docs/') && p !== 'docs/';
    });
    // The folder's own file comes first, its subdirectories after.
    assert.equal(docsBlock[0].getAttribute('data-path'), 'docs/readme.txt', 'a folder\'s files lead its subdirectories in files-first mode');
    assert.equal(docsBlock[1].getAttribute('data-path'), 'docs/design/', 'then the subdirectories fan out');
    // The pill names the current mode, flips it, persists the choice,
    // and re-renders in the other order.
    const orderBtn = elements.get('workOrderBtn');
    assert.equal(orderBtn.textContent, 'files first');
    evaluate('toggleWorkOrder()');
    assert.equal(evaluate('workOrder'), 'dirs');
    assert.equal(orderBtn.textContent, 'dirs first');
    assert.equal(sandbox.localStorage.store['harness.work.order'], 'dirs', 'the choice persists in the browser');
    assert.equal(spans()[0].getAttribute('data-path'), 'docs/', 'the flip re-renders directories first');
    evaluate('toggleWorkOrder()');
    assert.equal(evaluate('workOrder'), 'files');

    // ---- leaving the pane ----
    sandbox.showWork();
    assert.equal(fetched, 1, 'a fresh listing is not re-read on re-open');
    evaluate('closeWork()');
    assert.equal(sandbox.shownSid, 'tab-1', 'close lands back on the active session');
    // No session to land on: the view hides directly.
    sandbox.getSession = () => null;
    evaluate('closeWork()');
    assert.equal(evaluate('workActive'), false);
    assert.equal(document.getElementById('workView').style.display, 'none');

    console.log('Work pane tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
