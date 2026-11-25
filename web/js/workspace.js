// workspace.js — the "work" pane: a listing of the workspace directory.
// One surface, two affordances: the lines are plain text, so several
// names can be dragged over with the mouse and copied for a prompt; and a
// plain click on one name (or the root path beside the heading) copies
// that path — directories and the root carry a trailing slash, ready for
// a filename to follow. The listing comes from GET /workspace (capped
// server-side) and refreshes when it is stale. Needs core.js (apiFetch,
// setStatus, writeOsClipboard) and tabs.js (deactivatePanes, showSession,
// renderTabBar).
let workActive = false;

// The last listing and when it arrived. Opening the pane refetches a
// stale copy, so a run that wrote files is reflected the next time the
// pane is opened; the refresh button forces it.
let workListing = null;
let workFetchedAt = 0;
let workBusy = false;
let workNoteTimer = null;
const WORK_STALE_MS = 30000;

// Display order: files or directories first, tree-wide. Remembered per
// browser; the header pill flips it.
let workOrder = 'files';
const WORK_ORDER_KEY = 'harness.work.order';

// Directories the person has collapsed, by workspace-relative path.
// Right-click toggles; a refresh re-renders but keeps the set.
const collapsedWorkDirs = new Set();

function loadWorkOrder() {
    try {
        if (typeof localStorage === 'undefined' || !localStorage.getItem) return 'files';
        const stored = localStorage.getItem(WORK_ORDER_KEY);
        if (stored === 'files' || stored === 'dirs') return stored;
    } catch (e) {}
    return 'files';
}
workOrder = loadWorkOrder();

function showWork() {
    if (typeof deactivatePanes === 'function') deactivatePanes();
    workActive = true;
    document.getElementById('output').style.display = 'none';
    document.getElementById('workView').style.display = '';
    setStatus('');
    renderTabBar();
    ensureWorkSkeleton();
    // Stale-based: toggling the pane in and out does not re-read an
    // unchanged tree; the refresh button is the explicit re-read.
    maybeRefreshWork(false);
}

// Leaving the pane lands back on the active session, like history's back.
function closeWork() {
    if (typeof activeSid !== 'undefined' && typeof getSession === 'function'
        && activeSid && getSession(activeSid)) {
        showSession(activeSid);
    } else {
        workActive = false;
        document.getElementById('workView').style.display = 'none';
    }
}

// The pane is built once, then only the tree is refilled. Nothing here
// is model-controlled, so the names are set through textContent and the
// paths ride a data attribute, never markup. The large title is the top
// boundary of the box, level with every other pane's title.
function ensureWorkSkeleton() {
    const view = document.getElementById('workView');
    if (!view || view.getAttribute('data-built') === '1') return;
    view.setAttribute('data-built', '1');
    const title = document.createElement('h2');
    title.className = 'pane-title';
    title.textContent = 'Workspace';
    view.appendChild(title);
    const headRow = document.createElement('div');
    headRow.className = 'work-head-row';
    // The verbatim workspace root, printed under the title and clickable
    // to copy like every name below it.
    const rootEl = document.createElement('span');
    rootEl.id = 'workRoot';
    rootEl.className = 'work-root';
    rootEl.title = 'Click to copy the absolute workspace path';
    rootEl.onclick = () => copyWorkPath(workRootPath());
    headRow.appendChild(rootEl);
    const refresh = document.createElement('button');
    refresh.className = 'copy-btn';
    refresh.type = 'button';
    refresh.textContent = 'refresh';
    refresh.title = 'Re-read the directory now';
    refresh.onclick = () => maybeRefreshWork(true);
    const orderBtn = document.createElement('button');
    orderBtn.className = 'copy-btn';
    orderBtn.type = 'button';
    orderBtn.id = 'workOrderBtn';
    orderBtn.title = 'Toggle whether files or subdirectories list first at every level.';
    orderBtn.onclick = () => toggleWorkOrder();
    const actions = document.createElement('span');
    actions.className = 'round-actions';
    actions.appendChild(refresh);
    actions.appendChild(orderBtn);
    headRow.appendChild(actions);
    view.appendChild(headRow);
    const note = document.createElement('p');
    note.id = 'workNote';
    note.className = 'hint';
    view.appendChild(note);
    const tree = document.createElement('pre');
    tree.id = 'workTree';
    view.appendChild(tree);
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Left-click to copy the relative path. Right-click to collapse/expand a subdirectory.';
    view.appendChild(hint);
    if (typeof tree.addEventListener === 'function') {
        tree.addEventListener('click', onWorkTreeClick);
        // Right-click never reaches the copy path: it folds or unfolds
        // the directory under the pointer. The browser menu is replaced.
        tree.addEventListener('contextmenu', onWorkTreeContextMenu);
    }
}

// `force` skips the staleness check; the plain call is what opening the
// pane uses, so an unchanged tree is not re-read every visit.
async function maybeRefreshWork(force) {
    const note = document.getElementById('workNote');
    if (workBusy) return;
    const stale = !workListing
        || (typeof Date === 'function' && Date.now() - workFetchedAt > WORK_STALE_MS);
    if (!force && !stale) return;
    workBusy = true;
    if (note) note.textContent = 'loading…';
    try {
        const res = await apiFetch('/workspace');
        if (!res.ok) throw new Error(await res.text() || ('HTTP ' + res.status));
        workListing = await res.json();
        workFetchedAt = typeof Date === 'function' ? Date.now() : 0;
        renderWorkListing(workListing);
    } catch (e) {
        if (note) note.textContent = 'The workspace listing failed: ' + String((e && e.message) || e);
    } finally {
        workBusy = false;
    }
}

function renderWorkListing(listing) {
    const note = document.getElementById('workNote');
    const tree = document.getElementById('workTree');
    if (!tree || !listing) return;
    const rootEl = document.getElementById('workRoot');
    if (rootEl) rootEl.textContent = String(listing.root || '');
    if (typeof tree.replaceChildren === 'function') tree.replaceChildren();
    else tree.textContent = '';
    const entries = Array.isArray(listing.entries) ? listing.entries : [];
    appendWorkEntries(tree, entries, '', 0);
    if (listing.truncated) {
        const cap = document.createElement('span');
        cap.className = 'work-cap';
        cap.textContent = '… (listing capped: open the directory for more)';
        tree.appendChild(cap);
    }
    if (note) {
        note.textContent = entries.length ? '' : 'The workspace directory is empty (or nothing readable is in it).';
    }
    const orderBtn = document.getElementById('workOrderBtn');
    if (orderBtn) orderBtn.textContent = workOrder === 'dirs' ? 'dirs first' : 'files first';
}

// Files or directories first, tree-wide, alphabetical within each group.
function orderedWorkEntries(entries) {
    const filesFirst = workOrder !== 'dirs';
    return entries.slice().sort((a, b) => {
        const aDir = !!(a && a.dir);
        const bDir = !!(b && b.dir);
        if (aDir !== bDir) {
            if (filesFirst) return aDir ? 1 : -1;
            return aDir ? -1 : 1;
        }
        const aName = String((a && a.name) || '').toLowerCase();
        const bName = String((b && b.name) || '').toLowerCase();
        return aName < bName ? -1 : aName > bName ? 1 : 0;
    });
}

function appendWorkEntries(parent, entries, prefix, depth) {
    for (const entry of orderedWorkEntries(entries)) {
        const name = String((entry && entry.name) || '');
        if (!name) continue;
        // Directories carry their trailing slash in the copied path, so a
        // pasted directory is ready for a filename to follow it. `prefix`
        // always ends with a slash (children only exist under directories).
        const path = prefix + name + (entry.dir ? '/' : '');
        const hasChildren = !!entry.dir && Array.isArray(entry.children) && entry.children.length > 0;
        const line = document.createElement('span');
        line.className = 'work-entry' + (entry.dir ? ' work-dir' : '');
        line.setAttribute('data-path', path);
        if (entry.dir) line.setAttribute('data-has-children', hasChildren ? '1' : '0');
        // The hover note names the current state, so a collapsed
        // directory is not mistaken for an empty one.
        if (hasChildren) {
            line.title = collapsedWorkDirs.has(path) ? 'right-click to expand' : 'right-click to collapse';
        }
        line.textContent = '  '.repeat(depth) + name + (entry.dir ? '/' : '');
        parent.appendChild(line);
        parent.appendChild(document.createTextNode('\n'));
        if (hasChildren && !collapsedWorkDirs.has(path)) {
            appendWorkEntries(parent, entry.children, path, depth + 1);
        }
    }
}

function toggleWorkOrder() {
    workOrder = workOrder === 'dirs' ? 'files' : 'dirs';
    try {
        if (typeof localStorage !== 'undefined' && localStorage.setItem) {
            localStorage.setItem(WORK_ORDER_KEY, workOrder);
        }
    } catch (e) {}
    renderWorkListing(workListing);
}

// Right-click on a directory folds or unfolds it. The browser context
// menu is replaced on the tree only; left-click still copies the path.
function onWorkTreeContextMenu(event) {
    const target = event && event.target;
    if (!target || typeof target.getAttribute !== 'function') return;
    if (String(target.getAttribute('data-has-children') || '') !== '1') return;
    const path = String(target.getAttribute('data-path') || '');
    if (!path) return;
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (collapsedWorkDirs.has(path)) collapsedWorkDirs.delete(path);
    else collapsedWorkDirs.add(path);
    renderWorkListing(workListing);
}

// The absolute workspace path with its trailing slash: a pasted root is
// ready for a filename the same way a pasted directory is.
function workRootPath() {
    const root = workListing && workListing.root ? String(workListing.root) : '';
    if (!root) return '';
    return root.endsWith('/') ? root : root + '/';
}

// One copy path for every clickable element in the pane. A drag that
// selected text is not a click: the selection is the person's own copy,
// so it is left alone.
function copyWorkPath(path) {
    if (!path) return;
    let selected = '';
    try {
        if (typeof window !== 'undefined' && typeof window.getSelection === 'function') {
            selected = String(window.getSelection().toString());
        }
    } catch (e) {}
    if (selected && selected.trim()) return;
    if (typeof writeOsClipboard !== 'function') return;
    writeOsClipboard(path).then(ok => flashWorkNote(
        ok ? ('copied: ' + path) : ('copy failed: ' + path)
    ));
}

function onWorkTreeClick(event) {
    const target = event && event.target;
    if (!target || typeof target.getAttribute !== 'function') return;
    copyWorkPath(String(target.getAttribute('data-path') || ''));
}

function flashWorkNote(text) {
    const note = document.getElementById('workNote');
    if (!note) return;
    note.textContent = text;
    if (workNoteTimer && typeof clearTimeout === 'function') clearTimeout(workNoteTimer);
    workNoteTimer = typeof setTimeout === 'function'
        ? setTimeout(() => { note.textContent = ''; workNoteTimer = null; }, 1500)
        : null;
}
