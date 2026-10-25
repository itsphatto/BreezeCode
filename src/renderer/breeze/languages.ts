/* ================= Languages & highlighting ================= */
type Tok = [cls: string | null, text: string];
const LANGS: Record<string, [lexer: string, name: string]> = {
  html: ['html', 'HTML'], htm: ['html', 'HTML'], xml: ['html', 'XML'], svg: ['html', 'SVG'], vue: ['html', 'Vue'],
  css: ['css', 'CSS'], scss: ['css', 'SCSS'], less: ['css', 'Less'],
  js: ['js', 'JavaScript'], mjs: ['js', 'JavaScript'], cjs: ['js', 'JavaScript'], jsx: ['js', 'JavaScript JSX'],
  ts: ['js', 'TypeScript'], tsx: ['js', 'TypeScript JSX'], mts: ['js', 'TypeScript'], cts: ['js', 'TypeScript'],
  json: ['json', 'JSON'], jsonc: ['js', 'JSON with Comments'],
  md: ['md', 'Markdown'], markdown: ['md', 'Markdown'],
  py: ['py', 'Python'],
  java: ['java', 'Java'], rs: ['rs', 'Rust'],
  c: ['cpp', 'C'], h: ['cpp', 'C/C++ Header'],
  cpp: ['cpp', 'C++'], cc: ['cpp', 'C++'], cxx: ['cpp', 'C++'], hpp: ['cpp', 'C++ Header'], hh: ['cpp', 'C++ Header'], hxx: ['cpp', 'C++ Header'],
  cs: ['cs', 'C#'], csx: ['cs', 'C# Script'], csproj: ['html', 'C# Project'],
  png: ['', 'PNG Image'], jpg: ['', 'JPEG Image'], jpeg: ['', 'JPEG Image'], gif: ['', 'GIF Image'], webp: ['', 'WebP Image'],
  avif: ['', 'AVIF Image'], bmp: ['', 'Bitmap Image'], ico: ['', 'Icon'],
  gitignore: ['ignore', 'Ignore'], dockerignore: ['ignore', 'Ignore'], npmignore: ['ignore', 'Ignore'],
  prettierignore: ['ignore', 'Ignore'], eslintignore: ['ignore', 'Ignore'], vercelignore: ['ignore', 'Ignore'],
};
const extOf = (path: string) => { const n = baseName(path).toLowerCase(); return n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : ''; };
function langOf(path: string): [lexer: string, name: string] {
  if (baseName(path).toLowerCase().startsWith('.env')) return ['py', 'Environment'];
  return LANGS[extOf(path)] ?? ['', 'Plain Text'];
}

// A lexer is an ordered list of small token patterns, joined into one regex with a named group per kind.
type TokenRule = [kind: string, pattern: RegExp];
const either = (...patterns: RegExp[]) => new RegExp(patterns.map(p => p.source).join('|'));
const lexer = (rules: TokenRule[], flags = 'g') => new RegExp(rules.map(([kind, p]) => `(?<${kind}>${p.source})`).join('|'), flags);
const keywords = (list: string) => new RegExp(String.raw`\b(?:${list.replaceAll(' ', '|')})\b`);
const JS_KW = 'break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return super switch this throw try typeof var void while with yield async await static get set type interface enum implements private public protected readonly declare as true false null undefined';
const CS_KW = 'abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach get goto if implicit in init int interface internal is lock long namespace new null object operator out override params private protected public readonly record ref required return sbyte sealed set short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile when where while with yield';
const JAVA_KW = 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record sealed permits yield true false null';
const RS_KW = 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Some None Result Ok Err Box';
const CPP_KW = 'alignas alignof auto bool break case catch char char8_t char16_t char32_t class const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept nullptr operator private protected public register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while concept override final NULL size_t std string vector';
const PY_KW = 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self';
const LINE_COMMENT = /\/\/[^\n]*/;
const BLOCK_COMMENT = /\/\*[\s\S]*?(?:\*\/|$)/;
const QUOTED = /"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?/;
const BACKTICKED = /`(?:\\[\s\S]|[^`\\])*`?/;
const NUMBER = either(/\b0[xX][\da-fA-F]+\b/, /\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/);
const CALL = /\b[A-Za-z_$][\w$]*(?=\()/;
const LEXERS: Record<string, RegExp> = {
  js: lexer([['com', either(LINE_COMMENT, BLOCK_COMMENT)], ['str', either(QUOTED, BACKTICKED)], ['num', NUMBER], ['kw', keywords(JS_KW)], ['prop', CALL]]),
  css: lexer([
    ['com', BLOCK_COMMENT], ['str', QUOTED], ['kw', /@[\w-]+|!important/],
    // A property is a name followed by ':' and a value ending in ';' or '}' (a:hover { … } reaches '{' first, so it stays a selector).
    ['prop', /(?<![\w-])-{0,2}[A-Za-z_][\w-]*(?=\s*:(?!:)[^;{}]*[;}])/],
    ['num', either(/#[\da-fA-F]{3,8}\b/, /-?\b\d+(?:\.\d+)?(?:%|[a-z]{1,3})?/)],
  ]),
  json: lexer([['prop', /"(?:\\.|[^"\\\n])*"(?=\s*:)/], ['str', /"(?:\\.|[^"\\\n])*"?/], ['num', either(/-/, NUMBER)], ['kw', /\b(?:true|false|null)\b/]]),
  // C#: raw """…""" strings, verbatim/interpolated @"…" $"…" strings, and #region-style directives.
  cs: lexer([
    ['com', either(LINE_COMMENT, BLOCK_COMMENT)], ['kw', /(?<=^|\n)[ \t]*#[a-z]+/],
    ['str', either(/\$*"""[\s\S]*?(?:"""|$)/, /(?:\$@|@\$|@)"(?:""|[^"])*"?/, /\$?"(?:\\.|[^"\\\n])*"?/, /'(?:\\.|[^'\\\n])*'?/)],
    ['num', either(/\b0[xX][\da-fA-F_]+[uUlL]*\b/, /\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[fFdDmMuUlL]*\b/)], ['kw', keywords(CS_KW)], ['prop', /\b[A-Za-z_]\w*(?=\s*[(<])/],
  ]),
  py: lexer([['com', /#[^\n]*/], ['str', either(/"""[\s\S]*?(?:"""|$)/, /'''[\s\S]*?(?:'''|$)/, QUOTED)], ['num', NUMBER], ['kw', keywords(PY_KW)], ['prop', /\b[A-Za-z_]\w*(?=\()/]]),
  // Java: """text blocks""" and @Annotations.
  java: lexer([
    ['com', either(LINE_COMMENT, BLOCK_COMMENT)], ['str', either(/"""[\s\S]*?(?:"""|$)/, QUOTED)], ['attr', /@[A-Za-z_]\w*/],
    ['num', either(/\b0[xXbB][\da-fA-F_]+[lL]?\b/, /\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[fFdDlL]?\b/)], ['kw', keywords(JAVA_KW)], ['prop', CALL],
  ]),
  // Rust: strings may span lines, r#"raw"# strings, 'c' chars but 'lifetimes, #[attributes] and macro! calls.
  rs: lexer([
    ['com', either(LINE_COMMENT, BLOCK_COMMENT)], ['kw', /#!?\[[^\]\n]*\]?/],
    ['str', either(/b?r#"[\s\S]*?(?:"#|$)/, /b?r"[^"]*"?/, /b?"(?:\\[\s\S]|[^"\\])*"?/, /b?'(?:\\[\s\S]|[^\\'\n])'/)],
    ['attr', /'[A-Za-z_]\w*/],
    ['num', either(/\b0[xob][\da-fA-F_]+(?:[iu](?:8|16|32|64|128|size))?\b/, /\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?(?:[iu](?:8|16|32|64|128|size)|f32|f64)?\b/)],
    ['kw', keywords(RS_KW)], ['prop', either(/\b[A-Za-z_]\w*!/, CALL)],
  ]),
  // C/C++: #include/#define directives (with their <header>), R"(raw)" strings, prefixed u8"…" L'…' literals, and digit separators.
  cpp: lexer([
    ['com', either(LINE_COMMENT, BLOCK_COMMENT)], ['kw', /(?<=^|\n)[ \t]*#[ \t]*[a-z]+/],
    ['str', either(/(?<=#[ \t]*(?:include|import)[ \t]*)<[^>\n]*>?/,/(?:u8|[uUL])?R"[^(\s]*\([\s\S]*?(?:\)[^"\s]*"|$)/,/(?:u8|[uUL])?"(?:\\.|[^"\\\n])*"?/, /(?:u8|[uUL])?'(?:\\.|[^'\\\n])*'?/)],
    ['num', either(/\b0[xXbB][\da-fA-F']+[uUlL]*\b/, /\b\d[\d']*(?:\.\d+)?(?:[eE][+-]?\d+)?[fFuUlL]*\b/)], ['kw', keywords(CPP_KW)], ['prop', CALL],
  ]),
  md: lexer([
    ['kw', /(?<=^|\n)#{1,6}[^\n]*/], ['str', either(/```[^`]*(?:```|$)/, /`[^`\n]*`/)], ['com', /(?<=^|\n)>[^\n]*/],
    ['attr', either(/\*\*[^*\n]+\*\*/, /\[[^[\]\n]*\]\([^()\n]*\)/)],
  ]),
  html: lexer([['com', /<!--[\s\S]*?(?:-->|$)/], ['tagblock', /<[!/]?[A-Za-z][^>]*>?/]]),
  // .gitignore and friends: # comments (only at the start of a line), ! negations and * / ** globs.
  ignore: lexer([['com', /(?<=^|\n)[ \t]*#[^\n]*/], ['kw', /(?<=^|\n)!/], ['attr', /\*\*?|\?/]]),
};
const HTML_TAG = lexer([['tag', /^<[!/]?[\w:-]+|\/?>$/], ['str', /"[^"]*"?|'[^']*'?/], ['attr', /[^\s="'<>/]+/]]);

// The named group that matched: the token's kind.
function tokKind(m: RegExpExecArray): string | null {
  const groups = m.groups;
  for (const k in groups) if (groups[k] !== undefined) return k;
  return null;
}
function lex(text: string, re: RegExp): Tok[] {
  const out: Tok[] = [];
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!m[0]) { re.lastIndex++; continue; }
    if (m.index > last) out.push([null, text.slice(last, m.index)]);
    const kind = tokKind(m);
    if (kind === 'tagblock') out.push(...lex(m[0], HTML_TAG)); // lex() resets lastIndex of the inner regex only
    else out.push([kind, m[0]]);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push([null, text.slice(last)]);
  return out;
}
// CSS: plain text outside any { } block is a selector.
function markSelectors(toks: Tok[]): Tok[] {
  let depth = 0;
  const out: Tok[] = [];
  for (const [cls, text] of toks) {
    if (cls) { out.push([cls, text]); continue; }
    for (const part of text.split(/([{}])/)) {
      if (part === '{') depth++;
      else if (part === '}') depth = Math.max(0, depth - 1);
      const selector = depth === 0 && part !== '}' && part.trim() !== '';
      out.push([selector ? 'tag' : null, part]);
    }
  }
  return out;
}
// HTML with its <style> and <script> blocks coloured as CSS and JavaScript (TS/JSX and JSON scripts too).
// Comments come first in the pattern, so a commented-out <script> stays a comment.
const EMBEDDED = /<!--[\s\S]*?(?:-->|$)|(<(style|script)\b[^>]*>)([\s\S]*?)(?=<\/\2\s*>|$)/gi;
function htmlToks(text: string): Tok[] {
  const out: Tok[] = [];
  let last = 0;
  for (const m of text.matchAll(EMBEDDED)) {
    if (!m[1]) continue; // a comment: lexed as HTML with the text around it
    const start = (m.index ?? 0) + m[1].length, inner = m[3];
    out.push(...lex(text.slice(last, start), LEXERS.html));
    const type = (/\b(?:type|lang)\s*=\s*["']?([^"'\s>]+)/i.exec(m[1])?.[1] ?? '').toLowerCase();
    if (m[2].toLowerCase() === 'style') out.push(...markSelectors(lex(inner, LEXERS.css)));
    else if (!type || /javascript|ecmascript|module|babel|jsx|tsx?$|typescript/.test(type)) out.push(...lex(inner, LEXERS.js));
    else if (type.includes('json')) out.push(...lex(inner, LEXERS.json));
    else out.push([null, inner]); // templates and other data blocks stay plain
    last = start + inner.length;
  }
  out.push(...lex(text.slice(last), LEXERS.html));
  return out;
}
// A highlighted document is a flat token stream: token k runs from starts[k] to starts[k + 1] (or the end).
// Lines are turned into HTML only when they are drawn, so a 10,000-line file costs the same as the lines in view.
interface HlDoc { text: string; lexer: string; starts: number[]; kinds: (string | null)[]; lines: number[]; html: (string | undefined)[]; }
type HlToks = Pick<HlDoc, 'starts' | 'kinds'>;
// Every file Breeze opens is coloured (main.js opens up to 5 MB). HTML and CSS past HL_EXACT_MAX are lexed in full
// only once typing pauses, since they can't be re-lexed near an edit.
const HL_MAX = 5 * 1024 * 1024;
const HL_EXACT_MAX = 400000;
function fullToks(text: string, lexerName: string): HlToks {
  const starts: number[] = [], kinds: (string | null)[] = [];
  if (LEXERS[lexerName] && text.length <= HL_MAX) {
    const toks = lexerName === 'html' ? htmlToks(text) : lex(text, LEXERS[lexerName]);
    let at = 0;
    for (const [cls, t] of lexerName === 'css' ? markSelectors(toks) : toks) {
      if (t) { starts.push(at); kinds.push(cls); at += t.length; }
    }
  }
  if (!starts.length) { starts.push(0); kinds.push(null); }
  return { starts, kinds };
}
// Lexers whose tokens depend only on the text around them (not HTML's embedded blocks or CSS's selector depth),
// so an edit is re-lexed from just above it until the tokens fall back in step with the old ones.
const INCREMENTAL = new Set(['js', 'json', 'cs', 'py', 'java', 'rs', 'cpp', 'md', 'ignore']);
// The lengths of the unchanged head and tail of an edit, compared a chunk at a time first (string === is a native compare).
function editSpan(old: string, text: string): [head: number, tail: number] {
  const min = Math.min(old.length, text.length);
  const CH = 2048;
  let p = 0;
  while (p + CH <= min && old.slice(p, p + CH) === text.slice(p, p + CH)) p += CH;
  while (p < min && old.charCodeAt(p) === text.charCodeAt(p)) p++;
  let s = 0;
  while (s + CH <= min - p && old.slice(old.length - s - CH, old.length - s) === text.slice(text.length - s - CH, text.length - s)) s += CH;
  while (s < min - p && old.charCodeAt(old.length - 1 - s) === text.charCodeAt(text.length - 1 - s)) s++;
  return [p, s];
}
// Big HTML and CSS can't be re-lexed near an edit (embedded blocks, selector depth), so while typing the old
// tokens are kept around the edit and moved along with the text after it; the exact colours follow on a pause.
function shiftToks(prev: HlDoc, text: string): HlToks {
  const [p, s] = editSpan(prev.text, text);
  const delta = text.length - prev.text.length, oldEnd = prev.text.length - s;
  const k = lineOfOffset(prev.starts, p);
  const starts = prev.starts.slice(0, k + 1), kinds = prev.kinds.slice(0, k + 1);
  for (let j = lineOfOffset(prev.starts, oldEnd); j < prev.starts.length; j++) {
    const at = Math.max(prev.starts[j], oldEnd) + delta;
    if (at <= starts[starts.length - 1]) { starts.pop(); kinds.pop(); }
    if (at < text.length) { starts.push(at); kinds.push(prev.kinds[j]); }
  }
  if (!starts.length) { starts.push(0); kinds.push(null); }
  return { starts, kinds };
}
function relex(prev: HlDoc, text: string): HlToks {
  const old = prev.text, re = LEXERS[prev.lexer];
  const [p, s] = editSpan(old, text);
  const delta = text.length - old.length;
  // Start two lines above the edit (a lookahead can reach past a line break), at the token found there.
  let from = lineStart(text, p);
  for (let n = 0; n < 2 && from > 0; n++) from = lineStart(text, from - 1);
  const k = lineOfOffset(prev.starts, from), at = prev.starts[k];
  const starts = prev.starts.slice(0, k), kinds = prev.kinds.slice(0, k);
  // Below the line the edit ends on nothing can see it: a token starting where an old one did means the rest is unchanged.
  const settle = lineEnd(text, text.length - s) + 1;
  const push = (kind: string | null, start: number): boolean => {
    if (start >= settle) {
      const j = lineOfOffset(prev.starts, start - delta);
      if (prev.starts[j] === start - delta && prev.kinds[j] === kind) {
        const n = starts.length, rest = prev.starts.length - j;
        starts.length = kinds.length = n + rest;
        for (let i = 0; i < rest; i++) { starts[n + i] = prev.starts[j + i] + delta; kinds[n + i] = prev.kinds[j + i]; }
        return true;
      }
    }
    starts.push(start); kinds.push(kind);
    return false;
  };
  let last = at;
  re.lastIndex = at;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!m[0]) { re.lastIndex++; continue; }
    if (m.index > last && push(null, last)) return { starts, kinds };
    if (push(tokKind(m), m.index)) return { starts, kinds };
    last = m.index + m[0].length;
  }
  if (last < text.length || !starts.length) push(null, last);
  return { starts, kinds };
}
function lineHtmlOf(d: HlDoc, i: number): string {
  const done = d.html[i];
  if (done !== undefined) return done;
  const from = d.lines[i], to = i + 1 < d.lines.length ? d.lines[i + 1] - 1 : d.text.length;
  let h = '';
  for (let k = lineOfOffset(d.starts, from); k < d.starts.length && d.starts[k] < to; k++) {
    const part = d.text.slice(Math.max(d.starts[k], from), Math.min(d.starts[k + 1] ?? to, to));
    if (part) h += d.kinds[k] ? `<span class="tk-${d.kinds[k]}">${esc(part)}</span>` : esc(part);
  }
  return d.html[i] = h;
}
const COMMENT: Record<string, [string, string]> = { js: ['// ', ''], java: ['// ', ''], rs: ['// ', ''], cpp: ['// ', ''], cs: ['// ', ''], py: ['# ', ''], css: ['/* ', ' */'], html: ['<!-- ', ' -->'], md: ['<!-- ', ' -->'] };

/* ================= Syntax checks (red error lines) ================= */
// Quick structural checks that work everywhere: brackets, strings, comments, tags, JSON, Python blocks.
// In the desktop app JavaScript and TypeScript are also compiled by V8 (main.js) for exact errors.
interface RawDiag { at: number; len: number; msg: string; }
interface ScanOpts { lineCom?: string; blockCom?: boolean; quotes: string; template?: boolean; regex?: boolean; triple?: boolean; jsx?: boolean; }
interface Opened { ch: string; at: number; tmpl?: number; }
const LINT_MAX = 400000;
const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = ')]}';
const SPACE = ' \n\t\r';
// A "/" starts a regex (not a division) after an operator, an opening bracket or one of these keywords.
const REGEX_AFTER = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await|instanceof))\s*$/;
const JS_SCAN: ScanOpts = { lineCom: '//', blockCom: true, quotes: `'"`, template: true, regex: true };
const CSS_SCAN: ScanOpts = { blockCom: true, quotes: `'"` };
const PY_SCAN: ScanOpts = { lineCom: '#', quotes: `'"`, triple: true };
const JAVA_SCAN: ScanOpts = { lineCom: '//', blockCom: true, quotes: `'"`, triple: true };
// Rust strings are blanked before the scan (lintRust), so it only checks comments and brackets.
const RS_SCAN: ScanOpts = { lineCom: '//', blockCom: true, quotes: '' };
const neverClosed = (s: Opened): RawDiag =>
  ({ at: s.at, len: 1, msg: s.tmpl == null ? `'${s.ch}' is never closed` : 'Template expression is never closed (missing })' });

// Finds unbalanced brackets and unclosed strings/comments. Also returns the text with comments and
// string contents blanked (same length), so later checks don't trip over them.
class CodeScanner {
  readonly diags: RawDiag[] = [];
  private readonly out: string[] = [];
  private readonly stack: Opened[] = [];
  private i = 0;
  private last = 0;
  private readonly t: string;
  private readonly o: ScanOpts;
  constructor(t: string, o: ScanOpts) { this.t = t; this.o = o; }

  run(): { diags: RawDiag[]; masked: string } {
    while (this.i < this.t.length) this.step();
    for (const s of this.stack) this.diags.push(neverClosed(s));
    this.out.push(this.t.slice(this.last));
    return { diags: this.diags, masked: this.out.join('') };
  }
  // Python joins lines inside strings so a multi-line string reads as one logical line.
  private mask(from: number, to: number): void {
    this.out.push(this.t.slice(this.last, from), this.t.slice(from, to).replace(this.o.triple ? /[^]/g : /[^\n]/g, ' '));
    this.last = to;
  }
  private step(): void {
    const c = this.t[this.i];
    if (SPACE.includes(c)) { this.i++; return; }
    if (this.comment(c) || this.quoted(c) || this.regex(c)) return;
    if (PAIRS[c]) { this.stack.push({ ch: c, at: this.i }); this.i++; return; }
    if (CLOSERS.includes(c)) { this.close(c); return; }
    this.i++;
  }
  private comment(c: string): boolean {
    const { t, o, i } = this;
    if (o.lineCom && t.startsWith(o.lineCom, i) && (o.regex || t[i - 1] !== ':')) {
      const e = lineEnd(t, i);
      this.mask(i, e); this.i = e;
      return true;
    }
    if (!o.blockCom || c !== '/' || t[i + 1] !== '*') return false;
    const e = t.indexOf('*/', i + 2);
    if (e === -1) this.unclosed(i, 2, 'Comment is never closed (missing */)');
    else { this.mask(i, e + 2); this.i = e + 2; }
    return true;
  }
  // The rest of the file was swallowed by something that never ends.
  private unclosed(at: number, len: number, msg: string): void {
    this.diags.push({ at, len, msg });
    this.mask(at + len, this.t.length);
    this.i = this.t.length;
  }
  private quoted(c: string): boolean {
    const { t, o, i } = this;
    if (o.triple && (t.startsWith('"""', i) || t.startsWith("'''", i))) {
      const q = t.slice(i, i + 3), e = t.indexOf(q, i + 3);
      if (e === -1) this.unclosed(i, 3, `String is never closed (missing ${q})`);
      else { this.mask(i + 3, e); this.i = e + 3; }
      return true;
    }
    if (o.template && c === '`') { this.i = this.template(i + 1, i); return true; }
    if (!o.quotes.includes(c)) return false;
    let j = i + 1;
    while (j < t.length && t[j] !== c && t[j] !== '\n') j += t[j] === '\\' ? 2 : 1;
    if (t[j] === c) { this.mask(i + 1, j); this.i = j + 1; return true; }
    if (o.jsx) { this.i++; return true; } // JSX text can hold a lone apostrophe
    this.diags.push({ at: i, len: Math.max(1, j - i), msg: `String is never closed (missing ${c})` });
    this.mask(i + 1, j); this.i = j;
    return true;
  }
  // Continues a template literal from `from` (just after ` or after a ${…}); returns where code resumes.
  private template(from: number, start: number): number {
    const t = this.t;
    for (let j = from; j < t.length; j++) {
      if (t[j] === '\\') j++;
      else if (t[j] === '`') { this.mask(from, j); return j + 1; }
      else if (t[j] === '$' && t[j + 1] === '{') { this.mask(from, j); this.stack.push({ ch: '{', at: j + 1, tmpl: start }); return j + 2; }
    }
    this.diags.push({ at: start, len: 1, msg: 'Template literal is never closed (missing `)' });
    this.mask(from, t.length);
    return t.length;
  }
  private regex(c: string): boolean {
    const { t, i } = this;
    if (!this.o.regex || c !== '/' || !REGEX_AFTER.test(t.slice(Math.max(0, i - 12), i))) return false;
    let j = i + 1, inClass = false;
    while (j < t.length && t[j] !== '\n' && (inClass || t[j] !== '/')) {
      if (t[j] === '\\') j++;
      else if (t[j] === '[') inClass = true;
      else if (t[j] === ']') inClass = false;
      j++;
    }
    if (t[j] !== '/') return false; // a division after all
    this.mask(i + 1, j); this.i = j + 1;
    return true;
  }
  private close(c: string): void {
    if (!this.stack.some(s => PAIRS[s.ch] === c)) {
      this.diags.push({ at: this.i, len: 1, msg: `Unexpected '${c}'` });
      this.i++;
      return;
    }
    // Anything opened after the matching bracket was left open.
    while (PAIRS[this.stack.at(-1)?.ch ?? ''] !== c) this.diags.push(neverClosed(this.stack.pop() as Opened));
    const open = this.stack.pop() as Opened;
    this.i = open.tmpl == null ? this.i + 1 : this.template(this.i + 1, open.tmpl);
  }
}
const scanCode = (t: string, o: ScanOpts) => new CodeScanner(t, o).run();

// A small JSON parser that reports where the first mistake is. `loose` allows comments and trailing commas (tsconfig etc.).
class JsonChecker {
  private i = 0;
  private readonly t: string;
  private readonly loose: boolean;
  constructor(t: string, loose: boolean) { this.t = t; this.loose = loose; }

  check(): RawDiag[] {
    try {
      this.ws();
      if (this.i >= this.t.length) return [];
      this.value();
      this.ws();
      if (this.i < this.t.length) this.fail('Unexpected text after the end of the JSON');
      return [];
    } catch (e) {
      if (e instanceof JsonMistake) return [e.diag];
      throw e;
    }
  }
  private fail(msg: string, at = this.i, len = 1): never { throw new JsonMistake({ at, len, msg }); }
  private get ended() { return this.i >= this.t.length; }
  private ws(): void {
    const t = this.t;
    while (!this.ended) {
      if (SPACE.includes(t[this.i])) this.i++;
      else if (this.loose && t.startsWith('//', this.i)) this.i = lineEnd(t, this.i);
      else if (this.loose && t.startsWith('/*', this.i)) this.skipComment();
      else return;
    }
  }
  private skipComment(): void {
    const e = this.t.indexOf('*/', this.i + 2);
    if (e === -1) this.fail('Comment is never closed (missing */)', this.i, 2);
    this.i = e + 2;
  }
  private str(): void {
    const t = this.t, s = this.i++;
    while (!this.ended && t[this.i] !== '"' && t[this.i] !== '\n') this.i += t[this.i] === '\\' ? 2 : 1;
    if (t[this.i] !== '"') this.fail('String is never closed (missing ")', s, Math.max(1, this.i - s));
    this.i++;
  }
  // The items of an object or array, up to the closing bracket.
  private list(close: string, item: () => void): void {
    this.i++; this.ws();
    if (this.t[this.i] === close) { this.i++; return; }
    for (; ;) {
      item(); this.ws();
      if (this.t[this.i] === close) { this.i++; return; }
      if (this.t[this.i] !== ',') this.fail(this.ended ? `Expected '${close}' but the file ended` : `Expected ',' or '${close}'`);
      const comma = this.i++;
      this.ws();
      if (this.t[this.i] === close) {
        if (!this.loose) this.fail('Trailing commas are not allowed in JSON', comma);
        this.i++;
        return;
      }
    }
  }
  private member(): void {
    this.ws();
    const c = this.t[this.i];
    if (c !== '"') {
      if (this.ended) this.fail('Expected a property name but the file ended');
      this.fail(/['\w$]/.test(c) ? 'Property names need double quotes' : 'Expected a property name');
    }
    this.str(); this.ws();
    if (this.t[this.i] !== ':') this.fail("Expected ':' after the property name");
    this.i++;
    this.value();
  }
  private value(): void {
    this.ws();
    const c = this.t[this.i];
    if (c === '{') { this.list('}', () => this.member()); return; }
    if (c === '[') { this.list(']', () => this.value()); return; }
    if (c === '"') { this.str(); return; }
    const word = ['true', 'false', 'null'].find(w => this.t.startsWith(w, this.i));
    if (word) { this.i += word.length; return; }
    const num = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    num.lastIndex = this.i;
    const hit = num.exec(this.t);
    if (hit) { this.i += hit[0].length; return; }
    if (c === "'") this.fail('Strings need double quotes in JSON');
    this.fail(this.ended ? 'Expected a value but the file ended' : `Unexpected '${c}'`);
  }
}
class JsonMistake extends Error {
  readonly diag: RawDiag;
  constructor(diag: RawDiag) { super(diag.msg); this.diag = diag; }
}

// CSS: every declaration inside a rule needs "property: value", and a ';' before the next one.
function cssDeclMistake(text: string, at: number): RawDiag | null {
  if (!text.includes(':')) return { at, len: text.length, msg: "Expected ':' between the property and its value" };
  const rows = text.split('\n');
  const k = rows.findIndex((r, n) => n < rows.length - 1 && r.includes(':') && /^\s*[-\w]+\s*:/.test(rows[n + 1]));
  return k === -1 ? null : { at: at + rows.slice(0, k + 1).join('\n').length, len: 1, msg: "Missing ';' at the end of this line" };
}
function lintCssDecls(masked: string): RawDiag[] {
  const out: RawDiag[] = [];
  let depth = 0, seg = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c !== '{' && c !== '}' && c !== ';') continue;
    const text = masked.slice(seg, i), s = text.trim();
    const mistake = depth > 0 && c !== '{' && s && !s.startsWith('@') ? cssDeclMistake(s, seg + text.indexOf(s[0])) : null;
    if (mistake) out.push(mistake);
    depth = Math.max(0, depth + (c === '{' ? 1 : 0) - (c === '}' ? 1 : 0));
    seg = i + 1;
  }
  return out;
}

// Python: block statements end in ':' and indentation has to line up.
const PY_BLOCK = /^(?:async\s+)?(if|elif|else|for|while|def|class|try|except|finally|with)\b/;
interface LogicalLine { at: number; text: string; }
const bracketDelta = (ln: string) => [...ln].reduce((d, ch) => d + Number('([{'.includes(ch)) - Number(')]}'.includes(ch)), 0);
// Joins lines that continue inside brackets or after a backslash.
function logicalLines(masked: string): LogicalLine[] {
  const lines: LogicalLine[] = [];
  let cur: LogicalLine | null = null;
  let off = 0, depth = 0;
  for (const ln of masked.split('\n')) {
    const at = off;
    off += ln.length + 1;
    if (!cur && !ln.trim()) continue;
    if (cur) cur.text += '\n' + ln;
    else cur = { at, text: ln };
    depth = Math.max(0, depth + bracketDelta(ln));
    if (depth === 0 && !/\\\s*$/.test(ln)) { lines.push(cur); cur = null; }
  }
  if (cur) lines.push(cur);
  return lines;
}
// The block's ':' sits outside any brackets (and isn't a := walrus).
function hasBlockColon(body: string): boolean {
  let d = 0;
  for (let k = 0; k < body.length; k++) {
    const ch = body[k];
    if ('([{'.includes(ch)) d++;
    else if (')]}'.includes(ch)) d--;
    else if (ch === ':' && d === 0 && body[k + 1] !== '=') return true;
  }
  return false;
}
class PythonChecker {
  readonly out: RawDiag[] = [];
  private readonly indents = [0];
  private opener: string | null = null; // the keyword of the previous line, if it ended with ':'

  line(L: LogicalLine): void {
    const lead = /^[ \t]*/.exec(L.text)?.[0] ?? '';
    const body = L.text.trim();
    this.indent(L, lead);
    const kw = PY_BLOCK.exec(body)?.[1] ?? null;
    if (kw && !hasBlockColon(body)) this.out.push({ at: L.at + L.text.trimEnd().length, len: 1, msg: `Expected ':' after the '${kw}' line` });
    this.opener = /:\s*$/.test(body) ? kw ?? '' : null;
  }
  private indent(L: LogicalLine, lead: string): void {
    const ind = lead.replaceAll('\t', '        ').length;
    const top = this.indents.at(-1) ?? 0;
    const span = Math.max(1, lead.length);
    if (this.opener !== null && ind <= top) {
      const after = this.opener ? ` after the '${this.opener}' line` : '';
      this.out.push({ at: L.at + lead.length, len: 1, msg: 'Expected an indented block' + after });
    } else if (ind > top) {
      if (this.opener === null) this.out.push({ at: L.at, len: span, msg: 'Unexpected indent' });
      else this.indents.push(ind);
    } else if (ind < top) {
      while (this.indents.length > 1 && (this.indents.at(-1) ?? 0) > ind) this.indents.pop();
      if (this.indents.at(-1) !== ind) this.out.push({ at: L.at, len: span, msg: 'This indent does not match any outer block' });
    }
  }
}
function lintPython(masked: string): RawDiag[] {
  const checker = new PythonChecker();
  for (const L of logicalLines(masked)) checker.line(L);
  return checker.out;
}

// HTML (and strict XML/SVG): every element that needs a closing tag gets one, in the right order.
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const OPTIONAL_END = new Set(['html', 'head', 'body', 'p', 'li', 'dt', 'dd', 'option', 'optgroup', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'colgroup', 'caption', 'rb', 'rt', 'rtc', 'rp']);
const RAW_TAGS = new Set(['script', 'style', 'textarea', 'title']);
const JS_TYPES = new Set(['module', 'text/javascript', 'application/javascript']);
const MARKUP = /<!--|<!\[CDATA\[|<[!?]|<\/?([A-Za-z][\w:.-]*)/g;
interface OpenTag { name: string; at: number; len: number; }
class MarkupChecker {
  readonly out: RawDiag[] = [];
  private readonly stack: OpenTag[] = [];
  private readonly lower: string;
  private readonly re = new RegExp(MARKUP.source, 'g');
  private readonly t: string;
  private readonly xml: boolean;
  constructor(t: string, xml: boolean) {
    this.t = t;
    this.xml = xml;
    this.lower = xml ? t : t.toLowerCase();
  }

  run(): RawDiag[] {
    for (let m = this.re.exec(this.t); m; m = this.re.exec(this.t)) if (!this.token(m)) break;
    for (const s of this.stack) if (this.needsEnd(s.name)) this.out.push({ at: s.at, len: s.len, msg: `<${s.name}> is never closed` });
    return this.out;
  }
  private needsEnd(name: string): boolean { return this.xml || !OPTIONAL_END.has(name); }
  private isVoid(name: string): boolean { return !this.xml && VOID_TAGS.has(name); }
  // Handles one match; false stops the scan (the rest of the file is unreadable).
  private token(m: RegExpExecArray): boolean {
    if (m[0] === '<!--') return this.skipTo(m, '-->', 'Comment');
    if (m[0] === '<![CDATA[') return this.skipTo(m, ']]>', 'CDATA section');
    if (!m[1]) return this.skipTo(m, '>', 'Tag');
    const end = this.tagEnd(m);
    if (end === -1) return true;
    const name = this.xml ? m[1] : m[1].toLowerCase();
    const tag = { name, at: m.index, len: end + 1 - m.index };
    this.re.lastIndex = end + 1;
    if (m[0][1] === '/') this.closeTag(tag, m[1]);
    else this.openTag(tag, m[0].length, this.t.slice(m.index + m[0].length, end));
    return true;
  }
  private skipTo(m: RegExpExecArray, end: string, what: string): boolean {
    const e = this.t.indexOf(end, m.index + m[0].length);
    if (e === -1) { this.out.push({ at: m.index, len: m[0].length, msg: `${what} is never closed (missing ${end})` }); return false; }
    this.re.lastIndex = e + end.length;
    return true;
  }
  // Finds the tag's '>' while skipping quoted attribute values; -1 (and a problem) when there is none.
  private tagEnd(m: RegExpExecArray): number {
    const t = this.t;
    let j = m.index + m[0].length, q = '';
    for (; j < t.length; j++) {
      const c = t[j];
      if (q) { if (c === q) q = ''; }
      else if (c === '"' || c === "'") q = c;
      else if (c === '>' || c === '<') break;
    }
    if (t[j] === '>') return j;
    const msg = q ? `Attribute value is never closed (missing ${q})` : `<${m[1]}> tag is never closed (missing >)`;
    this.out.push({ at: m.index, len: m[0].length, msg });
    this.re.lastIndex = j;
    return -1;
  }
  private closeTag(tag: OpenTag, raw: string): void {
    if (this.isVoid(tag.name)) { this.out.push({ ...tag, msg: `<${raw}> never takes a closing tag` }); return; }
    const k = this.stack.map(s => s.name).lastIndexOf(tag.name);
    if (k < 0) { this.out.push({ ...tag, msg: `Unexpected </${raw}>: no <${raw}> is open here` }); return; }
    for (const s of this.stack.splice(k).slice(1)) {
      if (this.needsEnd(s.name)) this.out.push({ at: s.at, len: s.len, msg: `<${s.name}> is never closed (expected </${s.name}> before </${raw}>)` });
    }
  }
  private openTag(tag: OpenTag, nameLen: number, attrs: string): void {
    if (attrs.endsWith('/') || this.isVoid(tag.name)) return;
    this.stack.push({ name: tag.name, at: tag.at, len: nameLen });
    if (!this.xml && RAW_TAGS.has(tag.name)) this.rawText(tag.name, attrs);
  }
  // <script>, <style>…: skip to the closing tag, checking the code inside on the way.
  private rawText(name: string, attrs: string): void {
    const from = this.re.lastIndex;
    const end = this.lower.indexOf(`</${name}`, from);
    if (end === -1) { this.re.lastIndex = this.t.length; return; } // reported as never closed
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1].toLowerCase();
    let opts: ScanOpts | null = null;
    if (name === 'style') opts = CSS_SCAN;
    else if (name === 'script' && (!type || JS_TYPES.has(type))) opts = JS_SCAN;
    if (opts) for (const d of scanCode(this.t.slice(from, end), opts).diags) this.out.push({ ...d, at: d.at + from });
    this.re.lastIndex = end;
  }
}

const JS_EXT = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx']);
const V8_EXT = new Set(['js', 'mjs', 'cjs', 'ts', 'mts', 'cts']); // JSX/TSX need a JSX-aware parser
const looseJson = (path: string) => /^(?:tsconfig|jsconfig)\b/i.test(baseName(path)) || path.startsWith('.vscode/');
function lintCss(text: string, ext: string): RawDiag[] {
  const r = scanCode(text, ext === 'css' ? CSS_SCAN : { ...CSS_SCAN, lineCom: '//' });
  return ext === 'css' && !r.diags.length ? lintCssDecls(r.masked) : r.diags;
}
function lintPy(text: string): RawDiag[] {
  const r = scanCode(text, PY_SCAN);
  return r.diags.length ? r.diags : lintPython(r.masked);
}
// Rust strings may span lines and hold raw text (r#"…"#), and a lone ' starts a lifetime rather than a string, so
// strings and chars are blanked first (comments stay for the scanner).
const RS_TEXT = /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|b?r(#?)"[\s\S]*?(?:"\1|$)|b?"(?:\\[\s\S]|[^"\\])*(?:"|$)|b?'(?:\\[\s\S]|[^\\'\n])'/g;
function lintRust(text: string): RawDiag[] {
  const diags: RawDiag[] = [];
  const blanked = text.replace(RS_TEXT, (m: string, hash: string | undefined, at: number) => {
    if (m.startsWith('/')) return m;
    const open = m.indexOf('"'), close = '"' + (hash ?? '');
    if (open >= 0 && (m.length < open + 1 + close.length || !m.endsWith(close))) diags.push({ at, len: open + 1, msg: `String is never closed (missing ${close})` });
    return m.replace(/[^\n]/g, ' ');
  });
  return diags.concat(scanCode(blanked, RS_SCAN).diags);
}
// Which check runs for each file extension.
const LINTERS: Record<string, (text: string, path: string) => RawDiag[]> = {
  json: (t, p) => new JsonChecker(t, looseJson(p)).check(),
  jsonc: t => new JsonChecker(t, true).check(),
  css: t => lintCss(t, 'css'), scss: t => lintCss(t, 'scss'), less: t => lintCss(t, 'less'),
  html: t => new MarkupChecker(t, false).run(), htm: t => new MarkupChecker(t, false).run(), vue: t => new MarkupChecker(t, false).run(),
  xml: t => new MarkupChecker(t, true).run(), svg: t => new MarkupChecker(t, true).run(),
  py: lintPy,
  java: t => scanCode(t, JAVA_SCAN).diags,
  rs: lintRust,
};
for (const ext of JS_EXT) LINTERS[ext] = t => scanCode(t, { ...JS_SCAN, jsx: ext === 'jsx' || ext === 'tsx' }).diags;
function lintStructure(text: string, path: string): RawDiag[] {
  return LINTERS[extOf(path)]?.(text, path) ?? [];
}
function toDiags(t: string, raw: RawDiag[]): Diag[] {
  const starts = [0];
  for (let k = t.indexOf('\n'); k !== -1; k = t.indexOf('\n', k + 1)) starts.push(k + 1);
  return raw.map(d => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= d.at) lo = mid; else hi = mid - 1; }
    return { line: lo, col: d.at - starts[lo], len: d.len, msg: d.msg };
  }).sort((a, b) => a.line - b.line || a.col - b.col);
}

/* ----- Colored file & folder icons (16×16 inline SVG) ----- */
const svg16 = (body: string) => `<svg viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
const badge = (bg: string, fg: string, label: string, size = 6.4) =>
  svg16(`<rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="${bg}"/><text x="8" y="11.2" text-anchor="middle" font-family="Inter,Segoe UI,sans-serif" font-weight="800" font-size="${size}" fill="${fg}">${label}</text>`);
const page = (color: string, inner = '') =>
  svg16(`<path d="M3.5 1.5h6l3 3v10h-9z" fill="${color}" fill-opacity=".16" stroke="${color}" stroke-width="1.1" stroke-linejoin="round"/><path d="M9.5 1.5v3h3" fill="none" stroke="${color}" stroke-width="1.1" stroke-linejoin="round"/>${inner}`);
const ICONS: Record<string, string> = {
  html: svg16('<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" fill="none" stroke="#f16529" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="m9 3.5-2 9" stroke="#f9a77d" stroke-width="1.4" stroke-linecap="round"/>'),
  css: svg16('<path d="M6.3 2.5 5 13.5M11 2.5 9.7 13.5M2.8 6h11M2.2 10h11" fill="none" stroke="#42a5f5" stroke-width="1.6" stroke-linecap="round"/>'),
  scss: svg16('<circle cx="8" cy="8" r="6.5" fill="#cd6799"/><path d="M10.5 5.5c-1-1-4-.6-4 .9 0 1.6 3.5 1.3 3.5 3 0 1.4-2.6 1.6-3.8.6" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/>'),
  js: badge('#f1d33b', '#1e1e1e', 'JS'),
  ts: badge('#3178c6', '#ffffff', 'TS'),
  cs: badge('#68217a', '#ffffff', 'C#'),
  jsx: svg16('<g fill="none" stroke="#61dafb" stroke-width="1"><ellipse cx="8" cy="8" rx="6.6" ry="2.6"/><ellipse cx="8" cy="8" rx="6.6" ry="2.6" transform="rotate(60 8 8)"/><ellipse cx="8" cy="8" rx="6.6" ry="2.6" transform="rotate(120 8 8)"/></g><circle cx="8" cy="8" r="1.4" fill="#61dafb"/>'),
  json: svg16('<path d="M6 2.5c-1.6 0-1.8.8-1.8 2v1.3c0 1-.5 1.7-1.7 1.9v.6c1.2.2 1.7.9 1.7 1.9v1.3c0 1.2.2 2 1.8 2M10 2.5c1.6 0 1.8.8 1.8 2v1.3c0 1 .5 1.7 1.7 1.9v.6c-1.2.2-1.7.9-1.7 1.9v1.3c0 1.2-.2 2-1.8 2" fill="none" stroke="#f5b942" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="8" r="1" fill="#f5b942"/>'),
  md: svg16('<rect x="1" y="3.5" width="14" height="9" rx="2" fill="none" stroke="#6aa8d8" stroke-width="1.2"/><path d="M3.5 10.5v-4l1.8 2 1.8-2v4M11.2 6.3v4M9.6 8.9l1.6 1.6 1.6-1.6" fill="none" stroke="#6aa8d8" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>'),
  image: svg16('<rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="#b388ff" fill-opacity=".18" stroke="#b388ff" stroke-width="1.2"/><circle cx="5.5" cy="6" r="1.3" fill="#ffd166"/><path d="m2.5 12.5 4-4 2.5 2.5 1.8-1.8 3 3.3z" fill="#b388ff"/>'),
  svg: svg16('<path d="M8 1.8 14.2 8 8 14.2 1.8 8z" fill="#ffb13b" fill-opacity=".2" stroke="#ffb13b" stroke-width="1.2" stroke-linejoin="round"/><circle cx="8" cy="8" r="1.6" fill="#ffb13b"/>'),
  env: svg16('<circle cx="5.5" cy="8" r="3" fill="none" stroke="#e5c07b" stroke-width="1.5"/><path d="M8.5 8h6M12.5 8v2.4M14.5 8v1.6" fill="none" stroke="#e5c07b" stroke-width="1.5" stroke-linecap="round"/>'),
  git: svg16('<path d="M8 1.6 14.4 8 8 14.4 1.6 8z" fill="#f05033"/><path d="M6.4 5.2v5.6M6.4 6.6 9.6 9.4" stroke="#fff" stroke-width="1.1" stroke-linecap="round"/><circle cx="6.4" cy="10.6" r="1" fill="#fff"/><circle cx="9.6" cy="9.4" r="1" fill="#fff"/><circle cx="6.4" cy="5" r="1" fill="#fff"/>'),
  node: svg16('<path d="M8 1.3 13.8 4.6v6.8L8 14.7 2.2 11.4V4.6z" fill="#8cc84b" fill-opacity=".2" stroke="#8cc84b" stroke-width="1.2" stroke-linejoin="round"/><path d="M6 6.2v3.6M10 6.2v3.6M6 6.2l4 3.6" stroke="#8cc84b" stroke-width="1.2" stroke-linecap="round"/>'),
  py: svg16('<path d="M8 1.5c-3 0-3 1.3-3 2.3V6h3.2v.6H3.6C2.3 6.6 1.5 7.6 1.5 9.4s.8 2.9 2 2.9H5V10.5c0-1.2 1-2.2 2.2-2.2h3.3c1 0 1.8-.8 1.8-1.8V3.8c0-1.2-1.2-2.3-4.3-2.3z" fill="#3776ab"/><path d="M8 14.5c3 0 3-1.3 3-2.3V10H7.8v-.6h4.6c1.3 0 2.1-1 2.1-2.8s-.8-2.9-2-2.9H11v1.8c0 1.2-1 2.2-2.2 2.2H5.5c-1 0-1.8.8-1.8 1.8v2.7c0 1.2 1.2 2.3 4.3 2.3z" fill="#ffd43b"/>'),
  // The real Java and Rust logos, kept once as symbols in breeze.html's sprite.
  java: '<svg viewBox="0 0 16 16" aria-hidden="true"><use href="#i-lang-java" width="16" height="16"/></svg>',
  rust: '<svg viewBox="0 0 16 16" aria-hidden="true"><use href="#i-lang-rust" width="16" height="16"/></svg>',
  cpp: '<svg viewBox="0 0 16 16" aria-hidden="true"><use href="#i-lang-cpp" width="16" height="16"/></svg>',
  exe: svg16('<rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="#4aa3ff" fill-opacity=".16" stroke="#4aa3ff" stroke-width="1.2"/><path d="M1.5 5.5h13" stroke="#4aa3ff" stroke-width="1.2"/><circle cx="3.7" cy="4" r=".6" fill="#4aa3ff"/><path d="m6.5 8 2 1.6-2 1.6" fill="none" stroke="#4aa3ff" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>'),
  bin: page('#9aa5b1', '<path d="M5.6 7.6v2M5.6 11.4v.2M8 7.6v.2M8 9.4v2M10.4 7.6v2M10.4 11.4v.2" stroke="#9aa5b1" stroke-width="1.1" stroke-linecap="round"/>'),
  archive: page('#e6a23c', '<path d="M8 2v8" stroke="#e6a23c" stroke-width="1.2" stroke-dasharray="1.2 1.2"/><rect x="6.6" y="10.2" width="2.8" height="2.4" rx=".6" fill="none" stroke="#e6a23c" stroke-width="1"/>'),
  pdf: badge('#e5483f', '#ffffff', 'PDF', 4.6),
  doc: badge('#2b6cb0', '#ffffff', 'DOC', 4.6),
  xls: badge('#1f8a4c', '#ffffff', 'XLS', 4.6),
  ppt: badge('#d9622b', '#ffffff', 'PPT', 4.6),
  c: badge('#5a6dbd', '#ffffff', 'C'),
  h: badge('#8a63d2', '#ffffff', 'H'),
  go: badge('#00add8', '#ffffff', 'GO', 5.4),
  php: badge('#777bb4', '#ffffff', 'PHP', 4.6),
  rb: svg16('<path d="M4 2.5h8l2.5 3.5L8 14 1.5 6z" fill="#cc342d" fill-opacity=".25" stroke="#cc342d" stroke-width="1.2" stroke-linejoin="round"/><path d="M1.5 6h13M5.5 6 8 14l2.5-8M4 2.5 5.5 6 8 2.5 10.5 6 12 2.5" fill="none" stroke="#cc342d" stroke-width=".9" stroke-linejoin="round"/>'),
  kt: badge('#7f52ff', '#ffffff', 'KT', 5.4),
  swift: badge('#f05138', '#ffffff', 'SW', 5.4),
  sql: svg16('<ellipse cx="8" cy="4" rx="5" ry="2" fill="#42a5f5" fill-opacity=".25" stroke="#42a5f5" stroke-width="1.2"/><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" fill="none" stroke="#42a5f5" stroke-width="1.2"/>'),
  audio: svg16('<path d="M6 11.5V3.5l7-1.5v8" fill="none" stroke="#ec6aa5" stroke-width="1.4" stroke-linejoin="round"/><circle cx="4.6" cy="11.6" r="1.7" fill="#ec6aa5"/><circle cx="11.6" cy="10.2" r="1.7" fill="#ec6aa5"/>'),
  video: svg16('<rect x="1.5" y="3" width="13" height="10" rx="2" fill="#ff7043" fill-opacity=".18" stroke="#ff7043" stroke-width="1.2"/><path d="m6.8 6 3.4 2-3.4 2z" fill="#ff7043"/>'),
  font: badge('#9c7fd1', '#ffffff', 'Aa', 5.6),
  shell: svg16('<rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="#4caf50" fill-opacity=".14" stroke="#4caf50" stroke-width="1.2"/><path d="m4.3 6 2.2 2-2.2 2M8 10.5h3.5" fill="none" stroke="#4caf50" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'),
  config: page('#c792ea', '<path d="M5.5 8h5M5.5 10.5h3.5" stroke="#c792ea" stroke-width="1.1" stroke-linecap="round"/>'),
  text: page('#a1a1aa', '<path d="M5.5 7.5h5M5.5 9.5h5M5.5 11.5h3" stroke="#a1a1aa" stroke-width="1" stroke-linecap="round"/>'),
  lock: page('#8b8b95', '<rect x="5.6" y="8.6" width="4.8" height="3.6" rx=".8" fill="#8b8b95"/><path d="M6.6 8.6V7.6a1.4 1.4 0 0 1 2.8 0v1" fill="none" stroke="#8b8b95" stroke-width="1"/>'),
  license: page('#e5c07b', '<circle cx="8" cy="9" r="1.8" fill="none" stroke="#e5c07b" stroke-width="1"/>'),
  file: page('#8b8b95'),
  xml: svg16('<path d="M5 4.5 1.8 8 5 11.5M11 4.5 14.2 8 11 11.5" fill="none" stroke="#e37933" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.4" cy="8" r=".9" fill="#e37933"/><circle cx="8" cy="8" r=".9" fill="#e37933"/><circle cx="9.6" cy="8" r=".9" fill="#e37933"/>'),
  yaml: svg16('<path d="M2 3h2.6L6.5 6.4 8.4 3H11L7.8 8.3V13H5.2V8.3z" fill="#cb171e"/><path d="M10 9.5h4M10 12h3" stroke="#cb171e" stroke-width="1.4" stroke-linecap="round"/>'),
  toml: badge('#9c4221', '#ffffff', 'TML', 4.4),
  vue: svg16('<path d="M1 2.5h3L8 9.4l4-6.9h3L8 14.5z" fill="#41b883"/><path d="M4 2.5h2.4L8 5.3l1.6-2.8H12L8 9.4z" fill="#35495e"/>'),
  svelte: svg16('<path d="M11.8 2.6c-1.4-1-3.4-.7-4.5.6L4.6 6c-.9 1-1 2.6-.2 3.7-.4.8-.4 1.7 0 2.5 1 1.8 3.5 2.3 5.1 1l2.7-2.8c.9-1 1-2.6.2-3.7.4-.8.4-1.7 0-2.5-.2-.6-.5-1.2-.6-1.6z" fill="#ff3e00"/><path d="M9.8 5.2 6.4 8.6M9.6 7.4 6.2 10.8" stroke="#fff" stroke-width="1.1" stroke-linecap="round"/>'),
  astro: svg16('<path d="M5.6 2h4.8l3.2 9.2c-1.4-.8-3.2-1.2-5.6-1.2s-4.2.4-5.6 1.2z" fill="#ff5d01"/><path d="M5.8 12c0 1.2 1 2.5 2.2 2.5s2.2-1.3 2.2-2.5c-1.4.6-3 .6-4.4 0z" fill="#ff5d01" fill-opacity=".7"/>'),
  dart: svg16('<path d="M4 1.5 1.5 4v7l3.2 3.5h7l2.8-2.8V6.5L9 1.5z" fill="#0175c2" fill-opacity=".25"/><path d="M4 1.5h5l5.5 5v5.2L4.7 1.9zM1.5 4l9 9.5h-5.8L1.5 11z" fill="#0175c2"/>'),
  lua: svg16('<circle cx="7.5" cy="8.5" r="6" fill="#000080"/><circle cx="7.5" cy="8.5" r="6" fill="none" stroke="#7a7aff" stroke-width=".8"/><circle cx="10" cy="6" r="1.6" fill="#fff"/><circle cx="13.5" cy="2.5" r="1.4" fill="#7a7aff"/>'),
  r: badge('#276dc3', '#ffffff', 'R'),
  scala: svg16('<path d="M4 2.5c3 .8 8 1 8 1v2.5s-5-.2-8-1zM4 6.8c3 .8 8 1 8 1v2.5s-5-.2-8-1zM4 11c3 .8 8 1 8 1v2.5s-5-.2-8-1z" fill="#dc322f"/>'),
  zig: badge('#f7a41d', '#1e1e1e', 'ZIG', 4.4),
  elixir: svg16('<path d="M8.2 1.5c-2.5 2.6-4.7 6-4.7 8.6 0 2.4 2 4.4 4.5 4.4s4.5-1.8 4.5-4.3c0-3-2.6-4.3-2.6-6.6-1 1.3-1.5 2.3-1.7 3.4-.6-1.6-.4-3.7 0-5.5z" fill="#6e4a7e"/><path d="M6.2 9.5c-.3 1.5.4 3 1.8 3.3" fill="none" stroke="#c3a0d6" stroke-width=".9" stroke-linecap="round"/>'),
  haskell: svg16('<path d="M1.5 13.5 5 8 1.5 2.5h2.6L7.6 8l-3.5 5.5z" fill="#5e5086"/><path d="M5.1 13.5 8.6 8 5.1 2.5h2.6l7 11h-2.6l-2.2-3.4-2.2 3.4z" fill="#8f4e8b"/><path d="M11.4 6.2h3.1v1.5h-2.2zM12.3 8.5h2.2V10h-1.2z" fill="#5e5086"/>'),
  perl: badge('#39457e', '#ffffff', 'PL', 5.4),
  docker: svg16('<path d="M1.2 8.2h12.4c.5-.9 1.3-1.2 1.9-1.1-.2-.8-.8-1.2-1.4-1.2-.3-.9-1-1.3-1-1.3s-.7.9-.4 2H1.2c-.2 3.4 2 6 6.2 6 3.6 0 5.8-1.8 6.6-4.4" fill="#2496ed" fill-opacity=".25" stroke="#2496ed" stroke-width="1" stroke-linejoin="round"/><path d="M2.6 5.6h1.8v1.8H2.6zM4.8 5.6h1.8v1.8H4.8zM7 5.6h1.8v1.8H7zM9.2 5.6H11v1.8H9.2zM4.8 3.4h1.8v1.8H4.8zM7 3.4h1.8v1.8H7zM7 1.2h1.8V3H7z" fill="#2496ed"/>'),
  make: svg16('<path d="M9.8 2.2a3.3 3.3 0 0 0-3.4 4.4L2 11a1.4 1.4 0 0 0 2 2l4.4-4.4a3.3 3.3 0 0 0 4.4-3.4l-2 2-1.9-.5-.5-1.9z" fill="#6d8086" fill-opacity=".3" stroke="#a9b6ba" stroke-width="1.1" stroke-linejoin="round"/>'),
  graphql: svg16('<path d="M8 1.8 13.4 4.9v6.2L8 14.2l-5.4-3.1V4.9zM8 1.8 2.6 11.1h10.8z" fill="none" stroke="#e535ab" stroke-width="1" stroke-linejoin="round"/><circle cx="8" cy="1.8" r="1.1" fill="#e535ab"/><circle cx="13.4" cy="4.9" r="1.1" fill="#e535ab"/><circle cx="13.4" cy="11.1" r="1.1" fill="#e535ab"/><circle cx="8" cy="14.2" r="1.1" fill="#e535ab"/><circle cx="2.6" cy="11.1" r="1.1" fill="#e535ab"/><circle cx="2.6" cy="4.9" r="1.1" fill="#e535ab"/>'),
  proto: badge('#4285f4', '#ffffff', 'PB', 5.4),
  terraform: svg16('<path d="M6 2.3 9.6 4.4v4.2L6 6.5zM10.2 4.4l3.6-2.1v4.2l-3.6 2.1zM2.2 0.1 5.6 2.1v4.2L2.2 4.3zM6 7 9.6 9.1v4.2L6 11.2z" fill="#7b42bc"/>'),
  notebook: svg16('<rect x="2.5" y="1.5" width="11" height="13" rx="1.5" fill="#f37626" fill-opacity=".16" stroke="#f37626" stroke-width="1.2"/><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" stroke="#f37626" stroke-width="1.1" stroke-linecap="round"/><path d="M2.5 4h-1M2.5 8h-1M2.5 12h-1" stroke="#f37626" stroke-width="1.2" stroke-linecap="round"/>'),
  gradle: svg16('<path d="M13.6 4.2c-.8-.8-2.1-.8-2.9 0l.6.6c.4-.3 1-.3 1.3.1.5.5.2 1.4-.6 2.2C10 8.8 6.6 5.2 2 7.5c-.6.3-.3 1.6.5 2.4l.9-.6.8 1v2.2h1.5v-1.6c1 .3 2.2.3 3.2 0v1.6h1.5V10c1.5-.9 2.8-2.4 3.4-4 .3-.7.2-1.4-.2-1.8z" fill="#02303a" stroke="#5ecbd3" stroke-width=".9" stroke-linejoin="round"/>'),
  cmake: svg16('<path d="M8 1.5 14.5 14H1.5z" fill="#064f8c" fill-opacity=".25"/><path d="M8 1.5 1.5 14l6.5-4z" fill="#064f8c"/><path d="M8 1.5V10l6.5 4z" fill="#3eae2b"/><path d="M8 10 1.5 14h13z" fill="#e72429"/>'),
  vim: svg16('<path d="M8 1.3 14.7 8 8 14.7 1.3 8z" fill="#019833"/><path d="M4.5 5h3l-.4.5v4L10 5.5h-.6l.4-.5h2l-.4.5-4.6 6h-1V5.5H5z" fill="#fff"/>'),
  tex: badge('#3d6117', '#ffffff', 'TeX', 4.6),
  diff: svg16('<rect x="1.5" y="1.5" width="13" height="13" rx="2.5" fill="#56b6c2" fill-opacity=".14" stroke="#56b6c2" stroke-width="1.1"/><path d="M5.5 3.8v4.4M3.3 6h4.4M8.8 11h4" stroke="#56b6c2" stroke-width="1.4" stroke-linecap="round"/>'),
  cert: page('#e5c07b', '<circle cx="8" cy="8.8" r="1.9" fill="none" stroke="#e5c07b" stroke-width="1"/><path d="m7 10.5-.6 2.4 1.6-.8 1.6.8-.6-2.4" fill="#e5c07b"/>'),
  key: svg16('<circle cx="5" cy="10.5" r="3" fill="none" stroke="#f0b429" stroke-width="1.5"/><path d="m7.2 8.3 6-6M11 4.5l1.6 1.6M12.6 2.9l1.4 1.4" fill="none" stroke="#f0b429" stroke-width="1.5" stroke-linecap="round"/>'),
  eslint: svg16('<path d="M5 1.8h6l4 6.2-4 6.2H5L1 8z" fill="#4b32c3" fill-opacity=".25" stroke="#8080f2" stroke-width="1.1" stroke-linejoin="round"/><path d="M6.4 5.1h3.2L11.2 8l-1.6 2.9H6.4L4.8 8z" fill="#8080f2"/>'),
  prettier: svg16('<path d="M2 3h6M10 3h4M2 5.5h3M7 5.5h7M2 8h8M12 8h2M2 10.5h4M8 10.5h6M2 13h7" stroke-width="1.4" stroke-linecap="round" stroke="#56b3b4"/><path d="M8 3h2M5 5.5h2M10 8h2M6 10.5h2" stroke-width="1.4" stroke-linecap="round" stroke="#f7b93e"/>'),
  vite: svg16('<path d="M14.5 2.5 8.3 14a.4.4 0 0 1-.7 0L1.5 2.5a.4.4 0 0 1 .4-.6L8 3l6.1-1.1a.4.4 0 0 1 .4.6z" fill="#646cff" fill-opacity=".85"/><path d="M10.8 1.6 6.4 2.5a.2.2 0 0 0-.1.2l-.3 4.8a.2.2 0 0 0 .2.2l1.2-.3a.2.2 0 0 1 .2.2l-.3 1.7a.2.2 0 0 0 .3.2l.8-.2a.2.2 0 0 1 .3.2l-.6 2.9c0 .2.2.3.3.1l.1-.1 2.5-5a.2.2 0 0 0-.2-.3l-1.2.2a.2.2 0 0 1-.2-.2l.8-2.8a.2.2 0 0 0-.3-.3z" fill="#ffc517"/>'),
  tailwind: svg16('<path d="M8 3.5c-1.9 0-3 .9-3.5 2.8.7-.9 1.5-1.3 2.4-1 .5.1.9.5 1.3.9.7.7 1.4 1.5 3.1 1.5 1.9 0 3-.9 3.5-2.8-.7.9-1.5 1.3-2.4 1-.5-.1-.9-.5-1.3-.9-.7-.7-1.4-1.5-3.1-1.5zM4.5 7.7C2.6 7.7 1.4 8.6 1 10.5c.7-.9 1.5-1.3 2.4-1 .5.1.9.5 1.3.9.7.7 1.4 1.5 3.1 1.5 1.9 0 3-.9 3.5-2.8-.7.9-1.5 1.3-2.4 1-.5-.1-.9-.5-1.3-.9-.7-.7-1.4-1.5-3.1-1.5z" fill="#38bdf8"/>'),
  readme: svg16('<circle cx="8" cy="8" r="6.5" fill="#42a5f5" fill-opacity=".18" stroke="#42a5f5" stroke-width="1.2"/><path d="M8 7.2v4" stroke="#42a5f5" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="4.9" r="1" fill="#42a5f5"/>'),
  changelog: page('#7cb342', '<path d="M8 7v2.2l1.4 1" fill="none" stroke="#7cb342" stroke-width="1.1" stroke-linecap="round"/><circle cx="8" cy="9.2" r="2.6" fill="none" stroke="#7cb342" stroke-width="1"/>'),
  sourcemap: page('#9aa5b1', '<path d="M5.5 8.5h2v3h3M8.5 7.5l2 1-2 1" fill="none" stroke="#9aa5b1" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>'),
  robots: svg16('<rect x="3" y="5" width="10" height="8" rx="2" fill="#78909c" fill-opacity=".2" stroke="#90a4ae" stroke-width="1.2"/><path d="M8 5V2.6" stroke="#90a4ae" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="2.2" r=".9" fill="#90a4ae"/><circle cx="6" cy="8.5" r="1" fill="#90a4ae"/><circle cx="10" cy="8.5" r="1" fill="#90a4ae"/><path d="M6.3 11h3.4" stroke="#90a4ae" stroke-width="1" stroke-linecap="round"/>'),
  test: svg16('<path d="M6 1.8h4M6.8 1.8v4L2.6 12.6a1.1 1.1 0 0 0 1 1.6h8.8a1.1 1.1 0 0 0 1-1.6L9.2 5.8v-4" fill="none" stroke="#22c55e" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"/><path d="M4.2 10h7.6l1.1 2.6a.7.7 0 0 1-.6 1H3.7a.7.7 0 0 1-.6-1z" fill="#22c55e"/>'),
};
const EXT_ICON: Record<string, string> = {
  html: 'html', htm: 'html', xhtml: 'html', xml: 'xml', xsd: 'xml', xsl: 'xml', xslt: 'xml', plist: 'xml', rss: 'xml', atom: 'xml', resx: 'xml', vue: 'vue', svelte: 'svelte', astro: 'astro', css: 'css', less: 'css', scss: 'scss', sass: 'scss',
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', tsx: 'jsx', ts: 'ts', mts: 'ts', cts: 'ts', json: 'json', jsonc: 'json', md: 'md', markdown: 'md',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', ico: 'image', bmp: 'image', avif: 'image', svg: 'svg',
  py: 'py', java: 'java', jar: 'java', rs: 'rust', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', cs: 'cs', csx: 'cs', csproj: 'config', sln: 'config', sh: 'shell', bash: 'shell', ps1: 'shell', bat: 'shell', cmd: 'shell', yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'config', cfg: 'config', conf: 'config', properties: 'config', editorconfig: 'config', dart: 'dart', lua: 'lua', r: 'r', rmd: 'r', scala: 'scala', sc: 'scala', zig: 'zig', ex: 'elixir', exs: 'elixir', hs: 'haskell', lhs: 'haskell', pl: 'perl', pm: 'perl', graphql: 'graphql', gql: 'graphql', proto: 'proto', tf: 'terraform', tfvars: 'terraform', hcl: 'terraform', ipynb: 'notebook', gradle: 'gradle', cmake: 'cmake', mk: 'make', vim: 'vim', tex: 'tex', bib: 'tex', diff: 'diff', patch: 'diff', pem: 'cert', crt: 'cert', cer: 'cert', p12: 'cert', pfx: 'cert', key: 'key', pub: 'key', map: 'sourcemap', fish: 'shell', zsh: 'shell', psm1: 'shell', m: 'c', mm: 'cpp', fs: 'cs', fsx: 'cs', vb: 'cs', csh: 'shell', jl: 'py', pyw: 'py', pyi: 'py', ejs: 'html', hbs: 'html', pug: 'html', njk: 'html', twig: 'html', liquid: 'html', styl: 'css', pcss: 'css', postcss: 'css',
  txt: 'text', log: 'text', csv: 'text', tsv: 'text', rtf: 'text', lock: 'lock', exe: 'exe', msi: 'exe', app: 'exe', apk: 'exe', com: 'exe', scr: 'exe', dll: 'bin', so: 'bin', dylib: 'bin', bin: 'bin', o: 'bin', obj: 'bin', a: 'bin', lib: 'bin', class: 'bin', pyc: 'bin', wasm: 'bin', iso: 'bin', img: 'bin', dat: 'bin', zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive', tgz: 'archive', bz2: 'archive', xz: 'archive', pdf: 'pdf', doc: 'doc', docx: 'doc', odt: 'doc', xls: 'xls', xlsx: 'xls', ods: 'xls', ppt: 'ppt', pptx: 'ppt', odp: 'ppt', c: 'c', h: 'h', go: 'go', php: 'php', rb: 'rb', kt: 'kt', kts: 'kt', swift: 'swift', sql: 'sql', db: 'sql', sqlite: 'sql', sqlite3: 'sql', mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio', m4a: 'audio', aac: 'audio', mp4: 'video', mkv: 'video', mov: 'video', avi: 'video', webm: 'video', ttf: 'font', otf: 'font', woff: 'font', woff2: 'font', tiff: 'image', heic: 'image', psd: 'image',
};
function fileIcon(name: string): string {
  const n = name.toLowerCase();
  if (n.startsWith('.env')) return ICONS.env;
  if (n.startsWith('.git')) return ICONS.git;
  if (n === 'package.json' || n === 'package-lock.json' || n === '.npmrc' || n === '.nvmrc') return ICONS.node;
  if (n.startsWith('license')) return ICONS.license;
  if (/^(tsconfig|jsconfig)[\w.-]*\.json$/.test(n)) return ICONS.ts;
  if (n === 'cargo.toml' || n === 'cargo.lock') return ICONS.rust;
  if (n === 'dockerfile' || n.startsWith('dockerfile.') || n.endsWith('.dockerfile') || n === '.dockerignore' || /^(docker-)?compose[\w.-]*\.ya?ml$/.test(n)) return ICONS.docker;
  if (n === 'makefile' || n === 'gnumakefile') return ICONS.make;
  if (n === 'cmakelists.txt') return ICONS.cmake;
  if (n.startsWith('.eslint') || /^eslint\.config\./.test(n)) return ICONS.eslint;
  if (n.startsWith('.prettier') || /^prettier\.config\./.test(n)) return ICONS.prettier;
  if (/^vite(st)?\.config\./.test(n)) return ICONS.vite;
  if (/^tailwind\.config\./.test(n)) return ICONS.tailwind;
  if (n === '.editorconfig') return ICONS.config;
  if (n === 'robots.txt') return ICONS.robots;
  if (/^readme(\.|$)/.test(n)) return ICONS.readme;
  if (/^(changelog|changes|history)(\.|$)/.test(n)) return ICONS.changelog;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(n) || /^test_.*\.py$|_test\.(py|go)$/.test(n)) return ICONS.test;
  if (n.endsWith('.d.ts')) return ICONS.ts;
  if (n === '.vimrc' || n === '.gvimrc') return ICONS.vim;
  const ext = n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : '';
  return ICONS[EXT_ICON[ext] ?? 'file'];
}
// Folder colours follow what the folder usually holds.
const FOLDER_COLORS: [RegExp, string][] = [
  [/^(src|app|lib|source)$/, '#7aa9ff'], [/^(node_modules)$/, '#8cc84b'], [/^\.git$/, '#f05033'], [/^\.(claude|vscode|idea|github)$/, '#d97757'],
  [/^(assets|images?|img|public|static|media|icons?)$/, '#ffb74d'], [/^(tests?|__tests__|spec)$/, '#4db6ac'], [/^(dist|build|out|\.next)$/, '#9e9e9e'],
  [/^(components?|ui|views?|pages?)$/, '#c4b5fd'], [/^(styles?|css)$/, '#42a5f5'], [/^(docs?)$/, '#6aa8d8'],
];
function folderIcon(name: string, open: boolean): string {
  const c = FOLDER_COLORS.find(([re]) => re.test(name.toLowerCase()))?.[1] ?? '#90a4c4';
  return open
    ? svg16(`<path d="M1.5 4a1 1 0 0 1 1-1h3.4l1.4 1.5h5.7a1 1 0 0 1 1 1V7H4.2a1 1 0 0 0-.95.68L1.5 12.5z" fill="${c}" fill-opacity=".55"/><path d="M3.3 7.7A1 1 0 0 1 4.25 7h10.3l-1.9 5.8a1 1 0 0 1-.95.7H1.5z" fill="${c}"/>`)
    : svg16(`<path d="M1.5 4a1 1 0 0 1 1-1h3.4l1.4 1.5h6.2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="${c}"/><path d="M1.5 6h13" stroke="#000" stroke-opacity=".18"/>`);
}
const CHEV = '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

