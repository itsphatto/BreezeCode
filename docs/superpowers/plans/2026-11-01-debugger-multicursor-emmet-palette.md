# Debugger, Multi-Cursor, Emmet and Command Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Command Palette, Emmet for HTML/CSS, multi-cursor editing and a full-page Python + JS/TS debugger to Breeze Code.

**Architecture:** Pure, DOM-free logic goes in `src/renderer/editcore.ts` (already loaded by tests through `vm` +
`stripTypeScriptTypes`) or in `src/main/*.js` CommonJS modules; UI lives in one `src/renderer/breeze/<feature>.ts`
file per feature in the shared global scope. Main-process features are reached through `handle()` in `main.js` and a
bridge in `preload.js`. The debugger is one `DebugManager` in main with a DAP backend (debugpy) and a CDP backend
(Node inspector) behind one normalised API.

**Tech Stack:** Electron 44 (Node 24 in main, global `WebSocket`), TypeScript 7 (`tsc`, no bundler), `node --test`,
`emmet` npm package, debugpy, Node inspector protocol.

**Spec:** `docs/superpowers/specs/2026-11-01-debugger-multicursor-emmet-palette-design.md`

## Global Constraints

- Build order and one commit (or more) per task: Palette → Emmet → Multi-cursor → Debugger. Work on branch `feat/ide-gaps`, never directly on `main`.
- No new runtime dependency except `emmet`. No downloads at debug time; the debugger uses debugpy (pip) and the user's Node.
- Every new renderer `.ts` file is added to `tsconfig.json` `files` **and** a `<script src="breeze/<name>.js" defer>` in `breeze.html`, placed before `views.js`.
- Every `localStorage` read/write goes through the existing `store` helper or is wrapped in try/catch.
- Keys (exact): Palette Ctrl+Shift+P and F1. Multi-cursor Alt+Click, Ctrl+D, Ctrl+Shift+L, Ctrl+Alt+Up, Ctrl+Alt+Down, Shift+Alt+drag, Esc. Debugger Ctrl+Shift+D start, F9 toggle breakpoint, debug page F5 continue, F6 pause, F10 over, F11 into, Shift+F11 out, Ctrl+Shift+F5 restart, Shift+F5 stop. Existing keys keep their meaning (F5 run, Alt+Up/Down move line, Ctrl+Alt+K/L/J marks).
- New menu items carry `act` + `key` in `MENUS` (`commands.ts`) so `DEFAULT_KEYS`/`keyBinds` pick them up and they appear in the palette and Controls list automatically.
- Debuggable files: `.py`, `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`. TypeScript needs Node ≥ 22.18 (or ≥ 23.6 on the 23 line); message: "Debugging TypeScript needs Node 22.18 or newer".
- Copy follows PRODUCT.md voice: plain words, short sentences, no jargon a beginner would trip on.
- `npm test` and `npx tsc` must pass at the end of every task.

## Review Focus

1. **Paths with spaces** (the repo itself lives in `…\Desktop\Breeze Code`): breakpoints must still bind for both backends → test in Task 10 (`fileUrl` encodes spaces) and Task 11 integration test runs from a folder with a space.
2. **Program ends or crashes before any pause** (syntax error, exits at once, script not found): session reaches `stopped` with the exit code and the stderr in Output, never stuck on "starting" → test in Task 11.
3. **Stop pressed while still starting** (before DAP/CDP connects): process tree killed, no orphan python/node left → test in Task 11.
4. **Several cursors on one line, and cursors that collide after Backspace** (`a|b|c` + Backspace twice): offsets map correctly and carets merge into one → tests in Task 6.
5. **Tab after a normal CSS value** (`color: red|` or `  margin: 0 auto|`): must indent/accept autofill, not expand `red` into a property → test in Task 4.

---

## Part A — Command Palette

### Task 1: Fuzzy scorer

**Files:**
- Modify: `src/renderer/editcore.ts` (append)
- Test: `test/editcore.test.js` (add to the `vm.runInContext` destructuring list and add tests)

**Interfaces:**
- Produces: `fuzzyScore(label: string, query: string): { score: number; hits: number[] } | null` — case-insensitive subsequence match; `hits` are matched character indices in `label`; empty query → `{ score: 0, hits: [] }`; no match → `null`. Scoring: +1 per hit, +5 per hit that follows the previous hit directly, +8 per hit at a word start (index 0, or after space, `:`, `.`, `-`, `_`, `/`, or a lower→upper case change).

- [ ] **Step 1: Write failing tests**

```js
test('fuzzyScore matches subsequences and prefers word starts and runs', () => {
  assert.equal(fuzzyScore('Edit: Find in Files', 'xyz'), null);
  assert.deepEqual(plain(fuzzyScore('Edit: Find', '')), { score: 0, hits: [] });
  assert.deepEqual(plain(fuzzyScore('Edit: Find in Files', 'fif')).hits, [6, 11, 14]);
  assert.ok(fuzzyScore('View: Terminal', 'term').score > fuzzyScore('Edit: Toggle Breakpoint Menu', 'term').score);
  assert.ok(fuzzyScore('Go to File', 'GTF').score > 0); // case-insensitive
});
```

- [ ] **Step 2: Run** `node --test test/editcore.test.js` — Expected: FAIL (`fuzzyScore is not defined`).
- [ ] **Step 3: Implement `fuzzyScore`** in `editcore.ts`. Greedy left-to-right, but prefer a word-start occurrence of the next query char when one exists before the next plain occurrence's run would break (simple greedy over word starts first, then any char, is enough to satisfy the tests).
- [ ] **Step 4: Run** `node --test test/editcore.test.js` and `npx tsc` — Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `git commit -m "feat(palette): add fuzzy scorer"`

### Task 2: Command Palette UI

**Files:**
- Create: `src/renderer/breeze/palette.ts`
- Modify: `src/renderer/breeze/commands.ts` (View menu item; `'view.palette'` in `commands`), `src/renderer/breeze/editor.ts:1270-1294` (`quickOpen`: `>` switches to palette), `src/renderer/breeze.html`, `tsconfig.json`, `src/renderer/breeze.css` (`.qo-item mark` highlight)

**Interfaces:**
- Consumes: `fuzzyScore` (Task 1); `MENUS`, `MenuItem`, `activateMenuItem(it)` from `commands.ts`; `openModal`/`closeModal`; `store`.
- Produces: `openPalette(query = ''): void`; `paletteEntries(): { label: string; key: string; item: MenuItem }[]` (from **all** `MENUS`, not `BAR_MENUS`; label `"<Menu name>: <item.label>"`; skip items without `act`, without `label`, or with `enabled?.() === false`; de-dupe by `act`; `key` is the current binding from `keyBinds[act] ?? item.key ?? ''`); recent list key `breeze.palette.recent` (max 8 acts, most recent first).

- [ ] **Step 1: Add menu item** `{ label: 'Command Palette…', act: 'view.palette', key: 'Ctrl+Shift+P' }` at the top of the View menu and `'view.palette': () => openPalette()` in `commands`. Also bind F1 to the same act (second item in Help menu `{ label: 'Show All Commands', act: 'view.paletteF1', key: 'F1' }` → `openPalette()`).
- [ ] **Step 2: Implement `palette.ts`** reusing `quickOpen`'s modal markup and classes (`#qoIn`, `.qo-list`, `.qo-item`, `.on`): rows show the label with `hits` wrapped in `<mark>` and the key in `<small>`; empty query lists recents then the rest alphabetically; ↑/↓/Enter/Esc as in `quickOpen`; Enter/click → `closeModal()`, push act to recents, `activateMenuItem(item)`.
- [ ] **Step 3: Go to File bridge** — in `quickOpen`'s `input.oninput`, if `input.value.startsWith('>')`, `closeModal()` then `openPalette(input.value.slice(1))`.
- [ ] **Step 4: Register** `palette.ts` in `tsconfig.json` and `breeze.html`; run `npx tsc && npm test` — Expected: PASS.
- [ ] **Step 5: Verify in app** (`npm start`): Ctrl+Shift+P opens the list; typing `fif` puts "Edit: Find in Files" first with highlighted letters; Enter runs it; reopening shows it under recents; F1 opens it; Ctrl+P then `>term` lands in the palette filtered to terminal commands; disabled commands (e.g. Save with no file) are absent.
- [ ] **Step 6: Commit** `git commit -m "feat: add Command Palette (Ctrl+Shift+P)"`

---

## Part B — Emmet

### Task 3: Emmet engine in main

**Files:**
- Modify: `package.json` (add `"dependencies": { "emmet": "<latest 2.x>" }`; ensure electron-builder `files` ships `node_modules/emmet` — it does by default for `dependencies`), `src/main/main.js` (handler), `src/main/preload.js` (bridge), `src/renderer/breeze/core.ts` (bridge type)
- Create: `src/main/emmet.js`
- Test: `test/emmet.test.js`

**Interfaces:**
- Produces: `src/main/emmet.js` exports `expandAbbr(abbr: string, syntax: 'html'|'xml'|'jsx'|'vue'|'svelte'|'css'|'scss'|'less'): string | null` — returns the expansion with fields written as `${N}` / `${N:placeholder}`, or `null` when emmet throws or returns the input unchanged. Uses `expand(abbr, { syntax, type: markup|stylesheet, options: { 'output.field': (i, p) => p ? '${' + i + ':' + p + '}' : '${' + i + '}' } })`.
- IPC: `handle('emmet:expand', (_e, abbr, syntax) => expandAbbr(String(abbr).slice(0, 500), syntax))`; preload `emmet: { expand: (abbr, syntax) => invoke('emmet:expand', abbr, syntax) }`; core type `emmet: { expand(abbr: string, syntax: string): Promise<string | null> }`.

- [ ] **Step 1: Install** `npm install emmet` and confirm `require('emmet')` works in Node.
- [ ] **Step 2: Write failing tests**

```js
const { expandAbbr } = require('../src/main/emmet');
test('expands markup', () => {
  assert.equal(expandAbbr('ul>li.item*2', 'html'), '<ul>\n\t<li class="item">${1}</li>\n\t<li class="item">${2}</li>\n</ul>');
  assert.match(expandAbbr('a:link', 'html'), /^<a href="\$\{1:http:\/\/\}">\$\{2\}<\/a>$/);
});
test('expands stylesheet', () => {
  assert.equal(expandAbbr('m10', 'css'), 'margin: 10px;');
  assert.equal(expandAbbr('df', 'css'), 'display: flex;');
});
test('returns null on garbage', () => { assert.equal(expandAbbr('ul>>>', 'html'), null); });
```
(Adjust only exact whitespace/field strings to what emmet 2.x actually emits; the shapes above are the contract.)

- [ ] **Step 3: Run** `node --test test/emmet.test.js` — Expected: FAIL (module missing).
- [ ] **Step 4: Implement** `src/main/emmet.js`, the handler, preload and core type.
- [ ] **Step 5: Run** `npm test && npx tsc` — Expected: PASS.
- [ ] **Step 6: Commit** `git commit -m "feat(emmet): expand abbreviations in the main process"`

### Task 4: Abbreviation extraction and insertion (pure)

**Files:**
- Modify: `src/renderer/editcore.ts` (append), `test/editcore.test.js`

**Interfaces:**
- Produces:
  - `emmetAbbrBefore(line: string, col: number, kind: 'markup' | 'stylesheet'): { abbr: string; start: number } | null` — `start` is the column where the abbreviation begins. Markup: scan back over `[A-Za-z0-9.#>+^*$@\-:!_=%]`, balanced `[...]`, `{...}`, `(...)`; stop at whitespace or `<`/`>` that belongs to a tag. Return `null` if the caret is inside an open tag (`openTagAt` already exists), if the abbr is empty, or if it is a bare word (no `.#>+^*[{(:!`) not in `EMMET_WORDS`. Stylesheet: the run of `[A-Za-z0-9\-:!#.%]` before the caret, and only when everything before `start` on the line is whitespace or ends with `{` or `;`.
  - `EMMET_WORDS: Set<string>` — HTML element names plus `!`, `lorem`, `link:css`-style snippet heads Emmet knows (`a`, `div`, `span`, `p`, `ul`, `ol`, `li`, `img`, `input`, `button`, `form`, `table`, `tr`, `td`, `th`, `section`, `header`, `footer`, `nav`, `main`, `article`, `aside`, `h1`–`h6`, `label`, `select`, `option`, `textarea`, `script`, `style`, `link`, `meta`, `br`, `hr`, `canvas`, `video`, `audio`, `iframe`, `svg`, `lorem`, `!`).
  - `emmetInsert(expansion: string, indent: string): { text: string; caret: number }` — prefixes every line after the first with `indent`, replaces `${N:ph}` with `ph` and `${N}` with ``, caret = position of the lowest-numbered field in the result (end of text when no fields).
- Note: string/comment detection is **not** done here; Task 5 checks the highlighter token at the caret.

- [ ] **Step 1: Write failing tests**

```js
test('emmetAbbrBefore markup', () => {
  assert.deepEqual(plain(emmetAbbrBefore('  ul>li.item*3', 14, 'markup')), { abbr: 'ul>li.item*3', start: 2 });
  assert.deepEqual(plain(emmetAbbrBefore('div[title="a b"]', 16, 'markup')), { abbr: 'div[title="a b"]', start: 0 });
  assert.equal(emmetAbbrBefore('hello', 5, 'markup'), null);              // bare non-tag word
  assert.equal(emmetAbbrBefore('<div class', 10, 'markup'), null);        // inside a tag
  assert.deepEqual(plain(emmetAbbrBefore('text section', 12, 'markup')), { abbr: 'section', start: 5 });
});
test('emmetAbbrBefore stylesheet', () => {
  assert.deepEqual(plain(emmetAbbrBefore('  m10', 5, 'stylesheet')), { abbr: 'm10', start: 2 });
  assert.deepEqual(plain(emmetAbbrBefore('a { df', 6, 'stylesheet')), { abbr: 'df', start: 4 });
  assert.equal(emmetAbbrBefore('  color: red', 12, 'stylesheet'), null);  // Review Focus 5
  assert.equal(emmetAbbrBefore('  margin: 0 auto', 16, 'stylesheet'), null);
});
test('emmetInsert indents and places the caret on the first field', () => {
  assert.deepEqual(plain(emmetInsert('<ul>\n\t<li>${1}</li>\n</ul>', '  ')), { text: '<ul>\n  \t<li></li>\n  </ul>', caret: 12 });
  assert.deepEqual(plain(emmetInsert('<a href="${1:http://}">${2}</a>', '')), { text: '<a href="http://"></a>', caret: 9 });
  assert.deepEqual(plain(emmetInsert('margin: 10px;', '')), { text: 'margin: 10px;', caret: 13 });
});
```

- [ ] **Step 2: Run** `node --test test/editcore.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** the three exports.
- [ ] **Step 4: Run** `node --test test/editcore.test.js && npx tsc` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(emmet): find and insert abbreviations"`

### Task 5: Emmet in the editor (Tab + preview)

**Files:**
- Create: `src/renderer/breeze/emmet.ts`
- Modify: `src/renderer/breeze/editor.ts:1059-1061` (Tab branch of `editorKeys`), `src/renderer/breeze/autofill.ts` (`editorSuggest` adds the preview entry), `breeze.html`, `tsconfig.json`

**Interfaces:**
- Consumes: `api.emmet.expand` (Task 3); `emmetAbbrBefore`, `emmetInsert` (Task 4); `replaceRange(ta, start, end, text, selStart, selEnd)` (`editor.ts:923`); language id of a buffer from `languages.ts`.
- Produces: `emmetSyntaxOf(b: EditorBuffer): string | null` (maps the buffer's language to an emmet syntax or `null`); `emmetCandidate(b: EditorBuffer, ta: CodeSurface): { start: number; end: number; abbr: string; syntax: string } | null` (sync: single cursor, empty selection, supported syntax, caret token not string/comment, `emmetAbbrBefore` hit); `async tryEmmet(b: EditorBuffer, ta: CodeSurface): Promise<boolean>` (expands and inserts; returns false when nothing expanded); `emmetPreview(b, ta): Promise<string | null>` (debounced 120 ms, drops stale replies by comparing `ta.value`/caret before applying).

- [ ] **Step 1: Implement `emmet.ts`.** Insertion: `const { text, caret } = emmetInsert(expansion, indentOfLine)`; `replaceRange(ta, start, end, text, start + caret, start + caret)` — one history step.
- [ ] **Step 2: Hook Tab.** In `editorKeys`, before `indentKey`: if `!e.shiftKey && b && emmetCandidate(b, ta)` then `e.preventDefault()` and `void tryEmmet(b, ta).then(ok => { if (!ok) indentKey(ta, false); })`. `suggestKeys` already runs earlier, so an open autofill popup keeps Tab priority.
- [ ] **Step 3: Preview.** In `editorSuggest`, when `emmetCandidate` is non-null, prepend a suggestion labelled `Emmet: <first line of the expansion>…` whose accept action calls `tryEmmet`.
- [ ] **Step 4: Run** `npx tsc && npm test` — Expected: PASS.
- [ ] **Step 5: Verify in app:** in an `.html` file `ul>li.item*3` + Tab expands with caret inside the first `<li>`; `hello` + Tab indents; inside `"…"` Tab indents; in `.css` inside a rule `df` + Tab → `display: flex;`, `color: red` + Tab indents; Ctrl+Z undoes the expansion in one step; the preview row appears while typing `ul>li`.
- [ ] **Step 6: Commit** `git commit -m "feat: Emmet for HTML and CSS"`

---

## Part C — Multi-Cursor

### Task 6: Multi-selection logic (pure)

**Files:**
- Modify: `src/renderer/editcore.ts` (append), `test/editcore.test.js`

**Interfaces:**
- Consumes: existing `Sel`, `moveCaret`, `deleteSpan`, `wordAt`, `lineOfOffset`, `colAtVisual`, `visualCol`.
- Produces:
  - `normalizeSels(sels: Sel[], len: number): Sel[]` — clamps to `[0,len]`, sorts by `min(anchor,head)`, merges ranges that overlap and carets at the same spot (merged selection keeps the later one's direction). Adjacent non-empty ranges that only touch stay separate.
  - `applyEdits(text: string, edits: TextEdit[]): { text: string; carets: number[] }` — `edits` sorted and non-overlapping, one per selection; result caret *i* sits at the end of edit *i*'s inserted text in the new text.
  - `moveSels(text: string, starts: number[], sels: Sel[], key: NavKey, mods: { shift: boolean; ctrl: boolean }, page: number): Sel[]` — `moveCaret` per selection (goal `null`), then `normalizeSels`.
  - `nextOccurrence(text: string, sels: Sel[]): Sel | null` — needle is the text of the **last** selection in `sels` order given (the most recently added); if it is empty, returns the word at that caret (`wordAt`) as a selection instead; otherwise searches forward from its end, wraps to the start, skips ranges already selected; `null` when none left.
  - `allOccurrences(text: string, needle: string): Sel[]` (non-overlapping, case-sensitive).
  - `splitPaste(clip: string, n: number): string[]` — if `clip` (after trimming one trailing `\n`) has exactly `n` lines, one per cursor; else `n` copies of `clip`.
  - `columnSels(text: string, starts: number[], fromLine: number, fromVcol: number, toLine: number, toVcol: number): Sel[]` — one selection per line in range, from `colAtVisual(line, fromVcol)` to `colAtVisual(line, toVcol)` clamped to line length, anchor on the `from` side.

- [ ] **Step 1: Write failing tests** (key ones; add the obvious symmetric cases):

```js
test('normalizeSels merges overlaps and duplicate carets', () => {
  assert.deepEqual(plain(normalizeSels([{ anchor: 5, head: 5 }, { anchor: 1, head: 3 }, { anchor: 2, head: 4 }, { anchor: 5, head: 5 }], 10)),
    [{ anchor: 1, head: 4 }, { anchor: 5, head: 5 }]);
});
test('applyEdits maps carets through edits of different lengths on one line', () => {
  assert.deepEqual(plain(applyEdits('a b c', [{ start: 1, end: 1, text: 'XX' }, { start: 3, end: 3, text: 'Y' }, { start: 5, end: 5, text: '' }])),
    { text: 'aXX bY c', carets: [3, 6, 8] });
});
test('Backspace at colliding carets merges them (Review Focus 4)', () => {
  // 'abc' with carets after a and after b: one Backspace deletes both and leaves one caret at 0.
  // (A cursor whose Backspace deletes nothing still keeps its caret: callers pass a zero-length edit, not none.)
  const t = 'abc', sels = [{ anchor: 1, head: 1 }, { anchor: 2, head: 2 }];
  const edits = sels.map(s => { const [a, b] = deleteSpan(t, s, 'Backspace', false); return { start: a, end: b, text: '' }; });
  const r = applyEdits(t, edits);
  assert.equal(r.text, 'c');
  assert.deepEqual(plain(normalizeSels(r.carets.map(c => ({ anchor: c, head: c })), r.text.length)), [{ anchor: 0, head: 0 }]);
  assert.deepEqual(plain(applyEdits('c', [{ start: 0, end: 0, text: '' }])), { text: 'c', carets: [0] });
});
test('nextOccurrence selects the word first, then wraps and skips selected', () => {
  const T = 'foo bar foo baz foo';
  assert.deepEqual(plain(nextOccurrence(T, [{ anchor: 1, head: 1 }])), { anchor: 0, head: 3 });
  assert.deepEqual(plain(nextOccurrence(T, [{ anchor: 0, head: 3 }])), { anchor: 8, head: 11 });
  assert.deepEqual(plain(nextOccurrence(T, [{ anchor: 8, head: 11 }, { anchor: 16, head: 19 }])), { anchor: 0, head: 3 });
  assert.equal(nextOccurrence(T, [{ anchor: 0, head: 3 }, { anchor: 8, head: 11 }, { anchor: 16, head: 19 }]), null);
});
test('splitPaste distributes one line per cursor only on an exact match', () => {
  assert.deepEqual(splitPaste('a\nb\n', 2), ['a', 'b']);
  assert.deepEqual(splitPaste('a\nb', 3), ['a\nb', 'a\nb', 'a\nb']);
});
test('columnSels clamps short lines', () => {
  const T = 'abcdef\nab\nabcdef', S = lineStarts(T);
  assert.deepEqual(plain(columnSels(T, S, 0, 1, 2, 4)), [{ anchor: 1, head: 4 }, { anchor: 8, head: 9 }, { anchor: 11, head: 14 }]);
});
```

- [ ] **Step 2: Run** `node --test test/editcore.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** the exports.
- [ ] **Step 4: Run** `node --test test/editcore.test.js && npx tsc` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(editor): multi-selection logic"`

### Task 7: CodeSurface holds and edits several selections

**Files:**
- Modify: `src/renderer/codeview.ts`, `src/renderer/breeze.css` (`.code-caret.extra` reuses `.code-caret` blink)

**Interfaces:**
- Consumes: Task 6 helpers.
- Produces on `CodeSurface`: `get selections(): Sel[]` (all, sorted), `get primaryIndex(): number`, `setSelections(sels: Sel[], primary: number): void` (normalises; primary becomes `selStart/selEnd/selDir`, the rest go to `private extras: Sel[]`; fires `selectionchange`), `addSelection(sel: Sel): void` (new selection becomes primary), `clearExtras(): void`, `get multi(): boolean`. Existing `setSelectionRange` now also clears `extras` (so every existing app caller stays single-cursor). `setRangeText` maps extras through the edit the same way it maps the primary.

- [ ] **Step 1: Model + paint.** Add `extras`; `paint()` loops all selections for `.code-sel` boxes and draws a pooled `.code-caret.extra` element per extra caret in the visible window; the hidden input still follows the primary.
- [ ] **Step 2: Editing with `multi`.** In `onKey`/`onInput`/paste/copy/cut, when `this.multi`:
  - nav keys → `moveSels`, keep primary index by position;
  - Backspace/Delete → `deleteSpan` per selection → `applyEdits`;
  - typed text, Enter (`'\n'`), Tab (`'\t'`) → replace each selection;
  - paste → `splitPaste(clip, n)`; copy/cut → non-empty selections joined by `\n` (nothing when all empty);
  - IME `compositionend` → commit to primary, then `clearExtras()`.
  - All of it goes through a new `private multiEdit(edits: TextEdit[], inputType: string, data: string | null)` that dispatches **one** cancelable `beforeinput`, sets `this.text` via `applyEdits`, rebuilds `starts`, sets carets, then dispatches one `input` — one undo step.
- [ ] **Step 3: Run** `npx tsc && npm test` — Expected: PASS (existing editcore tests unchanged).
- [ ] **Step 4: Verify in app** via DevTools console: `activeText().ta.setSelections([{anchor:0,head:0},{anchor:10,head:10}],0)`, type `x` → both get `x`, Ctrl+Z removes both at once, arrows move both, copy/paste of two words onto two carets distributes.
- [ ] **Step 5: Commit** `git commit -m "feat(editor): CodeSurface supports several selections"`

### Task 8: Multi-cursor gestures, commands and guards

**Files:**
- Modify: `src/renderer/codeview.ts` (`onPointerDown`: Alt+Click, Shift+Alt drag), `src/renderer/breeze/editor.ts` (`editorKeys` guards + Esc; `updateStatus`), `src/renderer/breeze/commands.ts` (Selection menu items + `commands` entries + add the new acts to `EDITOR_ONLY`)

**Interfaces:**
- Consumes: Task 6 + Task 7 APIs.
- Produces commands: `sel.addNext` (Ctrl+D, `ta.addSelection(nextOccurrence(...))`, reveal it), `sel.allOccurrences` (Ctrl+Shift+L), `sel.cursorAbove` (Ctrl+Alt+Up), `sel.cursorBelow` (Ctrl+Alt+Down) — the latter two add a caret at the same visual column on the adjacent line of the top-most/bottom-most selection.

- [ ] **Step 1: Pointer gestures.** Alt+Click (no Shift) → `addSelection` at the click offset, no drag. Shift+Alt+drag → on each drag step `setSelections(columnSels(...), last)` from the press point's (line, vcol) to the pointer's. Note `onKey` already returns on `altKey`; leave that for keys.
- [ ] **Step 2: Guards.** In `editorKeys`, when `ta.multi`: skip `closeTagKey`, `pairKey`, autofill (`suggestKeys`/`editorSuggest`), Emmet, and the Tab/Enter branches (`indentKey`/`enterKey`) so the surface's plain multi handling runs; Esc → `ta.clearExtras()` + `preventDefault`. `replaceRange` and other app edits call `setSelectionRange` and so collapse to one cursor by design.
- [ ] **Step 3: Status.** `updateStatus` shows `N selections` instead of `Ln, Col` when `ta.multi`.
- [ ] **Step 4: Menu.** Selection menu: Add Next Occurrence (Ctrl+D), Select All Occurrences (Ctrl+Shift+L), Add Cursor Above (Ctrl+Alt+Up), Add Cursor Below (Ctrl+Alt+Down). Help → Keyboard Shortcuts list gains "Add cursor — Alt+Click" and "Column select — Shift+Alt+Drag".
- [ ] **Step 5: Run** `npx tsc && npm test` — Expected: PASS.
- [ ] **Step 6: Verify in app:** every gesture in the table works; Esc returns to one cursor; with two cursors `(` inserts a plain `(` at both (no auto-pair); Enter inserts plain newlines; single-cursor auto-pair/indent/Emmet still work; split editor still works.
- [ ] **Step 7: Commit** `git commit -m "feat: multi-cursor editing"`

---

## Part D — Debugger

Shared types (define once in `src/renderer/breeze/core.ts` for the renderer; JSDoc in `src/main/debug.js` for main):

```ts
interface Bp { line: number; enabled: boolean; condition?: string; hitCondition?: string; logMessage?: string } // line is 1-based
interface DebugFrame { id: number; name: string; file: string | null; line: number; col: number } // file project-relative, null for internals
interface DebugValue { name: string; value: string; type: string; ref: number } // ref > 0 = expandable
type DebugState = 'starting' | 'running' | 'paused' | 'stopped';
type DebugEvent =
  | { type: 'state'; state: DebugState }
  | { type: 'paused'; reason: string; frames: DebugFrame[]; exception?: string }
  | { type: 'output'; stream: 'stdout' | 'stderr' | 'console'; text: string }
  | { type: 'breakpoints'; file: string; lines: number[] }      // verified lines
  | { type: 'exited'; code: number | null }
  | { type: 'error'; message: string; hint?: 'install-debugpy' | 'node-too-old' | 'not-found' };
```

### Task 9: DAP client

**Files:**
- Create: `src/main/dap.js`
- Test: `test/dap.test.js`

**Interfaces:**
- Produces: `class DapReader { push(chunk: Buffer): object[] }` (Content-Length framing; handles split headers/bodies and several messages in one chunk); `class DapClient extends EventEmitter { constructor(stream: Duplex); request(command: string, args?: object): Promise<object> /* resolves body, rejects with message on success:false */; emits 'event' ({ event, body }), 'close'; close(): void }`.

- [ ] **Step 1: Write failing tests** with a `PassThrough` pair: framing of a message split across 3 chunks; two messages in one chunk; `request` writes a framed `{ seq, type:'request', command, arguments }` and resolves when a matching `response` arrives; rejects on `success: false` with its `message`; `event` messages are emitted.
- [ ] **Step 2: Run** `node --test test/dap.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** `dap.js`.
- [ ] **Step 4: Run** `node --test test/dap.test.js` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(debug): DAP client"`

### Task 10: CDP client and mapping

**Files:**
- Create: `src/main/cdp.js`
- Test: `test/cdp.test.js`

**Interfaces:**
- Produces: `class CdpClient extends EventEmitter { static connect(wsUrl: string): Promise<CdpClient>; send(method: string, params?: object): Promise<object>; emits each CDP event by method name and 'close'; close(): void }` (global `WebSocket`); pure helpers:
  - `fileUrl(absPath: string): string` — `pathToFileURL(absPath).href` (encodes spaces as `%20`).
  - `urlRegexFor(absPath: string): string` — case-insensitive regex source matching both `file:///C:/…` encodings and the raw path, for `Debugger.setBreakpointByUrl({ urlRegex })`.
  - `cdpCondition(bp: Bp, id: number): string` — `''` for plain; `(cond)` for condition; hit count → `(globalThis.__bzHit ??= {})[id] = ((globalThis.__bzHit ??= {})[id] ?? 0) + 1, __bzHit[id] <op> n` (supports `>= n`, `> n`, `== n`, `% n`, bare `n` = `>= n`) combined with the condition by `&&`; logpoint → `console.log(<template literal from logMessage with {expr} → ${expr}>), false`.
  - `valueOf(name: string, ro: object, refFor: (objectId: string) => number): DebugValue` — primitives by `value`/`description`, strings quoted, objects/arrays `description` with `ref = refFor(objectId)`.
  - `framesOf(callFrames: object[], scripts: Map<string, string>, root: string): DebugFrame[]` — 1-based lines; `file` relative to `root` when inside it, else `null`.

- [ ] **Step 1: Write failing tests:** `fileUrl('C:\\Users\\me\\Breeze Code\\a.js')` → `'file:///C:/Users/me/Breeze%20Code/a.js'`; `new RegExp(urlRegexFor(p), 'i')` matches that URL and its lower-case drive variant (Review Focus 1); `cdpCondition` for plain / condition / `>= 3` / `x > 1` + `% 2` / logpoint `'x is {x}'` (evaluate the generated expression with `vm` over a context to assert hit-count behaviour across calls and the logged string); `valueOf` for number, string (`'"hi"'`), undefined, object with objectId (ref > 0); `framesOf` with a script outside the root → `file: null`.
- [ ] **Step 2: Run** `node --test test/cdp.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** `cdp.js`.
- [ ] **Step 4: Run** `node --test test/cdp.test.js` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(debug): CDP client and mapping"`

### Task 11: DebugManager and backends

**Files:**
- Create: `src/main/debug.js`
- Test: `test/debug.test.js`, fixtures `test/fixtures/debug space/loop.js`, `test/fixtures/debug space/loop.py`, `test/fixtures/debug space/boom.js` (folder name has a space on purpose)

**Interfaces:**
- Consumes: Tasks 9–10; `killTree(child)` pattern from `main.js:1121` (move it into `debug.js` and export, or pass it in).
- Produces:
  - `debugKind(file: string): 'python' | 'node' | null`.
  - `nodeSupportsTs(version: string): boolean` — true for `>= 22.18.0` on 22, `>= 23.6.0` on 23, any `>= 24`.
  - `launchArgs(kind, file, { port, ts }): { args: string[] }` — python: `['-m','debugpy','--listen',`127.0.0.1:${port}`,'--wait-for-client',file]`; node: `['--inspect-brk=127.0.0.1:0', ...(ts ? ['--experimental-strip-types'] : []), file]`.
  - `class DebugManager extends EventEmitter` — emits `'event'` with `DebugEvent`; methods: `start({ file, root, python, node, stopOnEntry, breakpoints: Record<string, Bp[]>, exceptions })`, `stop()`, `restart()`, `pause()`, `continue()`, `step(kind: 'over'|'into'|'out')`, `runTo(file, line)`, `setBreakpoints(file, bps)`, `setExceptions(mode: 'none'|'uncaught'|'all')`, `scopes(frameId): Promise<DebugValue[]>`, `children(ref): Promise<DebugValue[]>`, `evaluate(expr, frameId, context: 'watch'|'repl'|'hover'): Promise<DebugValue>`, `setValue(ref, name, value): Promise<DebugValue>`, `stdin(text)`. One session at a time (`start` stops a running one first).
  - Output is coalesced: stdout/stderr chunks buffered and emitted at most every 50 ms per stream.
  - Python: check `python -m debugpy --version` first → on failure emit `error` with `hint: 'install-debugpy'`; free port via `net.createServer().listen(0)`; connect with retries (100 ms, up to 10 s) then `initialize` → `attach` → breakpoints → `configurationDone`. Map DAP `stopped`/`stackTrace`/`scopes`/`variables`/`evaluate`/`setVariable` to the normalised API.
  - Node: if `ts` and `!nodeSupportsTs(v)` → `error` `hint: 'node-too-old'`; parse `ws://` from stderr (`/Debugger listening on (ws:\/\/\S+)/`), hide the inspector banner lines from Output; `Debugger.enable`, `Runtime.enable`, track `Debugger.scriptParsed` (scriptId → url), set breakpoints with `urlRegexFor` + `cdpCondition`, `Runtime.runIfWaitingForDebugger`; resume the first `--inspect-brk` pause unless `stopOnEntry`; `Debugger.setPauseOnExceptions` for exceptions; scopes from `callFrame.scopeChain` (Local open, Closure, Global → name "Globals"); `Debugger.evaluateOnCallFrame` for evaluate; `Debugger.setVariableValue` for set.
  - Lifecycle: process `exit` → emit `exited` then `state: stopped`; `stop()` during `starting` kills the tree and emits `stopped` (no connection attempts survive).

- [ ] **Step 1: Write failing unit tests** for `debugKind`, `nodeSupportsTs` (`'v22.17.0'` false, `'v22.18.0'` true, `'v23.5.0'` false, `'v23.6.0'` true, `'v24.0.0'` true), `launchArgs`.
- [ ] **Step 2: Write failing integration tests** (use `process.execPath` with `ELECTRON_RUN_AS_NODE` unset — the test runner's own Node):
  - node: start `loop.js` with a breakpoint on line 3 → receive `paused` with top frame `file: 'loop.js', line: 3`; `scopes` contains a local `i`; `evaluate('i * 2')` returns its double; `step('over')` → paused on line 4; `continue()` → `exited` code 0 then `stopped`.
  - node `boom.js` (throws on line 1, no breakpoints): `stopped` arrives within 5 s, Output contains `Error` (Review Focus 2).
  - stop during start: `start` then immediately `stop()` → `stopped` within 2 s and the child PID is gone (`process.kill(pid, 0)` throws) (Review Focus 3).
  - python: same as the node loop test, `test.skip` when `python -m debugpy --version` fails.
- [ ] **Step 3: Run** `node --test test/debug.test.js` — Expected: FAIL.
- [ ] **Step 4: Implement** `debug.js` (both backends behind private `PythonBackend` / `NodeBackend` classes with the same method set).
- [ ] **Step 5: Run** `node --test test/debug.test.js && npm test` — Expected: PASS (python test passes or is skipped).
- [ ] **Step 6: Commit** `git commit -m "feat(debug): DebugManager with debugpy and Node backends"`

### Task 12: Debug IPC bridge

**Files:**
- Modify: `src/main/main.js` (handlers; stop on folder change/close at `:454` and `:677`, and on `before-quit`), `src/main/preload.js`, `src/renderer/breeze/core.ts` (types above + bridge type)

**Interfaces:**
- Consumes: Task 11; `resolveIn(rel)` for every file argument; `getTools()` for the Python path; the Node path from the same lookup used at `main.js:1278`.
- Produces: channels `debug:start(rel, opts)`, `debug:stop`, `debug:restart`, `debug:pause`, `debug:continue`, `debug:step(kind)`, `debug:runTo(rel, line)`, `debug:setBreakpoints(rel, bps)`, `debug:exceptions(mode)`, `debug:scopes(frameId)`, `debug:children(ref)`, `debug:evaluate(expr, frameId, context)`, `debug:setValue(ref, name, value)`, `debug:stdin(text)`; push channel `debug:event` (one `DebugEvent`). Preload: `debug: { start, stop, restart, pause, continue: cont, step, runTo, setBreakpoints, exceptions, scopes, children, evaluate, setValue, stdin, onEvent(cb) }` (note `continue` is a keyword-safe property name in object literals; keep it as `continue`).
- [ ] **Step 1: Implement** handlers + bridge + types.
- [ ] **Step 2: Run** `npm test && npx tsc` — Expected: PASS (`node --check` covers main/preload).
- [ ] **Step 3: Verify** from DevTools: `api.debug.onEvent(console.log); api.debug.start('some.js', {})` logs `state`/`exited` events.
- [ ] **Step 4: Commit** `git commit -m "feat(debug): IPC bridge"`

### Task 13: Breakpoints in the IDE

**Files:**
- Create: `src/renderer/breeze/debug.ts` (breakpoint store section only for now)
- Modify: `src/renderer/editcore.ts` + `test/editcore.test.js` (pure line shifter), `src/renderer/breeze/editor.ts` (`gutterHtml`, gutter click at `:496`, call the shifter where `shiftMarks` is called, rename hook beside `renameMarks`), `src/renderer/breeze/commands.ts` (Run menu: Toggle Breakpoint F9), `breeze.css`, `breeze.html`, `tsconfig.json`

**Interfaces:**
- Produces: `shiftLines(lines: number[], before: string, after: string): number[]` in `editcore.ts` (0-based lines; lines after an edit move by the line delta, lines inside a deleted span collapse onto the edit's first line, duplicates removed) — extract from the existing `shiftMarks` logic so marks and breakpoints share it; `breakpoints: Map<string, Bp[]>`, `toggleBreakpoint(path: string, line0: number): void`, `bpAt(path, line0): Bp | undefined`, `saveBreakpoints()` (store key `breeze.breakpoints:<root>`), `onBreakpointsChanged(path)` (repaints gutter and, if a session is live, calls `api.debug.setBreakpoints`).
- [ ] **Step 1: Write failing tests** for `shiftLines`: insert two lines above → `+2`; delete a span containing a line → collapses; edit after all lines → unchanged.
- [ ] **Step 2: Run** `node --test test/editcore.test.js` — FAIL; **implement**; make `shiftMarks` use it; run again — PASS.
- [ ] **Step 3: Gutter.** Clicking a line number (not the mark dot) toggles a breakpoint; breakpoints render as a red dot left of the number (hollow when `enabled` is false or unverified); F9 toggles on the caret line.
- [ ] **Step 4: Run** `npx tsc && npm test` — PASS. **Verify in app:** toggle by click and F9, add lines above (dot moves), reload window (persists), rename file (follows).
- [ ] **Step 5: Commit** `git commit -m "feat(debug): breakpoints in the editor gutter"`

### Task 14: Full-page debug view — shell, toolbar, source, call stack, breakpoints panel

**Files:**
- Modify: `src/renderer/breeze.html` (new `<section id="debug" class="hidden">` screen beside `#box`), `src/renderer/breeze.css` (debug layout + splitters), `src/renderer/breeze/debug.ts`, `src/renderer/breeze/commands.ts` (Run menu items + `commands`), `src/renderer/breeze/setup.ts` (`swapScreen` knows `#debug`), `src/renderer/breeze/editor.ts` (status-bar debug pill)

**Interfaces:**
- Consumes: Tasks 12–13; `swapScreen`, `showIde`; `CodeSurface` + the highlighter used by `renderCode` (`highlighted(b)`), read-only by setting `input.readOnly = true` and ignoring `beforeinput` (cancel it).
- Produces: `startDebugging(): Promise<void>` (active file must satisfy `debugKind`; saves dirty buffer first; else toast "Breeze can debug Python, JavaScript and TypeScript files"); `openDebugView()`; `leaveDebugView()`; `debugState: DebugState`; `selectFrame(i: number)`; commands `debug.start` (Ctrl+Shift+D), `debug.stop` (Shift+F5), `debug.restart` (Ctrl+Shift+F5), `debug.continue` (F5 *only when paused*: `run.start` checks `debugState === 'paused'` first), `debug.pause` (F6), `debug.stepOver` (F10), `debug.stepInto` (F11), `debug.stepOut` (Shift+F11), `debug.toggleBreakpoint` (F9, from Task 13), `debug.open` (Open Debug View).
- Layout and behaviour exactly as spec §4 "Full-page debug view": toolbar; left column Call Stack + Breakpoints (checkbox enable, click jumps, right-click menu Edit Condition / Edit Hit Count / Edit Log Message / Remove, "Uncaught exceptions" and "All exceptions" toggles → `api.debug.exceptions`, "Remove all"); centre read-only source with paused-line highlight and gutter breakpoints, exception banner; splitter sizes stored under `breeze.debug.layout`. Status pill in the IDE: "Debugging <file> — <state> · Open".
- [ ] **Step 1: Implement** the screen, toolbar (buttons disabled per state), source pane, call stack, breakpoints panel and event handling for `state`/`paused`/`breakpoints`/`exited`/`error` (error card with fix button: `install-debugpy` → `runCommand('python -m pip install debugpy')` in the IDE terminal then retry; `node-too-old` → message + link to nodejs.org).
- [ ] **Step 2: Run** `npx tsc && npm test` — PASS.
- [ ] **Step 3: Verify in app** with a small `.js` and `.py` file: Ctrl+Shift+D opens the full page, stops on a breakpoint, highlighted line, F10/F11/Shift+F11/F5 behave, call stack frame click switches the source, breakpoint toggles in the panel reach the session, Back to editor and the status pill round-trip, Shift+F5 stops.
- [ ] **Step 4: Commit** `git commit -m "feat(debug): full-page debug view"`

### Task 15: Variables, Watch, Debug Console, Output, hover and run-to-line

**Files:**
- Modify: `src/renderer/breeze/debug.ts`, `src/renderer/breeze.html`, `src/renderer/breeze.css`

**Interfaces:**
- Consumes: `api.debug.scopes/children/evaluate/setValue/stdin/runTo`; `selectFrame`.
- Produces: Variables tree (Locals expanded, others collapsed, lazy `children(ref)`, values changed since the last pause get a `.changed` flash, double-click value → inline input → `setValue`); Watch list (add/edit/remove, stored per project `breeze.debug.watch:<root>`, re-evaluated with context `'watch'` on every pause and frame change, errors shown inline); Debug Console tab (input with ↑/↓ history, `evaluate(expr, frame, 'repl')`, results as expandable values, program `console` output shown too); Output tab (stdout/stderr, stderr in the error colour, an input line that calls `stdin(text + '\n')`); hover on an identifier in the source while paused → `evaluate(word, frame, 'hover')` tooltip after 300 ms; right-click a source line → "Run to here" → `runTo`.
- [ ] **Step 1: Implement** the four panels, hover and run-to-line.
- [ ] **Step 2: Run** `npx tsc && npm test` — PASS.
- [ ] **Step 3: Verify in app** (Python and JS): Locals show and expand objects/lists; watch `len(items)` / `items.length` updates per step; console evaluates `total * 2`; a program calling `input()` / `readline` reads from the Output input line; editing a variable's value changes the program's later output; hover shows values; "Run to here" stops on that line; an uncaught exception with "Uncaught exceptions" on pauses with the banner.
- [ ] **Step 4: Commit** `git commit -m "feat(debug): variables, watch, console and output panels"`

### Task 16: Final check

- [ ] **Step 1: Run** `npm test && npx tsc` — Expected: all PASS (Python integration test may be skipped; say so in the report).
- [ ] **Step 2: In-app pass over all four features** together: palette lists the new Selection and Run/Debug commands; Emmet and multi-cursor don't interfere (Emmet off with several cursors); a debug session survives switching to the IDE and back; closing the folder stops the session.
- [ ] **Step 3: Update docs:** add the features to `README.md` "Features" and `PRODUCT.md` "Capabilities and Constraints" (one line each, plain words), and the Help → Keyboard Shortcuts list.
- [ ] **Step 4: Commit** `git commit -m "docs: debugger, multi-cursor, Emmet and Command Palette"`
