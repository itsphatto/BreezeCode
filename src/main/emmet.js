// Emmet abbreviation expansion. Fields come back as ${N} / ${N:placeholder} so the editor can turn them into tab stops.
const { default: expand } = require('emmet');

const STYLESHEET = new Set(['css', 'scss', 'less']);
const field = (index, placeholder) => (placeholder ? '${' + index + ':' + placeholder + '}' : '${' + index + '}');

function expandAbbr(abbr, syntax) {
  if (typeof abbr !== 'string' || !abbr) return null;
  try {
    const out = expand(abbr, {
      syntax,
      type: STYLESHEET.has(syntax) ? 'stylesheet' : 'markup',
      options: { 'output.field': field },
    });
    return out && out !== abbr ? out : null;
  } catch {
    return null;
  }
}

module.exports = { expandAbbr };
