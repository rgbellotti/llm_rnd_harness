// Manual tool testing: run a registered tool directly, without recording.
let toolTestState = { tool: '', values: {} };

// Manual tests already receive the machine-shaped execution JSON. For
// web_fetch, pull browser stderr and exit status out for a dedicated panel
// without changing the editable page-text preview or what a model receives.
// Other tools keep their existing preview behavior; request-level errors
// still use the panel below.
function toolTestDiagnostics(data) {
    if (!data) return '';
    if (data.error) return String(data.error);
    if (data.tool !== 'web_fetch' || !data.raw) return '';
    let raw;
    try { raw = JSON.parse(data.raw); } catch (e) { return ''; }
    if (!raw || typeof raw !== 'object') return '';
    const stderr = typeof raw.stderr === 'string' ? raw.stderr.trim() : '';
    const hasExit = Object.prototype.hasOwnProperty.call(raw, 'exit_code');
    const badExit = hasExit && raw.exit_code !== 0;
    if (!stderr && !badExit) return '';
    const lines = [];
    if (stderr) lines.push(stderr);
    if (badExit) lines.push('exit code: ' + (raw.exit_code == null ? 'unavailable' : raw.exit_code));
    return lines.join('\n');
}
function showToolTestDiagnostics(text) {
    const box = document.getElementById('tt-diagnostics');
    const body = document.getElementById('tt-diagnostics-text');
    if (!box || !body) return;
    const value = String(text || '').trim();
    body.textContent = value;
    box.hidden = !value;
}

function testableTools() {
    const c = cachedConfig;
    if (!c || !Array.isArray(c.tools)) return [];
    return c.tools.filter(t => {
        const name = t.function && t.function.name;
        return name === 'web_fetch' || name === 'web_search' || name === 'read_pdf' || name === 'write_file' || (typeof name === 'string' && name.endsWith('_search'));
    });
}

// Parse the text of an array-typed field (`edits`) into its JSON value.
// Returns undefined for an empty field so the run leaves the argument
// out; throws with a message naming the field on invalid JSON.
function parseArrayField(name, value) {
    if (value === '') return undefined;
    try {
        return JSON.parse(value);
    } catch (e) {
        throw new Error(name + ' is not valid JSON.');
    }
}

// The tool the form opens on: web_fetch when it is testable, else the
// first testable tool. A previous pick in toolTestState wins over this.
function defaultTestableTool(tools) {
    const names = tools.map(t => t.function && t.function.name);
    if (names.includes('web_fetch')) return 'web_fetch';
    return names[0] || '';
}

function fieldForProperty(name, spec) {
    const wrap = document.createElement('div');
    wrap.className = 'menu-row';
    const label = document.createElement('label');
    label.textContent = name + (spec && spec.description ? ' — ' + spec.description : '');
    label.setAttribute('for', 'tt-' + name);
    wrap.appendChild(label);

    let input;
    if (spec && Array.isArray(spec.enum)) {
        input = document.createElement('select');
        input.id = 'tt-' + name;
        for (const v of spec.enum) {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = v;
            if (spec.default === v) opt.selected = true;
            input.appendChild(opt);
        }
    } else if (spec && spec.type === 'integer') {
        input = document.createElement('input');
        input.type = 'number';
        input.id = 'tt-' + name;
        if (spec.minimum !== undefined) input.min = spec.minimum;
        if (spec.maximum !== undefined) input.max = spec.maximum;
        if (spec.default !== undefined) input.value = spec.default;
    } else if (spec && spec.type === 'array') {
        // A JSON array typed as text: write_file's `edits` pairs.
        input = document.createElement('textarea');
        input.id = 'tt-' + name;
        input.spellcheck = true;
        input.rows = 4;
        input.style.width = '100%';
        input.placeholder = '[{"search": "...", "replace": "..."}]';
    } else if (name === 'content') {
        // write_file's full-file text: multiline, not a one-line field.
        input = document.createElement('textarea');
        input.id = 'tt-' + name;
        input.spellcheck = true;
        input.rows = 12;
        input.style.width = '100%';
    } else {
        input = document.createElement('input');
        input.type = 'text';
        input.id = 'tt-' + name;
        input.style.width = '100%';
        input.style.minWidth = '420px';
        if (spec && spec.default !== undefined) input.value = spec.default;
    }
    input.dataset.arg = name;
    input.addEventListener('input', () => {
        toolTestState.values[name] = input.value;
    });
    // write_file's path opens prefilled with the workspace directory, so
    // the write address starts where the project lives. A saved value
    // from earlier in this tab visit wins over the prefill.
    if (name === 'path'
        && toolTestState.tool === 'write_file'
        && toolTestState.values[name] === undefined
        && cachedConfig && typeof cachedConfig.workspace_dir === 'string'
        && cachedConfig.workspace_dir) {
        input.value = cachedConfig.workspace_dir.replace(/\/+$/, '') + '/';
    }
    if (toolTestState.values[name] !== undefined) input.value = toolTestState.values[name];
    wrap.appendChild(input);
    return wrap;
}

function renderToolTest() {
    const view = document.getElementById('toolTestView');
    if (!view) return;
    view.innerHTML = '';

    const title = document.createElement('h2');
    title.textContent = 'Manual Tool Testing';
    view.appendChild(title);

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Runs a tool exactly as the model would. Not recorded in any transcript or history. Output is editable.';
    view.appendChild(hint);

    const tools = testableTools();
    if (tools.length === 0) {
        const p = document.createElement('p');
        p.className = 'hint';
        p.textContent = 'No testable tools in config yet.';
        view.appendChild(p);
        return;
    }

    const row = document.createElement('div');
    row.className = 'menu-row';
    const selLabel = document.createElement('label');
    selLabel.textContent = 'Tool';
    row.appendChild(selLabel);
    const select = document.createElement('select');
    select.id = 'tt-tool';
    for (const t of tools) {
        const opt = document.createElement('option');
        opt.value = t.function.name;
        opt.textContent = t.function.name;
        select.appendChild(opt);
    }
    if (toolTestState.tool) select.value = toolTestState.tool;
    else toolTestState.tool = defaultTestableTool(tools);
    select.value = toolTestState.tool;
    row.appendChild(select);
    view.appendChild(row);

    const form = document.createElement('div');
    form.id = 'tt-form';
    view.appendChild(form);

    const btnRow = document.createElement('div');
    btnRow.className = 'menu-row';
    const runBtn = document.createElement('button');
    runBtn.className = 'btn-accept';
    runBtn.type = 'button';
    runBtn.textContent = 'Run tool';
    btnRow.appendChild(runBtn);
    view.appendChild(btnRow);

    const status = document.createElement('p');
    status.id = 'tt-status';
    status.className = 'hint';
    view.appendChild(status);

    const btnRow2 = document.createElement('div');
    btnRow2.className = 'menu-row';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn-accept';
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save';
    const topBtn = document.createElement('button');
    topBtn.type = 'button';
    topBtn.textContent = 'top';
    const bottomBtn = document.createElement('button');
    bottomBtn.type = 'button';
    bottomBtn.textContent = 'bottom';
    btnRow2.appendChild(saveBtn);
    btnRow2.appendChild(topBtn);
    btnRow2.appendChild(bottomBtn);
    view.appendChild(btnRow2);

    function saveResult() {
        const box = document.getElementById('tt-result');
        const text = box ? (box.value || '') : '';
        if (!text) { setStatus('The result is empty.'); return; }
        const selector = (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function')
            ? window.showSaveFilePicker : null;
        if (selector) {
            selector({ suggestedName: 'tool_result.txt', types: [{ description: 'Text', accept: { 'text/plain': ['.txt'] } }] })
                .then(handle => handle.createWritable()).then(writable => {
                    return writable.write(text).then(() => writable.close());
                }).then(() => { setStatus('Saved the result.'); })
                .catch(e => {
                    if (e && e.name === 'AbortError') return;
                    if (typeof download === 'function') { download('tool_result.txt', text, 'text/plain;charset=utf-8'); setStatus('Saved the result.'); return; }
                    setStatus('Could not save the result.');
                });
            return;
        }
        if (typeof download === 'function') { download('tool_result.txt', text, 'text/plain;charset=utf-8'); setStatus('Saved the result.'); return; }
        setStatus('Could not save the result.');
    }
    saveBtn.onclick = saveResult;
    topBtn.onclick = () => {
        const box = document.getElementById('tt-result');
        if (!box) return;
        try { box.focus(); } catch (e) {}
        if (typeof box.setSelectionRange === 'function') { try { box.setSelectionRange(0, 0); } catch (e) {} }
        box.scrollTop = 0;
    };
    bottomBtn.onclick = () => {
        const box = document.getElementById('tt-result');
        if (!box) return;
        const v = String(box.value || '');
        try { box.focus(); } catch (e) {}
        if (typeof box.setSelectionRange === 'function') { try { box.setSelectionRange(v.length, v.length); } catch (e) {} }
        box.scrollTop = typeof box.scrollHeight === 'number' ? box.scrollHeight : 0;
    };

    const resultLabel = document.createElement('label');
    resultLabel.textContent = 'Result (editable)';
    resultLabel.setAttribute('for', 'tt-result');
    view.appendChild(resultLabel);
    const result = document.createElement('textarea');
    result.id = 'tt-result';
    result.spellcheck = true;
    result.style.width = '100%';
    result.style.minHeight = '420px';
    view.appendChild(result);

    const diagnostics = document.createElement('section');
    diagnostics.id = 'tt-diagnostics';
    diagnostics.className = 'tool-test-diagnostics';
    diagnostics.hidden = true;
    const diagnosticsLabel = document.createElement('label');
    diagnosticsLabel.textContent = 'Diagnostics (not submitted to the model)';
    diagnosticsLabel.setAttribute('for', 'tt-diagnostics-text');
    const diagnosticsText = document.createElement('pre');
    diagnosticsText.id = 'tt-diagnostics-text';
    diagnosticsText.className = 'tool-test-diagnostics-text';
    diagnostics.appendChild(diagnosticsLabel);
    diagnostics.appendChild(diagnosticsText);
    view.appendChild(diagnostics);

    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Raw execution JSON';
    details.appendChild(summary);
    const raw = document.createElement('pre');
    raw.id = 'tt-raw';
    details.appendChild(raw);
    view.appendChild(details);

    function buildForm() {
        form.innerHTML = '';
        const t = tools.find(x => x.function.name === select.value);
        if (!t) return;
        toolTestState.tool = select.value;
        const props = (t.function.parameters && t.function.parameters.properties) || {};
        const required = new Set(t.function.parameters && t.function.parameters.required || []);
        for (const name of Object.keys(props)) {
            const field = fieldForProperty(name, props[name]);
            if (required.has(name)) {
                const req = document.createElement('span');
                req.textContent = ' *';
                field.querySelector('label').appendChild(req);
            }
            form.appendChild(field);
        }
    }

    select.addEventListener('change', () => {
        toolTestState.tool = select.value;
        toolTestState.values = {};
        buildForm();
    });
    buildForm();

    runBtn.addEventListener('click', async () => {
        showToolTestDiagnostics('');
        status.textContent = 'Running…';
        const t = tools.find(x => x.function.name === select.value);
        const props = (t.function.parameters && t.function.parameters.properties) || {};
        const args = {};
        for (const name of Object.keys(props)) {
            const el = document.getElementById('tt-' + name);
            if (!el) continue;
            let v = el.value;
            const spec = props[name];
            if (spec && spec.type === 'integer') {
                if (v !== '') v = Number(v);
            } else if (spec && spec.type === 'array') {
                try {
                    const parsed = parseArrayField(name, v);
                    if (parsed === undefined) continue;
                    v = parsed;
                } catch (e) {
                    status.textContent = 'Error: ' + e.message;
                    showToolTestDiagnostics('Error: ' + e.message);
                    return;
                }
            }
            if (v !== '' && v !== null) args[name] = v;
        }
        try {
            const res = await apiFetch('/test-tool', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tool: select.value, arguments: args })
            });
            const data = await res.json();
            if (!res.ok || data.error) {
                const message = 'Error: ' + (data.error || res.statusText);
                status.textContent = message;
                showToolTestDiagnostics(message);
                return;
            }
            status.textContent = 'Done.';
            result.value = data.preview || '';
            raw.textContent = data.raw || '';
            showToolTestDiagnostics(toolTestDiagnostics(data));
        } catch (e) {
            const message = 'Request failed: ' + e;
            status.textContent = message;
            showToolTestDiagnostics(message);
        }
    });
}
