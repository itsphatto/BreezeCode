/* ================= Workspace ================= */
// A history step. Only the newest step of a stack keeps its whole text; older ones keep `edit`, which turns the
// step above them back into theirs (see pushSnap / popSnap).
interface Snapshot { text?: string; edit?: TextEdit; sel: [number, number]; }
interface EditorBuffer {
  path: string;
  kind: 'text' | 'binary' | 'large' | 'image' | 'video' | 'pdf';
  text: string;
  saved: string;
  eol: '\n' | '\r\n';
  size: number;
  ta: CodeSurface | null;
  url?: string;          // images and videos: where the file loads from
  diags?: Diag[];        // syntax errors from the last check
  diagLines?: number;    // line count the errors were found at (they're hidden while it differs)
  runDiags?: Diag[];     // the entries of `diags` that came from the last failed run (cleared by the next run or lint)
  lintSeq?: number;
  lintTimer?: TimeoutId;
  undo: Snapshot[];      // the editor keeps its own history (see "Undo & redo")
  redo: Snapshot[];
  lastEdit: { kind: string; at: number } | null;
  disk?: string;         // the file's newer text on disk, changed by something else while this buffer had unsaved edits
  untitled?: boolean;    // a new file not saved anywhere yet (see untitledBuffer): saving asks where first
}
interface Session { tabs: string[]; active: string | null; expanded: string[]; pos: Record<string, [number, number]>; }

let rootInfo: RootInfo | null = null;
// True until start-up has tried to reopen the last folder: the panels show placeholders instead of "no folder".
let restoringWorkspace = true;
// Grey bars standing in for a panel's rows while they load, so the panel doesn't flash an empty state first.
const skeletonRows = (n: number) => `<div class="skel" aria-hidden="true">${Array.from({ length: n }, (_, i) => `<i class="skel-row w${i % 4}"></i>`).join('')}</div>`;
const dirCache = new Map<string, DirEntry[]>();
const expanded = new Set<string>();
const buffers = new Map<string, EditorBuffer>();
// Keyed by each surface's hidden input, the element key events and focus land on.
const textareaOwner = new WeakMap<HTMLTextAreaElement, EditorBuffer>();
const surfaceOf = (el: EventTarget | null): CodeSurface | undefined => textareaOwner.get(el as HTMLTextAreaElement)?.ta ?? undefined;
const isDirty = (b?: EditorBuffer) => !!b && b.kind === 'text' && b.text !== b.saved;
// An untitled tab's path sits in a folder no real path can have (Windows names can't hold ':'), so it never meets a
// file's, while its name and extension still pick the icon, the highlighting and the Run button.
const UNTITLED_DIR = ':untitled';
const isUntitled = (p: string | null | undefined) => !!p && p.startsWith(UNTITLED_DIR);
// A path as the user should read it: an untitled tab is just its name.
const shownPath = (p: string) => isUntitled(p) ? baseName(p) : p;
let sessionTimer: TimeoutId | undefined;
let openTabs: string[] = [];
let active: string | null = null;
// The files agents are editing: the phase (for its colour) and the agent itself (a team has several).
const locks: Record<string, { phase: AgentKey; agent: string }> = {};
const added: Record<string, Set<number>> = {};
let ctxPath: string | null = null;

async function refreshLiveShare(): Promise<void> {
  const button = $('#liveShare');
  const status = await api.live.status().catch(() => null);
  const show = !!rootInfo && !!status?.available;
  const running = !!status?.running;
  button.classList.toggle('hidden', !show);
  button.classList.toggle('live', running);
  button.title = running
    ? `Live Share is running at ${status?.url ?? ''} · Click to turn off`
    : 'Host index.html locally and open it in your browser';
  swapText($('span', button), running ? 'Live Share: on' : 'Live Share');
  void setIcon(button, running ? 'stop' : 'play');
}

async function toggleLiveShare(): Promise<void> {
  try {
    const current = await api.live.status().catch(() => null);
    if (current?.running) {
      await api.live.stop();
      await refreshLiveShare();
      toast('Live Share turned off');
      return;
    }
    const live = await api.live.start();
    await refreshLiveShare();
    toast(`Live Share opened at ${live.url}`);
  } catch (e) {
    toast(errMsg(e));
  }
}

$('#liveShare').onclick = () => background(toggleLiveShare());

const sessionKey = () => `breeze.session:${rootInfo?.root ?? ''}`;
const hotExitKey = () => `breeze.dirty:${rootInfo?.root ?? ''}`;

function saveSession(): void {
  if (!rootInfo) return;
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(flushSession, 300);
}
function flushSession(): void {
  if (!rootInfo) return;
  clearTimeout(sessionTimer);
  const pos: Session['pos'] = {};
  // A hidden surface reads scrollTop 0; a restored offset still waiting to be applied is the real one.
  // Untitled tabs have no file to reopen, so they stay out.
  const onDisk = (p: string | null) => !!p && !isUntitled(p);
  for (const b of buffers.values()) if (b.ta && onDisk(b.path)) pos[b.path] = [b.ta.selectionStart, pendingScroll.get(b) ?? b.ta.scrollTop];
  store.set(sessionKey(), { tabs: openTabs.filter(onDisk), active: onDisk(active) ? active : null, expanded: [...expanded], pos } as Session);
  // Hot exit: unsaved edits survive a reload or a crash.
  const dirty: Record<string, string> = {};
  for (const b of buffers.values()) if (isDirty(b) && onDisk(b.path)) dirty[b.path] = b.text;
  if (Object.keys(dirty).length) store.set(hotExitKey(), dirty); else store.del(hotExitKey());
}
window.addEventListener('beforeunload', flushSession);
