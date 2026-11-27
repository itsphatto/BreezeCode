// Pure matching and ranking for autofill.ts: which words fit what was typed, and in what order. No DOM, no globals
// from other files.

// A word as the code editor counts them: a letter, _ or $, then two or more of those, digits or -.
const WORD_RE = /[A-Za-z_$][\w$-]{2,}/g;

const isUpper = (c: string) => c >= 'A' && c <= 'Z';
const isLower = (c: string) => c >= 'a' && c <= 'z';
const isDigit = (c: string) => c >= '0' && c <= '9';
const isJoiner = (c: string) => c === '_' || c === '-' || c === '$' || c === '.';

// Where a word's parts start: its first letter, a capital after a small letter or digit (userName), the last capital of
// a run that goes on in small letters (HTMLElement → H, E), the first digit of a number, and whatever follows _ - $ or .
function partStarts(word: string): boolean[] {
  return Array.from(word, (c, i) => {
    if (i === 0) return true;
    const p = word[i - 1], n = word[i + 1] ?? '';
    if (isJoiner(c)) return false;
    if (isJoiner(p)) return true;
    return isUpper(c) ? isLower(p) || isDigit(p) || (isUpper(p) && isLower(n)) : isDigit(c) && !isDigit(p);
  });
}

const runsIn = (marks: number[]) => marks.filter((m, i) => i === 0 || m !== marks[i - 1] + 1).length;

// How `typed` fits `word`. Tier 0: it starts the word exactly; 1: in another case; 2: its letters pick out the word's
// parts from the first one on (gebi → getElementById, ael → addEventListener); 3: from a later part (name → userName).
// For tiers 2 and 3 each typed letter starts a part or follows the one before it, so a typo never fits. `marks` are the
// matched letters, for bolding. Null when it doesn't fit.
function matchWord(typed: string, word: string): { tier: number; marks: number[] } | null {
  const t = typed.toLowerCase(), w = word.toLowerCase();
  if (w.startsWith(t)) return { tier: word.startsWith(typed) ? 0 : 1, marks: Array.from(t, (_, i) => i) };
  if (t.length < 2) return null;
  let k = 0;
  for (const c of w) if (c === t[k]) k++;
  if (k < t.length) return null; // not even in order: most words stop here
  const starts = partStarts(word), memo = new Map<number, number[] | null>();
  // Marks for t[i..] with t[i - 1] at `prev`, in the fewest runs (getElementById: "ge" from "get", not "g" + "E").
  const go = (i: number, prev: number): number[] | null => {
    if (i === t.length) return [];
    const key = i * (w.length + 1) + prev + 1;
    if (memo.has(key)) return memo.get(key)!;
    let best: number[] | null = null;
    for (let j = prev + 1; j < w.length; j++) {
      if (w[j] !== t[i] || !(starts[j] || (i > 0 && j === prev + 1))) continue;
      const rest = go(i + 1, j);
      if (rest && (!best || runsIn([j, ...rest]) < runsIn(best))) best = [j, ...rest];
      if (i === 0 && best?.[0] === 0) break; // a fit from the first letter beats any later one
    }
    memo.set(key, best);
    return best;
  };
  const marks = go(0, -1);
  return marks ? { tier: marks[0] === 0 ? 2 : 3, marks } : null;
}

interface Ranked { text: string; tier: number; marks: number[]; weight: number; }
// The best `limit` words for `typed`: by tier, then weight, then the shorter. `picked`, the word taken the last time
// the same was typed, goes first. The typed word itself is no suggestion.
function rankWords(typed: string, weights: Map<string, number>, limit: number, picked?: string): Ranked[] {
  const out: Ranked[] = [];
  for (const [text, weight] of weights) {
    if (text === typed) continue;
    const m = matchWord(typed, text);
    if (m) out.push({ text, tier: text === picked ? -1 : m.tier, marks: m.marks, weight });
  }
  return out.sort((a, b) => a.tier - b.tier || b.weight - a.weight || a.text.length - b.text.length).slice(0, limit);
}

// The words within `reach` characters of `pos`, each with how near its closest use is: 1 at the caret, down to 0 at `reach`.
function nearWords(text: string, pos: number, reach: number): Map<string, number> {
  const out = new Map<string, number>(), from = Math.max(0, pos - reach);
  for (const m of text.slice(from, pos + reach).matchAll(WORD_RE)) {
    const at = from + (m.index ?? 0), d = at > pos ? at - pos : Math.max(0, pos - at - m[0].length);
    out.set(m[0], Math.max(out.get(m[0]) ?? 0, 1 - d / reach));
  }
  return out;
}

// What a textbox's caret is after: the word being typed (two letters at least) or, right after a word and a space, the
// next one; with the one or two words before it. Null where there is nothing to offer: inside a word, in @mentions,
// /commands and #refs (they have their own menus), after a number.
function textboxContext(before: string, after: string): { prefix: string; prev?: string; prev2?: string } | null {
  const m = /(?:^|[^@/#\w'-])(?:(?:([A-Za-z][\w'-]*) )?([A-Za-z][\w'-]*) )?([A-Za-z][\w'-]*)?$/.exec(before);
  if (!m || /^[\w'-]/.test(after)) return null;
  const prefix = m[3] ?? '', prev = m[2], prev2 = m[1];
  if (prefix ? prefix.length < 2 : !prev || !before.endsWith(' ')) return null;
  return { prefix, prev, prev2 };
}

// True when one letter added, dropped, changed or two swapped turns `a` into `b` (teh → the, recieve → receive).
function oneEditApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}
