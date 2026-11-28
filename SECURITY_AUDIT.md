# Breeze Code security audit

**Status re-check:** 2026-11-28 · Version 0.8.4 plus unreleased commits (`d4838b0`) and the uncommitted fixes for findings 4, 8 and 9 · Electron 44.9.3 · Windows 11

**Original audit:** 2026-10-29 · Version 0.5.9 · branch `vulnerabilityTESTING`

## Scope and method

The original audit read the code by hand and ran proof-of-concept scripts against the real modules. It covered Electron hardening, the preload's IPC handlers, renderer XSS (about 390 template interpolations), shell and command construction, secrets, the updater and `npm audit`.

The 2026-11-28 re-check read the current source for the findings below and ran `npm audit`. Findings 4, 8 and 9 were then fixed; `npm test` with those fixes: 1073 tests, 1064 pass, 0 fail, 9 skipped. It did **not** re-run the old proofs of concept, repeat the XSS review or run the Rust engine tests.

**Not yet audited** (added or heavily changed since 0.5.9): voice typing, Agent Board, Breeze's own MCP server and MCP client connections, the agent browser, Copilot, OpenCode and DeepSeek CLI integrations, the API agents' web tools, and the macOS and Linux builds.

## Summary

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | High | Command injection through the Antigravity `.cmd`/`.bat` shim | **Fixed** |
| 2 | High | Antigravity ignored the Full access setting | **Superseded** by finding 3 (Full access is now always on) |
| 3 | **High** | Build mode runs every agent with no permission guard | **Open** (current behaviour, set in code) |
| 4 | Medium | A repository's own git config and hooks ran code on Breeze's git actions | **Fixed**, not yet released |
| 5 | Medium | Workspace sync could write into `.git` | **Removed** with workspace sync |
| 6 | Low–Medium | GitHub sign-in asks for the full `repo` scope | **Open** |
| 7 | Low | Builds and updates aren't code-signed | **Open** |
| 8 | Low | `breeze-preview://` served `.env` and `.git` files | **Fixed**, not yet released |
| 9 | Low | Any website could embed Live Share files while it ran | **Fixed**, not yet released |
| 10 | Low | `sync:clone` path traversal | **Removed** with workspace sync |
| 11 | Info | Hardening notes | See below |

The main threat model: **any** renderer XSS becomes remote code execution, because `api.term.run` is a raw shell. The most practical attacks don't need XSS. They go through the agents and git (findings 3 and 4).

---

## 1. High (fixed): command injection through the Antigravity CLI shim (Windows)

**Was.** `.cmd`/`.bat` shims were spawned with `shell: true` and the prompt as a raw argument, so `&`, `|`, `>` or `<` in a prompt ran as `cmd.exe` syntax.

**Fix.** `AntigravityAgentService.cmdLine` builds the `cmd.exe` line itself, quotes each argument and escapes every metacharacter. Line breaks become spaces.

**Test.** "cmdLine: a .cmd shim gets every argument intact and runs nothing else" (passes in the 2026-11-28 run on Windows).

## 2. High (superseded): Antigravity and the Full access setting

The service now adds `--dangerously-skip-permissions` only when `mode === 'build'` and `fullAccess` is true. Ask, plan and commit-message runs never get it (test: "buildSpawnArgs: permissions are skipped only in build mode with Full access").

`fullAccess()` is now hard-coded to `true`, so **every Antigravity build run skips permissions**. See finding 3. Behaviour against a real `agy` is still unverified.

## 3. High: build mode runs every agent with no permission guard

**Where.** `src/main/main.ts`: `const fullAccess = () => true;`

**What build mode does today**

| Agent | Build mode |
|---|---|
| Claude Code | `--permission-mode bypassPermissions` |
| Codex | sandbox `danger-full-access` |
| OpenCode | `--auto` |
| GitHub Copilot | `--allow-all` |
| Antigravity | `--dangerously-skip-permissions` |
| DeepSeek CLI | started with full access |
| API and local models | `run_command` and web requests run without asking, and commands inherit Breeze's whole environment |

Agents may read and write outside the project, including `.env` and `.git`.

**Impact.** A prompt injection in project content (a README, an issue, a web page the agent reads) can run any command with the user's rights and read any secret the user can read. Team deny rules do not stop a shell command from changing a teammate's files.

**Ask and Plan modes** still restrict writes: Claude and Copilot get write and shell tools denied, Codex runs read-only, and API and local models ask before any command other than read-only git. How far each outside CLI enforces its own read-only mode was not tested.

**Documentation.** `README.md` now warns that Build runs with full access and doesn't ask. It previously described a **Full access** switch that doesn't exist.

**Fix.** Before release, say in the app that build mode runs without restrictions. A full fix restores an off-by-default switch, with command approval or an allowlist.

## 4. Medium (fixed, not yet released): a repository's own git config and hooks ran code on Breeze's git actions

**Was.** A folder whose `.git` came from someone else (a zip, a shared drive, a USB stick) could run programs through hooks or `.git/config` when Breeze staged, committed, fetched or pushed.

**Fix.** Breeze's git calls go through a trust gate (`src/main/gittrust.ts`). Risky local settings and hooks, including those of nested repositories, trigger a one-time "Trust this repository?" prompt. The answer is kept in app state, and changed settings or hooks ask again. Until trusted, read-only calls run with hooks, filters and diff/merge drivers switched off, and every other call is refused. Unreadable settings fail closed.

**Behaviour change.** Source Control no longer shows uncommitted changes inside a submodule's working files, and fetch, pull, push and switch don't recurse into submodules.

**Tests.** `test/gittrust.test.js` passes, including cases for nested repositories and hooks defined in config. A separate throwaway script ran both of those attacks on git 2.55: the planted program ran with plain git and did not run through the gate.

**Remaining.**
- The terminal and AI agents run git themselves and are not gated. With full access always on (finding 3), an agent can also change `.git/config`.
- A change made to `.git` between the check and the git call is not caught. Read-only calls reuse a check for up to 2 seconds.
- Global and system git settings are treated as the user's own.
- Needs git 2.26 or newer; on older versions Breeze refuses to run git.
- Not checked in the running app, on macOS or on Linux. Speed cost not measured.

## 5. Medium (removed): sync could write into `.git`

Fixed in the original audit. Workspace sync has since been removed (`sync` source no longer exists).

## 6. Low–Medium: GitHub OAuth asks for the full `repo` scope

**Where.** `src/main/main.ts`, device flow: `scope: 'read:user user:email repo'`.

**Impact.** The token can read and write every private repository the user can reach. It is now used for pull requests and for cloning and pushing private repositories, no longer for sync. It is stored with `safeStorage`.

**Fix.** Use a GitHub App with per-repository installation, or request `repo` only when a feature that needs it is first used.

## 7. Low: builds and updates aren't code-signed

**Where.** `package.json` → `build.win` has no signing settings. The repository has no `CSC_LINK` secret, so CI builds are unsigned.

**Impact.** `electron-updater` checks the installer's hash against a manifest from the same GitHub release. Anyone who controls the releases (stolen token, compromised CI) can ship a malicious update. Windows SmartScreen and macOS Gatekeeper warn on install. macOS auto-update requires a signed app, so expect it to fail on unsigned Mac builds (not tested).

**Fix.** Sign the Windows installer and set a publisher name, sign and notarise the Mac build, require 2FA and use short-lived CI tokens.

## 8. Low (fixed, not yet released): the preview protocol served `.env` and `.git`

**Fix.** `createPreviewHandler` (`src/main/previewServer.ts`) answers 404 for anything `agentBlocked` refuses, on the requested path and again on the final file. `blockedRel` now reads names the way Windows opens them (trailing dots and spaces, NTFS streams).

**Tests.** `test/previewServer.test.js` and a new case in `test/guard.test.js` pass. Not checked in the running app.

**Remaining.** Hard links to `.env`, and a link swapped between the check and the read, are not covered.

## 9. Low (fixed, not yet released): any website could embed Live Share files

**Fix.** Each session serves under a random 192-bit path, `http://127.0.0.1:2026/<token>/` (`src/main/liveserver.ts`). Root-relative URLs work through an HttpOnly, SameSite=Strict cookie, accepted only when `Sec-Fetch-Site` is `same-origin`, `none` or absent. Other requests get 404. The `Host` check and the `.env`/`.git` refusal remain.

**Tests.** `test/liveserver.test.js` passes. Cookie behaviour in a real browser is not checked.

## 10. Low (removed): `sync:clone` path traversal

Fixed in the original audit. The feature has since been removed.

## 11. Info and hardening notes

Re-checked on 2026-11-28:

- **Electron settings.** The windows whose settings were searched use `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`. `handle()` refuses IPC calls from anything but the top-level app page.
- **CSP** keeps `script-src 'self'` and `style-src 'self'`. `img-src file:` and `media-src file:` still let the page load local files as pictures or media.
- **Escaping.** `esc` still doesn't escape quotes and `escAttr` doesn't escape `'`. Escape both in both functions.
- **`versionOf`** still uses `exec` with `"${bin}" --version`; `execFile` would be cleaner.
- **Secrets.** The only `ghp_`-shaped strings found in git history are made-up values in two test files. No `GOCSPX-` secret was found. `scripts/write-config.js` bundles only client IDs and the Google desktop client secret, which Google documents as non-confidential.
- **Dependencies.** `npm audit --omit=dev`: 0 vulnerabilities. With dev dependencies: 6 moderate, all from `minimatch` under `electron-builder` (build time only).

From the original audit, not re-checked: no renderer XSS was found; navigation is locked to the app page; Discord presence with "details" on shares the file name, project name and agent task text (opt-in).

## Suggested order of work

1. Finding 3: warn in the app (the README is done); then restore a permission switch.
2. Check the fixes for findings 4, 8 and 9 in the running app.
3. Finding 7: code signing.
4. Finding 6 and the notes in 11.
5. Audit the features listed under "Not yet audited".
