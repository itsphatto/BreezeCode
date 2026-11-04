"use strict";
/* Breeze Code — renderer logic.
   Files, search, terminal and agent detection are real in the desktop app (main.js + preload.js).
   Opened in a plain browser, a small in-memory demo project stands in for the disk.
   Agent conversations, checkpoints and collaboration are still simulated.

   The renderer is the files in this folder, one per feature, loaded in order as classic scripts by breeze.html
   (after editcore.js and codeview.js). They share one global scope: no imports or exports. Code that runs while a
   file loads can only use what that file and the ones before it declare; that includes a promise callback (.then, or
   code after an await) started during loading, which can run before the next file does. Event handlers, timers and
   anything run from boot() in init.ts can use every file. This file holds the shared types and helpers. */
/* ================= Helpers ================= */
function $(s, r = document) {
    return r.querySelector(s);
}
function $$(s, r = document) {
    return [...r.querySelectorAll(s)];
}
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const esc = (s) => s.replaceAll(/[&<>]/g, c => ESCAPES[c]);
const escAttr = (s) => esc(s).replaceAll('"', '&quot;');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
const dirName = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const joinPath = (dir, name) => (dir ? `${dir}/${name}` : name);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const forceReflow = (el) => el.offsetWidth;
// IPC errors arrive as "Error invoking remote method 'x': Error: message" — keep only the message.
const errMsg = (e) => {
    const text = e instanceof Error ? e.message : String(e);
    return text.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
};
// Folders first, then names A–Z.
const byDirThenName = (a, b) => {
    if (a.dir !== b.dir)
        return a.dir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
};
function toast(text) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    $('#toastRoot').replaceChildren(t);
    sfx.play('ping');
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 200); }, 2600);
}
// Changes a label's text with a quick fade-in, and lets its box grow or shrink to the new width instead of jumping.
function swapText(el, text) {
    if (el.textContent === text)
        return;
    if (!el.isConnected || matchMedia('(prefers-reduced-motion: reduce)').matches) {
        el.textContent = text;
        return;
    }
    const from = el.getBoundingClientRect().width;
    el.textContent = text;
    el.getAnimations().forEach(a => { if (a.id === 'swap')
        a.cancel(); });
    const fade = el.animate([{ opacity: 0, filter: 'blur(3px)', transform: 'translateY(2px)' }, { opacity: 1, filter: 'blur(0)', transform: 'none' }], { duration: 240, easing: 'cubic-bezier(.2, .8, .2, 1)' });
    fade.id = 'swap';
    const to = el.getBoundingClientRect().width;
    if (Math.abs(from - to) < 1 || getComputedStyle(el).display === 'inline')
        return;
    const { overflow, whiteSpace } = el.style;
    el.style.overflow = 'hidden';
    el.style.whiteSpace = 'nowrap';
    const size = el.animate([{ width: `${from}px` }, { width: `${to}px` }], { duration: 300, easing: 'cubic-bezier(.32, .72, 0, 1)' });
    size.id = 'swap';
    const done = () => { el.style.overflow = overflow; el.style.whiteSpace = whiteSpace; };
    size.onfinish = done;
    size.oncancel = done;
}
// Starts async work without waiting for it; a failure shows as a toast.
function background(work) {
    work.catch(e => toast(errMsg(e)));
}
const store = {
    get(key, fallback) {
        try {
            const v = localStorage.getItem(key);
            return v == null ? fallback : JSON.parse(v);
        }
        catch {
            return fallback;
        }
    },
    set(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        }
        catch { /* storage blocked or full */ }
    },
    del(key) {
        try {
            localStorage.removeItem(key);
        }
        catch { /* storage blocked */ }
    },
};
const THEME_IDS = ['dark', 'contrast', 'light'];
const savedTheme = store.get('breeze.theme', 'dark');
let theme = THEME_IDS.find(t => t === savedTheme) ?? 'dark';
document.documentElement.dataset.theme = theme;
// The big screen changes (the flight to and from Breeze Space, the debugger taking over panel by panel) are opt-in;
// without them screens cross-fade in place.
let bigAnim = store.get('breeze.bigAnim', false) === true;
// The code font size in px (editors, the debugger's source). The line height follows it.
const CODE_SIZE_MIN = 10, CODE_SIZE_MAX = 24, CODE_SIZE_DEFAULT = 13;
let codeSize = clamp(Math.round(Number(store.get('breeze.codeSize', CODE_SIZE_DEFAULT)) || CODE_SIZE_DEFAULT), CODE_SIZE_MIN, CODE_SIZE_MAX);
/* ----- Redrawing lists: only the rows that changed ----- */
// Replacing a whole list (the code window per keystroke, the file tree per file change) makes the browser style
// and lay out every row again. Instead each row keeps the
// html it was drawn from; rows whose html is unchanged stay, new ones are made, and old ones nobody wants go.
// Rows are matched by html in order, so lines that slid up or down (Enter, scrolling) are kept and not redrawn.
const drawnHtml = new WeakMap();
const rowMaker = document.createElement('template');
function patchRows(el, rows) {
    const old = Array.from(el.children);
    const free = new Map(); // html → old row indexes, in order
    old.forEach((n, i) => {
        const h = drawnHtml.get(n);
        if (h !== undefined) {
            const at = free.get(h);
            if (at)
                at.push(i);
            else
                free.set(h, [i]);
        }
    });
    const used = new Set();
    let lastOld = -1;
    const nodes = rows.map(h => {
        const at = free.get(h);
        if (!at?.length)
            return undefined;
        // Prefer the first match after the last row kept, so a run of lines that slid keeps its order.
        let k = at.findIndex(i => i > lastOld);
        if (k < 0)
            k = 0;
        const i = at.splice(k, 1)[0];
        used.add(i);
        lastOld = i;
        return old[i];
    });
    const fresh = rows.filter((_, j) => !nodes[j]);
    if (fresh.length === rows.length) { // nothing to keep: one parse is quickest
        el.innerHTML = rows.join('');
        Array.from(el.children).forEach((n, j) => drawnHtml.set(n, rows[j]));
        return;
    }
    rowMaker.innerHTML = fresh.join('');
    const made = Array.from(rowMaker.content.children);
    let m = 0;
    rows.forEach((h, j) => { if (!nodes[j]) {
        nodes[j] = made[m++];
        drawnHtml.set(nodes[j], h);
    } });
    old.forEach((n, i) => { if (!used.has(i))
        n.remove(); });
    let cur = el.firstElementChild;
    for (const n of nodes) {
        if (n === cur)
            cur = cur.nextElementSibling;
        else
            el.insertBefore(n, cur);
    }
}
// A row changed by hand (the current line's highlight, a folder's chevron) no longer matches its html, so it is never kept.
const forgetRow = (n) => { if (n)
    drawnHtml.delete(n); };
