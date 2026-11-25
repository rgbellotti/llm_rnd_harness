const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { document, elements } = require('./testdom.js').createDom();
const sandbox = { document, getSession: () => null, runningSid: 'run', setTimeout: fn => fn(), stopRun: async () => {}, fetch: null, setActivityIcon: () => {} };
// apiFetch (core.js) is what the app calls; route it to the stub fetch.
sandbox.apiFetch = (...args) => sandbox.fetch(...args);
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(__dirname + '/core.js', 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(__dirname + '/approval.js', 'utf8'), sandbox);
const evaluate = code => vm.runInContext(code, sandbox);
const original = 'URL: https://example.com\nContent: † Info·( https://example.com/info )';
const rawPage = '<html><script>secret-script-token</script><p>Hello</p></html>';
const showWeb = id => sandbox.showApprovalModal({
    approval_id: id, round: 1, name: 'web_fetch', arguments: { url: 'https://example.com' },
    review: { kind: 'fetch', url: 'https://example.com', preview: original, raw_body: rawPage }
});
(async () => {
    sandbox.showApprovalModal({ approval_id: 'search', round: 1, name: 'web_search', arguments: { query: '<query>', max_results: 5 } });
    assert.equal(document.getElementById('approvalText').style.display, 'none');
    assert.equal(document.getElementById('addCommentBtn').style.display, 'none');
    assert.equal(document.getElementById('approvalAccept').style.display, '');
    sandbox.fetch = async (_url, options) => { assert.equal(JSON.parse(options.body).action, 'approve'); return { ok: true }; };
    await sandbox.decideApproval('approve');
    assert.equal(evaluate('pendingApprovalId'), null);
    sandbox.showApprovalModal({
        approval_id: 'search-one', round: 1, name: 'web_search',
        arguments: { query: 'sources', max_results: 5 },
        review: { kind: 'search', query: 'sources', max_results: 5 }
    });
    assert.match(document.getElementById('approvalHint').textContent, /second review dialog/);
    assert.match(document.getElementById('approvalHint').textContent, /only the text approved there reaches the model/);
    sandbox.showApprovalModal({
        approval_id: 'search-two', round: 1, name: 'web_search',
        arguments: { query: 'sources', max_results: 5 },
        review: { kind: 'search', query: 'sources', max_results: 5, preview: 'raw hit list' }
    });
    assert.equal(document.getElementById('approvalTitle').textContent, 'Review search results');
    assert.equal(document.getElementById('approvalText').value, 'raw hit list');
    assert.equal(document.getElementById('rawBodyWrap').style.display, 'none');
    assert.equal(document.getElementById('fetchReviewTabs').style.display, 'none');
    assert.match(document.getElementById('approvalHint').textContent, /stays open until you decide/);
    sandbox.showApprovalModal({
        approval_id: 'cmd-one', round: 1, name: 'run_cmd',
        arguments: { command: 'printf harness-ok' },
        output_review: true
    });
    assert.match(document.getElementById('approvalHint').textContent, /second review dialog then opens with its output/);
    sandbox.showApprovalModal({
        approval_id: 'cmd-two', round: 1, name: 'run_cmd',
        arguments: { command: 'printf harness-ok' },
        review: { kind: 'cmd', command: 'printf harness-ok', preview: 'stdout:\nharness-ok\n' }
    });
    assert.equal(document.getElementById('approvalTitle').textContent, 'Review command output');
    assert.equal(document.getElementById('approvalText').value, 'stdout:\nharness-ok\n');
    assert.equal(document.getElementById('rawBodyWrap').style.display, 'none');
    document.getElementById('approvalText').value = '';
    await sandbox.submitWebResults();
    assert.match(document.getElementById('approvalError').textContent, /command output/);
    sandbox.showApprovalModal({ approval_id: 'pdf-one', round: 1, name: 'read_pdf', arguments: { path: '/tmp/spec.pdf' },
        review: { kind: 'pdf', path: '/tmp/spec.pdf', pages: '1-3', layout: 'reading', mode: 'text' } });
    assert.equal(document.getElementById('approvalAccept').style.display, '');
    assert.match(document.getElementById('approvalHint').textContent, /PDF.*second review/i);
    assert.match(document.getElementById('approvalHint').textContent, /only content approved there reaches the model/i);
    sandbox.fetch = async (_url, options) => { assert.equal(JSON.parse(options.body).action, 'approve'); return { ok: true }; };
    await sandbox.decideApproval('approve');
    assert.equal(evaluate('pendingApprovalId'), null);
    sandbox.showApprovalModal({ approval_id: 'pdf-two', round: 2, name: 'read_pdf', arguments: { path: '/tmp/spec.pdf' },
        review: { kind: 'pdf', path: '/tmp/spec.pdf', pages: '1-3', layout: 'reading', mode: 'text', preview: 'page text body' } });
    assert.equal(document.getElementById('approvalTitle').textContent, 'Review extracted text (spec.pdf)');
    assert.match(document.getElementById('approvalHint').textContent, /Edit or trim noisy parts/i);
    assert.equal(document.getElementById('approvalText').value, 'page text body');
    assert.equal(document.getElementById('rawBodyWrap').style.display, 'none');
    assert.equal(document.getElementById('approvalAccept').style.display, 'none');
    assert.match(document.getElementById('webSubmit').textContent, /Approve/);
    sandbox.fetch = async () => ({ ok: true });
    document.getElementById('approvalText').value = 'trimmed pdf text';
    await sandbox.submitWebResults();
    assert.equal(evaluate('pendingApprovalId'), null);
    showWeb('fetch');
    assert.equal(document.getElementById('approvalCloud').style.display, 'none');
    assert.equal(document.getElementById('webSubmit').textContent, 'Approve & submit content');
    assert.equal(document.getElementById('approvalText').value, original);
    assert.equal(document.getElementById('approvalDialog').className, 'modal web-input');
    assert.equal(document.getElementById('approvalAccept').style.display, 'none');
    assert.equal(document.getElementById('fetchReviewTabs').style.display, '');
    assert.equal(document.getElementById('approvalText').style.display, '');
    assert.equal(document.getElementById('addCommentBtn').style.display, '');
    assert.equal(document.getElementById('rawBodyWrap').style.display, 'none');
    assert.match(document.getElementById('fetchTextTab').className, /sub-tab-active/);
    document.getElementById('fetchRawTab').onclick();
    assert.equal(document.getElementById('rawBodyWrap').style.display, '');
    assert.equal(document.getElementById('approvalText').style.display, 'none');
    assert.equal(document.getElementById('addCommentBtn').style.display, 'none');
    assert.equal(document.getElementById('approvalTextBottom').style.display, 'none');
    assert.match(document.getElementById('rawBodyBox').textContent, /secret-script-token/);
    assert.match(document.getElementById('fetchRawTab').className, /sub-tab-active/);
    document.getElementById('fetchTextTab').onclick();
    assert.equal(document.getElementById('approvalText').style.display, '');
    assert.equal(document.getElementById('addCommentBtn').style.display, '');
    assert.equal(document.getElementById('approvalTextTop').style.display, '');
    assert.equal(document.getElementById('approvalText').value, original);
    const jumped = document.getElementById('approvalText');
    jumped.scrollHeight = 400;
    jumped.scrollTop = 40;
    document.getElementById('approvalTextTop').onclick();
    assert.equal(jumped.selectionStart, 0);
    assert.equal(jumped.selectionEnd, 0);
    assert.equal(jumped.scrollTop, 0);
    document.getElementById('approvalTextBottom').onclick();
    assert.equal(jumped.selectionStart, original.length);
    assert.equal(jumped.selectionEnd, original.length);
    assert.equal(jumped.scrollTop, 400);
    document.getElementById('approvalTextAll').onclick();
    assert.equal(jumped.selectionStart, 0);
    assert.equal(jumped.selectionEnd, original.length);
    assert.equal(jumped.scrollTop, 0);
    assert.equal(jumped.value, original);
    assert.equal(document.getElementById('rawBodyWrap').style.display, 'none');
    assert.match(document.getElementById('approvalHint').textContent, /document\.body after JavaScript/);
    assert.match(document.getElementById('approvalHint').textContent, /DOMContentLoaded/);
    assert.match(document.getElementById('approvalHint').textContent, /marked partial/);
    assert.match(document.getElementById('approvalHint').textContent, /HTTP response body/);
    assert.match(document.getElementById('approvalHint').textContent, /stays open until you decide/);
    document.getElementById('approvalText').value = '';
    sandbox.fetch = () => { throw new Error('empty text must not send'); };
    await sandbox.submitWebResults();
    const edited = '  edited page text\nNotes: <literal>  ';
    document.getElementById('approvalText').value = edited;
    sandbox.fetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(body.action, 'web_result'); assert.equal(body.text, edited);
        return { ok: false, text: async () => 'retry' };
    };
    await sandbox.submitWebResults();
    assert.equal(evaluate('approvalBusy'), false);
    assert.equal(document.getElementById('approvalText').value, edited);
    assert.equal(document.getElementById('webSubmit').disabled, false);
    sandbox.fetch = async () => { showWeb('next'); return { ok: true }; };
    await sandbox.submitWebResults();
    assert.equal(evaluate('pendingApprovalId'), 'next');
    assert.equal(document.getElementById('approvalText').value, original);
    sandbox.fetch = async () => ({ ok: true });
    await sandbox.submitWebResults();
    assert.equal(evaluate('pendingApprovalId'), null);
    showWeb('stop'); await document.getElementById('approvalStop').onclick();
    assert.equal(evaluate('pendingApprovalId'), null);
    sandbox.showApprovalModal({
        approval_id: 'search-after', round: 1, name: 'web_search',
        arguments: { query: 'sources', max_results: 5 },
        review: { kind: 'search', query: 'sources', max_results: 5, preview: 'raw hit list' }
    });
    assert.equal(document.getElementById('rawBodyWrap').style.display, 'none');
    assert.equal(document.getElementById('rawBodyBox').textContent, '');
    sandbox.showApprovalModal({
        approval_id: 'fetch-no-body', round: 1, name: 'web_fetch', arguments: { url: 'https://example.com' },
        review: { kind: 'fetch', url: 'https://example.com', preview: original }
    });
    assert.equal(document.getElementById('approvalText').value, original);
    assert.equal(document.getElementById('rawBodyWrap').style.display, 'none');
    assert.equal(document.getElementById('fetchReviewTabs').style.display, 'none');
    assert.equal(document.getElementById('approvalStderrTab').style.display, 'none');
    sandbox.showApprovalModal({
        approval_id: 'fetch-stderr', round: 1, name: 'web_fetch', arguments: { url: 'https://example.com' },
        review: { kind: 'fetch', url: 'https://example.com', preview: original, stderr: 'refused request: private address\n', raw_body: rawPage }
    });
    assert.equal(document.getElementById('approvalText').value, original);
    assert.equal(document.getElementById('approvalStderrTab').style.display, '');
    assert.match(document.getElementById('approvalDialog').className, /has-stderr/);
    assert.match(document.getElementById('approvalDialog').className, /web-input/);
    assert.equal(document.getElementById('approvalStderrPane').style.display, 'none');
    assert.match(document.getElementById('approvalHint').textContent, /stderr tab/);
    document.getElementById('approvalStderrTab').onclick();
    assert.equal(document.getElementById('approvalStderrPane').style.display, '');
    assert.equal(document.getElementById('approvalActionPane').style.display, 'none');
    assert.match(document.getElementById('approvalStderr').textContent, /refused request: private address/);
    document.getElementById('approvalText').value = 'curated page';
    let postedFetch = null;
    sandbox.fetch = async (_url, options) => {
        postedFetch = JSON.parse(options.body);
        return { ok: true };
    };
    await sandbox.submitWebResults();
    assert.equal(postedFetch.action, 'web_result');
    assert.equal(postedFetch.text, 'curated page');
    assert.equal(postedFetch.text.includes('refused request'), false);
    sandbox.showApprovalModal({
        approval_id: 'fetch-blank-stderr', round: 1, name: 'web_fetch', arguments: { url: 'https://example.com' },
        review: { kind: 'fetch', url: 'https://example.com', preview: original, stderr: ' \n\t' }
    });
    assert.equal(document.getElementById('approvalStderrTab').style.display, 'none');
    assert.equal(document.getElementById('approvalDialog').className.includes('has-stderr'), false);
    sandbox.showApprovalModal({
        approval_id: 'search-hides-stderr', round: 1, name: 'web_search',
        arguments: { query: 'sources', max_results: 5 },
        review: { kind: 'search', query: 'sources', max_results: 5, preview: 'raw hit list' }
    });
    assert.equal(document.getElementById('approvalStderrTab').style.display, 'none');
    assert.equal(document.getElementById('approvalText').value, 'raw hit list');
    sandbox.cachedConfig = { model_cloud: true };
    showWeb('cloud');
    assert.equal(document.getElementById('approvalCloud').style.display, '');
    assert.equal(document.getElementById('approvalCloud').textContent, 'CLOUD — prompts and tool outputs leave this machine');
    assert.equal(document.getElementById('approvalCloudFoot').style.display, '');
    assert.equal(document.getElementById('approvalCloudFoot').textContent, 'CLOUD — prompts and tool outputs leave this machine');
    assert.equal(document.getElementById('webSubmit').textContent, 'Approve & submit content');
    document.getElementById('approvalAccept').textContent = 'Accept & run';
    sandbox.showApprovalModal({
        approval_id: 'cloud-accept', round: 1, name: 'run_cmd',
        arguments: { command: 'printf harness-ok' }
    });
    assert.equal(document.getElementById('approvalCloud').style.display, '');
    assert.equal(document.getElementById('approvalCloud').textContent, 'CLOUD — prompts and tool outputs leave this machine');
    assert.equal(document.getElementById('approvalCloudFoot').style.display, 'none');
    assert.equal(document.getElementById('approvalAccept').textContent, 'Accept & run');
    assert.equal(document.getElementById('addCommentBtn').style.display, 'none');
    document.getElementById('approvalRedirect').onclick();
    assert.equal(document.getElementById('approvalText').style.display, '');
    assert.equal(document.getElementById('approvalRedirect').textContent, 'Send to model');
    assert.equal(document.getElementById('addCommentBtn').style.display, 'none');
    sandbox.activeSid = null;
    sandbox.getSession = () => ({
        commentTag: 'abc123def456',
        data: { order: [1, 2], rounds: {
            1: { thinking: 'earlier pass over the directory' },
            2: { thinking: 'list the files, then keep the pngs' }
        } }
    });
    sandbox.showApprovalModal({
        approval_id: 'think', round: 2, name: 'run_cmd',
        arguments: { command: 'ls' }
    });
    assert.equal(document.getElementById('approvalThinking').textContent, 'list the files, then keep the pngs');
    assert.match(document.getElementById('approvalThinkingNote').textContent, /round 2/);
    assert.equal(document.getElementById('approvalActionPane').style.display, '');
    assert.equal(document.getElementById('approvalThinkingPane').style.display, 'none');
    document.getElementById('approvalThinkingTab').onclick();
    assert.equal(document.getElementById('approvalActionPane').style.display, 'none');
    assert.match(document.getElementById('approvalThinkingTab').className, /sub-tab-active/);
    document.getElementById('approvalActionTab').onclick();
    assert.match(document.getElementById('approvalActionTab').className, /sub-tab-active/);
    sandbox.showApprovalModal({
        approval_id: 'cloud-cmd', round: 1, name: 'run_cmd',
        arguments: { command: 'printf harness-ok' },
        review: { kind: 'cmd', command: 'printf harness-ok', preview: 'stdout:\nharness-ok\n' }
    });
    assert.equal(document.getElementById('approvalTitle').textContent, 'Review command output');
    assert.equal(document.getElementById('approvalCloudFoot').style.display, '');
    assert.equal(document.getElementById('approvalCloudFoot').textContent, 'CLOUD — prompts and tool outputs leave this machine');
    assert.equal(document.getElementById('webSubmit').textContent, 'Approve & submit content');
    assert.equal(document.getElementById('fetchReviewTabs').style.display, 'none');
    assert.equal(document.getElementById('addCommentBtn').style.display, '');
    const commentBox = document.getElementById('approvalText');
    commentBox.value = 'stdout:\nharness-ok\n';
    commentBox.selectionStart = 'stdout:\n'.length;
    commentBox.selectionEnd = commentBox.selectionStart;
    document.getElementById('addCommentBtn').onclick();
    const commentOpen = '<abc123def456>';
    const commentClose = '</abc123def456>';
    assert.equal(commentBox.value, 'stdout:\n' + commentOpen + commentClose + 'harness-ok\n');
    assert.equal(commentBox.selectionStart, 'stdout:\n'.length + commentOpen.length);
    assert.equal(commentBox.selectionEnd, commentBox.selectionStart);
    commentBox.selectionStart = commentBox.selectionStart;
    commentBox.value = commentBox.value.slice(0, commentBox.selectionStart) + 'focus on the pngs' + commentBox.value.slice(commentBox.selectionStart);
    let postedComment = null;
    sandbox.fetch = async (_url, options) => {
        postedComment = JSON.parse(options.body).text;
        return { ok: true };
    };
    await sandbox.submitWebResults();
    assert.equal(postedComment, 'stdout:\n<abc123def456>focus on the pngs</abc123def456>harness-ok\n');
    assert.equal(postedComment.includes('user_comment'), false);
    assert.equal(
        sandbox.maskCommentTags(postedComment, 'abc123def456'),
        'stdout:\n<user_comment>focus on the pngs</user_comment>harness-ok\n'
    );
    sandbox.cachedConfig = { model_cloud: false };
    showWeb('local-again');
    assert.equal(document.getElementById('approvalCloud').style.display, 'none');
    assert.equal(document.getElementById('approvalCloud').textContent, '');
    assert.equal(document.getElementById('approvalCloudFoot').style.display, 'none');
    assert.equal(document.getElementById('webSubmit').textContent, 'Approve & submit content');
    sandbox.cachedConfig = null;
    sandbox.escHtml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    sandbox.cachedConfig = null;
    sandbox.doClearSession = () => {};
    sandbox.fmtMs = ms => String(ms || 0) + " ms";
    sandbox.originalPreviewLabel = name => name === 'read_pdf' ? 'EXTRACT ORIGINAL' : (name === 'web_search' || name === 'rag_search') ? 'SEARCH ORIGINAL' : name === 'run_cmd' ? 'COMMAND OUTPUT ORIGINAL' : 'FETCH ORIGINAL';
    vm.runInContext(fs.readFileSync(__dirname + '/storage.js', 'utf8'), sandbox);
    const archive = sandbox.archiveDoc([{ num: 1, prompt: 'test', data: { totals: { prompt: 0, completion: 0 }, order: [1], rounds: {
        1: { toolCalls: [{ name: 'web_fetch', arguments: { url: 'https://example.com' } }],
             toolResults: [{ output: edited, duration_ms: 1 }],
             toolPreviews: [{ output: original, duration_ms: 10 }] }
    } } }]);
    assert.ok(archive.includes('FETCH ORIGINAL (before review'));
    assert.ok(archive.includes('function copyArchive'));
    assert.ok(archive.includes('</script></head>'));
    const labeled = sandbox.archiveDoc([{ num: 2, prompt: 'labels', data: { totals: { prompt: 0, completion: 0 }, order: [1], rounds: {
        1: { toolPreviews: [
            { name: 'web_search', output: 'hits', duration_ms: 1 },
            { name: 'run_cmd', output: 'stdout', duration_ms: 2 }
        ] }
    } } }]);
    assert.ok(labeled.includes('SEARCH ORIGINAL'));
    assert.ok(labeled.includes('COMMAND OUTPUT ORIGINAL'));
    assert.ok(archive.includes('† Info·( https://example.com/info )'));
    assert.ok(archive.includes('edited page text'));
    assert.ok(archive.includes('&lt;literal&gt;'));
    const fetchCapture = JSON.stringify({
        stdout: 'kept page',
        stderr: 'network error',
        raw_body: '<html>secret-script-token</html>',
        exit_code: 0
    });
    assert.equal(sandbox.previewContextText({ name: 'web_fetch', output: fetchCapture }), 'kept page');
    assert.equal(sandbox.previewContextText({ name: 'web_fetch', output: original }), original);
    assert.equal(sandbox.previewContextText({ name: 'run_cmd', output: fetchCapture }), fetchCapture);
    const fetchWindow = document.createElement('div');
    sandbox.renderWebFetchPreview(fetchWindow, text => text, { name: 'web_fetch', output: fetchCapture, duration_ms: 4 });
    assert.equal(fetchWindow.children[1].children[0].textContent, 'Captured text');
    assert.equal(fetchWindow.children[1].children[1].textContent, 'stderr');
    assert.equal(fetchWindow.children[1].children[2].textContent, 'Original HTML');
    assert.equal(fetchWindow.children[2].textContent, 'kept page');
    assert.equal(fetchWindow.children[2].style.display, '');
    assert.equal(fetchWindow.children[3].style.display, 'none');
    assert.match(fetchWindow.children[3].textContent, /network error/);
    fetchWindow.children[1].children[1].onclick();
    assert.equal(fetchWindow.children[3].style.display, '');
    assert.equal(fetchWindow.children[2].style.display, 'none');
    const fetchResult = document.createElement('div');
    sandbox.renderWebFetchResult(fetchResult, text => text, {
        name: 'web_fetch', output: '{"url":"https://example.com","content":"approved page"}', duration_ms: 5
    }, 'network error');
    assert.equal(fetchResult.children[1].children[0].textContent, 'Output');
    assert.match(fetchResult.children[2].textContent, /approved page/);
    assert.equal(fetchResult.children[3].style.display, 'none');
    const quietResult = document.createElement('div');
    sandbox.renderWebFetchResult(quietResult, text => text, { name: 'web_fetch', output: 'approved page', duration_ms: 5 }, '  ');
    assert.match(quietResult.textContent, /approved page/);
    assert.equal(quietResult.children.length, 0);
    const archivedFetch = sandbox.archiveDoc([{ num: 4, prompt: 'fetch', data: { totals: { prompt: 0, completion: 0 }, order: [1], rounds: {
        1: { toolPreviews: [{ name: 'web_fetch', output: fetchCapture, duration_ms: 4 }] }
    } } }]);
    assert.ok(archivedFetch.includes('kept page'));
    assert.ok(archivedFetch.includes('stderr:\nnetwork error') || archivedFetch.includes('stderr:\\nnetwork error') || archivedFetch.includes('stderr:'));
    assert.ok(archivedFetch.includes('network error'));
    assert.ok(archivedFetch.includes('Original HTML:'));
    assert.ok(archivedFetch.includes('secret-script-token'));
    assert.equal(archivedFetch.includes('"raw_body"'), false);
    const maskedArchive = sandbox.archiveDoc([{ num: 3, prompt: 'notes', commentTag: 'abc123def456', data: { totals: { prompt: 0, completion: 0 }, order: [1], rounds: {
        1: { thinking: 'see <abc123def456>x</abc123def456>', content: 'ok',
             toolCalls: [{ name: 'run_cmd', arguments: { command: 'ls' } }],
             toolResults: [{ output: 'ls\n<abc123def456>\nfocus\n</abc123def456>', duration_ms: 1 }],
             toolPreviews: [{ output: 'preview <abc123def456>keep</abc123def456>', duration_ms: 2 }] }
    } } }]);
    assert.ok(maskedArchive.includes('&lt;user_comment&gt;'));
    assert.ok(maskedArchive.includes('&lt;/user_comment&gt;'));
    assert.equal(maskedArchive.includes('abc123def456'), false);
    assert.match(maskedArchive, /see &lt;user_comment&gt;x&lt;\/user_comment&gt;/);
    assert.doesNotMatch(maskedArchive, /<span class="user-comment">[^<]*see /);
    assert.match(maskedArchive, /<span class="user-comment">/);
    sandbox.setStatus = () => {};
    sandbox.runningSid = null;
    vm.runInContext(fs.readFileSync(__dirname + '/tabs.js', 'utf8'), sandbox);
    evaluate('cachedConfig = ' + JSON.stringify({
        model: 'local-test', model_cloud: false, max_tool_rounds: null,
        workspace_dir: '/tmp', custom_files: [], system_prompt: 'prompt',
        enabled_tools: ['run_cmd'], review_run_cmd: false,
        tools: [{ function: { name: 'run_cmd' } }], tool_meta: []
    }) + '; renderConfig()');
    const findId = (node, id) => {
        if (!node) return null;
        if (node.id === id) return node;
        for (const child of node.children || []) {
            const found = findId(child, id);
            if (found) return found;
        }
        return null;
    };
    const reviewBox = findId(document.getElementById('configView'), 'review-run-cmd');
    assert.ok(reviewBox, 'config view renders the run_cmd review checkbox');
    assert.equal(reviewBox.type, 'checkbox');
    assert.equal(reviewBox.checked, false);
    assert.equal(reviewBox.disabled, false);
    let rowText = '';
    const scan = node => {
        rowText += node.textContent || '';
        for (const child of node.children || []) scan(child);
    };
    // children[0] is the pane title; the registration round follows it.
    scan(document.getElementById('configView').children[1]);
    assert.match(rowText, /\(local\)/);
    assert.match(rowText, /Review run_cmd output/);
    assert.equal(rowText.includes('On by default'), false);
    assert.equal(rowText.includes('i enters insert'), false);
    const vimBox = findId(document.getElementById('configView'), 'vim-editing');
    assert.ok(vimBox, 'config view renders the vim editing checkbox');
    assert.equal(vimBox.type, 'checkbox');
    assert.equal(vimBox.checked, false);
    assert.ok(!vimBox.disabled, 'vim keys stay switchable during a run');
    const autosaveBox = findId(document.getElementById('configView'), 'restore-autosave');
    assert.ok(autosaveBox, 'config view renders the restore autosave checkbox');
    assert.equal(autosaveBox.type, 'checkbox');
    assert.equal(autosaveBox.checked, true);
    assert.ok(!autosaveBox.disabled, 'restore autosave stays switchable during a run');
    const configIds = [];
    const walkIds = node => {
        if (node && node.id) configIds.push(node.id);
        for (const child of (node && node.children) || []) walkIds(child);
    };
    walkIds(document.getElementById('configView'));
    assert.ok(configIds.indexOf('vim-editing') < configIds.indexOf('restore-autosave'), 'restore autosave sits under vim keys');
    evaluate('renderDocs()');
    const vimHelp = findId(document.getElementById('docsView'), 'vim-editing-help');
    assert.ok(vimHelp, 'docs list the vim keys');
    let docsText = '';
    const scanDocs = node => {
        docsText += node.textContent || '';
        for (const child of node.children || []) scanDocs(child);
    };
    scanDocs(document.getElementById('docsView'));
    // The docs view is wording the user rewrites freely — sections may
    // be added, removed, or reworded any time. Assert the rendering
    // behavior, never the sentences.
    assert.ok(docsText.length > 0, 'renderDocs populates the docs view');
    // Backticks are markup: every `code` span renders as a code element
    // and no raw backtick leaks into the displayed text.
    assert.ok(!docsText.includes('`'), 'backticks must render as code, not text');
    const docsCodes = [];
    const walkCode = node => {
        if (node && node.tag === 'code') docsCodes.push(node.textContent);
        for (const child of (node && node.children) || []) walkCode(child);
    };
    walkCode(document.getElementById('docsView'));
    assert.ok(docsCodes.length > 0, 'code spans render as code elements');
    // Sections render as headed blocks.
    let docsHeadings = 0;
    const walkHeadings = node => {
        if (node && node.tag === 'h3') docsHeadings += 1;
        for (const child of (node && node.children) || []) walkHeadings(child);
    };
    walkHeadings(document.getElementById('docsView'));
    assert.ok(docsHeadings > 0, 'docs sections render with headings');
    // A re-render rebuilds the view in place instead of appending a
    // second copy.
    const firstPass = docsText;
    evaluate('renderDocs()');
    let secondPass = '';
    const rescan = node => {
        secondPass += node.textContent || '';
        for (const child of node.children || []) rescan(child);
    };
    rescan(document.getElementById('docsView'));
    assert.equal(secondPass, firstPass, 'renderDocs rebuilds in place, not appends');
    sandbox.fetch = async (url, options) => {
        assert.equal(url, '/run-cmd-review');
        assert.equal(JSON.parse(options.body).enabled, true);
        return { ok: true, json: async () => ({ review_run_cmd: true }) };
    };
    reviewBox.checked = true;
    await reviewBox.onchange();
    assert.equal(evaluate('cachedConfig.review_run_cmd'), true);
    const updated = findId(document.getElementById('configView'), 'review-run-cmd');
    assert.equal(updated.checked, true);
    evaluate('cachedConfig = ' + JSON.stringify({
        model: 'beam:cloud', model_cloud: true, max_tool_rounds: null,
        workspace_dir: '/tmp', custom_files: [], system_prompt: 'prompt',
        enabled_tools: ['run_cmd'], review_run_cmd: true,
        tools: [{ function: { name: 'run_cmd' } }], tool_meta: []
    }) + '; renderConfig()');
    let cloudRow = '';
    const scanCloud = node => {
        cloudRow += node.textContent || '';
        for (const child of node.children || []) scanCloud(child);
    };
    for (const child of document.getElementById('configView').children) scanCloud(child);
    // The cloud marker is a security property, not prose: it must be
    // visible while a cloud model is selected. The local case below
    // asserts it disappears.
    assert.match(cloudRow, /CLOUD/);
    evaluate('cachedConfig = ' + JSON.stringify({
        model: 'local-test', model_cloud: false, max_tool_rounds: null,
        workspace_dir: '/tmp', custom_files: [],
        system_prompt: 'Inside a tool result, a <abc123def456> block </abc123def456> is the person.',
        system_prompt_template: 'Keep this role.',
        comment_tag: 'abc123def456',
        workspace_env: '/tmp/lab',
        workspace_env_enabled: false,
        workspace_sentence: '',
        enabled_tools: ['run_cmd'], review_run_cmd: false,
        tools: [{ function: { name: 'run_cmd' } }], tool_meta: []
    }) + '; renderConfig()');
    let promptRow = '';
    const scanPrompt = node => {
        promptRow += node.textContent || '';
        for (const child of node.children || []) scanPrompt(child);
    };
    for (const child of document.getElementById('configView').children) scanPrompt(child);
    assert.match(promptRow, /<user_comment>/);
    assert.equal(promptRow.includes('abc123def456'), false);
    // A local model shows no cloud marker: visibility of egress is the
    // function, and it toggles with the model.
    assert.equal(promptRow.includes('CLOUD'), false, 'local model must not show the cloud marker');
    const promptView = findId(document.getElementById('configView'), 'system-prompt');
    assert.ok(promptView, 'the system prompt is on the config page');
    assert.equal(typeof promptView.onclick, 'function');
    const configHead = document.getElementById('configView').children[1];
    const markers = [];
    for (const child of configHead.children) {
        if (child.id) markers.push(child.id);
        else if (String(child.className || '').split(/\s+/).includes('config-rule')) markers.push('rule');
        else if (String(child.className || '').split(/\s+/).includes('config-check')) markers.push('check');
    }
    const sentenceAt = markers.indexOf('workspace-sentence');
    assert.deepEqual(markers.slice(sentenceAt, sentenceAt + 9), [
        'workspace-sentence', 'rule', 'comment-tag-note', 'rule', 'tool-menu', 'check', 'check', 'check', 'rule'
    ]);
    assert.ok(markers.indexOf('theme-presets') > markers.lastIndexOf('rule'));
    const commentNote = findId(configHead, 'comment-tag-note');
    // The note explains the comment marker: assert it exists, is
    // populated, and displays the protocol token. Its sentences are
    // display wording and may change freely.
    assert.ok(commentNote.textContent.length > 0, 'the comment marker note is populated');
    assert.match(commentNote.textContent, /<user_comment><\/user_comment>/);
    const restoreBtn = findId(configHead, 'system-prompt-restore');
    assert.equal(restoreBtn.textContent, 'Restore default');
    const promptHead = findId(configHead, 'system-prompt-head');
    assert.ok(findId(promptHead, 'system-prompt-restore'), 'restore default sits on the system prompt header');
    assert.equal(findId(promptHead, 'system-prompt'), null);
    assert.equal(restoreBtn.disabled, false);
    evaluate('configActive = true');
    promptView.onclick();
    const roleEdit = findId(document.getElementById('configView'), 'system-prompt-edit');
    assert.ok(roleEdit, 'clicking the system prompt opens the role');
    assert.equal(roleEdit.value, 'Keep this role.');
    roleEdit.value = 'Custom role.';
    sandbox.fetch = async (url, options) => {
        assert.equal(url, '/role');
        const sent = JSON.parse(options.body);
        assert.equal(sent.template, 'Custom role.');
        assert.equal(sent.workspace_enabled, false);
        assert.equal(sent.workspace_env, '/tmp/lab');
        return { ok: true, json: async () => ({
            system_prompt: 'Custom role.',
            system_prompt_template: 'Custom role.',
            workspace_env_enabled: false,
            workspace_env: '/tmp/lab',
            workspace_sentence: ''
        }) };
    };
    const roleStore = new Map();
    sandbox.localStorage = {
        getItem(key) { return roleStore.has(key) ? roleStore.get(key) : null; },
        setItem(key, value) { roleStore.set(key, String(value)); },
        removeItem(key) { roleStore.delete(key); },
    };
    const saveRoleBtn = findId(document.getElementById('configView'), 'system-prompt-save');
    await saveRoleBtn.onclick();
    assert.equal(JSON.parse(roleStore.get('harness.role.v1')).template, 'Custom role.');
    assert.equal(evaluate('cachedConfig.system_prompt_template'), 'Custom role.');
    const savedView = findId(document.getElementById('configView'), 'system-prompt');
    assert.match(savedView.textContent, /Custom role/);
    const wsBox = findId(document.getElementById('configView'), 'workspace-env');
    assert.equal(wsBox.checked, false);
    wsBox.checked = true;
    const wsPath = findId(document.getElementById('configView'), 'workspace-env-path');
    wsPath.value = '/tmp/custom-env';
    const previousGet = document.getElementById.bind(document);
    document.getElementById = (id) => {
        if (id === 'workspace-env') return wsBox;
        if (id === 'workspace-env-path') return wsPath;
        if (id === 'system-prompt-edit') return null;
        return previousGet(id);
    };
    sandbox.fetch = async (url, options) => {
        const sent = JSON.parse(options.body);
        assert.equal(url, '/role');
        assert.equal(sent.template, 'Custom role.');
        assert.equal(sent.workspace_enabled, true);
        assert.equal(sent.workspace_env, '/tmp/custom-env');
        return { ok: true, json: async () => ({
            system_prompt: 'Custom role. named',
            system_prompt_template: 'Custom role.',
            workspace_env_enabled: true,
            workspace_env: '/tmp/custom-env',
            workspace_sentence: 'A general workspace directory is available at: /tmp/custom-env'
        }) };
    };
    await wsBox.onchange();
    assert.equal(evaluate('cachedConfig.workspace_env_enabled'), true);
    const sentence = findId(document.getElementById('configView'), 'workspace-sentence');
    assert.match(sentence.textContent, /\/tmp\/custom-env/);
    document.getElementById = previousGet;
    evaluate('cachedConfig.system_prompt_default = "Built-in role."');
    sandbox.fetch = async (url, options) => {
        const sent = JSON.parse(options.body);
        assert.equal(url, '/role');
        assert.equal(sent.template, 'Built-in role.');
        assert.equal(sent.workspace_enabled, true);
        assert.equal(sent.workspace_env, '/tmp/custom-env');
        return { ok: true, json: async () => ({
            system_prompt: 'Built-in role.',
            system_prompt_template: 'Built-in role.',
            system_prompt_default: 'Built-in role.',
            workspace_env_enabled: true,
            workspace_env: '/tmp/custom-env',
            workspace_sentence: 'A general workspace directory is available at: /tmp/custom-env'
        }) };
    };
    const restoreDefault = findId(document.getElementById('configView'), 'system-prompt-restore');
    await restoreDefault.onclick();
    assert.equal(evaluate('cachedConfig.system_prompt_template'), 'Built-in role.');
    assert.equal(roleStore.has('harness.role.v1'), false);
    assert.match(findId(document.getElementById('configView'), 'system-prompt').textContent, /Built-in role/);
    roleStore.set('harness.role.v1', JSON.stringify({ template: 'Stored role.' }));
    evaluate('cachedConfig.system_prompt_template = "Built-in role."');
    sandbox.fetch = async (url, options) => {
        const sent = JSON.parse(options.body);
        assert.equal(url, '/role');
        assert.equal(sent.template, 'Stored role.');
        return { ok: true, json: async () => ({
            system_prompt: 'Stored role.',
            system_prompt_template: 'Stored role.',
            system_prompt_default: 'Built-in role.',
            workspace_env_enabled: true,
            workspace_env: '/tmp/custom-env',
            workspace_sentence: 'A general workspace directory is available at: /tmp/custom-env'
        }) };
    };
    await evaluate('restoreStoredRole()');
    assert.equal(evaluate('cachedConfig.system_prompt_template'), 'Stored role.');
    assert.equal(JSON.parse(roleStore.get('harness.role.v1')).template, 'Stored role.');
    const presets = findId(document.getElementById('configView'), 'theme-presets');
    const editor = findId(document.getElementById('configView'), 'theme-editor');
    assert.ok(presets, 'config view lists themes');
    assert.ok(editor, 'config view lists color fields');
    assert.ok(findId(editor, 'theme-selector-tok-keyword'), 'keyword color has a selector');
    assert.ok(findId(editor, 'theme-color-page'), 'page color has a hex field');
    assert.ok(findId(editor, 'theme-selector-diff-del'), 'removed line has a selector');
    assert.ok(findId(editor, 'theme-selector-diff-add'), 'added line has a selector');
    assert.ok(findId(editor, 'theme-selector-comment-bg'), 'comment highlight has a selector');
    assert.ok(findId(editor, 'theme-selector-comment-text'), 'comment text has a selector');
    assert.ok(findId(editor, 'theme-selector-task-text'), 'task list text has a selector');
    assert.ok(findId(editor, 'theme-selector-task-line'), 'task list line has a selector');
    assert.equal(findId(presets, 'theme-delete-blue-gold'), null);
    assert.equal(findId(presets, 'theme-delete-dark'), null);
    let themeText = '';
    const scanTheme = node => {
        themeText += node.textContent || '';
        for (const child of node.children || []) scanTheme(child);
    };
    scanTheme(presets);
    // Built-in theme names are registry data (their delete-button ids
    // derive from them), so their presence is a data assertion. The
    // labels and help sentences around them are display wording.
    assert.match(themeText, /Blue and gold/);
    assert.match(themeText, /Dark mode/);
    // The long scheme-help paragraph is gone by design: the editor, the
    // preset list, and the save row carry the affordances themselves.
    assert.equal(findId(document.getElementById('configView'), 'theme-help'), null);
    // The editor's per-element selectors were asserted structurally
    // above; the wording in its labels and preview legend is surface.
    const longFn = { name: 'run_cmd', description: 'long' };
    for (let i = 0; i < 20; i++) longFn['field_' + i] = 'value ' + i;
    evaluate('cachedConfig = ' + JSON.stringify({
        model: 'local-test', model_cloud: false, max_tool_rounds: null,
        workspace_dir: '/tmp', custom_files: [], system_prompt: 'prompt',
        enabled_tools: ['ask_user', 'run_cmd'], review_run_cmd: false,
        tools: [
            { function: { name: 'ask_user', description: 'short' } },
            { function: longFn }
        ],
        tool_meta: []
    }) + '; renderConfig()');
    const condensedTools = [];
    const walkCondensed = node => {
        if (!node) return;
        if (String(node.className || '').split(/\s+/).includes('tool-condensed')) condensedTools.push(node);
        for (const child of node.children || []) walkCondensed(child);
    };
    walkCondensed(document.getElementById('configView'));
    assert.equal(condensedTools.length, 0, 'config lists switches without the tool text');
    assert.ok(findId(document.getElementById('configView'), 'toolchk-run_cmd'), 'config has a tool switch');
    assert.equal(findId(document.getElementById('configView'), 'toolchk-ask_user').checked, true);
    const callRun = findId(document.getElementById('configView'), 'callchk-run_cmd');
    const outRun = findId(document.getElementById('configView'), 'outchk-run_cmd');
    assert.equal(callRun.tag, 'select');
    assert.equal(callRun.children[0].textContent, 'Approve only (default)');
    assert.equal(callRun.children[1].textContent, 'Allow all');
    assert.equal(callRun.disabled, false, 'the call menu follows an enabled tool');
    assert.equal(callRun.value, 'approve');
    assert.equal(outRun.disabled, false, 'the output menu is selectable while calls stay on Approve only');
    assert.equal(outRun.value, 'approve');
    assert.equal(findId(document.getElementById('configView'), 'callchk-ask_user').disabled, true);
    assert.equal(findId(document.getElementById('configView'), 'callchk-ask_user').value, 'approve');
    assert.equal(findId(document.getElementById('configView'), 'outchk-ask_user').disabled, true);
    assert.equal(findId(document.getElementById('configView'), 'outchk-ask_user').value, 'approve');
    assert.match(findId(document.getElementById('configView'), 'tool-menu').tag, /table/i);
    const policyPosts = [];
    sandbox.fetch = async (url, options) => {
        const sent = JSON.parse(options.body);
        policyPosts.push(sent);
        assert.equal(url, '/tools');
        assert.ok(sent.enabled.includes('run_cmd'));
        assert.ok(sent.enabled.includes('ask_user'));
        return { ok: true, json: async () => ({ enabled_tools: sent.enabled, approve_calls: sent.approve_calls, approve_outputs: sent.approve_outputs }) };
    };
    outRun.value = 'allow';
    await outRun.onchange();
    assert.deepEqual(policyPosts[0].approve_calls, []);
    assert.deepEqual(policyPosts[0].approve_outputs, ['run_cmd']);
    const outChosen = findId(document.getElementById('configView'), 'outchk-run_cmd');
    assert.equal(outChosen.disabled, false);
    assert.equal(outChosen.value, 'allow');
    const callAllow = findId(document.getElementById('configView'), 'callchk-run_cmd');
    callAllow.value = 'allow';
    await callAllow.onchange();
    assert.deepEqual(policyPosts[1].approve_calls, ['run_cmd']);
    assert.deepEqual(policyPosts[1].approve_outputs, []);
    const outAfter = findId(document.getElementById('configView'), 'outchk-run_cmd');
    assert.equal(outAfter.disabled, true, 'the output menu stays off while calls are Allow all');
    assert.equal(outAfter.value, 'allow');
    assert.equal(findId(document.getElementById('configView'), 'callchk-run_cmd').value, 'allow');
    assert.equal(findId(document.getElementById('configView'), 'callchk-ask_user').disabled, true);
    let configToolText = '';
    const scanTools = node => {
        configToolText += node.textContent || '';
        for (const child of node.children || []) scanTools(child);
    };
    scanTools(document.getElementById('configView'));
    assert.equal(configToolText.includes('field_0'), false);
    // The policy menus themselves were asserted structurally just above
    // (callchk-*/outchk-* with their values); their option labels are
    // display wording.
    evaluate('renderTools()');
    assert.ok(findId(document.getElementById('toolsView'), 'toolcard-run_cmd'), 'tools cards keep their own switch id');
    assert.equal(findId(document.getElementById('toolsView'), 'callcard-run_cmd').value, 'allow');
    assert.equal(findId(document.getElementById('toolsView'), 'outcard-run_cmd').disabled, true);
    assert.equal(findId(document.getElementById('toolsView'), 'outcard-run_cmd').value, 'allow');
    assert.equal(findId(document.getElementById('toolsView'), 'callcard-ask_user').disabled, true);
    assert.equal(findId(document.getElementById('toolsView'), 'callcard-ask_user').value, 'approve');
    assert.equal(findId(document.getElementById('toolsView'), 'toolchk-run_cmd'), null);
    walkCondensed(document.getElementById('toolsView'));
    assert.equal(condensedTools.length, 1, 'a long tool description starts condensed');
    const expandHit = condensedTools[0].children.find(child => String(child.className || '').includes('round-expand-hit'));
    assert.ok(expandHit, 'the condensed description is clickable');
    expandHit.onclick({ preventDefault() {} });
    assert.equal(String(condensedTools[0].className).includes('tool-condensed'), false);
    let condenseLink = null;
    const walkCondense = node => {
        if (!node || condenseLink) return;
        if (node.textContent === 'click to condense') condenseLink = node;
        for (const child of node.children || []) walkCondense(child);
    };
    walkCondense(document.getElementById('toolsView'));
    assert.ok(condenseLink, 'an expanded tool description offers condense');
    assert.equal(condenseLink.style.display, '');
    condenseLink.onclick();
    assert.equal(String(condensedTools[0].className).includes('tool-condensed'), true);
    assert.equal(condenseLink.style.display, 'none');

    // The manual test view lives inside the tools pane now: two inner
    // tabs, registered shown first, and switching swaps the containers.
    // The shared fake DOM adopts the created containers' ids, so the
    // switch and the re-render need no hand binding.
    const toolsView = document.getElementById('toolsView');
    assert.ok(findId(toolsView, 'toolsTabRegistered'), 'the registered inner tab exists');
    assert.ok(findId(toolsView, 'toolsTabTest'), 'the test inner tab exists');
    assert.ok(findId(toolsView, 'toolsRegistered'), 'the registration container is nested in the pane');
    assert.ok(findId(toolsView, 'toolTestView'), 'the test container is nested in the pane');
    assert.equal(findId(toolsView, 'toolTestView').style.display, 'none', 'registered is the default inner tab');
    assert.equal(
        String(findId(toolsView, 'toolsTabRegistered').className).includes('sub-tab-active'),
        true
    );
    // tooltest.js is not loaded in this sandbox; the switch still swaps
    // the containers and the active tab.
    evaluate("showToolPaneTab('test')");
    assert.equal(findId(toolsView, 'toolTestView').style.display, '');
    assert.equal(findId(toolsView, 'toolsRegistered').style.display, 'none');
    assert.equal(
        String(findId(toolsView, 'toolsTabTest').className).includes('sub-tab-active'),
        true
    );
    assert.equal(
        String(findId(toolsView, 'toolsTabRegistered').className).includes('sub-tab-active'),
        false
    );
    // A re-render of the pane rebuilds the containers, and their ids
    // re-adopt, so the remembered inner tab is still found.
    evaluate('renderTools()');
    assert.equal(findId(toolsView, 'toolTestView').style.display, '', 'the pane reopens on its last inner tab');
    evaluate("showToolPaneTab('registered')");
    assert.equal(findId(toolsView, 'toolsRegistered').style.display, '');
    assert.equal(findId(toolsView, 'toolTestView').style.display, 'none');

    const page = fs.readFileSync(__dirname + '/../index.html', 'utf8');
    assert.match(page, /id="creditsBtn"/);
    assert.match(page, /id="creditsView"/);
    // The credits pane is "Inference Providers": each provider name in
    // plain text, a middle dot, and the full billing url slightly
    // muted — the whole "name · url" line one anchor.
    assert.match(page, /Inference Providers/);
    assert.equal(page.includes('>Credits</h3>'), false);
    assert.match(page, /href="https:\/\/ollama\.com\/dashboard"/);
    assert.match(page, />Ollama <span class="provider-url">/);
    assert.match(page, /href="https:\/\/console\.x\.ai\/team\/default\/billing"/);
    assert.match(page, />xAI <span class="provider-url">/);
    assert.match(page, /href="https:\/\/platform\.reflection\.ai\/billing"/);
    assert.match(page, />Reflection <span class="provider-url">/);
    assert.equal(page.includes(' · <span class="provider-url">'), false, 'the middle dot is gone from the provider lines');
    assert.equal(page.includes('add Ollama Pro credits'), false);
    assert.equal(page.includes('add Grok credits'), false);
    assert.equal(page.includes('add Reflection credits'), false);
    assert.match(page, /id="docsBtn"/);
    assert.match(page, /id="docsView"/);
    assert.match(page, /id="toolsBtn"/);
    assert.match(page, /id="toolsView"/);
    // The test tab is an inner tab of the tools pane, not a dashboard
    // button or a top-level view.
    assert.equal(page.includes('id="testBtn"'), false);
    assert.equal(page.includes('id="toolTestView"'), false);
    assert.match(page, /id="savePromptBtn"/);
    assert.match(page, /id="compactPromptBtn"/);
    assert.equal(page.includes('id="copyPromptBtn"'), false);
    assert.match(page, /id="clearPromptBtn"/);
    assert.match(page, /id="restorePromptBtn"/);
    const style = {};
    style.setProperty = (name, value) => { style[name] = value; };
    const root = {
        attrs: {},
        style,
        setAttribute(name, value) { this.attrs[name] = value; },
        removeAttribute(name) { delete this.attrs[name]; }
    };
    document.documentElement = root;
    sandbox.localStorage = {
        store: {},
        getItem(key) { return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null; },
        setItem(key, value) { this.store[key] = String(value); }
    };
    // Dark mode is the harness's resting look: a browser that never
    // chose a theme answers dark, and deleting the active preset
    // returns there.
    assert.equal(evaluate('highlightTheme()'), 'dark');
    evaluate("applyHighlightTheme('dark')");
    assert.equal(root.attrs['data-highlight'], undefined);
    assert.equal(style['--h-tok-keyword'], '#bb55f1');
    assert.equal(style['--h-page'], '#101418');
    assert.equal(style['--h-diff-del'], '#7a303c');
    assert.equal(style['--h-tok-punct'], '#ced4da');
    // The Dark mode preset is the working6 scheme: the fields it retuned
    // from the old dark carry its values, and the ones it kept stay put.
    assert.equal(style['--h-text'], '#c3cdb8');
    assert.equal(style['--h-heading'], '#c3cdb8');
    assert.equal(style['--h-title'], '#c3cdb8');
    assert.equal(style['--h-active'], '#33bbdd');
    assert.equal(style['--h-code-fg'], '#37a8c7');
    assert.equal(style['--h-condense'], '#17233a');
    assert.equal(style['--h-comment-bg'], '#1e5c3a');
    assert.equal(style['--h-comment-text'], '#fffa00');
    assert.equal(style['--h-task-text'], '#aaaa77');
    assert.equal(style['--h-task-line'], '#2a3e50');
    // The Generate button carries its own go-green fields, themed per
    // preset like every other assignment.
    assert.equal(style['--h-generate'], '#287255');
    assert.equal(style['--h-generate-hover'], '#2f8155');
    assert.equal(sandbox.localStorage.getItem('harness.highlight'), 'dark');
    const darkArchive = sandbox.archiveDoc([{ num: 1, prompt: 'colors', data: { totals: { prompt: 0, completion: 0 }, order: [], rounds: {} } }]);
    assert.match(darkArchive, /#bb55f1/);
    assert.match(darkArchive, /#ced4da/);
    assert.match(darkArchive, /#69db7c/);
    assert.match(darkArchive, /#8ce99a/);
    assert.match(darkArchive, /#74c0fc/);
    assert.match(darkArchive, /#0c1014/);
    assert.equal(darkArchive.includes('#d6336c'), false);
    assert.equal(darkArchive.includes('#f8f9fa'), false);
    evaluate("applyHighlightTheme('current')");
    assert.equal(sandbox.highlightTheme(), 'blue-gold');
    assert.equal(style['--h-tok-keyword'], '#e6db74');
    assert.equal(style['--h-generate'], '#2f7a4d');
    const currentArchive = sandbox.archiveDoc([{ num: 1, prompt: 'colors', data: { totals: { prompt: 0, completion: 0 }, order: [], rounds: {} } }]);
    assert.equal(currentArchive.includes('#bb55f1'), false);
    assert.match(currentArchive, /#e6db74/);
    assert.equal(evaluate("setThemeColor('tok-keyword', 'turbo')"), '');
    assert.equal(style['--h-tok-keyword'], '#e6db74');
    assert.equal(evaluate("setThemeColor('tok-keyword', '#112233')"), '#112233');
    assert.equal(sandbox.highlightTheme(), 'custom');
    assert.equal(evaluate("saveThemePreset('Dark mode')"), '');
    assert.match(evaluate("themePresetError('Dark mode')"), /keep their names/);
    assert.equal(evaluate("saveThemePreset('  ')"), '');
    const presetId = evaluate("saveThemePreset('Night reading')");
    assert.match(presetId, /^p[a-z0-9]+$/);
    assert.equal(sandbox.highlightTheme(), presetId);
    assert.equal(evaluate("deleteThemePreset('blue-gold')"), false);
    assert.equal(evaluate("deleteThemePreset('dark')"), false);
    assert.equal(evaluate("deleteThemePreset(" + JSON.stringify(presetId) + ")"), true);
    assert.equal(sandbox.highlightTheme(), 'dark');
    assert.equal(style['--h-tok-keyword'], '#bb55f1');
    sandbox.showApprovalModal({
        approval_id: 'relay', round: 2, name: 'run_sudo_cmd_relay',
        arguments: { command: 'sudo systemctl restart mydaemon', task: 'restarting the daemon' },
        review: { kind: 'relay', command: 'sudo systemctl restart mydaemon', preview: '' }
    });
    assert.match(document.getElementById('approvalTitle').textContent, /Root command/);
    assert.match(document.getElementById('approvalHint').textContent, /will not run this command/);
    assert.equal(document.getElementById('approvalText').style.display, '');
    assert.equal(document.getElementById('approvalText').value, '');
    assert.equal(document.getElementById('webSubmit').style.display, '');
    assert.equal(document.getElementById('webSubmit').textContent, 'Submit output to model');
    assert.equal(document.getElementById('relayCopyBtn').style.display, '');
    // No password field and no root banner: the harness never runs this.
    assert.equal(document.getElementById('approvalAccept').style.display, 'none');
    assert.equal(document.getElementById('approvalRedirect').style.display, 'none');
    evaluate('cachedConfig = ' + JSON.stringify({
        model: 'local-test', model_cloud: false, max_tool_rounds: null,
        workspace_dir: '/tmp', custom_files: [], system_prompt: 'prompt',
        enabled_tools: ['run_sudo_cmd_relay'], review_run_cmd: false,
        approve_calls: [], approve_outputs: [],
        tools: [{ function: { name: 'run_sudo_cmd_relay', description: 'relay' } }],
        tool_meta: []
    }) + '; renderConfig();');
    const relayCalls = findId(document.getElementById('configView'), 'callchk-run_sudo_cmd_relay');
    const relayOuts = findId(document.getElementById('configView'), 'outchk-run_sudo_cmd_relay');
    assert.equal(findId(document.getElementById('configView'), 'toolchk-run_sudo_cmd_relay').checked, true);
    assert.equal(relayCalls.disabled, false);
    assert.equal(relayCalls.value, 'approve');
    assert.equal(relayCalls.children.length, 2, 'Allow all is offered for the relay');
    assert.equal(relayOuts.disabled, false);
    // view_img is always manual: both approval menus stay disabled no
    // matter what the config carries, because every image is shown to
    // the person before any pixels leave this machine.
    evaluate('cachedConfig = ' + JSON.stringify({
        model: 'local-test', model_cloud: false, max_tool_rounds: null,
        workspace_dir: '/tmp', custom_files: [], system_prompt: 'prompt',
        enabled_tools: ['view_img'], review_run_cmd: false,
        approve_calls: [], approve_outputs: [],
        tools: [{ function: { name: 'view_img', description: 'image' } }],
        tool_meta: []
    }) + '; renderConfig();');
    assert.equal(findId(document.getElementById('configView'), 'toolchk-view_img').checked, true);
    assert.equal(findId(document.getElementById('configView'), 'callchk-view_img').disabled, true);
    assert.equal(findId(document.getElementById('configView'), 'outchk-view_img').disabled, true);
    console.log('Approved search and fetch review dialog tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
