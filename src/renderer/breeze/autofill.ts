/* ================= Autofill ================= */
// One suggestion list, used by the code editor (words and keywords) and the terminal (files, commands, history).
// insert/from: a language server's completion, which may insert other text than its label, from another spot.
// run: does its own thing instead of inserting; plain: the typed prefix is not part of its label, so none of it is bolded.
interface Suggestion { text: string; hint?: string; insert?: string; from?: number; run?: () => void; plain?: boolean; }
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
function renderSuggest(): void {
  if (!suggest) return;
  const { items, sel, typed } = suggest;
  suggestEl.innerHTML = items.map((s, i) => {
    const hint = s.hint ? `<small>${esc(s.hint)}</small>` : '';
    return `<div class="${i === sel ? 'on' : ''}" data-sg="${i}" role="option"><span><b>${esc(s.text.slice(0, s.plain ? 0 : typed))}</b>${esc(s.text.slice(s.plain ? 0 : typed))}</span>${hint}</div>`;
  }).join('');
  suggestEl.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  suggest.onRender?.();
}
// Shows suggestions under (x, y), or above `above` when they don't fit below.
function showSuggest(state: SuggestState, x: number, y: number, above: number): void {
  if (!state.items.length) { hideSuggest(); return; }
  suggest = state;
  renderSuggest();
  suggestEl.classList.remove('hidden');
  const h = suggestEl.offsetHeight, w = suggestEl.offsetWidth;
  suggestEl.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
  suggestEl.style.top = `${y + h > innerHeight - 8 ? Math.max(8, above - h) : y}px`;
}
// Counts closes, so a late answer (the Emmet preview) can tell the list was closed after it was asked for.
let suggestHidden = 0;
function hideSuggest(): void {
  suggestHidden++;
  suggest = null;
  suggestEl.classList.add('hidden');
  editorGhost.textContent = '';
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
const wordCache = new WeakMap<EditorBuffer, { at: number; counts: Map<string, number> }>();
function fileWords(b: EditorBuffer): Map<string, number> {
  const cached = wordCache.get(b);
  // Big files are counted less often: the count takes longer and a few new words barely change it.
  if (cached && Date.now() - cached.at < Math.max(150, b.text.length / 50)) return cached.counts;
  const counts = new Map<string, number>();
  for (const m of b.text.slice(0, LINT_MAX).matchAll(/[A-Za-z_$][\w$-]{2,}/g)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  wordCache.set(b, { at: Date.now(), counts });
  return counts;
}
function editorCandidates(b: EditorBuffer, prefix: string): Suggestion[] {
  const counts = fileWords(b);
  const lower = prefix.toLowerCase();
  const words = new Map<string, number>();
  for (const w of EDITOR_WORDS[langOf(b.path)[0]] ?? []) words.set(w, 1000);
  for (const [w, n] of counts) words.set(w, (words.get(w) ?? 0) + n);
  // The word being typed is in the file too; it isn't a suggestion by itself. (A word written once elsewhere still is.)
  return [...words]
    .filter(([w]) => w.toLowerCase().startsWith(lower) && w !== prefix)
    .sort((a, b2) => Number(b2[0].startsWith(prefix)) - Number(a[0].startsWith(prefix)) || b2[1] - a[1] || a[0].length - b2[0].length)
    .slice(0, 8)
    .map(([w, n]) => ({ text: w, hint: n >= 1000 ? 'keyword' : '' }));
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
  const show = (items: Suggestion[]) => {
    listed = items;
    showSuggest({
      owner: ta.input, items: emmetItem ? [emmetItem, ...items] : items, sel: 0, typed: prefix.length,
      accept: s => {
        hideSuggest();
        if (s.run) s.run(); else replaceRange(ta, s.from ?? pos - prefix.length, ta.selectionStart, s.insert ?? s.text);
      },
      onRender: ghost,
    }, x - 8, top + LINE_H + 2, top - 2);
  };
  const words = member || short ? [] : editorCandidates(b, prefix);
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
const COMMON_WORDS = (
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
  'words work working world would write writing wrong year years yesterday young your yourself account action ' +
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
  'window workspace'
).split(' ');
function isTextbox(el: EventTarget | null): el is Textbox {
  const ok = el instanceof HTMLTextAreaElement ? !el.classList.contains('code-input')
    : el instanceof HTMLInputElement && ['text', 'search'].includes(el.type) && el !== termInput && !el.matches('#qoIn, .menu input'); // those two arrow through their own lists
  return ok && !(el as Textbox).readOnly && !(el as Textbox).disabled;
}
// Which word follows which, so after one word the list offers the next, like a search box. Learned pairs count three
// times a seed pair. The seeds are everyday requests, so there is something to offer before anything is learned.
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
].join(' . ');
const SEED_WORDS = SEED_TEXT.split(' ');
const seedPairs = new Map<string, number>();
SEED_WORDS.forEach((w, i) => {
  const next = SEED_WORDS[i + 1];
  if (!next || w === '.' || next === '.') return;
  addPair(w, next, 1);
  seedPairs.set(`${w} ${next}`, (seedPairs.get(`${w} ${next}`) ?? 0) + 1);
});
for (const [a, b, n] of store.get<[string, string, number][]>('breeze.pairs', [])) addPair(a, b, n * 3);
let pairSave = 0;
const secretField = (el: Textbox) => /key|token|secret|pass/i.test(`${el.id} ${el.name} ${el.placeholder} ${el.getAttribute('aria-label') ?? ''}`);
function learnWord(word: string, prev?: string): void {
  if (/\d/.test(word) || word.length > 30) return;
  if (prev && !/\d/.test(prev)) {
    addPair(prev.toLowerCase(), word.toLowerCase(), 3);
    clearTimeout(pairSave);
    // Only the learned share is saved: the seeds come from the list above on every run.
    pairSave = window.setTimeout(() => {
      const out: [string, string, number][] = [];
      for (const [a, m] of pairs) for (const [w, n] of m) { const own = Math.round((n - (seedPairs.get(`${a} ${w}`) ?? 0)) / 3); if (own >= 1) out.push([a, w, own]); }
      store.set('breeze.pairs', out.sort((x, y) => y[2] - x[2]).slice(0, 3000));
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
  let prev: string | undefined;
  for (const token of text.split(/\s+/)) {
    const m = /^["'(\[]*([A-Za-z](?:[\w'-]*\w)?)([^\w\s]*)$/.exec(token);
    if (!m || /\d/.test(m[1])) { prev = undefined; continue; }
    learnWord(m[1], prev);
    prev = m[2] ? undefined : m[1];
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
// Words that finish `prefix`, the ones that often follow `prev` first. With no prefix, only the ones that follow `prev`.
function textboxCandidates(prefix: string, prev?: string): Suggestion[] {
  const lower = prefix.toLowerCase(), words = new Map<string, number>(), next = prev ? pairs.get(prev.toLowerCase()) : undefined;
  if (prefix) {
    COMMON_WORDS.forEach((w, i) => words.set(w, 0.9 - i / COMMON_WORDS.length / 2));
    for (const w of SEED_WORDS) if (w !== '.') words.set(w, Math.min(1.5, Math.max(words.get(w) ?? 0, 0.8) + 0.1)); // "can" and "the" by how often they come up
    for (const [w, n] of learned) words.set(w, n * 3);
    for (const b of buffers.values()) if (b.kind === 'text') for (const [w, n] of fileWords(b)) words.set(w, (words.get(w) ?? 0) + n);
  }
  // Ties between next words go to the more common one ("help" over "so" after "can you").
  for (const [w, n] of next ?? []) words.set(w, (words.get(w) ?? 0) + n * 10 + (commonRank.get(w) ?? 0));
  // Your own spelling of a word ("React", "GitHub") over the lowercase one the pairs and the lists keep; "i" is "I".
  const form = new Map<string, [string, number]>();
  for (const [w, n] of learned) { const k = w.toLowerCase(), f = form.get(k); if (!f || n > f[1]) form.set(k, [w, n]); }
  const spell = (w: string) => form.get(w.toLowerCase())?.[0] ?? (w === 'i' ? 'I' : w);
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
// The word being typed (two letters at least) or, right after a word and a space, the next word.
function textboxSuggest(el: Textbox): void {
  const pos = el.selectionStart ?? 0;
  const before = el.value.slice(Math.max(0, pos - 80), pos);
  // @mentions, /commands and #refs have their own menus; mid-word typing gets none.
  const m = /(?:^|[^@/#\w'-])(?:([A-Za-z][\w'-]*) )?([A-Za-z][\w'-]*)?$/.exec(before);
  const prefix = m?.[2] ?? '', prev = m?.[1];
  const ok = m && (prefix ? prefix.length >= 2 : !!prev && before.endsWith(' ')) && !/[\w'-]/.test(el.value[pos] ?? '');
  const items = ok ? textboxCandidates(prefix, prev) : [];
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
