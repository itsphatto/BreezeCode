/* Breeze Code — renderer logic.
   Files, search, terminal and agent detection are real in the desktop app (main.js + preload.js).
   Opened in a plain browser, a small in-memory demo project stands in for the disk.
   Agent conversations, checkpoints and collaboration are still simulated.

   The renderer is the files in this folder, one per feature, loaded in order as classic scripts by breeze.html
   (after editcore.js and codeview.js). They share one global scope: no imports or exports. Code that runs while a
   file loads can only use what that file and the ones before it declare; that includes a promise callback (.then, or
   code after an await) started during loading, which can run before the next file does. Event handlers, timers and
   anything run from boot() in init.ts can use every file. This file holds the shared types and helpers. */

/* ================= Types ================= */
type TimeoutId = ReturnType<typeof setTimeout>;
type IntervalId = ReturnType<typeof setInterval>;
type AgentKey = 'assistant' | 'planner' | 'builder';
type AgentStatus = 'idle' | 'working' | 'waiting' | 'done';

interface Agent {
  name: string;
  letter: string;
  tint: string;   // colour class suffix, see .tint-* in breeze.css
  model: string;
  status: AgentStatus;
  task: string;
  used: number;
  agentId?: string;   // the agent (Codex, Claude Code…) that last took this role; the card wears its name and logo
}
interface User { name: string; provider: string; login?: string; email?: string | null; avatar?: string | null; }
type AgentMode = 'plan' | 'build' | 'ask';
interface AgentEvent { t: 'session' | 'text' | 'plan' | 'tool' | 'file' | 'note' | 'error' | 'done' | 'auth' | 'auth-required' | 'crossing' | 'team-done'; id?: string; model?: string; text?: string; kind?: string; label?: string; path?: string; hint?: string; ok?: boolean; stopped?: boolean; cost?: number; ms?: number; tokens?: number; url?: string; command?: string; agent?: string; owner?: string; blocked?: boolean; error?: string; teamId?: string; changed?: string[]; notes?: Record<string, Record<string, string>>; skipped?: string[]; }
// Agent teams: one prompt, several agents building in parallel (main process: team.js).
interface TeamParse { shared: string; tasks: { agentId: string; text: string }[]; unknown: string[]; }
interface TeamClaimResult { teamId: string; claims: Record<string, string[]>; clashes: { path: string; agents: string[] }[]; failed: string[]; sessions: Record<string, string>; }
interface AuthEvent { t: 'code' | 'waiting' | 'done' | 'error'; provider?: string; code?: string; uri?: string; user?: User; text?: string; }
interface GitFile { path: string; x: string; y: string; }
interface GitStatus { repo: boolean; branch?: string; upstream?: string; ahead?: number; behind?: number; incoming?: string[]; hasCommits?: boolean; hasRemote?: boolean; files?: GitFile[]; ignored?: string[]; }
interface GitCommit { hash: string; parents: string[]; author: string; when: string; refs: string[]; subject: string; }
interface GitCommitDetail { hash: string; author: string; email: string; when: string; message: string; files: { path: string; added: number; removed: number }[]; }

interface DirEntry { name: string; dir: boolean; }
interface FileRead { text?: string; binary?: boolean; tooLarge?: boolean; image?: boolean; size: number; }
interface Diag { line: number; col: number; len: number; msg: string; }
type SyntaxResult = { ok: true } | (Diag & { eof?: boolean }) | null;
interface RootInfo { root: string; name: string; }
interface SearchHit { path: string; line: number; col: number; text: string; }
interface DetectedAgent { id: string; name: string; vendor: string; url: string; found: boolean; path: string | null; version: string | null; api?: boolean; models?: string[]; install?: string | null; }
// Tokens each agent used this month (counted by Breeze), and the plan windows the agent itself reports (percent used).
interface LimitWindow { label: string; used: number; resetsAt: number | null; }
interface AgentUsage { usage: Record<string, number>; limits: Record<string, LimitWindow[]>; }
interface Accounts { accounts: User[]; active: string | null; }
// Workspace sync (main.js + sync.js). A failure comes back as { error, code } instead of throwing.
interface SyncFail { error: string; code: string | null; }
interface CloudWorkspace { id: string; name: string; rev: number; device: string; deviceNo?: number; updatedAt: string; }
interface SyncStatus { remote: CloudWorkspace | null; newer: boolean; workspaces: CloudWorkspace[]; linked: boolean; device: string; }
interface SyncSummary { id: string; rev: number; uploaded: number; downloaded: number; removed: number; conflicts: string[]; backedUp: string[]; skipped: number; }
interface SharedSettings { updatedAt: string; values: Record<string, unknown>; }
interface Completion { text: string; dir: boolean; }
interface DetectedTool { id: string; name: string; found: boolean; version: string | null; optional?: boolean; hint?: string | null; cmd?: string | null; url?: string | null; }
interface Detection { agents: DetectedAgent[]; tools: DetectedTool[]; platform: string; demo?: boolean; }
interface Rect { x: number; y: number; width: number; height: number; }
interface DiscordActivity { details?: string; state?: string; start?: number; }
interface RecentFolder { path: string; name: string; openedAt?: number | null; missing?: boolean; }
interface LiveStatus { available: boolean; running: boolean; url: string; }

interface BreezeApi {
  version?: string;
  fs: {
    openFolder(): Promise<RootInfo | null>;
    createFolder(): Promise<RootInfo | null>;
    restore(): Promise<RootInfo | null>;
    closeFolder(): Promise<void>;
    recent(): Promise<RecentFolder[]>;
    openRecent(dir: string): Promise<RootInfo>;
    forgetRecent(dir: string): Promise<void>;
    readDir(rel: string): Promise<DirEntry[]>;
    readFile(rel: string): Promise<FileRead>;
    writeFile(rel: string, text: string): Promise<void>;
    createFile(rel: string): Promise<void>;
    createDir(rel: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    trash(rel: string): Promise<void>;
    listFiles(): Promise<string[]>;
    search(query: string, matchCase: boolean): Promise<SearchHit[]>;
    fileUrl(rel: string): Promise<string>;
    previewUrl(rel: string): Promise<string>;
    onChange(cb: (paths: string[]) => void): () => void;
    onWatchLost(cb: (reason: string) => void): () => void;
    importFile(dir: string, name: string, data: Uint8Array): Promise<string>;
  };
  lint: { check(code: string, ext: string): Promise<SyntaxResult>; };
  term: {
    cwd(): Promise<string>;
    run(command: string): Promise<{ id?: number; cwd?: string; error?: string }>;
    kill(id: number): Promise<void>;
    write(id: number, text: string): Promise<void>;
    complete(word: string): Promise<Completion[]>;
    onData(cb: (id: number, chunk: string) => void): () => void;
    onExit(cb: (id: number, code: number | null) => void): () => void;
  };
  run: { file(rel: string): Promise<{ id?: number; cwd?: string; error?: string }>; };
  sys: { detect(force?: boolean): Promise<Detection>; openExternal(url: string): Promise<void>; runCommand(cmd: string): Promise<boolean>; getPathForFile?(file: File): string; };
  live: { status(): Promise<LiveStatus>; start(): Promise<LiveStatus>; stop(): Promise<LiveStatus>; };
  // A local LLM server (Ollama, LM Studio or anything OpenAI-compatible).
  // An empty url makes the desktop app look for Ollama or LM Studio at their usual addresses.
  llm: { connect(url: string, key: string): Promise<{ url?: string; model: string; models: string[] }>; setModel(model: string): Promise<void>; disconnect(): Promise<void>; };
  // Discord Rich Presence through the Discord app on this computer.
  discord: { set(activity: DiscordActivity): Promise<{ user: string | null }>; clear(): Promise<void>; };
  agent: {
    run(opts: { agent: string; mode: AgentMode; prompt: string; session: string | null; box?: boolean }): Promise<number>;

    stop(runId: number): Promise<void>;
    setModel(agent: string, model: string, effort?: string): Promise<boolean>;
    fullAccess(): Promise<boolean>;
    setFullAccess(on: boolean): Promise<boolean>;
    usage(): Promise<AgentUsage>;
    onEvent(cb: (runId: number, ev: AgentEvent) => void): () => void;
  };
  team: {
    parse(text: string): Promise<TeamParse>;
    claim(opts: { shared: string; members: { agentId: string; task: string; session: string | null }[] }): Promise<TeamClaimResult>;
    start(opts: { teamId: string; owners: Record<string, string>; exclude?: string[] }): Promise<Record<string, number>>;
    stop(teamId: string): Promise<void>;
    undo(opts: { teamId: string; path: string }): Promise<void>;
  };
  git: {
    status(): Promise<GitStatus>;
    log(): Promise<{ head: string | null; commits: GitCommit[]; details?: GitCommitDetail[] }>;
    show(hash: string): Promise<GitCommitDetail>;
    diff(rel: string | string[], staged: boolean): Promise<string>;
    init(): Promise<unknown>;
    stage(paths: string[]): Promise<unknown>;
    unstage(paths: string[], hasCommits: boolean): Promise<unknown>;
    discard(files: { path: string; untracked: boolean }[]): Promise<void>;
    commit(message: string, all: boolean): Promise<string>;
    branches(): Promise<string[]>;
    switchTo(name: string, create: boolean, from?: string): Promise<unknown>;
    sync(op: 'fetch' | 'pull' | 'push'): Promise<unknown>;
    deleteBranch(name: string): Promise<unknown>;
    genCommitMsg(opts: { agent: string; prompt: string; model?: string; effort?: string }): Promise<string>;
  };
  auth: {
    user(): Promise<User | null>;
    accounts(): Promise<Accounts>;
    switchTo(id: string): Promise<User>;
    start(provider: string): Promise<{ started?: boolean; error?: string }>;
    cancel(): Promise<void>;
    signOut(): Promise<User | null>;
    remove(id: string): Promise<User | null>;
    onEvent(cb: (ev: AuthEvent) => void): () => void;
  };
  sync: {
    status(): Promise<SyncStatus | SyncFail>;
    run(mode: 'sync' | 'pull'): Promise<SyncSummary | SyncFail>;
    clone(id: string): Promise<{ info: RootInfo; summary: SyncSummary } | null | SyncFail>;
    settings(local: SharedSettings | null): Promise<{ settings: SharedSettings | null; pulled: boolean } | SyncFail>;
  };
  // Social feeds for Vibe Mode. The desktop app signs in through its own browser window and lays the feed over #vibeFrame.
  vibe: {
    status(): Promise<Record<string, boolean>>;
    connect(id: string, bounds: Rect): Promise<boolean>;
    connectBounds(bounds: Rect): Promise<void>;
    connectClose(): Promise<void>;
    disconnect(id: string): Promise<void>;
    show(id: string, bounds: Rect): Promise<void>;
    bounds(bounds: Rect): Promise<void>;
    mute(muted: boolean): Promise<void>;
    hide(): Promise<void>;
  };
  win: { reload(): Promise<void>; toggleDevTools(): Promise<void>; quit(): Promise<void>; edit(role: string): Promise<void>; theme(t: Theme): Promise<void>;
    clearBar(on: boolean): Promise<void>; launchWait(): Promise<number | null>; launchShow(): Promise<void>; };
}
interface Window { breeze?: BreezeApi; }

/* ================= Helpers ================= */
function $<T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document): T {
  return r.querySelector(s) as T;
}
function $$<T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document): T[] {
  return [...r.querySelectorAll<T>(s)];
}
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const esc = (s: string): string => s.replaceAll(/[&<>]/g, c => ESCAPES[c]);
const escAttr = (s: string): string => esc(s).replaceAll('"', '&quot;');
const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const dirName = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const forceReflow = (el: HTMLElement): number => el.offsetWidth;
// IPC errors arrive as "Error invoking remote method 'x': Error: message" — keep only the message.
const errMsg = (e: unknown): string => {
  const text = e instanceof Error ? e.message : String(e);
  return text.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
};
// Folders first, then names A–Z.
const byDirThenName = (a: DirEntry, b: DirEntry): number => {
  if (a.dir !== b.dir) return a.dir ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
};

function toast(text: string): void {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = text;
  $('#toastRoot').replaceChildren(t);
  sfx.play('ping');
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 200); }, 2600);
}
// Changes a label's text with a quick fade-in, and lets its box grow or shrink to the new width instead of jumping.
function swapText(el: HTMLElement, text: string): void {
  if (el.textContent === text) return;
  if (!el.isConnected || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = text; return; }
  const from = el.getBoundingClientRect().width;
  el.textContent = text;
  el.getAnimations().forEach(a => { if (a.id === 'swap') a.cancel(); });
  const fade = el.animate([{ opacity: 0, filter: 'blur(3px)', transform: 'translateY(2px)' }, { opacity: 1, filter: 'blur(0)', transform: 'none' }], { duration: 240, easing: 'cubic-bezier(.2, .8, .2, 1)' });
  fade.id = 'swap';
  const to = el.getBoundingClientRect().width;
  if (Math.abs(from - to) < 1 || getComputedStyle(el).display === 'inline') return;
  const { overflow, whiteSpace } = el.style;
  el.style.overflow = 'hidden';
  el.style.whiteSpace = 'nowrap';
  const size = el.animate([{ width: `${from}px` }, { width: `${to}px` }], { duration: 300, easing: 'cubic-bezier(.32, .72, 0, 1)' });
  size.id = 'swap';
  const done = () => { el.style.overflow = overflow; el.style.whiteSpace = whiteSpace; };
  size.onfinish = done; size.oncancel = done;
}
// Starts async work without waiting for it; a failure shows as a toast.
function background(work: Promise<unknown>): void {
  work.catch(e => toast(errMsg(e)));
}

const store = {
  get<T>(key: string, fallback: T): T {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v) as T; } catch { return fallback; }
  },
  set(key: string, value: unknown): void {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked or full */ }
  },
  del(key: string): void {
    try { localStorage.removeItem(key); } catch { /* storage blocked */ }
  },
};

/* ================= Appearance ================= */
// Set as early as the page's scripts run, so the window comes up in the chosen colours (Settings → Appearance).
type Theme = 'dark' | 'contrast' | 'light';
const THEME_IDS: Theme[] = ['dark', 'contrast', 'light'];
const savedTheme = store.get<string>('breeze.theme', 'dark');
let theme: Theme = THEME_IDS.find(t => t === savedTheme) ?? 'dark';
document.documentElement.dataset.theme = theme;

