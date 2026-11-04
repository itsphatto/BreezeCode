"use strict";
let rootInfo = null;
// True until start-up has tried to reopen the last folder: the panels show placeholders instead of "no folder".
let restoringWorkspace = true;
// Grey bars standing in for a panel's rows while they load, so the panel doesn't flash an empty state first.
const skeletonRows = (n) => `<div class="skel" aria-hidden="true">${Array.from({ length: n }, (_, i) => `<i class="skel-row w${i % 4}"></i>`).join('')}</div>`;
const dirCache = new Map();
const expanded = new Set();
const buffers = new Map();
// Keyed by each surface's hidden input, the element key events and focus land on.
const textareaOwner = new WeakMap();
const surfaceOf = (el) => textareaOwner.get(el)?.ta ?? undefined;
const isDirty = (b) => !!b && b.kind === 'text' && b.text !== b.saved;
// An untitled tab's path sits in a folder no real path can have (Windows names can't hold ':'), so it never meets a
// file's, while its name and extension still pick the icon, the highlighting and the Run button.
const UNTITLED_DIR = ':untitled';
const isUntitled = (p) => !!p && p.startsWith(UNTITLED_DIR);
// A path as the user should read it: an untitled tab is just its name.
const shownPath = (p) => isUntitled(p) ? baseName(p) : p;
let sessionTimer;
let openTabs = [];
let active = null;
// The files agents are editing: the phase (for its colour) and the agent itself (a team has several).
const locks = {};
const added = {};
let ctxPath = null;
async function refreshLiveShare() {
    const button = $('#liveShare');
    const status = await api.live.status().catch(() => null);
    const show = !!rootInfo && !!status?.available;
    const running = !!status?.running;
    button.classList.toggle('hidden', !show);
    button.classList.toggle('live', running);
    button.title = running
        ? `Live Share is running at ${status?.url ?? ''} · Click to turn off`
        : 'Host index.html locally and open it in your browser';
    swapText($('span', button), running ? 'Live Share: on' : 'Live Share');
    void setIcon(button, running ? 'stop' : 'play');
}
async function toggleLiveShare() {
    try {
        const current = await api.live.status().catch(() => null);
        if (current?.running) {
            await api.live.stop();
            await refreshLiveShare();
            toast('Live Share turned off');
            return;
        }
        const live = await api.live.start();
        await refreshLiveShare();
        toast(`Live Share opened at ${live.url}`);
    }
    catch (e) {
        toast(errMsg(e));
    }
}
$('#liveShare').onclick = () => background(toggleLiveShare());
const sessionKey = () => `breeze.session:${rootInfo?.root ?? ''}`;
const hotExitKey = () => `breeze.dirty:${rootInfo?.root ?? ''}`;
function saveSession() {
    if (!rootInfo)
        return;
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(flushSession, 300);
}
function flushSession() {
    if (!rootInfo)
        return;
    clearTimeout(sessionTimer);
    const pos = {};
    // A hidden surface reads scrollTop 0; a restored offset still waiting to be applied is the real one.
    // Untitled tabs have no file to reopen, so they stay out.
    const onDisk = (p) => !!p && !isUntitled(p);
    for (const b of buffers.values())
        if (b.ta && onDisk(b.path))
            pos[b.path] = [b.ta.selectionStart, pendingScroll.get(b) ?? b.ta.scrollTop];
    store.set(sessionKey(), { tabs: openTabs.filter(onDisk), active: onDisk(active) ? active : null, expanded: [...expanded], pos });
    // Hot exit: unsaved edits survive a reload or a crash.
    const dirty = {};
    for (const b of buffers.values())
        if (isDirty(b) && onDisk(b.path))
            dirty[b.path] = b.text;
    if (Object.keys(dirty).length)
        store.set(hotExitKey(), dirty);
    else
        store.del(hotExitKey());
}
window.addEventListener('beforeunload', flushSession);
