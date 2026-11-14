# Agent board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A full-page Agent board where installed agents are dragged into boxes (2×2 grid, scrolls to 8) and run in parallel, with first-touch file ownership and a relay that sends a blocked edit to the owner's box and the answer back.

**Architecture:** A new main-process `BoardCoordinator` (`src/main/board.ts`) gives the existing run hooks the same surface `TeamCoordinator` does (`owners`, `members`, `foreignOwner`, `observe`), so deny lists, `checkTeamWrite` and restore-on-crossing work unchanged; it adds `relay` events. The renderer adds a `#board` screen; each box is its own chat `Surface` with one `AgentTabState`, so the existing chat rendering (`addMsg`, `handleAgentEvent`, cards) is reused. The relay queue and loop guard live in the renderer.

**Tech Stack:** Electron, TypeScript (CJS, compiled in place by root `tsconfig.json`), `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-14-agent-board-design.md`

## Global Constraints

- Renderer files are global scripts: a new `src/renderer/breeze/board.ts` must be added to `tsconfig.json` `files` (after `teams.ts`, before `views.ts`) and to `breeze.html` as `<script src="breeze/board.js" defer></script>` in the same position.
- Box keys are `box1`…`box8`. At most 8 boxes. Grid: 2 columns, each row `50%` of the page's grid height, always one empty row below the last filled one (until 8).
- Box display name: `<ShortName> · <n>` (e.g. `Claude · 1`), using `shortName` from `src/main/mentions.ts`.
- Relay diff cap: 200 lines. Loop guard: 3 relays in a row per pair of boxes with no message from the person.
- Restore recheck: reuse 300 ms (`RECHECK_MS` behaviour from `team.ts`).
- Shortcut: Ctrl+Shift+B. Button `#boardBtn`, title `Agent board (Ctrl+Shift+B)`.
- Every box runs in `build` mode. No attachments, no mode select.
- Board is IDE-only (not on the Breeze Box surface). A folder change stops the board.
- Git: commit only when the person asks; work is on `main`, so branch first (`feat/agent-board`) if asked to commit.
- Before any `cargo`/engine command in Git Bash, put msys64 ucrt64 on PATH (see memory). `npm test` runs `tsc` first.

## Review Focus

1. **Same agent in two boxes** — two Claude boxes must own files separately and get separate sessions. Pinned in Task 1 test `same agent in two boxes is two owners`.
2. **Relay to a busy or emptied box** — must queue (busy) or show "Box N is empty" with Drop (emptied), never start a second run on a busy box. Pinned in Task 6 test `relayQueue holds a relay until the box is idle`.
3. **Relay ping-pong** — the 4th automatic relay between the same pair must pause. Pinned in Task 6 test `relayQueue pauses after 3 hops in a row`.
4. **Crossing on a file nobody snapshotted yet** (owner created it, asker overwrote it) — restore must bring back the owner's version, not delete it. Pinned in Task 2 test `crossing restores the owner's latest version`.
5. **Stop all while a relay is waiting** — nothing starts afterwards. Pinned in Task 6 test `stopAll drops waiting relays`.

---

### Task 1: BoardCoordinator ownership and box runs

**Files:**
- Create: `src/main/board.ts`
- Test: `test/board.test.js`

**Interfaces:**
- Consumes (from `src/main/team.ts`, already exported): `cleanRel`, `ownerOf`, `claimFirstTouch`, `addToSnapshot`, `restore`, `notesFor`, types `RunId`, `Owners`, `RunEvent`, `Snapshot`.
- Produces:
  - `interface BoxMember { agentId: string /* box key */; agent: string /* real agent id */; name: string }`
  - `interface BoardDeps { startRun(opts: { agent: string; mode: 'build'; prompt: string; session?: string | null; team: { coordinator: BoardCoordinator; agentId: string } }): RunId; stopRun(id: RunId): void; emit(id: RunId, ev: RunEvent): void; setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout }`
  - `class BoardCoordinator { id: string; root: string; owners: Owners; members: BoxMember[]; constructor({ id, root, deps }); startBox(boxKey: string, o: { agent: string; name: string; prompt: string; session?: string | null }): RunId; foreignOwner(boxKey: string, rel: string): Promise<string | null>; observe(runId: RunId, ev: RunEvent): boolean; release(rel: string): void; stopBox(boxKey: string): void; stopAll(): void; hasRun(runId: RunId): boolean }`
  - `function boardBrief(member: BoxMember, prompt: string, board: { members: BoxMember[]; owners: Owners }): string`
  - `function lineDiff(before: string, after: string, max = 200): string`

- [ ] **Step 1: Write the failing tests** in `test/board.test.js`, with a `fakeDeps()` like `team.test.js` (records `runs: {opts}[]`, `emitted: [id, ev][]`, `stopped: id[]`, returns ids 1, 2, …):
  - `startBox starts a build run keyed by the box` — `startBox('box1', { agent: 'claude', name: 'Claude · 1', prompt: 'make UI' })` → `deps.runs[0].opts` has `agent: 'claude'`, `mode: 'build'`, `team.agentId: 'box1'`; `members` has one entry `{ agentId: 'box1', agent: 'claude', name: 'Claude · 1' }`.
  - `same agent in two boxes is two owners` — two Claude boxes; `await foreignOwner('box1', 'a.js')` → `null`; `await foreignOwner('box2', 'a.js')` → `'box1'`; `owners['a.js'] === 'box1'`.
  - `startBox on a running box throws` — a second `startBox('box1', …)` before its `done` rejects with `/still working/`.
  - `boardBrief lists teammates and what not to edit` — with `owners { 'web/': 'box2' }`, the brief for box1 contains `make UI`, `Codex · 2`, `Do not edit: web/`, and `For Codex · 2:`.
  - `lineDiff trims the common start and end` — `lineDiff('a\nb\nc', 'a\nX\nc')` === `'@@ line 2\n-b\n+X'`; a 500-line change returns 200 lines plus `… 300 more lines`.
  - `release frees a file` — after `release('a.js')`, `foreignOwner('box2','a.js')` → `null`.
  - `stopAll stops every running box` — two boxes started → `deps.stopped` deep-equals `[1, 2]`.

- [ ] **Step 2: Run to see them fail**
  Run: `npx tsc && node --test test/board.test.js`
  Expected: FAIL, `Cannot find module '../src/main/board'`.

- [ ] **Step 3: Implement `src/main/board.ts`**
  - `foreignOwner` mirrors `TeamCoordinator.foreignOwner` (first-touch claim, `addToSnapshot` for a newly owned path into a snapshot started empty `{ files: new Map(), skipped: [] }` in the constructor).
  - `boardBrief`: the prompt, then "You are <name> on an Agent board. Teammates: <name> (working on: <their last prompt, first line>)…", "Do not edit: <paths owned by others, comma-separated>" (omit the line when none), "If you need a change in a teammate's file, don't make it. Say so at the end of your final message under a line 'For <name>:'".
  - `lineDiff`: common-prefix/common-suffix trim by line, header `@@ line <first differing line, 1-based>`, then `-` lines then `+` lines, capped at `max` with `… N more lines`.
  - A box's runs are tracked in `runs: Map<RunId, { boxKey, lastText, done }>`; `members` keeps one entry per box (replaced when the box's agent changes).

- [ ] **Step 4: Run to see them pass**
  Run: `npx tsc && node --test test/board.test.js`
  Expected: PASS (7 tests).

---

### Task 2: Crossings and relay events

**Files:**
- Modify: `src/main/board.ts`
- Test: `test/board.test.js`

**Interfaces:**
- Consumes: Task 1.
- Produces: events emitted on the **asking** box's run id:
  - `{ t: 'crossing', path, agent: fromBox, owner: toBox, error? }` (same shape as teams)
  - `{ t: 'relay', from: fromBox, to: toBox, path?: string, diff?: string, note?: string }`
  - `BoardCoordinator.settled(): Promise<void>` (for tests, as in `TeamCoordinator`).

- [ ] **Step 1: Write the failing tests** (temp folder like `team.test.js`'s `newTeam`):
  - `crossing restores the owner's latest version` — box2 creates `api.ts` (`'v1'` on disk, `observe(id2, {t:'file', path})`), box2 changes it to `'v2'` + file event, box1 writes `'hack'` + file event; after `settled()` the file reads `'v2'`, and emitted contains a `crossing` with `owner: 'box2'` and a `relay` with `from: 'box1'`, `to: 'box2'`, `path: 'api.ts'`, and `diff` containing `-v2` and `+hack`.
  - `a For note on done relays` — box1's last text ends with `For Codex · 2:\nexport getUser`; `observe(id1, { t: 'done', ok: true })` → a `relay` with `to: 'box2'`, `note: 'export getUser'`.
  - `observe never hides board events` — every `observe` call returns `false`.
  - `crossing on a blocked write emits no restore` — a `crossing` emitted by main with `blocked: true` is not produced here; `foreignOwner` only (no file change) → no `relay` with a diff. (Guards against double relays for Claude Code / Local, whose `checkTeamWrite` already emits the crossing.)

- [ ] **Step 2: Run to see them fail**
  Run: `npx tsc && node --test test/board.test.js`
  Expected: FAIL on the 4 new tests.

- [ ] **Step 3: Implement**
  - On `file` from the owner: refresh its snapshot entry (as `TeamCoordinator.#refresh`).
  - On `file` from a non-owner: read the file (the attempted content), `restore`, recheck after 300 ms, emit `crossing`, then `relay` with `lineDiff(ownerVersion, attempted)`. Keep a per-path lane so restores never overlap (as `#inLane`).
  - On `done`: `notesFor(lastText, otherNames)` → one `relay` per note, `to` resolved from the name back to the box key.
  - For a blocked write (main's `checkTeamWrite`), main emits the `crossing`; add `BoardCoordinator.blocked(fromBox, toBox, rel)` that emits only the `relay` (no diff, `note: 'Tried to edit <rel>'`), and call it from `checkTeamWrite` in Task 3.

- [ ] **Step 4: Run to see them pass**
  Run: `npx tsc && node --test test/board.test.js`
  Expected: PASS (11 tests).

---

### Task 3: Main-process wiring and preload

**Files:**
- Modify: `src/main/main.ts` (near `teams` at ~2446, `teamOf` at 2092, `checkTeamWrite` at ~2956, folder-change lines 528 and 756)
- Modify: `src/main/preload.ts` (next to `team:` at 169)
- Test: `test/board.wiring.test.js` (source-text test, as the main-process memory note describes)

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces (renderer API, `api.board`):
  - `open(): Promise<{ boardId: string; owners: Record<string, string> }>`
  - `run(o: { boxKey: string; agent: string; prompt: string; session: string | null }): Promise<number>` (run id; events arrive on `agent:event` like any run)
  - `stop(boxKey: string): Promise<void>`, `stopAll(): Promise<void>`, `release(path: string): Promise<void>`, `owners(): Promise<Record<string, string>>`

- [ ] **Step 1: Write the failing source-text test** — reads `main.ts` and `preload.ts` and asserts: `handle('board:open'`, `'board:run'`, `'board:stop'`, `'board:stopAll'`, `'board:release'`, `'board:owners'` exist; `stopBoard()` appears on both folder-change lines next to `stopTeams()`; preload has `board: {` with `invoke('board:run'`.

- [ ] **Step 2: Run to see it fail**
  Run: `node --test test/board.wiring.test.js`
  Expected: FAIL.

- [ ] **Step 3: Implement**
  - One `board: BoardCoordinator | null` for the open root; `board:open` creates it with `deps = { startRun: launchRun, stopRun, emit: sendEvent, setTimeout, clearTimeout }`.
  - `board:run` validates: `boxKey` matches `/^box[1-8]$/`, the agent is found (`teamAgents()`), `prompt` is a string (slice to `MAX_TASK`), `session` passes `SAFE_ID` or is null; name is `` `${shortName(agent)} · ${boxKey.slice(3)}` ``.
  - Widen `teamOf`'s type to `TeamCoordinator | BoardCoordinator` (add a shared `interface RunCoordinator { id; owners; members; foreignOwner; observe }` in `team.ts` and type against it).
  - `checkTeamWrite`: after emitting the crossing, call `coordinator.blocked?.(agentId, owner, rel)`.
  - `stopBoard()` = `board?.stopAll(); board = null`, called next to `stopTeams()` on both folder-change paths.

- [ ] **Step 4: Run all tests**
  Run: `npm test`
  Expected: PASS, including `team.test.js` unchanged.

---

### Task 4: Renderer surfaces for boxes

**Files:**
- Modify: `src/renderer/breeze/agents.ts` (`SURFACES` 94, `surfaceTabs`/`activeTabId` 181–182, `attachmentsMap` 91, `agentInkAt`, `renderAgentTabs`)
- Modify: `src/renderer/breeze/teams.ts` (`startAgentRun` 354)
- Modify: `src/renderer/breeze/core.ts` (`AgentEvent` type: add `'relay'`, `from?`, `to?`, `diff?`, `note?`)

**Interfaces:**
- Produces:
  - ``type SurfaceName = WorkMode | `board:${string}` `` — a box's surface is named `board:box1`…`board:box8` (the `board:` prefix keeps it apart from the Breeze Box surface `box`).
  - `function isBoardSurface(name: SurfaceName): boolean` and `function boxKeyOf(name: SurfaceName): string` (`'board:box1'` → `'box1'`).
  - `function registerSurface(s: Surface): void` — adds to `SURFACES`, `surfaceTabs`, `activeTabId`, `attachmentsMap`, `agentInkAt`.
  - `startAgentRun` launches through `api.board.run({ boxKey, agent, prompt, session })` when `isBoardSurface(tab.surfaceName)`, else `api.agent.run` as now.

- [ ] **Step 1:** Change the records' key type to `SurfaceName`, add `registerSurface` and `isBoardSurface`. `renderAgentTabs` and `placeAgentTabInk` return early for a board surface (a box has one tab and no tab strip). `onAgentFile` treats a board surface like `ide` for opening files only when the board page is not showing (else `liveFile`).
- [ ] **Step 2:** Branch `startAgentRun` as above.
- [ ] **Step 3: Verify nothing else broke**
  Run: `npm test`
  Expected: PASS, `tsc` clean.

---

### Task 5: The board page, roster, and boxes

**Files:**
- Create: `src/renderer/breeze/board.ts`
- Modify: `src/renderer/breeze.html` (button after `#debugBtn` at 486; new `<section id="board" class="screen hidden">` next to `#debug`; script tag), `src/renderer/breeze.css`, `src/renderer/breeze/setup.ts:1291` (add `'#board'` to the screens list; light `#boardBtn` like `#debugBtn`), `src/renderer/breeze/debugview.ts` (rail copy: the board button stays unlit there), `tsconfig.json`
- Test: `test/board.page.test.js` (source-text)

**Interfaces:**
- Consumes: Task 3 `api.board`, Task 4 `registerSurface`, `createAgentTab`, `startAgentRun`, `stopAgent`, `BRAND_ICONS`, `appState.detect`, `openAgentPicker`, `agentPillMenuItems`, `popupMenu`, `swapScreen`, `showIde`.
- Produces: `openBoard(): void`, `leaveBoard(): void`, `boardBoxes: Map<string /* box1… */, { agent: string; surface: Surface; tab: AgentTabState }>`, `boardStatus(boxKey): 'idle' | 'working' | 'waiting' | 'done' | 'failed'`, `fillBox(boxKey, agent): void`, `emptyBox(boxKey): Promise<void>`.

- [ ] **Step 1: Write the failing source-text test** — `breeze.html` contains `id="boardBtn"`, `id="board"`, `breeze/board.js`; `tsconfig.json` lists `src/renderer/breeze/board.ts`; `setup.ts` screens list contains `'#board'`; `board.ts` handles `dragstart`, `drop`, and `Ctrl+Shift+B`.
- [ ] **Step 2: Run to see it fail** — `node --test test/board.page.test.js` → FAIL.
- [ ] **Step 3: Implement the page**
  - Title bar: Back (`leaveBoard` → `showIde`), Auto-relay toggle (Task 6), Stop all.
  - Roster: one draggable chip per found agent (`draggable="true"`, `dataTransfer.setData('text/breeze-agent', id)`); none found → "Choose an agent" (`openAgentPicker`).
  - Grid: renders filled boxes in key order plus empty boxes up to `max(4, filled rounded up to even + 2)`, capped at 8. Empty box: dashed, "Drop an agent here", `dragover` highlight, Enter opens a `popupMenu` of agents.
  - `fillBox`: builds the box DOM (header: logo, `Claude · 1`, model chevron → `agentPillMenuItems`, status dot, "owns N files" link, ✕), a chat element, a prompt + Send; `registerSurface({ name: 'board:box1', … })`; `createAgentTab` on it.
  - Drop on an idle filled box replaces the agent and starts a new chat; on a working box adds class `shake` for 400 ms and does nothing else.
  - Double-click a header toggles `.box-max`; Esc restores.
  - Persist `{ boxKey: agent }` and each tab's chat (`saveChat`) per folder in `store` under `breeze.board.<root>`; restore on `openBoard`.
  - Status bar: "Agent board — N working · Open" while any box works and the page is hidden.
- [ ] **Step 4: Run** `npm test` → PASS.

---

### Task 6: Relay queue, cards, loop guard

**Files:**
- Create: `src/renderer/breeze/boardrelay.ts` (pure, no DOM, so it can be tested in node: same pattern as `conflictcore.ts`/`explaincore.ts`)
- Modify: `src/renderer/breeze/board.ts`, `src/renderer/breeze/teams.ts` (`AGENT_EVENTS`: add `relay`; crossing card wording for board tabs: "<name> tried to edit `<path>` (<owner name>). Breeze put it back and asked <owner short>.")
- Modify: `tsconfig.json`, `breeze.html` (script before `board.js`)
- Test: `test/boardrelay.test.js`

**Interfaces:**
- Produces in `boardrelay.ts`:
  - `interface Relay { id: string; from: string; to: string; path?: string; diff?: string; note?: string; kind: 'ask' | 'reply' }`
  - `class RelayQueue { auto: boolean; constructor(limit = 3); push(r: Relay, isIdle: (box: string) => boolean): 'start' | 'queued' | 'paused'; next(box: string): Relay | null; personSpoke(box: string): void; drop(id: string): void; stopAll(): void; waiting(box: string): Relay[] }`
  - `function relayPrompt(r: Relay, fromName: string): string` — ask: "<fromName> needs a change in your files.\n<path/diff or note>\nMake it if it fits your task, then say what you did in one or two lines." reply: "<fromName> answered your request:\n<note>\nContinue your task."

- [ ] **Step 1: Write the failing tests:**
  - `relayQueue holds a relay until the box is idle` — `push(r, () => false)` → `'queued'`; `next('box2')` returns it.
  - `relayQueue pauses after 3 hops in a row` — four pushes between box1↔box2 with idle boxes → `['start','start','start','paused']`; after `personSpoke('box1')`, the next push → `'start'`.
  - `auto off pauses everything` — `auto = false` → `'paused'`.
  - `stopAll drops waiting relays` — after `stopAll()`, `next('box2')` → `null`.
  - `relayPrompt includes the diff` — contains `Claude · 1` and the diff text.
- [ ] **Step 2: Run to see them fail** — `npx tsc && node --test test/boardrelay.test.js` → FAIL.
- [ ] **Step 3: Implement `boardrelay.ts`**, then wire in `board.ts`:
  - `relay` event (ask) → card in the asking box ("Asked Codex · 2"), incoming card in the target box ("From Claude · 1", diff in a `<pre>`), then per `push` result: `'start'` → `startAgentRun(agent, 'build', relayPrompt(...), 'build', targetTab)`; `'queued'` → card says "Waiting for Codex · 2 to finish"; `'paused'` → card with **Send** / **Drop**.
  - When a relay run ends, its final text goes back as a `kind: 'reply'` relay to the asker (same queue rules). The asker's dot shows `waiting` while its ask is open.
  - On any box run's `done`, call `next(box)` and start the waiting relay if any.
  - Target box empty → card "Box N is empty" with **Drop**.
  - The person sending from a box calls `personSpoke(box)`. Stop all → `api.board.stopAll()` + `queue.stopAll()`.
- [ ] **Step 4: Run** `npm test` → PASS.

---

### Task 7: Check it in the running app

- [ ] **Step 1:** Launch Breeze and drive it over CDP (see memory `breeze-cdp-app-check`). Open a scratch folder.
- [ ] **Step 2:** Ctrl+Shift+B opens the board; the roster shows installed agents; 4 empty boxes; scrolling shows more after filling 3.
- [ ] **Step 3:** Drag Claude into box 1 and Codex into box 2. Box 2: "create api.ts exporting getUser". Then box 1: "edit api.ts to add getPosts". Expect: a crossing card in box 1, an incoming relay card in box 2, box 2 runs, a reply card in box 1, and box 1 continues.
- [ ] **Step 4:** Stop all stops both; nothing starts afterwards. Screenshot the board for the person.

---

## Self-review notes

- Spec coverage: button/page (T5), roster + drag (T5), grid 4→8 (T5), per-box chat/prompt (T4, T5), ownership first-touch + release (T1, T3, T5 "owns N files"), relay crossing/diff/notes (T2), queue/cards/reply (T6), loop guard + Auto-relay + Stop all (T6), status bar (T5), folder change (T3), errors: failed box / emptied box / restore failure reuse crossing card (T6, T2).
- Type names checked across tasks: `BoardCoordinator`, `BoxMember`, `boxKey`, `RelayQueue`, `relayPrompt`, `registerSurface`, `isBoardSurface`.
