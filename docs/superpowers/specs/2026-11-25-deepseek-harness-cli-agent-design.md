# DeepSeek Harness (dsh) as a CLI agent — design

Date: 2026-11-25. Status: **approved**, then checked against dsh 0.2.2-rc.5 on Windows with a stand-in model server (no
live key). dsh is a developer preview that promises breaking changes and says it has had no security audit.

## Intent
Let people who use DeepSeek's own coding harness pick it in Breeze like Codex or OpenCode.

## Approaches
1. **`dsh --profile headless --json` per message (recommended).** One process per run that prints one JSON event per line
   and takes `--session-id` to continue: the shape of the OpenCode agent, so it reuses `streamCli`.
2. **`dsh --profile acp`.** A long-lived JSON-RPC connection. The only one that can show dsh's permission questions in
   Breeze, but needs a new client and process lifecycle. Worth it later, if approvals are wanted.
3. **Final answer only (`headless` without `--json`).** Little work, no progress or file list.

## Design (approach 1)
- **Agent** `dsh`, "DeepSeek Harness", @mention `@dsh`. Found as `dsh` on PATH or in npm's global folder. Get it:
  `npm install -g @deepseek-ai/dsh` (needs Node 24.9+).
- **Run:** `dsh --profile headless --json --approval-policy never --permission-mode <preset> [--session-id <id>] -`,
  prompt on stdin, the project as working directory.
- **Key:** the DeepSeek key saved in Breeze, if any, as `DEEPSEEK_API_KEY` in that process's environment only. A key the
  user has set themselves wins.
- **Permissions:** Build uses `workspace-write`; Breeze's Full Access uses `danger-full-access`. Headless cannot ask, so
  in Build anything outside the sandbox is refused, and the refusal is shown.
- **Ask and Plan** use dsh's own `read-only` preset (its base profile ships one, so no overlay is needed).
- **Events:** session -> session, text -> text, thinking -> "Thought" note, tool_call / tool_result -> tool and file
  lines, status.usage -> tokens, final -> done (or the error in `reason`). Unknown types are ignored.
- **Teams and Agent board:** left out at first. dsh has no per-file deny rules like Claude's and OpenCode's.
- **Commit messages and other one-shot questions:** left out. With dsh picked, they go to the DeepSeek API agent when its
  key is saved, and otherwise say so. Never to another company's agent.
- **Model choice:** left out; dsh uses its own default.
- **Warning:** the card reads "Developer preview · may break between versions".

## Checked with dsh installed

- `read-only` blocked edit, write, PowerShell, cmd, node and delete, and every request for wider access.
- `workspace-write` allows the project and the temp folder only.
- Session ids resume; an unknown one fails with `session "…" does not exist` (Breeze then starts a new chat).
- `taskkill /T /F` stops the whole tree. The process exits by itself after `final`.
- A project `.env` that sets `DEEPSEEK_BASE_URL` makes dsh refuse to start. Breeze also sets the address itself whenever it
  passes its saved key.
- dsh uploads each session's log to DeepSeek by default. Breeze's runs turn that off with a `--patch` overlay, and set
  `DSH_TELEMETRY_DISABLED`.
- npm's `.cmd` shim can't carry the overlay's path when the user name has a space, so on Windows Breeze runs dsh's
  `lib/bin.js` with node directly.
- Starting takes about 23 seconds on the test machine, so a run says it is starting.
- npm held back five packages' install scripts; everything above worked without them.
