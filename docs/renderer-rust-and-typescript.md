# Renderer: Rust and TypeScript responsibilities

In Breeze, **the renderer** is the Electron page: the HTML, CSS, and TypeScript that the user sees and interacts with. Rust supports that renderer by owning document data and doing text-heavy work efficiently. Rust does **not** directly draw pixels, HTML, CSS, or editor controls.

## Rust: document engine

The Rust sidecar in [`engine/`](../engine/) is the document engine. It is used for work that should stay fast and memory-conscious even when a file is very large.

- Opens text files and keeps their contents in a rope data structure.
- Applies edits, normalizes line endings, tracks whether a document is dirty, and saves safely.
- Maintains undo/redo history and an on-disk journal for recovery.
- Searches and counts matches without copying the complete file into the UI process.
- Supplies a requested range of lines to the app, truncating exceptionally long lines when appropriate.
- Enforces document limits and read-only behavior for files that cannot be edited as UTF-8.

The Rust engine communicates through JSON-lines requests. It runs outside the renderer, so a large document does not need to be fully held by the web page.

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

The most useful candidates are existing TypeScript code that repeatedly scans an entire normal-sized file. The huge-file path already uses the Rust engine, so the next performance gain is to extend that same model to normal files without moving the browser UI.

| Priority | Existing Breeze code | Rust replacement | Why it can help |
| --- | --- | --- | --- |
| High | `src/renderer/breeze/languages.ts`: `fullToks`, `relex`, `scanCode`, `JsonChecker`, `PythonChecker`, and `MarkupChecker` | A document-aware lexer/parser that returns token spans and diagnostics for requested lines | These functions regex-scan and slice the whole document to colour code and find simple mistakes. They currently run in the renderer whenever highlighting needs updating. |
| High | `src/renderer/breeze/editor.ts`: `runFind`, `replaceAll`, `allOccurrences`, and normal-file find highlighting | Extend the engine's existing `find`, `count`, and edit protocol to normal files | The Rust engine already performs rope-based search for huge files. Normal files still use `toLowerCase`, `indexOf`, arrays of up to 20,000 offsets, and string rebuilding in the renderer. |
| Medium | `src/renderer/editcore.ts`: line-start scanning, edit-span comparison, and position calculations | Engine-owned line index and position/range APIs | These operations are correct in TypeScript, but they duplicate facts Rust can keep beside the rope. This matters most after every open file is engine-backed. |
| Medium | `src/renderer/bigcore.ts`: `LineCache.apply`, newline counting, and split/rejoin work | Let Rust return revised line windows after an edit | The current cache is small and useful, but it mirrors document-edit logic in JavaScript. Rust can make the cache authoritative and reduce duplicated string work. |
| Later | `src/renderer/breeze/docview.ts`: `dfParse` and Office XML parsing | Background Rust/XML parsing that returns a document-view model | This can help with very large `.docx`, `.pptx`, or `.xlsx` files, but it is a larger feature because the TypeScript view relies on browser DOM XML objects. |

### Best first change: share the Rust engine with normal files

The clearest first project is to move **normal text files** onto the existing Rust document engine, then request only the lines and token spans that are visible. This removes the need for the renderer to keep and repeatedly scan a second full copy of each file.

The engine already has the foundations for this: rope storage, edits, undo/redo, paged line reads, search, count, and save. The highest-value additions would be:

1. `tokens(doc, firstLine, lineCount)` returning compact syntax-token spans for a visible line range.
2. `diagnostics(doc, changedRange)` returning parser/checker warnings asynchronously.
3. `replaceAll(doc, query, replacement, options)` performing one engine-side undoable edit.
4. Position and line-index operations exposed by document id instead of recomputing them from a renderer-owned string.

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
