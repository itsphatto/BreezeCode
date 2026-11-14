# Agent board — design

Date: 2026-11-14 · Revision 1 · Status: draft, waiting for approval

## Goal

A new activity-bar button opens the **Agent board**, a full page where the person runs several agents side by
side. The board starts empty, with the installed agents on a roster. The person drags an agent into a box, gives it
a prompt, and every box runs at the same time, like split view. There are 4 boxes in a 2×2 grid, and scrolling down
shows more.

Agents on the board never overwrite each other's files. When one needs a change in a file another box owns, Breeze
**relays** the request: the owner's box gets a message, the owner makes the change, and the answer goes back to the
box that asked.

## Non-goals

- Replacing the `@mention` team flow in the chat (`teams.ts`). It stays as it is.
- Git worktrees, branches or merging. Every box works in the open folder.
- A lead agent that splits one big task across the boxes. Each box gets its own prompt from the person.
- Breeze Box (`box` surface). The board is IDE-only.

## Anti-goals (failure even if it works)

- Two boxes write the same file and one silently loses its work.
- Agents relay back and forth forever and burn tokens with nobody watching.
- A busy board makes the IDE slow, or leaves agents running after the person thinks they stopped them.

## Approaches considered

| Approach | Trade-off | Picked |
|---|---|---|
| **Relay**: block the edit, send the request to the owner's box, the owner does it and answers | Nobody overwrites anyone, and both sides of the talk are visible. Costs an extra run on the owner's side. | **Yes**, the person chose it |
| Hand over: the owner gives up the file and the asker edits it | Simpler, but the owner may be mid-edit on that file | No |
| Ask the person: both boxes pause until the person picks | Safest, but nothing runs while it waits | No |

Placement (my call): a full page in the main window, opened like Debug (`swapScreen`), not a separate OS window. A
second window would need its own copy of the whole chat renderer (`agents.ts`, `teams.ts`, markdown, tool cards).

## User-facing behaviour

### Opening it

- A new activity-bar button sits under Debug (`#boardBtn`, icon: a 2×2 grid). Its title is "Agent board
  (Ctrl+Shift+B)". It is copied into the Debug page's rail like the other buttons.
- The page has the activity bar on the left, a title bar with **Back** (to the editor) and **Stop all**, the roster
  strip, and the grid. Leaving the page keeps every box running, and the status bar shows "Agent board — 2 working ·
  Open" to come back.

### Roster

- A strip across the top with one chip per installed agent (`appState.detect`): logo (`BRAND_ICONS`) and short name.
  The chips can be dragged.
- With no agents found, the strip shows the existing "Choose an agent" button (`openAgentPicker()`).
- The same agent can sit in more than one box. Each box has its own session.

### Boxes

- The grid has 2 columns. Each row is half the page height, so 4 boxes fill the screen. Below the last row there is
  always one more empty row, so scrolling down always shows room for more. The board holds up to 8 boxes.
- An **empty box** shows a dashed outline and "Drop an agent here". Dropping a chip fills it. Keyboard: Tab to a box,
  Enter opens a menu of agents.
- A **filled box** has:
  - a header with the agent's logo, its name with the box number ("Claude · 1"), the model/effort chevron (the same
    menu as the agent bar), a status dot (idle, working, waiting on a teammate, done, failed), an "owns N files"
    link that lists the files, and ✕ to empty the box (it stops the run first).
  - a chat, the same rendering as the IDE chat (messages, tool lines, cards).
  - a prompt with Send/Stop, like the IDE composer, without attachments or the mode select. Every box runs in
    build mode.
- Dropping a chip on a filled, idle box swaps in that agent and starts a new chat. A working box refuses the drop and
  shakes.
- A double-click on a box header makes it fill the page. Esc or a second double-click puts it back.
- The layout (which agent is in which box, and each box's chat) is saved per folder, like IDE chats.

### Ownership

- The board has one ownership map for the open folder, shared by every box.
- A file belongs to the first box that edits it (first-touch, `claimFirstTouch`). There is no claim pass up front,
  because boxes start at different times.
- Ownership lasts until the board is cleared, the folder changes, or the person releases a file from the "owns N
  files" list.
- Before a box's run starts, Breeze tells it which files its teammates own ("Do not edit: …") and that it should ask
  for changes it needs in them.

### Relay (agents talking)

1. Box 1 (Claude) edits `api.ts`, which box 2 (Codex) owns.
   - Claude Code and the Local LLM are stopped before the write lands (the deny list and `checkTeamWrite`, as in
     teams today).
   - Codex and Antigravity write first. Breeze keeps a copy of the attempted content, puts the file back, and
     re-checks 300 ms later, as `TeamCoordinator.#onFile` does today.
2. Box 1 shows a crossing card: "Claude tried to edit `api.ts` (Codex · 2). Breeze put it back and asked Codex."
3. Breeze builds a **relay message** from what box 1 tried to do: the diff of the attempted content against the
   owner's version (when Breeze has it), plus box 1's "For Codex:" notes from its final message (`notesFor`).
4. Box 2 shows the message as an incoming card, labelled with box 1's logo: "From Claude · 1". When box 2 is idle,
   Breeze starts a follow-up run on box 2's session with that message. When box 2 is working, the message waits
   in a queue and starts when box 2's run ends.
5. When box 2's relay run finishes, its final message goes back to box 1 as a "Reply from Codex · 2" card. When box 1
   is idle, Breeze starts a follow-up run on box 1's session ("Codex made the change: … Continue your task."). Box 1's
   status shows "waiting on Codex" in the meantime.
6. Box 1's final message can also carry a "For <name>:" note without trying an edit. That note is relayed the same
   way.

### Loop guard

- Each pair of boxes gets at most 3 relays in a row with no message from the person. After that, the relay card shows
  "Paused. Send it?" with **Send** and **Drop**, and nothing more runs on its own.
- A toggle in the title bar, **Auto-relay**, is on by default. When it is off, every relay waits for **Send**.
- **Stop all** stops every box and drops every waiting relay.

## Components

### 1. `src/main/board.ts` (no Electron imports, side effects through `deps`, like `team.ts`)

`BoardCoordinator` gives main.ts the same surface that `TeamCoordinator` does, so the existing run hooks work
unchanged:

- `id`, `owners`, `members` (one per box: `{ agentId: boxKey, agent, name }`, where `boxKey` is `box1`…`box8` and
  `name` is "Claude · 1").
- `foreignOwner(boxKey, rel)` and `observe(runId, ev)`, with the same meaning as on `TeamCoordinator`.
- `startBox(boxKey, { agent, prompt, session })` builds the brief (the task, the teammates, "Do not edit: …", and how
  to ask for a change) and starts a build run with `team: { coordinator: this, agentId: boxKey }`.
- On a crossing, it reads the attempted content before restoring it, makes a unified diff (capped at 200 lines), and
  emits `{ t: 'relay', from, to, path, diff }`.
- On a box's `done`, it reads `notesFor` and emits `{ t: 'relay', from, to, note }` for each note.
- `relay` events go to the renderer, which owns the queue and the loop guard, so the person sees and controls every
  hop.
- Reuses `cleanRel`, `ownerOf`, `claimFirstTouch`, `claudeDenyArgs`, `notesFor`, `snapshot`, `addToSnapshot` and
  `restore` from `team.ts`, which are exported already.
- The snapshot grows file by file as boxes first touch files (`addToSnapshot`). It is not taken all at once.

### 2. main.ts wiring

- `board:open()` creates or returns the board for the open folder. `board:run({ boxKey, agent, prompt, session })`
  calls `startBox` and returns the run id. `board:stop(boxKey)`, `board:stopAll()`, `board:release({ path })`,
  `board:owners()`.
- `launchRun` already accepts `opts.team.coordinator`, and the board's runs go through the same `teamOf` map.
- The Claude Code deny list is built when the run starts. A file a teammate claims after that is caught by the
  restore path instead.
- A folder change stops the board, as it does for teams.
- `preload.ts` exposes `api.board.{ open, run, stop, stopAll, release, owners }`.

### 3. Renderer: `src/renderer/breeze/board.ts`, `breeze.html`, `breeze.css`

- The `#board` screen, the button, the rail copy, and the status-bar entry.
- Each filled box is an `AgentTabState` on a new surface `board`, so `addMsg`, `handleAgentEvent`, tool lines and
  cards render as they do in the IDE. Each box gets its own chat element and prompt.
- Drag and drop uses HTML5 drag events on the roster chips and the boxes.
- The relay queue lives here: a waiting list per box, the per-pair counter (reset by any message the person sends to
  either box), and the Auto-relay toggle.
- Handlers for `crossing` (existing card, board wording) and `relay` (incoming and reply cards).

## Errors

- One box fails: the others keep going. Its dot turns red and any relay waiting for it shows "Codex · 2 failed.
  Send again?"
- A restore fails (the file is locked): a crossing card with the reason and **Undo** to retry, as in teams.
- The relay target box was emptied: the relay card says "Box 2 is empty" and offers **Drop**.
- The person edits an owned file in the editor: that is not a crossing. Only agent edits are checked.

## Testing

- `test/board.test.js` (node:test, with fake `deps` like `team.test.js`): first-touch ownership across boxes, the
  same agent in two boxes kept apart, crossing → restore + `relay` event with a diff, a "For X:" note → `relay`,
  `release` frees a file, `stopAll`.
- A source-text test that the button, the screen, and `api.board` are wired.
- A manual check in the running app over CDP: drag two agents in, give both prompts that touch the same file, see
  the relay go out and the reply come back, and check that Stop all stops both.

## Left to the builder

- Exact visuals: the drag ghost, the drop highlight, the card styling. Follow the current chat cards and the
  activity-bar icon set.
- The status-bar wording and the keyboard shortcut, if Ctrl+Shift+B is taken.
