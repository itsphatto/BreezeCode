/* ================= Every text file in the engine: each buffer's engine document ================= */
// A text file the page reads (50 MB or less) also opens in the Rust engine (main.js "doc:" channels). The page keeps
// b.text as its copy, and each writer of it calls docSync, which sends the change to the engine through the buffer's
// DocQueue (doccore.ts). A file the engine won't edit (not UTF-8) or couldn't open stays on the old path (b.docSkip);
// an engine that can't start turns this off for the session (engineOff). Huge files are bigfile.ts's, not this.
// A text with a lone \r stays on the old path too: the engine drops every \r in edit text, so an undo, a reload or a
// resync carrying one would reach the file without it. b.text never holds a \r\n (readBuffer turns those into \n),
// so any \r in it is a lone one.
// Loaded before buffers.ts: nothing here runs other files' code at load time, only from events.

// The engine couldn't start this session (not built, or blocked): every buffer saves the old way.
let engineOff = false;
// Bumped by every open of a buffer (and by closing it): a reply to an older open is dropped.
const docOpens = new WeakMap<EditorBuffer, number>();
const nextDocOpen = (b: EditorBuffer) => { const n = (docOpens.get(b) ?? 0) + 1; docOpens.set(b, n); return n; };
const DOC_TOP: DocPos = { line: 0, col: 0 };
// "Can't start" is told by engine.js's own message (or a spawn error), not by a per-file error such as a missing file.
const ENGINE_CANT_START = /^The Breeze engine isn't built|^spawn /;

function docFailed(b: EditorBuffer, e: unknown): void {
  if (!ENGINE_CANT_START.test(errMsg(e))) { b.docSkip = true; return; }
  if (engineOff) return;
  engineOff = true;
  toast('The Breeze engine isn\'t running, so files save the old way');
}

// Gives the buffer its document and a queue that sends to it. The queue only acts while it is the buffer's own: once
// the document is closed or reopened, an edit still queued must not reach another document (a restarted engine
// numbers its documents from 1 again).
function docAttach(b: EditorBuffer, r: DocOpen): void {
  const id = r.doc;
  const live = () => b.docQ === q;
  const gone = () => Promise.reject(new Error('The document was closed'));
  const q: DocQueue = new DocQueue({
    send: (e, kind) => live() ? api.doc.edit(id, e.start, e.end, e.text, kind) : gone(),
    // A text with a \r can't be sent (see the top): the resync fails, and the document is dropped.
    resync: () => !live() ? gone()
      : b.text.includes('\r') ? Promise.reject(new Error('The text has a lone carriage return'))
      : api.doc.edit(id, DOC_TOP, DOC_END, b.text, 'other'),
    dropped: () => {
      if (!live()) return;
      if (buffers.get(b.path) === b) toast(`Couldn't keep ${baseName(b.path)} in the engine; it saves the old way`);
      void api.doc.close(id).catch(() => {});
      b.doc = b.docQ = undefined;
      b.docSkip = true;
    },
  });
  q.lines = r.lines; // the engine's count as opened, so a save before any edit needn't resync
  b.doc = id;
  b.docQ = q;
  b.eol = r.eol;
}

// Opens b.path in the engine and attaches it, then (unless the engine holds the truth: a first open whose crash
// journal was replayed) brings the engine to the page's text. `base` is the text the engine opens with, when known;
// it is fetched when null, when the crash journal was replayed, or when `bytes` (the size of the file the page read)
// isn't what the engine read: the file changed between the two reads. `first`: readBuffer's open, before the buffer
// is in `buffers`. Returns the engine's text as opened, or null with no document (the failure recorded; a reply no
// longer wanted is closed).
async function docStart(b: EditorBuffer, base: string | null, first: boolean, bytes?: number): Promise<{ text: string; recovered: boolean } | null> {
  if (engineOff) return null;
  const seq = nextDocOpen(b), path = b.path;
  // No newer open or close since, not moved since (the document would be the old path's), and (once it is in
  // `buffers`) the tab is still open in this folder.
  const wanted = () => docOpens.get(b) === seq && b.path === path && (first || buffers.get(b.path) === b);
  let r: DocOpen;
  try { r = await api.doc.open(path); } catch (e) { if (wanted()) docFailed(b, e); return null; }
  const drop = () => { void api.doc.close(r.doc).catch(() => {}); return null; };
  if (!wanted()) return drop();
  if (r.readOnly) { b.docSkip = true; return drop(); } // not UTF-8: the old path, as before
  let text = base;
  if (text == null || r.recovered || (bytes != null && r.bytes !== bytes)) {
    try { text = (await api.doc.text(r.doc, DOC_TOP, DOC_END)).text; } catch (e) { if (wanted()) docFailed(b, e); return drop(); }
    if (!wanted()) return drop();
  }
  // The text the page holds from here: the engine's when its crash journal is taken, else b.text. With a lone \r it
  // stays on the old path (a taken journal's text still goes to the page, which saves it the old way).
  const recovered = first && r.recovered;
  if ((recovered ? text : b.text).includes('\r')) { b.docSkip = true; drop(); return recovered ? { text, recovered } : null; }
  docAttach(b, r);
  if (!recovered) docSync(b, text, b.text); // in the same turn as the attach, so no edit falls between
  return { text, recovered: r.recovered };
}

/** Opens the buffer in the engine and makes the engine's text match the page's, which is the truth (a reopen after
 *  the engine went down, a move, a draft's first save). `base`: the text the engine opens with, or null to fetch it. */
async function docOpen(b: EditorBuffer, base: string | null): Promise<void> {
  await docStart(b, base, false);
}

/** readBuffer's first open, where the engine may hold the truth: the engine's whole text when its crash journal was
 *  replayed (unsaved edits from before a crash), else null. `bytes`: the file's size as the page read it (BOM
 *  included, as the engine counts it); when the engine read another size, the file changed between the two reads,
 *  and the engine is brought to the page's text. */
async function docOpenFirst(b: EditorBuffer, bytes: number): Promise<string | null> {
  const got = await docStart(b, b.text, true, bytes);
  return got?.recovered ? got.text : null;
}

/** Sends the change from `before` to `after` (the buffer's text) to the engine. `edits`: the surface's own edits for
 *  it (a keystroke's lastEdits), so the change needn't be found by comparing the texts. */
function docSync(b: EditorBuffer, before: string, after: string, edits?: readonly TextEdit[] | null): void {
  if (!b.docQ) return;
  docPush(b, b.docQ, docEditsFor(before, after, edits ?? null), docKindOf(b.lastEdit?.kind));
}

// Queues edits on the buffer's queue `q`, unless one carries a \r (which the engine would drop): then the document
// goes and the buffer saves the old way, exactly.
function docPush(b: EditorBuffer, q: DocQueue, edits: DocEdit[], kind: DocKind): void {
  if (edits.some(e => e.text.includes('\r'))) { docClose(b); b.docSkip = true; return; }
  q.push(edits, kind);
}

/** Resolves once every edit sent so far has reached the engine (or the document was dropped). Never rejects. */
function docFlush(b: EditorBuffer): Promise<void> {
  return b.docQ?.flush() ?? Promise.resolve();
}

/** The bytes a save without the engine writes for `text`: the buffer's line ending on every line, and the byte order
 *  mark the file was read with (the engine puts both back itself). */
function diskText(b: EditorBuffer, text: string): string {
  const t = b.eol === '\r\n' ? text.replaceAll('\n', '\r\n') : text;
  return b.bom ? '\uFEFF' + t : t;
}

/** Saves the buffer through its engine document and returns the page text the file now holds, so the caller marks
 *  exactly that as saved. The save is sent only once the queue is idle (every edit pushed, even one typed during the
 *  wait, has reached the engine), in the same turn as reading b.text, so the engine holds exactly that text. When the
 *  engine's line count says a writer missed docSync, the whole text is sent first (once: the engine then holds the
 *  page's text whatever it counts). With no document (the engine off, a file it won't hold) or one dropped meanwhile,
 *  the file is written the old way (fs:writeFile, with the buffer's line ending and byte order mark). Rejects
 *  with the engine's (or the write's) error. */
async function docSave(b: EditorBuffer): Promise<string> {
  let resynced = false;
  for (let q = b.docQ; q && b.doc != null; q = b.docQ) {
    await q.flush();
    if (b.docQ !== q || !q.idle) continue; // reopened after an engine restart, or edits pushed during the wait
    if (!resynced && q.lines !== lineStartsOf(b.text).length) {
      resynced = true;
      docPush(b, q, [{ start: DOC_TOP, end: DOC_END, text: b.text }], 'other');
      continue; // with a \r the document went: the loop ends and the text is written the old way
    }
    const t = b.text;
    await api.doc.save(b.doc); // called in the same turn as `t` was read: nothing falls between
    return t;
  }
  const t = b.text; // the queue died, or no document: the old way
  await api.fs.writeFile(b.path, diskText(b, t));
  return t;
}

/** Closes the buffer's document (best effort); an open still on its way is dropped too. */
function docClose(b: EditorBuffer): void {
  nextDocOpen(b);
  if (b.doc != null) void api.doc.close(b.doc).catch(() => {});
  b.doc = b.docQ = undefined;
}

// The engine stopped, and every document with it: each opens again and is brought up to the page's text. bigfile.ts
// reopens the huge files with its own listener.
api.doc.onDown(() => {
  for (const b of buffers.values()) {
    if (b.doc == null) continue;
    b.doc = b.docQ = undefined; // gone with the engine: nothing to close
    void docOpen(b, null);
  }
});
