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
// Reloads after a save or an agent's edit. Not while inspecting: a refresh would drop what's hovered, pinned or being
// edited, so the page catches up when inspect mode is turned off (or with the Reload button).
let previewStale = false;
function autoReloadPreview(): void {
  if (previewInspecting) previewStale = true;
  else void reloadPreview();
}
async function reloadPreview(): Promise<void> {
  if (!running || !previewPath) return;
  previewStale = false;
  const url = await api.fs.previewUrl(previewPath).catch(() => '');
  if (url) {
    $('#urlText').textContent = previewPath;
    await fadePreview(() => { frame.removeAttribute('srcdoc'); frame.src = `${url}?t=${Date.now()}`; });
  } else {
    // Browser demo: no file URLs, so inline the saved HTML. The page inherits Breeze's CSP, which refuses inline <style>
    // and can't load the project's files, so its own stylesheets are read from the project and attached as constructed
    // sheets (CSP allows those) before it fades in. Its scripts don't run here.
    const html = (await api.fs.readFile(previewPath).catch(() => null))?.text ?? '';
    const page = `http://page/${previewPath}`;
    const links = [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('link[rel~="stylesheet"][href]')]
      .map(l => new URL(l.getAttribute('href') ?? '', page)).filter(u => u.host === 'page'); // not other sites' sheets
    const css = await Promise.all(links.map(u => api.fs.readFile(decodeURIComponent(u.pathname.slice(1))).then(f => f.text ?? '', () => '')));
    css.push('html,body{scrollbar-width:none}::-webkit-scrollbar{display:none}');
    frame.addEventListener('load', () => {
      const win = frame.contentWindow as (Window & typeof globalThis) | null;
      if (!win) return;
      win.document.adoptedStyleSheets = css.map(text => { const s = new win.CSSStyleSheet(); s.replaceSync(text); return s; });
    }, { once: true });
    $('#urlText').textContent = previewPath;
    await fadePreview(() => { frame.srcdoc = html; });
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
function stopPreview(): void { running = false; previewPath = null; renderPreview(); if (document.fullscreenElement) void document.exitFullscreen(); }
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
  if (!on && previewStale) void reloadPreview();
}
inspectBtn.onclick = () => setPreviewInspect(!previewInspecting);
frame.addEventListener('load', sendPreviewInspect);
// A right click in hover mode posts the element under it; Breeze offers to edit it right in the page, show it in the
// source, or ask the agent about it. A click or Escape in the page posts 'dismiss' (Breeze sees no clicks in there).
type InspectedEl = { tag: string; id: string; classes: string[]; text: string; index: number };
type InspectedChange = { from: string; to: string };
// The page sends the element and its ancestors, innermost first, so Breeze can fall back to one the source really has.
const inspectedChain = (v: unknown): InspectedEl[] | null =>
  Array.isArray(v) && v.length && v.every(x => typeof x?.tag === 'string') ? v as InspectedEl[] : null;
let inspectMenuSeq = 0; // the page's number for the menu that's open, 0 when none is
addEventListener('message', e => {
  if (e.source !== frame.contentWindow) return;
  // The page is the user's own code, so what it posts is checked before use.
  const d = e.data as { breezeInspector?: string; seq?: unknown; x?: unknown; y?: unknown; el?: InspectedEl; chain?: unknown; changes?: unknown } | null;
  const kind = d?.breezeInspector;
  if (kind === 'hover-off') setPreviewInspect(false);
  else if (kind === 'dismiss') { if (inspectMenuSeq) closeMenu(); }
  else if (kind === 'escape') { if (document.fullscreenElement) void document.exitFullscreen(); }
  else if (kind === 'undo' || kind === 'redo') queuePreviewEdit(() => stepPreviewEdit(kind === 'undo'));
  else if (kind === 'edit-failed') { toast('Only text changes can be saved from the preview'); void reloadPreview(); }
  else if (kind === 'edit') {
    const chain = inspectedChain(d?.chain);
    const changes = Array.isArray(d?.changes) && d.changes.every(c => typeof c?.from === 'string' && typeof c?.to === 'string') ? d.changes as InspectedChange[] : null;
    if (chain && changes) queuePreviewEdit(() => saveInspectedEdit(chain, changes));
  } else if (kind === 'menu' && typeof d?.seq === 'number' && typeof d.x === 'number' && typeof d.y === 'number' && typeof d.el?.tag === 'string') {
    const el = d.el, chain = inspectedChain(d.chain) ?? [el], seq = d.seq, x = d.x, y = d.y, r = frame.getBoundingClientRect();
    inspectMenuSeq = seq;
    popupMenu(r.left + x, r.top + y, [
      { label: 'Edit Manually', run: () => editInPreview(x, y) },
      { label: 'Show in Source', run: () => void showInspectedSource(chain) },
      { label: 'Ask AI', run: () => askAboutInspected(el) },
    ], () => {
      if (inspectMenuSeq === seq) inspectMenuSeq = 0;
      frame.contentWindow?.postMessage({ breezeInspector: 'menu-closed', seq }, '*');
    });
  }
});
// The page makes the element's text editable where the right click was; focus has to move into the frame first.
function editInPreview(x: number, y: number): void {
  if (!previewPath || !/\.html?$/i.test(previewPath)) { toast('Editing in the preview works on HTML pages'); return; }
  frame.focus();
  frame.contentWindow?.postMessage({ breezeInspector: 'edit', x, y }, '*');
}
// "h1#hero.title": how the element is named in the menu's prompt, matching the label the page draws over it.
function inspectedName(el: InspectedEl): string {
  return el.tag + (el.id ? `#${el.id}` : '') + (Array.isArray(el.classes) ? el.classes.map(c => `.${c}`).join('') : '');
}
// Where the element's opening tag is in the page's source: the tag carrying its id, else the nth tag of its kind.
// shortcut: a text search, not a parse, so a "<div" inside a comment or string can land on the wrong tag; upgrade to a
// source-mapped HTML parse if that bites.
function inspectedOffset(src: string, el: InspectedEl): number {
  if (!/^[a-z][\w-]*$/i.test(el.tag)) return -1;
  let off = -1;
  if (el.id) {
    const id = el.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    off = new RegExp(`<${el.tag}\\b[^>]*\\bid\\s*=\\s*["']?${id}["'\\s>]`, 'i').exec(src)?.index ?? -1;
  }
  if (off < 0 && typeof el.index === 'number' && el.index >= 0) off = [...src.matchAll(new RegExp(`<${el.tag}\\b`, 'gi'))][el.index]?.index ?? -1;
  return off;
}
// The element's content in the source, [after its opening tag, before its closing tag], or null when the tag found
// isn't plausibly it: a page's script can add elements (a text-splitting animation wraps lines in divs), which shifts
// the count, so the tag found must carry every class the source gives it among the element's classes (scripts add
// classes, they rarely remove them). The closing tag is the one that brings same-named tags back to level.
function inspectedRange(src: string, el: InspectedEl): { open: number; start: number; end: number } | null {
  const open = inspectedOffset(src, el);
  if (open < 0) return null;
  const start = src.indexOf('>', open) + 1;
  if (!start) return null;
  const cls = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(src.slice(open, start));
  const have = new Set(Array.isArray(el.classes) ? el.classes : []);
  if ((cls?.[1] ?? cls?.[2] ?? '').split(/\s+/).some(c => c && !have.has(c))) return null;
  const tags = new RegExp(`<(/?)${el.tag}\\b[^>]*>`, 'gi');
  tags.lastIndex = start;
  let depth = 1;
  for (let m = tags.exec(src); m; m = tags.exec(src)) {
    if (m[1]) { if (--depth === 0) return { open, start, end: m.index }; } else if (!m[0].endsWith('/>')) depth++;
  }
  return null;
}
// The first of the element and its ancestors (the page sends them innermost first) that's found in the source.
function findInspectedSource(src: string, chain: InspectedEl[]): Spot | null {
  for (const el of chain) {
    const r = inspectedRange(src, el);
    if (!r) continue;
    const lineStart = src.lastIndexOf('\n', r.open - 1) + 1;
    return { line: src.slice(0, r.open).split('\n').length - 1, col: r.open - lineStart, len: el.tag.length + 1 };
  }
  return null;
}
const escHtmlText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
// The page's source with a text edit made in the preview written into it, or null when it can't be placed. The edit
// goes into the innermost of the element and its ancestors that is found in the source and holds every old text, each
// looked for after the last, as written or with entities (the page saw them decoded). So a line a script wrapped in its
// own div lands in the heading it came from, not in some later element that happens to share the words.
// shortcut: the first ">" ends the opening tag and the first match inside the element is taken as the node, so a ">"
// in an attribute or the same words twice in one element can misplace it; a source-mapped parse fixes both.
function applyInspectedEdit(src: string, chain: InspectedEl[], changes: InspectedChange[]): string | null {
  if (!changes.length || changes.some(c => !c.from)) return null;
  for (const el of chain) {
    const r = inspectedRange(src, el);
    if (!r) continue;
    let out = src, from = r.start, end = r.end, placed = true;
    for (const c of changes) {
      let at = out.indexOf(c.from, from), len = c.from.length;
      if (at < 0 || at + len > end) { const enc = escHtmlText(c.from); at = out.indexOf(enc, from); len = enc.length; }
      if (at < 0 || at + len > end) { placed = false; break; }
      const to = escHtmlText(c.to);
      out = out.slice(0, at) + to + out.slice(at + len);
      from = at + to.length;
      end += to.length - len;
    }
    if (placed) return out;
  }
  return null;
}
// The page's source as the preview edits it: the editor's text when the file is open there, else the file's, with
// Windows line endings read as \n (the page's text nodes have \n, so a multi-line text matches) and put back on write.
async function readPreviewSource(path: string): Promise<{ text: string; crlf: boolean } | null> {
  const open = buffers.get(path);
  if (open?.kind === 'text' && open.ta) return { text: open.text, crlf: false };
  const raw = (await api.fs.readFile(path).catch(() => null))?.text;
  return raw == null ? null : { text: raw.replaceAll('\r\n', '\n'), crlf: raw.includes('\r\n') };
}
// Saves `text` as the page's source. Open in the editor, it goes in as one undoable step there and the file is saved
// (anything else unsaved in it too, as Ctrl+S would); not open, it's written straight to the file. The page reloads
// only when asked (undo/redo); a new edit is already showing in it.
async function writePreviewSource(path: string, src: { text: string; crlf: boolean }, text: string, reload: boolean): Promise<boolean> {
  const open = buffers.get(path);
  if (!(open?.kind === 'text' && open.ta)) {
    try { await api.fs.writeFile(path, src.crlf ? text.replaceAll('\n', '\r\n') : text); } catch (e) { toast(`Couldn't save ${baseName(path)}: ${errMsg(e)}`); return false; }
    if (reload) void reloadPreview();
    return true;
  }
  const old = src.text;
  let s = 0, e = 0;
  while (s < old.length && old[s] === text[s]) s++;
  while (e < old.length - s && e < text.length - s && old[old.length - 1 - e] === text[text.length - 1 - e]) e++;
  replaceRange(open.ta, s, old.length - e, text.slice(s, text.length - e));
  frame.focus(); // replaceRange focuses the editor; the next Ctrl+Z belongs to the preview
  if (!(await saveFile(path))) return false;
  if (reload && previewStale) void reloadPreview(); // the save's own reload waited for inspect mode to end
  return true;
}
// Ctrl+Z / Ctrl+Y in the preview step back and forth through its edits. A step only applies while the file still
// holds what that edit left (or, redoing, what it replaced); a file changed since in some other way drops the history.
type PreviewStep = { path: string; before: string; after: string };
const previewUndo: PreviewStep[] = [], previewRedo: PreviewStep[] = [];
// One at a time: each reads the file the last one wrote, so held-down Ctrl+Z doesn't race itself.
let previewEditQueue: Promise<void> = Promise.resolve();
function queuePreviewEdit(run: () => Promise<void>): void {
  previewEditQueue = previewEditQueue.then(run).catch(e => toast(errMsg(e)));
}
async function saveInspectedEdit(chain: InspectedEl[], changes: InspectedChange[]): Promise<void> {
  const path = previewPath;
  if (!path || !/\.html?$/i.test(path)) return;
  const src = await readPreviewSource(path);
  const next = src && applyInspectedEdit(src.text, chain, changes);
  if (!src || next == null) { toast(`Couldn't find that text in ${baseName(path)}`); void reloadPreview(); return; }
  if (!(await writePreviewSource(path, src, next, false))) { void reloadPreview(); return; }
  previewUndo.push({ path, before: src.text, after: next });
  previewRedo.length = 0;
}
async function stepPreviewEdit(undo: boolean): Promise<void> {
  const from = undo ? previewUndo : previewRedo, to = undo ? previewRedo : previewUndo;
  const step = from.at(-1);
  if (!step) return;
  const src = await readPreviewSource(step.path);
  if (src?.text !== (undo ? step.after : step.before)) {
    previewUndo.length = previewRedo.length = 0;
    toast(`${baseName(step.path)} changed since, so the preview's edits can't be ${undo ? 'undone' : 'redone'}`);
    return;
  }
  from.pop();
  if (await writePreviewSource(step.path, src, undo ? step.before : step.after, true)) to.push(step);
  else from.push(step);
}
async function showInspectedSource(chain: InspectedEl[]): Promise<void> {
  const path = previewPath;
  if (!path) return;
  const b = /\.html?$/i.test(path) ? await loadBuffer(path) : null;
  const at = b ? findInspectedSource(b.text, chain) : null;
  if (b && !at) toast(`Couldn't find that ${chain[0].tag} in ${baseName(path)}`);
  openFile(path, at ?? undefined);
}
function askAboutInspected(el: InspectedEl): void {
  if (!previewPath) return;
  if (!layout.agentsOpen) { layout.agentsOpen = true; applyLayout(); }
  const ta = SURFACES.ide.prompt;
  const snippet = typeof el.text === 'string' && el.text ? ` ("${el.text.slice(0, 60)}${el.text.length > 60 ? '…' : ''}")` : '';
  const before = ta.value.slice(0, ta.selectionStart ?? ta.value.length);
  ta.setRangeText(`${before && !/\s$/.test(before) ? ' ' : ''}In ${previewPath}, the <${inspectedName(el)}> element${snippet}: `, ta.selectionStart ?? ta.value.length, ta.selectionEnd ?? ta.value.length, 'end');
  ta.focus();
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

// Fullscreen: the button makes the window fullscreen and the preview pane cover it (.pane.preview.full). The window,
// not the frame, goes fullscreen so Breeze's menus (the inspector's included) still show over the page. Escape in
// Breeze or in the page (which posts 'escape' when it has nothing of its own to close) leaves it.
const fullBtn = $<HTMLButtonElement>('#previewFull');
function syncPreviewFull(): void {
  const on = !!document.fullscreenElement;
  $('#previewPane').classList.toggle('full', on);
  document.body.classList.toggle('preview-full', on);
  fullBtn.classList.toggle('on', on);
  fullBtn.setAttribute('aria-pressed', String(on));
  fullBtn.title = on ? 'Exit Fullscreen' : 'Fullscreen';
  fullBtn.innerHTML = svgIcon(on ? 'minimize' : 'maximize', 13);
}
fullBtn.onclick = () => void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())
  .catch(e => toast(`Couldn't go fullscreen: ${errMsg(e)}`));
document.addEventListener('fullscreenchange', syncPreviewFull);
addEventListener('keydown', e => { if (e.key === 'Escape' && document.fullscreenElement) void document.exitFullscreen(); });
