/* ================= Debugger ================= */

/* ----- Breakpoints ----- */
// A red dot before a line number (click the number, or F9 on the caret line). Kept per file in each folder, moved with
// their lines as the file is edited (like the line marks), and sent to the debugger whenever one is running.
// Lines are 1-based in `Bp` (as the debugger wants them) and 0-based in the editor; bpAt and toggleBreakpoint take
// the editor's, and only they and the gutter convert.
const breakpoints = new Map<string, Bp[]>(); // path → breakpoints, by line
const verifiedBps = new Map<string, Set<number>>(); // path → 1-based lines the debugger accepted, while a session runs
let debugLive = false;
const breakpointsKey = () => `breeze.breakpoints:${rootInfo?.root ?? ''}`;
function loadBreakpoints(): void {
  breakpoints.clear();
  for (const [p, list] of Object.entries(store.get<Record<string, Bp[]>>(breakpointsKey(), {}))) {
    if (Array.isArray(list) && list.length) breakpoints.set(p, list.filter(b => Number.isInteger(b?.line) && b.line > 0));
  }
}
function saveBreakpoints(): void {
  store.set(breakpointsKey(), Object.fromEntries([...breakpoints].filter(([, l]) => l.length)));
}
const bpAt = (path: string, line0: number): Bp | undefined => breakpoints.get(path)?.find(b => b.line === line0 + 1);
// Whether the debugger has not (yet) accepted this breakpoint: only meaningful while a session is running.
const bpUnverified = (path: string, line0: number) => debugLive && !verifiedBps.get(path)?.has(line0 + 1);
function bpDotHtml(path: string, line0: number): string {
  const bp = bpAt(path, line0);
  if (!bp) return '<span class="bp-dot"></span>';
  const state = !bp.enabled ? 'off' : bpUnverified(path, line0) ? 'pending' : 'on';
  const title = bp.logMessage ? 'Logpoint' : bp.condition || bp.hitCondition ? 'Conditional breakpoint' : 'Breakpoint';
  return `<span class="bp-dot ${state}" title="${title}${state === 'off' ? ' (disabled)' : state === 'pending' ? ' (not bound yet)' : ''}"></span>`;
}
// The line number as the gutter draws it: clicking it toggles a breakpoint.
const lineNoHtml = (path: string, i: number) => `<span class="ln-no" data-bp="${i}">${bpDotHtml(path, i)}${i + 1}</span>`;

function toggleBreakpoint(path: string | null, line0: number): void {
  if (!path) return;
  if (buffers.get(path)?.untitled) { toast('Save the file first to set a breakpoint.'); return; }
  const list = breakpoints.get(path) ?? [];
  const at = list.findIndex(b => b.line === line0 + 1);
  if (at >= 0) list.splice(at, 1); else list.push({ line: line0 + 1, enabled: true });
  list.sort((a, c) => a.line - c.line);
  breakpoints.set(path, list);
  onBreakpointsChanged(path);
}
// Repaints the gutter, remembers the change, and tells a running debugger.
function onBreakpointsChanged(path: string): void {
  saveBreakpoints();
  repaintMarks(path);
  refreshDebugBreakpoints();
  if (debugLive) background(api.debug.setBreakpoints(path, breakpoints.get(path) ?? []));
}
// After an edit, breakpoints move with their lines exactly as marks do (see shiftMarks); two landing on one line keep
// the first.
function shiftBreakpoints(path: string, before: string, after: string, edits: readonly TextEdit[] | null = null): void {
  const list = breakpoints.get(path);
  if (!list?.length || before === after) return;
  const use = editsFor(before, after, edits);
  const moved: Bp[] = [];
  list.forEach((b, i) => {
    const line = shiftLinesByEdits([b.line - 1], before, use)[0] + 1;
    if (!moved.some(m => m.line === line)) moved.push(line === list[i].line ? b : { ...b, line });
  });
  moved.sort((a, c) => a.line - c.line);
  if (moved.length === list.length && moved.every((m, i) => m === list[i])) return;
  breakpoints.set(path, moved);
  saveBreakpoints();
  verifiedBps.delete(path); // its old lines no longer mean anything; the debugger answers the update below
  refreshDebugBreakpoints();
  if (debugLive) background(api.debug.setBreakpoints(path, moved));
}
// A file or folder was moved: `move` maps each old path to its new one.
function renameBreakpoints(move: (path: string) => string): void {
  const moved = [...breakpoints].map(([p, l]) => [move(p), l] as const);
  breakpoints.clear();
  for (const [p, l] of moved) breakpoints.set(p, l);
  verifiedBps.clear();
  saveBreakpoints();
}

/* ----- The session ----- */
// What the debug page and the status bar know of the one session (main/debug.js). Driven by its events alone:
// start() resolves only once the program runs, and a failed start arrives as an `error` event, then `state: stopped`.
type ExceptionMode = 'none' | 'uncaught' | 'all';
let debugState: DebugState = 'stopped';
let debugFile: string | null = null;      // the file the session runs, or ran last
let debugFrames: DebugFrame[] = [];        // innermost first, while paused
let debugFrameIdx = 0;                     // the frame the page shows (selectFrame)
let debugPause: { reason: string; exception?: string } | null = null;
let debugError: { message: string; hint?: string; python?: string } | null = null; // why the last start failed, until the next one
let debugExit: number | null | undefined;  // the last run's exit code; undefined while none has finished
let debugStopped = false;                  // the user stopped the last run (its exit code says nothing then)
const EXC_KEY = 'breeze.debug.exceptions';
let debugExceptions: ExceptionMode = ((m: unknown) => (m === 'none' || m === 'all' ? m : 'uncaught'))(store.get<unknown>(EXC_KEY, 'uncaught'));

// Python, or JavaScript/TypeScript run by Node; null for anything else (main/debug.js decides the same way).
function debugKind(path: string | null): 'python' | 'node' | null {
  if (!path) return null;
  if (/\.py$/i.test(path)) return 'python';
  return /\.(?:[cm]?js|m?ts)$/i.test(path) ? 'node' : null;
}

// Ctrl+Shift+D: debug the open file (the page's own file while the page shows). With a session already going, it
// just brings the page up.
async function startDebugging(): Promise<void> {
  if (debugState !== 'stopped') { openDebugView(); return; }
  const path = debugPageShowing() ? debugTarget() : active;
  if (!path || !debugKind(path)) { toast('Breeze can debug Python, JavaScript and TypeScript files'); return; }
  await startDebugFile(path);
}
// Saves the file if it has changes (the program runs from disk), shows the page and starts. Every breakpoint goes
// along: main keeps them between sessions and would otherwise still hold another folder's.
async function startDebugFile(path: string): Promise<void> {
  const b = buffers.get(path);
  if (b?.untitled || isDirty(b)) {
    if (!(await saveFile(path))) return;
    if (b?.untitled) path = active ?? path; // saving a new file gives it its real path, in the active tab
  }
  debugFile = path;
  debugError = null;
  debugExit = undefined;
  debugStopped = false;
  debugFrames = [];
  debugPause = null;
  forgetDebugSources();
  resetDebugPanels();
  openDebugView();
  try {
    await api.debug.start(path, { breakpoints: Object.fromEntries(breakpoints), exceptions: debugExceptions });
  } catch (e) { // refused before it began (no folder open, a file outside it): no events follow
    debugError = { message: errMsg(e) };
    renderDebug();
  }
}
// Restart runs the file again from the top, saved first like a start.
async function restartDebugging(): Promise<void> {
  if (debugState !== 'stopped' && debugFile) await startDebugFile(debugFile);
}
function stopDebugging(): void {
  if (debugState === 'stopped') return;
  debugStopped = true;
  background(api.debug.stop());
}
// Pause on uncaught exceptions, on every exception, or on none. Remembered for later sessions too.
function setDebugExceptions(mode: ExceptionMode): void {
  debugExceptions = mode;
  store.set(EXC_KEY, mode);
  background(api.debug.exceptions(mode));
  renderDebug();
}

// The one subscription: the breakpoint dots (above), then the page and the status bar (debugview.ts), then the
// variables, watch, console and output (debugpanels.ts).
api.debug.onEvent(ev => {
  switch (ev.type) {
    case 'state': {
      const live = ev.state !== 'stopped';
      if (live !== debugLive) {
        debugLive = live;
        verifiedBps.clear();
        for (const p of breakpoints.keys()) repaintMarks(p);
      }
      debugState = ev.state;
      if (ev.state === 'starting') debugExit = undefined; // a restart's old run has just reported its exit
      if (ev.state !== 'paused') { debugFrames = []; debugPause = null; } // a pause's own 'paused' event comes first
      break;
    }
    case 'breakpoints':
      verifiedBps.set(ev.file, new Set(ev.lines));
      repaintMarks(ev.file);
      break;
    case 'paused': {
      debugFrames = ev.frames;
      debugPause = { reason: ev.reason, exception: ev.exception };
      debugFrameIdx = Math.max(0, ev.frames.findIndex(f => f.file)); // the innermost frame in the user's own code
      const at = ev.frames[debugFrameIdx];
      // Over in the editor the pause would go unseen: say where it stopped and how to look.
      if (at?.file && !$('#ide').classList.contains('hidden')) toast(`Paused at ${baseName(at.file)} line ${at.line}. Click Debugging in the status bar to see it.`);
      break;
    }
    case 'exited':
      debugExit = ev.code;
      break;
    case 'error':
      debugError = { message: ev.message, hint: ev.hint, python: ev.python };
      break;
    case 'output':
      onDebugOutput(ev.stream, ev.text);
      return;
  }
  onDebugEvent(ev);
  onDebugPanelsEvent(ev);
});
