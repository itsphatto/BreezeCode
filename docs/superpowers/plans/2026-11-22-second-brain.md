# Second Brain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-folder memory nodes captured from agent compactions, shown as an interactive graph from the board's folder header.

**Architecture:** A pure, Electron-free module `src/main/secondbrain.ts` holds the store, the summary parser, the link builder and the log readers. `main.ts` calls it from the Claude, Codex and local-loop paths and exposes IPC. A new renderer file `src/renderer/breeze/brain.ts` draws the canvas graph overlay; `board.ts` opens it from a context menu.

**Tech Stack:** TypeScript (CJS via root tsconfig), node:test, plain canvas 2D. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-22-second-brain-design.md`

## Global Constraints
- Storage: `second-brain.json` in userData; scope keys from `scopeOf()` in `agentmemory.ts`.
- Node text ≤ 300 characters; ≤ 1500 nodes per folder; top 6 links per node; Jaccard ≥ 0.25.
- No secrets (`memoryRefusal`) and no network calls.
- Keep CRLF in files that use it; don't touch the other session's uncommitted changes.
- UI: Unbounded headline, sizes on 10–24 scale, panel easing `.4s cubic-bezier(.32,.72,0,1)`, sentence case, no emoji.

## Review Focus
- A summary with a fenced code block or a pasted key → no node is kept from it (test in Task 1).
- The same compaction seen twice (stream and log) → nodes are not doubled; `hits` increases instead (Task 1).
- Two folders differing only in case on Windows → share one brain (Task 1, `scopeOf` win32).
- A folder with no memories → the overlay shows an empty state, not a blank canvas (Task 3, checked in demo).
- A corrupt or missing `second-brain.json` → the store starts empty and doesn't throw (Task 1).

---

### Task 1: `secondbrain.ts` store, parser, links, log readers

**Files:** Create `src/main/secondbrain.ts`, `test/secondbrain.test.js`.

**Interfaces (produces):**
- `type Kind = 'fact'|'decision'|'task'|'file'`
- `interface BrainNode { id: string; kind: Kind; text: string; at: number; agent: string; hits: number }`
- `interface BrainLink { a: string; b: string; w: number }`
- `extractMemories(summary: string): { kind: Kind; text: string }[]` (file nodes included, text = path)
- `filesIn(text: string): string[]`
- `buildLinks(nodes: BrainNode[], maxPerNode = 6, minJaccard = 0.25): BrainLink[]`
- `class BrainStore { constructor(file: string|null, platform?: string); addSummary(folder: string, summary: string, agent: string, now?: number): number /* nodes added or bumped */; addFacts(folder, texts: string[], agent, now?): number; graph(folder): { nodes: BrainNode[]; links: BrainLink[] }; remove(folder, id): boolean; seen(key: string): boolean /* summary hash dedupe, persisted */ }`
- `claudeCompactSummary(lines: string[]): string|null` (last `isCompactSummary` user line's text)
- `codexCompactions(lines: string[]): string[]` (`compacted` payload messages)
- `droppedReplies(before: ChatMessage[], after: ChatMessage[]): string[]` (assistant texts in `before` missing from `after`)

- [ ] Tests: Claude-style summary with "2. Key Technical Concepts:", "3. Files and Code Sections:", "6. All user messages:", "7. Pending Tasks:" headings → kinds fact/file/task, nothing from section 6, no text inside ``` fences; plain summary "We decided to use pnpm" → decision; secret bullet dropped; same summary twice → node count unchanged and hits 2; cap 1500 drops least-hit oldest; folder scopes `C:\A` and `c:\a` on win32 are one brain; links: two facts naming `src/a.ts` linked, unrelated facts not, ≤ 6 per node; codex/claude log line parsers; `droppedReplies`; corrupt file → empty.
- [ ] Run `npx tsc && node --test test/secondbrain.test.js` → fail, then implement, then pass.

### Task 2: Capture + IPC in main, preload, types, demo

**Files:** Modify `src/main/main.ts` (claudeEvent, codex turn end, local loop at `brain.compactHistory` call, new handlers), `src/main/preload.ts`, `src/renderer/breeze/core.ts` (BreezeApi), `src/renderer/breeze/platform.ts` (demoApi `brain`).

**Interfaces:** `api.brain.graph(folder) → {nodes, links}`, `api.brain.remove(folder, id) → boolean`, `api.brain.onChange(cb: ({folder}) => void)`. IPC channels `brain:graph`, `brain:remove`, push `brain:changed`.

- [ ] Claude: on `system/compact_boundary` or a `user` event with `isCompactSummary`, take the summary text (or read the session JSONL via `claudeCompactSummary`), `addSummary(base, text, 'claude')` deduped by `seen(hash)`.
- [ ] Codex: at turn completion, read the thread rollout (same lookup as `codexContext`) and add each unseen `codexCompactions` entry.
- [ ] Local loop: `addFacts(base, droppedReplies(messages, compacted), agent)` when the result is shorter.
- [ ] demoApi: about 40 sample nodes with files, so the graph has clusters.
- [ ] Source-text test in `test/secondbrain.test.js`: main.ts contains `compact_boundary` and `brain:graph`; preload has `brain:`.

### Task 3: Graph overlay and menu

**Files:** Create `src/renderer/breeze/brain.ts`; modify `board.ts` (contextmenu on `.box-side-folder` → `{ label: 'Second brain', run: () => openSecondBrain(folder) }`), `src/renderer/breeze.html` (script tag), the board stylesheet.

- [ ] `openSecondBrain(folder: string): void`: overlay with Unbounded "Second brain" headline, folder name, legend chips per kind (toggle), close button + Esc, empty state "Nothing remembered yet. Memories appear here when an agent's chat is compacted."
- [ ] Canvas force sim: repulsion, spring links, gentle centering; radius `3 + 1.6·sqrt(degree)`; unlinked nodes pushed to an outer ring. Wheel zoom at cursor, background drag pans, node drag, hover card (text, kind, agent, date, Forget button) and neighbor highlight. Device-pixel-ratio aware. Reduced motion: settle 300 ticks before painting.
- [ ] Refresh on `brain.onChange` for the open folder.

### Task 4: Verify
- [ ] `npm test` → only the 3 known `previewInspect` failures.
- [ ] breeze-static: open board, right-click folder header → Second brain, check pan/zoom/hover, screenshot.
