# Pull Requests in a full-page Source Control — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Source Control becomes a full page that lists the open GitHub PRs into the current branch, shows their commits and red/green diffs, merges them on GitHub, and resolves conflicts on a three-pane compare page with an optional AI Conflict Duel.

**Architecture:** GitHub REST calls live in a pure, testable `src/main/github.js`; PR conflict work runs in a throwaway git worktree via `src/main/prconflict.js`. Both are exposed to the renderer over IPC (`api.gh.*`, `api.git.prConflict*`). The renderer gets two DOM-free logic files (`scmcore.ts`, `conflictcore.ts`, unit-tested through `vm` like `editcore.ts`) and two UI files (`prs.ts`, `conflicts.ts`); the existing `git.ts` panel moves into the page's left column.

**Tech Stack:** Electron 44 main process (CommonJS JS), renderer TypeScript compiled by `tsc` into classic global scripts, `node:test` for tests, GitHub REST API v2022-11-28, git CLI.

**Spec:** `docs/superpowers/specs/2026-11-04-pull-requests-source-control-design.md`

## Global Constraints

- github.com only; repo comes from the `origin` remote. Other hosts → `{ error: 'not-github' }`; no origin → `{ error: 'no-remote' }`.
- Token: active account if provider is GitHub, else first saved GitHub account; read with `getSecret('token:' + accountId(a))`. None → `{ error: 'signed-out' }`; HTTP 401 → `{ error: 'reauth' }`.
- GitHub headers exactly as `sync.js`: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `User-Agent: Breeze-IDE`, `X-GitHub-Api-Version: 2022-11-28`.
- PR list: `GET /repos/{o}/{r}/pulls?state=open&base={branch}&per_page=50`; cached per `owner/repo/base` for 30 s.
- Commits up to 250; files paged (`per_page=100`) up to 3000; files over 400 diff lines start collapsed.
- Merge: `PUT /repos/{o}/{r}/pulls/{n}/merge` with `merge_method` (`merge` | `squash` | `rebase`) and `sha` = the head sha the user reviewed.
- Conflict worktrees live in `<userData>/pr-worktrees/<repoHash>-{n}`; the PR ref is `refs/breeze/pr-{n}`. The user's own working tree is never touched.
- Resolution commit message: `Merge {base} into {head} (resolved in Breeze)`; push with `git push origin HEAD:{headRef}`.
- Duel: user's current agent, three one-shot runs (Ours advocate, Theirs advocate, Judge), read-only, on one conflict block with 40 lines of context. Nothing is committed by the Duel.
- Every new renderer `.ts` file is added to `tsconfig.json` `files` and to `breeze.html` as `<script src="breeze/<name>.js" defer>` (core files before `git.js`, UI files after `git.js`, all before `views.js`).
- The browser demo (`platform.ts`) must keep working: every new `api` method gets a demo stub.
- All user-visible copy is sentence case, no trailing periods on buttons.

## Review Focus

1. **Stale responses after a branch switch** — the user switches from `main` to `dev` while `main`'s PR list or a PR detail is still loading; the late `main` answer must not overwrite the `dev` view. (Task 5: request-generation guard + test.)
2. **Modify/delete conflicts** — one side deleted the file, the other changed it; git has no stage 2 or stage 3 entry. Expected: that pane shows "Deleted in this branch" and the choices are *Keep file* / *Delete file*, not a crash. (Task 7 test, Task 8 UI.)
3. **Fork PR whose head repo was deleted** — GitHub returns `head.repo: null`. Expected: the row shows `unknown:branch`, the detail loads, and *Resolve conflicts* is disabled with "The source repository no longer exists". (Task 1 test, Task 5.)
4. **Detached HEAD / no branch** — `git status` gives no branch (mid-rebase or a checked-out commit). Expected: the PR section says "Not on a branch" and makes no API call. (Task 5 test via `prListState`.)
5. **CRLF files with conflict markers** — Windows checkouts write `<<<<<<< HEAD\r\n`. Expected: conflicts parse, choices apply, and the written result keeps CRLF. (Task 7 + `conflictcore` test.)

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/main/github.js` | create | `parseGithubRemote`, `githubClient({ token, fetch })` with `listPulls`, `getPull`, `pullCommits`, `pullFiles`, `getCommit`, `getRepo`, `mergePull`; `GithubError` with `code`. |
| `src/main/prconflict.js` | create | `startConflict`, `finishConflict`, `abortConflict`, `pruneConflicts`, taking an injected `run(cwd, args, input?)` git runner. |
| `src/main/main.js` | modify | `githubFor()` token lookup, `gh:*` IPC, `git:prConflict*` IPC, `agent:ask` IPC, prune on start. |
| `src/main/preload.js` | modify | `api.gh.*`, `api.git.prConflictStart/Finish/Abort`, `api.agent.ask`. |
| `src/renderer/breeze/core.ts` | modify | Types `GhPull`, `GhCommit`, `GhFile`, `GhResult<T>`, `ConflictSession`, `ConflictFile`; `BreezeApi` additions. |
| `src/renderer/breeze/scmcore.ts` | create | DOM-free: `parsePatch`, `prStatus`, `prListState`. |
| `src/renderer/breeze/conflictcore.ts` | create | DOM-free: `parseConflicts`, `applyChoice`, `hasMarkers`, `duelPrompts`, `extractCodeBlock`. |
| `src/renderer/breeze/prs.ts` | create | Full-page shell, PR list section, PR detail tabs, merge menu. |
| `src/renderer/breeze/conflicts.ts` | create | Compare page and Duel UI. |
| `src/renderer/breeze/git.ts` | modify | Render into the page's left column; `showDiff` renders inline when the page is open. |
| `src/renderer/breeze/views.ts` | modify | Enter/leave full-page mode on `git` view. |
| `src/renderer/breeze.html`, `breeze.css` | modify | `#scmPage` markup and styles. |
| `src/renderer/breeze/platform.ts` | modify | Demo PRs (one ready, one conflicting), demo conflict session, demo `agent.ask`. |
| `tsconfig.json` | modify | Add the four new renderer files. |
| `test/github.test.js`, `test/prconflict.test.js`, `test/scmcore.test.js`, `test/conflictcore.test.js` | create | Unit tests. |

---

### Task 1: GitHub client (`src/main/github.js`)

**Files:**
- Create: `src/main/github.js`
- Test: `test/github.test.js`

**Interfaces:**
- Produces:
  - `parseGithubRemote(url: string): { owner: string, repo: string } | null`
  - `class GithubError extends Error { code: 'reauth' | 'forbidden' | 'not-found' | 'not-mergeable' | 'head-changed' | 'http'; status: number }` — 401→`reauth`, 403→`forbidden`, 404→`not-found`, 405→`not-mergeable`, 409→`head-changed`, other non-2xx→`http`. `message` is GitHub's `message` field when present.
  - `githubClient({ token, fetch }): { listPulls(o, r, base), getPull(o, r, n), pullCommits(o, r, n), pullFiles(o, r, n), getCommit(o, r, sha), getRepo(o, r), mergePull(o, r, n, { method, sha }) }` — all async, returning parsed JSON, except the normalized shapes below.
  - `listPulls` returns `GhPull[]` normalized to `{ number, title, author, avatar, head: { ref, label, sha, repo: string | null }, base: string, draft, commits?, mergeable: boolean | null, mergeableState: string, url, createdAt }` (`head.repo` = `head.repo?.full_name ?? null`; `head.label` = `'unknown:' + ref` when repo is null).
  - `pullFiles` follows pages of 100 until a page is short or 3000 files; returns `{ path, previous, status, additions, deletions, patch: string | null }[]`.
  - `pullCommits` returns `{ sha, message, author, avatar, date }[]` (`author` = `commit.author.name`).

- [ ] **Step 1: Write the failing tests** in `test/github.test.js` with a fake `fetch` that records `(url, init)` and returns queued `{ status, json }`:
  - `parseGithubRemote` on `https://github.com/itsphatto/Project-B.git`, `https://github.com/itsphatto/Project-B`, `git@github.com:itsphatto/Project-B.git`, `ssh://git@github.com/itsphatto/Project-B` → `{ owner: 'itsphatto', repo: 'Project-B' }`; `https://gitlab.com/a/b.git` and `''` → `null`.
  - `listPulls('o','r','main')` requests `https://api.github.com/repos/o/r/pulls?state=open&base=main&per_page=50` with the four Global Constraints headers; normalizes a sample PR; a PR with `head.repo: null` gives `head.repo === null` and `head.label === 'unknown:feature'`.
  - `pullFiles` with a first page of 100 and second of 3 → 103 files and two requests (`page=1`, `page=2`).
  - Error mapping: status 401 → rejects `GithubError` with `code 'reauth'`; 405 → `'not-mergeable'`; 409 → `'head-changed'`; message taken from body `{ message: 'Head branch was modified' }`.
  - `mergePull('o','r',7,{ method:'squash', sha:'abc' })` sends `PUT .../pulls/7/merge` with JSON body `{ merge_method: 'squash', sha: 'abc' }`.
- [ ] **Step 2: Run** `node --test test/github.test.js` — Expected: FAIL, `Cannot find module '../src/main/github'`.
- [ ] **Step 3: Implement `src/main/github.js`** with the interfaces above (one private `request(method, path, body)` sharing headers and error mapping; `module.exports = { parseGithubRemote, githubClient, GithubError }`).
- [ ] **Step 4: Run** `node --test test/github.test.js` — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/main/github.js test/github.test.js && git commit -m "feat(scm): GitHub pull request client"`

---

### Task 2: GitHub IPC, types and demo stubs

**Files:**
- Modify: `src/main/main.js` (near `git:fileLog`), `src/main/preload.js` (new `gh` group), `src/renderer/breeze/core.ts` (`BreezeApi`), `src/renderer/breeze/platform.ts` (demo `gh`)
- Modify: `package.json` `test` script is unchanged (it already globs `test/**/*.test.js`)

**Interfaces:**
- Consumes: Task 1 `parseGithubRemote`, `githubClient`, `GithubError`.
- Produces (main): `async function githubFor(): Promise<{ client, owner, repo } | { error: 'signed-out' | 'not-github' | 'no-remote' }>`.
- Produces (IPC → `api.gh`), every call resolving `GhResult<T> = { ok: true, data: T } | { ok: false, error: string, message?: string }` (a `GithubError` becomes `{ ok: false, error: e.code, message: e.message }`; never rejects):
  - `prs(base: string): GhResult<{ owner: string; repo: string; pulls: GhPull[] }>` (30 s cache keyed `owner/repo/base`; `force?: boolean` second arg skips it)
  - `pr(n: number): GhResult<GhPull>` · `prCommits(n): GhResult<GhCommit[]>` · `prFiles(n): GhResult<GhFile[]>` · `commit(sha): GhResult<GhFile[]>` (the commit's `files`) · `repo(): GhResult<{ allowMerge: boolean; allowSquash: boolean; allowRebase: boolean }>` · `merge(n, method, sha): GhResult<{ merged: boolean; message: string }>`
- Produces (renderer types in `core.ts`): `GhPull`, `GhCommit`, `GhFile`, `GhResult<T>` matching the shapes above.

- [ ] **Step 1: Implement `githubFor()`** in `main.js`: remote via `git(['remote', 'get-url', 'origin'])` (failure → `no-remote`), `parseGithubRemote` (null → `not-github`), token per Global Constraints (`accountsState()`, `accountId`, `getSecret`).
- [ ] **Step 2: Add the seven `gh:*` handlers** using `handle(...)`, wrapping each in one `ghCall(fn)` helper that produces `GhResult`.
- [ ] **Step 3: Expose them** in `preload.js` as `gh: { prs, pr, prCommits, prFiles, commit, repo, merge }`, and add `gh` to `BreezeApi` in `core.ts`.
- [ ] **Step 4: Add demo stubs** to `platform.ts`: two pulls into `main` — `#48 "Sapfire151/dev"` ready (`mergeable: true`) and `#51 "fix-login"` conflicting (`mergeable: false, mergeableState: 'dirty'`), each with 2–3 commits and 2 files whose `patch` has removed and added lines; `merge` resolves `{ ok: true, data: { merged: true, message: 'Merged' } }`.
- [ ] **Step 5: Verify** `npx tsc` exits 0 and `npm test` passes.
- [ ] **Step 6: Commit** `git commit -am "feat(scm): GitHub IPC for pull requests"`

---

### Task 3: Full-page Source Control shell

**Files:**
- Modify: `src/renderer/breeze.html` (add `#scmPage` inside `<section class="center">` as a sibling of `#work`), `src/renderer/breeze.css`, `src/renderer/breeze/views.ts:52-63`, `src/renderer/breeze/git.ts` (`renderScm`, `renderBranch`, `showDiff`)
- Create: `src/renderer/breeze/prs.ts` (shell part only), add to `tsconfig.json` and `breeze.html` after `git.js`

**Interfaces:**
- Produces (in `prs.ts`):
  - `let scmPageOpen: boolean`
  - `function openScmPage(): void` / `function closeScmPage(): void` — toggles `#main.scm-page`, which CSS uses to hide `#work`, the side panel and its sash, and show `#scmPage`. The agents panel is left as is. Saved `layout` is not changed, so closing restores the previous layout exactly.
  - `function showScmDetail(html: string, bind?: (el: HTMLElement) => void): void` — renders into `#scmDetail`.
  - `function scmEmptyDetail(): void` — empty state: icon + "Select a change or a pull request".
- Markup: `#scmPage > .scm-left#scmLeft (resizable via a new 'scm' sash, default 320px, clamp 240–560, stored as layout.scmLeft) + .scm-detail#scmDetail`. The existing `[data-panel="git"]` head and `#scm` body move into `#scmLeft` (same ids, so `git.ts` keeps working).

- [ ] **Step 1: Move markup** — cut the git panel's `.side-head` and `#scm` into `#scmLeft`; leave an empty `[data-panel="git"]` so `showView` still finds it.
- [ ] **Step 2: Hook views** — in `showView`, `v === 'git'` calls `openScmPage()`; any other `v` calls `closeScmPage()`. Clicking the active git icon again closes the page (back to the previous view, `files` by default).
- [ ] **Step 3: Inline diffs** — `showDiff` calls `showScmDetail` instead of `openModal` when `scmPageOpen`; its Open File button first calls `closeScmPage()`.
- [ ] **Step 4: Styles** — `.main.scm-page` rules; left column scrolls on its own; detail fills the rest.
- [ ] **Step 5: Verify in the browser demo** (`preview_start breeze-static`, open `src/renderer/breeze.html`, open the demo folder): Source Control icon → full page with branch, changes, commit box and graph on the left; clicking a changed file shows its diff on the right; Explorer icon → editor and preview return at their previous sizes. `npx tsc` exits 0.
- [ ] **Step 6: Commit** `git commit -am "feat(scm): full-page Source Control"`

---

### Task 4: Patch and PR-status logic (`scmcore.ts`)

**Files:**
- Create: `src/renderer/breeze/scmcore.ts` (no DOM, no globals from other files); add to `tsconfig.json` and `breeze.html` before `git.js`
- Test: `test/scmcore.test.js` (load with `vm` + `stripTypeScriptTypes`, as `test/editcore.test.js` does)

**Interfaces:**
- Produces:
  - `type PatchRow = { kind: 'hunk' | 'add' | 'del' | 'ctx' | 'note'; text: string; old: number | null; new: number | null }`
  - `function parsePatch(patch: string): PatchRow[]` — line numbers from each `@@ -a,b +c,d @@`; `\ No newline at end of file` → `note` with both numbers null.
  - `function prStatus(p: { mergeable: boolean | null; mergeableState: string; draft: boolean }): 'ready' | 'conflict' | 'checking' | 'draft'` — `draft` first; `mergeable === false || mergeableState === 'dirty'` → `conflict`; `mergeable === null` → `checking`; else `ready`.
  - `function prListState(s: { signedIn: boolean; branch: string | null; result: GhResult<unknown> | null }): 'no-branch' | 'signed-out' | 'loading' | 'ok' | string` — `branch === null` → `'no-branch'` before anything else; `result === null` → `'loading'`; `ok: false` → its `error`.

- [ ] **Step 1: Write failing tests**:
  - `parsePatch('@@ -10,3 +10,4 @@ fn\n a\n-b\n+B\n+C\n c')` → rows `hunk(null,null)`, `ctx(10,10)`, `del(11,null)`, `add(null,11)`, `add(null,12)`, `ctx(12,13)`.
  - `parsePatch` with `\ No newline at end of file` gives a `note` row.
  - `prStatus` for each of the four outcomes, including `{ mergeable: true, mergeableState: 'dirty', draft: false }` → `'conflict'` and draft winning over conflict.
  - `prListState({ signedIn: true, branch: null, result: null })` → `'no-branch'` (Review Focus 4).
- [ ] **Step 2: Run** `node --test test/scmcore.test.js` — Expected: FAIL (file missing).
- [ ] **Step 3: Implement** `scmcore.ts`.
- [ ] **Step 4: Run** the test — Expected: PASS; `npx tsc` exits 0.
- [ ] **Step 5: Commit** `git add src/renderer/breeze/scmcore.ts test/scmcore.test.js tsconfig.json src/renderer/breeze.html && git commit -m "feat(scm): patch parsing and PR status"`

---

### Task 5: PR list and PR detail (read only)

**Files:**
- Modify: `src/renderer/breeze/prs.ts`, `src/renderer/breeze/git.ts` (`renderScm` appends the PR section between the commit box and the graph; `refreshGit` and branch switch call `refreshPrs()`), `src/renderer/breeze.css`

**Interfaces:**
- Consumes: Task 2 `api.gh.*`; Task 3 `showScmDetail`, `scmPageOpen`; Task 4 `parsePatch`, `prStatus`, `prListState`.
- Produces:
  - `async function refreshPrs(force = false): Promise<void>`
  - `function prSectionHtml(): string` (used by `renderScm`)
  - `async function openPr(n: number): Promise<void>`
  - `function patchHtml(patch: string | null, url: string): string` — `.diff` with two line-number gutters (`.ln-old`, `.ln-new`) and `.dl.add|del|hunk` rows; null patch → "This file's diff isn't available here" + Open on GitHub.
  - Module state `prGen: number` — incremented on every `refreshPrs` and `openPr`; a response is dropped if `prGen` changed while it was in flight (Review Focus 1).

- [ ] **Step 1: PR section** — rows per spec §2 (number, title, `head.label → base`, avatar + login, commit count, status dot from `prStatus`, Draft pill). Each `prListState` value has its line of copy and button: `no-branch` "Not on a branch" · `signed-out` "Sign in with GitHub to see pull requests" [Sign in] · `reauth` "Your GitHub sign-in expired" [Sign in again] · `not-github` "This repository isn't on GitHub" · `no-remote` "No origin remote" · other errors "Couldn't load pull requests" [Retry] · empty list "No open pull requests into {branch}". `refreshPrs()` runs on page open, branch switch, the section's refresh button, and window focus (call it from the existing `focus` listener in `git.ts` alongside `queueGitRefresh`).
- [ ] **Step 2: Detail** — header (title, `#n`, `head → base`, author, time, Open on GitHub, Merge button placeholder disabled until Task 6) and tabs Commits / Files / Conflict (Conflict only when `prStatus === 'conflict'`). Commits: click a row expands that commit's files via `api.gh.commit(sha)` rendered with `patchHtml`. Files: collapsible blocks, status + `+adds −dels`, start collapsed when the patch has over 400 lines. A `checking` PR re-asks `api.gh.pr(n)` once after 2 s.
- [ ] **Step 3: Fork with deleted repo** — when `head.repo === null`, the Conflict tab's *Resolve conflicts* button is disabled with "The source repository no longer exists" (Review Focus 3).
- [ ] **Step 4: Verify in the browser demo**: PR section lists #48 (green) and #51 (red); clicking #48 shows its commits and files with red/green lines and both line numbers; switching branch in the picker to a branch with no PRs shows "No open pull requests into …" and a late answer for `main` does not replace it (simulate by delaying the demo `prs` stub 1.5 s and switching within that time). `npx tsc` exits 0.
- [ ] **Step 5: Commit** `git commit -am "feat(scm): pull request list and detail"`

---

### Task 6: Merging on GitHub

**Files:**
- Modify: `src/renderer/breeze/prs.ts`

**Interfaces:**
- Consumes: `api.gh.repo()`, `api.gh.merge(n, method, sha)`, `api.git.sync('pull')`, `popupMenu`.
- Produces: `async function mergePr(pr: GhPull, method: 'merge' | 'squash' | 'rebase'): Promise<void>`

- [ ] **Step 1: Merge menu** — the Merge button (enabled for `ready`; disabled with a tooltip for `draft`, `conflict`, `checking`) opens `popupMenu` with *Create a merge commit* · *Squash and merge* · *Rebase and merge*, each `enabled` from `api.gh.repo()`.
- [ ] **Step 2: `mergePr`** sends the head sha the detail was rendered with. Success → toast `Merged #{n}`, `refreshPrs(true)`, and `api.git.sync('pull')` then `refreshGit()` when the current branch equals `pr.base`. Failure copy: `not-mergeable` "GitHub can't merge this pull request right now" · `head-changed` "New commits were pushed while you were reviewing" + [Reload] · `forbidden` "You don't have permission to merge here" · other → the API message.
- [ ] **Step 3: Verify in the browser demo**: Merge on #48 → Squash → toast "Merged #48" and the list refreshes; make the demo `merge` stub return `{ ok: false, error: 'head-changed' }` once and check the Reload button reopens the PR. `npx tsc` exits 0.
- [ ] **Step 4: Commit** `git commit -am "feat(scm): merge pull requests on GitHub"`

---

### Task 7: Conflict worktree (`src/main/prconflict.js`)

**Files:**
- Create: `src/main/prconflict.js`
- Test: `test/prconflict.test.js` (real git in a temp dir; a bare repo as `origin`)

**Interfaces:**
- Produces (all take `run(cwd: string, args: string[], input?: string) => Promise<string>` that rejects on non-zero exit):
  - `startConflict({ run, repoDir, worktreesDir, number, base }): Promise<ConflictSession>` where `ConflictSession = { id: string, dir: string, number: number, base: string, headRef: string, clean: boolean, files: ConflictFile[] }` and `ConflictFile = { path: string, ours: string | null, theirs: string | null, merged: string }` (`null` = deleted on that side). `id` = `<sha1(repoDir) first 8>-<number>`; `headRef` is passed in by the caller from `GhPull.head.ref`. Steps per spec §5 (fetch `pull/{n}/head:refs/breeze/pr-{n}`, fetch base, `worktree add --detach`, `merge --no-commit --no-ff origin/{base}` tolerating exit 1, `diff --name-only --diff-filter=U`, `show :2:path` / `:3:path` with failure → `null`).
  - `finishConflict({ run, session, results: { path: string, text: string | null }[] }): Promise<void>` — writes each result (`null` → `git rm`), `git add`, commit with the Global Constraints message, `git push origin HEAD:{headRef}`, then `abortConflict`'s cleanup minus `merge --abort`.
  - `abortConflict({ run, repoDir, session }): Promise<void>` — `merge --abort` (ignore failure), `worktree remove --force`, `update-ref -d refs/breeze/pr-{n}`.
  - `pruneConflicts({ run, repoDir, worktreesDir }): Promise<void>` — `worktree prune` and delete leftover folders under `worktreesDir` for this repo.

- [ ] **Step 1: Write failing tests** building: bare `origin`; clone; `main` with `a.txt = "one\n"`; branch `feature` changes it to `"feature\n"` and pushes `refs/pull/7/head`; `main` changes it to `"main\n"` and pushes. Also `b.txt` modified on `feature` and deleted on `main`. Assertions:
  - `startConflict` returns 2 files; `a.txt` has `ours === 'feature\n'`, `theirs === 'main\n'`, `merged` containing `<<<<<<<`; `b.txt` has `theirs === null` (Review Focus 2).
  - The user's clone is untouched: `git status --porcelain` in `repoDir` is empty and its HEAD unchanged.
  - `finishConflict` with `a.txt → "both\n"`, `b.txt → null` pushes a commit to `feature` on `origin` whose message is `Merge main into feature (resolved in Breeze)`, and removes the worktree and ref.
  - `abortConflict` after `startConflict` leaves no worktree (`git worktree list` has one entry) and no `refs/breeze/pr-7`.
  - A file committed with CRLF on both sides keeps `\r\n` in `merged` (Review Focus 5).
- [ ] **Step 2: Run** `node --test test/prconflict.test.js` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `src/main/prconflict.js`.
- [ ] **Step 4: Run** the test — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/main/prconflict.js test/prconflict.test.js && git commit -m "feat(scm): resolve PR conflicts in a separate worktree"`

---

### Task 8: Conflict compare page

**Files:**
- Create: `src/renderer/breeze/conflictcore.ts` (DOM-free; before `git.js`) and `src/renderer/breeze/conflicts.ts` (UI; after `prs.js`); add both to `tsconfig.json` and `breeze.html`
- Modify: `src/main/main.js` (IPC + `pruneConflicts` after the workspace opens), `src/main/preload.js`, `src/renderer/breeze/core.ts`, `src/renderer/breeze/platform.ts`, `src/renderer/breeze/prs.ts` (Resolve conflicts button)
- Test: `test/conflictcore.test.js`

**Interfaces:**
- Consumes: Task 7; Task 3 `showScmDetail`; Task 5 `openPr`.
- Produces (IPC → `api.git`): `prConflictStart(n: number, base: string, headRef: string): Promise<ConflictSession>`, `prConflictFinish(id: string, results: { path: string; text: string | null }[]): Promise<void>`, `prConflictAbort(id: string): Promise<void>`. Main keeps open sessions in a `Map<id, session>`; worktrees dir = `path.join(app.getPath('userData'), 'pr-worktrees')`.
- Produces (`conflictcore.ts`):
  - `type ConflictBlock = { start: number; end: number; ours: string; theirs: string }` (character offsets in `merged`, `end` exclusive, markers included)
  - `function parseConflicts(text: string): ConflictBlock[]` — `<<<<<<<` / `=======` / `>>>>>>>` at line start, `\n` or `\r\n`, ignores `|||||||` base sections (diff3) by dropping them.
  - `function applyChoice(text: string, block: ConflictBlock, choice: 'ours' | 'theirs' | 'both' | { custom: string }): string` — `both` = ours then theirs.
  - `function hasMarkers(text: string): boolean`
- Produces (`conflicts.ts`): `async function openConflictPage(pr: GhPull): Promise<void>`.

- [ ] **Step 1: Write failing `conflictcore` tests**: two blocks parsed with correct `ours`/`theirs` and offsets; CRLF input parses and `applyChoice(..., 'theirs')` output still contains `\r\n` and no markers; `both` concatenates; diff3 base section dropped; `hasMarkers` true/false.
- [ ] **Step 2: Run** `node --test test/conflictcore.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** `conflictcore.ts`; run — Expected: PASS.
- [ ] **Step 4: IPC + demo** — the three `git:prConflict*` handlers in `main.js` (using the existing `git` binary via a `run` that calls `execFile(gitBin, safeGitArgs(args), { cwd })`), preload, `core.ts` types, a `pruneConflicts` call each time a workspace folder opens (leftovers from a crash), and a demo session for #51 with one text conflict and one deleted-on-base file.
- [ ] **Step 5: Page** — per spec §5: conflicted-file list with ✓; three panes Ours (PR) | Theirs (base branch) | Result (editable textarea using the editor font); per block *Use ours* · *Use theirs* · *Use both* · *Duel* (Duel disabled until Task 9); Prev/Next and "{k} of {n} left". A file whose `ours` or `theirs` is `null` shows "Deleted in this branch" in that pane and offers *Keep file* / *Delete file*. *Commit resolution* is enabled when no file `hasMarkers`; it calls `prConflictFinish`, toasts "Conflicts resolved and pushed", then `openPr(n)`. *Cancel* calls `prConflictAbort`. A push failure keeps the session open, shows the error, and adds *Copy resolved file* per file. A `clean: true` session shows "No conflicts after all" + [Push merge].
- [ ] **Step 6: Verify in the browser demo**: #51 → Conflict tab → Resolve conflicts → page opens; Use theirs removes the block and the counter drops; the deleted file offers Keep/Delete; Commit resolution enables only when both are resolved. `npx tsc` exits 0, `npm test` passes.
- [ ] **Step 7: Commit** `git commit -am "feat(scm): conflict compare page"`

---

### Task 9: Conflict Duel

**Files:**
- Modify: `src/main/main.js`, `src/main/preload.js`, `src/renderer/breeze/core.ts`, `src/renderer/breeze/platform.ts`, `src/renderer/breeze/conflictcore.ts`, `src/renderer/breeze/conflicts.ts`, `src/renderer/breeze.css`
- Test: `test/conflictcore.test.js` (extend)

**Interfaces:**
- Consumes: Task 8 `ConflictBlock`, `applyChoice`; existing `COMMIT_WRITERS` / `defaultCommitAgent` in `main.js`; renderer `currentActiveAgent()` (git.ts) and `openAgentPicker()` (setup.ts).
- Produces:
  - IPC `agent:ask` → `api.agent.ask(opts: { agent: string; prompt: string; model?: string; effort?: string }): Promise<string>` — same body as `git:genCommitMsg` (one-shot, read-only), kept as its own channel so commit-message tweaks never change the Duel.
  - `function duelPrompts(input: { path: string; before: string; ours: string; theirs: string; after: string }): { ours: string; theirs: string; judge: (oursArg: string, theirsArg: string) => string }` — `before`/`after` are up to 40 lines each around the block. Advocate prompts ask for at most 120 words: why their side should win and what breaks if the other wins. The judge prompt asks for a verdict of at most 80 words followed by exactly one fenced code block holding only the merged lines.
  - `function extractCodeBlock(reply: string): string | null` — contents of the first fenced block, without the fence line or language tag; `null` if none.

- [ ] **Step 1: Write failing tests**: `duelPrompts` includes the file path, both versions and the 40-line context, and the judge prompt includes both arguments; `extractCodeBlock('Verdict…\n```ts\nconst a = 1;\n```')` → `'const a = 1;'`; no fence → `null`.
- [ ] **Step 2: Run** `node --test test/conflictcore.test.js` — Expected: FAIL on the new tests.
- [ ] **Step 3: Implement** `duelPrompts`, `extractCodeBlock`; run — Expected: PASS.
- [ ] **Step 4: `agent:ask`** handler, preload, `core.ts`, and a demo stub returning canned advocate text and a judge reply with a fenced block.
- [ ] **Step 5: Duel UI** — the block's *Duel* button: no agent → `openAgentPicker()`. Otherwise show Ours / Theirs / Verdict cards, run the two advocates (in order, each card showing a spinner then its text or its error), then the judge. A judge reply with a code block replaces that block in Result via `applyChoice(..., { custom })`, highlighted "Proposed", with *Accept* (keeps it), *Edit* (focuses Result there), *Reject* (puts the original block back). A judge reply without a code block shows "The judge didn't propose a merge" and leaves Result unchanged.
- [ ] **Step 6: Verify in the browser demo**: Duel on #51's conflict shows both arguments and a verdict, the proposal lands in Result, and Reject restores the markers. `npx tsc` exits 0, `npm test` passes.
- [ ] **Step 7: Commit** `git commit -am "feat(scm): Conflict Duel"`

---

### Task 10: End-to-end check in the desktop app

**Files:** none new (fixes only, if found)

- [ ] **Step 1:** `npm test` passes and `npx tsc` exits 0.
- [ ] **Step 2:** `npm start`, open a GitHub repo you own with a test PR into `main`: the PR appears, commits and files match github.com, Merge (squash) merges it and the local `main` pulls.
- [ ] **Step 3:** Create a conflicting test PR, resolve it on the compare page (one block by hand, one by Duel), Commit resolution pushes to the PR branch, GitHub now shows it mergeable, merge it.
- [ ] **Step 4:** Signed out / Google-only / non-GitHub remote each show their message in the PR section.
- [ ] **Step 5: Commit** any fixes: `git commit -am "fix(scm): issues found in end-to-end check"`
