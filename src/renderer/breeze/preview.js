"use strict";
/* ================= Preview ================= */
let running = false;
let previewPath = null;
const frame = $('#previewFrame');
// allow-same-origin gives the page its own breeze-preview://project origin (not Breeze's file:// one), so its fonts,
// module scripts, fetch, workers and storage load; with an opaque origin every one of them was refused.
frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock');
frame.setAttribute('allow', 'fullscreen; autoplay; clipboard-read; clipboard-write');
function isHtml(p) { return !!p && /\.html?$/i.test(p); }
// The page Preview opens by default: the open HTML file, else the project's index.html.
function previewTarget() {
    if (isHtml(active))
        return active;
    return (dirCache.get('') ?? []).find(e => !e.dir && /^index\.html?$/i.test(e.name))?.name ?? null;
}
function renderPreview() {
    $('#previewEmpty').classList.toggle('hidden', running);
    frame.classList.toggle('hidden', !running);
    if (!running) {
        $('#urlText').textContent = 'Not running';
        frame.removeAttribute('src');
        frame.removeAttribute('srcdoc');
    }
    renderPreviewEmpty();
}
// With an HTML page in the project, the empty preview offers a button for it instead of a key to remember.
function renderPreviewEmpty() {
    const target = rootInfo ? previewTarget() : null;
    const hint = $('#previewHint');
    hint.innerHTML = target
        ? `<button class="btn btn-primary btn-sm" data-preview-file="1">${svgIcon('play', 12)} Preview ${esc(baseName(target))}</button>`
        : 'Add an <b>index.html</b> to preview it here.';
}
$('#previewEmpty').addEventListener('click', e => {
    if (!e.target.closest('[data-preview-file]'))
        return;
    const target = previewTarget();
    if (target)
        void startPreview(target);
});
async function startPreview(path) {
    // An untitled page is saved (somewhere the user picks) first: the preview loads it from disk.
    const page = path ?? (isHtml(active) ? active : null);
    if (isUntitled(page)) {
        if (!(await saveFile(page)))
            return;
        path = active ?? undefined;
    }
    if (!rootInfo) {
        toast('Open a folder first');
        return;
    }
    const target = path ?? previewTarget();
    if (!target) {
        toast('Add an index.html (or open an .html file) to preview it');
        return;
    }
    previewPath = target;
    if (!running)
        sfx.play('launch');
    running = true;
    layout.previewOpen = true;
    applyLayout();
    renderPreview();
    await reloadPreview();
}
async function reloadPreview() {
    if (!running || !previewPath)
        return;
    const url = await api.fs.previewUrl(previewPath).catch(() => '');
    if (url) {
        $('#urlText').textContent = previewPath;
        frame.removeAttribute('srcdoc');
        frame.src = `${url}?t=${Date.now()}`;
    }
    else {
        // Browser demo: no file URLs, so inline the saved HTML.
        const r = await api.fs.readFile(previewPath).catch(() => null);
        $('#urlText').textContent = previewPath;
        frame.srcdoc = (r?.text ?? '') + '<style>html,body{scrollbar-width:none}::-webkit-scrollbar{display:none}</style>';
    }
}
function stopPreview() { running = false; previewPath = null; renderPreview(); }
// The address bar lists every page in the project; picking one previews it.
async function openPreviewPages() {
    if (!rootInfo) {
        toast('Open a folder first');
        return;
    }
    const pages = (await api.fs.listFiles().catch(() => [])).filter(isHtml).sort();
    if (!pages.length) {
        toast('No HTML pages in this project');
        return;
    }
    openChipMenu($('#previewUrl'), pages.map(p => ({ label: p, checked: () => running && p === previewPath, run: () => void startPreview(p) })));
}
$('#previewUrl').onclick = () => void openPreviewPages();
$('#previewUrl').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    void openPreviewPages();
} };
