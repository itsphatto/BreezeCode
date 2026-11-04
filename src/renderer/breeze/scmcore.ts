// Pure patch / pull-request status logic for the Source Control PR view. No DOM, no globals from other files.
// `GhResult` is declared in core.ts.

type PatchRow = { kind: 'hunk' | 'add' | 'del' | 'ctx' | 'note'; text: string; old: number | null; new: number | null };

// GitHub file patches -> rows with old/new line numbers taken from each `@@ -a,b +c,d @@` header.
function parsePatch(patch: string): PatchRow[] {
  const rows: PatchRow[] = [];
  if (!patch) return rows;
  const lines = patch.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let o = 0, n = 0;
  for (const line of lines) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) { o = +h[1]; n = +h[2]; rows.push({ kind: 'hunk', text: line, old: null, new: null }); continue; }
    const c = line[0];
    if (c === '\\') rows.push({ kind: 'note', text: line, old: null, new: null });
    else if (c === '+') rows.push({ kind: 'add', text: line.slice(1), old: null, new: n++ });
    else if (c === '-') rows.push({ kind: 'del', text: line.slice(1), old: o++, new: null });
    else rows.push({ kind: 'ctx', text: line.slice(1), old: o++, new: n++ });
  }
  return rows;
}

function prStatus(p: { mergeable: boolean | null; mergeableState: string; draft: boolean }): 'ready' | 'conflict' | 'checking' | 'draft' {
  if (p.draft) return 'draft';
  if (p.mergeable === false || p.mergeableState === 'dirty') return 'conflict';
  if (p.mergeable === null) return 'checking';
  return 'ready';
}

// Whether GitHub says the pull request conflicts with its base, draft or not (prStatus reads 'draft' first, so a draft
// in conflict is still 'draft' there; its Conflict tab and Resolve depend on this instead).
function prHasConflict(p: { mergeable: boolean | null; mergeableState: string }): boolean {
  return p.mergeable === false || p.mergeableState === 'dirty';
}

// What the PR list should show: a state key, or the GithubError code when the request failed.
function prListState(s: { signedIn: boolean; branch: string | null; result: GhResult<unknown> | null }): 'no-branch' | 'signed-out' | 'loading' | 'ok' | string {
  if (s.branch === null) return 'no-branch';
  if (!s.signedIn) return 'signed-out';
  if (s.result === null) return 'loading';
  if (!s.result.ok) return s.result.error;
  return 'ok';
}
