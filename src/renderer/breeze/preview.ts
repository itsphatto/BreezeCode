/* ================= Preview ================= */
let running = false;
let previewPath: string | null = null;
const frame = $<HTMLIFrameElement>('#previewFrame');
// allow-same-origin gives the page its own breeze-preview://project origin (not Breeze's file:// one), so its fonts,
// module scripts, fetch, workers and storage load; with an opaque origin every one of them was refused.
frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock');
frame.setAttribute('allow', 'fullscreen; autoplay; clipboard-read; clipboard-write');
// What the preview can show: a page, or a Markdown file rendered (previewServer.js).
function isPage(p: string | null): p is string { return !!p && /\.(html?|md|markdown)$/i.test(p); }
// The page Preview opens by default: the open HTML or Markdown file, else the project's index.html.
function previewTarget(): string | null {
  if (isPage(active)) return active;
  return (dirCache.get('') ?? []).find(e => !e.dir && /^index\.html?$/i.test(e.name))?.name ?? null;
}
function renderPreview(): void {
  $('#previewEmpty').classList.toggle('hidden', running);
  frame.classList.toggle('hidden', !running);
  if (!running) { $('#urlText').textContent = 'Not running'; frame.removeAttribute('src'); frame.removeAttribute('srcdoc'); }
  renderPreviewEmpty();
}
// With an HTML page in the project, the empty preview offers a button for it instead of a key to remember.
function renderPreviewEmpty(): void {
  const target = rootInfo ? previewTarget() : null;
  const hint = $('#previewHint');
  hint.innerHTML = target
    ? `<button class="btn btn-primary btn-sm" data-preview-file="1">${svgIcon('play', 12)} Preview ${esc(baseName(target))}</button>`
    : 'Add an <b>index.html</b> to preview it here.';
}
$('#previewEmpty').addEventListener('click', e => {
  if (!(e.target as HTMLElement).closest('[data-preview-file]')) return;
  const target = previewTarget();
  if (target) void startPreview(target);
});
async function startPreview(path?: string): Promise<void> {
  // An untitled page is saved (somewhere the user picks) first: the preview loads it from disk.
  const page = path ?? (isPage(active) ? active : null);
  if (isUntitled(page)) {
    if (!(await saveFile(page))) return;
    path = active ?? undefined;
  }
  if (!rootInfo) { toast('Open a folder first'); return; }
  const target = path ?? previewTarget();
  if (!target) { toast('Add an index.html (or open an .html or .md file) to preview it'); return; }
  previewPath = target;
  if (!running) sfx.play('launch');
  running = true;
  layout.previewOpen = true; applyLayout();
  renderPreview();
  await reloadPreview();
}
async function reloadPreview(): Promise<void> {
  if (!running || !previewPath) return;
  const url = await api.fs.previewUrl(previewPath).catch(() => '');
  if (url) {
    $('#urlText').textContent = previewPath;
    await fadePreview(() => { frame.removeAttribute('srcdoc'); frame.src = `${url}?t=${Date.now()}`; });
  } else {
    // Browser demo: no file URLs, so inline the saved HTML.
    const r = await api.fs.readFile(previewPath).catch(() => null);
    $('#urlText').textContent = previewPath;
    await fadePreview(() => { frame.srcdoc = (r?.text ?? '') + '<style>html,body{scrollbar-width:none}::-webkit-scrollbar{display:none}</style>'; });
  }
}
// Another page, or the same one refreshed, fades: the old one out, then the new one in once it has loaded (or after
// PREVIEW_FADE_WAIT, for a page that never finishes loading). A newer reload takes over from one still fading.
const PREVIEW_FADE_WAIT = 3000;
let previewFadeGen = 0;
async function fadePreview(load: () => void): Promise<void> {
  const gen = ++previewFadeGen;
  frame.getAnimations().forEach(a => a.cancel());
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || frame.classList.contains('hidden')) { load(); return; }
  // A frame with nothing in it yet (the preview just started) has nothing to fade out.
  if (frame.getAttribute('src') || frame.hasAttribute('srcdoc')) {
    const out = frame.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 130, easing: 'ease-in', fill: 'forwards' });
    await out.finished.catch(() => {});
    if (gen !== previewFadeGen) return;
  } else frame.style.opacity = '0';
  let shown = false;
  const show = () => {
    if (shown || gen !== previewFadeGen) return;
    shown = true;
    frame.getAnimations().forEach(a => a.cancel());
    frame.style.opacity = '';
    frame.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
  };
  frame.addEventListener('load', show, { once: true });
  setTimeout(show, PREVIEW_FADE_WAIT);
  load();
}
function stopPreview(): void { running = false; previewPath = null; renderPreview(); }
// The address bar lists every page in the project; picking one previews it.
async function openPreviewPages(): Promise<void> {
  if (!rootInfo) { toast('Open a folder first'); return; }
  const pages = (await api.fs.listFiles().catch(() => [] as string[])).filter(isPage).sort();
  if (!pages.length) { toast('No HTML or Markdown pages in this project'); return; }
  openChipMenu($('#previewUrl'), pages.map(p => ({ label: p, checked: () => running && p === previewPath, run: () => void startPreview(p) })));
}
$('#previewUrl').onclick = () => void openPreviewPages();
$('#previewUrl').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void openPreviewPages(); } };


// Inspect on hover: the mouse button outlines whatever element the cursor is over in the preview, with its tag, id,
// classes and size (previewInspector.js draws it inside the page). The page can't be reached directly, so the state
// is posted to it, and posted again each time a page loads; Escape in the page turns it off and posts that back.
let previewInspecting = false;
const inspectBtn = $<HTMLButtonElement>('#previewInspect');
function sendPreviewInspect(): void {
  frame.contentWindow?.postMessage({ breezeInspector: 'hover', on: previewInspecting }, '*');
}
function setPreviewInspect(on: boolean): void {
  previewInspecting = on;
  inspectBtn.classList.toggle('on', on);
  inspectBtn.setAttribute('aria-pressed', String(on));
  sendPreviewInspect();
}
inspectBtn.onclick = () => setPreviewInspect(!previewInspecting);
frame.addEventListener('load', sendPreviewInspect);
addEventListener('message', e => {
  if (e.source === frame.contentWindow && (e.data as { breezeInspector?: string } | null)?.breezeInspector === 'hover-off') setPreviewInspect(false);
});
