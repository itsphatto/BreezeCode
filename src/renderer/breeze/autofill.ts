/* ================= Autofill ================= */
// One suggestion list, used by the code editor (words and keywords) and the terminal (files, commands, history).
// insert/from: a language server's completion, which may insert other text than its label, from another spot.
interface Suggestion { text: string; hint?: string; insert?: string; from?: number; }
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
    return `<div class="${i === sel ? 'on' : ''}" data-sg="${i}" role="option"><span><b>${esc(s.text.slice(0, typed))}</b>${esc(s.text.slice(typed))}</span>${hint}</div>`;
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
function hideSuggest(): void {
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
};
// Word counts per open file, refreshed at most every second and a half while typing.
const wordCache = new WeakMap<EditorBuffer, { at: number; counts: Map<string, number> }>();
function fileWords(b: EditorBuffer): Map<string, number> {
  const cached = wordCache.get(b);
  // Big files are counted less often: the count takes longer and a few new words barely change it.
  if (cached && Date.now() - cached.at < Math.max(1500, b.text.length / 50)) return cached.counts;
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
  // The word being typed counts once in the file; it isn't a suggestion by itself.
  return [...words]
    .filter(([w, n]) => w.toLowerCase().startsWith(lower) && w !== prefix && !(n === 1 && counts.get(w) === 1 && w.startsWith(prefix)))
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
  if (!ta || ta.selectionStart !== ta.selectionEnd) { hideSuggest(); return; }
  const prefix = wordBefore(ta);
  const pos = ta.selectionStart, ls = lineStart(b.text, pos), line = b.text.slice(ls, pos);
  // Right after a "." the language server lists the members.
  const lsp = lspOn.has(b.path), member = lsp && b.text[pos - prefix.length - 1] === '.';
  if (prefix.length < (force || member ? 0 : 2)) { hideSuggest(); return; }
  const cw = measureChar();
  const r = ta.getBoundingClientRect();
  const x = r.left + 4 + visualCol(line, pos - ls - prefix.length) * cw - ta.scrollLeft;
  const top = r.top + 10 + lineAt(b.text, pos) * LINE_H - ta.scrollTop;
  // Only where nothing follows on the line, so the hint never covers real text.
  const lineEnd = b.text.indexOf('\n', pos);
  const clear = !b.text.slice(pos, lineEnd < 0 ? undefined : lineEnd).trim();
  const ghost = () => {
    const s = suggest?.items[suggest.sel], t = s?.insert ?? s?.text;
    editorGhost.textContent = clear && s?.from == null && t?.startsWith(prefix) ? t.slice(prefix.length) : '';
    editorGhost.style.left = `${r.left + 4 + visualCol(line, pos - ls) * cw - ta.scrollLeft}px`;
    editorGhost.style.top = `${top}px`;
    // A half-typed line is usually a syntax error; its message would sit under the ghost text.
    $('#editor').classList.add('suggesting');
  };
  const show = (items: Suggestion[]) => showSuggest({
    owner: ta.input, items, sel: 0, typed: prefix.length,
    accept: s => { hideSuggest(); replaceRange(ta, s.from ?? pos - prefix.length, ta.selectionStart, s.insert ?? s.text); },
    onRender: ghost,
  }, x - 8, top + LINE_H + 2, top - 2);
  const words = member ? [] : editorCandidates(b, prefix);
  if (words.length) show(words); else hideSuggest();
  if (!lsp) return;
  // The server's answer comes first, then the file's words it didn't have. Dropped if the user moved on.
  const ask = ++lspAsk, text = b.text;
  void lspCompletions(b, pos, prefix).then(items => {
    if (ask !== lspAsk || b.text !== text || ta.selectionStart !== pos || document.activeElement !== ta.input || !items.length) return;
    const seen = new Set(items.map(s => s.text));
    show([...items, ...words.filter(w => !seen.has(w.text))].slice(0, 14));
  });
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

