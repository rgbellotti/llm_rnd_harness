// memory.js — project memory tab and the project dropdown used by config
// and tools. Needs tabs.js (cachedConfig, apiFetch, setStatus).
let memoryActive = false;
let memoryDeleteArmed = '';

function applyMemoryPayload(body) {
    if (!body || !cachedConfig) return;
    cachedConfig.memory_recording = body.recording;
    cachedConfig.memory_error = body.error || null;
    cachedConfig.memory_project = body.selected || null;
    cachedConfig.memory_projects = body.projects || [];
    if (body.selected && !(cachedConfig.enabled_tools || []).includes('project_mem')) {
        // Selection does not enable the tool. The checkbox stays the gate.
    }
    if (!body.selected && cachedConfig.enabled_tools) {
        cachedConfig.enabled_tools = cachedConfig.enabled_tools.filter(name => name !== 'project_mem');
        if (cachedConfig.approve_calls) {
            cachedConfig.approve_calls = cachedConfig.approve_calls.filter(name => name !== 'project_mem');
        }
    }
}

async function postMemory(path, payload) {
    const res = await apiFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {})
    });
    if (!res.ok) throw new Error(await res.text() || ('HTTP ' + res.status));
    return res.json();
}

async function selectMemoryProject(name) {
    try {
        const body = await postMemory('/memory/select', { name: name || null });
        applyMemoryPayload(body);
        if (typeof repaintRegistration === 'function') repaintRegistration();
        if (memoryActive) renderMemory(body);
        setStatus(name ? ('Project set to ' + name + '.') : 'Project cleared. project_mem is off until a project is selected.');
    } catch (err) {
        setStatus('Project selection failed: ' + (err && err.message ? err.message : err));
        if (typeof repaintRegistration === 'function') repaintRegistration();
    }
}

function memoryProjectControl(busy) {
    const wrap = document.createElement('div');
    wrap.className = 'metrics memory-picker';
    const label = document.createElement('label');
    label.appendChild(document.createTextNode('Project: '));
    const menu = document.createElement('select');
    menu.className = 'tool-policy';
    menu.disabled = !!busy;
    menu.title = busy
        ? 'A run is in flight — change the project after it finishes'
        : 'Project whose memory the next run can use. project_mem stays off until its checkbox is on.';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '(none)';
    menu.appendChild(none);
    const projects = (cachedConfig && cachedConfig.memory_projects) || [];
    for (let i = 0; i < projects.length; i++) {
        const project = projects[i];
        if (!project || !project.name) continue;
        const opt = document.createElement('option');
        opt.value = project.name;
        opt.textContent = project.name;
        menu.appendChild(opt);
    }
    menu.value = (cachedConfig && cachedConfig.memory_project) || '';
    menu.onchange = () => selectMemoryProject(menu.value);
    label.appendChild(menu);
    wrap.appendChild(label);
    if (cachedConfig && cachedConfig.memory_error) {
        const err = document.createElement('div');
        err.className = 'error';
        err.textContent = cachedConfig.memory_error;
        wrap.appendChild(err);
    }
    return wrap;
}

function memoryField(parent, labelText, value, tag) {
    const label = document.createElement('label');
    label.className = 'memory-label';
    label.textContent = labelText;
    const input = document.createElement(tag || 'input');
    if (!tag) input.type = 'text';
    input.className = 'memory-input';
    input.value = value || '';
    label.appendChild(input);
    parent.appendChild(label);
    return input;
}

function renderMemory(body) {
    const view = document.getElementById('memoryView');
    if (!view) return;
    view.innerHTML = '';
    const data = body || {};
    const paneTitle = document.createElement('h2');
    paneTitle.className = 'pane-title';
    paneTitle.textContent = 'Project memory';
    view.appendChild(paneTitle);
    const head = document.createElement('div');
    head.className = 'round';
    const hint = document.createElement('p');
    hint.className = 'docs-copy';
    hint.textContent = 'The word "project" is used similarly to an agent or bot assistant. Creating a project and description will allow the models to store memory throughout multiple sessions, in an experimental HOT/WARM/COLD memory layout inspired by Nous Research\'s design. Hot layer is inserted into the context history as principle awareness of the project state, Warm memorizations can be used for informed planning, and Cold detail-storage for project specific records/notes. Stored memory notes will be visible here while project is active.';
    head.appendChild(hint);
    if (data.error) {
        const err = document.createElement('div');
        err.className = 'error';
        err.textContent = data.error;
        head.appendChild(err);
    } else if (data.recording === false) {
        const err = document.createElement('div');
        err.className = 'error';
        err.textContent = 'Project memory is unavailable. History can still record runs.';
        head.appendChild(err);
    }
    const form = document.createElement('div');
    form.className = 'memory-form';
    const nameInput = memoryField(form, 'New project name', '', 'input');
    const descInput = memoryField(form, 'Goal / description', '', 'textarea');
    descInput.rows = 3;
    const create = document.createElement('button');
    create.type = 'button';
    create.textContent = 'Create project';
    create.onclick = async () => {
        try {
            const saved = await postMemory('/memory/projects', {
                name: nameInput.value,
                description: descInput.value
            });
            applyMemoryPayload(saved);
            renderMemory(saved);
            setStatus('Created project ' + (saved.selected || nameInput.value) + '.');
        } catch (err) {
            setStatus('Could not create project: ' + (err && err.message ? err.message : err));
        }
    };
    form.appendChild(create);
    head.appendChild(form);
    view.appendChild(head);

    const projects = data.projects || [];
    const list = document.createElement('div');
    list.className = 'round';
    const listTitle = document.createElement('h3');
    listTitle.textContent = 'Projects';
    list.appendChild(listTitle);
    if (!projects.length) {
        const empty = document.createElement('p');
        empty.className = 'docs-copy';
        empty.textContent = 'No projects yet.';
        list.appendChild(empty);
    }
    for (let i = 0; i < projects.length; i++) {
        const project = projects[i];
        const row = document.createElement('div');
        row.className = 'memory-project';
        const name = document.createElement('strong');
        name.textContent = project.name + (data.selected === project.name ? ' (selected)' : '');
        row.appendChild(name);
        const select = document.createElement('button');
        select.type = 'button';
        select.textContent = data.selected === project.name ? 'Clear' : 'Select';
        select.onclick = () => selectMemoryProject(data.selected === project.name ? '' : project.name);
        row.appendChild(select);
        const del = document.createElement('button');
        del.type = 'button';
        del.textContent = memoryDeleteArmed === project.name ? 'Confirm delete' : 'Delete';
        del.onclick = async () => {
            if (memoryDeleteArmed !== project.name) {
                memoryDeleteArmed = project.name;
                renderMemory(data);
                return;
            }
            memoryDeleteArmed = '';
            try {
                const saved = await postMemory('/memory/delete', { name: project.name });
                applyMemoryPayload(saved);
                renderMemory(saved);
                setStatus('Deleted project ' + project.name + '.');
            } catch (err) {
                setStatus('Could not delete project: ' + (err && err.message ? err.message : err));
            }
        };
        row.appendChild(del);
        if (project.description) {
            const goal = document.createElement('div');
            goal.className = 'metrics';
            goal.textContent = project.description;
            row.appendChild(goal);
        }
        list.appendChild(row);
    }
    view.appendChild(list);

    const selected = data.view;
    if (!selected) return;
    const notes = document.createElement('div');
    notes.className = 'round';
    const notesTitle = document.createElement('h3');
    notesTitle.textContent = selected.name;
    notes.appendChild(notesTitle);
    const edit = document.createElement('div');
    edit.className = 'memory-form';
    const goalInput = memoryField(edit, 'Goal / description', selected.description || '', 'textarea');
    goalInput.rows = 3;
    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = 'Save goal';
    save.onclick = async () => {
        try {
            const saved = await postMemory('/memory/description', {
                name: selected.name,
                description: goalInput.value
            });
            applyMemoryPayload(saved);
            renderMemory(saved);
            setStatus('Saved the goal for ' + selected.name + '.');
        } catch (err) {
            setStatus('Could not save the goal: ' + (err && err.message ? err.message : err));
        }
    };
    edit.appendChild(save);
    notes.appendChild(edit);

    const hot = document.createElement('h4');
    hot.textContent = 'Hot';
    notes.appendChild(hot);
    const hotHint = document.createElement('p');
    hotHint.className = 'docs-copy';
    hotHint.textContent = 'Inserted once, beside the system prompt, at the next session start. The warm keys line carries the references to the warm thoughts below. It is not rewritten during the run.';
    notes.appendChild(hotHint);
    const hotBody = document.createElement('pre');
    hotBody.className = 'memory-block';
    hotBody.textContent = selected.injected || selected.hot || '(none yet)';
    notes.appendChild(hotBody);

    const warm = document.createElement('h4');
    warm.textContent = 'Warm';
    notes.appendChild(warm);
    const warmBody = document.createElement('pre');
    warmBody.className = 'memory-block';
    let warmText = '{}';
    try { warmText = JSON.stringify(selected.warm || {}, null, 2); } catch (e) { warmText = '{}'; }
    warmBody.textContent = warmText;
    notes.appendChild(warmBody);

    const cold = document.createElement('h4');
    cold.textContent = 'Cold';
    notes.appendChild(cold);
    const coldNotes = document.createElement('div');
    coldNotes.className = 'memory-cold-notes';
    const rows = selected.notes || [];
    if (!rows.length) {
        const empty = document.createElement('p');
        empty.className = 'docs-copy';
        empty.textContent = '(none)';
        coldNotes.appendChild(empty);
    }
    for (let i = 0; i < rows.length; i++) {
        const note = rows[i];
        const card = document.createElement('dl');
        card.className = 'memory-cold-note';
        [['Title', note.key], ['Tags', note.tags], ['Note', note.body]].forEach(([label, value]) => {
            const term = document.createElement('dt');
            term.textContent = label;
            const detail = document.createElement('dd');
            detail.textContent = value || '';
            card.appendChild(term);
            card.appendChild(detail);
        });
        coldNotes.appendChild(card);
    }
    notes.appendChild(coldNotes);
    view.appendChild(notes);
}

async function showMemory() {
    if (typeof deactivatePanes === 'function') deactivatePanes();
    memoryActive = true;
    const output = document.getElementById('output');
    if (output) output.style.display = 'none';
    const view = document.getElementById('memoryView');
    if (view) {
        view.style.display = '';
        view.innerHTML = '<div class="round"><p>Loading project memory…</p></div>';
    }
    setStatus('');
    if (typeof renderTabBar === 'function') renderTabBar();
    try {
        const res = await apiFetch('/memory');
        if (!res.ok) throw new Error(await res.text() || ('HTTP ' + res.status));
        const body = await res.json();
        applyMemoryPayload(body);
        renderMemory(body);
    } catch (err) {
        if (view) {
            view.innerHTML = '';
            const d = document.createElement('div');
            d.className = 'error';
            d.textContent = 'Could not load project memory: ' + (err && err.message ? err.message : err);
            view.appendChild(d);
        }
    }
}
