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
interface AgentEvent { t: 'session' | 'approve' | 'draft' | 'text' | 'plan' | 'tool' | 'file' | 'note' | 'error' | 'done' | 'auth' | 'auth-required' | 'crossing' | 'team-done'; id?: string; model?: string; text?: string; kind?: string; label?: string; path?: string; hint?: string; ok?: boolean; stopped?: boolean; cost?: number; ms?: number; tokens?: number; url?: string; command?: string; agent?: string; owner?: string; blocked?: boolean; created?: boolean; error?: string; teamId?: string; changed?: string[]; notes?: Record<string, Record<string, string>>; skipped?: string[]; }
// Agent teams: one prompt, several agents building in parallel (main process: team.js).
// Skills view (main/skills.js): a skill is a folder with a SKILL.md; `id` is that folder.
interface AgentSkill { id: string; file: string; folder: string; name: string; description: string; agent: string; scope: 'user' | 'plugin' | 'synced' | 'builtin'; removable: boolean; plugin?: string; agents?: string[]; }
// `synced`: from the user's Claude account, which turns it on and off (no switch here).
interface AgentPlugin { id: string; name: string; marketplace: string; version: string; description: string; enabled: boolean; synced: boolean; skills: AgentSkill[]; }
// MCP servers (main/mcp.js): `breeze` ones are connected here and handed to Claude Code runs; `claude` ones are
// set up in Claude Code itself (scope user, local or project) and only shown.
interface McpServer { name: string; type: 'stdio' | 'http'; detail: string; scope?: 'user' | 'local' | 'project'; }
interface McpList { breeze: McpServer[]; claude: McpServer[]; }
interface McpInput { name: string; type: 'stdio' | 'http'; command?: string; env?: string; url?: string; headers?: string; }
// A skill's `agents`: every agent that has it (Breeze links each skill into every agent's folder).
interface SkillList { skills: AgentSkill[]; plugins: AgentPlugin[]; }
interface TeamParse { shared: string; tasks: { agentId: string; text: string }[]; unknown: string[]; }
interface TeamClaimResult { teamId: string; claims: Record<string, string[]>; clashes: { path: string; agents: string[] }[]; failed: string[]; sessions: Record<string, string>; }
interface AuthEvent { t: 'code' | 'waiting' | 'done' | 'error'; provider?: string; code?: string; uri?: string; user?: User; text?: string; }
interface GitFile { path: string; x: string; y: string; }
interface GitStatus { repo: boolean; branch?: string; upstream?: string; ahead?: number; behind?: number; incoming?: string[]; hasCommits?: boolean; hasRemote?: boolean; files?: GitFile[]; ignored?: string[]; }
interface GitCommit { hash: string; parents: string[]; author: string; when: string; refs: string[]; subject: string; }
interface GitCommitDetail { hash: string; author: string; email: string; when: string; message: string; files: { path: string; added: number; removed: number }[]; }
// GitHub pull requests (main/github.js). Every call resolves to a GhResult and never rejects; `error` is a GithubError
// code ('reauth', 'forbidden', 'not-found', 'not-mergeable', 'head-changed', 'rate-limit', 'http'), why there is no
// GitHub to ask ('signed-out', 'not-github', 'no-remote'), or 'invalid' for arguments main refused. A 'rate-limit'
// carries resetAt: when the limit lifts, in epoch seconds (null when GitHub didn't say).
interface GhPull {
  number: number; title: string; author: string; avatar: string;
  head: { ref: string; label: string; sha: string; repo: string | null };
  base: string; draft: boolean; commits?: number;
  mergeable: boolean | null; mergeableState: string; // 'clean', 'dirty' (conflicts), 'blocked', 'unknown'…
  url: string; createdAt: string;
}
interface GhCommit { sha: string; message: string; author: string; avatar: string | null; date: string | null; }
interface GhComment { id: number; author: string; avatar: string | null; body: string; createdAt: string | null; url: string; }
interface GhFile { path: string; previous: string | null; status: string; additions: number; deletions: number; patch: string | null; }
type GhResult<T> = { ok: true; data: T } | { ok: false; error: string; message?: string; resetAt?: number | null };
// A year of GitHub contributions: weeks run Sunday to Saturday (the first and last can be short); level is 0–4.
interface GhContributions { login: string; total: number; weeks: { date: string; count: number; level: number }[][]; }
// partial: asking GitHub for each pull request's details stopped early (a rate limit or an expired sign-in), so some
// rows may still read "checking".
interface GhPullList { owner: string; repo: string; pulls: GhPull[]; partial?: 'rate-limit' | 'reauth' | null; }

// A pull request's conflicts being resolved in a separate worktree (main/prconflict.js). For a 'text' file `ours` is the
// pull request's version, `theirs` the base branch's; null means that side deleted it. `merged` is the file with
// conflict markers. A 'binary' file (not UTF-8 text) is never decoded: ours, theirs and merged are null, hasOurs /
// hasTheirs say which sides have it, and it is resolved by keeping one side or deleting it.
interface ConflictFile {
  path: string; kind: 'text' | 'binary';
  ours: string | null; theirs: string | null; merged: string | null;
  hasOurs: boolean; hasTheirs: boolean;
}
interface ConflictSession { id: string; number: number; base: string; headRef: string; clean: boolean; files: ConflictFile[]; }
// A text file's result (null deletes it), or a binary file's choice.
type ConflictResult = { path: string; text: string | null } | { path: string; choice: 'ours' | 'theirs' | 'delete' };
// How finishing went: stage 'commit' means nothing was committed (the page stays editable), 'push' that the resolution
// is committed in the worktree and finishing again only retries the push.
type ConflictFinish = { ok: true } | { ok: false; stage: 'commit' | 'push'; message: string };

interface DirEntry { name: string; dir: boolean; }
interface FileRead { text?: string; binary?: boolean; tooLarge?: boolean; image?: boolean; video?: boolean; pdf?: boolean; size: number; }
type NbMessage = { id: string } & (
  | { type: 'stream'; name: string; text: string }
  | { type: 'display' | 'result'; data: Record<string, string> }
  | { type: 'error'; ename: string; evalue: string; traceback: string[] }
  | { type: 'done'; count?: number });
interface Diag { line: number; col: number; len: number; msg: string; sev?: number; } // sev 2: a warning
type SyntaxResult = { ok: true } | (Diag & { eof?: boolean }) | null;
interface RootInfo { root: string; name: string; }
// A folder opened from Explorer's "Open with Breeze Code", with the file that was right-clicked (project-relative).
interface LaunchInfo extends RootInfo { open: string | null; launched: true; }
interface SearchHit { path: string; line: number; col: number; text: string; }
interface DetectedAgent { id: string; name: string; vendor: string; url: string; found: boolean; path: string | null; version: string | null; api?: boolean; models?: string[]; install?: string | null; }
// Tokens each agent used this month (counted by Breeze), and the plan windows the agent itself reports (percent used).
interface LimitWindow { label: string; used: number; resetsAt: number | null; }
interface AgentUsage { usage: Record<string, number>; limits: Record<string, LimitWindow[]>; notes: Record<string, string | null>; }
// The last days of each agent's tokens by kind ("other" when the kind isn't known), its tool calls and last use (ms).
// cost: what the day's tokens would cost at API list prices (USD); 0 for an agent that isn't `priced`. unpriced: tokens
// from a model with no known price, left out of the cost.
interface TokenDay { input: number; output: number; cacheWrite: number; cacheRead: number; other: number; cost?: number; }
interface AgentHistory { from: string; days: number; agents: Record<string, { days: Record<string, TokenDay>; tools: number; last: number; priced?: boolean; unpriced?: number }>; }
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
interface DiscordActivity { details?: string; state?: string; start?: number; icon?: string; lang?: string; dev?: boolean; }
interface RecentFolder { path: string; name: string; openedAt?: number | null; missing?: boolean; }
interface LiveStatus { available: boolean; running: boolean; url: string; }

// Language server answers (main/lsp.js).
interface LspOpen { available: boolean; install?: string | null; error?: string; }
interface LspCompletion { label: string; kind: number; detail: string; sort: string; filter: string; insert: string; from: { line: number; character: number } | null; }
interface LspLocation { path: string | null; file: string; line: number; col: number; len: number; text?: string; }
interface LspEdit { start: { line: number; character: number }; end: { line: number; character: number }; text: string; }

// The debugger (main/debug.js): one session, Python or JavaScript/TypeScript.
interface Bp { line: number; enabled: boolean; condition?: string; hitCondition?: string; logMessage?: string; } // line is 1-based
interface DebugFrame { id: number; name: string; file: string | null; line: number; col: number; } // file project-relative, null for internals
interface DebugValue { name: string; value: string; type: string; ref: number; } // ref > 0 = expandable
type DebugState = 'starting' | 'running' | 'paused' | 'stopped';
type DebugEvent =
  | { type: 'state'; state: DebugState }
  | { type: 'paused'; reason: string; frames: DebugFrame[]; exception?: string }
  | { type: 'output'; stream: 'stdout' | 'stderr' | 'console'; text: string }
  | { type: 'breakpoints'; file: string; lines: number[] } // verified lines
  | { type: 'exited'; code: number | null }
  | { type: 'error'; message: string; hint?: 'install-debugpy' | 'node-too-old' | 'not-found'; python?: string }; // python: the interpreter missing debugpy
interface DebugStartOptions { stopOnEntry?: boolean; breakpoints?: Record<string, Bp[]>; exceptions?: 'none' | 'uncaught' | 'all'; }

// The titlebar Update button's state, sent by main.js's updater.
interface UpdateState { state: 'idle' | 'available' | 'downloading' | 'ready'; version?: string; percent?: number; }

interface BreezeApi {
  version?: string;
  platform?: string;
  fs: {
    openFolder(): Promise<RootInfo | null>;
    createFolder(): Promise<RootInfo | null>;
    // Asks where to put it, clones the repository there and opens it; null when the folder pick is cancelled.
    clone(url: string): Promise<RootInfo | null>;
    openFile(): Promise<LaunchInfo | null>;
    newFile(name: string, text: string): Promise<LaunchInfo | null>;
    restore(): Promise<RootInfo | LaunchInfo | null>;
    openLaunch(): Promise<LaunchInfo | null>;
    onLaunchRequest(cb: (dir: string) => void): () => void;
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
    copy(from: string, to: string): Promise<void>;
    reveal(rel: string): Promise<void>;
    trash(rel: string, keep?: boolean): Promise<string | null>;
    untrash(id: string, rel: string): Promise<void>;
    listFiles(): Promise<string[]>;
    search(query: string, matchCase: boolean): Promise<SearchHit[]>;
    fileUrl(rel: string): Promise<string>;
    previewUrl(rel: string): Promise<string>;
    onChange(cb: (paths: string[]) => void): () => void;
    onWatchLost(cb: (reason: string) => void): () => void;
    importFile(dir: string, name: string, data: Uint8Array): Promise<string>;
    // Keeps a pasted attachment in the temp folder (outside the project) and says where.
    stashAttachment(name: string, data: Uint8Array): Promise<{ path: string; url: string }>;
  };
  debug: {
    // Resolves once the program is running (or the attempt is over); failures arrive as `error` events.
    start(rel: string, opts?: DebugStartOptions): Promise<void>;
    stop(): Promise<void>;
    restart(): Promise<void>;
    pause(): Promise<void>;
    continue(): Promise<void>;
    step(kind: 'over' | 'into' | 'out'): Promise<void>;
    runTo(rel: string, line: number): Promise<void>;
    setBreakpoints(rel: string, bps: Bp[]): Promise<void>;
    exceptions(mode: 'none' | 'uncaught' | 'all'): Promise<void>;
    scopes(frameId: number): Promise<DebugValue[]>;
    children(ref: number): Promise<DebugValue[]>;
    evaluate(expr: string, frameId: number | undefined, context: 'watch' | 'repl' | 'hover'): Promise<DebugValue>;
    setValue(ref: number, name: string, value: string): Promise<DebugValue>;
    stdin(text: string): Promise<boolean>;
    // Downloads netcoredbg (for C#) into Breeze's data folder; resolves with its path.
    installNetcoredbg(): Promise<string>;
    onEvent(cb: (ev: DebugEvent) => void): () => void;
  };
  lint: { check(code: string, ext: string): Promise<SyntaxResult>; };
  // Notebook kernels: replies to run() arrive as messages named by the request's id.
  nb: {
    run(rel: string, id: string, code: string): Promise<void>;
    stop(rel: string): Promise<void>;
    onMessage(cb: (rel: string, msg: NbMessage) => void): () => void;
    onState(cb: (rel: string, state: 'idle' | 'busy' | 'dead') => void): () => void;
  };
  lsp: {
    open(rel: string, text: string): Promise<LspOpen>;
    // The whole new text, or one edit in offsets of the text sent before.
    change(rel: string, change: string | { start: number; end: number; text: string }): Promise<void>;
    close(rel: string): Promise<void>;
    completion(rel: string, line: number, ch: number): Promise<LspCompletion[]>;
    hover(rel: string, line: number, ch: number): Promise<string | null>;
    definition(rel: string, line: number, ch: number): Promise<LspLocation[]>;
    references(rel: string, line: number, ch: number): Promise<LspLocation[]>;
    rename(rel: string, line: number, ch: number, name: string): Promise<Record<string, LspEdit[]>>;
    // A file's errors and warnings from its server, for the text that had `lines` lines.
    onDiagnostics(cb: (rel: string, diags: Diag[], lines: number) => void): () => void;
  };
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
  update: { get(): Promise<UpdateState>; download(): Promise<void>; install(): Promise<void>; onState(cb: (s: UpdateState) => void): () => void; };
  sys: { detect(force?: boolean): Promise<Detection>; openExternal(url: string): Promise<void>; runCommand(cmd: string): Promise<boolean>; getPathForFile?(file: File): string; };
  live: { status(): Promise<LiveStatus>; start(): Promise<LiveStatus>; stop(): Promise<LiveStatus>; };
  // A local LLM server (Ollama, LM Studio or anything OpenAI-compatible).
  // An empty url makes the desktop app look for Ollama or LM Studio at their usual addresses.
  llm: { connect(url: string, key: string): Promise<{ url?: string; model: string; models: string[] }>; setModel(model: string): Promise<void>; disconnect(): Promise<void>; };
  // Emmet abbreviation expansion; the snippet uses ${N} / ${N:placeholder} fields, or null when nothing expands.
  emmet: { expand(abbr: string, syntax: string): Promise<string | null>; };
  // Discord Rich Presence through the Discord app on this computer.
  discord: { set(activity: DiscordActivity): Promise<{ user: string | null }>; clear(): Promise<void>; };
  agent: {
    run(opts: { agent: string; mode: AgentMode; prompt: string; session: string | null; box?: boolean }): Promise<number>;

    stop(runId: number): Promise<void>;
    answer(id: string, answer: 'once' | 'all' | 'deny'): Promise<void>;
    setModel(agent: string, model: string, effort?: string): Promise<boolean>;
    fullAccess(): Promise<boolean>;
    setFullAccess(on: boolean): Promise<boolean>;
    usage(): Promise<AgentUsage>;
    history(): Promise<AgentHistory>;
    // One question to the user's agent, read-only; its reply as it came (no commit-message clean-up).
    ask(opts: { agent: string; prompt: string; model?: string; effort?: string }): Promise<string>;
    onEvent(cb: (runId: number, ev: AgentEvent) => void): () => void;
  };
  mcp: {
    list(): Promise<McpList>;
    add(input: McpInput): Promise<McpServer>;
    remove(name: string): Promise<boolean>;
  };
  skills: {
    list(): Promise<SkillList>;
    read(file: string): Promise<string>;
    remove(dir: string): Promise<boolean>;
    setPlugin(id: string, on: boolean): Promise<boolean>;
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
    fileLog(rel: string): Promise<{ hash: string; author: string; when: string; subject: string }[]>;
    fileShow(hash: string, rel: string): Promise<string>;
    headText(rel: string): Promise<string | null>;
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
    // Main asks GitHub for the pull request's branches and where it lives; only its number is sent.
    prConflictStart(n: number): Promise<ConflictSession>;
    // Rejects only for an ended session or a resolution that doesn't fit it; git failures resolve to { ok: false, stage }.
    prConflictFinish(id: string, results: ConflictResult[]): Promise<ConflictFinish>;
    prConflictAbort(id: string): Promise<void>;
  };
  gh: {
    prs(base: string, force?: boolean): Promise<GhResult<GhPullList>>;
    pr(n: number): Promise<GhResult<GhPull>>;
    prCommits(n: number): Promise<GhResult<GhCommit[]>>;
    prFiles(n: number): Promise<GhResult<GhFile[]>>;
    commit(sha: string): Promise<GhResult<GhFile[]>>;
    repo(): Promise<GhResult<{ allowMerge: boolean; allowSquash: boolean; allowRebase: boolean }>>;
    merge(n: number, method: 'merge' | 'squash' | 'rebase', sha: string): Promise<GhResult<{ merged: boolean; message: string }>>;
    // The pull request's conversation (its issue comments), adding one, and closing it without merging.
    comments(n: number): Promise<GhResult<GhComment[]>>;
    comment(n: number, body: string): Promise<GhResult<GhComment>>;
    close(n: number): Promise<GhResult<{ closed: boolean }>>;
    // The active account's last year of contributions; error 'not-github' when the active account isn't GitHub.
    contributions(): Promise<GhResult<GhContributions>>;
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
    remove(id: string): Promise<{ ok: true } | SyncFail>;
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
  win: { reload(): Promise<void>; toggleDevTools(): Promise<void>; quit(): Promise<void>; edit(role: string): Promise<void>; theme(t: Theme): Promise<void>; devIcon(on: boolean): Promise<void>;
    minimize(): Promise<void>; toggleMaximize(): Promise<void>; close(): Promise<void>; isMaximized(): Promise<boolean>;
    newTerminal(): Promise<void>;
    onMaximized(cb: (maximized: boolean) => void): () => void;
    termPopup(action: 'minimize' | 'toggleMaximize'): Promise<void>; // the popped-out terminal's window (layout.ts)
    onTermMaximized(cb: (maximized: boolean) => void): () => void;
    launchWait(): Promise<number | null>; launchShow(): Promise<void>; launchFade(): Promise<void>; };
}
interface Window { breeze?: BreezeApi; }

/* ================= Helpers ================= */
// Pages of windows the IDE has moved some of its own elements into (the popped-out terminal, terminal.ts). Looking
// something up on the page also looks there, so code keeps finding those elements by id wherever they are.
const elsewhere: Document[] = [];
function $<T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document): T {
  let el = r.querySelector(s);
  if (!el && r === document) for (const d of elsewhere) if ((el = d.querySelector(s))) break;
  return el as T;
}
function $$<T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document): T[] {
  const all = [...r.querySelectorAll<T>(s)];
  if (r === document) for (const d of elsewhere) all.push(...d.querySelectorAll<T>(s));
  return all;
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
  if (!el.isConnected) { el.textContent = text; return; }
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
// The big screen changes (the flight to and from Breeze Space, the debugger taking over panel by panel) are opt-in;
// without them screens cross-fade in place.
let bigAnim = store.get<boolean>('breeze.bigAnim', false) === true;
// The code font size in px (editors, the debugger's source). The line height follows it.
const CODE_SIZE_MIN = 10, CODE_SIZE_MAX = 24, CODE_SIZE_DEFAULT = 13;
let codeSize = clamp(Math.round(Number(store.get<number>('breeze.codeSize', CODE_SIZE_DEFAULT)) || CODE_SIZE_DEFAULT), CODE_SIZE_MIN, CODE_SIZE_MAX);

/* ----- Redrawing lists: only the rows that changed ----- */
// Replacing a whole list (the code window per keystroke, the file tree per file change) makes the browser style
// and lay out every row again. Instead each row keeps the
// html it was drawn from; rows whose html is unchanged stay, new ones are made, and old ones nobody wants go.
// Rows are matched by html in order, so lines that slid up or down (Enter, scrolling) are kept and not redrawn.
const drawnHtml = new WeakMap<Element, string>();
const rowMaker = document.createElement('template');
function patchRows(el: HTMLElement, rows: string[]): void {
  const old = Array.from(el.children);
  const free = new Map<string, number[]>(); // html → old row indexes, in order
  old.forEach((n, i) => {
    const h = drawnHtml.get(n);
    if (h !== undefined) { const at = free.get(h); if (at) at.push(i); else free.set(h, [i]); }
  });
  const used = new Set<number>();
  let lastOld = -1;
  const nodes: (Element | undefined)[] = rows.map(h => {
    const at = free.get(h);
    if (!at?.length) return undefined;
    // Prefer the first match after the last row kept, so a run of lines that slid keeps its order.
    let k = at.findIndex(i => i > lastOld);
    if (k < 0) k = 0;
    const i = at.splice(k, 1)[0];
    used.add(i); lastOld = i;
    return old[i];
  });
  const fresh = rows.filter((_, j) => !nodes[j]);
  if (fresh.length === rows.length) { // nothing to keep: one parse is quickest
    el.innerHTML = rows.join('');
    Array.from(el.children).forEach((n, j) => drawnHtml.set(n, rows[j]));
    return;
  }
  rowMaker.innerHTML = fresh.join('');
  const made = Array.from(rowMaker.content.children);
  let m = 0;
  rows.forEach((h, j) => { if (!nodes[j]) { nodes[j] = made[m++]; drawnHtml.set(nodes[j]!, h); } });
  old.forEach((n, i) => { if (!used.has(i)) n.remove(); });
  let cur = el.firstElementChild;
  for (const n of nodes as Element[]) {
    if (n === cur) cur = cur.nextElementSibling;
    else el.insertBefore(n, cur);
  }
}
// A row changed by hand (the current line's highlight, a folder's chevron) no longer matches its html, so it is never kept.
const forgetRow = (n: Element | undefined) => { if (n) drawnHtml.delete(n); };
