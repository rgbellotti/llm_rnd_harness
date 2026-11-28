// modelmenu.js — load after tabs.js. The model name in the header is the
// toggle for the model selector: a compact dropdown with the
// OLLAMA/LOCAL/GROK/REFLECTION/OPENCODE groups, enabled only while no run is
// in flight (same rule as the server,
// which enforces it via the single-run semaphore). Switching swaps the model
// for the next run; the running chain, if any, is untouched.
let modelMenuBuilt = false;
function buildModelMenu() {
    const menu = document.getElementById('modelMenu');
    if (!menu || modelMenuBuilt) return;
    let groups = [];
    try { groups = JSON.parse(menu.getAttribute('data-groups') || '[]'); } catch (e) {}
    const frag = document.createDocumentFragment();
    for (const group of groups) {
        const label = document.createElement('span');
        label.className = 'menu-group-label';
        label.textContent = group.group;
        frag.appendChild(label);
        const models = group.models || [];
        if (group.group === 'LOCAL' && models.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'model-menu-hint';
            empty.textContent = 'No local chat models listed.';
            frag.appendChild(empty);
        }
        for (const name of models) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'model-option';
            btn.setAttribute('role', 'menuitemradio');
            btn.dataset.model = name;
            btn.dataset.provider = group.group;
            const mark = document.createElement('span');
            mark.className = 'model-mark';
            mark.textContent = '✓';
            const text = document.createTextNode(name);
            btn.append(mark, text);
            btn.onclick = () => switchModel(name);
            frag.appendChild(btn);
        }
    }
    const hint = document.createElement('div');
    hint.className = 'model-menu-hint';
    hint.textContent = 'Switches for the next run — nothing mid-generation changes.';
    frag.appendChild(hint);
    const err = document.createElement('div');
    err.className = 'model-menu-error';
    err.id = 'modelMenuError';
    err.style.display = 'none';
    frag.appendChild(err);
    menu.appendChild(frag);
    modelMenuBuilt = true;
}
function syncModelMenu() {
    // Called from tabs.js renderTabBar(): keep the menu's enabled state in
    // lockstep with runningSid. Also refreshes the active-model mark.
    const menu = document.getElementById('modelMenu');
    const toggle = document.getElementById('modelToggle');
    if (!menu || !toggle) return;
    const busy = runningSid !== null;
    for (const btn of menu.querySelectorAll('.model-option')) {
        btn.disabled = busy;
    }
    toggle.disabled = busy;
    toggle.title = busy
        ? 'A run is in flight — switch models when it finishes'
        : 'Switch model (applies to the next run)';
    const current = (toggle.textContent || '').trim();
    for (const btn of menu.querySelectorAll('.model-option')) {
        const active = btn.dataset.model === current;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-checked', active ? 'true' : 'false');
        btn.querySelector('.model-mark').textContent = active ? '✓' : ' ';
    }
    syncDefaultLink();
    applyReasoningControls();
}
function openModelMenu(open) {
    const menu = document.getElementById('modelMenu');
    const toggle = document.getElementById('modelToggle');
    if (!menu || !toggle) return;
    const want = open === undefined ? menu.hidden : open;
    if (want) {
        // Server enforces the same rule; this is the disabled rendering of it.
        clearModelMenuError();
        syncModelMenu();
        menu.hidden = false;
        toggle.setAttribute('aria-expanded', 'true');
    } else {
        menu.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
    }
}
function clearModelMenuError() {
    const err = document.getElementById('modelMenuError');
    if (err) { err.textContent = ''; err.style.display = 'none'; }
}
function showModelMenuError(text) {
    const err = document.getElementById('modelMenuError');
    if (!err) return;
    err.textContent = text;
    err.style.display = '';
}
async function switchModel(name) {
    const toggle = document.getElementById('modelToggle');
    if (runningSid !== null) return; // grayed out; server would 409 anyway
    clearModelMenuError();
    try {
        const res = await apiFetch('/model', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: name })
        });
        if (res.status === 409) {
            syncModelMenu();
            showModelMenuError(await res.text() || 'A run is in flight — switch when it finishes.');
            return;
        }
        if (!res.ok) throw new Error(await res.text() || ('HTTP ' + res.status));
        const body = await res.json();
        toggle.textContent = body.model;
        syncModelMenu();
        openModelMenu(false);
        refreshConfig();
        setStatus('Model switched to ' + body.model);
    } catch (e) {
        showModelMenuError('Switch failed: ' + e.message);
    }
}

// ---- default model ("Make Default") ----
const DEFAULT_MODEL_STORE_KEY = 'harness.default_model.v1';
function storedDefaultModel() {
    try {
        if (typeof localStorage === 'undefined' || !localStorage.getItem) return null;
        const raw = localStorage.getItem(DEFAULT_MODEL_STORE_KEY);
        return raw ? String(raw) : null;
    } catch (e) { return null; }
}
function rememberDefaultModel(name) {
    try {
        if (typeof localStorage === 'undefined' || !localStorage.setItem) return;
        if (typeof name !== 'string' || !name) return;
        localStorage.setItem(DEFAULT_MODEL_STORE_KEY, name);
    } catch (e) {}
}
async function makeDefaultModel(name) {
    clearModelMenuError();
    try {
        const res = await apiFetch('/default-model', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: name })
        });
        if (!res.ok) throw new Error(await res.text() || ('HTTP ' + res.status));
        const body = await res.json();
        if (typeof cachedConfig !== 'undefined' && cachedConfig) cachedConfig.default_model = body.default_model;
        rememberDefaultModel(body.default_model);
        syncModelMenu();
        if (typeof setStatus === 'function') setStatus('Default model set to ' + body.default_model);
    } catch (e) {
        showModelMenuError('Make default failed: ' + e.message);
    }
}
// A restart clears the process default. The browser copy is sent back so
// the next launch still starts with the model the user saved.
async function restoreStoredDefaultModel() {
    const saved = storedDefaultModel();
    if (!saved) return;
    if (typeof cachedConfig !== 'undefined' && cachedConfig && cachedConfig.default_model === saved) return;
    try {
        await apiFetch('/default-model', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: saved })
        });
        if (typeof cachedConfig !== 'undefined' && cachedConfig) cachedConfig.default_model = saved;
    } catch (e) {}
}
let defaultLinkEl = null;
function syncDefaultLink() {
    const menu = document.getElementById('modelMenu');
    const toggle = document.getElementById('modelToggle');
    if (!menu || !toggle) return;
    const current = String(toggle.textContent || '').trim();
    const def = (typeof cachedConfig !== 'undefined' && cachedConfig && cachedConfig.default_model) || '';
    if (!current || !def || current === def) {
        if (defaultLinkEl && typeof defaultLinkEl.remove === 'function') defaultLinkEl.remove();
        defaultLinkEl = null;
        return;
    }
    if (!defaultLinkEl) {
        defaultLinkEl = document.createElement('a');
        defaultLinkEl.className = 'model-default-link';
        defaultLinkEl.href = '#';
        defaultLinkEl.textContent = 'Make Default';
        defaultLinkEl.onclick = (e) => {
            if (e && e.preventDefault) e.preventDefault();
            const t = document.getElementById('modelToggle');
            const name = t ? String(t.textContent || '').trim() : '';
            if (name) return makeDefaultModel(name);
        };
        menu.appendChild(defaultLinkEl);
    }
    // Place it right after the active option.
    const options = menu.querySelectorAll('.model-option');
    let active = null;
    for (const o of options) {
        if (o.dataset && o.dataset.model === current) { active = o; break; }
    }
    if (active && typeof active.insertAdjacentElement === 'function') {
        active.insertAdjacentElement('afterend', defaultLinkEl);
    }
}
(function wireModelMenu() {
    buildModelMenu();
    const toggle = document.getElementById('modelToggle');
    if (toggle) {
        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            openModelMenu();
        });
    }
    document.addEventListener('click', (e) => {
        const menu = document.getElementById('modelMenu');
        const target = e.target;
        if (!menu || menu.hidden) return;
        if (target === toggle || (menu.contains && menu.contains(target))) return;
        openModelMenu(false);
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') openModelMenu(false);
    });
    syncModelMenu();
    const effort = document.getElementById('effortSelect');
    if (effort) {
        effort.addEventListener('change', () => switchEffort(effort.value));
    }
})();
function modelProviderGroup(model) {
    const name = String(model || '').trim();
    if (/^opencode\//i.test(name)) return 'OPENCODE';
    if (/^grok(?:-|$)/i.test(name)) return 'GROK';
    if (/^beam(?:-|$)/i.test(name)) return 'REFLECTION';
    return 'OLLAMA';
}
function selectedProviderGroup() {
    const toggle = document.getElementById('modelToggle');
    const menu = document.getElementById('modelMenu');
    const current = toggle ? String(toggle.textContent || '').trim() : '';
    if (menu && typeof menu.querySelectorAll === 'function') {
        for (const option of menu.querySelectorAll('.model-option')) {
            if (option.dataset && option.dataset.model === current && option.dataset.provider) {
                return option.dataset.provider;
            }
        }
    }
    return modelProviderGroup(current);
}
function reasoningEffortSupported(provider) {
    return provider === 'GROK' || provider === 'REFLECTION';
}
function applyReasoningControls() {
    const effort = document.getElementById('effortSelect');
    const label = document.getElementById('effortLabel');
    const note = document.getElementById('effortNote');
    const provider = selectedProviderGroup();
    const supported = reasoningEffortSupported(provider);
    if (label) {
        label.textContent = provider === 'GROK'
            ? 'Grok reasoning effort'
            : provider === 'REFLECTION' ? 'Beam reasoning effort' : 'Reasoning effort';
    }
    if (note) {
        note.textContent = supported
            ? ''
            : 'currently unsupported (model default used).'
                + (provider === 'OPENCODE' ? ' Reasoning adjustment available directly in OpenCode.' : '');
    }
    if (effort) {
        effort.disabled = !supported;
        effort.title = supported
            ? 'Reasoning level for the next run. Approvals can change it for later rounds in the same run.'
            : (note ? note.textContent : 'Reasoning adjustment is unsupported; the model default is used.');
        if (typeof cachedConfig !== 'undefined' && cachedConfig && cachedConfig.reasoning_effort
            && effort.value !== cachedConfig.reasoning_effort) {
            effort.value = cachedConfig.reasoning_effort;
        }
    }
}
async function switchEffort(effort) {
    if (!reasoningEffortSupported(selectedProviderGroup())) return;
    const err = document.getElementById('effortError');
    if (err) { err.textContent = ''; err.style.display = 'none'; }
    if (typeof runningSid !== 'undefined' && runningSid !== null) {
        if (err) { err.textContent = 'A run is in flight — change reasoning effort when it finishes.'; err.style.display = ''; }
        return;
    }
    try {
        const res = await apiFetch('/reasoning-effort', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ effort: effort })
        });
        if (res.status === 409) {
            if (err) { err.textContent = await res.text() || 'A run is in flight.'; err.style.display = ''; }
            return;
        }
        if (!res.ok) throw new Error(await res.text() || ('HTTP ' + res.status));
        const body = await res.json();
        if (typeof cachedConfig !== 'undefined' && cachedConfig) cachedConfig.reasoning_effort = body.effort;
        if (typeof setStatus === 'function') setStatus('Reasoning effort set to ' + body.effort);
        if (typeof refreshConfig === 'function') refreshConfig();
    } catch (e) {
        if (err) { err.textContent = 'Effort change failed: ' + e.message; err.style.display = ''; }
    }
}
