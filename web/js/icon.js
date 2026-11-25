// icon.js — load after core.js. The mark is the bullet on the Thinking /
// Waiting line. Static while a fresh tab is idle. Thinking (flip) spins
// the triangle on its vertical center axis. A tool call (wheel) rolls it
// clockwise in place. It fades out once the response completes.
// Pointer-events: none. Speeds live on :root in style.css.
//
// Modes: 'think' | 'tool' (busy), 'idle' (resting, static, visible — also
// used for mid-run pauses like approval gates), 'done' (response complete:
// finish the current spin cycle, then fade out).
let activityIconMode = 'idle';
let iconFinishPending = false;      // 'done' requested mid-cycle
let iconFinishTimer = null;
// A real cycle ends on animationiteration. This only runs when that event
// cannot fire. It stays a little past the slower CSS speed so the cycle
// wins when the browser does report it.
function cssDurationMs(value, fallbackMs) {
    const text = String(value || '').trim();
    const n = parseFloat(text);
    if (!isFinite(n) || n <= 0) return fallbackMs;
    return /ms$/i.test(text) ? n : n * 1000;
}
function iconFinishFallbackMs() {
    if (typeof matchMedia === 'function') {
        try {
            if (matchMedia('(prefers-reduced-motion: reduce)').matches) return 400;
        } catch (e) { /* timed fallback */ }
    }
    let y = 2500;
    let wheel = 6000;
    const img = deltaIcon();
    if (img && typeof getComputedStyle === 'function') {
        let cs = null;
        try { cs = getComputedStyle(img); } catch (e) { cs = null; }
        if (cs && cs.getPropertyValue) {
            y = cssDurationMs(cs.getPropertyValue('--y-spin-speed'), y);
            wheel = cssDurationMs(cs.getPropertyValue('--wheel-spin-speed'), wheel);
        }
    }
    return Math.ceil(Math.max(y, wheel)) + 400;
}
function deltaIcon() { return document.getElementById('deltaIcon'); }
function showDeltaIcon() {
    const img = deltaIcon();
    if (!img) return;
    img.classList.remove('icon-hidden');
}
function hideDeltaIcon() {
    const img = deltaIcon();
    if (!img) return;
    img.classList.add('icon-hidden');
}
function notifyRunLane() {
    if (typeof syncRunDock === 'function') syncRunDock();
}
function setActivityIcon(mode) {
    const img = deltaIcon();
    if (!img) {
        notifyRunLane();
        return;
    }
    if (mode === 'done') {
        if (activityIconMode === 'done') {
            notifyRunLane();
            return;
        }
        // If nothing is animating, fade straight away; otherwise finish the
        // cycle in flight, then fade.
        activityIconMode = 'idle';
        iconFinishPending = true;
        clearTimeout(iconFinishTimer);
        iconFinishTimer = setTimeout(finishActivityIcon, iconFinishFallbackMs());
        notifyRunLane();
        return;
    }
    if (mode === 'idle') {
        // Mid-run pause (approval gate, waiting for the user): static but
        // visible. Does not arm the fade — a resumed run needs the icon.
        activityIconMode = 'idle';
        iconFinishPending = false;
        clearTimeout(iconFinishTimer);
        iconFinishTimer = null;
        showDeltaIcon();
        if (img) img.classList.remove('flip', 'wheel');
        notifyRunLane();
        return;
    }
    // Fresh activity supersedes any pending finish; make the icon visible.
    showDeltaIcon();
    iconFinishPending = false;
    clearTimeout(iconFinishTimer);
    iconFinishTimer = null;
    if (activityIconMode === mode) {
        notifyRunLane();
        return;
    }
    activityIconMode = mode;
    img.classList.remove('flip', 'wheel');
    img.classList.add(mode === 'tool' ? 'wheel' : 'flip');
    notifyRunLane();
}
function finishActivityIcon() {
    iconFinishPending = false;
    clearTimeout(iconFinishTimer);
    iconFinishTimer = null;
    if (activityIconMode !== 'idle') return; // new activity started mid-cycle
    const img = deltaIcon();
    if (img) img.classList.remove('flip', 'wheel');
    hideDeltaIcon();
}
// Called from tabs.js renderTabBar(): the active tab's lifecycle decides
// the icon's resting visibility. Fresh tabs keep it visible (the chain
// does work), spent tabs let it expire to invisible.
function syncActivityIcon() {
    const img = deltaIcon();
    if (!img) return;
    if (typeof runningSid !== 'undefined' && runningSid !== null) {
        showDeltaIcon(); // busy state owns the icon; mode comes from events
        return;
    }
    if (iconFinishPending) {
        // A just-finished chain in this tab is winding down its cycle;
        // finishActivityIcon will hide it — don't resurrect or double-fade.
        return;
    }
    const s = typeof activeSession === 'function' ? activeSession() : null;
    if (s && (s.status === 'done' || s.status === 'error')) {
        hideDeltaIcon();
    } else {
        showDeltaIcon();
    }
}
(function wireActivityIcon() {
    const img = deltaIcon();
    if (!img || !img.addEventListener) return;
    img.addEventListener('animationiteration', () => {
        if (iconFinishPending) finishActivityIcon();
    });
})();
