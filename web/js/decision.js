// decision.js — the "decision" tab: run a bool / rating / choice query
// against a separate model. Transient (never recorded); independent of the
// [Generate] run, so it works during an approval window. Needs core.js,
// tabs.js (cachedConfig, apiFetch).
let decisionKind = 'bool';

// References to the form's own elements, set by renderDecision. Kept as
// fields rather than looked up by id so the sub-tab and run handlers do
// not depend on document.getElementById for dynamically-built nodes.
let decisionRefs = {
    modelSelect: null,
    prompt: null,
    tabs: null,
    fields: null,
    min: null,
    max: null,
    options: null,
    status: null,
    result: null,
    cloudNote: null,
};

function decisionGroups() {
    if (typeof cachedConfig !== 'undefined' && cachedConfig && cachedConfig.decision_models) {
        try { return JSON.parse(cachedConfig.decision_models) || []; } catch (e) { return []; }
    }
    return [];
}

function decisionCurrentModel() {
    return (typeof cachedConfig !== 'undefined' && cachedConfig && cachedConfig.decision_model) || '';
}

// A model is cloud unless it sits in the LOCAL group; the catalog groups
// are OLLAMA (cloud), LOCAL, GROK, REFLECTION.
function decisionModelIsCloud(model) {
    if (!model) return false;
    const groups = decisionGroups();
    for (const group of groups) {
        if ((group.models || []).indexOf(model) >= 0) {
            return group.group !== 'LOCAL';
        }
    }
    return /:cloud$/.test(model) || /-cloud$/.test(model);
}

function elementInt(el, fallback) {
    const n = el ? parseInt(el.value, 10) : NaN;
    return Number.isFinite(n) ? n : fallback;
}

function formatDecisionValue(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
}

// Build the POST body for the current form state. Pure, so it is testable.
function decisionPayload(kind, model, prompt, min, max, optionsText) {
    const body = { kind: kind, prompt: prompt };
    if (model) body.model = model;
    if (kind === 'rating') {
        body.min = min;
        body.max = max;
    } else if (kind === 'choice') {
        body.options = String(optionsText || '').split('\n')
            .map(function (s) { return s.trim(); })
            .filter(function (s) { return s.length > 0; });
    }
    return body;
}

function decisionFieldRow(id, labelText, type, value, placeholder) {
    const wrap = document.createElement('div');
    wrap.className = 'menu-row';
    const label = document.createElement('label');
    label.textContent = labelText;
    wrap.appendChild(label);
    const input = document.createElement('input');
    input.type = type;
    input.id = id;
    if (value !== undefined) input.value = value;
    if (placeholder) input.placeholder = placeholder;
    input.style.width = '90px';
    wrap.appendChild(input);
    return { node: wrap, input: input };
}

function decisionTypeFields(kind) {
    const wrap = document.createElement('div');
    let min = null;
    let max = null;
    let options = null;
    if (kind === 'rating') {
        const minField = decisionFieldRow('decisionMin', 'Minimum', 'number', 1);
        const maxField = decisionFieldRow('decisionMax', 'Maximum', 'number', 5);
        min = minField.input;
        max = maxField.input;
        wrap.appendChild(minField.node);
        wrap.appendChild(maxField.node);
        const hint = document.createElement('div');
        hint.className = 'menu-hint';
        hint.textContent = 'The model answers with an integer from min to max.';
        wrap.appendChild(hint);
    } else if (kind === 'choice') {
        const label = document.createElement('label');
        label.textContent = 'Options (one per line)';
        wrap.appendChild(label);
        const area = document.createElement('textarea');
        area.id = 'decisionOptions';
        area.spellcheck = true;
        area.rows = 4;
        area.placeholder = 'Local\nRemote\nHybrid';
        area.style.width = '100%';
        options = area;
        wrap.appendChild(area);
    } else {
        const hint = document.createElement('div');
        hint.className = 'menu-hint';
        hint.textContent = 'The model answers yes or no.';
        wrap.appendChild(hint);
    }
    return { node: wrap, min: min, max: max, options: options };
}

function setDecisionKind(kind) {
    decisionKind = kind;
    const tabs = decisionRefs.tabs;
    if (tabs) {
        for (let i = 0; i < tabs.children.length; i++) {
            const button = tabs.children[i];
            const on = button.textContent === kind;
            button.className = 'sub-tab' + (on ? ' sub-tab-active' : '');
            button.setAttribute('aria-selected', on ? 'true' : 'false');
        }
    }
    const built = decisionTypeFields(kind);
    if (decisionRefs.fields) {
        decisionRefs.fields.replaceChildren();
        decisionRefs.fields.appendChild(built.node);
    }
    decisionRefs.min = built.min;
    decisionRefs.max = built.max;
    decisionRefs.options = built.options;
}

function updateDecisionCloudNote() {
    const note = decisionRefs.cloudNote;
    const select = decisionRefs.modelSelect;
    if (!note || !select) return;
    const model = select.value || '';
    if (decisionModelIsCloud(model)) {
        note.textContent = 'CLOUD — the decision prompt and its answer leave this machine.';
        note.style.display = '';
    } else {
        note.textContent = '';
        note.style.display = 'none';
    }
}

async function switchDecisionModel(name) {
    try {
        const res = await apiFetch('/decision/model', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: name })
        });
        if (!res.ok) throw new Error(await res.text() || ('HTTP ' + res.status));
        const body = await res.json();
        if (typeof cachedConfig !== 'undefined' && cachedConfig) cachedConfig.decision_model = body.decision_model;
        updateDecisionCloudNote();
    } catch (e) {
        const note = decisionRefs.cloudNote;
        if (note) {
            note.textContent = 'Switch failed: ' + (e && e.message ? e.message : e);
            note.style.display = '';
        }
    }
}

async function runDecision() {
    const status = decisionRefs.status;
    const result = decisionRefs.result;
    const promptText = decisionRefs.prompt ? String(decisionRefs.prompt.value || '').trim() : '';
    if (!promptText) {
        if (status) status.textContent = 'Enter the context to decide on.';
        return;
    }
    const kind = decisionKind;
    const model = decisionRefs.modelSelect ? decisionRefs.modelSelect.value : '';
    const body = decisionPayload(kind, model, promptText,
        elementInt(decisionRefs.min, 1), elementInt(decisionRefs.max, 5),
        decisionRefs.options ? decisionRefs.options.value : '');
    if (status) status.textContent = 'Running…';
    if (result) result.style.display = 'none';
    try {
        const res = await apiFetch('/decision', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error(await res.text() || ('HTTP ' + res.status));
        const data = await res.json();
        if (status) status.textContent = '';
        if (result) {
            const decision = data.parsed_ok
                ? formatDecisionValue(data.value)
                : 'could not parse';
            result.textContent = 'model: ' + data.model
                + '\nkind: ' + data.kind
                + '\ndecision: ' + decision
                + '\n\nraw answer:\n' + String(data.raw || '');
            result.style.display = '';
        }
    } catch (e) {
        if (status) status.textContent = 'Error: ' + (e && e.message ? e.message : e);
    }
}

function renderDecision() {
    const view = document.getElementById('decisionView');
    if (!view) return;
    view.innerHTML = '';

    const title = document.createElement('h2');
    title.className = 'pane-title';
    title.textContent = 'Decision queries';
    view.appendChild(title);

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Run a bool, rating, or choice decision against a separate model. Transient — nothing is recorded. Works while a run is in flight.';
    view.appendChild(hint);

    const modelRow = document.createElement('div');
    modelRow.className = 'menu-row';
    const modelLabel = document.createElement('label');
    modelLabel.textContent = 'Model';
    modelRow.appendChild(modelLabel);
    const select = document.createElement('select');
    select.id = 'decisionModel';
    const groups = decisionGroups();
    const current = decisionCurrentModel();
    for (const group of groups) {
        const og = document.createElement('optgroup');
        og.label = group.group;
        for (const name of (group.models || [])) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            if (name === current) opt.selected = true;
            og.appendChild(opt);
        }
        select.appendChild(og);
    }
    select.onchange = () => switchDecisionModel(select.value);
    modelRow.appendChild(select);
    view.appendChild(modelRow);

    const cloudNote = document.createElement('span');
    cloudNote.className = 'menu-hint';
    cloudNote.id = 'decisionCloudNote';
    view.appendChild(cloudNote);

    const tabs = document.createElement('div');
    tabs.className = 'sub-tabs';
    tabs.id = 'decisionKindTabs';
    tabs.setAttribute('role', 'tablist');
    for (const kind of ['bool', 'rating', 'choice']) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sub-tab' + (kind === 'bool' ? ' sub-tab-active' : '');
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', kind === 'bool' ? 'true' : 'false');
        button.textContent = kind;
        button.onclick = () => setDecisionKind(kind);
        tabs.appendChild(button);
    }
    view.appendChild(tabs);

    const promptLabel = document.createElement('label');
    promptLabel.textContent = 'Context to decide on';
    view.appendChild(promptLabel);
    const prompt = document.createElement('textarea');
    prompt.id = 'decisionPrompt';
    prompt.spellcheck = true;
    prompt.rows = 6;
    prompt.style.width = '100%';
    view.appendChild(prompt);

    const fields = document.createElement('div');
    fields.id = 'decisionTypeFields';
    view.appendChild(fields);

    const runBtn = document.createElement('button');
    runBtn.type = 'button';
    runBtn.className = 'btn-accept';
    runBtn.textContent = 'Run decision';
    runBtn.onclick = runDecision;
    view.appendChild(runBtn);

    const status = document.createElement('p');
    status.id = 'decisionStatus';
    status.className = 'hint';
    view.appendChild(status);

    const result = document.createElement('pre');
    result.id = 'decisionResult';
    result.className = 'tool';
    result.style.display = 'none';
    view.appendChild(result);

    decisionRefs = {
        modelSelect: select,
        prompt: prompt,
        tabs: tabs,
        fields: fields,
        min: null,
        max: null,
        options: null,
        status: status,
        result: result,
        cloudNote: cloudNote,
    };

    setDecisionKind('bool');
    updateDecisionCloudNote();
}
