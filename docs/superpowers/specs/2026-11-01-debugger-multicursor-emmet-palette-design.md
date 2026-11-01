# Debugger, Multi-Cursor, Emmet and Command Palette — Design

Date: 2026-11-01
Status: approved in chat, awaiting spec review

Four independent features that close the biggest gaps between Breeze Code and a full IDE. Each ships as its own
commit, in this order, smallest first: **Command Palette → Emmet → Multi-Cursor → Debugger**.

## Intent

- **Who:** Breeze's beginners first (students, first projects), without short-changing experienced developers.
- **Outcome:** a beginner can pause a Python or JS/TS program, see what every variable holds and step through it;
  everyone gets the everyday editing power (multi-cursor, Emmet, a command palette) they expect from VS Code.
- **Constraints:** stays light (no large downloads), Windows-first, follows the existing structure: one feature per
  `src/renderer/breeze/*.ts` file in the shared global scope, pure logic in testable modules, main-process work in
  `src/main/*.js` behind `preload.js`.
- **Success:** each feature works in the running app, has `node --test` coverage for its pure logic, and doesn't
  change the behaviour of anything that already works when the feature isn't in use.

---

## 1. Command Palette

**What:** Ctrl+Shift+P (and F1) opens a fuzzy-searchable list of every command in the app.

- **Source of commands:** `BAR_MENUS` in `commands.ts`. Each item with an `act` becomes an entry labelled
  `<Menu>: <Label>` (e.g. "Edit: Find in Files") with its `key` shown on the right. Items whose `enabled()` is false
  are hidden; `checked()` items show their state. Separators and non-action items are skipped.
- **Matching:** subsequence fuzzy match over the label, scored for consecutive runs and word starts; ties broken by
  recent use. Matched characters are highlighted.
- **Recent first:** the last 8 run commands (stored in `localStorage` under `breeze.palette.recent`, wrapped in
  try/catch) sit at the top when the query is empty.
- **Running:** Enter or click runs the entry through the same function the menu bar uses (`activateMenuItem` / the
  `act` dispatcher), so behaviour is identical to the menu.
- **Go to File bridge:** typing `>` as the first character in Ctrl+P switches that picker to the palette, with the
  rest of the text as the query.
- **UI:** reuses the Go to File quick-pick styling (same overlay, list, keyboard handling: ↑/↓, Enter, Esc).
- **New menu entry:** View → Command Palette… (Ctrl+Shift+P). The keyboard shortcut list in Help gains it.
- **Files:** `src/renderer/breeze/palette.ts` (new; UI + wiring), a pure `fuzzyScore` in `editcore.ts` (the no-DOM
  module the tests already load), `commands.ts` (menu entry, exported list of
  actions), `breeze.html` + `tsconfig.json` (script registration), `breeze.css` (minor).
- **Tests:** fuzzy scorer (ordering, highlights, empty query), action flattening from a sample menu tree.

## 2. Emmet (HTML and CSS)

**What:** Tab expands Emmet abbreviations in HTML-like and CSS-like files.

- **Engine:** the official `emmet` npm package (MIT, ~200 KB), added as a runtime dependency and run in the **main
  process** behind a new IPC handler `emmet:expand(abbr, syntax) → { text } | null`. The renderer has no bundler,
  so the package stays in main.
- **Syntaxes:** markup — `html`, `xml`, `jsx`/`tsx` (as `jsx`), `vue`, `svelte`; stylesheet — `css`, `scss`, `less`.
  Language comes from the existing `languages.ts` detection.
- **Extracting the abbreviation:** a pure function walks back from the caret on the current line to the start of a
  valid abbreviation (markup: letters, digits, `.#>+^*$@-:![]{}()=_`, quotes inside `[]`/`{}`; stylesheet: the word
  before the caret). Returns nothing when the caret is inside a string or comment (per the existing highlighter
  tokens) or inside a tag's attributes. To avoid turning ordinary words into tags, in markup a bare word with no
  Emmet operators (`.#>+^*[{(:`) only expands if it is a known HTML element or Emmet snippet name.
- **Tab behaviour:** Tab with a single cursor, no selection, and an expandable abbreviation → replace the abbreviation
  with the expansion, indented to the current line's indent, caret at the first `${0}`/`|` field (fields are then
  removed). Otherwise Tab behaves exactly as today (indent / autofill accept). Autofill's own Tab acceptance keeps
  priority when its popup is open.
- **Preview:** while typing in a supported file, if the text before the caret is an expandable abbreviation, the
  existing autofill popup shows one entry "Emmet: <first line of expansion>…"; Tab/Enter on it expands. Requests are
  debounced (~120 ms) and stale replies are dropped.
- **Undo:** one expansion = one history step (a single `replaceRange`).
- **Out of scope (v1):** tab-stop jumping between fields, wrap-with-abbreviation, Emmet actions (balance, etc.).
- **Files:** `package.json` (dependency), `src/main/emmet.js` (new; wraps the package), `main.js` (IPC),
  `preload.js` (`emmet.expand`), `src/renderer/breeze/emmet.ts` (new; extraction, Tab hook, preview),
  `editor.ts` (Tab key hook in `editorKeys`), `autofill.ts` (preview entry), `core.ts` (bridge type).
- **Tests:** abbreviation extraction (many cases incl. strings/comments/attributes), `src/main/emmet.js` expansion
  for a handful of HTML and CSS abbreviations, field/caret handling and indentation.

## 3. Multi-Cursor Editing

**What:** several carets/selections that all edit at once.

### Model

`CodeSurface` keeps its current selection as the **primary** (`selStart`/`selEnd`/`selDir` unchanged, so every
existing caller keeps working) and adds `extras: Sel[]` (anchor/head pairs). A public API:

- `get selections(): Sel[]` — primary + extras, sorted by position.
- `setSelections(sels: Sel[], primaryIndex)` — normalises: sorts, merges overlapping/touching ranges, clamps.
- `addSelection(sel)`, `clearExtras()`, `get multi(): boolean`.
- Any call to the existing `setSelectionRange` from app code clears the extras (single-cursor semantics for every
  existing feature: go to line, find, LSP jumps, etc.).

Pure helpers live in `editcore.ts`: `normalizeSels`, `applyMultiEdit(text, sels, replacer) → { text, sels, edit }`
(builds the new text and the mapped selections in one pass from the end backwards), `moveSels` (runs the existing
`moveCaret` on each), `deleteSels` (runs `deleteSpan` on each), `nextOccurrence(text, sels)`.

### Gestures and keys

| Action | Input |
| --- | --- |
| Add a caret | Alt+Click |
| Add next occurrence of the selection (or select the word under the caret first) | Ctrl+D |
| Select all occurrences | Ctrl+Shift+L |
| Add caret on the line above / below | Ctrl+Alt+Up / Ctrl+Alt+Down |
| Column (box) selection | Shift+Alt+drag |
| Back to one cursor | Esc (keeps the primary) |

(Ctrl+Alt+K/L/J stay with marks; Alt+Up/Down stay as Move Line.)

### Editing with several cursors

- Typing, Enter, Tab, Backspace, Delete (incl. Ctrl variants), arrows, Home/End, Shift-extend, Ctrl+A (collapses to
  one selection of everything) all apply to every selection.
- **Copy/cut:** non-empty selections joined by `\n`; empty selections contribute nothing, and if all are empty
  nothing is copied (matching today's single-cursor behaviour).
- **Paste:** if the clipboard has exactly as many lines as there are cursors, line *i* goes to cursor *i*; otherwise
  the whole text goes to every cursor.
- **One undo step:** the whole multi-edit is dispatched as one `beforeinput`/`input` pair; the app's history records
  the text before and after as it does now (`textEdit` reduces it to one span covering all changes).
- **Smart keys only with one cursor:** auto-pairing, auto-indent on Enter, closing tags, Emmet, autofill, LSP
  completion run only when `!multi`. With several cursors, keys do the plain thing at each caret.
- **IME composition** with several cursors commits to the primary only and then clears extras (rare; keeps IME safe).

### Painting

`paint()` draws selection boxes and a caret element for every selection in the visible window (caret elements
pooled). The hidden input follows the primary. Status bar shows "N selections" when `multi`.

### Files and tests

`editcore.ts` (pure helpers), `codeview.ts` (model, keys, pointer gestures, painting), `editor.ts` (Esc handling,
Ctrl+D / Ctrl+Shift+L / Ctrl+Alt+Up/Down commands, smart-key guards, status), `commands.ts` (Selection menu entries
+ shortcut list), `breeze.css` (extra caret style). Tests in `test/editcore.test.js`: normalise/merge, multi-edit
offset mapping (inserts, deletes, mixed lengths), moves, next-occurrence wrap-around, paste distribution.

## 4. Debugger (Python and JavaScript/TypeScript)

### Architecture

One main-process module exposes a single **debug-session API** to the renderer, with two backends:

```
renderer/breeze/debug.ts  ──IPC──▶  main/debug.js (DebugManager: one session at a time)
                                          ├─ main/dap.js   — DAP client over TCP  ──▶ debugpy (Python)
                                          └─ main/cdp.js   — Chrome DevTools Protocol over WebSocket ──▶ node --inspect-brk
```

- **Breeze launches the program itself**, so it owns stdin/stdout/stderr: `input()` and `readline` work via the
  Output panel's input line.
  - **Python:** `python -m debugpy --listen 127.0.0.1:<free port> --wait-for-client <file>`, cwd = project root,
    Python found via the existing toolchain lookup. Then DAP `initialize` → `attach` → `setBreakpoints` /
    `setExceptionBreakpoints` → `configurationDone`.
  - **JS/TS:** `node --inspect-brk=127.0.0.1:0 <file>` (TS adds `--experimental-strip-types` when needed; Node
    ≥ 22.18 strips types without moving positions). The WebSocket URL is read from the "Debugger listening on ws://…"
    stderr line. Uses Electron's global `WebSocket`. `Debugger.enable`, `Runtime.enable`,
    `Debugger.setBreakpointByUrl` per breakpoint, `Runtime.runIfWaitingForDebugger`. The first `--inspect-brk` pause
    is auto-resumed unless the user chose "Stop on entry".
  - Older Node for a `.ts` file → a clear message ("Debugging TypeScript needs Node 22.18 or newer") with the
    install hint pattern from `toolchains.js`.
- **Normalised session API** (both backends implement it; renderer never sees DAP or CDP):
  - commands: `start({ file, stopOnEntry })`, `stop()`, `restart()`, `pause()`, `continue()`, `stepOver()`,
    `stepInto()`, `stepOut()`, `runToLine(file, line)`, `setBreakpoints(file, bps[])`, `setExceptionMode('none' |
    'uncaught' | 'all')`, `stack()`, `scopes(frameId)`, `children(ref)`, `evaluate(expr, frameId, context: 'watch' |
    'repl' | 'hover')`, `setValue(ref, name, value)`, `stdin(text)`.
  - events to renderer: `state` (`starting | running | paused | stopped`), `paused { reason, file, line, frames,
    exception? }`, `output { stream: 'stdout' | 'stderr' | 'console', text }`, `breakpoints { file, verified[] }`
    (resolved lines), `exited { code }`, `error { message, hint? }`.
  - Values are `{ name, value, type, ref }` where `ref > 0` means expandable; children fetched lazily.
- **Breakpoint kinds:** plain, conditional (`condition`), hit count (`hitCondition`, e.g. `>= 3`), logpoint
  (`logMessage` with `{expr}` interpolation). DAP passes these natively; CDP gets a generated condition
  (`(cond) && ++__bzHit[id] >= n`, logpoints as `console.log(...), false`).
- **Paths:** only files inside the open project; checked with the existing `pathguard`/`resolveIn` pattern.
- **Missing debugpy:** `python -m debugpy --version` fails → the error event carries a hint; the debug page offers a
  button that runs `python -m pip install debugpy` in the IDE terminal (existing terminal API), then retries.
- **Lifecycle:** one session at a time; stopping kills the process tree; closing the folder or the window stops the
  session. Agent runs and the normal F5 run are unaffected.

### Full-page debug view

A new screen `#debug` shown with the existing `swapScreen` (like Breeze Box), not a persisted `WorkMode`. Leaving it
("← Back to editor") returns to the IDE; the session keeps running and a slim "Debugging app.py — paused · Open"
bar shows in the IDE status bar.

Layout (resizable splitters, sizes remembered per user):

- **Toolbar:** Continue/Pause, Step Over, Step Into, Step Out, Restart, Stop · file name and state · "← Back to
  editor". Buttons show their shortcuts in tooltips.
- **Left column:** **Call Stack** (frames with file:line; click selects a frame, which drives Variables, Watch,
  hover and the console's evaluation scope) and **Breakpoints** (list with checkboxes to enable/disable, click to
  jump, right-click to edit condition/hit count/log message or remove; plus "Uncaught exceptions" and "All
  exceptions" toggles; "Remove all").
- **Centre:** **read-only source** of the selected frame's file using `CodeSurface` + the existing highlighter
  (read-only: input disabled, selection and copy allowed). Paused line highlighted and scrolled into view; gutter
  shows breakpoints (click toggles; right-click edits), unverified breakpoints hollow. Hovering an identifier while
  paused shows its value (`evaluate(…, 'hover')`). Right-click a line → "Run to here". Exception pauses show an
  inline banner with the message.
- **Right column:** **Variables** (scopes as an expandable tree — Locals open, Globals closed; values changed since
  the last pause flash; double-click a value to edit via `setValue`) and **Watch** (add, edit, remove expressions;
  re-evaluated on every pause and frame change; errors shown inline).
- **Bottom tabs:** **Debug Console** (REPL: evaluate in the selected frame, history with ↑/↓, results as expandable
  values) and **Output** (program stdout/stderr, with an input line that sends to stdin).
- **Empty / error states:** "Not running — press F5 to start" with the current file; clear error cards with the hint
  and a fix button where one exists.

### Breakpoints in the IDE

- F9 toggles a breakpoint on the caret line; clicking a line number in the IDE gutter toggles one (the existing mark
  dot keeps its job). Breakpoints render as red dots in the gutter, survive edits by shifting with lines (same
  approach as marks), and are saved per project in `localStorage` (`breeze.breakpoints:<root>`, try/catch).
- Changes during a session are sent to the backend immediately.

### Commands and keys

- Run menu: **Start Debugging** (Ctrl+Shift+D), Stop Debugging, Restart, Continue, Step Over/Into/Out,
  Toggle Breakpoint (F9), Open Debug View. All also in the Command Palette.
- On the debug page: F5 Continue, F6 Pause, F10 Step Over, F11 Step Into, Shift+F11 Step Out, Ctrl+Shift+F5
  Restart, Shift+F5 Stop. In the IDE, F5 keeps its current meaning (run file / preview); while a debug session is
  paused, F5 continues.
- Debuggable file = active file is `.py`, `.js`, `.mjs`, `.cjs` or `.ts`/`.mts`. Otherwise Start Debugging explains
  which languages are supported.

### Files

- New: `src/main/debug.js` (DebugManager, launch, process tree kill), `src/main/dap.js` (DAP framing + client),
  `src/main/cdp.js` (CDP client + adapter to the normalised API), `src/renderer/breeze/debug.ts` (view, panels,
  breakpoints store), `test/dap.test.js`, `test/cdp.test.js`, `test/debug.test.js`.
- Changed: `main.js` (IPC handlers, stop on folder close/quit), `preload.js` (`debug` bridge), `core.ts` (types),
  `editor.ts` (gutter breakpoints, F9, line shifting), `commands.ts` (menu + keys), `breeze.html` (`#debug` screen,
  script tag), `breeze.css` (debug view styles), `tsconfig.json` (new file).

### Testing

- **Unit (`node --test`):** DAP message framing (split/merged chunks, Content-Length), request/response matching,
  event dispatch; CDP → normalised mapping (paused event → frames, remote objects → values, condition generation for
  hit counts/logpoints); breakpoint line shifting; Node version gate.
- **Integration (`node --test`, skipped when the tool is missing):** debug a tiny `.js` file with real Node — break
  on a line, read a local, step over, evaluate, finish; same for Python when `debugpy` is installed.
- **In-app check:** run the app, debug a small Python and JS program through the full page (breakpoint, step, watch,
  console, stdin input, exception pause).

## Out of scope (all features)

Debugging C/C++/Rust/C#/Java, launch configuration files, attaching to an already-running process, multiple
simultaneous debug sessions, editing code on the debug page, Emmet tab-stops and wrap, palette commands beyond the
menu actions, multi-cursor "skip occurrence".
