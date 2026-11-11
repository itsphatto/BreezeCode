# Rust document engine, piece 2a: every text file opens in the engine

Date: 2026-11-11
Status: design, awaiting review

## Goal

After this piece, every text file Breeze Code opens is also open in the Rust engine (`breeze-engine.exe`), and
every save goes through the engine. Files above 50 MB keep working as piece 1 made them.

This is the first of three steps that finish the move to the engine:

| Step | What it delivers | User goal |
|---|---|---|
| 2a | Every text file opens in the engine; save goes through the engine; the page keeps a copy of the text | One save path |
| 2b | One windowed editor for every size; lint and LSP get their text from main, not the page | Faster typing |
| 3 | Syntax colours in Rust; the page stops holding any file's full text | Lower memory |

Piece 1: `docs/superpowers/specs/2026-11-10-rust-engine-huge-files-design.md`.

## What the user said, and what is assumed

Said by the user:

- Every file, including those under 50 MB, should go through the Rust engine.
- Keep every editor feature (colours, LSP, lint, replace, multi-cursor, split view, minimap, git marks).
- Goals: faster typing, one save path, lower memory. Crash recovery is not a goal.
- Work in stages; this spec is stage 2a.
- Undo keeps the editor's own history (word grouping, caret put back).
- When the engine can't start, files open and save the old way, with one toast per session.

Assumed (correct these if wrong):

- 2a may use a little more memory than today: the engine and the page both hold each open file until piece 3.
- Keeping each line's own line ending on save (instead of turning every ending into the file's main one) is
  wanted.

## Design

### The rule

The engine owns the file on disk. The page keeps a copy of the text (`b.text`), and every change to that copy is
also sent to the engine as an edit. Every feature that reads `b.text` today keeps reading it.

### Which files

A buffer gets an engine document when all of these hold:

- `kind === 'text'` (`fs:readFile` returned text, so 50 MB or less and not binary).
- It is not untitled.
- The engine has not been found off this session (see Errors).
- `doc:open` did not answer `readOnly: true` (not valid UTF-8). Such a file stays on the old path, as today, and
  its document is closed.
- The page's text has no lone `\r` (the engine drops every `\r` in edit text). A lone-CR file uses the old path, and
  an edit that brings one in (undo, reload, agent typing, the save backstop) closes the document first.

Files above 50 MB (`kind === 'large'`) keep using `BigSurface` and `bigfile.ts` unchanged.

### New files: `src/renderer/doccore.ts` and `src/renderer/breeze/docsync.ts`

The logic that needs no DOM lives in `src/renderer/doccore.ts`, so a Node test can load it
(`test/doccore.test.js`, with `editcore.ts` loaded first):

- `docEditsFor(before, after, edits?)`: the engine edits that turn `before` into `after`.
  - With `edits` (a keystroke's `ta.lastEdits`), each edit's offsets become `{ line, col }`.
  - Without them, the changed span comes from `textEdit(before, after)` (`editcore.ts`).
  - Positions are in `before`. The edits come last first, so each earlier position stays valid.
- `docPosAt(starts, offset)`: an offset turned into `{ line, col }` (`col` is a UTF-16 index, the engine's unit) by
  binary search on the line starts.
- `docKindOf(kind)`: follows the editor's own `b.lastEdit.kind`: `type` stays `type`, `deleteContentBackward` and
  `deleteContentForward` become `delete`, `insertFromPaste` becomes `paste`, and everything else is `other`. The
  engine's undo grouping is unused in 2a, so `kind` only labels the journal.
- `stripBom(text)`: the text without one leading byte order mark.
- `DOC_END`: an end position past any line. The engine clamps it to the end of the document.
- `DocQueue`: one per buffer. Edits go out in order; the page never waits for a reply before going on.
  - `push(edits, kind)` queues edits. A failed send becomes one whole-text resync (the edits still waiting are in
    that text, so they are skipped). If the resync fails too, the queue is dead and the document is dropped.
  - `flush()` resolves when every edit pushed before the call has been sent or skipped. It never rejects.
  - `idle` is true when nothing is queued and nothing is running: the engine holds the text as of the newest push.
  - `lines` is the line count from the newest reply (piece 1 protocol).

A keystroke's positions never scan the file: `lineStartsOf` (`editcore.ts`) keeps the line starts of the last two
texts, so a keystroke's `before` text is already indexed. `CodeSurface` does not change.

`src/renderer/breeze/docsync.ts` holds the per-buffer wiring. It loads before `buffers.ts` (script tag in
`breeze.html`, entry in `tsconfig.json` `files`).

| Function | What it does |
|---|---|
| `docOpen(b, base)` | Opens `b.path` in the engine, attaches the document and its queue, and syncs the page's text onto it. `base` is the text the engine opens with, or `null` to fetch it. |
| `docOpenFirst(b, bytes)` | `readBuffer`'s first open. Returns the engine's whole text when its crash journal was replayed, else `null`. |
| `docSync(b, before, after, edits?)` | Pushes the change from `before` to `after` onto the buffer's queue. No-op when `b.doc` is unset. |
| `docFlush(b)` | Resolves when the queue has sent every edit. |
| `docSave(b)` | Saves through the engine (see Save) and returns the text that reached disk. |
| `docClose(b)` | Closes the document; an open still on its way is dropped too. |
| `engineOff` | True once the engine couldn't start this session: every buffer saves the old way. |

`EditorBuffer` gains these fields (`workspace.ts`):

- `doc?: number`: the engine document id, set while the buffer is open in the engine.
- `docQ?: DocQueue`: the edits on their way to `doc`, in order.
- `docSkip?: boolean`: set when the engine opened the file read-only, or failed with an error other than
  "can't start". Such a buffer saves the old way, with no further engine attempt.
- `bom?: boolean`: the file starts with a byte order mark, which is kept out of `b.text`. Every old-way write puts it
  back.

### Open (`readBuffer`, `buffers.ts`)

1. `fs:readFile` runs, then `doc:open` (`docOpenFirst`) runs while the rest of the buffer is built.
2. A leading byte order mark (`﻿`) is removed from the text of every text file, engine on or off, and
   `b.bom` records it. The engine removes it too and writes it back on save, so positions on line 1 match.
   `reloadText` strips the mark the same way; when the mark was added or removed on disk, the document reopens.
3. `b.saved` is the text from disk, as today.
4. When `doc:open` answers `recovered: true` (the crash journal was replayed), `b.text` is set from
   `doc:text` for the whole document and the tab shows as unsaved.
5. When the reply's `bytes` differs from the size `fs:readFile` saw, the file changed between the two reads. The page
   fetches the engine's text and sends the difference.
6. `b.eol` comes from `doc:open` when there is a document.

### Every writer of `b.text`

Each place that changes an open buffer's text calls `docSync` right after the change:

| Writer | Where |
|---|---|
| Typing, paste, Emmet, every command that edits through the surface, undo and redo (they dispatch `input`) | `createSurface` input handler, `buffers.ts` (passes `ta.lastEdits`) |
| Split view typing | `editor.ts` (the `splitTa` input handler) |
| Colour picker | `colorpick.ts` |
| Hot-exit restore | `restoreBuffer`, `buffers.ts` |
| Revert all | `commands.ts` |
| Outside change taken in | `reloadText`, `explorer.ts` |
| Agent edits typed out | `setBuffer`, `explorer.ts` |
| "Use disk version" | `loadDiskVersion`, `tabs.ts` |

Outside changes reach the engine as ordinary edits, not `doc:reload`: a reload would read the file a second time,
and the two reads could see different versions.

### Save (`saveFile`, `tabs.ts`)

For a buffer with a document, `docSave(b)` returns the exact text that reached disk:

1. It waits until the queue is idle. It loops if edits arrive during the wait, or if the engine restarts and swaps
   the queue.
2. Only when idle, it checks the line count. If the queue's `lines` differs from the page's line count, it resyncs the
   whole text once and waits again. This catches a writer that missed `docSync`, and runs at most once per save.
3. It reads `b.text` and calls `doc:save` in the same turn, so the engine holds exactly that text. The engine writes
   atomically, through symbolic links, and puts back the byte order mark.
4. `saveFile` sets `b.saved` to the returned text, not to `b.text` as it is by then: typing during the save may have
   moved `b.text` on.

All old-way writes (engine off, read-only file, document dropped) go through `docSave` too. It writes with
`fs:writeFile`, using the buffer's line ending and byte order mark.

The changed-on-disk prompt, auto save, Save All and the close prompt keep calling `saveFile` and do not change.

Line endings: the engine keeps each untouched line's ending and gives new lines the file's main ending
(`normalise_eol`, `engine/src/doc.rs`). A file with mixed endings stays mixed. Today's save turns every ending into
the main one.

### Buffers without a document

- Untitled files: saved through the Save dialog (`saveUntitled`), as today. The saved file then opens like any
  other, with a document.
- Agent drafts not yet on disk (`blankBuffer`): the first save creates the empty file (`fs:createFile`), opens it
  in the engine, resyncs, and saves.
- Engine off, read-only or lone-CR file: today's `fs:writeFile`, through `docSave`.
- A moved or renamed file: the document closes as the path changes (so no save writes the old path), then reopens
  at the new path with the engine's own text fetched (not `b.saved`: the file there may have changed on disk), and
  the page's text is synced onto it (`moveEntry`, `explorer.ts`).

### Close

Closing a tab calls `docClose`. Closing the folder already closes every document in main (`closeAllDocs`).

### Not changing

- The unsaved check (`isDirty`: `b.text !== b.saved`).
- Hot exit (unsaved text kept in the page's store).
- The editor's undo history.
- `fs:writeFile` callers that don't touch open buffers: LSP edits to closed files (`lsp.ts`) and `.gitignore`
  (`explorer.ts`).
- `fs:readFile`, all `doc:*` handlers, the engine protocol and the engine.

## Errors

| Situation | What the user sees | What happens |
|---|---|---|
| The engine can't start (missing, blocked) | One toast per session: "The Breeze engine isn't running, so files save the old way" | Engine off for this session; every buffer uses the old path |
| File isn't valid UTF-8 | Nothing new | Document closed; buffer uses the old path |
| The text has (or gets) a lone `\r` | Nothing | Document closed; buffer uses the old path |
| An edit fails | Nothing | The queue resyncs the whole text; if that fails too, the document is dropped, the buffer uses the old path, and a toast says "Couldn't keep X in the engine; it saves the old way" |
| A save fails | "Couldn't save X: reason", as today | `b.saved` unchanged |
| The engine crashes (`doc:down`) | Nothing | Each document reopens; if its text differs from `b.text`, `docSync` sends the difference |

"Can't start" is told apart from other failures by the engine module's message ("The Breeze engine isn't
built..." or a spawn error, kept as "spawn ..." even when it arrives after spawn returns), not by a per-file error
such as a missing file.

## Speed

Typing must be no slower than today:

- A keystroke uses `ta.lastEdits` and `lineStartsOf`, which already holds the line starts of its `before` text, so
  there is no whole-text scan.
- The edit is sent without waiting.
- Writers without `lastEdits` (reload, agent typing, revert, restore) use `textEdit`, which they already pay for
  today in `highlighted()`.

## Testing

1. Unit tests, `test/doccore.test.js` (node:test, like the other tests):
   - Offset to `{ line, col }`: start, end, after `\n`, emoji (surrogate pairs), lone `\r`.
   - The edit made for insert, delete, replace and whole-text change.
   - The queue sends in order, resyncs once on a failed edit, drops the document after a second failure, and
     `docFlush` waits for every edit.
2. Engine round trip, skipped when the engine isn't built (as `test/engine.test.js` does): open a file, apply edits
   through `docSync`'s positions, save, compare the bytes. Files: LF, CRLF, mixed endings, a byte order mark, emoji.
3. `test/docsync.test.js`: `docsync.ts` against a fake engine (save with edits queued, save across `doc:down`, the
   line-count backstop, a dropped queue, a close or move during an open, lone-CR files and edits).
4. By hand in the app: type and save, undo and redo, paste, split view, an agent edit typed out, hot exit after a
   restart, a file changed on disk, and the engine exe renamed (fallback toast, files still save).

## Out of scope

- A windowed editor for every file, and lint and LSP fed from main: 2b.
- Syntax colours in Rust and lower memory: piece 3.
- The engine's undo for normal files.
- Any change to how files above 50 MB work.
