// boot.js — load last. Keybindings and startup: prefetch registration,
// restore tabs (or create the first), sync the prompt box.
document.getElementById('prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generate();
});
// Static chrome buttons (created in markup, not by renderTabBar).
// These are wired here rather than as inline onclick attributes so the
// page can use a strict nonce-based script-src policy.
document.getElementById('configBtn').onclick = () => showConfig();
document.getElementById('docsBtn').onclick = () => showDocs();
document.getElementById('toolsBtn').onclick = () => showTools();
document.getElementById('workBtn').onclick = () => {
    if (workActive) closeWork();
    else showWork();
};
document.getElementById('decisionBtn').onclick = () => showDecision();
document.getElementById('memoryBtn').onclick = () => showMemory();
document.getElementById('creditsBtn').onclick = () => showCredits();
document.getElementById('historyBtn').onclick = () => {
    if (historyActive) goBackToSession();
    else showHistory();
};
document.getElementById('promptEditBtn').onclick = () => setPromptExpanded(!promptExpanded);
document.getElementById('newSessionBtn').onclick = () => newSession();
document.getElementById('runBtn').onclick = () => generate();
document.getElementById('newTabBtn').onclick = () => newTab();

// ---------- boot ----------
(function boot() {
    if (typeof applyHighlightTheme === 'function') applyHighlightTheme();
    // Prefetch registration for exports (config tab reuses the cache)
    // and show the history banner when recording is unavailable.
    // The interrupted-run note waits until that refresh has decided
    // whether the recording banner owns the same element.
    const configReady = refreshConfig();
    try { storeEnabled = document.getElementById('storeToggle').checked; } catch (e) {}
    let restored = false;
    const resumeTabs = storeEnabled && typeof sameTabResume === 'function'
        && sameTabResume(typeof HARNESS_TOKEN === 'string' ? HARNESS_TOKEN : '');
    if (resumeTabs) { try { restored = restore(); } catch (e) { restored = false; } }
    if (restored && typeof rehydrateStoredTools === 'function') rehydrateStoredTools();
    if (!restored) createSession();
    else { exportDirty = hasContent(); renderTabBar(); }
    // A wide screen opens in the side-by-side editor. A narrow screen
    // stays compact until prompt edit is used.
    if (typeof promptLaneWide === 'function' && promptLaneWide() && runningSid === null && !promptExpanded && !promptCollapseChosen) {
        setPromptExpanded(true);
    }
    syncPromptUI();
    refreshPromptBox();
    if (typeof noteInterruptedRun === 'function' && configReady && typeof configReady.then === 'function') {
        configReady.then(() => noteInterruptedRun());
    }
})();
