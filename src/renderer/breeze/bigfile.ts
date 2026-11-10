/* ================= Huge files: tabs over the engine's documents ================= */
// A text file above the read limit ('large') opens in the Rust engine (main.js "doc:" channels) and shows as a
// BigSurface (bigsurface.ts) in #bigHost, over the code view. The page never holds its text: saving, finding and
// reloading all go through the engine by document id. Loaded before editor.ts: nothing here runs editor.ts code at
// load time, only from events.
const bigHost = $('#bigHost');
// Bumped by every open of a buffer (and by closing it): a reply to an older open is dropped.
const bigOpens = new WeakMap<EditorBuffer, number>();
const nextBigOpen = (b: EditorBuffer) => { const n = (bigOpens.get(b) ?? 0) + 1; bigOpens.set(b, n); return n; };
// Buffers already told they can't be edited (the toast comes once each).
const bigWarned = new WeakSet<EditorBuffer>();
let bigCountSeq = 0;
// The find count waits for typing to pause (it can scan hundreds of megabytes); `bigCountDone` ends a superseded wait.
let bigCountTimer: TimeoutId | undefined;
let bigCountDone: (() => void) | null = null;
// The buffer last shown in #bigHost, so a switch between huge files counts the open search again.
let bigShown: EditorBuffer | undefined;

const activeBig = (): EditorBuffer | undefined => { const b = activeBuf(); return b?.big ? b : undefined; };

// The engine's latest word on a document; the tab's unsaved dot follows `dirty`.
function bigState(b: EditorBuffer, big: BigDoc, r: DocState): void {
  const flipped = big.dirty !== r.dirty;
  big.dirty = r.dirty;
  big.lines = r.lines;
  if (flipped) { renderTabs(); renderTree(); }
}

async function openBig(b: EditorBuffer): Promise<void> {
  const seq = nextBigOpen(b);
  let r: DocOpen;
  try { r = await api.doc.open(b.path); } catch (e) { b.bigError = errMsg(e); return; }
  if (bigOpens.get(b) !== seq) { void api.doc.close(r.doc).catch(() => {}); return; }
  // The source reads big.doc on every call, so a reopen (see api.doc.onDown) only has to change the id.
  const big = { doc: r.doc, readOnly: r.readOnly, dirty: r.dirty, lines: r.lines, changedOnDisk: false } as BigDoc;
  const src: BigSource = {
    lines: (first, count) => api.doc.lines(big.doc, first, count),
    edit: (start, end, text, kind) => api.doc.edit(big.doc, start, end, text, kind),
    undo: () => api.doc.undo(big.doc),
    redo: () => api.doc.redo(big.doc),
    text: async (start, end) => (await api.doc.text(big.doc, start, end)).text,
  };
  const s = big.surface = new BigSurface(bigHost, src, {
    lineHeight: () => LINE_H, charWidth: measureChar, tabSize: 4, label: `Editing ${b.path}`,
    readOnly: r.readOnly, lines: r.lines, rev: r.rev,
  });
  s.root.classList.add('hidden'); // showBig shows it while its tab is active
  s.addEventListener('change', e => { if (b.big === big) bigState(b, big, (e as CustomEvent<DocState>).detail); });
  s.addEventListener('selectionchange', () => { if (b.path === active && b.big === big) updateStatus(); });
  s.addEventListener('readonly', () => {
    if (bigWarned.has(b)) return;
    bigWarned.add(b);
    toast('This file isn\'t valid UTF-8, so it can\'t be edited here');
  });
  s.addEventListener('error', e => toast(errMsg((e as CustomEvent<string>).detail)));
  b.eol = r.eol;
  b.bigError = undefined;
  b.big = big;
  // Only a first open says so: after an engine restart the edits were never gone from the screen.
  if (r.recovered) toast(`Restored unsaved edits to ${baseName(b.path)}`);
}

// Shows the active buffer's surface (and only that one); true when the active buffer is a huge file.
function showBig(b: EditorBuffer | undefined): boolean {
  const shown = !!b?.big;
  bigHost.classList.toggle('hidden', !shown);
  for (const x of buffers.values()) x.big?.surface.root.classList.toggle('hidden', x !== b);
  // The find bar works one way for huge files (#findToggle hidden) and another for the rest: a switch between the two
  // closes it, and a switch to another huge file counts its search there.
  if (findOpen && $('#findToggle').classList.contains('hidden') !== shown) closeFind();
  else if (shown && findOpen && bigShown !== b) void bigFindCount(b!);
  bigShown = shown ? b : undefined;
  return shown;
}

async function saveBig(b: EditorBuffer): Promise<boolean> {
  const big = b.big;
  if (!big) return false;
  if (big.changedOnDisk) {
    const choice = await askDiskConflict(b);
    if (choice === 'reload') { await reloadBig(b, big); return false; }
    if (choice !== 'overwrite') return false;
  }
  let r: DocState & { bytes: number };
  try { r = await api.doc.save(big.doc); } catch (e) { toast(`Couldn't save ${baseName(b.path)}: ${errMsg(e)}`); return false; }
  if (b.big !== big) return false; // the engine went down meanwhile and the reopen failed
  bigState(b, big, r); // an edit made during a long save keeps the unsaved dot
  big.changedOnDisk = false;
  b.size = r.bytes;
  renderTabs(); renderTree(); flushSession();
  if (b.path === active) updateStatus();
  return true;
}

// Takes the file as it is on disk, dropping the unsaved edits.
async function reloadBig(b: EditorBuffer, big: BigDoc): Promise<void> {
  let r: DocOpen;
  try { r = await api.doc.reload(big.doc); } catch (e) { toast(`Couldn't reload ${baseName(b.path)}: ${errMsg(e)}`); return; }
  if (b.big !== big) return;
  big.changedOnDisk = false;
  b.size = r.bytes;
  b.eol = r.eol;
  bigState(b, big, r);
  await big.surface.reset(r);
  if (b.path === active) updateStatus();
}

function closeBig(b: EditorBuffer): void {
  const big = b.big;
  if (!big) return;
  nextBigOpen(b); // a reopen still on its way is dropped (and closes what it opened)
  big.surface.remove();
  void api.doc.close(big.doc).catch(() => {});
}

// Enter / Shift+Enter in the find bar: the next match after the selection, or the one before it.
async function bigFindStep(b: EditorBuffer, dir: 1 | -1): Promise<void> {
  const big = b.big, q = findInput.value;
  if (!big || !q) return;
  const { anchor, head } = big.surface.selection;
  const from = dir === 1 ? posMax(anchor, head) : posMin(anchor, head);
  let r: DocState & { hit: (DocPos & { len: number }) | null };
  try { r = await api.doc.find(big.doc, q, findCase, from, dir === -1); } catch (e) { toast(errMsg(e)); return; }
  if (b.big !== big || findInput.value !== q) return; // typed on meanwhile: that search counts, not this one
  if (!r.hit) { $('#findCount').textContent = 'No results'; return; }
  const start = { line: r.hit.line, col: r.hit.col };
  big.surface.setSelection(start, { line: r.hit.line, col: r.hit.col + r.hit.len });
  await big.surface.reveal(start);
}

// The count beside the find field (the engine stops counting at 9,999), 200 ms after the last call.
function bigFindCount(b: EditorBuffer): Promise<void> {
  const seq = ++bigCountSeq;
  clearTimeout(bigCountTimer);
  bigCountDone?.();
  bigCountDone = null;
  if (!b.big || !findInput.value) { $('#findCount').textContent = ''; return Promise.resolve(); }
  return new Promise(done => {
    bigCountDone = done;
    bigCountTimer = setTimeout(() => { bigCountDone = null; void bigCountNow(b, seq).then(done); }, 200);
  });
}
async function bigCountNow(b: EditorBuffer, seq: number): Promise<void> {
  const big = b.big, q = findInput.value, out = $('#findCount');
  if (!big || !q) { out.textContent = ''; return; }
  let r: DocState & { count: number; capped: boolean };
  try { r = await api.doc.count(big.doc, q, findCase); } catch (e) { if (seq === bigCountSeq) toast(errMsg(e)); return; }
  if (seq !== bigCountSeq) return; // a newer query (or file) is being counted
  out.textContent = r.capped ? '9999+ results' : r.count ? `${r.count} results` : 'No results';
}

function bigGoToLine(b: EditorBuffer): void {
  const big = b.big;
  if (!big) return;
  const total = big.lines;
  openModal(`<input class="input w-full" id="lineIn" aria-label="Line number" placeholder="Go to line (1 – ${total})" inputmode="numeric">`, m => {
    const input = $<HTMLInputElement>('#lineIn', m);
    input.focus();
    input.onkeydown = e => {
      if (e.key !== 'Enter') return;
      const n = clamp(Number.parseInt(input.value, 10) || 1, 1, total);
      closeModal();
      if (b.big !== big) return;
      const at = { line: n - 1, col: 0 };
      big.surface.focus();
      big.surface.setSelection(at, at);
      void big.surface.reveal(at);
    };
  }, undefined, 'top');
}

// Changed on disk by something else: taken at once while there are no unsaved edits; otherwise the next save asks.
api.fs.onChange(paths => {
  for (const p of new Set(paths)) {
    const b = buffers.get(p);
    if (b?.big) void bigDiskChange(b, b.big);
  }
});
async function bigDiskChange(b: EditorBuffer, big: BigDoc): Promise<void> {
  let r: DocState & { changed: boolean };
  try { r = await api.doc.changed(big.doc); } catch { return; } // gone, or the engine is restarting
  if (b.big !== big || !r.changed) return;
  if (big.dirty || r.dirty) big.changedOnDisk = true;
  else await reloadBig(b, big);
}

// The engine stopped, and every document with it: open each huge file again and carry on where the view was. The
// engine's crash journal brings the unsaved edits back, so the tab stays as it is.
api.doc.onDown(() => {
  for (const b of buffers.values()) if (b.big) void reopenBig(b, b.big);
});
async function reopenBig(b: EditorBuffer, big: BigDoc): Promise<void> {
  const seq = nextBigOpen(b), s = big.surface;
  const top = s.topLine, { anchor, head } = s.selection;
  let r: DocOpen;
  try { r = await api.doc.open(b.path); } catch (e) {
    if (bigOpens.get(b) !== seq || b.big !== big) return;
    s.remove();
    b.big = undefined;
    b.bigError = errMsg(e);
    renderTabs(); renderTree();
    if (b.path === active) renderEditor();
    return;
  }
  // A newer reopen is on its way (or the buffer was closed): this document isn't wanted.
  if (buffers.get(b.path) !== b || bigOpens.get(b) !== seq || b.big !== big) { void api.doc.close(r.doc).catch(() => {}); return; }
  big.doc = r.doc;
  bigState(b, big, r);
  await s.reset(r);
  if (bigOpens.get(b) !== seq || b.big !== big) return;
  s.topLine = top;
  s.setSelection(anchor, head);
}

// A move that would carry a huge file with unsaved edits is refused before anything moves: the engine saves to the
// path it opened, so the edits would land at the old one. True (with a toast) when `p`, or anything under it, is one.
function bigMoveRefused(p: string): boolean {
  const b = [...buffers.values()].find(x => x.big?.dirty && (x.path === p || x.path.startsWith(p + '/')));
  if (b) toast(`Save ${baseName(b.path)} before moving it`);
  return !!b;
}
// After a move: a (clean) huge file is opened again in the engine at its new path.
async function bigMoved(b: EditorBuffer): Promise<void> {
  if (!b.big) return;
  closeBig(b);
  b.big = undefined;
  await openBig(b);
}
// "Don't Save" on leaving the folder: the engine's close drops each dirty huge file's crash journal, so the thrown-away
// edits don't come back as "Restored unsaved edits". Each then opens again as it is on disk, in case the folder stays.
async function discardBig(list: EditorBuffer[]): Promise<void> {
  const dirty = list.filter(b => b.big?.dirty);
  await Promise.all(dirty.map(b => api.doc.close(b.big!.doc).catch(() => {})));
  for (const b of dirty) if (b.big) void reopenBig(b, b.big);
}
// Menu Select All: the surface's own Ctrl+A (its selectAll is private), sent to its input without bubbling.
function bigSelectAll(b: EditorBuffer): void {
  const s = b.big?.surface;
  if (!s) return;
  s.focus();
  s.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, cancelable: true }));
}
