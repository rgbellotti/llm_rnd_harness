// tabs.js — session tabs: model, bar, switching, creation, archiving,
// config view, and session lifecycle (finish/clear/new). Needs core.js.
function tabTitle(s) {
    const base = (s.prompt || '').trim().split('\n')[0].slice(0, 30) || 'untitled';
    return '#' + s.num + ' ' + base;
}
let configActive = false;
let historyActive = false;
let creditsActive = false;
let docsActive = false;
let toolsActive = false;
let decisionActive = false;
let promptExpanded = false;
// Set when the user collapses the editor on a wide screen, so a resize
// back to wide does not force the tool row open again.
let promptCollapseChosen = false;
let cachedConfig = null;
// Copy uses the OS clipboard. Ctrl+V pastes. The slot stays defined so a
// cleared session still has somewhere to empty.
let editorSlot = '';
// Text typed into the prompt of a finished chain, before that edit
// becomes its own fresh tab.
let composerDraft = '';
const UPLOAD_MAX_BYTES = 1024 * 1024;
const UPLOAD_MAX_FILES = 10;
function renderTabBar() {
    const bar = document.getElementById('tabbar');
    bar.innerHTML = '';
    // Chrome buttons (config, history, prompt edit) live statically in the
    // top and bottom rows; only their active state is reflected here, so
    // the tab bar itself holds session tabs alone.
    const cfg = document.getElementById('configBtn');
    if (cfg) cfg.classList.toggle('active', configActive);
    const docsBtn = document.getElementById('docsBtn');
    if (docsBtn) docsBtn.classList.toggle('active', docsActive);
    const toolsBtn = document.getElementById('toolsBtn');
    if (toolsBtn) toolsBtn.classList.toggle('active', toolsActive);
    const decisionBtn = document.getElementById('decisionBtn');
    if (decisionBtn) decisionBtn.classList.toggle('active', decisionActive);
    const memoryBtn = document.getElementById('memoryBtn');
    if (memoryBtn) memoryBtn.classList.toggle('active', typeof memoryActive !== 'undefined' && memoryActive);
    const creditsBtn = document.getElementById('creditsBtn');
    if (creditsBtn) creditsBtn.classList.toggle('active', creditsActive);
    const hb = document.getElementById('historyBtn');
    if (hb) {
        hb.classList.toggle('active', historyActive);
        // In history mode the button reads "back" — a visible return path
        // to the live workspace.
        hb.textContent = historyActive ? 'back' : 'history';
    }
    const ed = document.getElementById('promptEditBtn');
    if (ed) ed.classList.toggle('active', promptExpanded);
    for (const s of sessions) {
        const b = document.createElement('button');
        b.className = 'tab-btn' + (s.id === activeSid ? ' active' : '') + (s.id === runningSid ? ' running' : '');
        b.type = 'button';
        b.textContent = tabTitle(s);
        b.title = s.prompt || 'untitled';
        b.onclick = () => showSession(s.id);
        bar.appendChild(b);
    }
    syncNewTabBtn();
    document.getElementById('newSessionBtn').disabled = runningSid !== null;
    syncPromptDock();
    syncStopBtn();
    syncPromptUI();
    syncModelMenu();
    syncActivityIcon();
}
function deactivatePanes() {
    configActive = false;
    historyActive = false;
    creditsActive = false;
    docsActive = false;
    toolsActive = false;
    decisionActive = false;
    if (typeof memoryActive !== 'undefined') memoryActive = false;
    if (typeof workActive !== 'undefined') workActive = false;
    // The manual test view is nested inside the tools pane now, so
    // hiding the pane hides it; it is not a top-level view.
    const ids = ['configView', 'historyView', 'creditsView', 'docsView', 'toolsView', 'workView', 'memoryView', 'decisionView'];
    for (let i = 0; i < ids.length; i++) {
        const el = document.getElementById(ids[i]);
        if (el) el.style.display = 'none';
    }
}
function showSession(sid) {
    const s = getSession(sid);
    if (!s) return;
    activeSid = sid;
    deactivatePanes();
    // Leave viewing mode: prompt workspace visible again, with the
    // editor extras exactly as the expand state dictates.
    document.getElementById('prompt').style.display = '';
    document.getElementById('bottom_row_buttons').style.display = '';
    document.getElementById('promptTools').style.display = promptExpanded ? '' : 'none';
    syncProtocolBox();
    const output = document.getElementById('output');
    output.style.display = '';
    output.innerHTML = '';
    output.appendChild(s.nodes.container);
    setStatus(s.statusText || '');
    renderTabBar();
    if (typeof onSessionShown === 'function') onSessionShown(s);
}
async function refreshConfig() {
    // Always refetch: the registration can change between runs
    // (--tools at startup), so the cache must not go stale.
    // Falls back to the previous snapshot on failure.
    try {
        const res = await apiFetch('/config');
        if (!res.ok) throw new Error(await res.text() || ('HTTP ' + res.status));
        cachedConfig = await res.json();
        if (typeof applyHistoryGate === 'function') applyHistoryGate(cachedConfig);
        if (typeof applyGrokControls === 'function') applyGrokControls();
        if (typeof restoreStoredRole === 'function') await restoreStoredRole();
        if (typeof restoreStoredDefaultModel === 'function') await restoreStoredDefaultModel();
        return true;
    } catch (e) {
        return cachedConfig !== null;
    }
}
// Narrow screens expand the prompt in place. A wide screen keeps that
// box in the left lane whenever nothing is running, including while
// history is open on the right. A run gives the lane to Thinking.
function promptLaneWide() {
    try {
        return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(min-width: 1920px)').matches;
    } catch (e) {
        return false;
    }
}
function promptRunLive() {
    try { return typeof runningSid !== 'undefined' && runningSid !== null; } catch (e) { return false; }
}
// History on a narrow screen hides the composer. On a wide screen the
// composer stays in the left lane so rounds can be curated beside it.
function syncHistoryComposer() {
    const beside = promptLaneWide() && !promptRunLive();
    // Narrow history hides Stop, prompt edit, and New tab. The session
    // tabs stay on that row so the dashboard can still switch sessions.
    const hideRunRow = historyActive && !beside;
    const left = document.getElementById('bottom_row_left');
    const right = document.getElementById('bottom_row_right');
    if (left) left.style.display = hideRunRow ? 'none' : '';
    if (right) right.style.display = hideRunRow ? 'none' : '';
    const actions = document.getElementById('composerActions');
    // Generate and Upload live under the prompt. A live run hides them;
    // Stop stays on the tab row. Narrow history hides them with the box.
    const hideActions = promptRunLive() || (historyActive && !beside);
    if (actions) actions.style.display = hideActions ? 'none' : '';
    const prompt = document.getElementById('prompt');
    if (historyActive) {
        const bottom = document.getElementById('bottom_row_buttons');
        const tools = document.getElementById('promptTools');
        if (prompt) prompt.style.display = beside ? '' : 'none';
        if (bottom) bottom.style.display = '';
        if (tools) tools.style.display = beside && promptExpanded ? '' : 'none';
    }
    const lane = document.getElementById('vimLaneToggle');
    if (lane) lane.style.display = (prompt && prompt.style.display === 'none') ? 'none' : '';
    syncProtocolBox();
}
// The context submenu stays with the prompt. Prompt edit opens the
// Save row and the tall editor; it does not hide this box. A narrow
// history hides the prompt, and the submenu goes with it.
function syncProtocolBox() {
    const protocol = document.getElementById('protocolBox');
    if (!protocol) return;
    const prompt = document.getElementById('prompt');
    const hidden = !!(prompt && prompt.style.display === 'none');
    protocol.style.display = hidden ? 'none' : '';
}
// The button exists in the page markup so its click handler can be
// wired at startup. It leaves the document until the active chain has
// finished, then returns to the bottom row.
let newTabButton = null;
function syncNewTabBtn() {
    if (!newTabButton) {
        const found = document.getElementById('newTabBtn');
        if (found) newTabButton = found;
    }
    if (!newTabButton) return;
    const a = typeof activeSession === 'function' ? activeSession() : null;
    const show = !!(a && (a.status === 'done' || a.status === 'error') && !promptRunLive());
    const home = document.getElementById('bottom_row_right');
    if (!show) {
        const parent = newTabButton.parentNode;
        if (parent && typeof parent.removeChild === 'function') parent.removeChild(newTabButton);
        return;
    }
    newTabButton.disabled = false;
    if (home && newTabButton.parentNode !== home && typeof home.appendChild === 'function') home.appendChild(newTabButton);
}
function syncPromptDock() {
    const wideIdle = promptLaneWide() && !promptRunLive();
    // The wide lane is the editor. Collapse and prompt edit are narrow-only.
    if (wideIdle && !promptExpanded) {
        promptExpanded = true;
        promptCollapseChosen = false;
        const box = document.getElementById('prompt');
        if (box && box.classList) box.classList.toggle('expanded', true);
        const tools = document.getElementById('promptTools');
        if (tools) tools.style.display = '';
    }
    const dock = !!wideIdle;
    const body = document.body;
    if (body && body.classList && typeof body.classList.toggle === 'function') body.classList.toggle('prompt-docked', dock);
    syncHistoryComposer();
    // Resize can measure the vim label before this class moves the prompt.
    // Read the box again after the move, or a return to the wide lane leaves
    // the label where the narrow prompt sat, on the right side of the page.
    if (typeof vimSyncChrome === 'function') vimSyncChrome();
}
function setPromptExpanded(on) {
    const live = promptRunLive();
    // A wide idle screen has no collapse control, so the editor stays open.
    if (!live && promptLaneWide()) on = true;
    if (on && !live) promptCollapseChosen = false;
    if (!on && !live && promptLaneWide()) promptCollapseChosen = true;
    promptExpanded = !!on && !live;
    const box = document.getElementById('prompt');
    if (box && box.classList) box.classList.toggle('expanded', promptExpanded);
    const tools = document.getElementById('promptTools');
    if (tools) tools.style.display = promptExpanded ? '' : 'none';
    syncProtocolBox();
    if (typeof refreshPromptBox === 'function') refreshPromptBox();
    renderTabBar();
}
function showCredits() {
    deactivatePanes();
    creditsActive = true;
    document.getElementById('output').style.display = 'none';
    const view = document.getElementById('creditsView');
    if (view) view.style.display = '';
    setStatus('');
    renderTabBar();
}
function showDocs() {
    deactivatePanes();
    docsActive = true;
    document.getElementById('output').style.display = 'none';
    const view = document.getElementById('docsView');
    if (view) view.style.display = '';
    setStatus('');
    renderTabBar();
    renderDocs();
}
async function openRegistration(which) {
    deactivatePanes();
    if (which === 'tools') toolsActive = true;
    else configActive = true;
    const other = document.getElementById(which === 'tools' ? 'configView' : 'toolsView');
    if (other) other.innerHTML = '';
    document.getElementById('output').style.display = 'none';
    const cv = document.getElementById(which === 'tools' ? 'toolsView' : 'configView');
    if (!cv) return;
    cv.style.display = '';
    setStatus('');
    renderTabBar();
    cv.innerHTML = '<div class="round"><p>Loading registration…</p></div>';
    if (!await refreshConfig()) {
        cv.innerHTML = '';
        const d = document.createElement('div');
        d.className = 'error';
        d.textContent = 'Could not load /config — is the server running?';
        cv.appendChild(d);
        return;
    }
    if (which === 'tools') renderTools();
    else renderConfig();
}
async function showConfig() {
    await openRegistration('config');
}
async function showTools() {
    await openRegistration('tools');
}
async function showDecision() {
    deactivatePanes();
    decisionActive = true;
    document.getElementById('output').style.display = 'none';
    const view = document.getElementById('decisionView');
    if (view) view.style.display = '';
    setStatus('');
    renderTabBar();
    // Always refetch: installed decision models can change between runs
    // (a newly-pulled `d3` tag appears on the next open).
    await refreshConfig();
    if (typeof renderDecision === 'function') renderDecision();
}
function configCopyBtn(text) {
    const b = document.createElement('button');
    b.className = 'copy-btn';
    b.type = 'button';
    b.textContent = 'copy';
    b.onclick = () => copyText(text, b);
    return b;
}
let historyBannerKind = '';
function applyHistoryGate(config) {
    const banner = document.getElementById('historyBanner');
    const label = document.getElementById('unrecordedLabel');
    if (!banner || !label || !config) return;
    if (config.history_recording !== false) {
        label.style.display = 'none';
        // An interrupted-run note is a separate reminder. A later config
        // refresh leaves it up until the recording banner replaces it.
        if (historyBannerKind === 'interrupted') return;
        banner.style.display = 'none';
        banner.textContent = '';
        historyBannerKind = '';
        return;
    }
    historyBannerKind = 'recording';
    const reason = config.history_error || 'history is unavailable';
    banner.style.display = '';
    banner.textContent = 'Session history is unavailable (' + reason + '). New runs stay refused until you allow an unrecorded session.';
    label.style.display = '';
}
function fillThemePresetList(box) {
    box.innerHTML = '';
    const active = typeof highlightTheme === 'function' ? highlightTheme() : '';
    for (const choice of listThemeChoices()) {
        const row = document.createElement('div');
        row.className = 'theme-preset' + (choice.id === active ? ' active' : '');
        row.presetId = choice.id;
        const select = document.createElement('button');
        select.type = 'button';
        select.className = 'copy-btn theme-preset-select';
        select.textContent = choice.name;
        select.title = choice.builtin
            ? choice.name + ' is built in'
            : 'Use ' + choice.name;
        select.onclick = () => {
            if (typeof applyHighlightTheme === 'function') applyHighlightTheme(choice.id);
            refreshThemePresetList();
            syncThemeEditor();
        };
        row.appendChild(select);
        if (!choice.builtin) {
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'copy-btn theme-preset-delete';
            del.id = 'theme-delete-' + choice.id;
            del.textContent = 'delete';
            del.title = 'Delete ' + choice.name;
            del.onclick = () => {
                if (typeof deleteThemePreset === 'function') deleteThemePreset(choice.id);
                refreshThemePresetList();
                syncThemeEditor();
            };
            row.appendChild(del);
        }
        box.appendChild(row);
    }
    if (active === 'custom') {
        const note = document.createElement('div');
        note.className = 'theme-preset-note';
        note.id = 'theme-unsaved';
        note.textContent = 'Unsaved colors';
        box.appendChild(note);
    }
}
function refreshThemePresetList() {
    const box = document.getElementById('theme-presets');
    if (!box || typeof listThemeChoices !== 'function') return;
    fillThemePresetList(box);
}
function syncThemeEditor() {
    if (typeof themeColor !== 'function' || typeof themeFields !== 'function') return;
    for (const row of themeFields()) {
        const hex = themeColor(row[1]);
        const selector = document.getElementById('theme-selector-' + row[1]);
        const text = document.getElementById('theme-color-' + row[1]);
        if (selector) selector.value = hex;
        if (text) {
            text.value = hex;
            text.className = '';
        }
    }
}
function renderThemeControls(head) {
    const label = document.createElement('div');
    label.className = 'metrics';
    label.textContent = 'Themes';
    head.appendChild(label);
    const presets = document.createElement('div');
    presets.id = 'theme-presets';
    presets.className = 'theme-presets';
    fillThemePresetList(presets);
    head.appendChild(presets);
    const editor = document.createElement('div');
    editor.id = 'theme-editor';
    editor.className = 'theme-editor';
    let group = '';
    for (const row of themeFields()) {
        if (row[0] !== group) {
            group = row[0];
            const heading = document.createElement('div');
            heading.className = 'theme-group';
            heading.textContent = group;
            editor.appendChild(heading);
        }
        const key = row[1];
        const hex = typeof themeColor === 'function' ? themeColor(key) : row[3];
        const field = document.createElement('label');
        field.className = 'theme-field';
        const name = document.createElement('span');
        name.textContent = row[2];
        const selector = document.createElement('input');
        selector.type = 'color';
        selector.id = 'theme-selector-' + key;
        selector.value = hex;
        selector.title = 'Select ' + row[2];
        const text = document.createElement('input');
        text.type = 'text';
        text.id = 'theme-color-' + key;
        text.value = hex;
        text.maxLength = 7;
        text.spellcheck = false;
        text.autocapitalize = 'off';
        text.title = 'HTML hex for ' + row[2];
        selector.oninput = () => {
            text.value = selector.value;
            text.className = '';
            if (typeof setThemeColor === 'function') setThemeColor(key, selector.value);
            refreshThemePresetList();
        };
        text.oninput = () => {
            const next = typeof normalizeHex === 'function' ? normalizeHex(text.value) : '';
            if (next) {
                text.className = '';
                selector.value = next;
                if (typeof setThemeColor === 'function') setThemeColor(key, next);
                refreshThemePresetList();
            } else if (String(text.value || '').trim().length >= 7) {
                text.className = 'bad';
            } else {
                text.className = '';
            }
        };
        text.onblur = () => {
            const current = typeof themeColor === 'function' ? themeColor(key) : hex;
            if (typeof normalizeHex !== 'function' || !normalizeHex(text.value)) {
                text.value = current;
                selector.value = current;
                text.className = '';
            }
        };
        field.appendChild(name);
        field.appendChild(selector);
        field.appendChild(text);
        editor.appendChild(field);
    }
    head.appendChild(editor);
    const saveRow = document.createElement('div');
    saveRow.className = 'theme-save-row';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.id = 'theme-preset-name';
    nameInput.maxLength = 40;
    nameInput.placeholder = 'Preset name';
    nameInput.title = 'Name for the colors currently shown';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'copy-btn';
    save.id = 'theme-preset-save';
    save.textContent = 'Save preset';
    const error = document.createElement('div');
    error.className = 'metrics';
    error.id = 'theme-preset-error';
    save.onclick = () => {
        const problem = typeof themePresetError === 'function' ? themePresetError(nameInput.value) : '';
        if (problem) {
            error.textContent = problem;
            return;
        }
        if (typeof saveThemePreset === 'function') saveThemePreset(nameInput.value);
        nameInput.value = '';
        error.textContent = '';
        refreshThemePresetList();
    };
    saveRow.appendChild(nameInput);
    saveRow.appendChild(save);
    head.appendChild(saveRow);
    head.appendChild(error);
}
function renderConfig() {
    const c = cachedConfig;
    const cv = document.getElementById('configView');
    cv.innerHTML = '';
    const enabled = new Set(c.enabled_tools || []);
    const names = (c.tools || []).map(t => (t.function && t.function.name) || '?').filter(n => n !== '?');
    const total = names.length;
    const active = names.filter(n => enabled.has(n)).length;

    const paneTitle = document.createElement('h2');
    paneTitle.className = 'pane-title';
    paneTitle.textContent = 'Session registration';
    cv.appendChild(paneTitle);

    const head = document.createElement('div');
    head.className = 'round';
    const meta = document.createElement('div');
    meta.className = 'tool';
    const metaText = 'model: ' + c.model
        + (c.model_cloud ? ' (' + cloudEgressLabel() + ')' : ' (local)')
        + '\nmax_tool_rounds: ' + (c.max_tool_rounds == null ? 'unlimited' : c.max_tool_rounds)
        + '\nworkspace: ' + (c.workspace_dir || '(unknown)')
        + '\ngrok api: ' + (c.grok_key ? 'XAI_API_KEY is loaded' : 'XAI_API_KEY is not set')
        + '\nreflection api: ' + (c.reflection_key ? 'REFLECTION_API_KEY is loaded' : 'REFLECTION_API_KEY is not set')
        + '\nopencode api: ' + (c.opencode_key ? 'OPENCODE_API_KEY is loaded' : 'OPENCODE_API_KEY is not set')
        + '\nollama server: ' + (c.ollama_server ? 'running' : 'not reachable')
        + '\nharness db key: ' + (c.harness_db_key ? 'HARNESS_DB_KEY is loaded' : 'HARNESS_DB_KEY is not set')
        + '\ncustom files: ' + (c.custom_files.length ? c.custom_files.join(', ') : '(none — run_cmd only)');
    meta.textContent = metaText;
    head.appendChild(meta);
    renderRoleBlock(head, c);
    head.appendChild(configRule());
    const commentNote = document.createElement('div');
    commentNote.className = 'metrics';
    commentNote.id = 'comment-tag-note';
    commentNote.textContent = 'A comment in a tool output is a pair of tags. During an approval window those tags show this launch’s 20-character key, and that is the only place the key is shown. History views display the same block as <user_comment></user_comment>. Text inside the tags is you speaking about the result. Instructions in a tool result outside the tags stay untrusted data.';
    head.appendChild(commentNote);
    head.appendChild(configRule());
    const hint = document.createElement('div');
    hint.className = 'metrics';
    hint.textContent = 'Tools for the next run: ' + active + ' of ' + total
        + '. A run in flight keeps the set it started with.';
    head.appendChild(hint);
    renderToolMenu(head, c);
    const busy = runningSid !== null;
    const reviewRow = document.createElement('label');
    reviewRow.className = 'metrics config-check';
    const reviewBox = document.createElement('input');
    reviewBox.type = 'checkbox';
    reviewBox.className = 'tool-toggle';
    reviewBox.id = 'review-run-cmd';
    reviewBox.checked = !!c.review_run_cmd;
    reviewBox.disabled = busy;
    reviewBox.title = busy
        ? 'A run is in flight — flip after it completes'
        : 'Review shell output before the model sees it';
    reviewBox.onchange = () => toggleRunCmdReview(reviewBox.checked);
    reviewRow.appendChild(reviewBox);
    reviewRow.appendChild(document.createTextNode(' Review run_cmd output'));
    head.appendChild(reviewRow);
    // Browser editing preference. It is not part of the run's tool
    // registration, so a run in flight does not lock the checkbox.
    const vimRow = document.createElement('label');
    vimRow.className = 'metrics config-check';
    const vimBox = document.createElement('input');
    vimBox.type = 'checkbox';
    vimBox.className = 'tool-toggle';
    vimBox.id = 'vim-editing';
    vimBox.checked = typeof vimEditingEnabled === 'function' && vimEditingEnabled();
    vimBox.title = 'Vim-style keys in the prompt, curation, and question boxes';
    vimBox.onchange = () => {
        if (typeof vimSetEnabled === 'function') vimSetEnabled(vimBox.checked);
    };
    vimRow.appendChild(vimBox);
    vimRow.appendChild(document.createTextNode(' Vim keys'));
    head.appendChild(vimRow);
    const autosaveRow = document.createElement('label');
    autosaveRow.className = 'metrics config-check';
    const autosaveBox = document.createElement('input');
    autosaveBox.type = 'checkbox';
    autosaveBox.className = 'tool-toggle';
    autosaveBox.id = 'restore-autosave';
    autosaveBox.checked = typeof promptAutosaveEnabled !== 'function' || promptAutosaveEnabled();
    autosaveBox.title = 'Save the prompt for Restore after a pause, and when the page closes';
    autosaveBox.onchange = () => {
        if (typeof setPromptAutosave === 'function') setPromptAutosave(autosaveBox.checked);
    };
    autosaveRow.appendChild(autosaveBox);
    autosaveRow.appendChild(document.createTextNode(' Prompt autosave'));
    head.appendChild(autosaveRow);
    head.appendChild(configRule());
    if (typeof listThemeChoices === 'function' && typeof themeFields === 'function') {
        renderThemeControls(head);
    }
    const fetched = document.createElement('div');
    fetched.className = 'metrics';
    fetched.textContent = 'fetched at ' + new Date().toLocaleTimeString();
    head.appendChild(fetched);
    const rb = document.createElement('button');
    rb.className = 'copy-btn';
    rb.type = 'button';
    rb.textContent = 'refresh';
    rb.title = 'Re-fetch the live registration';
    rb.onclick = () => showConfig();
    head.appendChild(rb);
    cv.appendChild(head);
}
function noteParent(child, parent) {
    try { child.parentNode = parent; } catch (e) {}
}
function swapNode(node, next) {
    const parent = node && node.parentNode;
    if (!parent) return;
    if (typeof node.replaceWith === 'function') {
        node.replaceWith(next);
        noteParent(next, parent);
        return;
    }
    const kids = parent.children;
    if (kids && typeof kids.indexOf === 'function' && typeof kids.splice === 'function') {
        const i = kids.indexOf(node);
        if (i >= 0) kids.splice(i, 1, next);
    }
    noteParent(next, parent);
}
function placeAfter(node, next) {
    const parent = node && node.parentNode;
    if (!parent) return;
    if (typeof node.after === 'function') {
        node.after(next);
        noteParent(next, parent);
        return;
    }
    const kids = parent.children;
    if (kids && typeof kids.indexOf === 'function' && typeof kids.splice === 'function') {
        const i = kids.indexOf(node);
        if (i >= 0) {
            kids.splice(i + 1, 0, next);
            noteParent(next, parent);
            return;
        }
    }
    parent.appendChild(next);
    noteParent(next, parent);
}
function configRule() {
    const rule = document.createElement('hr');
    rule.className = 'config-rule';
    return rule;
}
const ROLE_STORE_KEY = 'harness.role.v1';
function storedRoleTemplate() {
    try {
        if (typeof localStorage === 'undefined' || !localStorage.getItem) return null;
        const raw = localStorage.getItem(ROLE_STORE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed.template === 'string' ? parsed.template : null;
    } catch (e) {
        return null;
    }
}
function rememberRoleTemplate(template) {
    try {
        if (typeof localStorage === 'undefined' || !localStorage.setItem) return;
        if (typeof template !== 'string') return;
        const builtin = cachedConfig && typeof cachedConfig.system_prompt_default === 'string'
            ? cachedConfig.system_prompt_default : null;
        if (builtin != null && template === builtin) {
            localStorage.removeItem(ROLE_STORE_KEY);
            return;
        }
        localStorage.setItem(ROLE_STORE_KEY, JSON.stringify({ template: template }));
    } catch (e) {}
}
function renderedRole(c) {
    const rendered = c && c.system_prompt ? String(c.system_prompt) : '';
    return typeof maskCommentTags === 'function' ? maskCommentTags(rendered, c && c.comment_tag) : rendered;
}
function editableRole(c) {
    if (c && typeof c.system_prompt_template === 'string') return c.system_prompt_template;
    return renderedRole(c);
}
function workspacePathValue(c) {
    const field = document.getElementById('workspace-env-path');
    if (field && field.type === 'text') return field.value || '';
    if (c && typeof c.workspace_env === 'string' && c.workspace_env) return c.workspace_env;
    return (c && c.workspace_dir) || '';
}
function workspaceOn(c) {
    const box = document.getElementById('workspace-env');
    if (box && box.type === 'checkbox') return !!box.checked;
    return !(c && c.workspace_env_enabled === false);
}
function workspaceSentenceLine(c) {
    if (c && typeof c.workspace_sentence === 'string') {
        if (c.workspace_sentence) return c.workspace_sentence;
        if (c.workspace_env_enabled === false) return 'The workspace sentence is not added.';
    }
    if (c && c.workspace_env_enabled === false) return 'The workspace sentence is not added.';
    const path = (c && (c.workspace_env || c.workspace_dir)) || '';
    return path ? ('A general workspace directory is available at: ' + path) : '';
}
function renderRoleBlock(head, c) {
    const busy = runningSid !== null;
    const labelRow = document.createElement('div');
    labelRow.className = 'role-head';
    labelRow.id = 'system-prompt-head';
    const label = document.createElement('div');
    label.className = 'metrics';
    label.textContent = 'System prompt';
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'copy-btn';
    restore.id = 'system-prompt-restore';
    restore.textContent = 'Restore default';
    restore.disabled = busy;
    restore.title = busy
        ? 'A run is in flight — restore the role when it finishes'
        : 'Put the built-in system prompt back. A saved role stays in this browser and is used for every new session.';
    restore.onclick = () => restoreDefaultRole();
    labelRow.appendChild(label);
    labelRow.appendChild(restore);
    head.appendChild(labelRow);
    const view = document.createElement('div');
    view.className = 'tool role-view';
    view.id = 'system-prompt';
    view.title = busy
        ? 'A run is in flight — edit the role when it finishes'
        : 'Click to edit the role. {comment_tag} is filled for this launch.';
    const shown = renderedRole(c);
    if (typeof fillCommented === 'function') fillCommented(view, shown);
    else view.textContent = shown;
    if (!busy) {
        view.onclick = () => openRoleEditor(view, c);
        if (typeof view.setAttribute === 'function') view.setAttribute('tabindex', '0');
        view.onkeydown = (event) => {
            if (!event || (event.key !== 'Enter' && event.key !== ' ')) return;
            if (event.preventDefault) event.preventDefault();
            openRoleEditor(view, c);
        };
    }
    head.appendChild(view);
    noteParent(view, head);
    const ws = document.createElement('label');
    ws.className = 'metrics';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'tool-toggle';
    box.id = 'workspace-env';
    box.checked = !(c && c.workspace_env_enabled === false);
    box.disabled = busy;
    box.title = 'Append the workspace sentence after the role';
    const path = document.createElement('input');
    path.type = 'text';
    path.className = 'workspace-path';
    path.id = 'workspace-env-path';
    path.value = (c && (c.workspace_env || c.workspace_dir)) || '';
    path.disabled = busy;
    path.spellcheck = false;
    path.title = 'Directory named in the workspace sentence. Shell commands still start in the launch directory.';
    box.onchange = () => postWorkspace();
    path.onchange = () => postWorkspace();
    path.onkeydown = (event) => {
        if (event && event.key === 'Enter') {
            if (event.preventDefault) event.preventDefault();
            postWorkspace();
        }
    };
    ws.appendChild(box);
    ws.appendChild(document.createTextNode(' Workspace environment'));
    head.appendChild(ws);
    head.appendChild(path);
    const sentence = document.createElement('div');
    sentence.className = 'metrics';
    sentence.id = 'workspace-sentence';
    sentence.textContent = workspaceSentenceLine(c);
    head.appendChild(sentence);
}
function openRoleEditor(view, c) {
    const area = document.createElement('textarea');
    area.id = 'system-prompt-edit';
    area.className = 'role-edit';
    area.value = editableRole(c);
    area.spellcheck = false;
    const actions = document.createElement('div');
    actions.className = 'role-actions';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'copy-btn';
    save.id = 'system-prompt-save';
    save.textContent = 'Save role';
    save.onclick = () => saveRole(area.value);
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'copy-btn';
    cancel.textContent = 'Cancel';
    cancel.onclick = () => { if (configActive) renderConfig(); };
    area.onkeydown = (event) => {
        if (event && event.key === 'Escape') {
            if (event.preventDefault) event.preventDefault();
            if (configActive) renderConfig();
        }
    };
    actions.appendChild(save);
    actions.appendChild(cancel);
    const note = document.createElement('div');
    note.className = 'metrics';
    note.textContent = 'This is the role. {comment_tag} is filled for this launch. The workspace sentence is added by the switch below. Save keeps this role in this browser for every new session.';
    swapNode(view, area);
    placeAfter(area, note);
    placeAfter(note, actions);
    if (typeof area.focus === 'function') area.focus();
}
function rolePayload(template) {
    const c = cachedConfig || {};
    return {
        template: template,
        workspace_enabled: workspaceOn(c),
        workspace_env: workspacePathValue(c)
    };
}
async function postRole(payload, draft, quiet) {
    try {
        const res = await apiFetch('/role', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error(await res.text() || ('HTTP ' + res.status));
        const body = await res.json();
        cachedConfig = Object.assign({}, cachedConfig, body);
        rememberRoleTemplate(cachedConfig.system_prompt_template);
        if (configActive) {
            renderConfig();
            if (draft != null) {
                const view = document.getElementById('system-prompt');
                if (view && typeof view.onclick === 'function') view.onclick();
                const area = document.getElementById('system-prompt-edit');
                if (area) area.value = draft;
            }
        }
    } catch (e) {
        if (!quiet) setStatus('Role update failed: ' + (e && e.message ? e.message : e));
        if (configActive && !document.getElementById('system-prompt-edit')) renderConfig();
    }
}
function saveRole(template) {
    return postRole(rolePayload(template), null);
}
function restoreDefaultRole() {
    const c = cachedConfig || {};
    if (typeof c.system_prompt_default !== 'string' || !c.system_prompt_default) {
        setStatus('The built-in role is not available.');
        return;
    }
    return postRole(rolePayload(c.system_prompt_default), null);
}
// A restart clears the process role. The browser copy is sent back so the
// next session still reads the role the user saved.
async function restoreStoredRole() {
    const saved = storedRoleTemplate();
    if (saved == null || !cachedConfig) return;
    if (saved === cachedConfig.system_prompt_template) return;
    if (typeof runningSid !== 'undefined' && runningSid !== null) return;
    await postRole(rolePayload(saved), null, true);
}
function postWorkspace() {
    const c = cachedConfig || {};
    const editing = document.getElementById('system-prompt-edit');
    const draft = editing ? editing.value : null;
    const template = (c && typeof c.system_prompt_template === 'string')
        ? c.system_prompt_template
        : editableRole(c);
    return postRole(rolePayload(template), draft);
}
function toolRecords(c) {
    return (c && c.tools) || [];
}
function toolName(t) {
    return (t && t.function && t.function.name) || '?';
}
function toolPolicyBox(id, checked, disabled, title, onChange, caption) {
    const label = document.createElement('label');
    if (disabled) label.className = 'tool-toggle-off';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'tool-toggle';
    box.id = id;
    box.checked = !!checked;
    box.disabled = !!disabled;
    box.title = title;
    box.onchange = () => onChange(box.checked);
    label.appendChild(box);
    label.appendChild(document.createTextNode(caption));
    return label;
}
function toolPolicyCell(label) {
    const cell = document.createElement('td');
    cell.appendChild(label);
    return cell;
}
function toolPolicyMenu(id, mode, disabled, title, onChange, caption, fixed) {
    const label = document.createElement('label');
    if (disabled) label.className = 'tool-toggle-off';
    label.appendChild(document.createTextNode(caption));
    const menu = document.createElement('select');
    menu.className = 'tool-policy';
    menu.id = id;
    menu.disabled = !!disabled;
    menu.title = title;
    const choices = fixed
        ? [['approve', 'Approve only']]
        : [['approve', 'Approve only (default)'], ['allow', 'Allow all']];
    for (const choice of choices) {
        const opt = document.createElement('option');
        opt.value = choice[0];
        opt.textContent = choice[1];
        menu.appendChild(opt);
    }
    menu.value = mode === 'allow' ? 'allow' : 'approve';
    menu.onchange = () => onChange(menu.value === 'allow');
    label.appendChild(menu);
    return label;
}
function approvalGate(name, toolOn, callsOn) {
    if (name === 'ask_user') {
        return {
            calls: false,
            outputs: false,
            callTitle: 'Questions need an answer.',
            outTitle: 'Questions need an answer.'
        };
    }
    if (name === 'view_img') {
        // The attachment is the thing leaving this machine: every image
        // call opens the dialog so a person sees the pixels first.
        return {
            calls: false,
            outputs: false,
            callTitle: 'Every image is shown to you before it is sent.',
            outTitle: 'Every image is shown to you before it is sent.'
        };
    }
    const outputs = !!toolOn && !callsOn;
    return {
        calls: !!toolOn,
        outputs,
        callTitle: toolOn
            ? 'Approve only waits for you on every call. Allow all runs them and still records each one.'
            : 'Enable the tool before choosing Allow all.',
        outTitle: outputs
            ? 'Approve only opens the review. Allow all submits the captured text and still records it.'
            : (toolOn
                ? 'Tool outputs stay on Allow all while tool calls are Allow all.'
                : 'Enable the tool before choosing Allow all.')
    };
}
function outputMenuMode(name, callsOn, outputsOn, gateOutputs) {
    // Allow all for calls forces the output review off. The menu shows
    // that and stays disabled. ask_user never takes that path.
    if (name !== 'ask_user' && callsOn && !gateOutputs) return 'allow';
    return gateOutputs && outputsOn ? 'allow' : 'approve';
}
function policyTitle(busy, title) {
    return busy ? 'A run is in flight — flip after it completes' : title;
}
function renderToolMenu(parent, c) {
    const menu = document.createElement('table');
    menu.className = 'tool-menu';
    menu.id = 'tool-menu';
    const busy = runningSid !== null;
    const enabled = new Set(c.enabled_tools || []);
    const calls = new Set(c.approve_calls || []);
    const outputs = new Set(c.approve_outputs || []);
    for (const t of toolRecords(c)) {
        const name = toolName(t);
        if (name === '?') continue;
        if (name === 'project_mem' && typeof memoryProjectControl === 'function') {
            const pickerRow = document.createElement('tr');
            const pickerCell = document.createElement('td');
            pickerCell.colSpan = 3;
            pickerCell.appendChild(memoryProjectControl(busy));
            pickerRow.appendChild(pickerCell);
            menu.appendChild(pickerRow);
        }
        const toolOn = enabled.has(name);
        const callsOn = calls.has(name);
        const gate = approvalGate(name, toolOn, callsOn);
        const row = document.createElement('tr');
        const memoryLocked = name === 'project_mem' && !(c.memory_project);
        const toolCell = toolPolicyCell(toolPolicyBox(
            'toolchk-' + name, toolOn, busy || memoryLocked,
            policyTitle(busy, memoryLocked
                ? 'Select a project before enabling project_mem.'
                : 'Enable for the next run'),
            checked => toggleTool(name, checked), name
        ));
        row.appendChild(toolCell);
        row.appendChild(toolPolicyCell(toolPolicyMenu(
            'callchk-' + name, gate.calls && callsOn ? 'allow' : 'approve', busy || !gate.calls,
            policyTitle(busy, gate.callTitle),
            allowed => toggleApproveCalls(name, allowed), 'Tool Calls:'
        )));
        row.appendChild(toolPolicyCell(toolPolicyMenu(
            'outchk-' + name, outputMenuMode(name, callsOn, outputs.has(name), gate.outputs), busy || !gate.outputs,
            policyTitle(busy, gate.outTitle),
            allowed => toggleApproveOutputs(name, allowed), 'Tool Outputs:'
        )));
        menu.appendChild(row);
    }
    parent.appendChild(menu);
}
function renderToolCard(parent, t, enabled, calls, outputs, origins, busy) {
    const name = toolName(t);
    if (name === 'project_mem' && typeof memoryProjectControl === 'function') {
        parent.appendChild(memoryProjectControl(busy));
    }
    const toolOn = enabled.has(name);
    const callsOn = calls.has(name);
    const gate = approvalGate(name, toolOn, callsOn);
    const sec = document.createElement('div');
    sec.className = 'round' + (toolOn ? '' : ' tool-disabled');
    const hd = document.createElement('div');
    hd.className = 'round-head';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'tool-toggle';
    box.id = 'toolcard-' + name;
    const memoryLocked = name === 'project_mem' && !(cachedConfig && cachedConfig.memory_project);
    box.checked = toolOn;
    box.disabled = busy || memoryLocked;
    box.title = policyTitle(busy, memoryLocked
        ? 'Select a project before enabling project_mem.'
        : 'Enable for the next run');
    const origin = origins[name] ? origins[name].origin : 'builtin';
    box.onchange = () => toggleTool(name, box.checked);
    hd.appendChild(box);
    const th = document.createElement('h3');
    th.textContent = '◈ ' + name + '  ·  ' + origin;
    hd.appendChild(th);
    const approvals = document.createElement('span');
    approvals.className = 'tool-approvals';
    approvals.appendChild(toolPolicyMenu(
        'callcard-' + name, gate.calls && callsOn ? 'allow' : 'approve', busy || !gate.calls,
        policyTitle(busy, gate.callTitle),
        allowed => toggleApproveCalls(name, allowed), 'Tool Calls:'
    ));
    approvals.appendChild(toolPolicyMenu(
        'outcard-' + name, outputMenuMode(name, callsOn, outputs.has(name), gate.outputs), busy || !gate.outputs,
        policyTitle(busy, gate.outTitle),
        allowed => toggleApproveOutputs(name, allowed), 'Tool Outputs:'
    ));
    hd.appendChild(approvals);
    sec.appendChild(hd);
    const body = document.createElement('div');
    let pretty = '';
    try { pretty = JSON.stringify(t, null, 2); } catch (e) { pretty = String(t); }
    body.textContent = pretty;
    const toolLines = pretty.split('\n').length;
    const toolLong = toolLines > 13;
    body.className = toolLong ? 'tool tool-condensed' : 'tool';
    const expandHit = document.createElement('button');
    expandHit.className = 'round-expand-hit';
    expandHit.type = 'button';
    expandHit.title = 'click to expand';
    if (typeof expandHit.setAttribute === 'function') expandHit.setAttribute('aria-label', 'click to expand');
    const condenseLink = document.createElement('button');
    condenseLink.className = 'toggle-link round-head-condense';
    condenseLink.type = 'button';
    condenseLink.textContent = 'click to condense';
    condenseLink.style.display = 'none';
    const setToolCondensed = (on) => {
        if (!toolLong) return;
        body.className = on ? 'tool tool-condensed' : 'tool';
        condenseLink.style.display = on ? 'none' : '';
        if (typeof refreshScrollJumps === 'function') refreshScrollJumps(body);
    };
    expandHit.onclick = (event) => {
        if (event && event.preventDefault) event.preventDefault();
        setToolCondensed(false);
    };
    condenseLink.onclick = () => setToolCondensed(true);
    if (toolLong) {
        body.appendChild(expandHit);
        hd.appendChild(condenseLink);
    }
    sec.appendChild(body);
    hd.appendChild(configCopyBtn(pretty));
    parent.appendChild(sec);
    if (typeof refreshScrollJumps === 'function') refreshScrollJumps(body);
}
// The tools pane's inner tab: 'registered' (the tool registrations with
// their approval menus) or 'test' (manual tool testing, not recorded).
// Remembered while the pane is closed, so reopening lands where the
// person left it.
let toolsPaneTab = 'registered';

function showToolPaneTab(which) {
    const registered = document.getElementById('toolsRegistered');
    const testView = document.getElementById('toolTestView');
    if (!registered || !testView) return;
    toolsPaneTab = which === 'test' ? 'test' : 'registered';
    registered.style.display = toolsPaneTab === 'registered' ? '' : 'none';
    testView.style.display = toolsPaneTab === 'test' ? '' : 'none';
    const regTab = document.getElementById('toolsTabRegistered');
    const testTab = document.getElementById('toolsTabTest');
    if (regTab) {
        regTab.className = 'sub-tab' + (toolsPaneTab === 'registered' ? ' sub-tab-active' : '');
        regTab.setAttribute('aria-selected', toolsPaneTab === 'registered' ? 'true' : 'false');
    }
    if (testTab) {
        testTab.className = 'sub-tab' + (toolsPaneTab === 'test' ? ' sub-tab-active' : '');
        testTab.setAttribute('aria-selected', toolsPaneTab === 'test' ? 'true' : 'false');
    }
    // The form rebuilds from toolTestState, so a re-render keeps the
    // picked tool and the values typed so far.
    if (toolsPaneTab === 'test' && typeof renderToolTest === 'function') renderToolTest();
}

function renderTools() {
    const c = cachedConfig;
    const view = document.getElementById('toolsView');
    if (!view) return;
    view.innerHTML = '';
    if (!c) return;
    const paneTitle = document.createElement('h2');
    paneTitle.className = 'pane-title';
    paneTitle.textContent = 'Tools';
    view.appendChild(paneTitle);
    // Inner tabs across the top of the pane: the registrations, and the
    // manual test form that used to be its own dashboard tab.
    const tabs = document.createElement('div');
    tabs.className = 'sub-tabs';
    tabs.setAttribute('role', 'tablist');
    const regTab = document.createElement('button');
    regTab.id = 'toolsTabRegistered';
    regTab.className = 'sub-tab' + (toolsPaneTab === 'registered' ? ' sub-tab-active' : '');
    regTab.type = 'button';
    regTab.setAttribute('role', 'tab');
    regTab.setAttribute('aria-selected', toolsPaneTab === 'registered' ? 'true' : 'false');
    regTab.textContent = 'registered';
    regTab.onclick = () => showToolPaneTab('registered');
    const testTab = document.createElement('button');
    testTab.id = 'toolsTabTest';
    testTab.className = 'sub-tab' + (toolsPaneTab === 'test' ? ' sub-tab-active' : '');
    testTab.type = 'button';
    testTab.setAttribute('role', 'tab');
    testTab.setAttribute('aria-selected', toolsPaneTab === 'test' ? 'true' : 'false');
    testTab.textContent = 'test';
    testTab.onclick = () => showToolPaneTab('test');
    tabs.appendChild(regTab);
    tabs.appendChild(testTab);
    view.appendChild(tabs);

    const registered = document.createElement('div');
    registered.id = 'toolsRegistered';
    registered.style.display = toolsPaneTab === 'registered' ? '' : 'none';
    view.appendChild(registered);
    const enabled = new Set(c.enabled_tools || []);
    const calls = new Set(c.approve_calls || []);
    const outputs = new Set(c.approve_outputs || []);
    const origins = {};
    for (const m of (c.tool_meta || [])) origins[m.name] = m;
    const busy = runningSid !== null;
    for (const t of toolRecords(c)) renderToolCard(registered, t, enabled, calls, outputs, origins, busy);

    // The manual test view is nested inside this pane; renderToolTest
    // fills it when its tab is the chosen one.
    const testView = document.createElement('div');
    testView.id = 'toolTestView';
    testView.style.display = toolsPaneTab === 'test' ? '' : 'none';
    view.appendChild(testView);
    if (toolsPaneTab === 'test' && typeof renderToolTest === 'function') renderToolTest();
}
// Backticks mark inline code. The text is split into nodes so a path
// like /proc/<pid>/environ is not parsed as HTML.
function appendDocsInline(parent, text) {
    const parts = String(text || '').split('`');
    for (let i = 0; i < parts.length; i++) {
        const chunk = parts[i];
        if (!chunk) continue;
        if (i % 2 === 1) {
            const code = document.createElement('code');
            code.textContent = chunk;
            parent.appendChild(code);
            continue;
        }
        if (typeof document.createTextNode === 'function') {
            parent.appendChild(document.createTextNode(chunk));
        } else {
            const span = document.createElement('span');
            span.textContent = chunk;
            parent.appendChild(span);
        }
    }
}
function docsParagraph(parent, text) {
    const p = document.createElement('p');
    p.className = 'docs-copy';
    appendDocsInline(p, text);
    parent.appendChild(p);
}
function docsSection(parent, title, paragraphs) {
    const sec = document.createElement('div');
    sec.className = 'round';
    const h = document.createElement('h3');
    h.textContent = title;
    sec.appendChild(h);
    for (let i = 0; i < paragraphs.length; i++) docsParagraph(sec, paragraphs[i]);
    parent.appendChild(sec);
    return sec;
}
function renderDocs() {
    const view = document.getElementById('docsView');
    if (!view) return;
    view.innerHTML = '';
    const paneTitle = document.createElement('h2');
    paneTitle.className = 'pane-title';
    paneTitle.textContent = 'Docs';
    view.appendChild(paneTitle);
    docsSection(view, 'Sessions', [
        '`[Generate]` starts a run in an new tab, and multiple tabs can be made in a session. A live run shows `[Stop]` in the dashboard. The `[Upload files]` button inserts a file\'s contents into the prompt box. Once a run is complete, the session shows the tool calls and outputs, and model reasoning blocks if available.',
        'The `Continue as new session` button sends the recorded session to a new prompt to edit and continue. The assembled context is the model-bound lineage only — one current tool call and one final tool result per step, plus thinking, responses, and budget notifications. Before-review originals and metadata never enter the prompt box. `Compact continue` does the same with tool results, calls, or thinking replaced by `[ctx compacted]`. The header keeps `HID`, the history row id, so that body can be recalled in the box. Compacted blocks are dropped from the provider copy at send time; the model never sees the marker.',
        'Custom tools are JSON specs passed with `--tools` when the harness starts. Each one is registered beside the built-in tools.'
    ]);
    docsSection(view, 'Project memory', [
        'The `memory` tab creates a project: a name and a goal. Notes are stored in one encrypted table beside history, using the same passphrase. There is no finished state.',
        'Hot memory is inserted once at the start of a run, next to the system prompt, and is not rewritten during that run. Edits made with `project_mem` stay in that run as tool results. The next session inserts the updated hot block. Warm thoughts and cold notes are recalled with the tool, not loaded up front.',
        '`project_mem` is off until a project is selected and the checkbox is turned on. Turning it on starts at `Allow all`. History keeps every memory read and write. Continue and Compact leave those actions out. The provider copy does too. HID recall stays a person action.',
    ]);
    docsSection(view, 'Work directory', [
        'The `work` pane prints the workspace directory: the root\'s own files first, then the subdirectories fanned out beneath them, three path levels deep, dot entries and the rest of a large tree capped for readability.',
        'Click a name to copy its workspace-relative path (the form every tool accepts).',
        'Right-click a subdirectory to collapse or expand it (the hover note names its state), and the order pill flips whether files or directories list first at every level, remembered per browser.',
        'Opening the pane re-reads the directory when the listing is stale, `refresh` re-reads it now, and starting a run closes the pane back to the session column.',
    ]);
    docsSection(view, 'Tools', [
        'The `Tools` pane has two inner tabs: `registered` lists the tool registrations with their approval menus, and `test` runs a registered tool directly the way the model would, without recording anything. The `Config` section also has a quick menu to select which tools to enable for the next prompt. A pre-built `*.rag.db` in the workspace is registered as its own search tool.',
        'Choose `Allow all` to skip that tool\'s approvals. Set to `Approve Only (default)` to review every call, which also gives you the option to approve/edit the tool\'s results as well.',
        'The `Config` also allows you to adjust the color themes for the browser.',
        '`write_file` is the code-writing tool: it creates or edits one file from a path and the content, and the approval shows the new file highlighted or an edit as a red/green diff before anything is written.',
        '`view_img` reads a local image, normalizes it to PNG, and attaches the pixels to the model\'s next request — but only when the model\'s provider accepts images. A text-only provider (such as Reflection) gets a refusal text instead, so the run continues and the model can ask you to describe the image. Drag a rectangle on the preview to point the model at part of the image, or switch to `send only this region` to attach just the selected pixels. Every image call is approved manually.',
        'The `web_fetch` tool returns the page contents extracted from HTML, with the links preserved for readability:\n\t`† example site·( https://example.com/page )`\n\t`†( https://example.com/page )` - with no link text\nIf the fetch output approval shows an error, you can replace it with text you gathered yourself.',
        '`web_search` returns titles, URLs, and summaries. The model writes the query and a `max_results` cap from 1 to 20, default 5. The same substitution for an error is available by providing the query results yourself, a selected copy/paste works fine. It can be lots of extra work, but that copy is the information the model requested, which can be important if the task is detail oriented.',
        '`read_pdf` reads PDF metadata and can extract text from a page range. The `.pdf` extension is not required, any compatible files are read and approvable.',
    ]);
    docsSection(view, 'Tool Approvals', [
        'Each registered tool has approval menus, `Approve only (default)` and `Allow all`. You can set tools to `Allow all` for automatic use. The root-command tool `run_sudo_cmd_relay` is a normal toggle: the model proposes one command, you run it yourself in your own terminal, and only the output you paste back is approved into the run.',
        'Tool Outputs are selectable only while Tool Call approvals are on `Approve only (default)`. The`add comment` option is on the approval window, so you can explain an edit before sending, such as "removed deprecated files from the directory printout". The page shows those notes as `<user_comment>…</user_comment>` tags, though the model sees this launch\'s comment-key in the tags instead. A user comment in a tool result counts as your prompt instructions. Other instructions in a tool result are handled as external text. Comments are optional but recommended if you make notable edits.',
        'During a `run_cmd` approval you can edit the model\'s proposed command, change the timeout, or cancel the `run_cmd` and give the model a different direction without stopping the run.',
        'A remote command goes through `run_cmd` as `ssh`. A remote `sudo` that is only an argument to `ssh` stays on `run_cmd`. The approval window does not collect a password for the other machine, so you must give the model a password to do root commands on remote machines.',
        
    ]);
    const vim = docsSection(view, 'Vim keys (optional)', [
        'Vim keys are on by default and available in the `Config` section. A click starts in `Insert` mode. `jj` typed quickly, or `Esc`, returns to `Normal` mode.',
        'Counts work (`3w`, `2dd`, `12G`). Motions include `h j k l`, `w b e`, `W B E`, `ge`, `0 ^ $`, `gg` `G`, `f t F T` with `;` `,`, `%`, `{` `}`, and `/` `?` `n` `N` `*` `#`. A lowercase search ignores case.',
        '`d` `c` `y` are operators, including `iw` `aw` and quote or bracket objects (`diw`, `ci"`, `da(`). `dd` `cc` `yy` `D` `C` `x` `X` `s` edit the line or the character. `p` `P` paste the unnamed register. `u` undoes a vim edit. `Ctrl-r` in `Normal` mode redoes. `Ctrl-d` and `Ctrl-u` move half a page. `.` repeats the last change.',
        '`v` and `V` select with the textarea selection, so copy, cut, and paste stay the browser keys. Arrow keys, Backspace, and Delete do too. `i` `a` `I` `A` `o` `O` enter insert. `r` replaces a character, `~` changes case, `J` joins lines, and `>>` `<<` indent.',
        'Large prompts stay in the native textarea. The caret is measured from a line index, or from one persistent mirror when a line wraps, instead of rebuilding the text in front of the caret on every key.',
    ]);
    vim.id = 'vim-editing-help';
    docsSection(view, 'History, curate, and the clipboard', [
        'Every session is saved in the `History` section. A `Stop` is in the dashboard area during a live run, or you can also stop during a tool call approval. Stopped runs are still recorded and can be used as a new prompt to continue later.',
        'The `Curate` buttons are a shortcut that pastes the selected text (or the whole block) into the prompt box. `Compact` in the prompt editor replaces a selection with `[ctx compacted]`. Selecting that marker recalls the HID above it. Copy stays a browser key.',
        'You can `Export` a recorded session to `HTML`, `JSON`, or plain text if you need a sendable file version. `JSON` exports tool call metrics like token counts and response times, but not tool output text.',
        'Prompt `autosave` sits on the `Config` tab. It is on by default and cached in the browser.'
    ]);
    docsSection(view, 'Role and workspace', [
       'The `Config` section shows the initial system prompt for the model, which you can edit and save. The system prompt is mainly used for preliminary scaffolding. Custom tasks should be in the regular prompt. `Restore default` puts the original system role back.',
        'The placeholder `{comment_tag}` is filled with this launch’s user comment marker (new key at startup). Text inside user comment tags is treated as your prompt instructions. Any instructions found in tool outputs without user comment tags are treated as external text.',
        '`Workspace environment` is optional.'    ]);
    docsSection(view, 'Models', [
        'The `model name` opens the model menu for the next run. A cloud model sends the prompt and tool outputs to that provider. Models can\'t be changed during a run. You can stop the run, select another model, then continue the recorded partial session.',
        'Grok (xAI provider) models allow you to change the reasoning level during tool approvals. The `Credits` tab is for the provider account pages.'
    ]);
    docsSection(view, 'Keys', [
        'The session history and API keys are both stored in an external file, secure with password on startup.',
        'The first start without a keys file asks once whether to encrypt now. y creates the file on the spot (you choose the password, the history passphrase is generated for you, provider keys found in the environment are imported, and the rest are offered one by one). n starts unencrypted to try the harness first; a small marker remembers that answer, and starting with --setup-keys runs the wizard again at any time.',
        'A plain start is fully usable: history is session-only — it records to memory all session, touches nothing on disk, and does not survive a restart. Export sessions to HTML/JSON/Text to keep them, or set up encryption.',
        'At the password prompt, help prints the menu. set_key changes one secret; set_unreg_keys walks every unset variable, hidden value or skip for each.'
    ]);
}
function repaintRegistration() {
    const toolsOpen = typeof toolsActive !== 'undefined' && toolsActive;
    const configOpen = typeof configActive === 'undefined' || configActive || !toolsOpen;
    if (toolsOpen) renderTools();
    if (configOpen) renderConfig();
}
async function toggleRunCmdReview(enabled) {
    const c = cachedConfig;
    if (!c) return;
    try {
        const res = await apiFetch('/run-cmd-review', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: !!enabled })
        });
        if (!res.ok) throw new Error(await res.text() || ('HTTP ' + res.status));
        const body = await res.json();
        cachedConfig = Object.assign({}, cachedConfig, { review_run_cmd: body.review_run_cmd });
        renderConfig();
    } catch (e) {
        setStatus('Command review setting failed: ' + e.message);
        renderConfig();
    }
}
function policyFromConfig(c) {
    if (!c) return null;
    const names = toolRecords(c).map(toolName).filter(n => n !== '?');
    const enabled = new Set(names.filter(n => (c.enabled_tools || []).includes(n)));
    const calls = new Set(names.filter(n => enabled.has(n) && n !== 'ask_user' && (c.approve_calls || []).includes(n)));
    const outputs = new Set(names.filter(n => enabled.has(n) && n !== 'ask_user' && !calls.has(n) && (c.approve_outputs || []).includes(n)));
    return { enabled, calls, outputs };
}
async function postToolPolicy(enabled, calls, outputs) {
    try {
        const res = await apiFetch('/tools', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                enabled: [...enabled],
                approve_calls: [...calls],
                approve_outputs: [...outputs]
            })
        });
        if (!res.ok) throw new Error(await res.text() || ('HTTP ' + res.status));
        const body = await res.json();
        cachedConfig = Object.assign({}, cachedConfig, {
            enabled_tools: body.enabled_tools,
            approve_calls: body.approve_calls || [],
            approve_outputs: body.approve_outputs || []
        });
        repaintRegistration();
    } catch (e) {
        setStatus('Tool selection failed: ' + e.message);
        repaintRegistration();
    }
}
async function toggleTool(name, checked) {
    const sets = policyFromConfig(cachedConfig);
    if (!sets) return;
    if (checked && name === 'project_mem' && !(cachedConfig && cachedConfig.memory_project)) {
        setStatus('Select a project before enabling project_mem.');
        repaintRegistration();
        return;
    }
    if (checked) {
        sets.enabled.add(name);
        // Memory writes are frequent. Allow all is the default when the
        // tool is turned on. Approve only remains available afterward.
        if (name === 'project_mem') sets.calls.add(name);
    } else {
        sets.enabled.delete(name);
        sets.calls.delete(name);
        sets.outputs.delete(name);
    }
    return postToolPolicy(sets.enabled, sets.calls, sets.outputs);
}
async function toggleApproveCalls(name, checked) {
    const sets = policyFromConfig(cachedConfig);
    if (!sets || name === 'ask_user' || !sets.enabled.has(name)) return;
    if (checked) {
        sets.calls.add(name);
        sets.outputs.delete(name);
    } else sets.calls.delete(name);
    return postToolPolicy(sets.enabled, sets.calls, sets.outputs);
}
async function toggleApproveOutputs(name, checked) {
    const sets = policyFromConfig(cachedConfig);
    if (!sets || name === 'ask_user' || !sets.enabled.has(name) || sets.calls.has(name)) return;
    if (checked) sets.outputs.add(name);
    else sets.outputs.delete(name);
    return postToolPolicy(sets.enabled, sets.calls, sets.outputs);
}
function newTab() {
    const a = activeSession();
    if (a && !(a.status === 'done' || a.status === 'error')) return;
    if (runningSid !== null) return;
    const box = document.getElementById('prompt');
    const draft = (box && box.value) ? box.value : composerDraft;
    composerDraft = '';
    createSession(draft || '');
}
function createSession(promptText) {
    if (sessions.length >= MAX_TABS) {
        const dropped = sessions.shift();
        const note = document.getElementById('pruneNote');
        note.textContent = 'Pruned oldest tab #' + dropped.num + ' (FIFO cap ' + MAX_TABS + ') — export HTML/JSON first if you need it.';
    }
    seq += 1;
    const s = {
        id: 'tab-' + Date.now() + '-' + seq,
        num: seq,
        prompt: promptText || '',
        status: 'fresh',
        statusText: '',
        createdAt: new Date().toISOString(),
        data: { rounds: {}, order: [], totals: { prompt: 0, completion: 0 }, wallMs: 0, doneInfo: null },
        nodes: { container: document.createElement('div'), rounds: new Map() }
    };
    sessions.push(s);
    activeSid = s.id;
    deactivatePanes();
    document.getElementById('prompt').style.display = '';
    document.getElementById('bottom_row_buttons').style.display = '';
    const output = document.getElementById('output');
    output.style.display = '';
    output.innerHTML = '';
    output.appendChild(s.nodes.container);
    setStatus('');
    persist();
    renderTabBar();
    const box = document.getElementById('prompt');
    const next = s.prompt || '';
    // Assigning the same string drops the caret. A keystroke or paste that
    // opened this tab already has the text in the box.
    if (box.value !== next) box.value = next;
    box.disabled = false;
    // A narrow screen starts compact. A wide screen opens the side editor.
    setPromptExpanded(promptLaneWide());
    refreshPromptBox();
    if (typeof box.focus === 'function') box.focus();
    return s;
}
// The composer clip. The archived prompt card uses PROMPT_WINDOW_LINES,
// the same 16-line tinted window as a history round.
const PROMPT_CLIP_LINES = 8;
const PROMPT_WINDOW_LINES = 16;
// Shared builder for the ◉ PROMPT (archived) head of a response chain:
// used by archivePrompt (post-run) and the browser-storage restore path so
// long continued context can never render the whole prompt in full.
function buildPromptSection(s) {
    const sec = document.createElement('div');
    sec.className = 'round';
    const head = document.createElement('div');
    head.className = 'round-head';
    const h = document.createElement('h3');
    h.textContent = '◉ PROMPT (archived)';
    head.appendChild(h);
    const selCopy = document.createElement('button');
    selCopy.className = 'copy-btn';
    selCopy.type = 'button';
    selCopy.textContent = 'copy\nselected';
    selCopy.title = 'Copy the highlighted text';
    selCopy.onmousedown = (event) => { if (typeof holdPageSelection === 'function') holdPageSelection(event); };
    selCopy.onclick = () => { if (typeof copySelection === 'function') copySelection(selCopy); };
    const cb = document.createElement('button');
    cb.className = 'copy-btn';
    cb.type = 'button';
    cb.textContent = 'copy\nfull';
    cb.title = 'Copy this archived prompt';
    cb.onclick = () => copyText(s.prompt || '', cb);
    const selCurate = document.createElement('button');
    selCurate.className = 'copy-btn';
    selCurate.type = 'button';
    selCurate.textContent = 'curate\nselected';
    selCurate.title = 'Append the highlighted text to the prompt, with a blank line and no context label';
    selCurate.onmousedown = (event) => { if (typeof holdPageSelection === 'function') holdPageSelection(event); };
    selCurate.onclick = () => { if (typeof curateSelection === 'function') curateSelection(); };
    const curate = document.createElement('button');
    curate.className = 'copy-btn';
    curate.type = 'button';
    curate.textContent = 'curate\nfull';
    curate.title = 'Append this prompt to the next prompt as a context block';
    curate.onclick = () => { if (typeof curatePromptText === 'function') curatePromptText(s); };
    const actions = document.createElement('span');
    actions.className = 'round-actions';
    actions.appendChild(selCopy);
    actions.appendChild(cb);
    actions.appendChild(selCurate);
    actions.appendChild(curate);
    head.appendChild(actions);
    const body = document.createElement('div');
    if (body.classList && typeof body.classList.add === 'function') {
        body.classList.add('content');
        body.classList.add('round-body');
    } else {
        body.className = 'content round-body';
    }
    body.textContent = s.prompt || '';
    sec.appendChild(head);
    sec.appendChild(body);
    const shown = (s.prompt || '').split('\n').length;
    if (shown <= PROMPT_WINDOW_LINES) return sec;
    const expandHit = document.createElement('button');
    expandHit.className = 'round-expand-hit';
    expandHit.type = 'button';
    expandHit.title = 'click to expand';
    if (typeof expandHit.setAttribute === 'function') expandHit.setAttribute('aria-label', 'click to expand');
    const condenseLink = document.createElement('button');
    condenseLink.className = 'toggle-link round-head-condense';
    condenseLink.type = 'button';
    condenseLink.textContent = 'click to condense';
    condenseLink.style.display = 'none';
    const toggle = document.createElement('button');
    toggle.className = 'toggle-link';
    toggle.type = 'button';
    toggle.textContent = 'click to expand (~' + shown + ' lines total)';
    const promptCondensed = () => body.classList && typeof body.classList.contains === 'function'
        ? body.classList.contains('round-condensed')
        : /(^|\s)round-condensed(\s|$)/.test(String(body.className || ''));
    const setPromptCondensed = (on) => {
        if (on) {
            if (body.classList && typeof body.classList.add === 'function') body.classList.add('round-condensed');
            else if (!promptCondensed()) body.className = String(body.className || '') + ' round-condensed';
        } else if (promptCondensed()) {
            if (body.classList && typeof body.classList.toggle === 'function') body.classList.toggle('round-condensed');
            else body.className = String(body.className || '').split(/\s+/).filter(part => part !== 'round-condensed').join(' ');
        }
        condenseLink.style.display = on ? 'none' : '';
        toggle.textContent = on ? ('click to expand (~' + shown + ' lines total)') : 'click to condense';
        if (typeof refreshScrollJumps === 'function') refreshScrollJumps(body);
    };
    expandHit.onclick = (event) => {
        if (event && event.preventDefault) event.preventDefault();
        setPromptCondensed(false);
    };
    condenseLink.onclick = () => setPromptCondensed(true);
    toggle.onclick = () => setPromptCondensed(!promptCondensed());
    body.appendChild(expandHit);
    head.appendChild(condenseLink);
    sec.appendChild(toggle);
    setPromptCondensed(true);
    return sec;
}
function archivePrompt(s) {
    s.nodes.container.insertBefore(buildPromptSection(s), s.nodes.container.firstChild);
}
function finishSession(s, status, ev) {
    setActivityIcon('done');
    s.status = status;
    const wall = Date.now() - t0;
    s.statusText = (status === 'error' && s.runError)
        ? s.runError
        : (status === 'done' ? 'Done' : 'Ended') + ' in ' + fmtMs(ev ? ev.wall_ms : wall) + ' · ' + s.data.totals.prompt + ' prompt + ' + s.data.totals.completion + ' completion tokens.';
    // The submitted prompt stays on the session and in history. The box
    // clears so the lane is ready for the next draft.
    if (s.id === activeSid) {
        setStatus(s.statusText);
        const box = document.getElementById('prompt');
        box.value = '';
        composerDraft = '';
        box.disabled = true;
        refreshPromptBox();
    }
    splitChainView(s);
    if (runningSid === s.id) runningSid = null;
    restoreStoredRole();
    exportDirty = true;
    persist();
    renderTabBar();
    if (typeof syncRunDock === 'function') syncRunDock();
}
function hasContent() {
    return sessions.some(s => (s.prompt || '').trim() !== '' || s.data.order.length > 0);
}
function doClearSession() {
    sessions = [];
    activeSid = null;
    runningSid = null;
    restoreStoredRole();
    seq = 0;
    hideApprovalModal();
    if (typeof syncRunDock === 'function') syncRunDock();
    document.getElementById('clearOverlay').style.display = 'none';
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    document.getElementById('output').innerHTML = '';
    document.getElementById('pruneNote').textContent = '';
    exportDirty = false;
    editorSlot = '';
    composerDraft = '';
    createSession();
}
function newSession() {
    if (runningSid !== null) return;
    // Only warn when there's unexported content worth keeping.
    if (!exportDirty || !hasContent()) { doClearSession(); return; }
    resetClearHint();
    pendingContinuation = '';
    document.getElementById('clearOverlay').style.display = 'flex';
}
function releasePromptCaret(box) {
    if (box && typeof vimClearBlockCaret === 'function') vimClearBlockCaret(box);
}
function syncPromptUI() {
    const s = activeSession();
    const box = document.getElementById('prompt');
    const btn = document.getElementById('runBtn');
    if (!box) return;
    // A wide idle lane keeps the composer beside history, config, docs,
    // tools, and credits. Narrow screens still set the box aside for those views.
    const besideLane = promptLaneWide() && !promptRunLive();
    const paneOpen = configActive || creditsActive || historyActive || docsActive || toolsActive || (typeof memoryActive !== 'undefined' && memoryActive);
    const hidden = !!(paneOpen && !besideLane);
    if (!s) {
        box.disabled = true;
        if (btn) btn.disabled = true;
        releasePromptCaret(box);
        return;
    }
    // A finished chain keeps its submitted prompt on the session. The box
    // stays editable so the next draft can be typed or pasted. A running
    // chain, and a composer hidden on a narrow pane, stay locked.
    const locked = hidden || promptRunLive() || s.status === 'running';
    const next = (s.status === 'fresh' || s.status === 'running') ? (s.prompt || '') : composerDraft;
    const focused = typeof document !== 'undefined' && document.activeElement === box;
    if (!focused || locked) {
        if (box.value !== next) box.value = next;
    }
    if (typeof refreshPromptBox === 'function') refreshPromptBox();
    box.disabled = locked;
    if (box.disabled) releasePromptCaret(box);
    const pending = (s.status === 'fresh' || s.status === 'running')
        ? ''
        : String((focused ? box.value : next) || '').trim();
    const canRun = !locked && runningSid === null && (s.status === 'fresh' || (s.status !== 'running' && pending !== ''));
    if (btn) btn.disabled = !canRun;
}
if (typeof window !== 'undefined' && window.matchMedia) {
    try {
        const promptLaneQuery = window.matchMedia('(min-width: 1920px)');
        if (promptLaneQuery && typeof promptLaneQuery.addEventListener === 'function') {
            promptLaneQuery.addEventListener('change', () => {
                if (promptLaneWide() && !promptRunLive() && !promptCollapseChosen && !promptExpanded) setPromptExpanded(true);
                else syncPromptDock();
            });
        }
    } catch (e) {}
}

