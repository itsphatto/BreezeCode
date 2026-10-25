/* ================= Editor core: pure position logic (no DOM) ================= */
// Shared global scope with the breeze/ files: no imports or exports here.
interface Sel { anchor: number; head: number }
type NavKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End' | 'PageUp' | 'PageDown';

// (lastIndexOf clamps -1 to 0, so offset 0 would find a leading '\n' and say line 2.)
const lineStart = (v: string, pos: number) => (pos > 0 ? v.lastIndexOf('\n', pos - 1) + 1 : 0);
const lineEnd = (v: string, pos: number) => { const i = v.indexOf('\n', pos); return i === -1 ? v.length : i; };
// The line starts of the last text asked about, so the open file's lines are found once per edit, not per call.
let lineMemo = { text: '', starts: [0] };
function lineStartsOf(text: string): number[] {
  if (lineMemo.text !== text) lineMemo = { text, starts: lineStarts(text) };
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
