# First-run Tips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The first time a user opens the code editor, Source Control, the Agent Board, Debug or Manage agents, a blue
bubble points at one control on that screen; it can be closed at any time and never returns.

**Architecture:** A pure module (`tipscore.ts`: the tip list, seen-state, placement math) tested in Node like
`statuscore.ts`, and a DOM module (`tips.ts`) that draws one bubble at a time. Each screen's existing open function
calls `offerTip(id)`. Settings → Miscellaneous gets a Show tips again row.

**Tech Stack:** TypeScript page scripts (no modules, globals shared across `breeze/*.js`), `tsc`, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-26-first-run-tips-design.md`

## Global Constraints

- Colours live in `breeze.css`; the CSP blocks inline `style` attributes, so position with `el.style.left/top` from script only.
- Pop-in animation only when `motionReduced()` (ui.ts) is false and `document.documentElement.dataset.power !== 'saver'`.
- Readable on dark, light and high-contrast themes: background `var(--blue)`, text `var(--on-blue)`.
- Seen-state key: `breeze.tipsSeen` in `store` (core.ts), shape `{ seen: TipId[]; skipped: boolean }`.
- Tips never show before `appState.onboarded` is true.
- Only one bubble at a time; it never dims the screen, traps focus or blocks clicks outside itself.
- The user commits; plan steps end in a checkpoint, not a `git commit` (project memory: commit only when asked).

## Review Focus

- Target control hidden (`#scmGenMsg` has `.hidden` with no changes; agents panel closed hides `#prompt`): no bubble, and the tip stays unseen for a later visit.
- Screen left while a bubble is up (board → editor): the bubble closes without marking that tip seen.
- Window resized or panel dragged with a bubble up: it follows its control and stays inside the window.
- Target near the window's top or right edge: the bubble flips below/left and stays on screen.
- Two screens opened quickly (board then debug): the second waits; never two bubbles.

---

### Task 1: Tip list, seen-state and placement (pure)

**Files:**
- Create: `src/renderer/breeze/tipscore.ts`
- Test: `test/tipscore.test.js` (load with `vm` + `stripTypeScriptTypes`, as `test/statuscore.test.js` does)

**Interfaces:**
- Produces:
  - `type TipId = 'editor' | 'scm' | 'board' | 'debug' | 'agents'`
  - `interface TipDef { id: TipId; target: string; text: string; action: string }` — `text` contains one `**bold**` span.
  - `const TIPS: TipDef[]` with exactly the spec table:
    - editor: `#prompt`, `Ask an **agent** to write or change code here.`, `Try it`
    - scm: `#scmGenMsg`, `Let the agent write your **commit message**.`, `Generate`
    - board: `#boardSideNew`, `Each **chat** runs its own agent in a box of its own.`, `New chat`
    - debug: `#dbgGo`, `Start your program and **pause** at breakpoints.`, `Start`
    - agents: `#pickList`, `Pick which **AI agent** Breeze uses.`, `Got it`
  - `interface TipsState { seen: TipId[]; skipped: boolean }`
  - `function tipsState(raw: unknown): TipsState` — anything malformed becomes `{ seen: [], skipped: false }`; unknown ids dropped.
  - `function shouldOffer(s: TipsState, id: TipId, onboarded: boolean): boolean`
  - `function markSeen(s: TipsState, id: TipId): TipsState` (new object, no duplicates)
  - `function placeTip(target: Rect, bubble: Size, view: Size): { left: number; top: number; side: 'above' | 'below'; arrowX: number }`
    with `Rect = { left; top; width; height }`, `Size = { width; height }`. Gap 10px between bubble and target, 8px margin to window edges.

- [ ] **Step 1: Write the failing tests**

```js
test('every screen has one tip with the spec wording', () => {
  assert.deepEqual(plain(TIPS.map(t => [t.id, t.target])), [['editor', '#prompt'], ['scm', '#scmGenMsg'], ['board', '#boardSideNew'], ['debug', '#dbgGo'], ['agents', '#pickList']]);
  for (const t of TIPS) assert.equal((t.text.match(/\*\*/g) || []).length, 2, t.id);
});
test('tipsState repairs bad stored values', () => {
  assert.deepEqual(plain(tipsState(null)), { seen: [], skipped: false });
  assert.deepEqual(plain(tipsState({ seen: ['board', 'nope', 3], skipped: 'yes' })), { seen: ['board'], skipped: false });
});
test('shouldOffer: only after setup, once per tip, never after skip all', () => {
  const s = tipsState(null);
  assert.equal(shouldOffer(s, 'board', false), false);
  assert.equal(shouldOffer(s, 'board', true), true);
  assert.equal(shouldOffer(markSeen(s, 'board'), 'board', true), false);
  assert.equal(shouldOffer(markSeen(s, 'board'), 'debug', true), true);
  assert.equal(shouldOffer({ seen: [], skipped: true }, 'debug', true), false);
});
test('markSeen adds once and leaves the input alone', () => {
  const s = tipsState(null), a = markSeen(markSeen(s, 'scm'), 'scm');
  assert.deepEqual(plain(a.seen), ['scm']); assert.deepEqual(plain(s.seen), []);
});
test('placeTip: above when there is room, centred on the target', () => {
  const p = placeTip({ left: 500, top: 400, width: 40, height: 20 }, { width: 260, height: 100 }, { width: 1200, height: 800 });
  assert.deepEqual(plain(p), { left: 390, top: 290, side: 'above', arrowX: 130 });
});
test('placeTip: flips below near the top and stays inside the window', () => {
  const p = placeTip({ left: 1170, top: 10, width: 24, height: 24 }, { width: 260, height: 100 }, { width: 1200, height: 800 });
  assert.equal(p.side, 'below'); assert.equal(p.top, 44); assert.equal(p.left, 1200 - 8 - 260);
  assert.equal(p.arrowX, 244); // the target's centre (1182 - 932 = 250), clamped 16px inside the bubble's edge
});
```

- [ ] **Step 2: Run and see them fail**

Run: `node --test test/tipscore.test.js`
Expected: FAIL (file `tipscore.ts` not found).

- [ ] **Step 3: Implement `tipscore.ts`** per the Interfaces block. No DOM, no globals from other files (same rule as statuscore.ts). Clamp `arrowX` to `[16, bubble.width - 16]`.

- [ ] **Step 4: Run and see them pass**

Run: `node --test test/tipscore.test.js` → all pass. Run `npx tsc` → exit 0.

- [ ] **Step 5: Checkpoint** — `git status` shows only the two new files.

### Task 2: The bubble

**Files:**
- Create: `src/renderer/breeze/tips.ts`
- Modify: `src/renderer/breeze.html` (add `<script src="breeze/tipscore.js" defer></script>` after `statuscore.js`, and `breeze/tips.js` before `whatsnew.js`)
- Modify: `src/renderer/breeze.css` (new section near `.whatsnew-link`)
- Test: `test/tips.wiring.test.js` (source-text checks, as `test/power.wiring.test.js`)

**Interfaces:**
- Consumes: everything in Task 1; `store`, `appState`, `$`, `esc`, `svgIcon`, `SPRING_BOUNCE` (core.ts); `motionReduced` (ui.ts).
- Produces:
  - `function offerTip(id: TipId, act?: () => void): void` — shows that tip if `shouldOffer`, its target matches, is connected and visible (`getClientRects().length > 0` and no `.hidden` ancestor), and no other bubble is up; otherwise does nothing. Calls `act` when the action button is pressed.
  - `function closeTip(seen: boolean): void`
  - `function resetTips(): void` — writes `{ seen: [], skipped: false }`.

Behaviour:
- Markup: `<div class="tip-bubble" role="dialog" aria-label="Tip">` with the text (`**x**` → `<b>x</b>`, rest escaped), a close `button.tip-x` (aria-label "Close tip"), a `button.tip-act` (play icon + label), a `button.tip-skip` "Skip all tips", and `i.tip-arrow`. Appended to `document.body`.
- Action button, × and Escape: `closeTip(true)`; action also calls `act`. Skip all: store `skipped: true`, then close.
- Re-place with `placeTip` on `resize` and every animation frame while open; if the target is gone or hidden, `closeTip(false)`.
- Data attribute `data-side="above|below"` sets the arrow's edge; `--arrow-x` set with `el.style.setProperty`.

- [ ] **Step 1: Write the failing wiring test**

```js
test('page loads the tip scripts in order', () => {
  assert.ok(page.indexOf('breeze/tipscore.js') > page.indexOf('breeze/statuscore.js'));
  assert.ok(page.indexOf('breeze/tips.js') < page.indexOf('breeze/whatsnew.js'));
});
test('bubble is blue, readable, and styled in the stylesheet', () => {
  assert.match(css, /\.tip-bubble\s*\{[^}]*background:\s*var\(--blue\)/);
  assert.match(css, /\.tip-bubble\s*\{[^}]*color:\s*var\(--on-blue\)/);
  assert.match(css, /\.tip-act\s*\{[^}]*border:[^;]*dashed/);
});
test('tips respect seen-state, motion and the power saver', () => {
  const t = r('tips');
  assert.match(t, /store\.get[^\n]*'breeze\.tipsSeen'/);
  assert.match(t, /motionReduced\(\)/);
  assert.match(t, /dataset\.power/);
  assert.doesNotMatch(t, /setAttribute\('style'/);
});
```

- [ ] **Step 2: Run and see it fail** — `node --test test/tips.wiring.test.js` fails on the missing script tags.

- [ ] **Step 3: Implement `tips.ts`, the CSS and the script tags.** CSS: `.tip-bubble` fixed, `z-index` above panels but below `#menuRoot` and `#modalRoot` (read their z-index in breeze.css and sit one below); `max-width: 280px`; radius 12px; shadow; `.tip-act` dashed `rgba(255,255,255,.55)` outline pill; `.tip-skip` small, underlined on hover; arrow is a rotated 10px square at `left: var(--arrow-x)`.

- [ ] **Step 4: Run** `npx tsc` (exit 0) and `node --test test/tips.wiring.test.js test/tipscore.test.js` (pass).

- [ ] **Step 5: Checkpoint.**

### Task 3: Offer the tips on each screen, and Show tips again

**Files:**
- Modify: `src/renderer/breeze/setup.ts` — end of `showIde()` (line ~1554): `offerTip('editor', () => $('#prompt').focus())`; inside `openAgentPicker()`'s open callback after the first render: `offerTip('agents')`
- Modify: `src/renderer/breeze/prs.ts` — end of `openScmPage()`: `offerTip('scm', () => run('git.genCommitMsg'))`
- Modify: `src/renderer/breeze/board.ts` — end of `openBoard()` (after the early return): `offerTip('board', () => $('#boardSideNew').click())`
- Modify: `src/renderer/breeze/debugview.ts` — end of `openDebugView()`: `offerTip('debug', () => run('run.start'))`
- Modify: `src/renderer/breeze/settings.ts` — in `case 'misc'`, a `<h5>Tips</h5>` + `settingRow('Show tips again', 'The blue tips come back the next time you open each screen.', '<button class="btn btn-sm" id="sTipsReset">Show again</button>')`; bind with `on('sTipsReset', () => { resetTips(); toast('Tips will show again'); })`; add `tips: 'show tips again', tutorial: 'show tips again'` to `SETTINGS_SYNONYMS`.
- Modify: `README.md` feature table — one row: `| **Tips** | The first time you open each screen, a blue tip points at where to start |`
- Test: extend `test/tips.wiring.test.js`

Each screen calls `offerTip` after a `requestAnimationFrame`, so the screen has laid out before the target's visibility is checked. Leaving a screen needs no hook: Task 2's frame loop closes the bubble once its target is hidden.

- [ ] **Step 1: Write the failing test**

```js
test('each screen offers its tip when it opens', () => {
  for (const [file, fn, id] of [['setup', 'showIde', 'editor'], ['setup', 'openAgentPicker', 'agents'], ['prs', 'openScmPage', 'scm'], ['board', 'openBoard', 'board'], ['debugview', 'openDebugView', 'debug']]) {
    const src = r(file), body = src.slice(src.indexOf(`function ${fn}(`)); 
    assert.match(body.slice(0, body.indexOf('\n}\n')), new RegExp(`offerTip\\('${id}'`), `${fn} → ${id}`);
  }
});
test('Settings can bring the tips back', () => {
  const s = r('settings');
  assert.match(s, /id="sTipsReset"/);
  assert.match(s, /on\('sTipsReset'[^\n]*resetTips\(\)/);
});
```

- [ ] **Step 2: Run and see it fail** — `node --test test/tips.wiring.test.js`.

- [ ] **Step 3: Add the calls, the Settings row and the README line** as listed above.

- [ ] **Step 4: Verify**

Run: `npx tsc` → exit 0; `node --test test/tipscore.test.js test/tips.wiring.test.js` → pass; full suite without the debugger tests (`ls test/*.test.js | grep -v /debug | xargs node --test`) → only the 5 failures that already fail on `main` (editcore curveFrames, two power.wiring saver tests, previewInspect, secondbrain links).

Then in the app (`npm start`) with `localStorage.removeItem('breeze.tipsSeen')` in DevTools: open the editor, Source Control (with a changed file), the board, Debug and Manage agents; each shows its bubble once; × / Escape / Skip all work; Settings → Miscellaneous → Show again brings them back.

- [ ] **Step 5: Checkpoint** — hand the diff to the user to commit.
