/* ----- Loading a workspace: its folders, its files and the tabs from last time ----- */
// Puts back a tab's unsaved text and caret from the last session.
function restoreBuffer(b: EditorBuffer, s: Session, dirty: Record<string, string>): void {
  if (b.kind === 'text' && dirty[b.path] != null) { b.text = dirty[b.path]; if (b.ta) b.ta.value = b.text; }
  const pos = s.pos[b.path];
  if (b.ta && pos) { b.ta.setSelectionRange(pos[0], pos[0]); b.ta.scrollTop = pos[1]; pendingScroll.set(b, pos[1]); }
}
// A hidden (display:none) surface ignores scrollTop, so a restored offset waits until the surface is laid out.
const pendingScroll = new WeakMap<EditorBuffer, number>();
function applyPendingScroll(b: EditorBuffer & { ta: CodeSurface }): void {
  const top = pendingScroll.get(b);
  if (top == null || !b.ta.clientHeight) return;
  b.ta.scrollTop = top;
  pendingScroll.delete(b);
}
async function loadWorkspace(info: RootInfo): Promise<void> {
  if (rootInfo) { flushSession(); resetWorkspace(); }
  rootInfo = info;
  gitLoaded = false;
  loadTreeOrder();
  background(holdStartup(loadNpmScripts()));
  swapText($('#projectName'), info.name);
  $('#projectName').title = info.root;
  document.title = `${info.name} — Breeze Code`;
  const s = store.get<Session>(sessionKey(), { tabs: [], active: null, expanded: [], pos: {} });
  const dirty = store.get<Record<string, string>>(hotExitKey(), {});
  expanded.clear();
  for (const d of s.expanded) expanded.add(d);
  await Promise.all(['', ...s.expanded].map(loadDir));
  renderTree();
  const loaded = await Promise.all(s.tabs.map(loadBuffer));
  for (const b of loaded) {
    if (!b) continue;
    restoreBuffer(b, s, dirty);
    openTabs.push(b.path);
  }
  active = s.active && openTabs.includes(s.active) ? s.active : openTabs[0] ?? null;
  renderTabs(); renderEditor(); renderTree();
  restoreChat(SURFACES.ide);
  renderBoxFolder();
  void refreshLiveShare();
  void holdStartup(refreshGit());
  syncCheckedAt = 0; background(checkCloudNewer());
  term.cwd = await api.term.cwd(); renderPs();
}
function resetWorkspace(): void {
  for (const b of buffers.values()) b.ta?.remove();
  buffers.clear(); dirCache.clear(); expanded.clear();
  treeOrder = {};
  openTabs = []; active = null; rootInfo = null;
  stopPreview();
  swapText($('#projectName'), 'No folder');
  document.title = 'Breeze Code';
  gitState = { repo: false }; gitLog = { head: null, commits: [] };
  renderScm(); renderBranch(); emptyChat();
  void refreshLiveShare();
}

async function loadDir(rel: string): Promise<void> {
  try { dirCache.set(rel, sortDirEntries(rel, await api.fs.readDir(rel))); }
  catch { dirCache.delete(rel); expanded.delete(rel); } // gone or unreadable: show it collapsed
}

function kindOf(r: FileRead): EditorBuffer['kind'] {
  if (r.image) return 'image';
  if (r.video) return 'video';
  if (r.pdf) return 'pdf';
  if (r.binary) return 'binary';
  return r.tooLarge ? 'large' : 'text';
}
async function loadBuffer(path: string): Promise<EditorBuffer | null> {
  const existing = buffers.get(path);
  if (existing) return existing;
  let r: FileRead;
  try { r = await api.fs.readFile(path); } catch (e) { toast(`Couldn't open ${baseName(path)}: ${errMsg(e)}`); return null; }
  const raw = r.text ?? '';
  const b: EditorBuffer = {
    path, size: r.size, kind: kindOf(r),
    eol: raw.includes('\r\n') ? '\r\n' : '\n',
    text: raw.replaceAll('\r\n', '\n'), saved: '', ta: null,
    undo: [], redo: [], lastEdit: null,
  };
  b.saved = b.text;
  if (b.kind === 'image' || b.kind === 'video') b.url = await api.fs.fileUrl(path).catch(() => '');
  if (b.kind === 'pdf') b.url = await api.fs.previewUrl(path).catch(() => ''); // file: frames are blocked by the CSP
  if (b.kind === 'text') { b.ta = createSurface(b); scheduleLint(b, 0); }
  buffers.set(path, b);
  return b;
}

/* ----- Syntax errors for a buffer ----- */
function scheduleLint(b: EditorBuffer, delay = 450): void {
  clearTimeout(b.lintTimer);
  b.lintTimer = setTimeout(() => void lintBuffer(b), delay);
}
// V8 has the final word on JavaScript/TypeScript: it is exact, and clean code clears any false alarm.
// When both find something, the structural messages win on shared lines (they say more). 
function mergeSyntax(diags: Diag[], r: SyntaxResult): Diag[] {
  if (!r) return diags;
  if ('ok' in r) return [];
  if (diags.length && (r.eof || diags.some(d => d.line === r.line))) return diags;
  return [...diags, { line: r.line, col: r.col, len: r.len, msg: r.msg }].sort((x, y) => x.line - y.line);
}
async function lintBuffer(b: EditorBuffer): Promise<void> {
  if (b.kind !== 'text' || buffers.get(b.path) !== b) return;
  const seq = b.lintSeq = (b.lintSeq ?? 0) + 1;
  const text = b.text, ext = extOf(b.path);
  let diags: Diag[] = [];
  if (text.length <= LINT_MAX) {
    diags = toDiags(text, lintStructure(text, b.path));
    if (V8_EXT.has(ext)) {
      const r = await api.lint.check(text, ext).catch(() => null);
      if (seq !== b.lintSeq) return; // a newer check is on its way
      diags = mergeSyntax(diags, r);
    }
  }
  const had = !!b.diags?.length;
  b.diags = diags; b.runDiags = undefined;
  b.diagLines = text.split('\n').length;
  if (had !== !!diags.length) renderTabs();
  if (b.path === active) renderCode();
}

// Each open file keeps its own surface (and history) across tab switches.
function createSurface(b: EditorBuffer): CodeSurface {
  // Measure against the surface's own text: mid-edit it is ahead of b.text (the input handler updates that after).
  // The constructor paints before `ta` is assigned, hence the empty text then.
  let self: CodeSurface | null = null;
  const ta = self = new CodeSurface($('#editor .code'), {
    lineHeight: LINE_H, charWidth: measureChar, pad: { top: 10, left: 4, right: 24, bottom: 10 }, label: `Editing ${b.path}`,
    ...lineMeasurer(hlLines, () => winFirst, () => self?.value ?? ''),
  });
  ta.classList.add('hidden');
  ta.value = b.text;
  textareaOwner.set(ta.input, b);
  ta.addEventListener('beforeinput', e => beforeEdit(b, e as InputEvent));
  ta.addEventListener('input', () => {
    lastUserTypeAt = Date.now();
    const wasDirty = isDirty(b);
    b.text = ta.value;
    if (wasDirty !== isDirty(b)) { renderTabs(); renderTree(); }
    if (b.path === splitPath) renderSplit();
    if (findOpen) runFind(false);
    queueRender(); saveSession(); scheduleLint(b);
    // Suggest words while typing one; any other edit closes the list.
    if (b.lastEdit?.kind === 'type' && Date.now() - b.lastEdit.at < 100) editorSuggest(b); else hideSuggest();
  });
  ta.addEventListener('blur', hideSuggest);
  ta.addEventListener('mousedown', hideSuggest);
  ta.addEventListener('scroll', () => { if (suggest?.owner === ta.input) editorSuggest(b); }); // follow the caret
  ta.addEventListener('scroll', syncScroll);
  ta.addEventListener('keydown', e => editorKeys(e as KeyboardEvent));
  ta.addEventListener('selectionchange', updateCaret); // also fires on focus
  return ta;
}

/* ----- Undo & redo ----- */
// The editor records its own history, so edits made by commands (indent, comment, move line…) undo
// exactly like typing. Typing groups into words; a pause of a second starts a new step.
const GROUPED = new Set(['type', 'deleteContentBackward', 'deleteContentForward']);
// The editor with keyboard focus: the split's pair while its input has focus, otherwise the active file's.
function focusedEditor(): { b: EditorBuffer; ta: CodeSurface } | undefined {
  if (document.activeElement === splitTa.input) {
    const b = splitBuf();
    if (b) return { b, ta: splitTa };
  }
  const b = activeText();
  return b ? { b, ta: b.ta } : undefined;
}
function remember(b: EditorBuffer, kind: string, ta: CodeSurface | null = b.ta): void {
  if (!ta) return;
  const now = Date.now();
  const grouped = GROUPED.has(kind) && b.lastEdit?.kind === kind && now - b.lastEdit.at < 1000;
  b.lastEdit = { kind, at: now };
  if (grouped) return;
  b.undo.push({ text: ta.value, sel: [ta.selectionStart, ta.selectionEnd] });
  // Each step is a copy of the file, so big files keep fewer of them (about 80 MB of history at most).
  const keep = clamp(Math.floor(40_000_000 / Math.max(1, ta.value.length)), 50, 500);
  while (b.undo.length > keep) b.undo.shift();
  b.redo = [];
}
function beforeEdit(b: EditorBuffer, e: InputEvent, ta: CodeSurface | null = b.ta): void {
  if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
    e.preventDefault();
    stepHistory(b, e.inputType === 'historyUndo', ta);
    return;
  }
  const word = e.inputType === 'insertText' && !!e.data && !/\s/.test(e.data);
  remember(b, word ? 'type' : e.inputType, ta);
}
function stepHistory(b: EditorBuffer, back: boolean, ta: CodeSurface | null = b.ta): void {
  const [from, to] = back ? [b.undo, b.redo] : [b.redo, b.undo];
  const snap = from.pop();
  if (!ta || !snap) return;
  to.push({ text: ta.value, sel: [ta.selectionStart, ta.selectionEnd] });
  b.lastEdit = null;
  ta.value = snap.text;
  ta.setSelectionRange(snap.sel[0], snap.sel[1]);
  ta.dispatchEvent(new Event('input'));
  revealOffset(b, snap.sel[0], ta);
}

