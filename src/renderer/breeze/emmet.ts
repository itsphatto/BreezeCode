/* ================= Emmet (Tab expands an abbreviation) ================= */
// The emmet syntax for a buffer's file type, or null when it has none. Main hands anything it doesn't know to the
// markup expander, so only the eight syntaxes it supports may come out of here.
const EMMET_MARKUP: Record<string, string> = { html: 'html', htm: 'html', xhtml: 'html', xml: 'xml', svg: 'xml', jsx: 'jsx', tsx: 'jsx', vue: 'vue', svelte: 'svelte' };
const EMMET_STYLE = new Set(['css', 'scss', 'less']);
function emmetSyntaxOf(b: EditorBuffer): string | null {
  const ext = extOf(b.path);
  return EMMET_MARKUP[ext] ?? (EMMET_STYLE.has(ext) ? ext : null);
}

// The abbreviation right before the caret, or null when Tab should do its usual job.
function emmetCandidate(b: EditorBuffer, ta: CodeSurface): { start: number; end: number; abbr: string; syntax: string } | null {
  const syntax = emmetSyntaxOf(b);
  const v = ta.value, end = ta.selectionStart;
  if (!syntax || end !== ta.selectionEnd || !end) return null;
  const ls = lineStart(v, end);
  if (end - ls > 1000) return null; // a minified line
  const style = EMMET_STYLE.has(syntax);
  const hit = emmetAbbrBefore(v.slice(ls, end), end - ls, style ? 'stylesheet' : 'markup');
  if (!hit) return null;
  const { abbr } = hit;
  // The extractor also returns prose that emmet would turn into junk tags: `end.`, `Hello:`, `1+1`, `3*4`, `a:b`.
  if (!style && (/^\d/.test(abbr) || /[.:+>^]$/.test(abbr))) return null;
  if (syntax === 'jsx' && !EMMET_WORDS.has(/^[^.#>+^*[{(:]*/.exec(abbr)![0])) return null; // `props.items` is code, not a tag
  if (!style && syntax !== 'jsx') {
    // Script and style blocks hold code, not markup.
    const head = v.slice(0, end);
    if (Math.max(head.lastIndexOf('<script'), head.lastIndexOf('<style')) > Math.max(head.lastIndexOf('</script'), head.lastIndexOf('</style'))) return null;
  }
  // Not inside a string or comment, nor (in a stylesheet) in a selector outside any rule.
  const d = highlighted(b);
  if (d.text !== v) return null;
  const kind = d.kinds[lineOfOffset(d.starts, end - 1)];
  if (kind === 'str' || kind === 'com' || (style && kind === 'tag')) return null;
  return { start: ls + hit.start, end, abbr, syntax };
}

// Expands the abbreviation before the caret in place, as one undo step. False when there was nothing to expand.
async function tryEmmet(b: EditorBuffer, ta: CodeSurface): Promise<boolean> {
  const c = emmetCandidate(b, ta);
  if (!c) return false;
  const value = ta.value;
  let expansion: string | null;
  try { expansion = await api.emmet.expand(c.abbr, c.syntax); } catch { return false; }
  // The user kept typing while main worked.
  if (!expansion || ta.value !== value || ta.selectionStart !== c.end || ta.selectionEnd !== c.end) return false;
  const lineFrom = lineStart(value, c.start);
  const indent = /^[ \t]*/.exec(value.slice(lineFrom, c.start))![0];
  // Emmet indents with tabs; the editor indents with INDENT.
  const { text, caret } = emmetInsert(expansion.replace(/^\t+/gm, t => INDENT.repeat(t.length)), indent);
  replaceRange(ta, c.start, c.end, text, c.start + caret, c.start + caret);
  return true;
}

// The expansion of the abbreviation before the caret for the autofill list, asked 120 ms after the last call.
// Null when there is none, or when a newer call or an edit made the answer stale.
let emmetPreviewTimer: TimeoutId | undefined;
let emmetPreviewAsk = 0;
let emmetPreviewDrop: (() => void) | undefined;
function emmetPreview(b: EditorBuffer, ta: CodeSurface): Promise<string | null> {
  const ask = ++emmetPreviewAsk;
  clearTimeout(emmetPreviewTimer);
  emmetPreviewDrop?.(); // the call this one replaces will never reach its timer
  return new Promise(resolve => {
    emmetPreviewDrop = () => resolve(null);
    emmetPreviewTimer = setTimeout(async () => {
      const c = emmetCandidate(b, ta);
      if (!c) { resolve(null); return; }
      const value = ta.value, pos = ta.selectionStart;
      let expansion: string | null = null;
      try { expansion = await api.emmet.expand(c.abbr, c.syntax); } catch { /* no preview */ }
      resolve(ask === emmetPreviewAsk && ta.value === value && ta.selectionStart === pos ? expansion : null);
    }, 120);
  });
}
