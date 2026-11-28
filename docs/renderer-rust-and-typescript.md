# Renderer: Rust and TypeScript responsibilities

In Breeze, **the renderer** is the Electron page: the HTML, CSS, and TypeScript that the user sees and interacts with. Rust supports that renderer by owning document data and doing text-heavy work efficiently. Rust does **not** directly draw pixels, HTML, CSS, or editor controls.

## Rust: document engine

The Rust sidecar in [`engine/`](../engine/) is the document engine. It is used for work that should stay fast and memory-conscious even when a file is very large.

- Opens text files and keeps their contents in a rope data structure.
- Applies edits, normalizes line endings, tracks whether a document is dirty, and saves safely.
- Maintains undo/redo history and an on-disk journal for recovery.
- Searches and counts matches without copying the complete file into the UI process.
- Runs the quick structural checks behind the red error lines (`engine/src/lint/`: brackets, strings, comments, tags, JSON, CSS, Python and Rust).
- Supplies a requested range of lines to the app, truncating exceptionally long lines when appropriate.
- Enforces document limits and read-only behavior for files that cannot be edited as UTF-8.

The Rust engine communicates through JSON-lines requests (`open`, `lines`, `edit`, `undo`, `redo`, `text`, `find`, `count`, `lint`, `save`, `changed`, `reload`, `close`). It runs outside the renderer, so a large document does not need to be fully held by the web page.

Every text file uses it now. A file above the page's read limit opens only in the engine (`bigfile.ts`, `bigsurface.ts`). A normal file up to 50 MB is also kept in the page as `b.text`, and each edit is sent to the engine too (`docsync.ts`, `doccore.ts`); a file the engine can't edit (not UTF-8, or with a lone `\r`) stays on the page-only path.

## TypeScript: visible, interactive renderer

The TypeScript in [`src/renderer/`](../src/renderer/) runs in Electron's renderer process. It creates and updates the interface using the DOM, HTML, and CSS.

- Builds the editor, tabs, sidebars, panels, menus, dialogs, terminal, and other app views.
- Receives keyboard, mouse, clipboard, IME, focus, scroll, resize, and accessibility events.
- Maps selections, cursor movement, and editor commands to document edits.
- Requests document content from the Rust engine through the preload/main-process bridge, then keeps the editor view in sync.
- Virtualizes the editor surface: it lays out and paints only the lines near the viewport instead of creating DOM for every line in a large file.
- Draws editor details such as the caret, selection rectangles, and visible text; CSS handles their appearance.
- Handles UI-only behavior such as syntax decorations, command menus, notifications, workspace views, and animations.

`editcore.ts` contains editor position logic without DOM access, while `codeview.ts` implements the virtualized, textarea-shaped editing surface.

## What belongs in Rust for performance

The most useful candidates are existing TypeScript code that repeatedly scans an entire normal-sized file.

Done so far:

- **Normal files share the engine** (`docsync.ts`), as described above.
- **Error checks.** The checkers from `languages.ts` were ported to `engine/src/lint/` and run through the `lint` request (`buffers.ts`). `languages.ts` keeps them as the fallback for a file the engine doesn't hold, and `test/lintengine.test.js` keeps the two in step.
- **Find.** For an engine-backed file, find asks the engine for every hit (`doc:findAll`, `engineFind` in `editor.ts`) and checks them against `b.text`; the page searches itself only when that fails.

Still in TypeScript:

| Priority | Existing Breeze code | Rust replacement | Why it can help |
| --- | --- | --- | --- |
| High | `src/renderer/breeze/languages.ts`: `fullToks`, `relex`, `scanCode` | A lexer that returns token spans for requested lines | These regex-scan and slice the whole document to colour code, in the renderer, whenever highlighting needs updating. |
| Medium | `src/renderer/breeze/editor.ts`: `replaceAll` | One engine-side, undoable replace-all edit | Replace all still rebuilds the string in the renderer and sends the result as an edit. |
| Medium | `src/renderer/editcore.ts`: line-start scanning, edit-span comparison, and position calculations | Engine-owned line index and position/range APIs | These operations are correct in TypeScript, but they duplicate facts Rust can keep beside the rope. This matters most after every open file is engine-backed. |
| Medium | `src/renderer/bigcore.ts`: `LineCache.apply`, newline counting, and split/rejoin work | Let Rust return revised line windows after an edit | The current cache is small and useful, but it mirrors document-edit logic in JavaScript. Rust can make the cache authoritative and reduce duplicated string work. |
| Later | `src/renderer/breeze/docview.ts`: `dfParse` and Office XML parsing | Background Rust/XML parsing that returns a document-view model | This can help with very large `.docx`, `.pptx`, or `.xlsx` files, but it is a larger feature because the TypeScript view relies on browser DOM XML objects. |

### Next changes

Normal files are on the engine, but the page still keeps and scans its own full copy for highlighting and positions. The highest-value additions now are:

1. `tokens(doc, firstLine, lineCount)` returning compact syntax-token spans for a visible line range.
2. `replaceAll(doc, query, replacement, options)` performing one engine-side undoable edit.
3. Position and line-index operations exposed by document id instead of recomputing them from a renderer-owned string.

TypeScript should still convert these results into HTML spans, gutter markers, selection boxes, and the caret. Moving DOM construction or input handling to Rust would not improve rendering performance because Chromium must do that work in the renderer.

## How a text edit reaches the screen

1. The user types, pastes, or selects text in the TypeScript editor surface.
2. TypeScript works out the edit and sends it through the trusted Electron bridge.
3. The main process forwards the request to the Rust document engine.
4. Rust updates the rope and its undo/journal state, then reports the result.
5. TypeScript requests or updates the affected visible lines and redraws the DOM layers for the text, selection, and caret.

## Short version

| Layer | Main job |
| --- | --- |
| Rust engine | Stores, edits, searches, journals, and saves document text efficiently. |
| TypeScript renderer | Shows the app, accepts input, and renders the visible editor and UI. |

This split lets Breeze keep the user interface responsive while the document layer handles files that would be expensive to load and redraw in full.
