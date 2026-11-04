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

// A textarea's value always has LF line breaks. For a file that had CRLF, put them back before it is stored.
function withEol(text: string, crlf: boolean): string {
  return crlf ? text.replace(/\r?\n/g, '\r\n') : text;
}
