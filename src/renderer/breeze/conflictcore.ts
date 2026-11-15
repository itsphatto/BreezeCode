// Pure merge-conflict text logic for the conflict page. No DOM, no globals from other files.
// A conflict in a file is a block of lines between `<<<<<<<` and `>>>>>>>`, split by `=======` into our side (the pull
// request) and their side (the base branch). With diff3 style, a `|||||||` section (the common ancestor) sits between.

// Character offsets in the text; `end` is exclusive and covers the closing marker line and its line break, so replacing
// text.slice(start, end) with whole lines leaves the lines around it as they were. `ours` and `theirs` keep their line
// breaks (LF or CRLF, as the file has them).
type ConflictBlock = { start: number; end: number; ours: string; theirs: string };
type ConflictChoice = 'ours' | 'theirs' | 'both' | { custom: string };

const CONFLICT_OPEN = /^<<<<<<<( |$)/;
const CONFLICT_BASE = /^\|\|\|\|\|\|\|( |$)/;
const CONFLICT_CLOSE = /^>>>>>>>( |$)/;

function parseConflicts(text: string): ConflictBlock[] {
  const blocks: ConflictBlock[] = [];
  // 0: outside, 1: in ours, 2: in the ancestor (dropped), 3: in theirs
  let state = 0, start = 0, ours = '', theirs = '';
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const next = nl === -1 ? text.length : nl + 1;
    const line = text.slice(pos, next);
    const bare = line.replace(/\r?\n$/, '');
    if (CONFLICT_OPEN.test(bare)) { state = 1; start = pos; ours = ''; theirs = ''; } // an unfinished block before it is dropped
    else if (state === 1 && CONFLICT_BASE.test(bare)) state = 2;
    else if ((state === 1 || state === 2) && bare === '=======') state = 3;
    else if (state === 3 && CONFLICT_CLOSE.test(bare)) { blocks.push({ start, end: next, ours, theirs }); state = 0; }
    else if (state === 1) ours += line;
    else if (state === 3) theirs += line;
    pos = next;
  }
  return blocks;
}

// A conflict marker line is still there: a whole block, or the half of one that was edited away.
function hasMarkers(text: string): boolean {
  return /^(<<<<<<<|>>>>>>>)( |\r?$)/m.test(text);
}

function applyChoice(text: string, block: ConflictBlock, choice: ConflictChoice): string {
  let pick = typeof choice === 'object' ? choice.custom : choice === 'ours' ? block.ours : choice === 'theirs' ? block.theirs : block.ours + block.theirs;
  // The closing marker was the file's last line, with no line break after it: the choice doesn't gain one either.
  if (!/\n$/.test(text.slice(block.start, block.end)) && typeof choice !== 'object') pick = pick.replace(/\r?\n$/, '');
  return text.slice(0, block.start) + pick + text.slice(block.end);
}

// Up to `lines` lines right before the block and right after it, as the text has them (line breaks kept). `start` and `end`
// sit on line boundaries, so each side is whole lines.
function blockContext(text: string, block: ConflictBlock, lines = 40): { before: string; after: string } {
  let from = block.start;
  for (let n = 0; n < lines && from > 0; n++) from = from < 2 ? 0 : text.lastIndexOf('\n', from - 2) + 1; // the line before `from`
  let to = block.end;
  for (let n = 0; n < lines && to < text.length; n++) {
    const nl = text.indexOf('\n', to);
    to = nl === -1 ? text.length : nl + 1;
  }
  return { before: text.slice(from, block.start), after: text.slice(block.end, to) };
}

// The Duel: each side's advocate argues for its version, then a judge picks or merges. The prompts carry everything the agent
// needs (the file path and the surrounding lines) and tell it to use no tools. Telling is all this file can do: the code in a
// conflict can come from someone else's fork, so main also takes tools away from the agents that allow it (see agent:ask).
// Code sits in fences longer than any backtick run inside it, so it can't close its own fence.
type DuelInput = { path: string; before: string; ours: string; theirs: string; after: string };
const NO_TOOLS = 'Do not run commands, read files or use any tools; answer only from the text in this message.';
function duelPrompts(input: DuelInput): { ours: string; theirs: string; judge: (oursArg: string, theirsArg: string) => string } {
  const fence = (s: string): string => {
    const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map(r => r.length));
    const ticks = '`'.repeat(Math.max(4, longest + 1));
    return ticks + '\n' + (s === '' || s.endsWith('\n') ? s : s + '\n') + ticks;
  };
  const setting = `A merge conflict in ${input.path}. ${NO_TOOLS}
The code just before it:
${fence(input.before)}

Version "ours":
${fence(input.ours)}

Version "theirs":
${fence(input.theirs)}

The code just after it:
${fence(input.after)}`;
  const advocate = (side: 'ours' | 'theirs', other: string): string => `You are arguing for one side of a merge conflict. ${setting}

Argue that the "${side}" version should win: why it is right for this code, and what breaks if "${other}" wins instead. Use at most 120 words. Plain text, no code block, no preamble.`;
  return {
    ours: advocate('ours', 'theirs'),
    theirs: advocate('theirs', 'ours'),
    judge: (oursArg, theirsArg) => `You are the judge of a merge conflict. ${setting}

The advocate for "ours" says:
${oursArg}

The advocate for "theirs" says:
${theirsArg}

Decide how the conflict should be resolved: one side, or a merge of both. Give a verdict of at most 80 words, then exactly one fenced code block holding only the merged lines that replace the conflict (no conflict markers, no surrounding code, no second code block). Fence it with four backticks (\`\`\`\`) so code that contains three backticks stays inside it.`,
  };
}

// The first fenced block in an agent's reply, without its fence lines and language tag; null if there is none (or it never closes).
// A fence is three or more backticks on a line of their own (then an optional language tag); it closes at a line of only
// backticks at least as long, so a shorter run inside the code stays code.
const CODE_BLOCK = /^[ \t]*(`{3,})[^\r\n`]*\r?\n(?:([\s\S]*?)\r?\n)??[ \t]*\1`*[ \t]*(?:\r?\n|$)/m;
function extractCodeBlock(reply: string): string | null {
  const m = CODE_BLOCK.exec(reply);
  return m ? m[2] ?? '' : null;
}

// The reply without that first fenced block: the judge's verdict, shown next to the proposed merge.
function withoutCodeBlock(reply: string): string {
  return reply.replace(CODE_BLOCK, '').trim();
}

// A textarea's value always has LF line breaks. For a file that had CRLF, put them back before it is stored.
function withEol(text: string, crlf: boolean): string {
  return crlf ? text.replace(/\r?\n/g, '\r\n') : text;
}

// Which lines of `a` and of `b` the other side doesn't have, by their longest common subsequence. Runs of changed lines
// between two kept ones are paired up in order (`pairs`), so an edited line can show what changed inside it. Past
// DIFF_MAX_CELLS (the table the subsequence needs) everything between the common start and end counts as changed.
type LineDiff = { a: boolean[]; b: boolean[]; pairs: Array<[number, number]> };
const DIFF_MAX_CELLS = 4_000_000;
function lineDiff(a: string[], b: string[]): LineDiff {
  const n = a.length, m = b.length;
  const ca: boolean[] = new Array(n).fill(true), cb: boolean[] = new Array(m).fill(true);
  let p = 0;
  while (p < n && p < m && a[p] === b[p]) { ca[p] = cb[p] = false; p++; }
  let s = 0;
  while (s < n - p && s < m - p && a[n - 1 - s] === b[m - 1 - s]) { ca[n - 1 - s] = cb[m - 1 - s] = false; s++; }
  const an = n - p - s, bm = m - p - s;
  if (an > 0 && bm > 0 && an * bm <= DIFF_MAX_CELLS) {
    const w = bm + 1, dp = new Uint32Array((an + 1) * w); // dp[i][j]: the subsequence's length from a[p+i] and b[p+j] on
    for (let i = an - 1; i >= 0; i--) {
      for (let j = bm - 1; j >= 0; j--) dp[i * w + j] = a[p + i] === b[p + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
    for (let i = 0, j = 0; i < an && j < bm;) {
      if (a[p + i] === b[p + j]) { ca[p + i] = cb[p + j] = false; i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
      else j++;
    }
  }
  const pairs: Array<[number, number]> = [];
  for (let i = 0, j = 0; i < n || j < m;) {
    if (i < n && j < m && !ca[i] && !cb[j]) { i++; j++; continue; }
    const ra: number[] = [], rb: number[] = [];
    while (i < n && ca[i]) ra.push(i++);
    while (j < m && cb[j]) rb.push(j++);
    for (let k = 0; k < Math.min(ra.length, rb.length); k++) pairs.push([ra[k], rb[k]]);
    if (!ra.length && !rb.length) { i++; j++; } // can't happen (both sides keep the same lines); never loops forever
  }
  return { a: ca, b: cb, pairs };
}

// The part of two lines that differs: [from, to) in each, between their common start and common end. Null when they
// share nothing at either end, where marking the whole line again would add nothing.
function changedSpan(a: string, b: string): { a: [number, number]; b: [number, number] } | null {
  const min = Math.min(a.length, b.length);
  let p = 0;
  while (p < min && a[p] === b[p]) p++;
  let s = 0;
  while (s < min - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  if (p === 0 && s === 0) return null;
  return { a: [p, a.length - s], b: [p, b.length - s] };
}

// What each line inside a conflict block is, for colouring the result: the marker lines, our side, the common ancestor
// (diff3) and their side, with the block's index. Lines outside every block aren't in the map. Lines are 0-based.
type ConflictLineKind = 'open' | 'ours' | 'base-mk' | 'base' | 'sep' | 'theirs' | 'close';
function conflictLines(text: string): Map<number, { kind: ConflictLineKind; block: number }> {
  const out = new Map<number, { kind: ConflictLineKind; block: number }>();
  const blocks = parseConflicts(text);
  if (!blocks.length) return out;
  let line = 0, pos = 0;
  blocks.forEach((b, block) => {
    for (; pos < b.start; line++) { const nl = text.indexOf('\n', pos); pos = nl === -1 ? text.length : nl + 1; }
    let state: ConflictLineKind = 'open';
    while (pos < b.end) {
      const nl = text.indexOf('\n', pos), next = nl === -1 ? text.length : nl + 1;
      const bare = text.slice(pos, next).replace(/\r?\n$/, '');
      let kind: ConflictLineKind;
      if (state === 'open' && CONFLICT_OPEN.test(bare)) { kind = 'open'; state = 'ours'; }
      else if (state === 'ours' && CONFLICT_BASE.test(bare)) { kind = 'base-mk'; state = 'base'; }
      else if ((state === 'ours' || state === 'base') && bare === '=======') { kind = 'sep'; state = 'theirs'; }
      else if (state === 'theirs' && CONFLICT_CLOSE.test(bare)) kind = 'close';
      else kind = state;
      out.set(line, { kind, block });
      line++; pos = next;
    }
  });
  return out;
}
