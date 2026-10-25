# Virtualized Code Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Typing, undo and panel resizing stay fast (a few ms) in 10,000-line files. To get there, the full-file `<textarea>` goes away and is replaced by a VS Code-style editor: a tiny hidden textarea takes input, and Breeze draws only the visible lines, the caret and the selection.

**Architecture:** Two new classic-script files sit beside `breezescript.ts` and share its global scope:
- `editcore.ts` holds pure text-position logic: line math, word motion, caret movement and delete spans. It has no DOM, so it gets unit tests under `node:test`.
- `codeview.ts` holds `CodeSurface`, a DOM class with a **textarea-shaped API** (`value`, `selectionStart/End`, `setSelectionRange`, `setRangeText`, `scrollTop`, `focus`, `addEventListener`…). Because the API matches, `EditorBuffer.ta` and almost every call site keep working when the type changes from `HTMLTextAreaElement` to `CodeSurface`.

The surface owns a native scroller holding a sized spacer, plus caret, selection, mouse, keyboard, IME and clipboard handling. The existing overlay in `breezescript.ts` keeps drawing the highlighted lines.

**Tech Stack:** Electron 44 renderer, TypeScript (`tsc`, strict, classic scripts, no bundler), Node 24 `node:test` with `module.stripTypeScriptTypes` + `node:vm` for renderer unit tests, plain CSS.

**Spec:** No separate spec. The design decisions are recorded in this header. The reason for the change was measured in the browser preview on a 390 KB, 7,800-line JS file: the full-file textarea costs ~90 ms of layout per keystroke, ~125 ms per undo and ~16 ms per sash-resize frame. With the textarea hidden, a resize frame costs ~2 ms.

## Global Constraints

- No new runtime or dev dependencies. No bundler. Files stay classic scripts loaded with `<script defer>` in `src/renderer/breeze.html`. Order: `editcore.js`, then `codeview.js`, then `breezescript.js`.
- `editcore.ts` uses erasable TypeScript only (no `enum`, `namespace` or parameter properties), so `stripTypeScriptTypes` can load it in tests. Its public names are top-level `function`/`const` declarations.
- Compiled outputs `src/renderer/editcore.js` and `src/renderer/codeview.js` are added to `.gitignore`, the same way `src/renderer/breezescript.js` already is.
- Metrics stay as today: `LINE_H = 21`, font `13px/21px var(--font-code)`, tab size 4, padding top 10 / right 24 / bottom 10 / left 4 (from `.hl, .ta` in `breeze.css`). Selection colour `rgba(0, 94, 255, .4)`. Caret colour `var(--text)`, width 2px.
- Buffer text always uses `\n`. Pasted or dropped text has `\r\n` and `\r` turned into `\n`.
- The hidden input textarea keeps the class `ta`. Global shortcuts (`breezescript.ts` ~8553, 8588, 8622, 10530, 5739) recognise the editor by `classList.contains('ta')`, and they must keep working unchanged.
- Performance targets, measured in the preview with the 390 KB file (setup snippet in Task 4): user keystroke incl. forced layout ≤ 5 ms median, undo ≤ 10 ms median, `applyLayout()` sash step ≤ 5 ms median.
- Undo/redo remain Breeze's own history (`remember`, `stepHistory`). The surface never uses browser undo.

## Review Focus

1. **Thai, CJK and emoji in code** (comments and strings). Caret and selection x-positions and click hit-testing must line up with the drawn text, even on lines where characters aren't one monospace cell wide. The caret must never stop inside a surrogate pair. Covered by Task 1 (surrogates) and Task 4 (DOM-measured x for non-ASCII lines).
2. **IME composition** (Thai, Japanese, Chinese keyboards). Text being composed is visible at the caret and lands as one insert when committed. Pressing keys mid-composition doesn't trigger shortcuts. Covered by Task 3.
3. **Pasting large or CRLF text.** A 1 MB paste lands in one step, as one undo step, with `\n` line endings. Covered by Task 3.
4. **Shortcuts while the editor has focus.** Ctrl+S/P/F/Z/Y, Tab, Enter, auto-pairs and word suggestions behave as they did with the old textarea. Covered by Task 4.
5. **Clicking or dragging outside the text.** A click past the end of a line or below the last line puts the caret at the line end or the document end. Dragging above or below the viewport auto-scrolls and keeps extending the selection. Covered by Task 3.

---

### Task 0: Branch and commit the pending work

**Files:** none new.

- [ ] **Step 1: Create the branch**

```bash
git switch -c perf/virtual-editor
```

- [ ] **Step 2: Commit the uncommitted highlighting speed-up and restored header**

Run `npm run build` and `npm test`. Expected: build exits 0; tests report `fail 0`.

```bash
git add src/renderer/breezescript.ts
git commit -m "perf: incremental syntax highlighting and cheaper per-keystroke editor work"
```

---

### Task 1: `editcore.ts` — pure position logic with unit tests

**Files:**
- Create: `src/renderer/editcore.ts`
- Create: `test/editcore.test.js`
- Modify: `src/renderer/breezescript.ts`: remove `lineStart`, `lineEnd`, `lineStarts`, `lineOfOffset`, `lineStartsOf` (and its `lineMemo`) and `visualCol`, which move to editcore unchanged.
- Modify: `tsconfig.json`: `files` gains `src/renderer/editcore.ts` (before breezescript).
- Modify: `src/renderer/breeze.html`: add `<script src="editcore.js" defer></script>` before `breezescript.js`.
- Modify: `.gitignore`: add `src/renderer/editcore.js`.

**Interfaces:**
- Produces (global, used by Tasks 2–5):
  - `interface Sel { anchor: number; head: number }`
  - `type NavKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End' | 'PageUp' | 'PageDown'`
  - moved as-is: `lineStart(v, pos)`, `lineEnd(v, pos)`, `lineStarts(text): number[]`, `lineOfOffset(starts, off): number`, `lineStartsOf(text): number[]`, `visualCol(lineText, col): number`
  - `colAtVisual(lineText: string, vcol: number): number`: the char index whose visual column is nearest `vcol` (ties go left), clamped to `[0, lineText.length]`, never inside a surrogate pair.
  - `wordLeft(text: string, off: number): number` / `wordRight(text: string, off: number): number`. `wordRight`: at `\n` → `off + 1`. Otherwise skip spaces and tabs, then skip one run of word chars `[\w$]` or one run of other non-space chars. `wordLeft` mirrors it.
  - `wordAt(text: string, off: number): [number, number]`: the run (word, punctuation or whitespace) containing the char at `off`. If `off` is at a run end, use the char before it, preferring word chars.
  - `moveCaret(text: string, starts: number[], sel: Sel, key: NavKey, mods: { shift: boolean; ctrl: boolean }, page: number, goal: number | null): { sel: Sel; goal: number | null }`
  - `deleteSpan(text: string, sel: Sel, key: 'Backspace' | 'Delete', ctrl: boolean): [number, number]`

- [ ] **Step 1: Write the failing tests** in `test/editcore.test.js`

Load it like this (matches the `require('node:test')` style of the other tests):

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const ctx = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(fs.readFileSync(require.resolve('../src/renderer/editcore.ts'), 'utf8')), ctx);
const { lineStarts, colAtVisual, wordLeft, wordRight, wordAt, moveCaret, deleteSpan } =
  vm.runInContext('({ lineStarts, colAtVisual, wordLeft, wordRight, wordAt, moveCaret, deleteSpan })', ctx);

const T = 'ab cd\n  ef\n\nxyz';           // lines start at 0, 6, 11, 12; length 15
const S = lineStarts(T);
const mv = (off, key, o = {}) => moveCaret(T, S, o.sel ?? { anchor: off, head: off }, key,
  { shift: !!o.shift, ctrl: !!o.ctrl }, o.page ?? 10, o.goal ?? null);
```

Tests, one `test()` each, with these exact assertions:
- `lineStarts(T)` deep-equals `[0, 6, 11, 12]`.
- Arrow keys: `mv(0,'ArrowRight').sel` → `{anchor:1,head:1}`. `mv(0,'ArrowRight',{shift:true}).sel` → `{anchor:0,head:1}`. `mv(0,'ArrowLeft',{sel:{anchor:1,head:4}}).sel` → `{anchor:1,head:1}`. `mv(0,'ArrowRight',{sel:{anchor:4,head:1}}).sel` → `{anchor:4,head:4}`.
- Vertical goal column: `mv(4,'ArrowDown')` → sel head `10`, goal `4`. From there with `goal:4`: down → `11`, goal stays `4`. Down again → `15`.
- Edges: `mv(3,'ArrowUp').sel.head` → `0`. `mv(13,'ArrowDown').sel.head` → `15`.
- Smart home: `mv(10,'Home').sel.head` → `8`. `mv(8,'Home').sel.head` → `6`. `mv(7,'End').sel.head` → `10`. `mv(7,'Home',{ctrl:true}).sel.head` → `0`. `mv(7,'End',{ctrl:true}).sel.head` → `15`.
- Word moves: `mv(0,'ArrowRight',{ctrl:true}).sel.head` → `2`, from `2` → `5`, from `5` → `6`. `mv(5,'ArrowLeft',{ctrl:true}).sel.head` → `3`, from `3` → `0`.
- Page: `mv(0,'PageDown',{page:2}).sel.head` → `11`.
- Horizontal moves reset goal: `mv(10,'ArrowLeft',{goal:4}).goal` → `null`.
- Surrogates: with `E = 'a😀b'`, `moveCaret(E, lineStarts(E), {anchor:1,head:1}, 'ArrowRight', {shift:false,ctrl:false}, 10, null).sel.head` → `3`. `deleteSpan(E, {anchor:3,head:3}, 'Backspace', false)` → `[1,3]`.
- `deleteSpan(T, {anchor:4,head:4}, 'Backspace', false)` → `[3,4]`. With `{anchor:1,head:4}` → `[1,4]`. Ctrl+Backspace at 5 → `[3,5]`. `'Delete'` at 15 → `[15,15]`. `'Backspace'` at 0 → `[0,0]`. Ctrl+Delete at 0 → `[0,2]`.
- `colAtVisual('\tab', 5)` → `2`. `colAtVisual('\tab', 1)` → `0`. `colAtVisual('abc', 99)` → `3`.
- `wordAt('foo.bar baz', 5)` → `[4,7]`. At `3` → `[3,4]`. At `7` → `[4,7]`.
- `wordRight('a  b', 1)` → `4`. `wordLeft('a  b', 3)` → `0`.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/editcore.test.js`
Expected: FAIL (`ENOENT` for `editcore.ts`).

- [ ] **Step 3: Create `src/renderer/editcore.ts`.** Move the six helpers out of `breezescript.ts` byte-for-byte, then add the new functions with the signatures above. Use the comment style of `breezescript.ts`: a one-line `//` comment above each function.

- [ ] **Step 4: Run the tests and the build**

Run: `node --test test/editcore.test.js`. Expected: all pass.
Run: `npm run build`. Expected: exit 0 (`breezescript.ts` still finds the moved helpers through the shared global scope).

- [ ] **Step 5: Add the new test to `npm test`.** No change is needed: the glob `test/**/*.test.js` already picks it up. Run `npm test`. Expected: `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/editcore.ts test/editcore.test.js src/renderer/breezescript.ts tsconfig.json src/renderer/breeze.html .gitignore
git commit -m "refactor: move editor position logic into editcore with unit tests"
```

---

### Task 2: `CodeSurface` — DOM, API, scrolling, caret and selection painting

**Files:**
- Create: `src/renderer/codeview.ts`
- Create: `test/harness/codeview.html`: loads `../../src/renderer/editcore.js` and `../../src/renderer/codeview.js`, plus a `<style>` block copying the `.code`, `.code-scroll`, `.code-spacer`, `.code-sel`, `.code-caret` and `.ta` rules from `breeze.css`, with the font `13px/21px Consolas, monospace`. It sets `window.SAMPLE` to 10,000 lines of `` `const value = compute(index) + 1; // line ${String(n).padStart(5, '0')}` `` joined by `\n`. Every line is 47 chars, so line k starts at `48 * k`. It then builds `window.s = new CodeSurface(host, { lineHeight: 21, charWidth, pad: { top: 10, left: 4, right: 24, bottom: 10 }, label: 'Harness' })` in a 900×600 host, with `charWidth` measured once from a 200-char span in that font, and sets `s.value = SAMPLE`.
- Modify: `src/renderer/breeze.css`: replace the `.ta` and `.ta::selection` rules (lines ~2160–2177) with the rules below.
- Modify: `tsconfig.json` (add `codeview.ts` after `editcore.ts`), `breeze.html` (add the `codeview.js` script after `editcore.js`), `.gitignore` (add `src/renderer/codeview.js`).

**Interfaces:**
- Consumes: Task 1's globals.
- Produces:

```ts
interface SurfaceOpts {
  lineHeight: number;                 // 21
  charWidth: () => number;            // breezescript's measureChar
  pad: { top: number; left: number; right: number; bottom: number }; // 10, 4, 24, 10
  label: string;                      // aria-label of the input
  xAt?: (line: number, col: number) => number | null;   // content-x override for a column (Task 4)
  colAt?: (line: number, x: number) => number | null;   // inverse override for hit-testing (Task 4)
}
class CodeSurface extends EventTarget {
  readonly root: HTMLDivElement;      // .code-scroll — the scroller; holds .code-spacer, .code-sel layer, .code-caret
  readonly input: HTMLTextAreaElement; // .ta — 1px focus/IME target positioned at the caret
  constructor(host: HTMLElement, opts: SurfaceOpts);
  value: string;                      // setter: no 'input' event; clamps selection; re-sizes spacer
  readonly selectionStart: number; readonly selectionEnd: number;
  readonly selectionDirection: 'forward' | 'backward' | 'none';
  setSelectionRange(start: number, end: number, dir?: 'forward' | 'backward' | 'none'): void; // fires 'selectionchange'
  setRangeText(text: string, start: number, end: number, mode?: 'select' | 'start' | 'end' | 'preserve'): void; // textarea semantics, no 'input' event
  scrollTop: number; scrollLeft: number;
  readonly clientHeight: number; readonly clientWidth: number; readonly scrollHeight: number;
  readonly classList: DOMTokenList;   // root's
  focus(opts?: FocusOptions): void;   // focuses input
  blur(): void;
  getBoundingClientRect(): DOMRect;   // root's
  remove(): void;                     // removes root and input
  refresh(): void;                    // repaint caret + selection for the visible window (called after metric changes)
}
```

Event routing in `addEventListener(type, fn, opts)` (overridden):
- `'keydown'` → `input`, with `capture: true`, so app listeners run before the surface's own bubble-phase handler (Task 3).
- `'mousedown'` and `'scroll'` → `root`.
- `'focus'` and `'blur'` → `input`.
- Everything else (`'beforeinput'`, `'input'`, `'selectionchange'`) → the `EventTarget` itself.
`removeEventListener` mirrors the same routing.

CSS (replaces the old `.ta` rules; `.hl` keeps its rules):

```css
.code-scroll { position: absolute; inset: 0; overflow: auto; cursor: text; }
.code-spacer { position: relative; }
.code-sel { position: absolute; height: 21px; background: rgba(0, 94, 255, .4); pointer-events: none; }
.code-caret { position: absolute; width: 2px; height: 19px; margin-top: 1px; background: var(--text); pointer-events: none; animation: caret-blink 1.06s steps(1) infinite; }
.code-scroll:not(.focused) .code-caret { display: none; }
@keyframes caret-blink { 50% { opacity: 0; } }
.ta { position: absolute; width: 1px; height: 21px; padding: 0; border: 0; outline: 0; resize: none; opacity: 0; overflow: hidden; white-space: pre; font: inherit; caret-color: transparent; }
.ta.composing { width: auto; min-width: 1px; opacity: 1; z-index: 3; background: var(--panel, #18181b); color: var(--text); box-shadow: 0 1px 0 var(--text); }
```

Behaviour to implement:
- The spacer is `lines × lineHeight + pad.top + pad.bottom` tall. Its width is the longest line's visual length × `charWidth()` + `pad.left + pad.right`.
- When `value` is set, recompute the width in full. After an edit, only grow it from the edited lines right away; do a full recompute 150 ms after the last edit.
- Paint `.code-sel` boxes and the caret only for lines in `[firstVisible − 5, lastVisible + 5]`. Repaint on scroll, on selection change and in `refresh()`.
- Caret and selection x comes from `opts.xAt?.(line, col) ?? pad.left + visualCol(lineText, col) * charWidth()`.
- A selection box spans to the line end + one `charWidth()` on every line except the last.
- Restart the blink animation on every caret move (`getAnimations()` → `currentTime = 0`).
- `input` sits at the caret position inside `root`, so the IME window opens there. `root` gets the class `focused` while `input` has focus.

- [ ] **Step 1: Write the harness checks.** Open `http://localhost:5173/test/harness/codeview.html` with the `breeze-static` preview config and run these snippets in turn with `javascript_tool`. Expected output is after `→`.

```js
s.value.split('\n').length                                        // → 10000
s.root.querySelector('.code-spacer').getBoundingClientRect().height // → 210020
s.setSelectionRange(30, 30); s.root.querySelector('.code-caret').style.top   // → "10px"
s.setSelectionRange(0, 200); s.root.querySelectorAll('.code-sel').length    // → 5
s.scrollTop = 21 * 5000; s.refresh(); s.root.querySelectorAll('.code-sel').length // → 0
(() => { const t = performance.now(); s.setRangeText('x', 100, 100, 'end'); s.root.offsetHeight; return performance.now() - t < 5; })() // → true
```

- [ ] **Step 2: Run them to see them fail.** Expected: `ReferenceError: s is not defined` until `codeview.ts` exists.

- [ ] **Step 3: Implement `CodeSurface` and the CSS** as specified above.

- [ ] **Step 4: Build and rerun the harness checks.** Run `npm run build` (exit 0), reload the harness and rerun the snippets. Expected: every `→` value matches.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/codeview.ts test/harness/codeview.html src/renderer/breeze.css tsconfig.json src/renderer/breeze.html .gitignore
git commit -m "feat: add CodeSurface, a virtualized textarea-shaped editor surface"
```

---

### Task 3: `CodeSurface` input — keyboard, typing, IME, clipboard, mouse

**Files:**
- Modify: `src/renderer/codeview.ts`
- Modify: `test/harness/codeview.html` (no new markup; checks only)

**Interfaces:**
- Consumes: `moveCaret`, `deleteSpan`, `wordAt`, `colAtVisual`, `lineStartsOf` (Task 1).
- Produces: `CodeSurface.insertText(text: string): void`. It replaces the selection as a **user edit**: it fires `beforeinput` (`inputType: 'insertText'`, `data: text`, cancelable). Unless that event is cancelled, it applies the change, puts the caret after the inserted text, reveals the caret and fires `input`.

  Every user edit goes through one private path, `userEdit(start, end, text, inputType, data?)`, which follows the same sequence. These are the `inputType` values Breeze's `beforeEdit` already understands:

| Trigger | inputType | data |
|---|---|---|
| `input` event on the hidden textarea, not composing (read `input.value`, then clear it) | `insertText` | the text |
| `compositionend` (insert `input.value`, clear it, remove `.composing`) | `insertText` | the text |
| Backspace / Delete keydown (span from `deleteSpan`; nothing happens for an empty span) | `deleteContentBackward` / `deleteContentForward`, or `deleteWordBackward` / `deleteWordForward` with Ctrl | — |
| `paste` event (`clipboardData.getData('text/plain')` with `\r\n?` → `\n`; `preventDefault`) | `insertFromPaste` | — |
| `cut` event (`clipboardData.setData('text/plain', selected)`; `preventDefault`; delete the selection) | `deleteByCut` | — |

Enter and Tab are **not** handled by the surface. Breeze's `editorKeys` already does them (capture phase). If no listener called `preventDefault`, the surface's bubble handler inserts `\n` or `\t` as `insertText`.

Keyboard (bubble-phase handler on `input`; it skips events with `defaultPrevented` or `isComposing`):
- NavKeys → `moveCaret` (page = visible lines − 1). Keep `goal` between vertical moves. Call `preventDefault`. Reveal the caret.
- Ctrl+A → select all.
- `copy` event → put the selected text in `clipboardData`, then `preventDefault`. With nothing selected, copy nothing.
- `compositionstart` → add `.composing` to `input`. While composing, all key handling is skipped.

Mouse (`pointerdown` on `root`, left button only; `preventDefault`, then `focus()`):
- Hit-test with `opts.colAt?.(line, x) ?? colAtVisual(lineText, Math.round((x − pad.left) / charWidth()))`.
- Below the last line → `value.length`. Above the first → `0`.
- `detail === 2` selects `wordAt`. `detail === 3` selects the line, including its `\n`. Shift extends from the anchor.
- Drag with `setPointerCapture`. While the pointer is above or below `root`, auto-scroll by `(distance / 4)` lines per animation frame and keep extending.
- Fire `selectionchange` on every selection change.

Also fire `selectionchange` on `focus`, so the app redraws its current line.

- [ ] **Step 1: Write the harness checks** (run with `javascript_tool` on the harness page; reload it first).

```js
s.focus(); s.setSelectionRange(0, 0);
s.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); s.selectionStart
// → 48 (line 1 start)
s.input.value = 'Z'; s.input.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'Z', bubbles: true })); [s.value.slice(48, 49), s.input.value]
// → ["Z", ""]
s.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })); s.value.slice(48, 53)
// → "const"
(() => { s.input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); const on = s.input.classList.contains('composing'); s.input.value = 'สวั'; s.input.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: 'สวั', isComposing: true, bubbles: true })); const mid = s.value.includes('สวั'); s.input.dispatchEvent(new CompositionEvent('compositionend', { data: 'สวั', bubbles: true })); return [on, mid, s.value.split('สวั').length - 1, s.input.classList.contains('composing')]; })()
// → [true, false, 1, false] (visible while composing, inserted exactly once on commit)
(() => { s.value = SAMPLE; const r = s.root.getBoundingClientRect(); s.scrollTop = 0; s.root.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 500, clientY: r.top + 10 + 21 * 2 + 5, button: 0, bubbles: true, detail: 1 })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); return s.selectionStart; })()
// → 143 (line 2 end: a click past the end of a line lands at the line end)
(() => { s.value = SAMPLE; s.setSelectionRange(48, 48); const dt = new DataTransfer(); dt.setData('text/plain', 'a\r\nb'); s.input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return s.value.slice(48, 51); })()
// → "a\nb"
(() => { let n = 0; s.addEventListener('beforeinput', e => { if (e.inputType === 'insertText') { n++; e.preventDefault(); } }, { once: true }); s.insertText('Q'); return [n, s.value.includes('Q')]; })()
// → [1, false]
(() => { const big = 'x\r\n'.repeat(350000); const dt = new DataTransfer(); dt.setData('text/plain', big); const t = performance.now(); s.input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); s.root.offsetHeight; return [s.value.includes('\r'), performance.now() - t < 100]; })()
// → [false, true]
```

Then check by hand in the harness with the `computer` tool:
- Type `hello` with `type`. It appears at the caret.
- Shift+End selects to the line end.
- Double-click a word selects it.
- Dragging below the harness host auto-scrolls.

Take a screenshot as proof.

- [ ] **Step 2: Run them to see them fail** against Task 2's surface. Expected: the ArrowDown check returns `0`.

- [ ] **Step 3: Implement** the keyboard, input, IME, clipboard and mouse behaviour above.

- [ ] **Step 4: Build, reload the harness and rerun all checks.** Expected: every `→` value matches, and the manual checks behave as described.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/codeview.ts test/harness/codeview.html
git commit -m "feat: keyboard, IME, clipboard and mouse input for CodeSurface"
```

---

### Task 4: Use `CodeSurface` for the main editor

**Files:**
- Modify: `src/renderer/breezescript.ts`
- Modify: `src/renderer/breeze.css` (only if a leftover `.ta` selector needs updating)

**Interfaces:**
- Consumes: `CodeSurface`, `SurfaceOpts` (Tasks 2–3).
- Produces:
  - `EditorBuffer.ta: CodeSurface | null`
  - `textareaOwner: WeakMap<HTMLTextAreaElement, EditorBuffer>`, now keyed by `surface.input`
  - `surfaceOf(el: EventTarget | null): CodeSurface | undefined`, which looks up `textareaOwner.get(el)?.ta`
  - `lineMeasurer(lines: HTMLElement, first: () => number, text: () => string): Pick<SurfaceOpts, 'xAt' | 'colAt'>`, which measures x on drawn lines that contain non-ASCII characters (Task 5 reuses it for the split)

Changes, by function (line numbers are from the start of this plan):
- `createTextarea(b)` (~4594): rename it `createSurface(b): CodeSurface`. Build `new CodeSurface($('#editor .code'), { lineHeight: LINE_H, charWidth: measureChar, pad: { top: 10, left: 4, right: 24, bottom: 10 }, label: `Editing ${b.path}`, ...lineMeasurer(hlLines, () => winFirst, () => b.text) })`, add class `hidden` and register `textareaOwner.set(s.input, b)`. Keep its listeners, with these changes:
  - `beforeinput` → `beforeEdit`, unchanged.
  - Replace the `['keyup', 'mouseup', 'select', 'selectionchange', 'focus']` list with `['selectionchange']`.
  - Use `s.input` as the suggest `owner`.
- `editorKeys(e)` (~6389): `const ta = surfaceOf(e.target)` instead of the cast. Pass `ta` to `suggestKeys(e, ta.input)`.
- Retype the helpers from `HTMLTextAreaElement` to `CodeSurface`: `replaceRange`, `selectedLines`, `indentKey`, `enterKey`, `pairKey`, `wordBefore`, `visibleLines`, `updateVSlider`. `replaceRange` keeps its logic; `setRangeText` and `dispatchEvent(new Event('input'))` exist on the surface.
- `editorSuggest` (~7666): `owner: ta.input`. The `suggest?.owner === ta` checks become `=== ta.input`.
- `measureChar` stays. After `document.fonts.ready` resets `charW`, call `activeText()?.ta.refresh()`.
- New `lineMeasurer(lines, first, text)` returns `{ xAt, colAt }`:
  - `xAt(line, col)`: return `null` when the line is pure ASCII (`!/[^\x00-\x7f]/.test(lineText)`) or `lines.children[line − first()]` isn't drawn. Otherwise, make a DOM `Range` at char `col` of that `.ln` element's text (walk its text nodes and count chars; `.diag-msg` spans don't count). Return `rect.left − lines.getBoundingClientRect().left + 4` (4 = pad.left).
  - `colAt(line, x)`: same guard. Binary-search `col` in `[0, lineText.length]` with `xAt` and return the nearest boundary.
- `stepHistory`: unchanged. (`value =` on the surface is now cheap.)
- Lifecycle sites keep their current calls, which the surface supports: `restoreBuffer`, `resetWorkspace`, `loadBuffer`, `reloadText`, `actuallyOpen`, `dropTab`, `loadDiskVersion`, `confirmDiscard`, `setBuffer`, `flushSession`, `nextProblem`, `revealOffset`, `goToLine`, `selectHit`, `openFind`, `searchSelection`, `editRole`, `renderEditor`. Each one must compile against `CodeSurface`; fix whatever `tsc` reports.
- `editRole(role)` (~8080): for `selectAll` with an active editor, do `b.ta.setSelectionRange(0, b.ta.value.length)` and return without calling `api.win.edit`. For `copy`, `cut` and `paste`, keep `api.win.edit(role)`: Electron fires the matching DOM clipboard event on the focused hidden input, and Task 3 handles those.

- [ ] **Step 1: Write the preview checks.** Start the `breeze-static` preview config, open `http://localhost:5173/src/renderer/breeze.html` and run the setup:

```js
appState.onboarded = true; $('#onboard').classList.add('hidden'); $('#ide').classList.remove('hidden');
const src = (await fetch('/src/main/main.js').then(r => r.text())).replace(/\r\n/g, '\n');
let big = ''; while (big.length < 390000) big += src + '\n';
store.set('breeze.demoOpen', true);
if (!rootInfo) rootInfo = await api.fs.openFolder();
await api.fs.writeFile('big10k.js', big.slice(0, 390000)); openFile('big10k.js');
await new Promise(r => setTimeout(r, 1000)); window.__b = activeText(); __b.ta instanceof CodeSurface
// → true
```

Timing checks (each returns a median in ms):

```js
const med = a => a.sort((x, y) => x - y)[a.length >> 1];
const b = __b, ta = b.ta; ta.focus(); ta.setSelectionRange(200000, 200000);
const type = []; for (let i = 0; i < 15; i++) { const t = performance.now(); ta.input.value = 'q'; ta.input.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'q', bubbles: true })); renderCode(); document.body.offsetHeight; type.push(performance.now() - t); }
const undo = []; for (let i = 0; i < 5; i++) { b.lastEdit = null; const t = performance.now(); stepHistory(b, true); renderCode(); document.body.offsetHeight; undo.push(performance.now() - t); }
const rs = []; for (let i = 0; i < 9; i++) { const t = performance.now(); layout.side = 240 + i * 3; applyLayout(); document.body.offsetHeight; rs.push(performance.now() - t); }
({ type: med(type) <= 5, undo: med(undo) <= 10, resize: med(rs) <= 5 })
// → { type: true, undo: true, resize: true }
```

Behaviour checks, done with the `computer` tool on the real UI (take a screenshot after each group):
- Typing `(` inserts `()` and leaves the caret between them.
- Enter after `{` indents.
- Tab indents; Shift+Tab outdents.
- Typing `cons` shows the word suggestion; Tab accepts it.
- Ctrl+F highlights hits; Enter steps through them.
- Ctrl+G goes to line 5000 and the caret is visible.
- Ctrl+Z then Ctrl+Y round-trips.
- Switching tabs and back keeps the caret and scroll position.
- Typing `// สวัสดี ok` on a line, then clicking just before `ok`, puts the caret before `o`. The caret is drawn flush with the glyph.
- Ctrl+S saves (the dirty dot clears).

- [ ] **Step 2: Run the setup to see it fail** before the change. Expected: `→ false`.

- [ ] **Step 3: Make the changes above.** Run `npm run build` until it exits 0.

- [ ] **Step 4: Rerun the setup, timing and behaviour checks.** Expected: `true`, `{ type: true, undo: true, resize: true }`, and every behaviour check as described. `read_console_messages` with `onlyErrors` shows no errors.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/breezescript.ts src/renderer/breeze.css
git commit -m "perf: drive the main editor with CodeSurface instead of a full-file textarea"
```

---

### Task 5: Use `CodeSurface` for the split editor

**Files:**
- Modify: `src/renderer/breeze.html`: inside `.split-editor .code`, delete `<textarea class="split-ta" id="splitTa" …>` and keep `<pre class="hl" id="splitHl">`.
- Modify: `src/renderer/breezescript.ts` (~6106–6260)
- Modify: `src/renderer/breeze.css`: delete the `.split-ta` and `.split-ta::selection` rules (~1976–2000).

**Interfaces:**
- Consumes: `CodeSurface` (Tasks 2–3), `lineMeasurer` (Task 4).
- Produces: `const splitTa: CodeSurface`, built once at startup in `$('.split-editor .code')` with label `Right split editor` and `...lineMeasurer(splitLines, () => splitWin.first, () => splitBuf()?.text ?? '')`. `splitLines` and `splitWin` are declared before it, so move the construction below them.

Changes:
- The split's `input` listener mirrors edits into the left buffer's surface with `b.ta.value = b.text` and `setSelectionRange`. That code stays and is now cheap.
- The split's Tab keydown handler: replace `document.execCommand('insertText', false, INDENT)` with `splitTa.insertText(INDENT)`.
- `for (const ev of ['click', 'keyup', 'select'] as const) splitTa.addEventListener(ev, paintSplit)` becomes `splitTa.addEventListener('selectionchange', paintSplit)`.
- `focused() === splitTa` (in the `file.save` command, ~7959) becomes `focused() === splitTa.input`.

- [ ] **Step 1: Write the preview check.** With the Task 4 setup loaded, run:

```js
openSplit('big10k.js', true); await new Promise(r => setTimeout(r, 500));
const t = performance.now(); splitTa.focus(); splitTa.setSelectionRange(100, 100); splitTa.insertText('Q'); document.body.offsetHeight;
[splitTa instanceof CodeSurface, __b.ta.value[100], performance.now() - t < 10]
// → [true, "Q", true]
```

- [ ] **Step 2: Run it to see it fail.** Expected: `splitTa instanceof CodeSurface` is `false`.

- [ ] **Step 3: Make the changes.** Run `npm run build` until it exits 0.

- [ ] **Step 4: Rerun the check, then check by hand.** Typing in the split shows up on the left. The split's sash drag stays smooth. The Swap Sides button works. Expected: `[true, "Q", true]`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/breeze.html src/renderer/breezescript.ts src/renderer/breeze.css
git commit -m "perf: split editor uses CodeSurface"
```

---

### Task 6: Final verification in the desktop app

**Files:** none (fix-ups only, if something is found).

- [ ] **Step 1:** Run `npm run build && npm test`. Expected: exit 0, `fail 0`.
- [ ] **Step 2:** Run `npm start` (Electron). Open a real folder that has a file of at least 10,000 lines. Check each of these:
  - Holding a letter key down scrolls nothing and never stutters.
  - Ctrl+Z held down undoes smoothly.
  - Dragging the explorer and agent sashes stays smooth.
  - Copy, cut and paste through Ctrl+C/X/V and through the Edit menu.
  - Reopening the app restores tabs, caret and scroll.
  - An agent edit still shows its blue typing caret and green added lines.
- [ ] **Step 3:** If anything was fixed, commit with `fix: …`. Then push the branch and open a PR to `main`.
