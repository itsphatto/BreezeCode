// Pure text logic for the next-line hint (autofill.ts): after Enter, the line above again with its numbers counted on,
// `<a class="example1">` → `<a class="example2">`. No DOM, no globals from other files.

const NEXT_LINE_MAX = 400; // longer lines get no guess

interface NumAt { at: number; digits: string; countable: boolean; }

// The runs of digits in a line. Not countable: a heading's tag name (h1), a hex colour (#ff0033) or part of a decimal (0.5).
function numbersIn(line: string): NumAt[] {
  return [...line.matchAll(/\d+/g)].map(m => {
    const at = m.index ?? 0, end = at + m[0].length;
    const before = line.slice(0, at), after = line.slice(end);
    const heading = /<\/?h$/i.test(before);
    const hex = /#[0-9a-f]*$/i.test(before) && /^[0-9a-f]*\b/i.test(after);
    const decimal = /\d\.$/.test(before) || /^\.\d/.test(after);
    return { at, digits: m[0], countable: !heading && !hex && !decimal };
  });
}

// The number as text, as wide as the one it replaces when that one had leading zeros (frame09 → frame10).
function padLike(n: number, like: string): string {
  const s = String(n);
  return like.length > 1 && like.startsWith('0') ? s.padStart(like.length, '0') : s;
}

function withNumbers(line: string, nums: NumAt[], next: (string | null)[]): string {
  let out = '', from = 0;
  nums.forEach((n, i) => {
    out += line.slice(from, n.at) + (next[i] ?? n.digits);
    from = n.at + n.digits.length;
  });
  return out + line.slice(from);
}

// The line to suggest under `above`, or null. With `twoAbove` in the same shape, each number goes on by its own step
// (1, 3 → 5). Without, only a markup line counts: every copy of its last number goes up by one. A single code line
// (`const a = 1;`) is no pattern, so it gets nothing.
function nextLineGuess(above: string, twoAbove: string | null): string | null {
  if (!above.trim() || above.length > NEXT_LINE_MAX) return null;
  const nums = numbersIn(above);
  if (!nums.some(n => n.countable)) return null;
  const shape = (s: string) => s.replace(/\d+/g, '#');
  if (twoAbove != null && twoAbove.length <= NEXT_LINE_MAX && shape(twoAbove) === shape(above)) {
    const prev = numbersIn(twoAbove);
    const steps = nums.map((n, i) => Number(n.digits) - Number(prev[i].digits));
    if (steps.every(s => s === 0)) return null; // the same line twice: no count to go on with
    const next = nums.map((n, i) => steps[i] ? Number(n.digits) + steps[i] : null);
    if (next.some(n => n != null && n < 0)) return null;
    return withNumbers(above, nums, next.map((n, i) => n == null ? null : padLike(n, nums[i].digits)));
  }
  if (!above.trimStart().startsWith('<')) return null;
  const last = nums.filter(n => n.countable).at(-1)!;
  return withNumbers(above, nums, nums.map(n => n.countable && Number(n.digits) === Number(last.digits) ? padLike(Number(n.digits) + 1, n.digits) : null));
}
