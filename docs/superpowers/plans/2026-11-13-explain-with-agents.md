# Explain with Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Right-click selected code → "Explain with Agents" → a floating card next to the code shows the active agent's explanation.

**Architecture:** A pure `explaincore.ts` (prompt text, card placement) tested in Node via `vm`, like `conflictcore.ts`. A DOM file `explain.ts` adds the editor's `contextmenu` handler, the card, and the `api.agent.ask` call. Main process is unchanged: `agent:ask` is already read-only and one-shot.

**Tech Stack:** TypeScript (tsc, CJS-free renderer scripts sharing one global scope), Electron, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-13-explain-with-agents-design.md`

## Global Constraints
- Nothing goes to, or switches to, the Agents tab. Only `api.agent.ask` is called.
- Selected code is cut at 12,000 characters; context is up to 20 lines before and after.
- Menu label exactly `Explain with Agents`; disabled when the selection is empty.
- Agent = `currentActiveAgent()`, model = `chosenModelFor(agent)`; no agent → `openAgentPicker()`.

## Review Focus
- Selection over 12,000 chars → prompt carries the first 12,000 and says it was cut (test in Task 1).
- Right-click near the bottom/right screen edge → card stays on screen, flips above (test in Task 1).
- Reply arrives after the card was closed or a newer explain started → dropped (request id check, Task 2).
- Agent errors / no agent installed → card shows the error with Retry; no agent → picker opens (Task 2).
- Selection in a CRLF file or with multiple cursors → uses the primary selection's text as shown (Task 2).

---

### Task 1: Pure core — prompt and placement

**Files:**
- Create: `src/renderer/breeze/explaincore.ts`
- Modify: `tsconfig.json` (add to `files`, after `conflictcore.ts`)
- Test: `test/explaincore.test.js`

**Interfaces:**
- Produces: `explainPrompt(o: { path: string; lang: string; first: number; last: number; code: string; before: string; after: string }): string` — `first`/`last` are 1-based line numbers.
- Produces: `explainContext(text: string, start: number, end: number, lines = 20): { before: string; after: string; first: number; last: number }`
- Produces: `placeCard(x: number, y: number, w: number, h: number, vw: number, vh: number): { left: number; top: number }` — 8px margin; below the point (y + 12) unless it would overflow, then above (y - h - 12); clamped inside.
- Produces: `EXPLAIN_MAX = 12000`

- [ ] Step 1: tests — prompt includes path, `lines 3-5`, the code in a fence, the context; code > 12000 chars is cut to 12000 and the prompt says `(cut)`; `explainContext` returns at most 20 lines each side and correct 1-based `first`/`last`; selection ending on a line break doesn't count the next line; `placeCard` below, flipped above near bottom, clamped at right edge.
- [ ] Step 2: run `node --test test/explaincore.test.js` → FAIL (file missing).
- [ ] Step 3: implement.
- [ ] Step 4: run → PASS.

### Task 2: Menu, card, agent call

**Files:**
- Create: `src/renderer/breeze/explain.ts`
- Modify: `tsconfig.json`, `src/renderer/breeze.html` (script tag after `conflicts.js`), `src/renderer/breeze.css` (`.explain-card` after `.lsp-hover`)

**Interfaces:**
- Consumes: Task 1 functions; `activeText()`, `popupMenu`, `currentActiveAgent`, `chosenModelFor`, `openAgentPicker`, `md`, `esc`, `toast`, `api.agent.ask`, `languageName`-equivalent from languages.ts (or the file extension).
- Produces: `explainSelection(x: number, y: number): void`, `closeExplain(): void`.

- [ ] Step 1: `contextmenu` on `#editor .code` → `popupMenu` with `Explain with Agents` (enabled when `ta.selectionStart !== ta.selectionEnd`).
- [ ] Step 2: card DOM: header (agent name, `Explain · lines a–b`, Copy, ✕), body (loading → `md(reply)` → error + Retry). Close on Esc, ✕, outside mousedown, active file change. Stale replies dropped via an incrementing id.
- [ ] Step 3: `npm test` → all pass (tsc compiles, existing tests green).
- [ ] Step 4: run the app, select code, right-click, check the card and that the Agents tab got nothing.
