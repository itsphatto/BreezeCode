/* ================= Debugger: the full page ================= */
// A screen of its own (swapScreen), like Breeze Space: the controls in the title bar, the call stack and breakpoints on
// the left, the file being debugged in the middle, read-only. Leaving it keeps the session running, and the IDE's
// status bar shows "Debugging app.py — paused · Open" to come back. The session itself lives in debug.ts.

const debugPageShowing = () => { const p = $('#debug'); return !p.classList.contains('hidden') && !p.classList.contains('screen-out'); };
// The file Start debugs from the page: the editor's file when it can be debugged, else the one debugged last.
const debugTarget = (): string | null => (debugKind(active) ? active : debugFile);

function openDebugView(): void {
  closeMenu();
  swapScreen('#debug');
  // Paused: the selected frame's line. Otherwise the file a start would run (or is running).
  const f = debugFrames[debugFrameIdx];
  if (f?.file) showDbgSource(f.file, f.line - 1);
  else showDbgSource(debugState === 'stopped' ? debugTarget() : debugFile);
  renderDebug();
  renderDbgPanels();
  placeRailIndicator();
}
function leaveDebugView(): void {
  hideDbgHover();
  showIde();
}
$('#dbgBack').onclick = leaveDebugView;
$('#debugBtn').onclick = openDebugView;

/* ----- The activity bar, copied from the IDE so the page keeps its place in the app ----- */
// Copied rather than written twice in breeze.html. The copies' views are `data-rail-view`, so views.ts (which wires
// and lights every `.act-btn[data-view]`) leaves them alone; picking one goes back to the editor on that view.
const dbgRail = $('#dbgRail');
for (const n of Array.from($('#ide .activity').children)) {
  const c = n.cloneNode(true) as HTMLElement;
  if (n.id) c.dataset.rail = n.id;
  for (const el of [c, ...Array.from(c.querySelectorAll<HTMLElement>('[id]'))]) el.removeAttribute('id');
  if (c.dataset.view) { c.dataset.railView = c.dataset.view; delete c.dataset.view; }
  c.classList.toggle('on', c.hasAttribute('data-debug-btn'));
  dbgRail.append(c);
}
dbgRail.addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.act-btn');
  if (!b) return;
  if (b.dataset.railView) { leaveDebugView(); showView(b.dataset.railView, true); }
  else if (b.dataset.rail === 'settingsBtn') openSettings(b);
});
function placeRailIndicator(): void {
  const ind = dbgRail.querySelector<HTMLElement>('.act-indicator');
  const btn = dbgRail.querySelector<HTMLElement>('[data-debug-btn]');
  if (!ind || !btn) return;
  ind.style.transform = `translateY(${btn.offsetTop + (btn.offsetHeight - 20) / 2}px)`;
  ind.style.opacity = '1';
}

/* ----- Layout: both side columns' widths, the call stack's and the variables' share of theirs, and the output's
   height, dragged and remembered ----- */
const DBG_LAYOUT_KEY = 'breeze.debug.layout';
const dbgLayout = { left: 280, stack: .45, right: 300, vars: .6, bottom: 220 };
{
  const saved = store.get<Record<string, unknown>>(DBG_LAYOUT_KEY, {});
  const num = (k: string, lo: number, hi: number) => { const v = saved[k]; return typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : null; };
  dbgLayout.left = num('left', 180, 640) ?? dbgLayout.left;
  dbgLayout.stack = num('stack', .15, .85) ?? dbgLayout.stack;
  dbgLayout.right = num('right', 200, 640) ?? dbgLayout.right;
  dbgLayout.vars = num('vars', .15, .85) ?? dbgLayout.vars;
  dbgLayout.bottom = num('bottom', 80, 2000) ?? dbgLayout.bottom;
}
function applyDbgLayout(): void {
  $('#dbgMain').style.setProperty('--dbg-left', `${dbgLayout.left}px`);
  $('#dbgMain').style.setProperty('--dbg-right', `${dbgLayout.right}px`);
  $('#dbgLeft').style.setProperty('--dbg-stack', String(dbgLayout.stack));
  $('#dbgRight').style.setProperty('--dbg-vars', String(dbgLayout.vars));
  $('#dbgMid').style.setProperty('--dbg-bottom', `${dbgLayout.bottom}px`);
}
applyDbgLayout();
// Other keys under the same name (later panels' sizes) are kept.
const saveDbgLayout = () => store.set(DBG_LAYOUT_KEY, { ...store.get<Record<string, unknown>>(DBG_LAYOUT_KEY, {}), ...dbgLayout });
function dbgSash(sash: HTMLElement, vertical: boolean, move: (e: PointerEvent) => void): void {
  sash.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    sash.classList.add('active');
    document.body.classList.add(vertical ? 'resizing' : 'resizing-h');
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      sash.classList.remove('active');
      document.body.classList.remove('resizing', 'resizing-h');
      saveDbgLayout();
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });
}
dbgSash($('#dbgLeftSash'), true, e => {
  const left = $('#dbgLeft').getBoundingClientRect().left;
  dbgLayout.left = clamp(e.clientX - left, 180, Math.min(640, innerWidth * .5));
  applyDbgLayout();
});
dbgSash($('#dbgStackSash'), false, e => {
  const r = $('#dbgLeft').getBoundingClientRect();
  dbgLayout.stack = clamp((e.clientY - r.top) / Math.max(1, r.height), .15, .85);
  applyDbgLayout();
});
dbgSash($('#dbgRightSash'), true, e => {
  const right = $('#dbgRight').getBoundingClientRect().right;
  dbgLayout.right = clamp(right - e.clientX, 200, Math.min(640, innerWidth * .4));
  applyDbgLayout();
});
dbgSash($('#dbgVarsSash'), false, e => {
  const r = $('#dbgRight').getBoundingClientRect();
  dbgLayout.vars = clamp((e.clientY - r.top) / Math.max(1, r.height), .15, .85);
  applyDbgLayout();
});
dbgSash($('#dbgBottomSash'), false, e => {
  const r = $('#dbgMid').getBoundingClientRect();
  dbgLayout.bottom = clamp(r.bottom - e.clientY, 80, Math.max(80, r.height - 140));
  applyDbgLayout();
});

/* ----- The source: the selected frame's file, read-only, on the editor's own surface and highlighter ----- */
const dbgLines = document.createElement('div');
dbgLines.style.position = 'relative';
const dbgInner = document.createElement('div');
dbgInner.style.position = 'relative';
dbgInner.append(dbgLines);
$('#dbgHl').appendChild(dbgInner);
const dbgGutInner = document.createElement('div');
const dbgGutLines = document.createElement('div');
dbgGutLines.style.position = 'relative';
dbgGutInner.append(dbgGutLines);
$('#dbgGutter').appendChild(dbgGutInner);
let dbgWin = { first: 0, last: 0, total: 1 };
let dbgShown: string | null = null; // the file in the middle
let dbgSelf: CodeSurface | null = null;
const dbgTa: CodeSurface = dbgSelf = new CodeSurface($('#dbgEditor .code'), {
  lineHeight: LINE_H, charWidth: measureChar, pad: { top: 10, left: 4, right: 24, bottom: 10 }, label: 'Code being debugged (read only)',
  ...lineMeasurer(dbgLines, () => dbgWin.first, () => dbgSelf?.value ?? ''),
});
// Read-only: the hidden input takes no typing, and every edit the surface would make (Enter, Delete, paste, cut) is
// cancelled. Selecting and copying still work.
dbgTa.input.readOnly = true;
dbgTa.addEventListener('beforeinput', e => e.preventDefault());
dbgTa.addEventListener('scroll', syncDbgScroll);
dbgTa.addEventListener('selectionchange', paintDbg);
const updateDbgSliders = editorSliders($('#dbgEditor'), () => (dbgShown && dbgBuf(dbgShown)?.kind === 'text' ? dbgTa : undefined));

// Files the page reads itself, for those not open in a tab (an open one shows its tab's text). Read again each start.
const dbgFiles = new Map<string, EditorBuffer | string>(); // path → buffer, or why it couldn't be read
function forgetDebugSources(): void { dbgFiles.clear(); }
function dbgBuf(path: string): EditorBuffer | undefined {
  const open = buffers.get(path);
  if (open?.kind === 'text') return open;
  const b = dbgFiles.get(path);
  return typeof b === 'object' ? b : undefined;
}
async function loadDbgFile(path: string): Promise<void> {
  if (dbgFiles.has(path)) return;
  dbgFiles.set(path, 'Loading…');
  try {
    const r = await api.fs.readFile(path);
    const raw = r.text ?? '';
    if (kindOf(r) !== 'text') dbgFiles.set(path, "Breeze can't show this file as text.");
    else {
      const text = raw.replaceAll('\r\n', '\n');
      dbgFiles.set(path, { path, kind: 'text', text, saved: text, eol: raw.includes('\r\n') ? '\r\n' : '\n', size: r.size, ta: null, undo: [], redo: [], lastEdit: null });
    }
  } catch (e) { dbgFiles.set(path, `Couldn't open ${baseName(path)}: ${errMsg(e)}`); }
  if (dbgShown === path) { renderDbgSource(); if (dbgReveal != null) revealDbgLine(dbgReveal); }
}

let dbgReveal: number | null = null; // the line to bring into view once the file has loaded
// Shows `path` in the middle; with `line0`, scrolls to that line and puts the caret on it.
function showDbgSource(path: string | null, line0?: number): void {
  if (path !== dbgShown) { dbgTa.value = ''; dbgTa.scrollTop = 0; }
  dbgShown = path;
  dbgReveal = line0 ?? null;
  renderDbgSource();
  if (line0 != null && path && dbgBuf(path)) revealDbgLine(line0);
}
function revealDbgLine(line0: number): void {
  dbgReveal = null;
  const b = dbgShown ? dbgBuf(dbgShown) : undefined;
  if (!b) return;
  const off = offsetOf(b.text, line0, 0);
  dbgTa.setSelectionRange(off, off);
  const top = line0 * LINE_H;
  if (top < dbgTa.scrollTop || top > dbgTa.scrollTop + dbgTa.clientHeight - LINE_H * 3) dbgTa.scrollTop = Math.max(0, top - dbgTa.clientHeight / 3);
  paintDbg();
}
function renderDbgSource(): void {
  const path = dbgShown;
  const b = path ? dbgBuf(path) : undefined;
  if (path && !b) void loadDbgFile(path);
  const why = !path ? (debugTarget() ? '' : 'Open a Python, JavaScript or TypeScript file in the editor to debug it here.')
    : b ? '' : (dbgFiles.get(path) as string | undefined) ?? 'Loading…';
  $('#dbgSrcHead').innerHTML = path
    ? `<span class="dbg-src-ico">${fileIcon(path)}</span><span class="dbg-src-name">${esc(baseName(path))}</span><span class="dbg-src-dir">${esc(dirName(path))}</span><span class="dbg-src-ro">Read only</span>`
    : '';
  $('#dbgSrcHead').classList.toggle('hidden', !path);
  $('#dbgEditor').classList.toggle('hidden', !b);
  $('#dbgBlank').classList.toggle('hidden', !!b || !why);
  $('#dbgBlank').textContent = why;
  if (!b) { updateDbgSliders(); return; }
  if (dbgTa.value !== b.text) {
    const { selectionStart: s, selectionEnd: e, scrollTop } = dbgTa;
    dbgTa.value = b.text;
    dbgTa.setSelectionRange(Math.min(s, b.text.length), Math.min(e, b.text.length));
    dbgTa.scrollTop = scrollTop;
  }
  paintDbg();
}
// The paused line (the top frame's) and the selected frame's line, when they are in the shown file; -1 otherwise.
function dbgMarkedLines(path: string): { at: number; sel: number } {
  const top = debugFrames[0], sel = debugFrames[debugFrameIdx];
  return {
    at: top?.file === path ? top.line - 1 : -1,
    sel: sel && sel !== top && sel.file === path ? sel.line - 1 : -1,
  };
}
function paintDbg(): void {
  const b = dbgShown ? dbgBuf(dbgShown) : undefined;
  if (!b) return;
  const doc = highlighted(b);
  const count = doc.lines.length;
  const cur = lineOfOffset(doc.lines, dbgTa.selectionStart);
  const [vf, vl] = visibleLines(dbgTa, count);
  dbgWin = { first: Math.max(0, vf - OVERSCAN), last: Math.min(count, vl + OVERSCAN), total: count };
  const { at, sel } = dbgMarkedLines(b.path);
  const exc = debugPause?.reason === 'exception' && debugPause.exception ? debugPause.exception.split('\n')[0] : '';
  const rows: string[] = [], nums: string[] = [];
  for (let i = dbgWin.first; i < dbgWin.last; i++) {
    const cls = [i === cur ? 'cur-line' : '', i === at ? 'dbg-at' : '', i === sel ? 'dbg-sel' : '', i === at && exc ? 'dbg-exc-line' : ''].filter(Boolean).join(' ');
    const msg = i === at && exc ? `<span class="diag-msg dbg-exc-msg">${esc(exc)}</span>` : '';
    rows.push(`<div class="ln${cls ? ' ' + cls : ''}">${lineHtmlOf(doc, i, shownOf(b, i))}${msg}</div>`);
    const gcls = [i === cur ? 'cur' : '', i === at ? 'dbg-at' : '', i === sel ? 'dbg-sel' : ''].filter(Boolean).join(' ');
    nums.push(`<div${gcls ? ` class="${gcls}"` : ''} data-line="${i}">${lineNoHtml(b.path, i)}</div>`);
  }
  patchRows(dbgLines, rows);
  dbgLines.style.top = dbgGutLines.style.top = `${dbgWin.first * LINE_H}px`;
  patchRows(dbgGutLines, nums);
  $('#dbgGutter').style.width = `${Math.max(3, String(count).length) * 8 + 48}px`; // +8 each for the arrow and the breakpoint dot
  syncDbgScroll();
  dbgTa.refresh(); // the caret was placed against the lines drawn before; measure it against these
}
function syncDbgScroll(): void {
  const [vf, vl] = visibleLines(dbgTa, dbgWin.total);
  if (vf < dbgWin.first || vl > dbgWin.last) { paintDbg(); return; }
  dbgInner.style.transform = `translate(${-dbgTa.scrollLeft}px, ${-dbgTa.scrollTop}px)`;
  dbgGutInner.style.transform = `translateY(${-dbgTa.scrollTop}px)`;
  updateDbgSliders();
}
// Line numbers toggle breakpoints, as in the editor; right-click one to edit or remove it.
$('#dbgGutter').addEventListener('click', e => {
  const no = (e.target as HTMLElement).closest<HTMLElement>('[data-bp]');
  if (no && dbgShown) toggleBreakpoint(dbgShown, Number(no.dataset.bp));
});
$('#dbgGutter').addEventListener('contextmenu', e => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-line]');
  if (!row || !dbgShown) return;
  e.preventDefault();
  popupMenu(e.clientX, e.clientY, bpMenuItems(dbgShown, Number(row.dataset.line)));
});
// F9 on the page: the caret's line in the source.
function toggleDebugSourceBreakpoint(): void {
  const b = dbgShown ? dbgBuf(dbgShown) : undefined;
  if (b) toggleBreakpoint(b.path, lineOfOffset(highlighted(b).lines, dbgTa.selectionStart));
}

/* ----- Toolbar and title ----- */
const DEBUG_STATE_WORD: Record<DebugState, string> = { starting: 'starting', running: 'running', paused: 'paused', stopped: 'not running' };
// A button's label, with the key it has now in its tooltip.
function dbgTool(id: string, label: string, act: string, enabled: boolean): void {
  const b = $<HTMLButtonElement>(id);
  const key = keyOf(act);
  b.title = key ? `${label} (${key})` : label;
  b.setAttribute('aria-label', label);
  b.disabled = !enabled;
}
function renderDbgTools(): void {
  const s = debugState, paused = s === 'paused', live = s !== 'stopped';
  // One place for Start, Continue and Pause: Pause while the program runs, the play button otherwise.
  $('#dbgGo').classList.toggle('hidden', live && !paused);
  $('#dbgPause').classList.toggle('hidden', !live || paused);
  dbgTool('#dbgGo', paused ? 'Continue' : 'Start Debugging', 'run.start', paused || (!live && !!debugTarget()));
  dbgTool('#dbgPause', 'Pause', 'debug.pause', s === 'running');
  dbgTool('#dbgOver', 'Step Over', 'debug.stepOver', paused);
  dbgTool('#dbgInto', 'Step Into', 'debug.stepInto', paused);
  dbgTool('#dbgOut', 'Step Out', 'debug.stepOut', paused);
  dbgTool('#dbgRestart', 'Restart', 'debug.restart', live);
  dbgTool('#dbgStop', 'Stop', 'run.stop', live);
  const file = live ? debugFile : debugTarget();
  const word = s === 'stopped' && debugExit !== undefined && file === debugFile ? (debugStopped ? 'stopped' : 'finished') : DEBUG_STATE_WORD[s];
  const tone = { starting: 'blue', running: 'ok', paused: 'warn', stopped: '' }[s];
  const html = file ? `<span class="dbg-what-ico">${fileIcon(file)}</span><b>${esc(baseName(file))}</b><span class="pill ${tone}">${word[0].toUpperCase() + word.slice(1)}</span>` : '';
  const what = $('#dbgWhat');
  if (what.dataset.html !== html) { what.innerHTML = html; what.dataset.html = html; }
}

/* ----- The note above the source: how to start, what went wrong, an exception ----- */
let dbgInstall: 'idle' | 'running' | 'failed' = 'idle';
let dbgInstallProc: number | null = null;
let dbgInstallCmd = '';
// pip for the Python the debugger runs (main names it with the error), so debugpy lands where it is looked for.
// Quoted for the terminal's shell when the path has spaces.
function installDebugpyCmd(): string {
  const py = debugError?.python || 'python';
  return `${/^[\w.:\\/-]+$/.test(py) ? py : `"${py}"`} -m pip install debugpy`;
}
function dbgNoteHtml(): { cls: string; html: string } | null {
  const s = debugState;
  const target = debugTarget();
  if (s === 'stopped' && dbgInstall !== 'idle') {
    return dbgInstall === 'running'
      ? { cls: 'info', html: `<b>Installing debugpy…</b><span>Breeze is running <code>${esc(dbgInstallCmd)}</code> in the terminal. Debugging starts again when it's done.</span>` }
      : { cls: 'err', html: `<b>debugpy didn't install</b><span>The terminal shows what went wrong.</span><div class="dbg-note-acts"><button class="btn btn-sm" data-dbg="terminal">Show terminal</button><button class="btn btn-sm" data-dbg="retry">Try again</button></div>` };
  }
  if (s === 'stopped' && debugError) {
    const e = debugError, py = debugKind(debugFile) === 'python';
    let fix = '', foot = '';
    if (e.hint === 'install-debugpy') {
      fix = '<button class="btn btn-sm btn-primary" data-dbg="install">Install debugpy</button>';
      foot = `<small class="dbg-note-foot">Install runs <code>${esc(installDebugpyCmd())}</code> in the terminal.</small>`;
    }
    else if (e.hint === 'node-too-old' || (e.hint === 'not-found' && !py)) fix = `<button class="btn btn-sm btn-primary" data-dbg="node">Get Node.js ${svgIcon('external', 12)}</button>`;
    else if (e.hint === 'not-found') fix = `<button class="btn btn-sm btn-primary" data-dbg="python">Get Python ${svgIcon('external', 12)}</button>`;
    const intro = e.hint === 'install-debugpy' ? 'Debugging Python needs debugpy, a free helper you install once.' : '';
    return { cls: 'err', html: `<b>Couldn't start debugging</b><span>${esc(intro || e.message)}</span><div class="dbg-note-acts">${fix}<button class="btn btn-sm" data-dbg="retry">Try again</button></div>${foot}` };
  }
  if (s === 'stopped') {
    const go = keyOf('run.start') || 'F5';
    if (!target) return { cls: 'info', html: `<b>Not running</b><span>Open a Python, JavaScript or TypeScript file in the editor, then start debugging it here.</span>` };
    const finished = debugExit !== undefined && target === debugFile;
    const head = !finished ? `Not running — press ${esc(go)} to start`
      : debugStopped ? `${esc(baseName(target))} stopped`
      : `${esc(baseName(target))} finished${debugExit != null ? ` (exit code ${debugExit})` : ''}`;
    const hint = breakpoints.get(target)?.length ? 'It pauses at your breakpoints.' : 'Click a line number to add a breakpoint where it should pause.';
    return { cls: 'info', html: `<b>${head}</b><span>${hint}</span><div class="dbg-note-acts"><button class="btn btn-sm btn-primary" data-dbg="start">${svgIcon('play', 11)}<span>${finished ? `Debug ${esc(baseName(target))} again` : `Start debugging ${esc(baseName(target))}`}</span></button></div>` };
  }
  if (s === 'starting') return { cls: 'info', html: `<b>Starting ${esc(baseName(debugFile ?? ''))}…</b>` };
  if (s === 'running') return { cls: 'info', html: `<b>Running</b><span>It pauses when it reaches a breakpoint. Press ${esc(keyOf('debug.pause') || 'F6')} to pause it now.</span>` };
  if (debugPause?.reason === 'exception') {
    return { cls: 'err', html: `<b>Paused on an exception</b>${debugPause.exception ? `<pre class="dbg-note-pre">${esc(debugPause.exception)}</pre>` : ''}` };
  }
  if (debugFrames.length && !debugFrames.some(f => f.file)) { // e.g. Pause while Node waits for a timer
    return { cls: 'info', html: `<b>Paused outside your code</b><span>Press ${esc(keyOf('debug.stepInto') || 'F11')} to step into your code when it runs next, or ${esc(keyOf('run.start') || 'F5')} to continue.</span>` };
  }
  return null;
}
function renderDbgNote(): void {
  const note = $('#dbgNote');
  const n = dbgNoteHtml();
  note.classList.toggle('hidden', !n);
  if (!n) return;
  const html = `<div class="dbg-note-body">${n.html}</div>`;
  note.className = `dbg-note ${n.cls}`;
  if (note.dataset.html !== html) { note.innerHTML = html; note.dataset.html = html; }
}
$('#dbgNote').addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-dbg]');
  if (!b) return;
  const what = b.dataset.dbg;
  if (what === 'start') run('debug.start');
  else if (what === 'retry') { dbgInstall = 'idle'; if (debugFile) void startDebugFile(debugFile); else run('debug.start'); }
  else if (what === 'install') installDebugpy();
  else if (what === 'node') background(api.sys.openExternal('https://nodejs.org/en/download'));
  else if (what === 'python') background(api.sys.openExternal('https://www.python.org/downloads/'));
  else if (what === 'terminal') { leaveDebugView(); run('term.focus'); }
});
// Runs pip in the IDE's terminal (it shows there) and starts again once it ends well.
function installDebugpy(): void {
  const session = activeTermSession;
  if (!session) { toast('Open the terminal first'); return; }
  if (session.proc != null) { toast('The terminal is busy. Stop what is running there, then try again.'); return; }
  dbgInstall = 'running';
  dbgInstallCmd = installDebugpyCmd();
  renderDebug();
  void runCommand(dbgInstallCmd).then(() => {
    dbgInstallProc = session.proc;
    if (dbgInstallProc == null) { dbgInstall = 'failed'; renderDebug(); } // it never started
  });
}
api.term.onExit((id, code) => {
  if (id !== dbgInstallProc) return;
  dbgInstallProc = null;
  dbgInstall = code === 0 ? 'idle' : 'failed';
  if (code === 0 && debugFile) void startDebugFile(debugFile);
  else renderDebug();
});

/* ----- Call stack ----- */
function renderDbgStack(): void {
  const list = $('#dbgStack');
  let html: string;
  if (!debugFrames.length) {
    html = `<div class="dbg-empty-row">${debugState === 'stopped' ? 'Shows where the program is when it pauses.' : debugState === 'paused' ? 'No frames.' : 'Running…'}</div>`;
  } else {
    html = debugFrames.map((f, i) => {
      const where = f.file ? `${baseName(f.file)}:${f.line}` : 'outside your project';
      return `<div class="dbg-row dbg-frame${i === debugFrameIdx ? ' on' : ''}${f.file ? '' : ' internal'}" role="listitem" tabindex="0" data-frame="${i}" title="${escAttr(f.file ? `${f.file}, line ${f.line}` : 'Code outside your project')}">
        ${i === 0 ? '<span class="dbg-frame-at" aria-label="Paused here"></span>' : '<span class="dbg-frame-gap"></span>'}<span class="dbg-fn">${esc(f.name || '(anonymous)')}</span><span class="dbg-loc">${esc(where)}</span></div>`;
    }).join('');
  }
  if (list.dataset.html !== html) { list.innerHTML = html; list.dataset.html = html; }
}
// Picks the frame the source, the variables and watch show, and the one hover and the console evaluate in.
function selectFrame(i: number): void {
  const f = debugFrames[i];
  if (!f) return;
  const moved = i !== debugFrameIdx;
  debugFrameIdx = i;
  renderDbgStack();
  if (moved) refreshDebugValues();
  if (f.file) showDbgSource(f.file, f.line - 1);
  else toast("This frame is outside your project, so there's no code to show");
}
$('#dbgStack').addEventListener('click', e => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-frame]');
  if (row) selectFrame(Number(row.dataset.frame));
});
$('#dbgStack').addEventListener('keydown', e => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-frame]');
  if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectFrame(Number(row.dataset.frame)); }
});

/* ----- Breakpoints ----- */
// Not accepted by a running debugger although it answered for that file: most likely a typo in its condition.
const bpRejected = (path: string, line: number) => debugLive && !!verifiedBps.get(path) && !verifiedBps.get(path)?.has(line);
function bpDetail(bp: Bp): string {
  return [bp.condition && `when ${bp.condition}`, bp.hitCondition && `hit count ${bp.hitCondition}`, bp.logMessage && `prints "${bp.logMessage}"`].filter(Boolean).join(' · ');
}
function renderDbgBps(): void {
  const all = [...breakpoints].filter(([, l]) => l.length).sort(([a], [b]) => a.localeCompare(b)).flatMap(([path, l]) => l.map(bp => ({ path, bp })));
  $('#dbgBpClear').classList.toggle('hidden', !all.length);
  const html = !all.length
    ? '<div class="dbg-empty-row">No breakpoints yet. Click a line number to add one; the program pauses there.</div>'
    : all.map(({ path, bp }) => {
      const where = `${baseName(path)} line ${bp.line}`;
      const detail = bpDetail(bp);
      const bad = bp.enabled && bpRejected(path, bp.line)
        ? `<span class="dbg-bp-bad" title="The debugger didn't take this breakpoint. If it has a condition or log message, check it for typos.">${svgIcon('alert', 12)}</span>` : '';
      return `<div class="dbg-row dbg-bp${bp.enabled ? '' : ' off'}" role="listitem" tabindex="0" data-bp-path="${escAttr(path)}" data-bp-line="${bp.line}" title="${escAttr(`${path}, line ${bp.line}${detail ? ` — ${detail}` : ''}`)}">
        <button type="button" class="dbg-check${bp.enabled ? ' on' : ''}" role="checkbox" aria-checked="${bp.enabled}" aria-label="${escAttr(`Use the breakpoint at ${where}`)}" data-bp-use>${svgIcon('check', 11)}</button>
        <span class="dbg-bp-file">${esc(baseName(path))}</span><span class="dbg-loc">${bp.line}</span>${detail ? `<span class="dbg-bp-detail">${esc(detail)}</span>` : ''}${bad}</div>`;
    }).join('');
  const list = $('#dbgBps');
  if (list.dataset.html !== html) { list.innerHTML = html; list.dataset.html = html; }
  for (const [id, on] of [['#dbgExcUncaught', debugExceptions !== 'none'], ['#dbgExcAll', debugExceptions === 'all']] as const) {
    $(id).classList.toggle('on', on);
    $(id).setAttribute('aria-checked', String(on));
  }
}
const bpRowOf = (e: Event) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-bp-path]');
  return row ? { path: row.dataset.bpPath as string, line0: Number(row.dataset.bpLine) - 1 } : null;
};
$('#dbgBps').addEventListener('click', e => {
  const at = bpRowOf(e);
  if (!at) return;
  if ((e.target as HTMLElement).closest('[data-bp-use]')) {
    const bp = bpAt(at.path, at.line0);
    if (bp) { bp.enabled = !bp.enabled; onBreakpointsChanged(at.path); }
    return;
  }
  showDbgSource(at.path, at.line0);
});
$('#dbgBps').addEventListener('keydown', e => {
  const at = bpRowOf(e);
  if (at && e.key === 'Enter' && !(e.target as HTMLElement).closest('[data-bp-use]')) showDbgSource(at.path, at.line0);
  if (at && e.key === 'Delete') { e.preventDefault(); removeBreakpoint(at.path, at.line0); }
});
$('#dbgBps').addEventListener('contextmenu', e => {
  const at = bpRowOf(e);
  if (!at) return;
  e.preventDefault();
  popupMenu(e.clientX, e.clientY, bpMenuItems(at.path, at.line0));
});
function removeBreakpoint(path: string, line0: number): void {
  const list = breakpoints.get(path);
  if (!list) return;
  breakpoints.set(path, list.filter(b => b.line !== line0 + 1));
  onBreakpointsChanged(path);
}
$('#dbgBpClear').onclick = () => {
  const n = [...breakpoints.values()].reduce((s, l) => s + l.length, 0);
  openModal(`<h3>Remove all breakpoints?</h3><p class="sub">This removes ${plural(n, 'breakpoint')} from every file in this folder.</p><div class="row end"><button class="btn" data-close>Cancel</button><button class="btn btn-danger" id="bpClearAll">Remove all</button></div>`, m => {
    $('#bpClearAll', m).onclick = () => {
      closeModal();
      for (const path of [...breakpoints.keys()]) { breakpoints.set(path, []); onBreakpointsChanged(path); }
    };
  });
};
// The two switches: "all" includes "uncaught", so turning uncaught off turns both off.
$('#dbgExcUncaught').onclick = () => setDebugExceptions(debugExceptions === 'none' ? 'uncaught' : 'none');
$('#dbgExcAll').onclick = () => setDebugExceptions(debugExceptions === 'all' ? 'uncaught' : 'all');

// The right-click menu of a breakpoint (in the list or the page's gutter), or of a line without one.
function bpMenuItems(path: string, line0: number): MenuItem[] {
  const bp = bpAt(path, line0);
  if (!bp) {
    return [
      { label: 'Add Breakpoint', run: () => toggleBreakpoint(path, line0) },
      { label: 'Add Conditional Breakpoint', run: () => editBreakpoint(path, line0, 'condition') },
      { label: 'Add Logpoint', run: () => editBreakpoint(path, line0, 'logMessage') },
    ];
  }
  return [
    { label: 'Edit Condition', run: () => editBreakpoint(path, line0, 'condition') },
    { label: 'Edit Hit Count', run: () => editBreakpoint(path, line0, 'hitCondition') },
    { label: 'Edit Log Message', run: () => editBreakpoint(path, line0, 'logMessage') },
    { sep: true },
    { label: bp.enabled ? 'Turn Off' : 'Turn On', run: () => { bp.enabled = !bp.enabled; onBreakpointsChanged(path); } },
    { label: 'Remove', run: () => removeBreakpoint(path, line0) },
  ];
}
type BpField = 'condition' | 'hitCondition' | 'logMessage';
const HIT_COUNT_RE = /^(?:>=|>|==|%)?\s*\d+$/;
const BP_FIELDS: Record<BpField, { title: string; sub: string; placeholder: string }> = {
  condition: {
    title: 'Pause only when…',
    sub: 'Write a test in the file\'s language, like <code>count &gt; 3</code>. The program pauses here only when it\'s true.',
    placeholder: 'count > 3',
  },
  hitCondition: {
    title: 'Pause after a number of times',
    sub: 'Type <code>5</code> to pause the 5th time this line runs, and every time after. You can also write <code>&gt;= 5</code>, <code>&gt; 5</code>, <code>== 5</code> (only the 5th time) or <code>% 5</code> (every 5th time).',
    placeholder: '5',
  },
  logMessage: {
    title: 'Print a message instead of pausing',
    sub: 'The message prints each time this line runs, and the program keeps going. Put a name in braces to print its value, like <code>total is {total}</code>.',
    placeholder: 'total is {total}',
  },
};
// Sets one of a breakpoint's extras in a small dialog; empty clears it. A line without a breakpoint gets one.
function editBreakpoint(path: string, line0: number, field: BpField): void {
  if (buffers.get(path)?.untitled) { toast('Save the file first to set a breakpoint.'); return; }
  const f = BP_FIELDS[field];
  const now = bpAt(path, line0)?.[field] ?? '';
  openModal(`<h3>${f.title}</h3><p class="sub">Line ${line0 + 1} of ${esc(baseName(path))}</p><p class="sub">${f.sub} Leave it empty to pause as usual.</p>
    <input class="input w-full mb-12" id="bpField" spellcheck="false" autocomplete="off" aria-label="${escAttr(f.title)}" placeholder="${escAttr(f.placeholder)}">
    <p class="dbg-form-err hidden" id="bpFieldErr" role="alert"></p>
    <div class="row end"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="bpFieldSave">Save</button></div>`, m => {
    const input = $<HTMLInputElement>('#bpField', m);
    input.value = now;
    input.focus();
    input.select();
    const save = () => {
      const v = input.value.trim();
      if (field === 'hitCondition' && v && !HIT_COUNT_RE.test(v)) {
        const err = $('#bpFieldErr', m);
        err.textContent = 'Use a number, or >=, >, == or % and then a number.';
        err.classList.remove('hidden');
        input.focus();
        return;
      }
      closeModal();
      const list = breakpoints.get(path) ?? [];
      let bp = list.find(b => b.line === line0 + 1);
      if (!bp) {
        if (!v) return;
        bp = { line: line0 + 1, enabled: true };
        list.push(bp);
        list.sort((a, c) => a.line - c.line);
        breakpoints.set(path, list);
      }
      if (v) bp[field] = v; else delete bp[field];
      onBreakpointsChanged(path);
    };
    $('#bpFieldSave', m).onclick = save;
    input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); save(); } };
  });
}

/* ----- The status bar pill in the IDE, while a session is going ----- */
function renderDebugPill(): void {
  const pill = $('#sbDebug');
  const on = debugState !== 'stopped' && !!debugFile;
  pill.classList.toggle('hidden', !on);
  pill.classList.toggle('paused', debugState === 'paused');
  if (!on) return;
  const html = `${svgIcon('bug', 13)}<span>Debugging ${esc(baseName(debugFile as string))} — ${DEBUG_STATE_WORD[debugState]} · Open</span>`;
  if (pill.dataset.html !== html) { pill.innerHTML = html; pill.dataset.html = html; }
}
$('#sbDebug').onclick = openDebugView;

/* ----- Redrawing ----- */
// A step goes paused → running → paused within a few milliseconds. Drawing "Running" for that (the note above the
// source, the call stack's placeholder, the toolbar swapping Continue for Pause) only flashes, most of all with a
// step key held down. So leaving a pause waits a beat: if the next pause comes first, nothing changed on screen.
const DBG_RUN_GRACE = 220;
let dbgRunHold: TimeoutId | undefined;
let dbgDrawnPaused = false;
function renderDebug(): void {
  clearTimeout(dbgRunHold);
  dbgRunHold = undefined;
  dbgDrawnPaused = debugState === 'paused';
  renderDebugPill();
  renderDbgTools();
  renderDbgNote();
  renderDbgStack();
  renderDbgBps();
  if (debugPageShowing()) renderDbgSource();
}
// Breakpoints changed (toggled, edited, moved with their lines, accepted by the debugger).
function refreshDebugBreakpoints(): void {
  renderDbgBps();
  if (dbgRunHold === undefined) renderDbgNote();
  if (debugPageShowing()) paintDbg();
}
// Every debugger event but program output (debug.ts has already noted what it says).
function onDebugEvent(ev: DebugEvent): void {
  if (ev.type === 'state' && ev.state === 'running' && dbgDrawnPaused) { // a step, or a Continue: wait to see which
    clearTimeout(dbgRunHold);
    dbgRunHold = setTimeout(renderDebug, DBG_RUN_GRACE);
    return;
  }
  if (dbgRunHold !== undefined && ev.type !== 'paused' && ev.type !== 'state' && ev.type !== 'breakpoints') return; // the timer redraws
  if (ev.type === 'paused') {
    const f = debugFrames[debugFrameIdx];
    if (f?.file) showDbgSource(f.file, f.line - 1);
  } else if (ev.type === 'state' && ev.state === 'starting' && debugFile && dbgShown !== debugFile) {
    showDbgSource(debugFile);
  } else if (ev.type === 'breakpoints') {
    refreshDebugBreakpoints();
    return;
  }
  renderDebug();
}
renderDebug();
