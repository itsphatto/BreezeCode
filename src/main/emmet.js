// Emmet abbreviation expansion. Fields come back as ${N} / ${N:placeholder} so the editor can turn them into tab stops.
const { default: expand } = require('emmet');

const STYLESHEET = new Set(['css', 'scss', 'less']);
const field = (index, placeholder) => (placeholder ? '${' + index + ':' + placeholder + '}' : '${' + index + '}');

// Emmet runs synchronously in main, so a huge snippet would freeze the whole app. The product of every `*N` in the
// abbreviation over-estimates how many elements it builds (siblings are counted as if nested); above MAX_REPEAT it
// isn't expanded at all; nor is lorem text over MAX_WORDS in all, and output over MAX_OUT is dropped.
const MAX_REPEAT = 1000;
const MAX_WORDS = 20000;
const MAX_OUT = 100 * 1024;
function tooBig(abbr) {
  let repeats = 1;
  for (const m of abbr.matchAll(/\*\s*(\d+)/g)) {
    repeats *= Math.max(1, Number(m[1]));
    if (repeats > MAX_REPEAT) return true;
  }
  let words = repeats;
  for (const m of abbr.matchAll(/(?:lorem|lipsum)[a-z]*(\d+)/gi)) {
    words *= Math.max(1, Number(m[1]));
    if (words > MAX_WORDS) return true;
  }
  return false;
}

function expandAbbr(abbr, syntax) {
  if (typeof abbr !== 'string' || !abbr) return null;
  if (tooBig(abbr)) return null;
  try {
    const out = expand(abbr, {
      syntax,
      type: STYLESHEET.has(syntax) ? 'stylesheet' : 'markup',
      options: { 'output.field': field },
    });
    if (out && out.length > MAX_OUT) return null;
    return out && out !== abbr ? out : null;
  } catch {
    return null;
  }
}

module.exports = { expandAbbr };
