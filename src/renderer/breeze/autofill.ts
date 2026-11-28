/* ================= Autofill ================= */
// One suggestion list, used by the code editor (words and keywords) and the terminal (files, commands, history).
// insert/from: a language server's completion, which may insert other text than its label, from another spot.
// run: does its own thing instead of inserting; plain: the typed prefix is not part of its label, so none of it is bolded;
// marks: the letters of its label that matched, bolded instead of the typed prefix (autofillcore.ts).
interface Suggestion { text: string; hint?: string; insert?: string; from?: number; run?: () => void; plain?: boolean; marks?: number[]; }
interface SuggestState { owner: HTMLElement; items: Suggestion[]; sel: number; typed: number; accept: (s: Suggestion) => void; onRender?: () => void; }
let suggest: SuggestState | null = null;
const suggestEl = document.createElement('div');
suggestEl.className = 'suggest hidden';
suggestEl.setAttribute('role', 'listbox');
document.body.append(suggestEl);
// Greyed-out rest of the selected suggestion, drawn right after the editor's caret.
const editorGhost = document.createElement('span');
editorGhost.className = 'editor-ghost';
editorGhost.setAttribute('aria-hidden', 'true');
document.body.append(editorGhost);
suggestEl.addEventListener('mousedown', e => e.preventDefault()); // keep focus where the user is typing
suggestEl.addEventListener('click', e => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-sg]');
  if (row && suggest) suggest.accept(suggest.items[Number(row.dataset.sg)]);
});
// The label with its matched letters in bold, a run of them at a time.
function boldMarks(text: string, marks: number[]): string {
  let out = '';
  for (let i = 0; i < text.length;) {
    const on = marks.includes(i);
    let j = i + 1;
    while (j < text.length && marks.includes(j) === on) j++;
    out += on ? `<b>${esc(text.slice(i, j))}</b>` : esc(text.slice(i, j));
    i = j;
  }
  return out;
}
function renderSuggest(): void {
  if (!suggest) return;
  const { items, sel, typed } = suggest;
  suggestEl.innerHTML = items.map((s, i) => {
    const hint = s.hint ? `<small>${esc(s.hint)}</small>` : '';
    const marks = s.marks ?? (s.plain ? [] : Array.from({ length: typed }, (_, k) => k));
    return `<div class="${i === sel ? 'on' : ''}" data-sg="${i}" role="option"><span>${boldMarks(s.text, marks)}</span>${hint}</div>`;
  }).join('');
  suggestEl.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  suggest.onRender?.();
}
// Shows suggestions under (x, y), or above `above` when they don't fit below.
function showSuggest(state: SuggestState, x: number, y: number, above: number): void {
  if (!state.items.length) { hideSuggest(); return; }
  suggest = state;
  suggestEl.style.translate = '';
  renderSuggest();
  suggestEl.classList.remove('hidden');
  const h = suggestEl.offsetHeight, w = suggestEl.offsetWidth;
  suggestEl.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
  suggestEl.style.top = `${y + h > innerHeight - 8 ? Math.max(8, above - h) : y}px`;
}
// Where the editor's list and ghost were placed, so scrolling carries them along with the text (a translate: no layout)
// instead of ranking the words and asking the language server again on every wheel tick.
let suggestView: { ta: CodeSurface; top: number; left: number; caretY: number; minY: number; maxY: number } | null = null;
function scrollSuggest(ta: CodeSurface): void {
  const v = suggestView;
  if (!v || v.ta !== ta) return;
  const dx = ta.scrollLeft - v.left, dy = ta.scrollTop - v.top, y = v.caretY - dy;
  if (y < v.minY || y > v.maxY) { hideSuggest(); return; } // the caret scrolled out of the editor
  suggestEl.style.translate = editorGhost.style.translate = `${-dx}px ${-dy}px`;
}
// Counts closes, so a late answer (the Emmet preview) can tell the list was closed after it was asked for.
let suggestHidden = 0;
function hideSuggest(): void {
  suggestHidden++;
  suggest = null;
  suggestView = null;
  suggestEl.classList.add('hidden');
  editorGhost.textContent = '';
  editorGhost.style.translate = '';
  $('#editor').classList.remove('suggesting');
}
// Arrow keys move, Tab or Enter accepts, Escape closes. True when the key was used.
function suggestKeys(e: KeyboardEvent, owner: HTMLElement): boolean {
  if (suggest?.owner !== owner) return false;
  const s = suggest;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') s.sel = (s.sel + (e.key === 'ArrowDown' ? 1 : -1) + s.items.length) % s.items.length;
  else if (e.key === 'Tab' || e.key === 'Enter') s.accept(s.items[s.sel]);
  else if (e.key === 'Escape') hideSuggest();
  else return false;
  e.preventDefault();
  e.stopPropagation();
  if (suggest) renderSuggest();
  return true;
}

/* ----- Code editor: words from the file plus the language's keywords ----- */
const CSS_PROPS = 'display position top right bottom left margin padding color background background-color border border-radius box-shadow font font-family font-size font-weight line-height letter-spacing text-align text-decoration width height min-width max-width min-height max-height flex flex-direction flex-wrap align-items justify-content gap grid grid-template-columns grid-template-rows place-items overflow opacity transform transition animation cursor z-index content outline visibility white-space inset aspect-ratio object-fit';
const HTML_TAGS = 'html head body title meta link script style div span section header footer main nav article aside button input label form select option textarea img picture video audio a ul ol li p h1 h2 h3 h4 h5 h6 strong em small code pre table thead tbody tr td th template iframe canvas svg';
const JS_EXTRA = 'console log document window querySelector querySelectorAll addEventListener removeEventListener getElementById createElement appendChild classList textContent innerHTML length forEach filter reduce includes startsWith endsWith JSON stringify parse Promise resolve setTimeout clearTimeout fetch Math Object keys values entries Array Number String Boolean Map Set';
const PY_EXTRA = 'print range len str int float list dict set tuple open enumerate zip isinstance sorted append extend items keys values format join split strip __init__ __name__ __main__';
const JAVA_EXTRA = 'System out println print printf String Integer Double Boolean Character Math List ArrayList Map HashMap Set HashSet Arrays Collections Scanner main args length size add get put remove contains equals toString Override Exception RuntimeException';
const RS_EXTRA = 'println! print! format! vec! panic! assert! assert_eq! main unwrap expect clone iter into_iter map filter collect push pop len is_empty new into to_string as_str HashMap HashSet derive Debug Clone';
const EDITOR_WORDS: Record<string, string[]> = {
  js: `${JS_KW} ${JS_EXTRA}`.split(' '),
  py: `${PY_KW} ${PY_EXTRA}`.split(' '),
  java: `${JAVA_KW} ${JAVA_EXTRA}`.split(' '),
  rs: `${RS_KW} ${RS_EXTRA}`.split(' '),
  cpp: `${CPP_KW} include define ifdef ifndef endif pragma cout cin cerr endl printf scanf main`.split(' '),
  css: CSS_PROPS.split(' '),
  html: HTML_TAGS.split(' '),
  json: ['true', 'false', 'null'],
  ...Object.fromEntries(Object.entries({ go: GO_KW, rb: RB_KW, kt: KT_KW, swift: SWIFT_KW, dart: DART_KW, zig: ZIG_KW, scala: SCALA_KW, groovy: GROOVY_KW, ex: EX_KW, hs: HS_KW, r: R_KW, pl: PL_KW }).map(([id, kw]) => [id, kw.split(' ')])),
};
// Word counts per open file, refreshed while typing: small files almost every keystroke, so a word just typed is offered.
const wordCache = new WeakMap<EditorBuffer, { at: number; text: string; counts: Map<string, number> }>();
function fileWords(b: EditorBuffer): Map<string, number> {
  const cached = wordCache.get(b);
  // Big files are counted less often: the count takes longer and a few new words barely change it. Unchanged ones never again.
  if (cached && (cached.text === b.text || Date.now() - cached.at < Math.max(150, b.text.length / 50))) return cached.counts;
  const counts = new Map<string, number>();
  for (const m of b.text.slice(0, LINT_MAX).matchAll(WORD_RE)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  wordCache.set(b, { at: Date.now(), text: b.text, counts });
  return counts;
}
// The word taken after typing a start of it, under that start and each longer one (us → userName for us, use, user…),
// so the same start offers it first next time. The oldest are dropped past 500.
const picks = new Map<string, string>(store.get<[string, string][]>('breeze.picks', []));
let pickSave = 0;
function rememberPick(typed: string, word: string): void {
  const keys = [typed.toLowerCase()];
  if (word.toLowerCase().startsWith(keys[0])) for (let n = typed.length + 1; n < word.length; n++) keys.push(word.slice(0, n).toLowerCase());
  for (const k of keys) { picks.delete(k); picks.set(k, word); }
  for (const k of picks.keys()) { if (picks.size <= 500) break; picks.delete(k); }
  clearTimeout(pickSave);
  pickSave = window.setTimeout(() => store.set('breeze.picks', [...picks]), 1000);
}
function editorCandidates(b: EditorBuffer, prefix: string, pos: number): Suggestion[] {
  const lang = langOf(b.path)[0], counts = fileWords(b), keywords = new Set(EDITOR_WORDS[lang] ?? []);
  const weights = new Map<string, number>();
  const add = (w: string, n: number) => weights.set(w, (weights.get(w) ?? 0) + n);
  // A keyword counts like a name used about seven times: it no longer outranks every name in the file.
  for (const w of keywords) add(w, 6);
  // Each further use counts a little less (log), so a name used a lot doesn't bury one used a few times right here.
  for (const [w, n] of counts) add(w, Math.log2(1 + n) * 2);
  // The names in the other open files of the same language, at half weight: a project's names cross files.
  for (const o of buffers.values()) if (o !== b && o.kind === 'text' && langOf(o.path)[0] === lang) for (const [w, n] of fileWords(o)) add(w, Math.log2(1 + n));
  // The words around the caret are the likeliest to come next.
  for (const [w, near] of nearWords(b.text, pos, 3000)) add(w, near * 6);
  const ranked = rankWords(prefix, weights, 8, picks.get(prefix.toLowerCase()));
  // The typed word is in the file too, so a count of one is just itself. A word that is already one (used elsewhere, or
  // a keyword) gets no list of part-matches only: Enter would swap it for another name.
  if ((ranked[0]?.tier ?? 0) >= 2 && ((counts.get(prefix) ?? 0) >= 2 || keywords.has(prefix))) return [];
  return ranked.map(r => ({ text: r.text, marks: r.marks, hint: keywords.has(r.text) ? 'keyword' : '' }));
}
// The word (letters, digits, _ $ and -) that ends at the caret.
function wordBefore(ta: CodeSurface): string {
  const v = ta.value, end = ta.selectionStart;
  let i = end;
  while (i > 0 && end - i < 60 && /[\w$-]/.test(v[i - 1])) i--;
  while (i < end && !/[A-Za-z_$]/.test(v[i])) i++; // words start with a letter, _ or $
  return v.slice(i, end);
}
function editorSuggest(b: EditorBuffer, force = false): void {
  const ta = b.ta;
  if (!ta || ta.multi || ta.selectionStart !== ta.selectionEnd) { hideSuggest(); return; } // none for several cursors
  const prefix = wordBefore(ta);
  const pos = ta.selectionStart, ls = lineStart(b.text, pos), line = b.text.slice(ls, pos);
  // Right after a "." the language server lists the members.
  const lsp = lspOn.has(b.path), member = lsp && b.text[pos - prefix.length - 1] === '.';
  const short = prefix.length < (force || member ? 0 : 2);
  // An abbreviation like `ul>li.x*3` ends in no word, so it is looked for before the length check.
  const abbr = emmetCandidate(b, ta);
  if (short && !abbr) { hideSuggest(); return; }
  const cw = measureChar();
  const r = ta.getBoundingClientRect();
  const x = r.left + 4 + visualCol(line, pos - ls - prefix.length) * cw - ta.scrollLeft;
  const top = r.top + 10 + lineAt(b.text, pos) * LINE_H - ta.scrollTop;
  // Only where nothing follows on the line, so the hint never covers real text.
  const lineEnd = b.text.indexOf('\n', pos);
  const clear = !b.text.slice(pos, lineEnd < 0 ? undefined : lineEnd).trim();
  const ghost = () => {
    const s = suggest?.items[suggest.sel], t = s?.insert ?? s?.text;
    editorGhost.textContent = clear && s?.from == null && !s?.run && t?.startsWith(prefix) ? t.slice(prefix.length) : '';
    editorGhost.style.left = `${r.left + 4 + visualCol(line, pos - ls) * cw - ta.scrollLeft}px`;
    editorGhost.style.top = `${top}px`;
    // A half-typed line is usually a syntax error; its message would sit under the ghost text.
    $('#editor').classList.add('suggesting');
  };
  let emmetItem: Suggestion | undefined, listed: Suggestion[] = [];
  const view = { ta, top: ta.scrollTop, left: ta.scrollLeft, caretY: top, minY: r.top, maxY: r.bottom - LINE_H };
  const show = (items: Suggestion[]) => {
    listed = items;
    suggestView = view;
    showSuggest({
      owner: ta.input, items: emmetItem ? [emmetItem, ...items] : items, sel: 0, typed: prefix.length,
      accept: s => {
        hideSuggest();
        if (!s.run && s.insert == null) rememberPick(prefix, s.text); // the file's words; the server ranks its own
        if (s.run) s.run(); else replaceRange(ta, s.from ?? pos - prefix.length, ta.selectionStart, s.insert ?? s.text);
      },
      onRender: ghost,
    }, x - 8, top + LINE_H + 2, top - 2);
    scrollSuggest(ta); // a late answer (the server's, Emmet's) lands where the text has scrolled to since
  };
  const words = member || short ? [] : editorCandidates(b, prefix, pos);
  if (words.length) show(words); else hideSuggest();
  // The expansion goes on top of the list once main has it, unless the user moved on or closed the list (Esc).
  if (abbr) {
    const hidden = suggestHidden;
    void emmetPreview(b, ta).then(expansion => {
      if (!expansion || document.activeElement !== ta.input || ta.selectionStart !== pos || suggestHidden !== hidden) return;
      const first = emmetInsert(expansion, '').text.split('\n')[0];
      emmetItem = { text: `Emmet: ${first.length > 48 ? first.slice(0, 48) : first}…`, plain: true, run: () => { void tryEmmet(b, ta); } };
      show(listed);
    });
  }
  if (!lsp) return;
  // The server's answer comes first, then the file's words it didn't have. Dropped if the user moved on.
  const ask = ++lspAsk, text = b.text;
  void lspCompletions(b, pos, prefix).then(items => {
    if (ask !== lspAsk || b.text !== text || ta.selectionStart !== pos || document.activeElement !== ta.input || !items.length) return;
    const seen = new Set(items.map(s => s.text));
    show([...items, ...words.filter(w => !seen.has(w.text))].slice(0, 14));
  });
}

/* ----- Next line: after Enter, the line above again with its numbers counted on (nextlinecore.ts) ----- */
// Drawn in the same grey as a word's rest. Tab takes it; typing, Esc, a click or leaving the editor drops it (hideSuggest
// empties the ghost, and a hint whose ghost is gone or whose spot changed counts as dropped).
let lineHint: { ta: CodeSurface; pos: number; value: string; text: string } | null = null;
function lineHintLive(ta: CodeSurface): boolean {
  const h = lineHint;
  return !!h && h.ta === ta && editorGhost.textContent === h.text && ta.value === h.value && ta.selectionStart === h.pos && ta.selectionEnd === h.pos;
}
function placeLineHint(): void {
  const h = lineHint;
  if (!h || !lineHintLive(h.ta)) return;
  const v = h.ta.value, ls = lineStart(v, h.pos), r = h.ta.getBoundingClientRect();
  editorGhost.style.translate = '';
  editorGhost.style.left = `${r.left + 4 + visualCol(v.slice(ls, h.pos), h.pos - ls) * measureChar() - h.ta.scrollLeft}px`;
  editorGhost.style.top = `${r.top + 10 + lineAt(v, h.pos) * LINE_H - h.ta.scrollTop}px`;
}
// Called right after Enter made a new line.
function nextLineHint(b: EditorBuffer, ta: CodeSurface): void {
  lineHint = null;
  if (ta !== b.ta || ta.multi || ta.selectionStart !== ta.selectionEnd || suggest) return;
  const v = ta.value, pos = ta.selectionStart, ls = lineStart(v, pos);
  const le = v.indexOf('\n', pos);
  if (ls === 0 || v.slice(ls, le < 0 ? undefined : le).trim()) return; // only on a line that is still empty
  const aboveAt = lineStart(v, ls - 1), above = v.slice(aboveAt, ls - 1);
  const twoAbove = aboveAt > 0 ? v.slice(lineStart(v, aboveAt - 1), aboveAt - 1) : null;
  const guess = nextLineGuess(above, twoAbove);
  if (!guess) return;
  const indent = v.slice(ls, pos);
  const text = guess.startsWith(indent) ? guess.slice(indent.length) : guess.trimStart();
  if (!text) return;
  lineHint = { ta, pos, value: v, text };
  editorGhost.textContent = text;
  placeLineHint();
}
// Tab: puts the hinted line in. False when there is none, so Tab indents as usual.
function acceptLineHint(ta: CodeSurface): boolean {
  if (!lineHintLive(ta)) { lineHint = null; return false; }
  const { pos, text } = lineHint!;
  lineHint = null;
  editorGhost.textContent = '';
  replaceRange(ta, pos, pos, text);
  return true;
}

/* ----- Terminal: files and folders, commands, and your history ----- */
const COMMANDS = ['git', 'npm', 'npx', 'node', 'cd', 'dir', 'ls', 'cls', 'clear', 'mkdir', 'python', 'pip', 'echo', 'type', 'cat', 'code'];
const SUBCOMMANDS: Record<string, string[]> = {
  git: ['status', 'add', 'commit', 'push', 'pull', 'fetch', 'switch', 'checkout', 'branch', 'log', 'diff', 'init', 'clone', 'merge', 'stash', 'restore'],
  npm: ['install', 'run', 'start', 'test', 'init', 'uninstall', 'update'],
};
// The project's npm scripts, so `npm s` hints `npm start` and `npm run b` hints `npm run build`.
let npmScripts: string[] = [];
async function loadNpmScripts(): Promise<void> {
  if (!rootInfo) { npmScripts = []; return; }
  const r = await api.fs.readFile('package.json').catch(() => null);
  try { npmScripts = Object.keys(JSON.parse(r?.text ?? '{}').scripts ?? {}); } catch { npmScripts = []; }
}
background(loadNpmScripts());
api.fs.onChange(paths => { if (paths.includes('package.json')) background(loadNpmScripts()); });
function subcommandsOf(cmd: string): string[] {
  return cmd === 'npm' ? [...new Set([...SUBCOMMANDS.npm, ...npmScripts.filter(s => ['start', 'test'].includes(s))])] : SUBCOMMANDS[cmd] ?? [];
}
// The known words that can finish the last word of `words`.
function knownWords(words: string[]): string[] {
  if (words.length === 1) return [...new Set([...term.history.map(h => h.split(' ')[0]), ...COMMANDS])];
  if (words.length === 2) return subcommandsOf(words[0]);
  if (words.length === 3 && words[0] === 'npm' && words[1] === 'run') return npmScripts;
  return [];
}
// Greyed-out rest of the line: the last matching command from history, else a known command; → accepts it.
function ghostMatch(value: string): string {
  if (!value) return '';
  const past = [...term.history].reverse().find(h => h.startsWith(value) && h !== value);
  if (past) return past;
  const words = value.split(' '), token = words.at(-1) ?? '';
  if (!token) return '';
  const word = knownWords(words).find(w => w.startsWith(token) && w !== token);
  return word ? value + word.slice(token.length) : '';
}
function updateGhost(): void {
  if (term.proc != null) {
    termGhost.innerHTML = '';
    termInput.classList.add('raw-input');
    return;
  }
  termInput.classList.remove('raw-input');
  const v = termInput.value;
  if (!v) {
    termGhost.innerHTML = '';
    return;
  }
  const match = ghostMatch(v);
  const highlightedTyped = formatCommandSyntax(v);
  const ghostTail = match?.startsWith(v) ? match.slice(v.length) : '';
  const ghostSpan = ghostTail ? `<span class="term-ghost-text">${esc(ghostTail)}</span>` : '';
  termGhost.innerHTML = `${highlightedTyped}${ghostSpan}`;
}
// Width of text in an input's own font.
const measureCtx = document.createElement('canvas').getContext('2d');
function textWidth(text: string, el: HTMLElement): number {
  if (!measureCtx) return text.length * 7;
  measureCtx.font = getComputedStyle(el).font;
  return measureCtx.measureText(text).width;
}
function commonPrefix(words: string[]): string {
  let shared = words[0] ?? '';
  for (const w of words) {
    let i = 0;
    while (i < shared.length && shared[i].toLowerCase() === w[i]?.toLowerCase()) i++;
    shared = shared.slice(0, i);
  }
  return shared;
}
async function terminalCandidates(line: string): Promise<{ token: string; items: Suggestion[] }> {
  const words = line.split(' ');
  const token = words.at(-1) ?? '';
  if (words.length === 1) {
    const commands = knownWords(words).filter(c => c.startsWith(token) && c !== token).map(c => ({ text: c, hint: 'command' }));
    const files = token ? await api.term.complete(token).catch(() => []) : [];
    return { token, items: [...commands, ...files.map(f => ({ text: f.text, hint: f.dir ? 'folder' : 'file' }))].slice(0, 40) };
  }
  const hint = words.length === 3 ? 'script' : words[0];
  const subs = knownWords(words).filter(c => c.startsWith(token) && c !== token).map(c => ({ text: c, hint }));
  const files = await api.term.complete(token).catch(() => []);
  return { token, items: [...subs, ...files.map(f => ({ text: f.text, hint: f.dir ? 'folder' : 'file' }))].slice(0, 40) };
}
// Tab completes the last word: one match fills in, several fill the shared start and list the rest.
async function completeTerminal(): Promise<void> {
  const line = termInput.value;
  const { token, items } = await terminalCandidates(line);
  if (termInput.value !== line || !items.length) return;
  const base = line.slice(0, line.length - token.length);
  const put = (text: string) => { termInput.value = base + text; updateGhost(); };
  if (items.length === 1) { put(items[0].text); hideSuggest(); return; }
  const shared = commonPrefix(items.map(i => i.text));
  if (shared.length > token.length) put(shared);
  const r = termInput.getBoundingClientRect();
  const x = r.left + textWidth(base, termInput);
  showSuggest({ owner: termInput, items, sel: 0, typed: termInput.value.length - base.length, accept: s => { put(s.text); hideSuggest(); termInput.focus(); } }, x, r.bottom + 4, r.top - 4);
}
// Keys the terminal's autofill handles before the normal ones; true when handled.
function terminalAutofillKeys(e: KeyboardEvent): boolean {
  if (term.proc != null) return false;
  if (suggestKeys(e, termInput)) return true;
  const match = ghostMatch(termInput.value);
  if ((e.key === 'Tab' || e.key === 'ArrowRight') && match && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    termInput.value = match;
    updateGhost();
    return true;
  }
  if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    void completeTerminal();
    return true;
  }
  return false;
}
termInput.addEventListener('input', () => { updateGhost(); if (suggest?.owner === termInput) hideSuggest(); });
termInput.addEventListener('blur', () => { termGhost.innerHTML = ''; hideSuggest(); });
termInput.addEventListener('focus', updateGhost);


/* ----- Every other textbox: words you typed before, plus the words in open files ----- */
// Tab or a click takes a word; Enter still sends or submits. Fields that look like they hold a secret are never learned from.
type Textbox = HTMLInputElement | HTMLTextAreaElement;
const learned = new Map<string, number>(store.get<[string, number][]>('breeze.words', []));
let learnSave = 0;
// So there is something to offer before anything is learned: everyday English, then app and code words. Ranked below
// your own words and the open files'.
const COMMON_WORDS = [...new Set((
  'about above across actually after again against almost alone along already also although always among another ' +
  'answer anything anyone anywhere appear around asked away back because become been before began begin behind ' +
  'being believe below better between both bring brought build built business called came cannot change check ' +
  'children clear close come coming could country course create current different does doing done down during ' +
  'each early either else enough even ever every everything example face fact family feel find first follow ' +
  'following found from full gave general give given going good great group hand happen hard have having head ' +
  'hear help here high himself hold home house however idea important include instead into issue just keep kind ' +
  'knew know known large last later learn least leave left less letter life light like line list little live long ' +
  'look looking made make making many matter maybe mean might mind minute moment money more morning most mother ' +
  'move much must myself name need never next nice night nothing number often okay once only open order other ' +
  'others otherwise over own part people perhaps person place plan play point possible probably problem public ' +
  'question quick quickly quite rather read ready real really reason remember right room said same saying school ' +
  'second seem seen sentence several should show side since small something sometimes soon sorry sound start ' +
  'state still stop story such sure take taken talk tell than thank thanks that their them themselves then there ' +
  'these they thing things think this those though thought through time today together told tomorrow took toward ' +
  'tried true trying turn under understand until upon used useful using usually very want wanted water week well ' +
  'went were what whatever when where whether which while white whole whose why will with within without word ' +
  'words work working world would write writing wrong year years yesterday young your yourself ' +
  "I'm I've I'll I'd don't doesn't didn't isn't aren't wasn't weren't can't couldn't shouldn't wouldn't won't haven't " +
  "hasn't it's that's there's what's let's you're you've you'll we're we've we'll they're here's " +
  'ability able absolutely accept according actual afraid afternoon agree ahead amazing amount anymore apart ' +
  'appreciate approach area arrive article asking attention available avoid aware awesome basic basically ' +
  'beautiful beginning best black blue body book bottom brief broken busy calm care careful carefully case ' +
  'cause certain certainly chance character cheap choice choose city clearly clever closer color common company ' +
  'complete completely concern condition consider continue control cool cost couple creating customer date dead ' +
  'deal dear decide decided decision deep definitely depend describe detail details develop difference ' +
  'difficult direction directly discuss doubt draw dream drive easy easily edge effect effort entire especially ' +
  'evening eventually everybody everyone everywhere exact exactly except excited expect expected experience ' +
  'explain extra fail fair fall fast favorite feeling figure final finally fine finish finished focus force ' +
  'forget forward free friend friends front future game getting goal gone green grow guess half happy hate ' +
  'heard hello helpful hope hour hours huge human hundred imagine immediately improve inside instance ' +
  'interesting join kept lead level likely listen love lower major manage mark meet meeting member mention ' +
  'middle miss mistake modern month months moving music natural nearly necessary nobody normal note notice ' +
  'obviously offer office online original outside overall perfect perfectly picture piece please pleased plus ' +
  'power prefer pretty price process produce provide purpose rate reach reply report require result rest rule ' +
  'safe scene sense serious share short simple simply single slow slowly social someone somewhere special speed ' +
  'spend stand step stuff suggest suppose surprise team terrible thousand tired total touch track typical ' +
  'unless upset usual various wait walk watch weekend welcome wish wonder wonderful worry worse worst yeah ' +
  'account action ' +
  'active add added adding address agent agents allow animation application apply array assets async attach audio ' +
  'await backend background branch break browser buffer bug button cache call callback cancel changes class clean ' +
  'click client clone code command comment commit component config configure connect console const content ' +
  'context copy correct crash css data database debug default define delete deploy design dialog directory ' +
  'disable display document download dropdown editor element empty enable endpoint error event export extension ' +
  'feature fetch field file files filter fix folder font format frontend function github handle handler header ' +
  'height hidden history hover html icon image implement import index input install interface item javascript ' +
  'json key layout library limit link loading local logic login logout main menu merge message method model ' +
  'module notification null object option output package padding page parameter password path performance ' +
  'permission pixel plugin popup position preview private project prompt property pull push query react readme ' +
  'refactor refresh release remove rename render repository request reset response return review route run save ' +
  'screen script scroll search select selected server session setting settings setup shortcut sidebar size source ' +
  'spacing string style submit support switch sync system table task template terminal test testing text theme ' +
  'title toggle token tooltip transition type typescript update upload user value variable version view width ' +
  'window workspace abort access adapter admin alert algorithm alias align analytics android anchor annotation ' +
  'argument arguments assert asset attribute auth authentication authorization automatic avatar backup badge ' +
  'banner base batch benchmark binary bind blob block boolean border boundary breakpoint bucket bundle cached ' +
  'canvas caption card cards carousel certificate channel chart checkbox checkout chunk cleanup clipboard ' +
  'closure cluster collapse collection column columns compile compiler compress concurrency connection constant ' +
  'constructor container controller cookie coordinate counter coverage credentials cursor dashboard dataset ' +
  'debounce debugger declaration decode decorator dependency dependencies deprecated desktop destroy ' +
  'development device diff docker docs domain draft drag drawer duplicate dynamic electron emoji encode ' +
  'encoding encrypt entry enum environment escape exception execute expand expression extend fallback filename ' +
  'flag flex float footer fork form frame framework gateway generate generic gesture gradient graph grid hash ' +
  'heading helper highlight hook host hosting href http https iframe immutable increment infinite inherit ' +
  'initialize inline insert integer integration iterate iterator label lambda latency launch layer lazy length ' +
  'lifecycle linter linux listener load loader locale lock logger logging loop macos manifest margin markdown ' +
  'match memory metadata middleware migrate migration mobile mock modal mount namespace native navbar ' +
  'navigation network node nodejs offline offset onboarding opacity optimize overflow overlay pagination panel ' +
  'parse parser patch payload pipeline placeholder platform pointer polling port preload primary production ' +
  'profile promise props protocol provider proxy python queue radius random range ratio redirect regex register ' +
  'regression remote renderer repo resize resolve responsive restart retry router runtime rust sandbox sanitize ' +
  'schema scope screenshot secret secure selector serialize service shadow signal signup slider snapshot socket ' +
  'sort spinner sqlite stack staging static status storage stream struct subscribe swift tabs tailwind thread ' +
  'throttle timeout timer timestamp toast toolbar transform tree trigger tuple typo undo unicode uninstall unit ' +
  'upgrade username utility validate validation vector viewport vite warning webhook websocket widget windows ' +
  'wrapper yaml zoom ' +
  // The forms a request takes (suggested, suggestions, improving), and the rest of everyday writing.
  'accepted accepts achieve achieved adds adjust adjusted affect affected affects allowed allowing allows alternative ' +
  'alternatively anybody anyway applied applies applying appears approve approved arrange asks assume assumed assuming ' +
  'attached attempt attempted avoided based becomes behave behaves behavior behaviour belongs benefit beside besides ' +
  'beyond bigger bit blank bold borders boxes breaks breaking broke brings builds calculate calculated calls cases ' +
  'categories category caused causes causing center centered changed changing chat chats checked checking checks ' +
  'chosen cleaner clearer clicked clicking clicks closed closes closing collapsed combine combined comes compared ' +
  'comparing comparison completed complex concept confirm confirmed confused confusing connected consistent contains ' +
  'continued continues controls convert converted copied corner corners correctly covered covers created creates ' +
  'crashed crashes crashing currently custom cut decrease deleted deleting delay demo depends described description ' +
  'designed designs detected determine developer developers differences differently disabled disappear disappeared ' +
  'disappears displayed displays documentation drop dropped edges edit edited editing efficient elements ended ends ' +
  'english enter entered errors etc events examples existing expanded expects explained explaining explanation ' +
  'explicitly extremely fails failed failing feedback feels fewer fields filled filtered finds fits fixed fixes ' +
  'fixing flicker flickers flow focused folders follows fonts forgot forms functions further furthermore gap gaps ' +
  'generated generates gets gives goals goes grows guide handled handles happened happening happens helps helpers ' +
  'hides hiding hints hit holds hopefully icons ideally ideas ignore ignored ignores images imported improved ' +
  'improvement improvements improving included includes including inconsistent increase increased info information ' +
  'inputs installed instructions interaction issues items itself jumps keeps keys knows labels language larger ' +
  'lately latest latter learned leaves let lets lighter likes limited limits lines links listed lists loaded loads ' +
  'logs longer looked looks lose losing lost mainly makes manual manually margins matched matches matching means ' +
  'meant menus merged messages methods minimal missed missing mixed mode modes modules mostly moved moves multiple ' +
  'names needed needs nested newer noticed odd older onto opened opening opens options ordered overlap overlapping ' +
  'pages parts paste pasted pattern patterns picked placed points popups possibly potentially preferences ' +
  'preferred pressed prevent prevents previous previously problems projects proper properly questions randomly ' +
  'rarely readable realized reasons received recent recently recommend recommended reduce reduced regardless ' +
  'regarding related relevant reliable reloaded remembered removed removes removing renamed rendered rendering ' +
  'repeated replaced replies reported requested requests required requires requirements resized resolved restarted ' +
  'results returned returns reused reverted rows rules runs running safer saved saves saw says screens scrolled ' +
  'scrolling sections seems selecting sends sent separate separately sets shape shapes shorter shortcuts showed ' +
  'showing shown shows similar similarly simpler slightly slower smaller smooth smoother snippet solid solution ' +
  'solutions solved somehow somewhat sorted sounds specific specifically stable standard started starts states stays ' +
  'steps stopped stops stored strange strings strongly structure stuck styles submitted subtle successful ' +
  'successfully suddenly suggested suggestion suggestions suggests summary supported supports switched takes tasks ' +
  'temporarily terms tested tests therefore thus tiny titles tools tries triggered turned turns typed typing ugly ' +
  'unclear unexpected unfortunately unlike unused updated updates updating usage users uses values variables versions ' +
  'views visible visual warnings ways weird whenever wherever wide wondering workflow works worked wrapped writes ' +
  'written wrote yet receive'
).split(' '))]; // once each, at its first (most common) place
function isTextbox(el: EventTarget | null): el is Textbox {
  const ok = el instanceof HTMLTextAreaElement ? !el.classList.contains('code-input')
    : el instanceof HTMLInputElement && ['text', 'search'].includes(el.type) && el !== termInput && !el.matches('#qoIn, .cmd-in, .menu input'); // those two arrow through their own lists
  return ok && !(el as Textbox).readOnly && !(el as Textbox).disabled;
}
// Which word follows which, so after a word the list offers the next, like a search box: keyed by the one word before
// ("the") and by the two before ("fix the"), which say far more. Learned ones count three times a seed. The seeds are
// everyday requests, so there is something to offer before anything is learned.
const pairs = new Map<string, Map<string, number>>();
const addPair = (a: string, b: string, n: number) => { const m = pairs.get(a) ?? new Map<string, number>(); m.set(b, (m.get(b) ?? 0) + n); pairs.set(a, m); };
const SEED_TEXT = [
  'can you help me fix the bug in the login page', 'can you please add a button to the settings page', 'please make the sidebar collapsible',
  'i want to add dark mode to the app', 'how do i run the tests', 'what does this function do', 'explain how this code works',
  'refactor the code to use async await', 'write a test for the parser', 'update the readme with the new commands',
  'remove the unused imports', 'rename the variable to something clearer', 'it still does not work', 'the build is failing again',
  'show me the error message', 'thank you so much', 'let me know if you have any questions', 'add a fade transition to the menu',
  'make it look better on mobile', 'fix the layout on small screens', 'create a new file for the component',
  'move the logic into a helper function', 'check why the page is slow', 'the app crashes when i click the button',
  'i think the problem is in the server', 'can you make it faster', 'use the same style as the other buttons', 'keep the old behavior',
  'do not change the api', 'commit the changes and open a pull request', 'what is the best way to do this', 'is there a better way',
  'it should work like the other one', 'when the user clicks the button it should open the dialog', 'add error handling for the network request',
  'the text is too small', 'the icon is not showing', 'replace the logo with the new one', 'this is a good idea', 'i would like to know',
  'we need to talk about the design', 'you can use the existing helper', 'i need to deploy the website', 'make sure the tests pass',
  'can you explain why this happens', 'why does the test fail', 'where is this function used', 'add a loading spinner while the data loads',
  'show a toast when the file is saved', 'split this file into smaller modules', 'add types to the function', 'run the build and fix the errors',
  'the button should be disabled while it loads', 'scroll to the bottom when a new message comes in', 'save the settings when the window closes',
  'look at the logs and tell me what went wrong', 'it works on my machine but not in production', 'add a keyboard shortcut for this',
  'the dropdown closes too fast', 'can we undo the last change', 'go back to the previous version', 'try a different approach',
  'that looks great', 'good job', 'that is not what i meant', 'start the dev server', 'install the missing package',
  'write the docs for the new feature', 'add a search box to the list', 'sort the list by date', 'keep it simple',
  'do the same for the other files', 'make the colors match the theme', 'center the text in the header', 'hide the scrollbar',
  'add a confirm dialog before deleting', 'the request times out after a few seconds', 'cache the result so it loads faster',
  "i don't know why this happens", "it doesn't work", "i'm not sure what you mean", "that's not what i meant", "it's still broken",
  "don't change anything else", "i think it's fixed now", "let's try something else", "can't find the file", "what's wrong with this",
].join(' . ');
const SEED_WORDS = SEED_TEXT.split(' ');
const seedPairs = new Map<string, number>();
const seedPair = (a: string, b: string) => { addPair(a, b, 1); seedPairs.set(`${a} ${b}`, (seedPairs.get(`${a} ${b}`) ?? 0) + 1); };
SEED_WORDS.forEach((w, i) => {
  const next = SEED_WORDS[i + 1], prev = SEED_WORDS[i - 1];
  if (!next || w === '.' || next === '.') return;
  seedPair(w, next);
  if (prev && prev !== '.') seedPair(`${prev} ${w}`, next);
});
for (const [a, b, n] of store.get<[string, string, number][]>('breeze.pairs', [])) addPair(a, b, n * 3);
let pairSave = 0;
const secretField = (el: Textbox) => /key|token|secret|pass/i.test(`${el.id} ${el.name} ${el.placeholder} ${el.getAttribute('aria-label') ?? ''}`);
function learnWord(word: string, prev?: string, prev2?: string): void {
  if (/\d/.test(word) || word.length > 30) return;
  if (prev && !/\d/.test(prev)) {
    addPair(prev.toLowerCase(), word.toLowerCase(), 3);
    if (prev2) addPair(`${prev2.toLowerCase()} ${prev.toLowerCase()}`, word.toLowerCase(), 3);
    clearTimeout(pairSave);
    // Only the learned share is saved: the seeds come from the list above on every run.
    pairSave = window.setTimeout(() => {
      const out: [string, string, number][] = [];
      for (const [a, m] of pairs) for (const [w, n] of m) { const own = Math.round((n - (seedPairs.get(`${a} ${w}`) ?? 0)) / 3); if (own >= 1) out.push([a, w, own]); }
      store.set('breeze.pairs', out.sort((x, y) => y[2] - x[2]).slice(0, 6000));
    }, 1000);
  }
  if (word.length < 3) return;
  learned.set(word, (learned.get(word) ?? 0) + 1);
  clearTimeout(learnSave);
  learnSave = window.setTimeout(() => store.set('breeze.words', [...learned].sort((a, b) => b[1] - a[1]).slice(0, 2000)), 1000);
}
// Every word of `text`, each with the one before it. Punctuation ends a run; @mentions, /commands, #refs, numbers and
// code aren't words and end one too.
function learnText(text: string): void {
  let prev: string | undefined, prev2: string | undefined;
  for (const token of text.split(/\s+/)) {
    const m = /^["'(\[]*([A-Za-z](?:[\w'-]*\w)?)([^\w\s]*)$/.exec(token);
    if (!m || /\d/.test(m[1])) { prev = prev2 = undefined; continue; }
    learnWord(m[1], prev, prev2);
    [prev2, prev] = m[2] ? [undefined, undefined] : [prev, m[1]];
  }
}
// What you send is your wording: a box is learned from when Enter sends it or you leave it, not keystroke by keystroke,
// so fixed typos and pasted text count as they end up. Only what's new since the last time is learned.
const learnedText = new WeakMap<Textbox, string>();
function commitTextbox(el: Textbox): void {
  const v = el.value, old = learnedText.get(el) ?? '';
  if (v === old || secretField(el)) return;
  learnedText.set(el, v);
  let cut = v.startsWith(old) ? old.length : 0;
  while (cut > 0 && /[\w'-]/.test(v[cut - 1])) cut--; // a word that was half typed last time is learned whole
  learnText(v.slice(cut));
}
// Once: the requests in your saved chats, so the suggestions sound like you from the start.
if (!store.get('breeze.wordsFromChats', false)) {
  store.set('breeze.wordsFromChats', true);
  requestIdleCallback(() => {
    try {
      for (const key of Object.keys(localStorage).filter(k => k.startsWith('breeze.history:'))) {
        for (const chat of store.get<{ html?: string }[]>(key, [])) {
          if (!chat.html) continue;
          for (const msg of new DOMParser().parseFromString(chat.html, 'text/html').querySelectorAll('.msg.user .body')) learnText(msg.textContent ?? '');
        }
      }
    } catch { /* storage blocked: start from the seeds */ }
  });
}
const commonRank = new Map(COMMON_WORDS.map((w, i) => [w, 1 - i / COMMON_WORDS.length]));
// Every language's keywords and built-ins: an open file's `const` and `return` are no words for a message.
const CODE_WORDS = new Set(Object.values(EDITOR_WORDS).flat());
const DICTIONARY = [...new Set([...COMMON_WORDS, ...SEED_WORDS].map(w => w.toLowerCase()))];
const inDictionary = new Set(DICTIONARY);
const typos = new Map<string, boolean>();
// A word sent once that isn't in the lists but is one letter off one that is: a typo (teh, recieve), not offered back.
// Sent again, it's meant (lint next to line).
function typo(w: string): boolean {
  const k = w.toLowerCase();
  if (inDictionary.has(k)) return false;
  if (!typos.has(k)) typos.set(k, DICTIONARY.some(d => oneEditApart(k, d)));
  return typos.get(k)!;
}
// Words that finish `prefix`, the ones that often follow `prev` (and `prev2` before it) first. With no prefix, only those.
function textboxCandidates(prefix: string, prev?: string, prev2?: string): Suggestion[] {
  const lower = prefix.toLowerCase(), words = new Map<string, number>();
  const next = prev ? pairs.get(prev.toLowerCase()) : undefined;
  const next2 = prev && prev2 ? pairs.get(`${prev2.toLowerCase()} ${prev.toLowerCase()}`) : undefined;
  if (prefix) {
    COMMON_WORDS.forEach((w, i) => words.set(w, 0.9 - i / COMMON_WORDS.length / 2));
    // Each time a word comes up in the seeds lifts it ("can", "the"), but one mention doesn't put "confirm" over "could".
    for (const w of SEED_WORDS) if (w !== '.') words.set(w, Math.min(1.5, Math.max(words.get(w) ?? 0, 0.6) + 0.15));
    for (const [w, n] of learned) if (w.toLowerCase().startsWith(lower) && (n > 1 || !typo(w))) words.set(w, n * 3);
    // The open files' names you may mention, by how often they're used, but never above the words you write yourself.
    const named = new Map<string, number>();
    for (const b of buffers.values()) if (b.kind === 'text') for (const [w, n] of fileWords(b)) if (!CODE_WORDS.has(w) && w.toLowerCase().startsWith(lower)) named.set(w, (named.get(w) ?? 0) + n);
    for (const [w, n] of named) words.set(w, (words.get(w) ?? 0) + Math.min(1, Math.log2(1 + n) / 5));
  }
  // Ties between next words go to the more common one ("help" over "so" after "can you"). A typo learned with its
  // neighbours stays out here too.
  const meant = (w: string) => (learned.get(w) ?? 0) > 1 || !typo(w);
  for (const [w, n] of next ?? []) if (meant(w)) words.set(w, (words.get(w) ?? 0) + n * 10 + (commonRank.get(w) ?? 0));
  for (const [w, n] of next2 ?? []) if (meant(w)) words.set(w, (words.get(w) ?? 0) + n * 25);
  // Your own spelling of a word ("React", "GitHub") over the lowercase one the pairs and the lists keep; "i" is "I".
  const form = new Map<string, [string, number]>();
  for (const [w, n] of learned) { const k = w.toLowerCase(), f = form.get(k); if (!f || n > f[1]) form.set(k, [w, n]); }
  const spell = (w: string) => form.get(w.toLowerCase())?.[0] ?? (/^i(?:'|$)/.test(w) ? `I${w.slice(1)}` : w); // i'm → I'm
  return [...words]
    .filter(([w]) => w.length > prefix.length && w.toLowerCase().startsWith(lower))
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .filter(([w], i, all) => all.findIndex(([x]) => x.toLowerCase() === w.toLowerCase()) === i) // "Hello" and "hello" once
    .slice(0, 6)
    .map(([w]) => spell(w))
    .map(w => ({ text: /^[A-Z]/.test(prefix) && /^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w })); // "He" offers "Hello"
}
// Where `pos` sits on screen: measured in a hidden copy of a textarea, or by text width in a one-line input.
function caretBox(el: Textbox, pos: number): { x: number; top: number; bottom: number } {
  const cs = getComputedStyle(el), r = el.getBoundingClientRect();
  if (el instanceof HTMLInputElement) {
    const x = r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft) + textWidth(el.value.slice(0, pos), el) - el.scrollLeft;
    return { x, top: r.top, bottom: r.bottom };
  }
  const copy = document.createElement('div'), mark = document.createElement('span');
  copy.style.cssText = `position:fixed;left:0;top:0;visibility:hidden;white-space:pre-wrap;overflow-wrap:break-word;box-sizing:border-box;width:${r.width}px;font:${cs.font};letter-spacing:${cs.letterSpacing};line-height:${cs.lineHeight};padding:${cs.padding};border:${cs.border}`;
  copy.textContent = el.value.slice(0, pos);
  mark.textContent = '​';
  copy.append(mark);
  document.body.append(copy);
  const m = mark.getBoundingClientRect();
  copy.remove();
  return { x: r.left + m.left, top: r.top + m.top - el.scrollTop, bottom: r.top + m.bottom - el.scrollTop };
}
let textboxAccepting = false;
// The word being typed (two letters at least) or, right after a word and a space, the next word (autofillcore.ts).
function textboxSuggest(el: Textbox): void {
  const pos = el.selectionStart ?? 0;
  const ctx = textboxContext(el.value.slice(Math.max(0, pos - 80), pos), el.value.slice(pos, pos + 1));
  const prefix = ctx?.prefix ?? '';
  const items = ctx ? textboxCandidates(prefix, ctx.prev, ctx.prev2) : [];
  if (!items.length) { if (suggest?.owner === el) hideSuggest(); return; }
  const from = pos - prefix.length, at = caretBox(el, from);
  showSuggest({
    owner: el, items, sel: 0, typed: prefix.length,
    accept: s => {
      hideSuggest();
      el.setSelectionRange(from, el.selectionStart ?? pos);
      textboxAccepting = true;
      // The word and a space, then on to the next word. execCommand keeps Ctrl+Z and fires 'input' for the field's own listeners.
      document.execCommand('insertText', false, el.value[el.selectionEnd ?? pos] === ' ' ? s.text : `${s.text} `);
      textboxAccepting = false;
      textboxSuggest(el);
    },
  }, at.x - 8, at.bottom + 4, at.top - 4);
}
document.addEventListener('input', e => {
  const el = e.target;
  if (!isTextbox(el) || textboxAccepting) return;
  const ie = e as InputEvent, pos = el.selectionStart ?? 0;
  if (ie.inputType !== 'insertText' || el.selectionEnd !== pos) { if (suggest?.owner === el) hideSuggest(); return; }
  textboxSuggest(el);
});
document.addEventListener('keydown', e => {
  const el = e.target;
  if (!isTextbox(el)) return;
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    commitTextbox(el); // before the field's own Enter sends and clears it
    setTimeout(() => { if (!el.value) learnedText.delete(el); }); // sent: the next message is all new, even if it's the same
  }
  if (suggest?.owner !== el) return;
  if (e.key === 'Enter') hideSuggest(); else suggestKeys(e, el);
}, true); // before the field's own keys, so Tab and the arrows reach the list first
document.addEventListener('focusout', e => {
  if (!isTextbox(e.target)) return;
  commitTextbox(e.target);
  if (suggest?.owner === e.target) hideSuggest();
});
