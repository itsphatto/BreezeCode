/* ================= Debugger: variables, watch, console and output ================= */
// The page's right column (the selected frame's variables, and watch expressions), its bottom tabs (the program's
// output with an input line for its stdin, and the Debug Console), values on hover in the source, and "Run to Here".
// Names, values, types and output all come from the program, so they go in as text: esc() in html, textContent else.

/* ----- Values as trees ----- */
// A row of a tree: a scope, a variable, a watch expression or a console result. Children are read when a row is
// first opened. Rows stay open across pauses by their key (the path of names from the root), and a variable whose
// value differs from the last pause's is marked changed.
interface DbgNode {
  key: string;
  name: string; value: string; type: string; ref: number;
  owner: number;      // the ref of the scope or object it belongs to, for setValue; 0 when it can't be changed here
  kids?: DbgNode[];   // read when first opened
  kidsErr?: string;   // why they couldn't be read
  loading?: boolean;
  err?: string;       // a watch or console expression that failed: the error shows in place of the value
  changed?: boolean;
  watch?: string;     // a watch row: its expression
  idle?: boolean;     // a watch row while the program isn't paused: no value to show
}
interface DbgTree { el: HTMLElement; roots: DbgNode[]; byKey: Map<string, DbgNode>; empty: () => string; track: boolean; }
const DBG_KIDS_MAX = 500;   // children drawn per row; the rest are counted
const DBG_VALUE_MAX = 2000; // characters of a value drawn in a row; the tooltip has more
const dbgOpen = new Map<string, boolean>(); // key → opened or closed by hand; scopes start open but Globals, the rest closed
const dbgTrees = new WeakMap<HTMLElement, DbgTree>();
// Bumped on every pause, frame change and resume: answers to the questions asked before are dropped.
let dbgValSeq = 0;
// Values by frame and key, this pause's and the last one's, for the "changed" mark.
let dbgSeen = new Map<string, string>();
let dbgPrev = new Map<string, string>();

const dbgKeyOf = (parent: string, name: string) => `${parent}/${encodeURIComponent(name)}`;
const dbgFrameKey = () => { const f = debugFrames[debugFrameIdx]; return f ? `${f.file ?? ''}:${f.name}:` : ''; };
// Locals (and Node's block and closure scopes, where a loop's variable or a callback's outer ones live) start open.
const dbgIsOpen = (n: DbgNode) => n.ref > 0 && (dbgOpen.get(n.key) ?? (n.type === 'scope' && n.key.startsWith('v/') && n.name !== 'Globals'));
// Python's errors come as a whole traceback: its last line says what went wrong. Node's are one line already.
function dbgErr(e: unknown): string {
  const lines = errMsg(e).split('\n').map(l => l.trim()).filter(Boolean);
  return (lines[0]?.startsWith('Traceback') ? lines.at(-1) : lines[0]) ?? 'Something went wrong';
}
// `seq`: the values are this pause's (they count for "changed"); -1 for values that don't.
function dbgNode(v: DebugValue, key: string, owner: number, seq: number): DbgNode {
  const n: DbgNode = { key, name: v.name, value: v.value, type: v.type, ref: v.ref, owner };
  if (seq >= 0 && seq === dbgValSeq) {
    const k = dbgFrameKey() + key, was = dbgPrev.get(k);
    n.changed = was !== undefined && was !== v.value;
    dbgSeen.set(k, v.value);
  }
  return n;
}
// Reads the children of every open row under `n`, so a tree looks as it did at the last pause.
async function dbgFill(n: DbgNode, seq: number, depth = 0): Promise<void> {
  if (!dbgIsOpen(n) || depth > 8) return;
  try {
    const vs = await api.debug.children(n.ref);
    n.kids = vs.map(v => dbgNode(v, dbgKeyOf(n.key, v.name), n.ref, seq));
    await Promise.all(n.kids.slice(0, DBG_KIDS_MAX).map(k => dbgFill(k, seq, depth + 1)));
  } catch (e) { n.kidsErr = dbgErr(e); }
}

// Colours a value like the editor colours code: strings, numbers, and true/false/None.
function dbgValClass(type: string): string {
  const t = type.toLowerCase();
  if (t === 'str' || t === 'string') return ' tk-str';
  if (['int', 'float', 'number', 'bigint', 'complex', 'decimal'].includes(t)) return ' tk-num';
  if (['bool', 'boolean', 'nonetype', 'null', 'undefined'].includes(t)) return ' tk-kw';
  return '';
}
function dbgRowHtml(n: DbgNode, depth: number): string {
  const open = dbgIsOpen(n), scope = n.type === 'scope' && !n.owner && !n.watch;
  const twisty = n.ref > 0 ? svgIcon(open ? 'chevronDown' : 'chevronRight', 12) : '';
  const name = n.name ? `<span class="dbg-name">${esc(n.name)}</span>` : '';
  const sep = n.name && !scope && (n.value || n.err != null || n.idle) ? '<span class="dbg-colon">:</span>' : ''; // debugpy's groups ("special variables") have no value
  const val = scope ? ''
    : n.err != null ? `<span class="dbg-val dbg-val-err">${esc(n.err)}</span>`
    : n.idle ? '<span class="dbg-val dbg-val-idle">—</span>'
    : `<span class="dbg-val${dbgValClass(n.type)}">${esc(n.value.length > DBG_VALUE_MAX ? `${n.value.slice(0, DBG_VALUE_MAX)}…` : n.value)}</span>`;
  const tip = (scope ? n.name
    : n.err != null ? `${n.name}: ${n.err}`
    : n.idle ? `${n.name}: shows a value when the program pauses`
    : `${n.name ? `${n.name}${n.type ? ` (${n.type})` : ''}: ` : ''}${n.value.slice(0, 4000)}`)
    + (n.owner > 0 ? '\nDouble-click the value to change it.' : n.watch != null ? '\nDouble-click the expression to change it.' : '');
  const rm = n.watch != null ? `<button class="icon-btn dbg-var-x" type="button" data-watch-rm tabindex="-1" aria-label="${escAttr(`Stop watching ${n.watch}`)}" title="Remove">${svgIcon('x', 12)}</button>` : '';
  const cls = ['dbg-var', scope ? 'scope' : '', n.changed ? 'changed' : '', n.watch != null ? 'watch' : ''].filter(Boolean).join(' ');
  return `<div class="${cls}" role="treeitem" tabindex="0" aria-level="${depth + 1}"${n.ref > 0 ? ` aria-expanded="${open}"` : ''} data-key="${escAttr(n.key)}" title="${escAttr(tip)}">${'<i class="dbg-ind"></i>'.repeat(depth)}<span class="dbg-twisty">${twisty}</span>${name}${sep}${val}${rm}</div>`;
}
function drawDbgTree(t: DbgTree): void {
  t.byKey.clear();
  const rows: string[] = [];
  const note = (depth: number, text: string, cls = '') => rows.push(`<div class="dbg-var-note${cls}" role="none">${'<i class="dbg-ind"></i>'.repeat(depth)}<span class="dbg-twisty"></span>${esc(text)}</div>`);
  const walk = (list: DbgNode[], depth: number) => {
    for (const n of list.slice(0, DBG_KIDS_MAX)) {
      t.byKey.set(n.key, n);
      rows.push(dbgRowHtml(n, depth));
      if (!dbgIsOpen(n)) continue;
      if (n.loading) note(depth + 1, 'Loading…');
      else if (n.kidsErr) note(depth + 1, `Couldn't read it: ${n.kidsErr}`, ' err');
      else if (n.kids?.length === 0) note(depth + 1, 'Empty');
      else if (n.kids) walk(n.kids, depth + 1);
    }
    if (list.length > DBG_KIDS_MAX) note(depth, `${list.length - DBG_KIDS_MAX} more not shown`);
  };
  walk(t.roots, 0);
  if (!rows.length) rows.push(`<div class="dbg-empty-row">${t.empty()}</div>`);
  patchRows(t.el, rows);
}
function dbgTree(el: HTMLElement, empty: () => string, track: boolean): DbgTree {
  const t: DbgTree = { el, roots: [], byKey: new Map(), empty, track };
  dbgTrees.set(el, t);
  return t;
}
async function toggleDbgNode(t: DbgTree, n: DbgNode): Promise<void> {
  const open = !dbgIsOpen(n);
  dbgOpen.set(n.key, open);
  if (open && !n.kids && !n.loading) {
    n.loading = true;
    n.kidsErr = undefined;
    drawDbgTree(t);
    const seq = t.track ? dbgValSeq : -1;
    try {
      const vs = await api.debug.children(n.ref);
      n.kids = vs.map(v => dbgNode(v, dbgKeyOf(n.key, v.name), n.ref, seq));
    } catch (e) { n.kidsErr = dbgErr(e); }
    n.loading = false;
  }
  drawDbgTree(t);
}

// One set of listeners for every tree on the page (variables, watch, and each console result), by delegation.
const dbgRowAt = (e: Event) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.dbg-var');
  const t = row ? dbgTrees.get(row.closest<HTMLElement>('.dbg-tree') as HTMLElement) : undefined;
  const n = row && t ? t.byKey.get(row.dataset.key ?? '') : undefined;
  return row && t && n ? { row, t, n } : null;
};
for (const host of [$('#dbgVars'), $('#dbgWatch'), $('#dbgConsole')]) {
  host.addEventListener('click', e => {
    const at = dbgRowAt(e);
    if (!at || (e.target as HTMLElement).closest('input')) return;
    if ((e.target as HTMLElement).closest('[data-watch-rm]')) { removeDbgWatch(at.n.watch as string); return; }
    if (at.n.ref > 0 && e.detail < 2) void toggleDbgNode(at.t, at.n);
  });
  host.addEventListener('dblclick', e => {
    const at = dbgRowAt(e);
    if (!at) return;
    const on = e.target as HTMLElement;
    if (at.n.watch != null && on.closest('.dbg-name')) editDbgWatch(at.row, at.n.watch);
    else if (on.closest('.dbg-val')) editDbgValue(at.t, at.n, at.row);
  });
  host.addEventListener('keydown', e => {
    const at = dbgRowAt(e);
    if (!at || e.target !== at.row) return;
    const { row, t, n } = at;
    const open = dbgIsOpen(n);
    if ((e.key === 'Enter' || e.key === ' ') && n.ref > 0) void toggleDbgNode(t, n);
    else if (e.key === 'ArrowRight' && n.ref > 0 && !open) void toggleDbgNode(t, n);
    else if (e.key === 'ArrowLeft' && open) void toggleDbgNode(t, n);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const rows = $$('.dbg-var', row.closest('.dbg-tree') as HTMLElement);
      rows[rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
    } else if (e.key === 'F2') {
      if (n.watch != null) editDbgWatch(row, n.watch); else editDbgValue(t, n, row);
    } else if (e.key === 'Delete' && n.watch != null) removeDbgWatch(n.watch);
    else return;
    e.preventDefault();
  });
}

// A small text box over part of a row: Enter keeps it, Escape (or no change) drops it, and so does leaving the box.
// `save` resolves to an error to show under the row, or null when done.
function dbgInlineEdit(t: DbgTree, row: HTMLElement, over: HTMLElement, text: string, label: string, save: (v: string) => Promise<string | null>): void {
  const input = document.createElement('input');
  input.className = 'dbg-edit';
  input.value = text;
  input.spellcheck = false;
  input.setAttribute('aria-label', label);
  over.replaceWith(input);
  forgetRow(row); // the row no longer looks like its html: the next draw makes it again
  input.focus();
  input.select();
  const key = row.dataset.key ?? '';
  let busy = false, closed = false;
  const close = (refocus: boolean) => {
    if (closed) return;
    closed = true;
    drawDbgTree(t);
    if (refocus) $$<HTMLElement>('.dbg-var', t.el).find(r => r.dataset.key === key)?.focus();
  };
  const commit = async (refocus: boolean) => {
    if (busy || closed) return;
    if (input.value === text) { close(refocus); return; }
    busy = true;
    const err = await save(input.value);
    busy = false;
    if (!err) { close(refocus); return; }
    input.classList.add('bad');
    let note = row.nextElementSibling as HTMLElement | null;
    if (!note?.classList.contains('dbg-edit-err')) {
      note = document.createElement('div');
      note.className = 'dbg-edit-err';
      note.setAttribute('role', 'alert');
      row.after(note);
    }
    note.textContent = err;
    input.focus();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); void commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); close(true); }
  });
  input.addEventListener('input', () => input.classList.remove('bad'));
  input.addEventListener('blur', () => {
    if (input.classList.contains('bad')) close(false);
    else void commit(false);
  });
}
// Double-click a variable's value: the new value is code in the program's language ("5", "'hi'", "[1, 2]").
function editDbgValue(t: DbgTree, n: DbgNode, row: HTMLElement): void {
  if (n.owner <= 0 || debugState !== 'paused') return;
  const val = row.querySelector<HTMLElement>('.dbg-val');
  if (!val) return;
  dbgInlineEdit(t, row, val, n.value, `New value for ${n.name}`, async v => {
    try {
      const r = await api.debug.setValue(n.owner, n.name, v);
      n.value = r.value; n.type = r.type; n.ref = r.ref; n.kids = undefined;
      if (t.track) {
        const k = dbgFrameKey() + n.key, was = dbgPrev.get(k);
        n.changed = was !== undefined && was !== n.value;
        dbgSeen.set(k, n.value);
      }
      // Watches may use it. The variables aren't read again: Node's scopes are copies taken at the pause, and
      // would still show the old value.
      void evalDbgWatches(dbgValSeq);
      return null;
    } catch (e) { return `Couldn't change it: ${dbgErr(e)}`; }
  });
}

/* ----- Variables ----- */
const dbgVarsTree = dbgTree($('#dbgVars'), () => {
  if (debugState === 'stopped') return 'Shows the variables when the program pauses.';
  if (!debugFrames.length) return 'Running… The variables show when it pauses.';
  return esc(dbgVarsMsg) || 'Loading…';
}, true);
let dbgVarsMsg = ''; // why there are none, once they've been read
async function loadDbgVars(seq: number): Promise<void> {
  const f = debugFrames[debugFrameIdx];
  if (!f) return;
  let roots: DbgNode[] = [];
  let err = '';
  try {
    const scopes = await api.debug.scopes(f.id);
    if (seq !== dbgValSeq) return;
    roots = scopes.map(s => dbgNode(s, dbgKeyOf('v', s.name), 0, -1));
    await Promise.all(roots.map(r => dbgFill(r, seq)));
  } catch (e) { err = dbgErr(e); }
  if (seq !== dbgValSeq) return;
  dbgVarsMsg = err ? `Couldn't read the variables: ${err}` : 'No variables here.';
  dbgVarsTree.roots = roots;
  dbgVarsTree.el.classList.remove('stale');
  drawDbgTree(dbgVarsTree);
}

/* ----- Watch ----- */
// Expressions kept per folder, evaluated in the selected frame at every pause and frame change.
const dbgWatchKey = () => `breeze.debug.watch:${rootInfo?.root ?? ''}`;
let dbgWatchFor: string | null = null;
let dbgWatchList: string[] = [];
function dbgWatches(): string[] {
  const k = dbgWatchKey();
  if (k !== dbgWatchFor) {
    dbgWatchFor = k;
    const saved = store.get<unknown>(k, []);
    dbgWatchList = Array.isArray(saved) ? [...new Set(saved.filter((x): x is string => typeof x === 'string' && !!x.trim()))] : [];
  }
  return dbgWatchList;
}
const saveDbgWatches = () => store.set(dbgWatchKey(), dbgWatchList);
const dbgExample = () => (debugKind(debugFile ?? debugTarget()) === 'python' ? 'len(items)' : 'items.length');
const dbgWatchTree = dbgTree($('#dbgWatch'), () => `Add an expression to see its value each time the program pauses, like <code>${dbgExample()}</code>.`, true);
// Rows for every expression, keeping the values already shown until the new ones arrive.
function dbgWatchRows(): DbgNode[] {
  return dbgWatches().map(expr => {
    const key = dbgKeyOf('w', expr);
    return dbgWatchTree.roots.find(n => n.key === key) ?? { key, name: expr, value: '', type: '', ref: 0, owner: 0, watch: expr, idle: true };
  });
}
// No values while the program isn't paused: just the expressions.
const idleDbgWatches = () => { dbgWatchTree.roots = dbgWatches().map(expr => ({ key: dbgKeyOf('w', expr), name: expr, value: '', type: '', ref: 0, owner: 0, watch: expr, idle: true })); };
async function evalDbgWatches(seq: number): Promise<void> {
  const f = debugFrames[debugFrameIdx];
  if (!f) { idleDbgWatches(); drawDbgTree(dbgWatchTree); return; }
  const roots = await Promise.all(dbgWatches().map(async (expr): Promise<DbgNode> => {
    const key = dbgKeyOf('w', expr);
    try {
      const n = dbgNode(await api.debug.evaluate(expr, f.id, 'watch'), key, 0, seq);
      n.name = expr; // the backends name a result after its expression, but say so here
      n.watch = expr;
      await dbgFill(n, seq);
      return n;
    } catch (e) { return { key, name: expr, value: '', type: '', ref: 0, owner: 0, watch: expr, err: dbgErr(e) }; }
  }));
  if (seq !== dbgValSeq) return;
  dbgWatchTree.roots = roots;
  dbgWatchTree.el.classList.remove('stale');
  drawDbgTree(dbgWatchTree);
}
function removeDbgWatch(expr: string): void {
  dbgWatchList = dbgWatches().filter(x => x !== expr);
  saveDbgWatches();
  dbgWatchTree.roots = dbgWatchTree.roots.filter(n => n.watch !== expr);
  drawDbgTree(dbgWatchTree);
}
// Adds or (with `was`) changes an expression; empty removes it. Returns an error to show, or null.
async function setDbgWatch(expr: string, was: string | null): Promise<string | null> {
  expr = expr.trim();
  const list = dbgWatches();
  if (!expr) { if (was != null) removeDbgWatch(was); return null; }
  if (expr !== was && list.includes(expr)) return 'That expression is already in the list.';
  if (was != null) list[list.indexOf(was)] = expr; else list.push(expr);
  saveDbgWatches();
  dbgWatchTree.roots = dbgWatchRows();
  drawDbgTree(dbgWatchTree);
  await evalDbgWatches(dbgValSeq);
  return null;
}
function editDbgWatch(row: HTMLElement, expr: string): void {
  const name = row.querySelector<HTMLElement>('.dbg-name');
  if (name) dbgInlineEdit(dbgWatchTree, row, name, expr, 'Watch expression', v => setDbgWatch(v, expr));
}
// The + in the header: a box under the list for the new expression.
const dbgWatchNew = document.createElement('div');
dbgWatchNew.className = 'dbg-watch-new hidden';
const dbgWatchInput = document.createElement('input');
dbgWatchInput.className = 'dbg-edit';
dbgWatchInput.spellcheck = false;
dbgWatchInput.setAttribute('aria-label', 'Expression to watch');
dbgWatchNew.append(dbgWatchInput);
$('#dbgWatchPanel').append(dbgWatchNew);
function openDbgWatchAdd(): void {
  dbgWatchInput.value = '';
  dbgWatchInput.placeholder = `Expression, like ${dbgExample()}`;
  dbgWatchInput.classList.remove('bad');
  dbgWatchNew.classList.remove('hidden');
  dbgWatchInput.focus();
}
async function commitDbgWatchAdd(): Promise<void> {
  if (dbgWatchNew.classList.contains('hidden')) return;
  const err = await setDbgWatch(dbgWatchInput.value, null);
  if (err) { dbgWatchInput.classList.add('bad'); dbgWatchInput.title = err; toast(err); return; }
  dbgWatchNew.classList.add('hidden');
}
$('#dbgWatchAdd').onclick = openDbgWatchAdd;
dbgWatchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); void commitDbgWatchAdd(); }
  else if (e.key === 'Escape') { e.preventDefault(); dbgWatchNew.classList.add('hidden'); }
});
dbgWatchInput.addEventListener('input', () => dbgWatchInput.classList.remove('bad'));
dbgWatchInput.addEventListener('blur', () => { if (!dbgWatchInput.value.trim()) dbgWatchNew.classList.add('hidden'); else void commitDbgWatchAdd(); });

/* ----- The bottom tabs ----- */
type DbgTab = 'output' | 'console';
let dbgTab: DbgTab = 'output';
const dbgTabEl = (t: DbgTab) => $(t === 'output' ? '#dbgTabOutput' : '#dbgTabConsole');
function showDbgTab(t: DbgTab): void {
  dbgTab = t;
  for (const x of ['output', 'console'] as const) {
    const on = x === t, tab = dbgTabEl(x);
    tab.classList.toggle('on', on);
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(x === 'output' ? '#dbgOutputPane' : '#dbgConsolePane').classList.toggle('hidden', !on);
  }
  dbgTabEl(t).classList.remove('has-new');
  dbgStickScroll(t === 'output' ? dbgOut : dbgCon);
}
// A tab not in front gets a dot when something new arrives in it.
const dbgNoteNew = (t: DbgTab) => { if (dbgTab !== t) dbgTabEl(t).classList.add('has-new'); };
$('#dbgBottom .dbg-tabs').addEventListener('click', e => {
  const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-dbg-tab]');
  if (tab) showDbgTab(tab.dataset.dbgTab as DbgTab);
});
$('#dbgBottom .dbg-tabs').addEventListener('keydown', e => {
  if (!(e.target as HTMLElement).closest('[data-dbg-tab]') || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
  e.preventDefault();
  showDbgTab(dbgTab === 'output' ? 'console' : 'output');
  dbgTabEl(dbgTab).focus();
});
$('#dbgClear').onclick = () => {
  if (dbgTab === 'output') clearDbgOutput(); else dbgCon.replaceChildren();
};

// Logs follow new lines only while scrolled to the bottom; scrolling up to read stops that until back down.
const dbgStuck = new WeakMap<HTMLElement, boolean>();
function dbgStickScroll(el: HTMLElement): void {
  if (dbgStuck.get(el) === false) return;
  requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}
for (const el of [$('#dbgOutLog'), $('#dbgConsole')]) {
  el.addEventListener('scroll', () => { if (el.clientHeight) dbgStuck.set(el, el.scrollHeight - el.scrollTop - el.clientHeight < 8); }, { passive: true });
}

/* ----- Output: the program's stdout and stderr, and its input line ----- */
// Text nodes in a few spans, one per run of a stream. Only the newest output is kept (a program can print a lot):
// past either limit the oldest spans go, and a note says so.
const DBG_OUT_CHARS = 1_000_000;
const DBG_OUT_LINES = 5000;
const DBG_OUT_SPAN = 16384; // characters per span, so trimming drops a little at a time
type DbgOutKind = 'out' | 'err' | 'echo' | 'note';
interface DbgOutSpan { el: HTMLSpanElement; kind: DbgOutKind; chars: number; lines: number; }
const dbgOut = $('#dbgOutLog');
const dbgOutSpans: DbgOutSpan[] = [];
let dbgOutChars = 0, dbgOutLines = 0, dbgOutEndsLine = true;
let dbgOutTrimmed: HTMLElement | null = null; // the "(older output removed)" note
let dbgOutDropped = false; // output went before it was ever shown
const countLines = (s: string) => { let n = 0; for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++; return n; };
function appendDbgOutput(text: string, kind: DbgOutKind): void {
  if (!text) return;
  if (text.length > DBG_OUT_CHARS) { // more than all that's kept at once: only its end, and nothing older
    text = text.slice(-DBG_OUT_CHARS);
    for (const old of dbgOutSpans.splice(0)) old.el.remove();
    dbgOutChars = dbgOutLines = 0;
    dbgOutDropped = true;
  }
  if (text.length > DBG_OUT_SPAN) { // a big burst goes in span-sized pieces, so trimming stays gradual
    let cut = DBG_OUT_SPAN;
    if (/[\ud800-\udbff]/.test(text[cut - 1])) cut--; // not between an emoji's two halves
    appendDbgOutput(text.slice(0, cut), kind);
    appendDbgOutput(text.slice(cut), kind);
    return;
  }
  let span = dbgOutSpans.at(-1);
  if (!span || span.kind !== kind || span.chars + text.length > DBG_OUT_SPAN) {
    const el = document.createElement('span');
    el.className = `dbg-o-${kind}`;
    dbgOut.append(el);
    span = { el, kind, chars: 0, lines: 0 };
    dbgOutSpans.push(span);
  }
  const lines = countLines(text);
  span.el.append(text);
  span.chars += text.length; span.lines += lines;
  dbgOutChars += text.length; dbgOutLines += lines;
  dbgOutEndsLine = text.endsWith('\n');
  let cut = 0;
  while ((dbgOutChars > DBG_OUT_CHARS || dbgOutLines > DBG_OUT_LINES) && dbgOutSpans.length - cut > 1) {
    dbgOutChars -= dbgOutSpans[cut].chars; dbgOutLines -= dbgOutSpans[cut].lines;
    cut++;
  }
  if (cut || dbgOutDropped) {
    dbgOutDropped = false;
    // Scrolled up to read: the text being read stays where it is as the oldest goes.
    const keep = dbgOutSpans[cut].el, reading = dbgStuck.get(dbgOut) === false;
    const top = reading ? keep.getBoundingClientRect().top : 0;
    if (!dbgOutTrimmed) {
      dbgOutTrimmed = document.createElement('div');
      dbgOutTrimmed.className = 'dbg-o-trim';
      dbgOutTrimmed.textContent = '(older output removed)';
      dbgOut.prepend(dbgOutTrimmed);
    }
    for (const old of dbgOutSpans.splice(0, cut)) old.el.remove();
    if (reading) dbgOut.scrollTop += keep.getBoundingClientRect().top - top;
  }
  dbgStickScroll(dbgOut);
  dbgNoteNew('output');
}
// A line of Breeze's own ("app.py finished"), on a line of its own.
const dbgOutNote = (text: string) => appendDbgOutput(`${dbgOutEndsLine ? '' : '\n'}${text}\n`, 'note');
function clearDbgOutput(): void {
  dbgOut.replaceChildren();
  dbgOutSpans.length = 0;
  dbgOutChars = dbgOutLines = 0;
  dbgOutEndsLine = true;
  dbgOutTrimmed = null;
  dbgOutDropped = false;
  dbgStuck.delete(dbgOut);
}
// Program output from debug.ts's subscription. 'console' is the debugger's own (debugpy's messages, Python
// logpoints): it goes to the Debug Console.
function onDebugOutput(stream: 'stdout' | 'stderr' | 'console', text: string): void {
  if (stream === 'console') dbgConsoleLog(text);
  else appendDbgOutput(text, stream === 'stderr' ? 'err' : 'out');
}
// Enter sends the line to the program's stdin, shown in the output as typed (a pipe doesn't echo it).
const dbgStdin = $<HTMLInputElement>('#dbgStdin');
dbgStdin.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.isComposing) return;
  e.preventDefault();
  if (debugState === 'stopped') return;
  const text = dbgStdin.value;
  dbgStdin.value = '';
  dbgStuck.delete(dbgOut);
  appendDbgOutput(`${text}\n`, 'echo');
  api.debug.stdin(`${text}\n`)
    .then(ok => { if (!ok) dbgOutNote("Your program isn't reading input any more, so that line wasn't sent."); })
    .catch(err => dbgOutNote(`Couldn't send that line: ${dbgErr(err)}`));
});

/* ----- Debug Console: evaluate in the selected frame ----- */
const dbgCon = $('#dbgConsole');
const dbgConIn = $<HTMLInputElement>('#dbgConsoleIn');
const DBG_CON_MAX = 1000; // entries kept
const dbgConHistory: string[] = [];
let dbgConAt = 0, dbgConDraft = '', dbgConSeq = 0;
function dbgConAdd(el: HTMLElement): void {
  dbgCon.append(el);
  while (dbgCon.childElementCount > DBG_CON_MAX) dbgCon.firstElementChild?.remove();
  dbgStickScroll(dbgCon);
  dbgNoteNew('console');
}
function dbgConLine(cls: string, text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = `dbg-c dbg-c-${cls}`;
  el.textContent = text;
  dbgConAdd(el);
  return el;
}
const dbgConsoleLog = (text: string) => dbgConLine('log', text.replace(/\r?\n$/, ''));
async function runDbgConsole(expr: string): Promise<void> {
  dbgStuck.delete(dbgCon);
  dbgConLine('in', expr);
  if (debugState === 'stopped') { dbgConLine('err', 'The program isn\'t running. Start debugging, then try again.'); return; }
  const f = debugState === 'paused' ? debugFrames[debugFrameIdx] : undefined;
  // A placeholder keeps the answer in order with whatever prints meanwhile.
  const slot = document.createElement('div');
  slot.className = 'dbg-c dbg-c-res';
  dbgConAdd(slot);
  try {
    const v = await api.debug.evaluate(expr, f?.id, 'repl');
    const tree = dbgTree(slot, () => '', false);
    slot.classList.add('dbg-tree');
    tree.roots = [dbgNode({ ...v, name: '' }, `c${++dbgConSeq}`, 0, -1)];
    drawDbgTree(tree);
  } catch (e) {
    slot.className = 'dbg-c dbg-c-err';
    slot.textContent = dbgErr(e);
  }
  dbgStickScroll(dbgCon);
}
dbgConIn.addEventListener('keydown', e => {
  if (e.isComposing) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    const expr = dbgConIn.value.trim();
    if (!expr) return;
    if (dbgConHistory.at(-1) !== expr) dbgConHistory.push(expr);
    if (dbgConHistory.length > 100) dbgConHistory.shift();
    dbgConAt = dbgConHistory.length;
    dbgConIn.value = '';
    void runDbgConsole(expr);
  } else if (e.key === 'ArrowUp' && dbgConAt > 0) {
    e.preventDefault();
    if (dbgConAt === dbgConHistory.length) dbgConDraft = dbgConIn.value;
    dbgConIn.value = dbgConHistory[--dbgConAt];
  } else if (e.key === 'ArrowDown' && dbgConAt < dbgConHistory.length) {
    e.preventDefault();
    dbgConIn.value = ++dbgConAt === dbgConHistory.length ? dbgConDraft : dbgConHistory[dbgConAt];
  }
});

/* ----- Hover: a value under the mouse while paused ----- */
const dbgHover = document.createElement('div');
dbgHover.className = 'lsp-hover dbg-hover hidden';
dbgHover.setAttribute('role', 'tooltip');
document.body.append(dbgHover);
let dbgHoverTimer: TimeoutId | undefined;
let dbgHoverAt: { x: number; y: number } | null = null;
let dbgHoverSeq = 0;
function hideDbgHover(): void {
  clearTimeout(dbgHoverTimer);
  dbgHoverSeq++;
  dbgHoverAt = null;
  dbgHover.classList.add('hidden');
}
// The name under `off`, with what it's a member of: hovering `name` in `user.name` asks for `user.name`. Nothing
// for strings, comments, numbers and keywords.
function dbgHoverExpr(b: EditorBuffer, off: number): string | null {
  const t = b.text;
  if (!isWordCh(t[off] ?? '')) return null;
  const doc = highlighted(b);
  const kind = doc.kinds[lineOfOffset(doc.starts, off)];
  if (kind === 'str' || kind === 'com' || kind === 'num' || kind === 'kw') return null;
  let from = off, to = off;
  while (from > 0 && isWordCh(t[from - 1])) from--;
  while (to < t.length && isWordCh(t[to])) to++;
  if (/^\d/.test(t.slice(from, to))) return null;
  while (t[from - 1] === '.') {
    let s = from - 1;
    while (s > 0 && isWordCh(t[s - 1])) s--;
    if (s === from - 1 || /^\d/.test(t.slice(s, from - 1))) break;
    from = s;
  }
  return t.slice(from, to);
}
async function showDbgHover(x: number, y: number): Promise<void> {
  const f = debugFrames[debugFrameIdx];
  const b = dbgShown ? dbgBuf(dbgShown) : undefined;
  if (debugState !== 'paused' || !f || !b || f.file !== b.path) return;
  const expr = dbgHoverExpr(b, dbgTa.offsetAt(x - measureChar() / 2, y)); // offsetAt rounds to the nearest gap: the character under the mouse starts left of it
  if (!expr) return;
  const seq = ++dbgHoverSeq;
  let v: DebugValue;
  try { v = await api.debug.evaluate(expr, f.id, 'hover'); } catch { return; } // not a name here: no tooltip
  if (seq !== dbgHoverSeq || debugState !== 'paused') return;
  const name = document.createElement('b');
  name.textContent = expr;
  const val = document.createElement('span');
  val.className = `dbg-val${dbgValClass(v.type)}`;
  val.textContent = v.value.length > 4000 ? `${v.value.slice(0, 4000)}…` : v.value;
  const type = document.createElement('small');
  type.textContent = v.type && v.type !== v.value ? `  ${v.type}` : '';
  dbgHover.replaceChildren(name, ' = ', val, type);
  dbgHover.classList.remove('hidden');
  dbgHoverAt = { x, y };
  const h = dbgHover.offsetHeight, w = dbgHover.offsetWidth;
  dbgHover.style.left = `${Math.max(8, Math.min(x - 8, innerWidth - w - 8))}px`;
  dbgHover.style.top = `${y - h - 10 > 8 ? y - h - 10 : y + 18}px`;
}
const dbgCode = $('#dbgEditor .code');
dbgCode.addEventListener('mousemove', e => {
  clearTimeout(dbgHoverTimer);
  if (dbgHoverAt && Math.hypot(e.clientX - dbgHoverAt.x, e.clientY - dbgHoverAt.y) > 24) hideDbgHover();
  if (e.buttons || debugState !== 'paused') return;
  dbgHoverTimer = setTimeout(() => void showDbgHover(e.clientX, e.clientY), 300);
});
dbgCode.addEventListener('mouseleave', hideDbgHover);
dbgCode.addEventListener('keydown', hideDbgHover, true);
dbgCode.addEventListener('wheel', hideDbgHover, { passive: true });

/* ----- Right-click in the source: Run to Here, and the line's breakpoint ----- */
dbgCode.addEventListener('contextmenu', e => {
  const b = dbgShown ? dbgBuf(dbgShown) : undefined;
  if (!b) return;
  e.preventDefault();
  hideDbgHover();
  const path = b.path, line0 = lineOfOffset(highlighted(b).lines, dbgTa.offsetAt(e.clientX, e.clientY));
  popupMenu(e.clientX, e.clientY, [
    { label: 'Run to Here', run: () => background(api.debug.runTo(path, line0 + 1)), enabled: () => debugState === 'paused' },
    { sep: true },
    ...bpMenuItems(path, line0),
  ]);
});

/* ----- Following the session ----- */
// The program paused or another frame was picked: read the variables and watches again.
function refreshDebugValues(): void {
  const seq = ++dbgValSeq;
  hideDbgHover();
  dbgVarsMsg = '';
  void loadDbgVars(seq);
  void evalDbgWatches(seq);
}
// A new run: its output and console start empty, and nothing counts as changed yet.
let dbgRestarting = false; // a start replaced a run whose end is still to be reported: not this run's to note
function resetDebugPanels(): void {
  dbgValSeq++;
  dbgRestarting = debugState !== 'stopped';
  clearDbgOutput();
  dbgCon.replaceChildren();
  dbgSeen = new Map();
  dbgPrev = new Map();
  dbgVarsTree.roots = [];
  drawDbgTree(dbgVarsTree);
  renderDbgPanels();
}
function renderDbgPanels(): void {
  const s = debugState;
  dbgStdin.disabled = s === 'stopped';
  dbgStdin.placeholder = s === 'stopped' ? 'Start debugging to type input for your program'
    : s === 'paused' ? 'Type input for your program and press Enter. It reads it when it continues.'
    : 'Type input for your program and press Enter';
  dbgConIn.disabled = s === 'stopped';
  dbgConIn.placeholder = s === 'stopped' ? 'Start debugging to use the console'
    : s === 'paused' ? `Type an expression, like total * 2, and press Enter (↑ ↓ for earlier ones)`
    : 'Pause the program to use its variables here';
  drawDbgTree(dbgVarsTree);
  // The last pause's values stay (dimmed) while it runs between steps; otherwise only the expressions show.
  if (s !== 'paused' && !(s === 'running' && dbgWatchTree.roots.some(n => !n.idle))) idleDbgWatches();
  drawDbgTree(dbgWatchTree);
  dbgStickScroll(dbgTab === 'output' ? dbgOut : dbgCon);
}
// Every debugger event but output, after debug.ts and the page have taken theirs.
function onDebugPanelsEvent(ev: DebugEvent): void {
  if (ev.type === 'paused') {
    dbgPrev = dbgSeen;
    dbgSeen = new Map();
    refreshDebugValues();
  } else if (ev.type === 'state' && ev.state !== 'paused') {
    dbgValSeq++;
    hideDbgHover();
    // Running between steps: the last values stay, dimmed, so stepping doesn't flash empty panels.
    dbgVarsTree.el.classList.toggle('stale', ev.state !== 'stopped');
    dbgWatchTree.el.classList.toggle('stale', ev.state !== 'stopped');
    if (ev.state === 'stopped' || ev.state === 'starting') dbgVarsTree.roots = [];
    if (ev.state === 'starting') dbgRestarting = false;
  } else if (ev.type === 'exited' && debugFile && !dbgRestarting) {
    dbgOutNote(debugStopped ? `${baseName(debugFile)} was stopped.` : `${baseName(debugFile)} finished${ev.code != null ? ` with exit code ${ev.code}` : ''}.`);
  }
  if (ev.type === 'state') renderDbgPanels();
}
renderDbgPanels();
