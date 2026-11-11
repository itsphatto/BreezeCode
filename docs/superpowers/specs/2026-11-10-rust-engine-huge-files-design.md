# Rust document engine, piece 1: editable files above 50 MB

Date: 2026-11-10
Status: design, awaiting review

## Goal

Breeze Code refuses to open a text file above 50 MB (`MAX_FILE_BYTES`, `src/main/main.js:45`). After this piece,
such a file opens in an editable view, and typing in it is as fast as in a small file.

This is the first of three pieces that move document handling into Rust. The user interface stays web technology.

| Piece | What it delivers | Status |
|---|---|---|
| 1 | Rust engine sidecar; files above 50 MB open and are editable | this spec |
| 2 | Every text file uses the engine; the editor stops holding the text as one string | later spec |
| 3 | Syntax highlighting in Rust; the 5 MB colour limit goes away | later spec |

## What the user said, and what is assumed

Said by the user:

- Keep the front end in web technology; write the slow backend part in Rust.
- The feature that needs the speed is large files and editing.
- One engine for both problems: opening files above 50 MB, and typing lag in big files.
- Use a sidecar process, not a native addon.
- Files above 50 MB must be editable in piece 1, not read-only.

Assumed (correct these if wrong):

- The interface holds only the visible lines of a huge file, never the whole text.
- Windows is the only build target for now (`npm run dist` builds `--win` only). The engine code itself is
  portable.
- Files are UTF-8. A file that is not valid UTF-8 opens for viewing only.

## Why the current design cannot do this

- `fs:readFile` reads the whole file and sends it to the page as one string over IPC.
- `CodeSurface` (`src/renderer/codeview.ts`) keeps the text as one JS string and addresses it by character
  offset. An insert builds a new string of the whole file.
- About 250 places in the renderer read that string (`b.text`, `ta.value`).

So a huge file needs a surface that addresses text by line and column and asks someone else for the text. That
someone is the engine. Piece 2 later moves the existing surface onto the same engine.

## Architecture

```
renderer (web)                 main process (Node)            sidecar (Rust)
BigSurface  ──┐
bigfile.ts  ──┼─ api.doc.* ─►  doc:* IPC handlers  ─►  engine.js  ─ JSON lines / stdio ─►  breeze-engine.exe
              │                 (path guard)             (spawn, ids, restart)                (rope per document)
```

Four units, each testable alone:

1. `engine/`: the Rust crate. Knows files, text, edits, undo, find, save. Knows nothing about Electron.
2. `src/main/engine.js`: starts the engine, matches replies to requests, restarts it. Knows nothing about text.
3. `doc:*` IPC handlers in `src/main/main.js`: turn a project-relative path into a guarded absolute path.
4. `src/renderer/bigsurface.ts` and `src/renderer/breeze/bigfile.ts`: the editing surface and its wiring into
   tabs, the status bar, find and save.

## Unit 1: the engine (`engine/`)

A Cargo binary crate named `breeze-engine`.

Dependencies: `ropey` (rope text buffer), `serde` and `serde_json` (messages), `memchr` (search).

### Text model

- Each open document is a `ropey::Rope`. Insert and delete cost O(log n) whatever the file size.
- Only `\n` ends a line. `ropey` is built without its Unicode and lone-CR line-break handling, so line numbers
  match the editor's (`text.split('\n')`). A trailing `\r` is stripped from each line the engine returns.
- The rope holds the file's bytes as they are, so line endings survive untouched, including mixed ones.
- The engine records the file's dominant line ending at open (`\r\n` if any line has it, else `\n`). A new line
  typed by the user is inserted with that ending.
- A UTF-8 byte order mark is removed at load, remembered, and written back on save.
- Positions are `{ line, col }`, both 0-based. `col` counts UTF-16 code units inside the line, so it equals a JS
  string index. The engine converts with `ropey`'s UTF-16 helpers.
- Line count equals `text.split('\n').length`: a file ending in a newline has a final empty line.

### Limits

- A file above 2 GB is refused with the message "This file is larger than 2 GB".
- Memory use is about the file's size plus undo history.
- A line longer than 10,000 UTF-16 units is returned cut to 10,000, with its full length. The surface shows the
  cut part and edits only inside it. This is the same limit the editor uses (`LONG_LINE`).
- `text` (used for copy) refuses a range above 100 MB.
- Undo history holds at most 256 MB of removed and inserted text. The oldest steps are dropped beyond that.

### Protocol

One JSON object per line on stdin and stdout. This is the format `src/main/kernel.js` already uses.

Request: `{ "id": 7, "op": "lines", "doc": 1, "first": 1200, "count": 180 }`

Reply: `{ "id": 7, "ok": true, ... }` or `{ "id": 7, "ok": false, "error": "message for the user" }`

Requests are handled in the order received. stderr carries diagnostics only.

Every reply that describes a document carries `rev` (a counter that grows with each change), `lines` (line
count) and `dirty` (changed since the last save or load).

| op | arguments | reply | notes |
|---|---|---|---|
| `open` | `path` | `doc`, `bytes`, `eol`, `readOnly`, `recovered` | `readOnly` when the file is not valid UTF-8. `recovered` when a journal was replayed. |
| `lines` | `doc`, `first`, `count` | `items: [{ text, len }]` | `len` is the full length when the line was cut. |
| `edit` | `doc`, `start`, `end`, `text`, `kind` | `caret` | Replaces the range with `text`. `kind` is `type`, `delete`, `paste` or `other`, used to group undo. |
| `undo` / `redo` | `doc` | `caret`, or `none: true` | |
| `text` | `doc`, `start`, `end` | `text` | For copy and cut. |
| `find` | `doc`, `query`, `matchCase`, `from`, `backward` | `hit: { line, col, len }` or `hit: null` | Wraps around once. |
| `count` | `doc`, `query`, `matchCase` | `count`, `capped` | Stops counting at 9,999. |
| `save` | `doc` | `bytes` | Atomic, see below. |
| `changed` | `doc` | `changed` | True when the file's size or modified time differs from the last load or save. |
| `reload` | `doc` | same as `open` | Drops edits and undo history, reads the file again. |
| `close` | `doc` | | Frees the document and deletes its journal. |

`edit` on a `readOnly` document fails with "This file isn't valid UTF-8, so it can't be edited here".

### Undo

- Each edit stores its inverse (range and removed text).
- An edit joins the previous undo step when it has the same `kind`, touches the position where the previous
  edit ended, and neither contains a newline. So a typed word is one step.
- `kind: "other"` and `paste` never join.
- A new edit clears the redo stack.

### Save

1. Write the rope (and the byte order mark, if the file had one) to `<file>.breeze-tmp-<pid>` in the same folder.
2. Flush and sync it to disk.
3. Rename it over the original.
4. If any step fails, delete the temp file and reply with the error. The original is untouched.

After a save the engine records the file's new size and modified time, clears `dirty`, and restarts the journal.

### Crash journal

The engine is started with `--journal-dir <folder>` (main passes a folder under Electron's `userData`).

- Per document: one journal file, named by a hash of the absolute path.
- First line: the path, and the file's size and modified time at load.
- Each `edit`, `undo` and `redo` is appended as one line and written out at once (no disk sync per edit).
- On `open`: if a journal exists and its first line matches the file on disk, the engine replays it and replies
  `recovered: true`. Otherwise the journal is deleted.
- The journal is deleted on `close` and restarted on `save` and `reload`.

This protects unsaved edits from an engine crash and from an app crash. It does not protect from a power cut.

## Unit 2: `src/main/engine.js`

A class shaped like `Kernels` in `src/main/kernel.js`.

- `request(op, args)` returns a promise for the reply. It rejects with the engine's `error` message.
- The engine starts on the first request, not at app start.
- Executable path: `unpacked(path.join(ROOT, 'runtime', 'breeze-engine.exe'))`, the helper the notebook kernel
  already uses.
- If the executable is missing, `request` rejects with "The Breeze engine isn't built. Run npm run build:engine".
- When the process exits, every waiting request rejects and the class emits `down`. The next request starts a
  new process.
- `stop()` ends the process. Main calls it on quit.

## Unit 3: IPC in `src/main/main.js`

New handlers, all through the existing `handle()` guard:

`doc:open`, `doc:lines`, `doc:edit`, `doc:undo`, `doc:redo`, `doc:text`, `doc:find`, `doc:count`, `doc:save`,
`doc:changed`, `doc:reload`, `doc:close`.

- `doc:open` takes a project-relative path and resolves it with `resolveIn`, the same guard as `fs:readFile`.
- Main keeps the set of open document ids. Every other handler rejects an id that is not in the set.
- Arguments are checked for type and range before they reach the engine (integers, strings, sizes).
- Closing the folder closes every open document.
- Engine `down` is forwarded to the page as `doc:down`.

`src/main/preload.js` gains `api.doc.*` for these, and `api.doc.onDown(cb)`.

`fs:readFile` does not change: it still answers `{ tooLarge: true, size }` above 50 MB. The page then opens the
file through `doc:open` instead of showing the "too large" note.

## Unit 4: the renderer

### `src/renderer/bigsurface.ts` (new, global scope like `codeview.ts`)

`BigSurface` is a small editing surface that never holds the whole text.

State it holds:

- `lines`: the document's line count.
- `topLine`: the first visible line. The surface owns vertical scrolling itself.
- A cache of fetched lines: the visible window plus 200 lines either side.
- The selection as two positions: `anchor` and `head`, each `{ line, col }`.
- `rev`: the newest document revision it knows.

Vertical scrolling is not native. A browser element cannot be taller than about 33 million pixels, which is
1.6 million lines, and a 1 GB log has many more. So the surface handles wheel, keyboard and its own slider, and
draws only the visible lines. Horizontal scrolling stays native.

Editing:

- Typing, Enter, Backspace, Delete, Tab: the surface changes its cached lines at once, repaints, and sends
  `doc:edit`. It does not wait for the reply.
- A `lines` reply older than the newest local edit is thrown away and fetched again.
- Movement: arrows, Home, End, Page Up, Page Down, Ctrl+Home, Ctrl+End, with Shift to select. Click, drag,
  double-click for a word, Ctrl+A.
- Copy and cut ask `doc:text` for the selected range. Above 100 MB the user sees "That selection is too large to
  copy".
- Paste sends one `edit` with `kind: "paste"`.
- Undo and redo call the engine, then refetch the window and place the caret where the engine says.
- Input goes through a hidden one-pixel textarea, the same way `CodeSurface` handles focus and IME.

Not in `BigSurface`: multi-cursor, syntax colours, LSP, Emmet, lint, split view, minimap, git change marks,
bracket guides, replace. These arrive when piece 2 merges the two surfaces.

### `src/renderer/breeze/bigfile.ts` (new)

Wires a `large` buffer into the app:

- `loadBuffer` (`buffers.ts:106`) already gives such a file `kind: 'large'`. For that kind it now calls
  `api.doc.open`. On failure the existing note stays, with the reason added.
- `EditorBuffer` gains an optional `big` field: `{ doc, surface, lines, dirty, readOnly }`.
- `renderEditor` (`editor.ts:154`) shows the surface for a buffer that has `big`, where it showed the note.
- The tab's unsaved dot and the close prompt read `big.dirty`.
- Ctrl+S calls `doc:save`. A failure shows as a toast with the engine's message.
- The status bar shows line, column and the file size.
- Find: the existing find bar is reused. In a big file, Enter and Shift+Enter call `doc:find`, and the count comes
  from `doc:count` ("9999+" when capped). The replace row is hidden.
- Go to line works through the existing command.
- Closing the tab calls `doc:close`.
- `recovered: true` shows a toast: "Restored unsaved edits to <name>".
- On `fs:changed` for the file: ask `doc:changed`. If true and the buffer is clean, `doc:reload`. If true and it
  has unsaved edits, the next save asks with the editor's existing "changed on disk" prompt ("Use disk version" or
  "Overwrite").
- On `doc:down`: reopen every big buffer with `doc:open`. The journal brings back unsaved edits. The surface
  refetches its window and keeps its scroll position and caret.

Existing editing code for normal files is not changed. The only edits to existing files are the branches named
above, the `EditorBuffer` field, `tsconfig.json` (two new files) and `breeze.html` (two new script tags).

## Build and packaging

- `scripts/build-engine.js`: runs `cargo build --release` in `engine/` and copies the executable to `runtime/`.
- `package.json`: new scripts `build:engine` and `test:engine` (`cargo test` in `engine/`). `predist` also runs
  `build:engine`, so an installer always contains the engine.
- `runtime/**` is already in `files` and `asarUnpack`, so no packaging change is needed.
- `.gitignore`: add `engine/target/` and `runtime/breeze-engine.exe`.
- A fresh clone must run `npm run build:engine` once. Until then huge files show the "engine isn't built" note
  and everything else works as today.

## Errors

| Situation | What the user sees |
|---|---|
| Engine not built | The existing note, with "Run npm run build:engine" |
| File above 2 GB | The existing note, with "This file is larger than 2 GB" |
| File locked or unreadable | The existing note, with the system's reason |
| Not valid UTF-8 | The file opens for viewing; typing shows a one-time toast |
| Save fails (locked, disk full) | A toast with the reason; the file on disk is untouched; edits stay |
| Engine crashes | The view reloads from the restarted engine; unsaved edits come back from the journal |
| File changed on disk, no unsaved edits | The view reloads |
| File changed on disk, unsaved edits | The existing "changed on disk" prompt at the next save |

## Testing

Rust (`cargo test` in `engine/`):

- Open: line count, byte size, LF, CRLF, mixed endings, byte order mark, empty file, no trailing newline.
- `lines`: windows at the start, middle and end; a line above 10,000 units; non-ASCII and surrogate pairs.
- `edit`: insert, delete, replace, across lines; UTF-16 columns; new lines use the file's ending.
- Undo and redo: grouping of typing, no grouping across a newline or a paste, redo cleared by a new edit, the
  256 MB cap.
- Save: round trip is byte-identical for an unedited file; edits land; byte order mark kept; a failed rename
  leaves the original intact.
- Journal: edits replay after a simulated crash; a journal for a changed file is ignored.
- Invalid UTF-8: opens read-only, `edit` and `save` refused.
- Find and count: case, wrap, backward, a hit that spans rope chunks.
- A generated 200 MB file: open, read the last window, edit the first and last line, save, reopen and check.

Node (`test/engine.test.js`, run by `npm test`):

- Drives the real executable through `engine.js`: open, lines, edit, save, close.
- Kills the process mid-session and checks that `down` fires and the next request works.
- Skips with a printed reason when the executable has not been built.

In the app (manual, with a generated 200 MB log):

1. Open it. Scroll to the end with the slider and with Ctrl+End.
2. Type on line 1 and on the last line. Undo and redo.
3. Find a string near the end.
4. Save, close the tab, reopen, and check both edits are there.
5. End the engine process in Task Manager with unsaved edits. Check the view recovers them.

## Targets to measure

These are goals to check during the manual test, not promises:

- A 1 GB file opens in under 5 seconds from an SSD.
- A keystroke paints in the same frame, whatever the file size.
- Jumping to any line shows text in under 50 ms.
- Engine memory stays under 1.3 times the file size before edits.

## Out of scope

- Normal files (50 MB and below) using the engine: piece 2.
- Syntax colours in huge files: piece 3.
- Replace, multi-cursor, LSP, lint, Emmet, split view, minimap and git change marks in huge files: piece 2.
- Project-wide search (`fs:search`) and the file list in Rust.
- Files above 2 GB.
- macOS and Linux builds of the engine.
- Encodings other than UTF-8.
