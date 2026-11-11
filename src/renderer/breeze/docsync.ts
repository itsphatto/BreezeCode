/* ================= Every text file in the engine: each buffer's engine document ================= */
// A text file the page reads (50 MB or less) also opens in the Rust engine (main.js "doc:" channels). The page keeps
// b.text as its copy, and each writer of it calls docSync, which sends the change to the engine through the buffer's
// DocQueue (doccore.ts). A file the engine won't edit (not UTF-8) or couldn't open stays on the old path (b.docSkip);
// an engine that can't start turns this off for the session (engineOff). Huge files are bigfile.ts's, not this.
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
    resync: () => live() ? api.doc.edit(id, DOC_TOP, DOC_END, b.text, 'other') : gone(),
    dropped: () => {
      if (!live()) return;
      if (buffers.get(b.path) === b) toast(`Couldn't keep ${baseName(b.path)} in the engine; it saves the old way`);
      void api.doc.close(id).catch(() => {});
      b.doc = b.docQ = undefined;
      b.docSkip = true;
    },
  });
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
  const seq = nextDocOpen(b);
  // No newer open or close since, and (once it is in `buffers`) the tab is still open in this folder.
  const wanted = () => docOpens.get(b) === seq && (first || buffers.get(b.path) === b);
  let r: DocOpen;
  try { r = await api.doc.open(b.path); } catch (e) { if (wanted()) docFailed(b, e); return null; }
  const drop = () => { void api.doc.close(r.doc).catch(() => {}); return null; };
  if (!wanted()) return drop();
  if (r.readOnly) { b.docSkip = true; return drop(); } // not UTF-8: the old path, as before
  let text = base;
  if (text == null || r.recovered || (bytes != null && r.bytes !== bytes)) {
    try { text = (await api.doc.text(r.doc, DOC_TOP, DOC_END)).text; } catch (e) { if (wanted()) docFailed(b, e); return drop(); }
    if (!wanted()) return drop();
  }
  docAttach(b, r);
  if (!(first && r.recovered)) docSync(b, text, b.text); // in the same turn as the attach, so no edit falls between
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
  b.docQ.push(docEditsFor(before, after, edits ?? null), docKindOf(b.lastEdit?.kind));
}

/** Resolves once every edit sent so far has reached the engine (or the document was dropped). Never rejects. */
function docFlush(b: EditorBuffer): Promise<void> {
  return b.docQ?.flush() ?? Promise.resolve();
}

/** Closes the buffer's document (best effort); an open still on its way is dropped too. */
function docClose(b: EditorBuffer): void {
  nextDocOpen(b);
  if (b.doc != null) void api.doc.close(b.doc).catch(() => {});
  b.doc = b.docQ = undefined;
}

/** After a move: the document opens again at the buffer's new path. The file there needn't be `b.saved` (it may have
 *  changed on disk), so the engine's text is read and the page's text synced onto it. */
async function docMoved(b: EditorBuffer): Promise<void> {
  docClose(b);
  await docOpen(b, null);
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
