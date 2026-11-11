/* ================= Big-file surface: pure cache and caret logic (no DOM) ================= */
// Shared global scope with the breeze/ files: no imports or exports here. DocPos and DocLine are declared in
// breeze/core.ts; this file only names them as types, so it also runs alone under the Node test.

// The engine returns a line cut to this many UTF-16 units; its full length comes back as `len`.
const BIG_LONG_LINE = 10000;
// An edit that would put more new lines than this into the cache clears it instead: the surface refetches its window.
const BIG_CACHE_EDIT_LINES = 2000;

function posCmp(a: DocPos, b: DocPos): number { return a.line - b.line || a.col - b.col; }
function posMin(a: DocPos, b: DocPos): DocPos { return posCmp(a, b) <= 0 ? a : b; }
function posMax(a: DocPos, b: DocPos): DocPos { return posCmp(a, b) >= 0 ? a : b; }

/** Where the caret lands after `text` (with "\n" line breaks) is inserted at `start`. */
function posAfterInsert(start: DocPos, text: string): DocPos {
  const nl = text.lastIndexOf('\n');
  if (nl === -1) return { line: start.line, col: start.col + text.length };
  let lines = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lines++;
  return { line: start.line + lines, col: text.length - nl - 1 };
}

/** How many lines the document gains (negative: loses) when start..end is replaced by `text`. */
function lineDelta(start: DocPos, end: DocPos, text: string): number {
  let added = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) added++;
  return added - (end.line - start.line);
}

/** The page's copy of the lines around the viewport. Edits are applied to it at once, before the engine answers. */
class LineCache {
  /** Line number of items[0]. */
  first = 0;
  items: DocLine[] = [];
  /** Revision the cached lines reflect, counting local edits not yet confirmed. */
  rev = 0;

  /** One past the last cached line. */
  get last(): number { return this.first + this.items.length; }
  get(line: number): DocLine | undefined { return this.items[line - this.first]; }
  /** Every line in first..last (exclusive) is cached. */
  covers(first: number, last: number): boolean { return first >= this.first && last <= this.last; }

  /** Stores a fetched window. Returns false, storing nothing, when `rev` is older than this.rev: that reply was
   *  asked for before a local edit and would undo it. */
  put(first: number, items: DocLine[], rev: number): boolean {
    if (rev < this.rev) return false;
    this.first = first;
    this.items = items.slice();
    this.rev = rev;
    return true;
  }

  /** Applies an edit to the cached lines as the engine will, and bumps rev by one. If start or end falls outside
   *  the cache, or on a line the engine cut at BIG_LONG_LINE, the cache is cleared: the text there is unknown. */
  apply(start: DocPos, end: DocPos, text: string): void {
    this.rev++;
    const lo = posMin(start, end), hi = posMax(start, end);
    const a = this.get(lo.line), b = this.get(hi.line);
    if (!a || !b || a.len > a.text.length || b.len > b.text.length) { this.clear(); return; }
    let made = 1;
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) made++;
    if (made > BIG_CACHE_EDIT_LINES) { this.clear(); return; }
    const joined = a.text.slice(0, lo.col) + text + b.text.slice(hi.col);
    // Like the engine, a line grown past the cut is held cut, with its full length in `len`.
    const lines: DocLine[] = joined.split('\n').map(t => t.length > BIG_LONG_LINE ? { text: t.slice(0, BIG_LONG_LINE), len: t.length } : { text: t, len: t.length });
    const at = lo.line - this.first;
    // Not splice(..., ...lines): spreading into a call has an argument limit.
    this.items = this.items.slice(0, at).concat(lines, this.items.slice(at + hi.line - lo.line + 1));
  }

  clear(): void {
    this.first = 0;
    this.items = [];
  }
}

interface BigMods { shift: boolean; ctrl: boolean }

// Columns never sit between the two halves of a surrogate pair.
const isLowSurrogate = (c: number) => c >= 0xDC00 && c <= 0xDFFF;
const isHighSurrogate = (c: number) => c >= 0xD800 && c <= 0xDBFF;
// A line the engine cut ends at BIG_LONG_LINE, so a high surrogate as the last unit there is half of a pair cut in two.
function snapCol(text: string | undefined, col: number): number {
  if (text && col === BIG_LONG_LINE && col === text.length && isHighSurrogate(text.charCodeAt(col - 1))) return col - 1;
  if (text && col > 0 && col < text.length && isLowSurrogate(text.charCodeAt(col)) && isHighSurrogate(text.charCodeAt(col - 1))) return col - 1;
  return col;
}
function stepLeft(text: string | undefined, col: number): number { return snapCol(text, col - 1); }
function stepRight(text: string | undefined, col: number): number {
  return text && col < text.length - 1 && isHighSurrogate(text.charCodeAt(col)) && isLowSurrogate(text.charCodeAt(col + 1)) ? col + 2 : col + 1;
}

/** New head for a movement key (the caller decides what the anchor does). `lenOf` gives a cached line's editable
 *  length (min(len, BIG_LONG_LINE)), or undefined when the line isn't cached: then `col` is kept, or is
 *  BIG_LONG_LINE where the move means "the end of the line", and the caller clamps after fetching. `textOf`
 *  gives a cached line's text so columns skip whole surrogate pairs. `goal` is the remembered column for
 *  vertical moves (pass null to start one); horizontal moves, Home and End return null. */
function bigMove(head: DocPos, key: string, mods: BigMods, lines: number, page: number, goal: number | null,
  lenOf: (line: number) => number | undefined, textOf?: (line: number) => string | undefined): { head: DocPos; goal: number | null } {
  const to = (line: number, col: number, g: number | null = null) => ({ head: { line, col }, goal: g });
  const lastLine = Math.max(0, lines - 1);
  const endOf = (line: number) => snapCol(textOf?.(line), lenOf(line) ?? BIG_LONG_LINE);
  const { line, col } = head;
  switch (key) {
    case 'ArrowLeft':
      if (col > 0) return to(line, stepLeft(textOf?.(line), col));
      return line > 0 ? to(line - 1, endOf(line - 1)) : to(line, 0);
    case 'ArrowRight': {
      const len = lenOf(line);
      if (len !== undefined && col >= len) return line < lastLine ? to(line + 1, 0) : to(line, len);
      const next = stepRight(textOf?.(line), col);
      return to(line, len === undefined ? next : Math.min(next, len));
    }
    case 'Home': return mods.ctrl ? to(0, 0) : to(line, 0);
    case 'End': return mods.ctrl ? to(lastLine, endOf(lastLine)) : to(line, endOf(line));
    case 'ArrowUp': case 'ArrowDown': case 'PageUp': case 'PageDown': {
      const rows = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : key === 'PageUp' ? -page : page;
      const g = goal ?? col, target = line + rows;
      if (target < 0) return to(0, 0, g);
      if (target > lastLine) return to(lastLine, endOf(lastLine), g);
      const len = lenOf(target);
      return to(target, len === undefined ? g : snapCol(textOf?.(target), Math.min(g, len)), g);
    }
  }
  return to(line, col, goal);
}

/** The last Find Next / Previous hit, as the engine reported it, with the query it was for and the selection the
 *  surface showed for it (setSelection clamps a hit past a cut line's BIG_LONG_LINE to that column). */
interface BigFindMemo { query: string; matchCase: boolean; hit: { line: number; col: number; len: number }; anchor: DocPos; head: DocPos }

/** Where Find Next (dir 1) or Previous (dir -1) searches from. Normally the selection's end (start). But while the
 *  selection is still exactly the one the last hit left, for the same query and case, it is that hit's real end
 *  (start): a hit past the cut shows clamped, and searching from the clamped spot would find the same hit again. */
function bigFindFrom(anchor: DocPos, head: DocPos, dir: 1 | -1, query: string, matchCase: boolean, memo: BigFindMemo | null): DocPos {
  const same = !!memo && memo.query === query && memo.matchCase === matchCase
    && posCmp(memo.anchor, anchor) === 0 && posCmp(memo.head, head) === 0;
  if (same) {
    const h = memo!.hit;
    return dir === 1 ? { line: h.line, col: h.col + h.len } : { line: h.line, col: h.col };
  }
  return dir === 1 ? posMax(anchor, head) : posMin(anchor, head);
}
