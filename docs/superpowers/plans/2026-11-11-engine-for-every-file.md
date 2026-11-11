# Rust Document Engine, Piece 2a (Every Text File in the Engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every text file of 50 MB or less is also open in the Rust engine, every change to it reaches the engine, and saving goes through `doc:save`.

**Architecture:** The page keeps its copy of the text (`b.text`) and every feature keeps reading it. A pure module (`doccore.ts`) turns a text change into engine edits and queues them in order; a wiring module (`breeze/docsync.ts`) opens, syncs, saves and closes each buffer's engine document. The 8 places that write `b.text` call `docSync`; `saveFile` calls `docSave`. The engine, its protocol and the `doc:*` handlers do not change.

**Tech Stack:** TypeScript 7 (global-scope renderer files, no imports), Electron 44, Node 24 `node:test`, the existing `breeze-engine.exe`.

**Spec:** `docs/superpowers/specs/2026-11-11-engine-for-every-file-design.md`. Read it before any task. Piece 1's spec (`2026-11-10-rust-engine-huge-files-design.md`) describes the engine protocol.

## Global Constraints

- Work on branch `feat/engine-every-file` (already created; the spec is committed there). Never commit to `main`.
- Renderer files share one global scope: no `import` / `export`. A new renderer file is added to `tsconfig.json` `files` and to a `<script defer>` tag in `src/renderer/breeze.html`, in load order.
- Positions are `{ line, col }`, 0-based; `col` counts UTF-16 code units, the same as a JS string index. Only `\n` ends a line.
- The engine turns each `\n` in edit text into the file's main line ending and drops every `\r` in edit text (`engine/src/doc.rs` `edit`). Positions past the end clamp.
- `doc:edit` text is capped at 52,428,800 UTF-16 units (`src/main/docargs.js` `MAX_TEXT`).
- Files above 50 MB (`kind === 'large'`, `b.big`) keep using `bigfile.ts` unchanged.
- The editor's undo history, `isDirty` (`b.text !== b.saved`) and hot exit do not change.
- Toast copy, exactly:
  - Engine off: `The Breeze engine isn't running, so files save the old way` (once per session).
  - Sync lost: `Couldn't keep ${baseName(b.path)} in the engine; it saves the old way`.
  - Save failure keeps today's: `Couldn't save ${baseName(b.path)}: ${errMsg(e)}`.
- "Engine can't start" means an error message containing `isn't built` or matching `/\bspawn\b/`. Any other `doc:open` error leaves that one buffer on the old path, silently.
- Typing must be no slower than today: a keystroke never scans the whole text (it uses `ta.lastEdits` and the memoised `lineStartsOf`).
- In Git Bash, run `export PATH="/c/msys64/ucrt64/bin:$PATH"` before any `cargo` or `npm run build:engine`.

## Review Focus

1. **Folder switch with edits in flight:** main closes every document, so queued edits fail with "That file isn't open". Expect no toast and no fallback write: the buffer is already gone. Task 3 (the `dropped` guard).
2. **Typing during a save (auto save fires 1 s after typing):** the save must contain every edit made before `saveFile` was called. Task 1 (`flush waits for edits pushed before it`).
3. **A failed edit with more edits queued behind it:** the resync sends the page's current text, which already contains those later edits; they must not be applied a second time. Task 1 (`edits queued before a resync are skipped`).
4. **Rename or move of an open, unsaved file:** the engine document points at the old path; a save would recreate the old file. Expect the document to reopen at the new path and the save to land there. Task 3.
5. **A file with a lone `\r` or a byte order mark:** saving must not drop or move bytes the user didn't touch. Task 2 (round-trip files `bom`, `lone-cr`).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/renderer/doccore.ts` (new) | Pure: offset to position, text change to engine edits, edit kind, BOM strip, `DocQueue` |
| `test/doccore.test.js` (new) | Unit tests for `doccore.ts` (vm, like `test/bigcore.test.js`) |
| `test/docsync.engine.test.js` (new) | `doccore` edits through the real engine, then compare saved bytes |
| `src/renderer/breeze/docsync.ts` (new) | Per-buffer engine document: open, sync, flush, save, close, reopen |
| `src/renderer/breeze/workspace.ts` | `EditorBuffer` gains `doc`, `docQ` |
| `src/renderer/breeze/buffers.ts` | `readBuffer` opens the document; `restoreBuffer` and the surface input handler sync |
| `src/renderer/breeze/tabs.ts` | `dropTab` closes; `saveFile` saves through the engine; `loadDiskVersion` syncs |
| `src/renderer/breeze/explorer.ts` | `moveEntry` reopens; `reloadText` and `setBuffer` sync |
| `src/renderer/breeze/editor.ts`, `colorpick.ts`, `commands.ts` | Split view, colour picker and revert sync |

Load order: `doccore.js` directly after `bigcore.js`; `breeze/docsync.js` directly after `breeze/workspace.js`.

---

### Task 1: `doccore.ts`, pure edit and queue logic

**Files:**
- Create: `src/renderer/doccore.ts`, `test/doccore.test.js`
- Modify: `tsconfig.json` (`files`: add `"src/renderer/doccore.ts"` after `bigcore.ts`), `src/renderer/breeze.html` (`<script src="doccore.js" defer></script>` after `bigcore.js`)

**Interfaces:**
- Consumes: `lineStartsOf(text)`, `textEdit(a, b)`, `TextEdit` from `src/renderer/editcore.ts`; `DocPos`, `DocState`, `DocKind` (declared in `breeze/core.ts`; names only, so the file runs alone under the test).
- Produces:
  - `interface DocEdit { start: DocPos; end: DocPos; text: string }`
  - `const DOC_END: DocPos` = `{ line: 2147483647, col: 0 }` (the engine clamps it to the end).
  - `docPosAt(starts: readonly number[], offset: number): DocPos`: binary search in line starts.
  - `docEditsFor(before: string, after: string, edits: readonly TextEdit[] | null): DocEdit[]`: `[]` when equal; with `edits` (sorted, non-overlapping, in `before`'s offsets) one `DocEdit` per edit; without, one from `textEdit(before, after)`. Positions come from `lineStartsOf(before)`. Returned **last edit first**, so applying them in order keeps earlier positions valid.
  - `docKindOf(kind: string | undefined): DocKind`: `'type'` → `type`; `deleteContentBackward`, `deleteContentForward` → `delete`; `insertFromPaste` → `paste`; anything else → `other`.
  - `stripBom(text: string): string`: removes one leading `﻿`.
  - `class DocQueue` with `constructor(io: DocIo)`, `push(edits: DocEdit[], kind: DocKind): void`, `flush(): Promise<void>`, `lines: number | null` (from the newest reply), `dead: boolean`.
  - `interface DocIo { send(e: DocEdit, kind: DocKind): Promise<DocState>; resync(): Promise<DocState>; dropped(err: unknown): void }`

Queue rules: edits are sent one at a time, in push order. When a send fails, the queue calls `resync()` once. Every edit pushed before that resync started is skipped, because the resync's text already contains them. If the resync fails, `dead = true`, `dropped(err)` is called once, and later pushes do nothing. `flush()` resolves when every edit pushed before the call has been sent or skipped (or the queue is dead); it never rejects.

- [ ] **Step 1: Write the failing tests** in `test/doccore.test.js`. Load `editcore.ts` then `doccore.ts` into one vm context with `stripTypeScriptTypes`, as `test/bigcore.test.js` does.

```js
const P = (line, col) => ({ line, col });
test('docPosAt', () => {
  const s = [0, 3, 4]; // "ab\n\ncd"
  eq(docPosAt(s, 0), P(0, 0)); eq(docPosAt(s, 2), P(0, 2)); eq(docPosAt(s, 3), P(1, 0)); eq(docPosAt(s, 4), P(2, 0)); eq(docPosAt(s, 6), P(2, 2));
});
test('docEditsFor: insert, delete, replace', () => {
  eq(docEditsFor('ab\ncd', 'ab\ncXd', null), [{ start: P(1, 1), end: P(1, 1), text: 'X' }]);
  eq(docEditsFor('ab\ncd', 'ad', null), [{ start: P(0, 1), end: P(1, 1), text: '' }]);
  eq(docEditsFor('one\ntwo', 'one\nTWO', null), [{ start: P(1, 0), end: P(1, 3), text: 'TWO' }]);
  eq(docEditsFor('same', 'same', null), []);
});
test('docEditsFor: emoji columns are UTF-16 units', () => {
  eq(docEditsFor('😀a', '😀Xa', null), [{ start: P(0, 2), end: P(0, 2), text: 'X' }]);
});
test('docEditsFor: a lone \\r is not a line break', () => {
  eq(docEditsFor('a\rb\nc', 'a\rb\ncZ', null), [{ start: P(1, 1), end: P(1, 1), text: 'Z' }]);
});
test('docEditsFor: multi-cursor edits come last first, in before offsets', () => {
  // "a\nb\nc" with an "x" typed before each line
  eq(docEditsFor('a\nb\nc', 'xa\nxb\nxc', [{ start: 0, end: 0, text: 'x' }, { start: 2, end: 2, text: 'x' }, { start: 4, end: 4, text: 'x' }]),
    [{ start: P(2, 0), end: P(2, 0), text: 'x' }, { start: P(1, 0), end: P(1, 0), text: 'x' }, { start: P(0, 0), end: P(0, 0), text: 'x' }]);
});
test('docKindOf', () => {
  assert.equal(docKindOf('type'), 'type'); assert.equal(docKindOf('deleteContentBackward'), 'delete');
  assert.equal(docKindOf('deleteContentForward'), 'delete'); assert.equal(docKindOf('insertFromPaste'), 'paste');
  assert.equal(docKindOf('reload'), 'other'); assert.equal(docKindOf(undefined), 'other');
});
test('stripBom', () => { assert.equal(stripBom('﻿ab'), 'ab'); assert.equal(stripBom('ab'), 'ab'); assert.equal(stripBom('﻿﻿'), '﻿'); });
test('DocQueue sends in order and keeps the newest line count', async () => { /* fake send records texts; push 3; flush; sent == ['1','2','3']; q.lines == 3 */ });
test('DocQueue: flush waits for edits pushed before it', async () => { /* send resolves after a timer; push, flush, assert all sent when flush resolves */ });
test('DocQueue: a failed edit resyncs once', async () => { /* send rejects once; resync called 1 time; q.dead false */ });
test('DocQueue: edits queued before a resync are skipped', async () => { /* push A (fails), B, C synchronously; resync runs; B and C never sent; D pushed after flush is sent */ });
test('DocQueue: a failed resync kills the queue and calls dropped once', async () => { /* send and resync reject; dropped called 1 time; q.dead true; a later push sends nothing; flush resolves */ });
```

Fill each `DocQueue` test body as its comment says, with a fake `io` object.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/doccore.test.js`
Expected: FAIL (`doccore.ts` does not exist).

- [ ] **Step 3: Implement `src/renderer/doccore.ts`** with the interfaces above. Header comment in the style of `bigcore.ts` (pure, no DOM, global scope).

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test test/doccore.test.js && npx tsc -p . --noEmit`
Expected: every test passes; tsc prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/doccore.ts test/doccore.test.js tsconfig.json src/renderer/breeze.html
git commit -m "feat(doccore): text changes as engine edits, and an ordered edit queue"
```

---

### Task 2: Round trip through the real engine

**Files:**
- Create: `test/docsync.engine.test.js`

**Interfaces:**
- Consumes: `docEditsFor`, `stripBom` (Task 1, loaded by vm); `Engine` from `src/main/engine.js`.
- Produces: nothing for later tasks.

Each case writes a file, opens it in the engine, builds `before` the way `readBuffer` will (`stripBom(text).replaceAll('\r\n', '\n')`), applies `docEditsFor(before, after, null)` through `edit`, saves, and compares the file's bytes. Skip when the engine isn't built, as `test/engine.test.js` does.

- [ ] **Step 1: Write the tests**

| Test name | File bytes | `after` (page text) | Expected file bytes |
|---|---|---|---|
| `lf` | `a\nb` | `a\nXb` | `a\nXb` |
| `crlf: a new line gets CRLF` | `a\r\nb` | `a\nnew\nb` | `a\r\nnew\r\nb` |
| `mixed endings stay mixed` | `a\r\nb\nc` | `a\nb\ncZ` | `a\r\nb\ncZ` |
| `bom` | `﻿ab` | `aXb` | `﻿aXb` |
| `emoji` | `😀a` | `😀Xa` | `😀Xa` |
| `lone-cr untouched` | `a\rb\nc` | `a\rb\ncZ` | `a\rb\ncZ` |
| `several edits in one change` | `a\nb\nc` | `xa\nxb\nxc` (with the three `TextEdit`s from Task 1's multi-cursor test) | `xa\nxb\nxc` |

Each test also asserts the engine's `lines` reply equals `after.split('\n').length`.

- [ ] **Step 2: Build the engine if `runtime/breeze-engine.exe` is missing, then run**

Run: `node --test test/docsync.engine.test.js`
Expected: 7 pass, none skipped. A failure here is a mismatch between the page's positions and the engine's: fix `doccore.ts`, not the test.

- [ ] **Step 3: Commit**

```bash
git add test/docsync.engine.test.js
git commit -m "test(docsync): page edits round-trip through the engine byte for byte"
```

---

### Task 3: `docsync.ts`, each buffer's engine document

**Files:**
- Create: `src/renderer/breeze/docsync.ts`
- Modify: `tsconfig.json` and `src/renderer/breeze.html` (after `breeze/workspace`), `src/renderer/breeze/workspace.ts` (`EditorBuffer`), `src/renderer/breeze/buffers.ts` (`readBuffer`), `src/renderer/breeze/tabs.ts` (`dropTab`), `src/renderer/breeze/explorer.ts` (`moveEntry`)

**Interfaces:**
- Consumes: Task 1 (`DocQueue`, `docEditsFor`, `docKindOf`, `stripBom`, `DOC_END`); `api.doc.*`, `DocOpen` (`breeze/core.ts`); `buffers`, `toast`, `errMsg`, `baseName`.
- Produces:
  - `EditorBuffer.doc?: number` and `EditorBuffer.docQ?: DocQueue` (in `workspace.ts`).
  - `docOpen(b: EditorBuffer, base: string | null): Promise<void>`: opens `b.path`. `readOnly` → close it, leave `b.doc` unset. Engine-can't-start error → set the session flag, toast once, leave unset. Other error → leave unset, no toast. On success sets `b.doc`, `b.docQ`, `b.eol = r.eol`, then makes the engine match the page: the engine's text is `base`, or the whole text from `doc:text(doc, {0,0}, DOC_END)` when `base` is null or `r.recovered`; then `docSync(b, engineText, b.text)`. Used for reopening (engine down, move, a draft's first save), where the page's text is the truth.
  - `docOpenFirst(b: EditorBuffer): Promise<string | null>`: the first open, from `readBuffer`, where the engine may hold the truth. Same failure handling as `docOpen`. Returns the engine's whole text when `r.recovered` (the crash journal was replayed), else null. Does not sync.
  - `docSync(b: EditorBuffer, before: string, after: string, edits?: readonly TextEdit[] | null): void`: no-op without `b.docQ`; else `b.docQ.push(docEditsFor(before, after, edits ?? null), docKindOf(b.lastEdit?.kind))`.
  - `docFlush(b: EditorBuffer): Promise<void>`.
  - `docClose(b: EditorBuffer): void`: best-effort `api.doc.close`, then clears `doc` and `docQ`.
  - `docMoved(b: EditorBuffer): Promise<void>`: `docClose`, then `docOpen(b, b.saved)`.
  - `engineOff: boolean`, read by Task 4's fallback.
- The queue's `io`: `send` → `api.doc.edit(b.doc, e.start, e.end, e.text, kind)`; `resync` → `api.doc.edit(b.doc, {line:0,col:0}, DOC_END, b.text, 'other')`; `dropped` → if `buffers.get(b.path) === b` (still open), toast the sync-lost copy; always clear `b.doc` and `b.docQ`.
- `api.doc.onDown` (a second listener; `bigfile.ts` keeps its own): for each buffer with `b.doc`, clear it and `void docOpen(b, null)`.

- [ ] **Step 1: Add the fields and `docsync.ts`** with the interfaces above.

- [ ] **Step 2: Wire `readBuffer`** (`buffers.ts:118`): for `kind === 'text'`, strip the BOM from the text read (`stripBom`) before `b.text`/`b.saved` are set; start `docOpenFirst(b)` at the same time as building the buffer, await it before `buffers.set`, and when it returns text, set `b.text` (and the surface's value) to it so the tab shows as unsaved.

- [ ] **Step 3: Wire close and move.** `dropTab` (`tabs.ts:454`) calls `docClose(gone)` for a buffer with `doc`. `moveEntry` (`explorer.ts:434`) calls `docMoved(b)` for each moved buffer with `doc`, after its path changes.

- [ ] **Step 4: Check types and tests**

Run: `npx tsc -p . --noEmit && npm test`
Expected: no tsc output; all tests pass.

- [ ] **Step 5: Check in the app.** Start Breeze, open a small file, and in DevTools run `buffers.get(active).doc`. Expected: a number. Close the tab: no error in the console.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/breeze/docsync.ts src/renderer/breeze/workspace.ts src/renderer/breeze/buffers.ts src/renderer/breeze/tabs.ts src/renderer/breeze/explorer.ts tsconfig.json src/renderer/breeze.html
git commit -m "feat(docsync): every text buffer opens in the engine"
```

---

### Task 4: Every writer syncs, and save goes through the engine

**Files:**
- Modify: `src/renderer/breeze/buffers.ts` (`createSurface` input handler, `restoreBuffer`), `src/renderer/breeze/editor.ts` (`splitTa` input handler, ~line 1024), `src/renderer/breeze/colorpick.ts` (`write`, `commit`), `src/renderer/breeze/commands.ts` (revert, line 313), `src/renderer/breeze/explorer.ts` (`reloadText`, `setBuffer`), `src/renderer/breeze/tabs.ts` (`loadDiskVersion`, `saveFile`), `src/renderer/breeze/docsync.ts` (`docSave`)

**Interfaces:**
- Consumes: Task 3 (`docSync`, `docFlush`, `docOpen`, `engineOff`).
- Produces: `docSave(b: EditorBuffer): Promise<void>` in `docsync.ts`: `docFlush`; if `b.docQ.lines !== lineStartsOf(b.text).length`, push a resync (a whole-text edit from `{0,0}` to `DOC_END`) and flush again; then `api.doc.save(b.doc)`. Rejects with the engine's error.

Sync rule at each writer: capture `before = b.text` before the write, call `docSync(b, before, b.text, edits)` right after. Only the two surface input handlers pass `edits` (`ta.lastEdits` / `splitTa.lastEdits`); the rest pass nothing.

- [ ] **Step 1: Add `docSync` at the 8 writers:** the surface input handler (`buffers.ts:223`), `restoreBuffer` (`buffers.ts:4`), the split input handler (`editor.ts`), colour picker `write` and `commit` (`colorpick.ts:152`, `:161`), revert (`commands.ts:313`), `reloadText` (`explorer.ts:587`), `setBuffer` (`explorer.ts:692`), `loadDiskVersion` (`tabs.ts:581`).

- [ ] **Step 2: Add `docSave` and use it in `saveFile`** (`tabs.ts:518`). For a buffer with `b.doc`, replace the `api.fs.writeFile` call with `await docSave(b)` inside the same try/catch and toast. A buffer without `b.doc` that is not untitled: if `!engineOff`, first make sure the file exists (`api.fs.createFile`, ignoring "already exists"), then `await docOpen(b, null)` (it reads whatever the file holds now); if that leaves `b.doc` set, `docSave(b)`; otherwise today's `api.fs.writeFile`. If `b.doc` is unset after `docSave`'s flush (the queue died), `docSave` writes with `api.fs.writeFile` instead, with today's line-ending conversion. Untitled buffers keep `saveUntitled`.

- [ ] **Step 3: Check types and tests**

Run: `npx tsc -p . --noEmit && npm test`
Expected: no tsc output; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/breeze/
git commit -m "feat(docsync): every change reaches the engine and save goes through it"
```

---

### Task 5: Check it in the app

**Files:**
- Modify: `docs/superpowers/specs/2026-11-11-engine-for-every-file-design.md` (the `CodeSurface` section: positions come from `lineStartsOf` in `editcore.ts`, not a new `lineCol` method)

- [ ] **Step 1: Run each check** in a scratch folder opened in Breeze (`npm start`). For each, compare the bytes on disk with `node -e "console.log(JSON.stringify(require('fs').readFileSync(process.argv[1],'utf8')))" <file>`.

| Check | Expected |
|---|---|
| Type in a LF file, Ctrl+S | Saved text matches the editor |
| Type a new line in a CRLF file, save | New line ends in `\r\n` |
| Edit one line of a mixed-ending file, save | Other lines keep their endings |
| File with a byte order mark, edit, save | BOM still first |
| Undo and redo, save | Saved text matches the editor |
| Multi-cursor typing on 3 lines, save | All 3 edits saved |
| Split view: type on the right, save | Saved |
| Change the file outside Breeze while it's clean, then type and save | Outside change kept plus the typing |
| Rename an open unsaved file in Explorer, save | Saved at the new name; old name not recreated |
| Unsaved edits, quit, start again, save | Restored edits saved |
| Agent edit types out into an open file, then save | Saved text matches |
| Rename `runtime/breeze-engine.exe`, start Breeze, edit, save | One toast with the engine-off copy; the file saves |
| Type quickly for 10 s in a 20 MB file | No more lag than on `main` |

- [ ] **Step 2: Update the spec's `CodeSurface` section** as listed under Files.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-11-11-engine-for-every-file-design.md
git commit -m "docs: positions come from editcore's line index"
```
