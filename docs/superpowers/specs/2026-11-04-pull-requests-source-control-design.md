# Pull Requests in a full-page Source Control

Date: 2026-11-04
Status: Approved design, awaiting spec review

## Goal

Review and merge GitHub pull requests without leaving Breeze. From the branch you are on, see the open PRs that want
to merge into it, read every commit and changed line, merge on GitHub, and resolve merge conflicts on a compare page
where AI agents can argue each side (Conflict Duel).

**Success:** on `main`, open Source Control, see the open PRs into `main`, open one, review its commits and red/green
diffs, and merge it. If it conflicts, resolve it on the compare page (with or without the Duel), push the fix, and merge.

## Decisions

| Question | Decision |
|---|---|
| Which PRs are shown | Open PRs whose **base** is the current local branch. Switching branches changes the list. |
| Where merging happens | **On GitHub**, through the API (merge / squash / rebase). |
| Where conflicts are resolved | **Locally**, in a separate git worktree, then pushed to the PR's head branch. |
| Layout | **Full page, list + detail.** Left column: branch, changes, commit box, PRs, graph. Right: the selected item. |
| Duel agents | **The user's chosen agent, three runs** (Ours advocate, Theirs advocate, judge), all in Ask mode. |
| GitHub access | GitHub REST API from the main process, with the token of the signed-in GitHub account. No `gh` CLI. |
| Hosts | github.com only. Other remotes show an explanation in the PR section. |

## 1. Full-page Source Control

- Choosing the Source Control activity (sidebar icon, `view.git`, Ctrl+Shift+G) hides the editor area, the narrow
  side panel and the preview, and shows one full-page `#scmPage`. The agents panel keeps its current open/closed state.
  Choosing any other activity (Explorer, Search, Debug, …) restores the previous layout exactly.
- **Left column (fixed width, resizable, ~320px default):**
  1. Branch picker + refresh + sync (the existing `renderBranch` / `pickBranch` / `syncBranch`).
  2. Changes and Staged sections, commit message box with AI message button (existing `renderScm` content, moved).
  3. **Pull requests** section (new).
  4. Commit graph (existing, moved).
- **Right side (detail):** shows the selected item. A local changed file shows its diff (what `showDiff` shows today
  in a modal, now inline). A PR shows the PR detail (§3). Nothing selected: an empty state with a short hint.
- Existing modal diffs (`showDiff`) open in the right side instead of a modal when the page is visible.

## 2. PR list

- **Finding the repo:** main reads `git remote get-url origin` and parses `owner/repo` from
  `https://github.com/owner/repo(.git)`, `git@github.com:owner/repo(.git)` and `ssh://git@github.com/owner/repo`.
  Other hosts → `{ error: 'not-github' }`.
- **Token:** the active account if it is GitHub, otherwise the first saved GitHub account
  (`getSecret('token:' + accountId(a))`). None → `{ error: 'signed-out' }`. A 401 → `{ error: 'reauth' }`.
- **Request:** `GET /repos/{owner}/{repo}/pulls?state=open&base={currentBranch}&per_page=50`.
- **Row:** `#number`, title, `head → base` (head shows `owner:branch` for forks), author avatar + login, commit count,
  and a status dot:
  - green "Ready" (`mergeable === true`, `mergeable_state` clean/unstable/has_hooks),
  - red "Conflict" (`mergeable === false` or `mergeable_state === 'dirty'`),
  - grey "Checking" (`mergeable === null`; GitHub computes it lazily, so the detail call re-asks once after 2s),
  - draft PRs get a "Draft" pill and no Merge button.
- **Refresh:** on page open, branch switch, the refresh button, window focus (reusing `queueGitRefresh`'s timing), and
  after a merge. Results are cached per `owner/repo/base` for 30s.
- **Empty / error states** (each with a one-line explanation and, where useful, a button):
  no PRs into this branch · not signed in to GitHub (Sign in) · sign-in expired (Sign in again) · remote is not on
  GitHub · no `origin` remote · offline / API error (Retry).

## 3. PR detail

- **Header:** title, `#number`, `head → base`, author, created time, "Open on GitHub" link
  (`api.sys.openExternal(html_url)`), and the **Merge** button.
- **Tabs:**
  - **Commits** — `GET /pulls/{n}/commits` (up to 250). Each row: short hash, first line of message, author, relative
    time. Clicking a commit shows that commit's patch (`GET /repos/{o}/{r}/commits/{sha}`, files[].patch) below it.
  - **Files** — `GET /pulls/{n}/files` (paged, up to 3000 files). Each file is a collapsible block with status
    (added / modified / removed / renamed), `+adds −dels`, and its patch rendered as diff lines: removed lines red,
    added lines green, hunk headers blue, old and new line numbers in two gutters. Files over 400 diff lines start
    collapsed; files with no `patch` (binary or too large) say so with an "Open on GitHub" link.
  - **Conflict** — only shown when the PR is in the Conflict state; explains which files conflict once checked and
    holds the "Resolve conflicts" button (§5).
- Diff rendering reuses the existing `.diff` / `.dl` styles, extended with line-number gutters.

## 4. Merging

- **Merge** opens a small menu: *Create a merge commit* · *Squash and merge* · *Rebase and merge*. Methods the repo
  disallows (`allow_merge_commit` etc. from `GET /repos/{o}/{r}`) are disabled.
- `PUT /repos/{o}/{r}/pulls/{n}/merge` with `merge_method` and `sha` = the head sha shown (so a PR that changed while
  you reviewed it is refused, not merged blind).
- **After success:** toast "Merged #n", refresh the PR list, and if the current branch is the PR's base, run the
  existing pull (`api.git.sync('pull')`).
- **Failures** are shown as the API's message: 405 not mergeable · 409 head changed (offer Reload) · 403 no permission.

## 5. Conflict compare page

**Preparing (main process, new `git:prConflictStart(number)`):**
1. `git fetch origin pull/{n}/head:refs/breeze/pr-{n}` and `git fetch origin {base}`.
2. `git worktree add --detach <userData>/pr-worktrees/<repoHash>-{n} refs/breeze/pr-{n}` — a separate folder, so the
   user's working tree, open files and uncommitted changes are never touched.
3. In the worktree: `git merge --no-commit --no-ff origin/{base}`.
4. `git diff --name-only --diff-filter=U` → conflicted files. For each, return `ours` (stage 2, the PR head),
   `theirs` (stage 3, the base), and the working file with conflict markers.
5. Returns `{ id, files: [{ path, ours, theirs, merged }] }`. If the merge is clean (GitHub was stale), say so and
   offer to push the merge commit.

**Page (renderer, `conflicts.ts`):** replaces the right side of the Source Control page.
- File list of conflicted files (with a ✓ once resolved) on top.
- Three panes for the selected file: **Ours (PR)** | **Theirs (base branch)** | **Result**. Ours and Theirs are
  read-only, Result is editable (the existing code surface).
- Each conflict block is highlighted in all three panes with buttons: *Use ours* · *Use theirs* · *Use both* ·
  *Duel*. Prev / Next conflict buttons and a counter "2 of 5 left".
- A file is resolved when its Result has no conflict markers left.
- **Commit resolution** (enabled when every file is resolved) → main `git:prConflictFinish(id, files)` writes the
  results, `git add`, `git commit -m "Merge {base} into {head} (resolved in Breeze)"`, and
  `git push origin HEAD:{headRef}`. Then the worktree is removed, the PR detail reloads, and Merge becomes available.
- **Cancel** → `git:prConflictAbort(id)`: `git merge --abort`, remove the worktree and the `refs/breeze/pr-{n}` ref.
- Worktrees left from a crash are removed on next start (`git worktree prune` + deleting the folder).
- **Fork PRs:** if the push is refused (no write access / maintainer edits off), keep the worktree, show the error, and
  offer *Copy resolved file* per file so the user can send it to the PR author.

## 6. Conflict Duel

- Runs only on the block it was started from (not the whole file), with a short context window (40 lines around it).
- Three one-shot runs of the user's current agent through a new `api.agent.ask` (the same read-only prompt → text
  path the AI commit message uses; never edits files, no chat session), run in order:
  1. **Ours advocate** — given both versions and file path: argue for keeping Ours; name what breaks if Theirs wins.
  2. **Theirs advocate** — the same for Theirs.
  3. **Judge** — given both versions and both arguments: reply with a short verdict and one fenced code block holding
     the merged block.
- UI: two argument cards (Ours / Theirs) stream in, then a Verdict card. The judge's code block is placed into the
  Result pane in place of that conflict block, highlighted as "Proposed", with *Accept* · *Edit* · *Reject* (reject
  puts the conflict markers back).
- No agent installed / chosen → the Duel button opens the agent picker. A failed run shows its error in its card and
  the other runs still show.
- Nothing is committed by the Duel; only Commit resolution commits.

## 7. Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `src/main/github.js` (new) | Parse GitHub remote URLs; REST calls: list PRs, PR, commits, files, commit patch, repo merge settings, merge. Pure functions taking `{ token, fetch }` so they're testable. | `fetch` |
| `src/main/main.js` | IPC: `gh:prs`, `gh:pr`, `gh:prCommits`, `gh:prFiles`, `gh:commit`, `gh:merge`; token lookup; `git:prConflictStart/Finish/Abort`; worktree cleanup on start. | `github.js`, `git()` |
| `src/main/preload.js` | Exposes `api.gh.*` and the three conflict calls. | — |
| `src/renderer/breeze/core.ts` | Types for PRs, commits, files, conflict sessions; `BreezeApi.gh`. | — |
| `src/renderer/breeze/prs.ts` (new) | Full-page shell, PR list section, PR detail (tabs, diff rendering, merge menu). | `git.ts` sections, `api.gh` |
| `src/renderer/breeze/conflicts.ts` (new) | Compare page, block actions, Duel. | `api.git`, `api.agent` |
| `src/renderer/breeze/git.ts` | Existing sections render into the left column; `showDiff` renders inline when the page is open. | — |
| `src/renderer/breeze/views.ts` / `layout.ts` | Enter / leave full-page mode when the `git` view is chosen / left. | — |
| `src/renderer/breeze.html` / `breeze.css` | `#scmPage` markup and styles. | — |
| `src/renderer/breeze/platform.ts` | Browser demo: two stand-in PRs (one ready, one in conflict) with commits, files and a conflict session. | — |

## 8. Testing

- `test/github.test.js`: remote URL parsing (https, ssh, scp-style, `.git` suffix, non-GitHub); each API call against a
  fake `fetch` (paths, query, headers, paging, error mapping 401/403/404/405/409).
- `test/conflict.test.js`: in a temp repo, a PR-like branch and a base that conflict → `prConflictStart` returns the
  files with ours/theirs/markers; `Finish` commits; `Abort` leaves no worktree or ref behind. Push is stubbed.
- Conflict-block parsing (markers → blocks, apply ours/theirs/both) as pure functions with unit tests.
- Manual check in the browser demo: list, detail tabs, diff colors, merge menu, conflict page, Duel with a stubbed agent.
- Manual check in the desktop app against a real repo with an open PR.

## Out of scope (for now)

- Creating PRs, reviewing (comments, approvals, requested changes), CI checks display.
- GitHub Enterprise and non-GitHub hosts (GitLab, Bitbucket).
- PRs into branches other than the current one (no base filter switcher).

## Delivery stages

1. Full-page Source Control with existing features moved into the left column.
2. PR list + PR detail (Commits, Files) — read only.
3. Merging on GitHub.
4. Conflict compare page (local worktree, resolve, push).
5. Conflict Duel.
