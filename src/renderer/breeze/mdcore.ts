// Pure Markdown helpers for agent replies (md() in agents.ts). No DOM, no globals from other files.

type MdPart = { text: string } | { info: string; code: string };

// Splits a reply into text and fenced code blocks. A fence is ``` at the start of a line (up to 3 spaces in front), as
// in Markdown: backticks in the middle of a sentence are text. An unclosed fence (the reply was cut off) still counts.
function splitFences(text: string): MdPart[] {
  const out: MdPart[] = [];
  const open = /^ {0,3}```([^`]*)$/, close = /^ {0,3}```\s*$/;
  let textStart = 0, info: string | null = null, codeStart = 0;
  for (let at = 0; at <= text.length;) {
    let end = text.indexOf('\n', at);
    if (end < 0) end = text.length;
    const line = text.slice(at, end);
    if (info === null) {
      const m = open.exec(line);
      if (m) {
        if (at > textStart) out.push({ text: text.slice(textStart, at) });
        info = m[1].trim();
        codeStart = end + 1;
      }
    } else if (close.test(line)) {
      out.push({ info, code: text.slice(codeStart, Math.max(codeStart, at - 1)) });
      info = null;
      textStart = end;
    }
    at = end + 1;
  }
  if (info !== null) out.push({ info, code: text.slice(Math.min(codeStart, text.length)).replace(/\n$/, '') });
  else if (textStart < text.length) out.push({ text: text.slice(textStart) });
  return out;
}

// Inline code in text that is already HTML-escaped: `x`, or ``a`b`` and ``` x ``` (a run of backticks closed by a run
// of the same length, on one line), as Markdown reads them. The text inside is trimmed.
function codeSpans(escaped: string): string {
  return escaped.replace(/(?<!`)(`+)(?!`)([^\n]*?[^`\n][^\n]*?)(?<!`)\1(?!`)/g, (_m: string, _ticks: string, code: string) => `<code>${code.trim()}</code>`);
}

// **bold** __bold__ *italic* _italic_ ~~struck~~ in text that is already HTML-escaped, on one line each. A mark needs a
// letter next to it on the inside ("2 * 3 * 4" and "* item" stay), _ inside a word is a letter (snake_case), and text in
// <code> is left alone. `keep`: the marks stay, each in a .md-mk span and the text between in .md-t (a line-through
// can't be taken off a child, so it goes on the text alone), styled by classes (the prompt's layer, mentions.ts, must
// keep every character the textarea has).
const EMPHASIS: [RegExp, string, string][] = [
  [/\*\*([^\s*](?:[^*\n]*?[^\s*])?)\*\*/g, '**', 'b'],
  [/(?<!\w)__([^\s_](?:[^_\n]*?[^\s_])?)__(?!\w)/g, '__', 'b'],
  [/(?<![*\w])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?![*\w])/g, '*', 'i'],
  [/(?<!\w)_([^\s_](?:[^_\n]*?[^\s_])?)_(?!\w)/g, '_', 'i'],
  [/~~([^\s~](?:[^~\n]*?[^\s~])?)~~/g, '~~', 's'],
];
function emphasis(escaped: string, keep = false): string {
  return escaped.split(/(<code>[\s\S]*?<\/code>)/).map((part, i) => i % 2 ? part : EMPHASIS.reduce((s, [re, mk, tag]) => s.replace(re, keep
    ? `<span class="md-${tag}"><span class="md-mk">${mk}</span><span class="md-t">$1</span><span class="md-mk">${mk}</span></span>`
    : `<${tag}>$1</${tag}>`), part)).join('');
}

/* ----- Edit Manually in a Markdown file's preview (preview.ts) ----- */
// The page shows the Markdown rendered, so its text is found in the file by the words themselves. Each change carries
// `nth`: how many times its old text showed in the page before it, which picks the copy in the file.
// shortcut: words the file holds but the page doesn't show (a link's address, a comment) shift that count, and a
// change spanning formatting ("**a** b" edited as "a b") isn't found; a source-mapped renderer would fix both.
type MdChange = { from: string; to: string; nth?: number };
const mdEscape = (s: string): string => s.replace(/[\\`*_[\]<]/g, c => `\\${c}`);
// Where `find` starts each non-overlapping time it shows in `s`.
function mdOccurrences(s: string, find: string): number[] {
  const out: number[] = [];
  for (let at = s.indexOf(find); at >= 0 && find; at = s.indexOf(find, at + find.length)) out.push(at);
  return out;
}
// The Markdown with every change written in, or null when one can't be placed.
function applyMdEdit(src: string, changes: MdChange[]): string | null {
  if (!changes.length || changes.some(c => !c.from)) return null;
  const edits: { at: number; len: number; text: string }[] = [];
  for (const c of changes) {
    let escaped = false, hits = mdOccurrences(src, c.from);
    if (!hits.length) { escaped = true; hits = mdOccurrences(src, mdEscape(c.from)); }
    const n = c.nth ?? 0;
    const at = n < hits.length ? hits[n] : hits.length === 1 ? hits[0] : -1;
    if (at < 0) return null;
    if (escaped) { edits.push({ at, len: mdEscape(c.from).length, text: mdEscape(c.to) }); continue; }
    // Only what was typed is escaped: the rest stays as the file wrote it ("snake_case" keeps its bare underscore).
    let p = 0, e = 0;
    while (p < c.from.length && p < c.to.length && c.from[p] === c.to[p]) p++;
    while (e < c.from.length - p && e < c.to.length - p && c.from[c.from.length - 1 - e] === c.to[c.to.length - 1 - e]) e++;
    edits.push({ at: at + p, len: c.from.length - p - e, text: mdEscape(c.to.slice(p, c.to.length - e)) });
  }
  edits.sort((a, b) => b.at - a.at);
  let out = src;
  for (let i = 0; i < edits.length; i++) {
    const d = edits[i];
    if (i && d.at + d.len > edits[i - 1].at) return null; // two changes landed on the same text
    out = out.slice(0, d.at) + d.text + out.slice(d.at + d.len);
  }
  return out;
}
// A fenced block that shows live in the chat (an artifact): a whole HTML page, an SVG drawing or a Mermaid diagram.
// `lang` is the fence's first word, `name` the file it saves as. A snippet of HTML stays plain code.
function artifactKind(lang: string, name: string, code: string): 'html' | 'svg' | 'mermaid' | '' {
  const l = lang.toLowerCase(), n = name.toLowerCase();
  if ((l === 'mermaid' || /\.mmd$/.test(n)) && code.trim()) return 'mermaid';
  if ((l === 'html' || /\.html?$/.test(n)) && /<(?:!doctype|html|body)\b/i.test(code)) return 'html';
  if ((l === 'svg' || l === 'xml' || n.endsWith('.svg')) && /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg\b/i.test(code)) return 'svg';
  return '';
}
// The line (from 0) an element's text starts on in the Markdown, by as many of its first words as the file has
// together (formatting splits them), or null.
function mdSourceLine(src: string, text: string): number | null {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').slice(0, 12);
  for (let k = words.length; k > 0; k--) {
    const find = words.slice(0, k).join(' ');
    if (find.length < 3) break;
    const at = src.indexOf(find);
    if (at >= 0) return src.slice(0, at).split('\n').length - 1;
  }
  return null;
}
