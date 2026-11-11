// DebugManager: runs the user's file under a debugger and turns each backend into one session API.
// Breeze launches the program itself, so it owns stdin/stdout/stderr; the backend (debugPython.js → debugpy over DAP,
// debugNode.js → node --inspect-brk over CDP, debugGdb.js → GDB over DAP for C, C++ and Rust) only speaks the
// protocol. One session at a time.
// Emits 'event' with a DebugEvent ({ type: 'state' | 'paused' | 'output' | 'breakpoints' | 'exited' | 'error', … }).
import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { PythonBackend, debugpyArgs } from './debugPython';
import { NodeBackend, nodeSupportsTs } from './debugNode';
import { GdbBackend } from './debugGdb';
import { JavaBackend } from './debugJava';
import { DotnetBackend } from './debugDotnet';
import type { GdbBuild } from './debugGdb';
import type { Backend, Bp, DebugEvent, DebugState, Host, Launch } from './debugTypes';

// What the page asks start() for. The tool paths and `build` come from the toolchain lookup in main.ts.
export interface StartOptions {
  root: string; file: string;
  breakpoints?: Record<string, Bp[]>;
  exceptions?: string;
  stopOnEntry?: boolean;
  env?: NodeJS.ProcessEnv;
  python?: string; node?: string; gdb?: string; java?: string; javac?: string; dotnet?: string; netcoredbg?: string;
  build?: GdbBuild; buildError?: string;
  hookSrc?: string; hookDir?: string; project?: string | null;
  args?: string[];
}
// One run of the debugger: its options, state, process and backend.
interface Session {
  opts: StartOptions;
  state: DebugState | null;
  child: ChildProcess | null;
  backend: Backend | null;
  live: boolean;
  dead: boolean;
  finished: boolean;
  exitCode: number | null | undefined;
  out: { stdout: string; stderr: string };
  timer: NodeJS.Timeout | null;
  superseded?: boolean;
  after?: Promise<unknown>;
  stopping?: Promise<void>;
  spawnFailed?: boolean;
}
type HintedError = Error & { hint?: string; python?: string };

const REQUEST_MS = 10000; // an adapter call that takes longer is a hung adapter: reject that call, keep the session
const CONNECT_MS = 15000; // finding, connecting to and configuring the adapter
const STOP_MS = 3000;     // how long stop() waits for the process tree to go before calling it stopped anyway
const OUTPUT_MS = 50;     // program output is coalesced per stream, so a chatty program doesn't flood the page

const TASKKILL = path.join(process.env.SystemRoot || String.raw`C:\Windows`, 'System32', 'taskkill.exe');
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32') execFile(TASKKILL, ['/pid', String(child.pid), '/T', '/F'], () => { /* already gone */ });
  else child.kill('SIGTERM');
}

const NODE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts']);
const NATIVE_EXTS = new Set(['.c', '.cpp', '.cc', '.cxx', '.rs']);
function debugKind(file: unknown): 'python' | 'native' | 'java' | 'dotnet' | 'node' | null {
  const ext = path.extname(String(file || '')).toLowerCase();
  if (ext === '.py') return 'python';
  if (NATIVE_EXTS.has(ext)) return 'native';
  if (ext === '.java') return 'java';
  if (ext === '.cs') return 'dotnet';
  return NODE_EXTS.has(ext) ? 'node' : null;
}
const UNSUPPORTED = 'Breeze can debug Python, JavaScript, TypeScript, C, C++, C#, Rust and Java files';
const isTs = (file: string) => /\.m?ts$/i.test(file);

function launchArgs(kind: string, file: string, { port, ts, args }: Launch = {}): { args: string[] } {
  if (kind === 'python') return { args: debugpyArgs(['--listen', `127.0.0.1:${port}`, '--wait-for-client', file]) };
  if (kind === 'native') return { args: [] }; // the built program, which waits for GDB itself
  if (kind === 'java' || kind === 'dotnet') return { args: args ?? [] };
  return { args: ['--inspect-brk=127.0.0.1:0', ...(ts ? ['--experimental-strip-types'] : []), file] };
}

// Rejects with a clear message when `p` hasn't settled in `ms`; the call it stands for is simply abandoned.
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`The debugger did not answer in time (${what})`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

const hinted = (message: string, hint?: string): HintedError => Object.assign(new Error(message), { hint });

// A project-relative path with forward slashes, or null for a file outside `root`.
function relOf(abs: unknown, root: string): string | null {
  if (typeof abs !== 'string' || !abs) return null;
  const rel = path.relative(root, abs); // case-insensitive on Windows
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

class DebugManager extends EventEmitter {
  session: Session | null = null;
  last: StartOptions | null = null;          // the last start() options, for restart()
  bps = new Map<string, Bp[]>();             // absolute path → Bp[]: kept between sessions
  exceptions = 'none';
  settled: Promise<unknown> = Promise.resolve(); // every session but the newest has finished (its 'stopped' is out)

  get pid() { return this.session?.child?.pid ?? null; }
  get state() { return this.session?.state ?? 'stopped'; }

  // Never rejects: what goes wrong arrives as an 'error' event, then 'state: stopped'. Resolves once the program is
  // running (or paused), or the attempt is over.
  async start(opts: StartOptions): Promise<void> {
    const prev = this.session;
    // Claimed at once, so a stop() right after start() finds this session even before the old one is gone.
    const s: Session = this.session = { opts, state: null, child: null, backend: null, live: false, dead: false, finished: false, exitCode: undefined, out: { stdout: '', stderr: '' }, timer: null };
    if (prev) prev.superseded = true;
    // Waits for every earlier session, not just the last one: two quick starts (a double-pressed Restart) must not
    // let the second spawn while the first one's predecessor is still being killed, or its events follow 'starting'.
    const stopping = this.stopSession(prev);
    s.after = this.settled = this.settled.then(() => stopping);
    await s.after;
    if (s.dead) return;
    const root = path.resolve(String(opts.root ?? ''));
    const file = path.resolve(root, String(opts.file ?? ''));
    this.last = { ...opts };
    if (opts.breakpoints) {
      this.bps = new Map(Object.entries(opts.breakpoints).map(([f, list]) => [path.resolve(root, f), list]));
    }
    if (opts.exceptions) this.exceptions = opts.exceptions;
    this.setState(s, 'starting');
    const kind = debugKind(file);
    if (!kind) { this.fail(s, hinted(UNSUPPORTED)); return; }
    if (kind === 'native' && !opts.build) { this.fail(s, hinted(opts.buildError || UNSUPPORTED, 'build-failed')); return; }
    const host = this.hostFor(s, root, file);
    s.backend = kind === 'python' ? new PythonBackend(host, { python: opts.python || 'python', env: opts.env })
      : kind === 'native' ? new GdbBackend(host, { gdb: opts.gdb || 'gdb', env: opts.env, build: opts.build! })
      : kind === 'java' ? new JavaBackend(host, { java: opts.java || 'java', javac: opts.javac || 'javac', env: opts.env })
      : kind === 'dotnet' ? new DotnetBackend(host, { dotnet: opts.dotnet || 'dotnet', netcoredbg: opts.netcoredbg, env: opts.env, hookSrc: opts.hookSrc!, hookDir: opts.hookDir!, project: opts.project ?? null })
      : new NodeBackend(host, { node: opts.node || 'node', env: opts.env, ts: isTs(file) });
    try {
      const launch = await within(s.backend.prepare(), CONNECT_MS, 'checking the debugger');
      if (s.dead) return;
      this.spawn(s, kind, root, file, launch);
      if (s.dead || s.finished) return;
      s.live = true; // from here breakpoint changes go to the backend (queued behind its own setup)
      await s.backend.connect();
      if (s.dead || s.finished) return;
      if (s.state === 'starting') this.setState(s, 'running');
    } catch (e) {
      if (s.dead || s.finished || s.exitCode !== undefined) return; // stopped, or the program ended: that says it all
      this.fail(s, e);
    }
  }

  spawn(s: Session, kind: string, root: string, file: string, launch: Launch): void {
    const backend = s.backend!;
    const { args } = launchArgs(kind, file, launch);
    const child = s.child = spawn(backend.cmd, args, { cwd: root, env: backend.env(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (t: string) => this.output(s, 'stdout', t));
    child.stderr.on('data', (t: string) => {
      const shown = backend.stderr(t); // Node's inspector banner is the backend's business, not the program's
      if (shown) this.output(s, 'stderr', shown);
    });
    child.stdin.on('error', () => { /* the program closed its stdin or ended */ });
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (s.exitCode !== undefined || s.finished) return;
      s.spawnFailed = true;
      const what = ({ python: "Python wasn't found", native: "The program wasn't found", java: "Java wasn't found", dotnet: "The .NET SDK wasn't found" } as Record<string, string>)[kind] ?? "Node.js wasn't found";
      this.emitFor(s, { type: 'error', message: e.code === 'ENOENT' ? `${what} (${backend.cmd})` : e.message, hint: e.code === 'ENOENT' && kind !== 'native' ? 'not-found' : undefined });
      this.finish(s, null);
    });
    child.on('exit', (code: number | null) => {
      s.exitCode = code;
      backend.exited?.();
      // 'close' waits for every holder of the pipes (debugpy's adapter is one); don't wait on it for long.
      setTimeout(() => this.finish(s, code), 500).unref?.();
    });
    child.on('close', (code: number | null) => this.finish(s, s.exitCode ?? code));
  }

  // What the backends see of the session.
  hostFor(s: Session, root: string, file: string): Host {
    return {
      root, file,
      stopOnEntry: !!s.opts.stopOnEntry,
      pid: () => s.child?.pid ?? null,
      bps: () => this.bps,
      exceptions: () => this.exceptions,
      emit: (ev: DebugEvent) => this.emitFor(s, ev),
      setState: (st: DebugState) => this.setState(s, st),
      output: (stream: 'stdout' | 'stderr' | 'console', text: string) => this.output(s, stream, text),
      alive: () => !s.dead && !s.finished && s.exitCode === undefined,
      warn: (e: unknown) => console.warn('[breeze] debug:', (e as Error | undefined)?.message ?? e),
      within,
      rel: (abs: unknown) => relOf(abs, root),
    };
  }

  // A listener that throws must not break the session's bookkeeping (or escape a stream handler in main).
  send(ev: DebugEvent): void {
    try { this.emit('event', ev); } catch (e) { console.warn('[breeze] debug event listener:', (e as Error | undefined)?.message ?? e); }
  }
  emitFor(s: Session, ev: DebugEvent): void {
    if (!s.finished) this.send(ev);
  }
  setState(s: Session, state: DebugState): void {
    if (s.finished || s.state === state) return;
    s.state = state;
    this.send({ type: 'state', state });
  }

  output(s: Session, stream: 'stdout' | 'stderr' | 'console', text: string): void {
    if (s.finished || !text) return;
    if (stream === 'console') { this.flush(s); this.emitFor(s, { type: 'output', stream, text }); return; }
    s.out[stream] += text;
    s.timer ??= setTimeout(() => { s.timer = null; this.flush(s); }, OUTPUT_MS);
  }
  flush(s: Session): void {
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    for (const stream of ['stdout', 'stderr'] as const) {
      const text = s.out[stream];
      s.out[stream] = '';
      if (text) this.emitFor(s, { type: 'output', stream, text });
    }
  }

  fail(s: Session, err: unknown): void {
    const e = err as HintedError | undefined;
    this.emitFor(s, { type: 'error', message: e?.message || String(err), ...(e?.hint ? { hint: e.hint } : {}), ...(e?.python ? { python: e.python } : {}) });
    this.stopSession(s);
  }

  // Once per session: the last output, 'exited' if a program ran, then 'stopped'.
  finish(s: Session, code: number | null): void {
    if (s.finished) return;
    this.flush(s);
    if (s.child && !s.spawnFailed) this.emitFor(s, { type: 'exited', code: code ?? null });
    if (!(s.superseded && s.state === null)) this.setState(s, 'stopped'); // a start replaced before it began says nothing
    s.finished = s.dead = true;
    try { s.backend?.close(); } catch (e) { console.warn('[breeze] debug:', (e as Error | undefined)?.message ?? e); }
    if (s.child && s.child.exitCode === null && s.child.signalCode === null) killTree(s.child); // e.g. the adapter outlived the program
    if (this.session === s) this.session = null;
  }

  // Asks the adapter to let go, then kills the process tree. Always ends in 'stopped', even with a wedged adapter.
  // A backend whose disconnect would let the program run on (Node resumes when its last inspector session goes)
  // has the tree killed first and the connection closed after.
  stopSession(s: Session | null): Promise<void> {
    if (!s || s.finished) return Promise.resolve();
    if (s.stopping) return s.stopping;
    s.dead = true; // no connection attempt outlives this
    s.stopping = (async () => {
      await s.after; // the sessions before this one are gone first, so their events come before this 'stopped'
      if (s.backend && s.live && !s.backend.killFirst) await within(s.backend.disconnect(), 1500, 'disconnect').catch(() => {});
      if (s.child && s.exitCode === undefined && !s.spawnFailed) {
        const child = s.child;
        const gone = new Promise(r => { child.once('exit', r); child.once('error', r); });
        killTree(s.child);
        let timer: NodeJS.Timeout;
        await Promise.race([gone, new Promise(r => { timer = setTimeout(r, STOP_MS); })]);
        clearTimeout(timer!);
      }
      try { s.backend?.close(); } catch { /* closing anyway */ }
      this.finish(s, s.exitCode ?? null);
    })();
    return s.stopping;
  }

  stop(): Promise<void> { return this.stopSession(this.session); }

  // For an app that is exiting and won't wait for stop(): kills the process tree right now, awaiting nothing, and
  // marks the session dead so any connection attempt still in flight gives up. The usual 'exited' / 'stopped' follow.
  killNow(): void {
    const s = this.session;
    if (!s || s.finished) return;
    s.dead = true;
    if (s.child && s.exitCode === undefined && !s.spawnFailed) killTree(s.child);
  }

  restart(): Promise<void> {
    if (!this.last) return Promise.resolve();
    return this.start({ ...this.last, breakpoints: Object.fromEntries(this.bps), exceptions: this.exceptions });
  }

  // The live session's backend, connected; otherwise the call rejects.
  ready(): Session & { backend: Backend } {
    const s = this.session;
    if (!s || s.finished || !s.backend || !s.live) throw new Error('The debugger is not running');
    return s as Session & { backend: Backend };
  }
  call<T>(what: string, fn: (b: Backend) => Promise<T>): Promise<T> {
    let s: Session & { backend: Backend };
    try { s = this.ready(); } catch (e) { return Promise.reject(e); }
    return within(Promise.resolve().then(() => fn(s.backend)), REQUEST_MS, what);
  }
  // Pause / continue / step only mean something in one state; otherwise they do nothing.
  whenState<T>(state: DebugState, what: string, fn: (b: Backend) => Promise<T>): Promise<T | void> {
    if (this.session?.state !== state) return Promise.resolve();
    return this.call(what, fn);
  }

  pause() { return this.whenState('running', 'pause', b => b.pause()); }
  continue() { return this.whenState('paused', 'continue', b => b.resume()); }
  step(kind: string) {
    if (!['over', 'into', 'out'].includes(kind)) return Promise.reject(new Error(`Unknown step: ${kind}`));
    return this.whenState('paused', 'step', b => b.step(kind));
  }
  runTo(file: string, line: number) {
    const s = this.session;
    if (!s) return Promise.resolve();
    return this.whenState('paused', 'run to line', b => b.runTo(path.resolve(path.resolve(s.opts.root), file), line));
  }
  setBreakpoints(file: string, bps: unknown) {
    const root = this.session ? path.resolve(this.session.opts.root) : this.last ? path.resolve(this.last.root) : null;
    const abs = root ? path.resolve(root, file) : path.resolve(file);
    const list: Bp[] = Array.isArray(bps) ? bps : [];
    if (list.length) this.bps.set(abs, list); else this.bps.delete(abs);
    if (!this.session?.live || this.session.finished) return Promise.resolve();
    return this.call('set breakpoints', b => b.setBreakpoints(abs, list));
  }
  setExceptions(mode: unknown) {
    this.exceptions = typeof mode === 'string' && ['uncaught', 'all'].includes(mode) ? mode : 'none';
    if (!this.session?.live || this.session.finished) return Promise.resolve();
    return this.call('exception breakpoints', b => b.setExceptions(this.exceptions));
  }
  scopes(frameId: number) { return this.call('scopes', b => b.scopes(frameId)); }
  children(ref: number) { return this.call('variables', b => b.children(ref)); }
  evaluate(expr: unknown, frameId: number | undefined, context?: string) { return this.call('evaluate', b => b.evaluate(String(expr), frameId, context || 'repl')); }
  setValue(ref: number, name: unknown, value: unknown) { return this.call('set value', b => b.setValue(ref, String(name), String(value))); }
  stdin(text: unknown): boolean {
    const child = this.session?.child;
    if (!child || this.session!.finished || !child.stdin!.writable) return false;
    child.stdin!.write(String(text));
    return true;
  }
}

export { DebugManager, debugKind, nodeSupportsTs, launchArgs, killTree, relOf };
