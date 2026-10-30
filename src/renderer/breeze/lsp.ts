/* ================= Language servers ================= */
// Completions, hover, go to definition, find references and rename, from the file's language server (main/lsp.js).
const lspOn = new Set<string>();          // open files whose server is running
const lspTimers = new Map<string, TimeoutId>();
const lspHinted = new Set<string>();      // install hints already shown, by command
let lspAsk = 0;                           // the newest completion request; older answers are dropped

async function lspOpen(b: EditorBuffer): Promise<void> {
  if (b.kind !== 'text') return;
  const r = await api.lsp.open(b.path, b.text).catch(() => ({ available: false }) as LspOpen);
  if (!buffers.has(b.path)) { void api.lsp.close(b.path); return; } // closed while the server started
  if (r.available) { lspOn.add(b.path); return; }
  if (r.install && !lspHinted.has(r.install)) {
    lspHinted.add(r.install);
    toast(`For autocomplete and go to definition in .${extOf(b.path)} files, install a language server: ${r.install}`);
  }
}
// The server gets the whole text, a moment after typing stops.
function lspChanged(b: EditorBuffer): void {
  if (!lspOn.has(b.path)) return;
  clearTimeout(lspTimers.get(b.path));
  lspTimers.set(b.path, setTimeout(() => { lspTimers.delete(b.path); void api.lsp.change(b.path, b.text); }, 150));
}
// Before asking anything, the server must have what's on screen.
async function lspFlush(b: EditorBuffer): Promise<void> {
  if (!lspTimers.has(b.path)) return;
  clearTimeout(lspTimers.get(b.path));
  lspTimers.delete(b.path);
  await api.lsp.change(b.path, b.text).catch(() => undefined);
}
function lspClosed(path: string): void {
  clearTimeout(lspTimers.get(path));
  lspTimers.delete(path);
  if (lspOn.delete(path)) void api.lsp.close(path);
}
function lspRenamed(from: string, b: EditorBuffer): void {
  lspClosed(from);
  void lspOpen(b);
}
// Offsets ↔ LSP positions (line and UTF-16 column, which is what JavaScript strings count).
const lspPosOf = (text: string, off: number) => ({ line: lineAt(text, off), ch: off - lineStart(text, off) });

/* ----- Completions, merged into the editor's word list ----- */
// LSP CompletionItemKind, shown as the hint.
const LSP_KINDS = ['', 'text', 'method', 'function', 'constructor', 'field', 'variable', 'class', 'interface', 'module', 'property', 'unit', 'value', 'enum', 'keyword', 'snippet', 'color', 'file', 'reference', 'folder', 'enum member', 'constant', 'struct', 'event', 'operator', 'type'];
async function lspCompletions(b: EditorBuffer, pos: number, prefix: string): Promise<Suggestion[]> {
  await lspFlush(b);
  const p = lspPosOf(b.text, pos);
  const items = await api.lsp.completion(b.path, p.line, p.ch).catch(() => [] as LspCompletion[]);
  const low = prefix.toLowerCase();
  return items
    .filter(i => i.filter.toLowerCase().startsWith(low) && i.insert !== prefix)
    .sort((a, c) => Number(c.filter.startsWith(prefix)) - Number(a.filter.startsWith(prefix)) || a.sort.localeCompare(c.sort))
    .slice(0, 12)
    .map(i => ({
      text: i.label, hint: LSP_KINDS[i.kind] ?? '', insert: i.insert,
      from: i.from ? offsetOf(b.text, i.from.line, i.from.character) : undefined,
    }));
}

/* ----- Hover: the type and docs of what the mouse rests on ----- */
const hoverEl = document.createElement('div');
hoverEl.className = 'lsp-hover hidden';
hoverEl.setAttribute('role', 'tooltip');
document.body.append(hoverEl);
let hoverTimer: TimeoutId | undefined;
let hoverPoint: { x: number; y: number } | null = null;
function hideHover(): void {
  clearTimeout(hoverTimer);
  hoverPoint = null;
  hoverEl.classList.add('hidden');
}
async function showHover(x: number, y: number): Promise<void> {
  const b = activeText();
  if (!b || !lspOn.has(b.path) || suggest) return;
  const off = b.ta.offsetAt(x, y);
  if (!/[\w$]/.test(b.text[off] ?? '')) return;
  await lspFlush(b);
  const p = lspPosOf(b.text, off);
  const text = await api.lsp.hover(b.path, p.line, p.ch).catch(() => null);
  if (!text || activeText() !== b) return;
  hoverEl.textContent = text;
  hoverEl.classList.remove('hidden');
  hoverPoint = { x, y };
  const h = hoverEl.offsetHeight, w = hoverEl.offsetWidth;
  hoverEl.style.left = `${Math.max(8, Math.min(x - 8, innerWidth - w - 8))}px`;
  hoverEl.style.top = `${y - h - 10 > 8 ? y - h - 10 : y + 18}px`;
}
const editorCode = $('#editor .code');
editorCode.addEventListener('mousemove', e => {
  clearTimeout(hoverTimer);
  if (hoverPoint && Math.hypot(e.clientX - hoverPoint.x, e.clientY - hoverPoint.y) > 24) hideHover();
  if (e.buttons) return; // selecting
  hoverTimer = setTimeout(() => void showHover(e.clientX, e.clientY), 500);
});
editorCode.addEventListener('mouseleave', hideHover);
editorCode.addEventListener('keydown', hideHover, true);
editorCode.addEventListener('wheel', hideHover, { passive: true });
// Ctrl+click goes to the definition, like F12.
editorCode.addEventListener('click', e => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
  const b = activeText();
  if (b && lspOn.has(b.path)) void goToDefinition(b, b.ta.offsetAt(e.clientX, e.clientY));
});

/* ----- Go to definition, find references ----- */
// The symbol at the caret of the focused editor, when its server is running (a toast says why not otherwise).
function lspTarget(): { b: EditorBuffer & { ta: CodeSurface }; off: number } | null {
  const b = activeText();
  if (!b) { toast('Open a file first'); return null; }
  if (!lspOn.has(b.path)) { toast(`No language server for .${extOf(b.path)} files`); return null; }
  return { b, off: b.ta.selectionStart };
}
function openLocation(l: LspLocation): void {
  if (!l.path) { toast(`Defined in ${baseName(l.file)}, outside this folder`); return; }
  openFile(l.path, { line: l.line, col: l.col, len: l.len });
}
async function goToDefinition(b: EditorBuffer, off: number): Promise<void> {
  hideHover();
  await lspFlush(b);
  const p = lspPosOf(b.text, off);
  let defs: LspLocation[];
  try { defs = await api.lsp.definition(b.path, p.line, p.ch); } catch (e) { toast(errMsg(e)); return; }
  if (!defs.length) { toast('No definition found'); return; }
  openLocation(defs[0]);
}
async function findReferences(): Promise<void> {
  const t = lspTarget();
  if (!t) return;
  await lspFlush(t.b);
  const p = lspPosOf(t.b.text, t.off);
  let refs: LspLocation[];
  try { refs = await api.lsp.references(t.b.path, p.line, p.ch); } catch (e) { toast(errMsg(e)); return; }
  if (!refs.length) { toast('No references found'); return; }
  const rows = refs.map((r, i) => `<div class="qo-item" data-i="${i}"><span>${fileIcon(baseName(r.path ?? ''))}&nbsp; ${esc(baseName(r.path ?? ''))}<small>:${r.line + 1}</small></span><small class="ref-text">${esc((r.text ?? '').trim())}</small></div>`);
  openModal(`<h3>${plural(refs.length, 'reference')}</h3><div class="qo-list">${rows.join('')}</div>`, m => {
    $$('[data-i]', m).forEach(el => el.onclick = () => { closeModal(); openLocation(refs[Number(el.dataset.i)]); });
  }, undefined, 'top');
}

/* ----- Rename symbol ----- */
function renameSymbol(): void {
  const t = lspTarget();
  if (!t) return;
  const [ws, we] = wordAt(t.b.text, t.off);
  const old = t.b.text.slice(ws, we);
  if (!old) { toast('Put the caret on a name to rename it'); return; }
  openModal(`<input class="input w-full" id="renIn" aria-label="New name" value="${escAttr(old)}" spellcheck="false">`, m => {
    const input = $<HTMLInputElement>('#renIn', m);
    input.focus(); input.select();
    input.onkeydown = e => {
      if (e.key !== 'Enter') return;
      const name = input.value.trim();
      closeModal();
      if (name && name !== old) void doRename(t.b, ws, name);
    };
  }, undefined, 'top');
}
async function doRename(b: EditorBuffer, off: number, name: string): Promise<void> {
  await lspFlush(b);
  const p = lspPosOf(b.text, off);
  let edits: Record<string, LspEdit[]>;
  try { edits = await api.lsp.rename(b.path, p.line, p.ch, name); } catch (e) { toast(errMsg(e)); return; }
  const files = Object.keys(edits);
  if (!files.length) { toast("That can't be renamed"); return; }
  let count = 0;
  for (const path of files) {
    count += edits[path].length;
    const open = buffers.get(path);
    // Open files change in the editor (one undo step each, saved by the user); the rest are written to disk.
    if (open?.kind === 'text' && open.ta) {
      const caret = open.ta.selectionStart;
      replaceRange(open.ta, 0, open.text.length, applyEdits(open.text, edits[path]), caret);
      continue;
    }
    try {
      const r = await api.fs.readFile(path);
      if (r.text == null) continue;
      await api.fs.writeFile(path, applyEdits(r.text, edits[path]));
    } catch (e) { toast(`Couldn't rename in ${baseName(path)}: ${errMsg(e)}`); }
  }
  b.ta?.focus();
  toast(`Renamed ${plural(count, 'place')} in ${plural(files.length, 'file')}`);
}
// Applies LSP edits (line/column ranges) to a text, last first so earlier offsets stay right.
function applyEdits(text: string, edits: LspEdit[]): string {
  const starts = lineStartsOf(text);
  const at = (pos: { line: number; character: number }) => Math.min(text.length, (starts[pos.line] ?? text.length) + pos.character);
  const sorted = edits.map(e => ({ s: at(e.start), e: at(e.end), t: e.text })).sort((a, c) => c.s - a.s);
  let out = text;
  for (const e of sorted) out = out.slice(0, e.s) + e.t + out.slice(e.e);
  return out;
}

commands['go.definition'] = () => { const t = lspTarget(); if (t) void goToDefinition(t.b, t.off); };
commands['go.references'] = () => void findReferences();
commands['go.rename'] = renameSymbol;
