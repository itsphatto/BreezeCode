/* ================= Editor core: pure position logic (no DOM) ================= */
// Shared global scope with the breeze/ files: no imports or exports here.
interface Sel { anchor: number; head: number }
type NavKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End' | 'PageUp' | 'PageDown';

// (lastIndexOf clamps -1 to 0, so offset 0 would find a leading '\n' and say line 2.)
const lineStart = (v: string, pos: number) => (pos > 0 ? v.lastIndexOf('\n', pos - 1) + 1 : 0);
const lineEnd = (v: string, pos: number) => { const i = v.indexOf('\n', pos); return i === -1 ? v.length : i; };
// The line starts of the last two texts asked about, so the open file's lines are found once per edit, not per
// call. Two, because mid-edit the buffer still has the text from before while the editor surface has the new one.
let lineMemo = { text: '', starts: [0] }, lineMemoOld = lineMemo;
function lineStartsOf(text: string): number[] {
  if (lineMemo.text === text) return lineMemo.starts;
  if (lineMemoOld.text === text) [lineMemo, lineMemoOld] = [lineMemoOld, lineMemo];
  else rememberLineStarts(text, lineStarts(text));
  return lineMemo.starts;
}
function visualCol(lineText: string, col: number): number {
  let v = 0;
  for (let i = 0; i < col; i++) v = lineText[i] === '\t' ? v + 4 - (v % 4) : v + 1;
  return v;
}
function lineStarts(text: string): number[] {
  const s = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) s.push(i + 1);
  return s;
}
// What changed from `a` to `b`, as one edit in `a`'s offsets: the span between their shared start and end.
// Compared in chunks first, so a big file's unchanged parts are skipped quickly.
interface TextEdit { start: number; end: number; text: string }
function textEdit(a: string, b: string): TextEdit {
  const n = Math.min(a.length, b.length);
  let p = 0;
  for (const step of [65536, 4096, 256]) while (p + step <= n && a.slice(p, p + step) === b.slice(p, p + step)) p += step;
  while (p < n && a[p] === b[p]) p++;
  let s = 0;
  const most = n - p;
  for (const step of [65536, 4096, 256]) while (s + step <= most && a.slice(a.length - s - step, a.length - s) === b.slice(b.length - s - step, b.length - s)) s += step;
  while (s < most && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { start: p, end: a.length - s, text: b.slice(p, b.length - s) };
}
const applyEdit = (t: string, e: TextEdit) => t.slice(0, e.start) + e.text + t.slice(e.end);

// The line starts after replacing [start, end) with `text`, from the ones before, without rescanning the file.
// A new array: the old one may still belong to a cached copy of the old text.
function shiftLineStarts(starts: number[], start: number, end: number, text: string): number[] {
  const delta = text.length - (end - start);
  const a = lineOfOffset(starts, start) + 1; // first start after the edit begins
  let b = a;
  while (b < starts.length && starts[b] <= end) b++; // starts inside the replaced span go
  const out = starts.slice(0, a);
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) out.push(start + i + 1);
  for (let i = b; i < starts.length; i++) out.push(starts[i] + delta);
  return out;
}
// Lets the editor surface hand over line starts it already has, so the same text isn't scanned twice.
function rememberLineStarts(text: string, starts: number[]): void {
  if (lineMemo.text !== text) lineMemoOld = lineMemo;
  lineMemo = { text, starts };
}
function lineOfOffset(starts: number[], off: number): number {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
  return lo;
}

// The char index in a line whose visual column is nearest `vcol` (ties go left), never inside a surrogate pair.
function colAtVisual(lineText: string, vcol: number): number {
  let best = 0, bestDist = Math.abs(vcol), v = 0;
  for (let i = 0; i < lineText.length && v < vcol; i++) {
    v = lineText[i] === '\t' ? v + 4 - (v % 4) : v + 1;
    const c = lineText.charCodeAt(i), next = lineText.charCodeAt(i + 1);
    if (c >= 0xD800 && c < 0xDC00 && next >= 0xDC00 && next < 0xE000) continue;
    const d = Math.abs(vcol - v);
    if (d < bestDist) { best = i + 1; bestDist = d; }
  }
  return best;
}

// One char left of `off`, stepping over a whole surrogate pair.
function prevChar(text: string, off: number): number {
  if (off <= 0) return 0;
  const lo = text.charCodeAt(off - 1), hi = text.charCodeAt(off - 2);
  return lo >= 0xDC00 && lo < 0xE000 && hi >= 0xD800 && hi < 0xDC00 ? off - 2 : off - 1;
}
// One char right of `off`, stepping over a whole surrogate pair.
function nextChar(text: string, off: number): number {
  if (off >= text.length) return text.length;
  const hi = text.charCodeAt(off), lo = text.charCodeAt(off + 1);
  return hi >= 0xD800 && hi < 0xDC00 && lo >= 0xDC00 && lo < 0xE000 ? off + 2 : off + 1;
}

const isWordCh = (c: string) => /[\w$]/.test(c);
const isBlankCh = (c: string) => c === ' ' || c === '\t';
// The next word stop to the right: a newline is one step; else skip blanks, then one word or punctuation run.
function wordRight(text: string, off: number): number {
  if (text[off] === '\n') return off + 1;
  let i = off;
  while (i < text.length && isBlankCh(text[i])) i++;
  if (i >= text.length || text[i] === '\n') return i;
  const word = isWordCh(text[i]);
  while (i < text.length && text[i] !== '\n' && !isBlankCh(text[i]) && isWordCh(text[i]) === word) i++;
  return i;
}
// The next word stop to the left, mirroring wordRight.
function wordLeft(text: string, off: number): number {
  if (text[off - 1] === '\n') return off - 1;
  let i = off;
  while (i > 0 && isBlankCh(text[i - 1])) i--;
  if (i <= 0 || text[i - 1] === '\n') return i;
  const word = isWordCh(text[i - 1]);
  while (i > 0 && text[i - 1] !== '\n' && !isBlankCh(text[i - 1]) && isWordCh(text[i - 1]) === word) i--;
  return i;
}

// The run (word, punctuation or whitespace) under `off`; blank space after a word or the end of the text picks the word before it.
function wordAt(text: string, off: number): [number, number] {
  off = Math.max(0, Math.min(off, text.length));
  const kind = (c: string) => isWordCh(c) ? 0 : isBlankCh(c) ? 1 : c === '\n' ? 2 : 3;
  let at = off;
  if (off >= text.length || kind(text[off]) === 1 || kind(text[off]) === 2) {
    if (off > 0 && (off >= text.length || kind(text[off]) === 1) && kind(text[off - 1]) === 0) at = off - 1;
    else if (off >= text.length) at = off - 1;
  }
  if (at < 0 || at >= text.length) return [off, off];
  const k = kind(text[at]);
  if (k === 2) return [at, at + 1];
  let a = at, b = at + 1;
  while (a > 0 && kind(text[a - 1]) === k) a--;
  while (b < text.length && kind(text[b]) === k) b++;
  return [a, b];
}

// Where a navigation key takes the caret. `goal` is the visual column vertical moves aim for; horizontal moves reset it.
function moveCaret(text: string, starts: number[], sel: Sel, key: NavKey, mods: { shift: boolean; ctrl: boolean }, page: number, goal: number | null): { sel: Sel; goal: number | null } {
  const { head } = sel, lo = Math.min(sel.anchor, head), hi = Math.max(sel.anchor, head);
  const done = (to: number, g: number | null) => ({ sel: { anchor: mods.shift ? sel.anchor : to, head: to }, goal: g });
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const left = key === 'ArrowLeft';
    if (!mods.shift && lo !== hi && !mods.ctrl) return done(left ? lo : hi, null);
    const to = mods.ctrl ? (left ? wordLeft(text, head) : wordRight(text, head)) : (left ? prevChar(text, head) : nextChar(text, head));
    return done(to, null);
  }
  const line = lineOfOffset(starts, head), ls = starts[line], le = lineEnd(text, ls);
  if (key === 'Home' || key === 'End') {
    if (mods.ctrl) return done(key === 'Home' ? 0 : text.length, null);
    if (key === 'End') return done(le, null);
    let first = ls;
    while (first < le && isBlankCh(text[first])) first++;
    return done(head === first ? ls : first, null);
  }
  const rows = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : key === 'PageUp' ? -page : page;
  const g = goal ?? visualCol(text.slice(ls, le), head - ls);
  const target = line + rows;
  if (target < 0) return done(0, g);
  if (target >= starts.length) return done(text.length, g);
  const ts = starts[target];
  return done(ts + colAtVisual(text.slice(ts, lineEnd(text, ts)), g), g);
}

// The range a Backspace or Delete removes: the selection, else one char (or one word with ctrl).
function deleteSpan(text: string, sel: Sel, key: 'Backspace' | 'Delete', ctrl: boolean): [number, number] {
  const { head } = sel;
  if (sel.anchor !== head) return [Math.min(sel.anchor, head), Math.max(sel.anchor, head)];
  if (key === 'Backspace') return [ctrl ? wordLeft(text, head) : prevChar(text, head), head];
  return [head, ctrl ? wordRight(text, head) : nextChar(text, head)];
}

/* ----- Closing tags ----- */
const VOID_HTML = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
// The innermost element still open at `pos`, as it was written, or null (also inside a comment).
// Void and self-closing tags never open; in HTML the body of <script> and <style> is raw text.
function openTagAt(text: string, pos: number, xml: boolean): string | null {
  const re = /<!--[\s\S]*?(?:-->|$)|<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  const stack: { name: string; written: string }[] = [];
  for (let m = re.exec(text); m && m.index < pos; m = re.exec(text)) {
    const comment = m[0].startsWith('<!--');
    if (comment && (m.index + m[0].length > pos || !m[0].endsWith('-->'))) return null;
    if (m.index + m[0].length > pos) break; // a tag still being typed at the caret
    if (comment) continue;
    const name = xml ? m[2] : m[2].toLowerCase();
    if (m[1]) {
      const at = stack.map(s => s.name).lastIndexOf(name);
      if (at !== -1) stack.length = at; // anything opened after it was left open
    } else if (!m[3].endsWith('/') && (xml || !VOID_HTML.has(name))) {
      stack.push({ name, written: m[2] });
      if (!xml && (name === 'script' || name === 'style')) {
        const close = text.slice(re.lastIndex, pos).search(new RegExp(String.raw`</${name}\b`, 'i'));
        if (close === -1) return m[2];
        re.lastIndex += close;
      }
    }
  }
  return stack.at(-1)?.written ?? null;
}

/* ----- Fuzzy matching ----- */
// Case-insensitive subsequence match of `query` in `label`, or null. `hits` are the matched indices.
// Scores +1 per hit, +5 for one right after the previous hit, +8 for one at a word start.
function fuzzyScore(label: string, query: string): { score: number; hits: number[] } | null {
  const q = query.toLowerCase();
  const eq = (i: number, j: number) => label[i].toLowerCase() === q[j];
  const wordStart = (i: number) => i === 0 || ' :.-_/'.includes(label[i - 1]) ||
    (label[i - 1] !== label[i - 1].toUpperCase() && label[i] !== label[i].toLowerCase());
  // The latest index each query char may take while the rest of the query still fits after it.
  const limit: number[] = [];
  let left = q.length;
  for (let i = label.length - 1; i >= 0 && left > 0; i--) if (eq(i, left - 1)) limit[--left] = i;
  if (left) return null;
  const hits: number[] = [];
  let score = 0;
  for (let j = 0, from = 0; j < q.length; j++) {
    let at = -1;
    for (let i = from; i <= limit[j] && at < 0; i++) if (wordStart(i) && eq(i, j)) at = i; // a word start first,
    for (let i = from; i <= limit[j] && at < 0; i++) if (eq(i, j)) at = i; // else any occurrence
    score += 1 + (j && at === from ? 5 : 0) + (wordStart(at) ? 8 : 0);
    hits.push(at);
    from = at + 1;
  }
  return { score, hits };
}

/* ----- Emmet ----- */
const EMMET_WORDS = new Set(('a div span p ul ol li img input button form table tr td th section header footer nav main article aside ' +
  'h1 h2 h3 h4 h5 h6 label select option textarea script style link meta br hr canvas video audio iframe svg lorem !').split(' '));
const EMMET_CLOSE: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
// The abbreviation ending at `col` of `line`, or null. Markup abbreviations may hold balanced (), [] and {} groups
// (their contents are free text); a bare word must be a known tag. A stylesheet abbreviation must start a declaration.
function emmetAbbrBefore(line: string, col: number, kind: 'markup' | 'stylesheet'): { abbr: string; start: number } | null {
  let start = col;
  if (kind === 'stylesheet') {
    while (start > 0 && /[A-Za-z0-9\-:!#.%]/.test(line[start - 1])) start--;
    const before = line.slice(0, start).trimEnd();
    return start < col && (!before || before.endsWith('{') || before.endsWith(';')) ? { abbr: line.slice(start, col), start } : null;
  }
  // Tags already on the line are off limits, and so is the inside of one still being typed.
  const left = line.slice(0, col);
  let floor = 0;
  for (const m of left.matchAll(/<\/?[A-Za-z][\w:.-]*(?:"[^"]*"|'[^']*'|[^>"'])*>/g)) floor = m.index + m[0].length;
  if (/<[/A-Za-z]/.test(left.slice(floor))) return null;
  while (start > floor) {
    const c = line[start - 1];
    const open = EMMET_CLOSE[c];
    if (open) {
      let depth = 0, i = start - 1;
      for (; i >= floor; i--) {
        if (line[i] === c) depth++;
        else if (line[i] === open && !--depth) break;
      }
      if (i < floor) break;
      start = i;
    } else if (/[A-Za-z0-9.#>+^*$@\-:!_=%]/.test(c)) start--;
    else break;
  }
  const abbr = line.slice(start, col);
  if (!abbr || (!/[.#>+^*[{(:!]/.test(abbr) && !EMMET_WORDS.has(abbr))) return null;
  return { abbr, start };
}

// Lays an expansion out at `indent` and strips its ${N} / ${N:placeholder} fields. The caret goes to the
// lowest-numbered field (so `${0}` when present), or to the end when there is none.
function emmetInsert(expansion: string, indent: string): { text: string; caret: number } {
  const src = expansion.split('\n').join('\n' + indent);
  let text = '', last = 0, caret = -1, best = Infinity;
  for (const m of src.matchAll(/\$\{(\d+)(?::([^}]*))?\}/g)) {
    text += src.slice(last, m.index);
    const n = +m[1];
    if (caret < 0 || n < best) { best = n; caret = text.length; }
    text += m[2] ?? '';
    last = m.index + m[0].length;
  }
  text += src.slice(last);
  return { text, caret: caret < 0 ? text.length : caret };
}

/* ----- Multiple selections ----- */
// Clamped, in document order, with overlapping ranges and carets on the same spot merged into one. A merged
// selection takes the direction of the later one; ranges that only touch stay apart.
function normalizeSels(sels: Sel[], len: number): Sel[] {
  const clamp = (n: number) => Math.max(0, Math.min(n, len));
  const rs = sels.map(s => ({ lo: clamp(Math.min(s.anchor, s.head)), hi: clamp(Math.max(s.anchor, s.head)), back: s.head < s.anchor }));
  rs.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  const out: typeof rs = [];
  for (const r of rs) {
    const prev = out[out.length - 1];
    if (prev && (r.lo < prev.hi || (r.lo === prev.hi && r.lo === r.hi && prev.lo === prev.hi))) {
      prev.hi = Math.max(prev.hi, r.hi);
      prev.back = r.back;
    } else out.push({ ...r });
  }
  return out.map(r => r.back ? { anchor: r.hi, head: r.lo } : { anchor: r.lo, head: r.hi });
}

// All the edits at once, in one pass. `edits` are sorted and don't overlap; caret i ends up after edit i's text.
function applyEdits(text: string, edits: TextEdit[]): { text: string; carets: number[] } {
  let out = '', last = 0, delta = 0;
  const carets: number[] = [];
  for (const e of edits) {
    out += text.slice(last, e.start) + e.text;
    last = e.end;
    carets.push(e.start + delta + e.text.length);
    delta += e.text.length - (e.end - e.start);
  }
  return { text: out + text.slice(last), carets };
}

// A navigation key for every selection; cursors that land on each other become one.
function moveSels(text: string, starts: number[], sels: Sel[], key: NavKey, mods: { shift: boolean; ctrl: boolean }, page: number): Sel[] {
  return normalizeSels(sels.map(s => moveCaret(text, starts, s, key, mods, page, null).sel), text.length);
}

// The next place to add a cursor (Ctrl+D): the word under the last-added caret, else the next copy of the text
// it has selected, wrapping round and passing over copies already selected. null when there are none left.
function nextOccurrence(text: string, sels: Sel[]): Sel | null {
  const last = sels[sels.length - 1];
  if (!last) return null;
  const lo = Math.min(last.anchor, last.head), hi = Math.max(last.anchor, last.head);
  if (lo === hi) {
    const [a, b] = wordAt(text, hi);
    return a === b ? null : { anchor: a, head: b };
  }
  const needle = text.slice(lo, hi), taken = sels.filter(s => s.anchor !== s.head);
  const free = (p: number) => !taken.some(s => p < Math.max(s.anchor, s.head) && p + needle.length > Math.min(s.anchor, s.head));
  for (const [from, wrapped] of [[hi, false], [0, true]] as const)
    for (let p = text.indexOf(needle, from); p !== -1 && !(wrapped && p >= hi); p = text.indexOf(needle, p + needle.length))
      if (free(p)) return { anchor: p, head: p + needle.length };
  return null;
}

// Every copy of `needle` (Ctrl+Shift+L), not overlapping each other, case-sensitive.
function allOccurrences(text: string, needle: string): Sel[] {
  const out: Sel[] = [];
  if (!needle) return out;
  for (let p = text.indexOf(needle); p !== -1; p = text.indexOf(needle, p + needle.length)) out.push({ anchor: p, head: p + needle.length });
  return out;
}

// What each of `n` cursors pastes: one line each when the clipboard has exactly n lines, else all of it to each.
// (A lone cursor always gets the clipboard whole, so a copied line keeps its newline.)
function splitPaste(clip: string, n: number): string[] {
  if (n > 1) {
    const lines = clip.replace(/\r?\n$/, '').split(/\r?\n/);
    if (lines.length === n) return lines;
  }
  return Array.from({ length: n }, () => clip);
}

// The cursors of a box drag: one per line between the two corners, each from the `from` visual column to the `to`
// one, cut short where a line is shorter. The anchor is on the `from` side, so a leftward drag selects backward.
function columnSels(text: string, starts: number[], fromLine: number, fromVcol: number, toLine: number, toVcol: number): Sel[] {
  const top = Math.max(0, Math.min(fromLine, toLine)), bottom = Math.min(starts.length - 1, Math.max(fromLine, toLine));
  const out: Sel[] = [];
  for (let l = top; l <= bottom; l++) {
    const ls = starts[l], line = text.slice(ls, lineEnd(text, ls));
    out.push({ anchor: ls + colAtVisual(line, fromVcol), head: ls + colAtVisual(line, toVcol) });
  }
  return out;
}
