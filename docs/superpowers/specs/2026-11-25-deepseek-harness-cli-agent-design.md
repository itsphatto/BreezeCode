# DeepSeek Harness (dsh) as a CLI agent — design

Date: 2026-11-25. Status: **waiting for approval.** Written from dsh's docs and source (0.2.2-rc.5); dsh has not been
installed or run. It is a developer preview that promises breaking changes and says it has had no security audit.

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
- **Ask and Plan:** dsh ships no read-only preset. Breeze adds one with a `--patch` overlay (`sandbox: read-only`). If
  that can't be confirmed, Ask and Plan are not offered for dsh: an instruction in the prompt is not a guarantee.
- **Events:** session -> session, text -> text, thinking -> "Thought" note, tool_call / tool_result -> tool and file
  lines, status.usage -> tokens, final -> done (or the error in `reason`). Unknown types are ignored.
- **Teams and Agent board:** left out at first. dsh has no per-file deny rules like Claude's and OpenCode's.
- **Commit messages, model choice:** left out at first; dsh uses its own default model.
- **Warning:** the card reads "Developer preview · may break between versions".

## To confirm with dsh installed, before building
1. The read-only overlay really blocks writes on Windows.
2. The names and inputs of its file tools (for the file list).
3. That stopping Breeze's run stops the whole process tree.
4. That the process exits by itself after `final`.
