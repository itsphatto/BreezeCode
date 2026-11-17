# Breeze Agent: Full Build Plan

Status: **built, then merged into Breeze Space. Device Control (section 11) was not built.**

> **Update: merged into Breeze Space.** There is no separate Breeze Agent workspace any more: no unlock code, no 3rd Workspace button, no Agent screen. Sections 2 to 5 below describe the original design; this is what replaced them:
> - **Every message in Breeze Space is read** by `src/main/agentintent.ts`. Rules only: no AI call, so no added time or cost. A question stays a normal chat reply. A message with several jobs, a list of steps, a big job, a chore on a connected service (email, Discord, Slack…), a schedule ("every morning") or a trigger ("when tests fail") becomes an agentic task. Starting a message with `/task` forces a task; `/chat` forces a normal reply.
> - **The task runs in the chat it came from, using Space's own pieces:** the plan-approval card, step notes ("Step 2 of 4 · …"), each step streaming like a normal reply, the question card when it's stuck, and Stop to cancel the task. A schedule that fires after a restart opens its own chat in the side bar.
> - **Only Claude Code and Codex can run tasks,** because only they reach Breeze's MCP tools. On Antigravity, OpenCode or the local model, Space switches to the first of Claude Code or Codex that's installed and says so in the chat. If neither is installed, the message goes through as a normal chat.
> - **The agent pill's menu** holds the Control level, "Next task runs" (overrides the schedule or trigger read from the message), and the task list (open its chat, run now, pause, cancel, remove, stop all).
> - **The tray** shows only while a task is running, queued, waiting for you, or has a schedule or trigger waiting, and the "Keep running in tray" setting is on. Someone who never starts a task never sees it: closing still quits.
> - **Emails, Discord and other services** work through MCP servers you connect in Breeze. Breeze doesn't include its own Gmail or Discord clients. Deleting Discord messages needs a bot in a server you manage; automating a personal Discord account breaks Discord's rules.

**What changed from the plan while building:**
- **Device Control was not built.** Its tool layer couldn't be completed in this build. The `breeze-hands` sidecar (`hands/`, `src/main/hands.ts`) and the block list and control rules (`src/main/deviceguard.ts`, with tests) are in the repo but nothing calls them. The composer has no Device Control toggle, and every task is created with `device: false`.
- **Triggers wired:** "file saved" (open project only, from the folder watcher) and "tests failed" (from any run's test output). "Git commit" and "PR comment" are in the brain and its tests, but nothing fires them yet, so the UI doesn't offer them.
- **Kill switch:** `Ctrl+Alt+Esc` while Breeze has focus, the **Stop all** button, and the tray's **Stop all tasks**. It is not a system-wide hotkey.
- **Vision check:** not needed without screen tools.

---

## 1. What it is

Breeze Agent is a hidden 3rd workspace, next to Breeze Code and Breeze Space.

- **Personality:** a mix of the Dot and Grok styles. It remembers you and your projects (the Dot side) and shows a small animated orb (a light Grok-style touch; there is no full character and no voice).
- **Job:** automation. It runs multi-step tasks, scheduled tasks, triggered tasks and a background queue, across all your Breeze projects, and it can control the whole device.
- **Brain:** a new **orchestrator**. It does not add a new model. It plans, splits a goal into steps, sends each step to an agent Breeze already runs (Antigravity, Claude, Codex, local/Ollama) through the existing `startRun` (`src/main/main.ts:3010`), checks the result, and retries.

---

## 2. Unlock + workspace switch

| What | Where |
|---|---|
| Code `agentic` typed in the existing Misc → **Enter code** box unlocks it | `settings.ts:1426` (`tryCode`), next to `DEV_CODE` |
| New state `agentUnlocked: boolean` (default `false`) | `onboarding.ts:6` (`AppState`) |
| On unlock: toast "Breeze Agent unlocked", jump to General | `settings.ts` |
| "Lock again" switch in Misc, the same way `sDevOff` works | `settings.ts:1442` |
| The existing General → **Workspace** seg gets a 3rd option, **Breeze Agent**, shown only when unlocked. No new switch. | `settings.ts:835`, handler at `:1312` |
| Animation: the existing `.seg` slide and the existing `swapScreen` transition. No new CSS for this part. | `breeze.css:1628`, `setup.ts:1426` |

**Note:** `agentic` is an easter egg, not access control.

---

## 3. New mode + screen

- Change `type WorkMode` to `'ide' | 'box' | 'agent'` (`onboarding.ts:2`).
- Add `'#agent'` to `swapScreen`'s screen list (`setup.ts:1429`).
- Add an `agent` branch to `enterMode` (`views.ts:82`), copied from the `box` branch.
- Restore on launch (`init.ts:8, 53, 90`). If the mode was `agent` but it's locked now, fall back to `ide`.
- Agent surface, tabs and attachments (`agents.ts:76, 82, 169`).
- Terminal placement (`layout.ts:28`).
- Discord and friends presence read "Breeze Agent" (`discord.ts`, `friends.ts`).
- New `#agent` screen in `breeze.html`, after `#box` (line 717). Copy the `#box` markup and reuse the `.box-*` CSS; only add what differs.
- **Orb:** idle = slow breathing, working = faster (the same idle/busy idea as `space.ts`). Look for reusable keyframes in `breeze.css` first; it gets a warning color while Device Control is on.
- **Icon:** `assets/brand/BreezeAgent.png`, **supplied by the user**. A placeholder until then.

---

## 4. Brain: `src/main/agentcore.ts` (no Electron in it, so it's testable)

```ts
Task {
  id, goal, project, agent,
  control: 'ask' | 'plan' | 'auto' | 'full',
  device: boolean,
  steps: Step[], status, log,
  schedule?, trigger?
}
```

**Loop**
1. **Plan:** the agent returns its steps as JSON. If that fails to parse, fall back to reading a numbered list.
2. **Run step:** `startRun` with that task's project as cwd.
3. **Check:** did the step meet its goal? Read the reply and the changed files.
4. Next step, **or** retry (at most 2), **or** stop and ask the user.

- Task state is saved to userData after every step, so tasks resume after a crash or restart.
- Run events are routed like `TeamCoordinator.observe` (`main.ts:2214`, `teamOf`). Task runs go to their own `task:event` channel, not `agent:event`, so the renderer's early-event buffer doesn't fill up.
- Questions and approvals reuse the existing `askUser` / `QuestionDesk` cards (`main.ts:3281`).

**New MCP tools** (`breezemcp.ts`; the server needs a per-run tool list, because today the list is fixed):
`task_update`, `task_note`, `git_status`, `remember`, `recall`, `forget`.
Claude already allows the whole `mcp__breeze` server (`main.ts:2856`), so no new permission flags are needed.

---

## 5. Control level dropdown (one merged dropdown)

A `select.select` in the composer, using the existing `dropdowns.ts`. **Autonomy and safety are merged into this one dropdown.**

| Level | Asks you | Device control in schedules/triggers | Kill switch |
|---|---|---|---|
| **Ask** | every risky step | no | always on |
| **Approve plan** | once, before running | no | always on |
| **Auto** | never | yes | red banner + `Ctrl+Alt+Esc` |
| **Full auto** | never | yes | hotkey only |

- Saved per task, so a scheduled task keeps the level it was created with.
- **Full auto** maps to the existing `agentFullAccess` (`main.ts:1888`) and shows the same red warning.
- `guard.ts` decides what counts as "risky". The agent's own label for a step is never trusted.

---

## 6. Queue

- At most **1 task per project** and **2 in total** at once.
- Keeps running while you're in Code or Space.
- Desktop notification when a task finishes or gets stuck (the existing notification setup, `main.ts:517`).
- Sidebar panel in the Agent screen: pause, cancel, reorder.

---

## 7. Schedules

- Daily at a set time, or every N hours.
- Run in **tray mode** (section 10). Runs missed because the app was really quit fire once on the next launch.

---

## 8. Triggers

- File saved, git commit, tests failed, PR comment (`github.ts`).
- Debounced, with a **cap of 10 runs an hour** so a trigger can't set itself off forever (for example, a task that saves a file that fires the save trigger).

---

## 9. Scope + memory

**All Breeze projects**
- Each task is tied to one project from the recent list. It can't hop to another project unless you allow it.
- `pathguard` keeps every step inside its task's project root.

**Memory:** `src/main/agentmemory.ts`
- A local JSON file in userData.
- **Per project + global.** Facts from one project never go into another project's prompts.
- Never stores file contents or secrets; anything that looks like a key is rejected.
- Size caps; the most useful memories go into the prompt within the token budget (`agentbrain.ts`).
- Settings has "View / clear memory".

---

## 10. Tray mode

- Closing the window hides Breeze to the tray instead of quitting (`main.ts`, Electron `Tray`).
- Tray menu: Open Breeze, running tasks (Pause / Cancel), Quit.
- Schedules and triggers keep running while the window is hidden.
- Settings → General has a **"Keep running in tray"** switch. It's **on by default once Breeze Agent is unlocked**, so Breeze Code users who never unlock see no change.
- The first time you close the window, a toast explains that Breeze is still running in the tray.
- While hidden, the page stops drawing: the orb and the Space canvas pause, through `power.ts`.
- Optional **Start with Windows** switch, off by default.
- Cost: it holds RAM in the background all day.

---

## 11. Device Control

**Toggle:** a liquid glass toggle in the **Agent composer**, next to the Control level dropdown. It reuses `switchHtml` and `liquidSwitch` (`settings.ts:38`, CSS at `breeze.css:14589`); nothing new is built for it. It glows while on.

**Reach** (new MCP tools):

| Area | Tools |
|---|---|
| Files anywhere | `fs_read`, `fs_write`, `fs_move`, `fs_delete`, `fs_list` |
| Apps + commands | `app_launch`, `shell_run` (system-wide), `process_list`, `process_kill` |
| Screen + mouse/keyboard | `screen_capture` (Electron `desktopCapturer`), `mouse_move`, `mouse_click`, `key_type`, `key_press` |
| System | volume, Wi-Fi, clipboard, notifications, window layout (PowerShell on Windows; the app ships Windows-only, so other platforms get stubs) |

**Only show what's available:** Breeze checks the selected agent. If it can't see images, the screen, mouse and keyboard tools aren't offered at all; the other device tools still work. It checks again whenever you switch agents.

**Audit log:** every device action is written to a log file you can open from Settings.

### 11a. Fixed block list (no setting turns it off)

**Why:** the agent reads files, web pages, PR comments and screenshots. Any of them can hide instructions (prompt injection), and no model reliably resists that. With Full auto, device control and triggers on, a stranger's PR comment could set it off while you're away. The block list is enforced in code (`pathguard.ts` / `guard.ts`), not in the prompt, so a fooled AI still can't get past it.

- **Never touched:** `C:\Windows`, Program Files, `~/.ssh`, `.gnupg`, Windows Credential Manager, browser password and cookie files (Chrome, Edge and Firefox profiles), crypto wallets, `.env` files outside projects.
- **Breeze's own settings and the block list file:** without this, the agent could edit them and switch its own limits off.
- **The keyboard tool never types into password fields.** Checked through Windows UI Automation `IsPassword` on the focused element, plus blocking text that looks like a secret.
- **Always asks, even in Full auto:** sending money, deleting more than 50 files at once, formatting drives, changing user accounts.
- **Manual exception:** "Allow this one path" in Settings. Only the user can click it; the AI can't.

### 11b. `breeze-hands` Rust sidecar (instead of nut.js)

**Problem with nut.js:** native C++ built against one exact Electron version. Electron is `^44` and updates on its own, and any update can break nut.js and crash the app when it loads. It would need `electron-rebuild` on every build, and its prebuilt binaries often lag new Electron versions.

**Fix:** a second Rust sidecar, the same pattern as the existing `engine/` (built by `scripts/build-engine.js`, spoken to over stdio by `engine.ts`).
- New crate `hands/`: `enigo` (mouse and keyboard), plus Windows APIs for volume, Wi-Fi and windows.
- It's a separate exe outside Electron, so **Electron updates can't break it**.
- `npm run build:engine` builds both sidecars; `predist` is unchanged.
- If it crashes, only device control stops; Breeze keeps running.
- **The kill switch kills this one process**, which stops all input instantly.
- Rust is already required for the engine, so this adds no new requirement.

---

## 12. Files touched (summary)

**New**
- `src/main/agentcore.ts`: tasks, loop, queue, schedules, triggers
- `src/main/agentmemory.ts`: memory store
- `src/main/deviceguard.ts`: block list, risky-step check, control-level rules
- `src/main/device.ts`: device tools (clipboard, notifications, screen capture, PowerShell)
- `src/main/hands.ts`: client for the `breeze-hands` sidecar
- `src/renderer/breeze/agentmode.ts`: Agent screen, queue panel, composer, task cards
- `hands/` (Rust crate)
- `test/agentcore.test.js`, `test/agentmemory.test.js`, `test/deviceguard.test.js`

**Changed**
- `src/main/main.ts`: startRun cwd, task event routing, IPC, tray, kill-switch hotkey
- `src/main/breezemcp.ts`: per-run tool list
- `src/main/preload.ts`, `src/renderer/breeze/core.ts`, `src/renderer/breeze/platform.ts`: the new `task` / `device` API (and its browser stub)
- `src/renderer/breeze/settings.ts`, `onboarding.ts`, `setup.ts`, `views.ts`, `init.ts`, `agents.ts`, `layout.ts`, `discord.ts`, `friends.ts`
- `src/renderer/breeze.html`, `src/renderer/breeze.css`
- `scripts/build-engine.js`, `tsconfig.json` (adds the new renderer file)

---

## 13. Tests

- Unlock code; the locked-mode fallback on launch
- Plan parsing (JSON + numbered-list fallback)
- Retry limit; resume after restart
- Queue limits (1 per project, 2 in total)
- Schedule next-run math; missed-run catch-up
- Trigger debounce and the 10-per-hour cap
- Control level rules (device control blocked unattended at Ask and Approve plan)
- Block list paths; Breeze's own settings protected; manual allow
- Memory: save / recall / forget, size cap, project isolation, secret rejection
- `npm test` + `cargo build` for `hands/`

---

## 14. Risks

1. **Prompt injection + device control** is the biggest risk. The block list (11a) and the always-ask actions are the floor.
2. **Shipping it all as one build:** a bug can sit in any of 6 systems, so every part needs its tests before it's called done.
3. **Screen control quality** depends on the agent. Claude can see images; Codex and small local models are weak or blind, so those get no screen tools.
4. **Tray mode** uses background RAM, and people may think closing the window is broken (the toast covers it).
5. **Memory leaks** project info into prompts if isolation fails. It needs strict tests.
6. **No Grok-style voice or full character.** The orb only.

---

## 15. Open items

- Brand icon `assets/brand/BreezeAgent.png`: the user supplies it.
- `run_tests` tool: dropped. Agents can already run tests through their shell, so `git_status` is the only new repo tool.
