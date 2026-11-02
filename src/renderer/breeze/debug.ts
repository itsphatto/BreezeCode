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

api.debug.onEvent(ev => {
  if (ev.type === 'state') {
    const live = ev.state !== 'stopped';
    if (live !== debugLive) {
      debugLive = live;
      verifiedBps.clear();
      for (const p of breakpoints.keys()) repaintMarks(p);
    }
  } else if (ev.type === 'breakpoints') {
    verifiedBps.set(ev.file, new Set(ev.lines));
    repaintMarks(ev.file);
  }
});
