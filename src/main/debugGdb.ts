// The DebugManager's C, C++ and Rust backend: GDB's own Debug Adapter Protocol (`gdb -i=dap`, GDB 14 or newer).
// prepare() builds the program with debug info and runtime/breeze_debug.h, which makes it wait before main until a
// debugger is attached. The manager then starts the program and owns its stdio, as for Python and Node; connect()
// starts GDB, attaches it to that process and lets the program go.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import type { ChildProcess, ExecFileException } from 'node:child_process';
import { Duplex } from 'node:stream';
import { DapClient } from './dap';
import type { DapEvent, DapFrame, DapScope, DapVariable, DapBreakpoint, DapThread } from './dap';
import { checkBp } from './cdp';
import type { Step } from './toolchains';
import type { Backend, Bp, DebugFrame, DebugValue, Host, Launch } from './debugTypes';

// What toolchains.debugPlan() returned for this file: the steps that build it, the program, its entry function.
export interface GdbBuild { steps: Step[]; exe: string | null; entry: string | null; cpp: boolean }
interface GdbBreakpoint { id?: number; line: number; verified: boolean }
interface StoppedBody { threadId?: number; reason?: string; description?: string; text?: string; hitBreakpointIds?: number[] }

const CONNECT_MS = 15000;
const BUILD_MS = 120000;

// GDB's file commands take a Windows path with forward slashes (it reads backslashes as escapes).
const gdbPath = (p: unknown) => String(p).replace(/\\/g, '/');
// GDB counts a hit condition as "stop from this hit on", the same as Breeze's bare number.
const gdbHit = (text: unknown): string | null => (/^\s*(\d+)\s*$/.exec((text as string) || '') || [])[1] ?? null;

class GdbBackend implements Backend {
  host: Host;
  gdb: string;
  baseEnv: NodeJS.ProcessEnv;
  build: GdbBuild;
  cmd: string;                       // what the manager starts, once built
  client: DapClient | null = null;
  proc: ChildProcess | null = null;
  threadId: number | null = null;
  byFile = new Map<string, GdbBreakpoint[]>();
  queue: Promise<unknown> = Promise.resolve();
  tempFiles = new Set<string>();
  attached = false;                  // GDB's own stop on attaching has come (and is not shown)
  entry: number | boolean = false;   // the id of the function breakpoint that stops on entry, until it is hit
  running = false;                   // GDB takes breakpoint changes only while the program is stopped (see whileStopped)
  quiet: (() => void) | null = null; // resolves the stop whileStopped asked for, which the page never sees
  ended = false;
  goFile = path.join(os.tmpdir(), `breeze-debug-${process.pid}-${Date.now()}.go`); // see breeze_debug.h

  constructor(host: Host, { gdb, env, build }: { gdb: string; env?: NodeJS.ProcessEnv; build: GdbBuild }) {
    this.host = host;
    this.gdb = gdb;
    this.baseEnv = env || process.env;
    this.build = build;
    this.cmd = build.exe ?? '';
  }

  env(): NodeJS.ProcessEnv { return { ...this.baseEnv, BREEZE_DEBUG_GO: this.goFile }; }

  async prepare(): Promise<Launch> {
    await new Promise<void>((resolve, reject) => execFile(this.gdb, ['--version'], { windowsHide: true, timeout: CONNECT_MS }, (e: ExecFileException | null, out: string) => {
      if (e) { reject(Object.assign(new Error('Debugging C, C++ and Rust needs GDB, which comes with MinGW-w64 GCC (MSYS2 or WinLibs)'), { hint: 'install-gdb' })); return; }
      const major = Number(/GNU gdb[^\d]*(\d+)/.exec(String(out))?.[1] || 0);
      if (major && major < 14) reject(Object.assign(new Error(`Debugging needs GDB 14 or newer (this is GDB ${major})`), { hint: 'install-gdb' }));
      else resolve();
    }));
    for (const step of this.build.steps) {
      if (!this.host.alive()) return {};
      this.host.output('console', `> ${step.display}\n`);
      if (step.mkdir) fs.mkdirSync(step.mkdir, { recursive: true }); // gcc and rustc won't create it
      await new Promise<void>((resolve, reject) => execFile(step.file, step.args, {
        cwd: step.cwd, env: step.env ? { ...this.env(), ...step.env } : this.env(), windowsHide: true, timeout: BUILD_MS, maxBuffer: 16 * 1024 * 1024,
      }, (e: ExecFileException | null, out: string, err: string) => {
        // Cargo reports what it built as JSON lines on stdout (--message-format): the program is the last executable.
        if (step.cargo) {
          for (const line of String(out).split('\n')) {
            let m: { reason?: string; executable?: string; target?: { name?: string } };
            try { m = JSON.parse(line); } catch { continue; } // not JSON
            if (m.reason !== 'compiler-artifact' || !m.executable) continue;
            this.cmd = m.executable;
            this.build.entry = `${String(m.target?.name ?? '').replace(/-/g, '_')}::main`;
          }
          out = '';
        }
        const text = [out, err].filter(Boolean).join('');
        if (text) this.host.output('stderr', text);
        if (e) reject(Object.assign(new Error(e.code === 'ENOENT' ? `${step.file} wasn't found` : 'The build failed: the Output shows why'), { hint: 'build-failed' }));
        else resolve();
      }));
    }
    if (!this.cmd) throw new Error('Cargo built no program to debug');
    return {};
  }

  stderr(text: string) { return text; }
  exited() { this.ended = true; }

  async connect(): Promise<void> {
    const { host } = this;
    const pid = host.pid();
    if (!pid) throw new Error("The program didn't start");
    const proc = this.proc = spawn(this.gdb, ['-q', '-iex', 'set pagination off', '-i=dap'], { cwd: host.root, env: this.env(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    proc.on('error', () => { /* the client closes with its streams */ });
    const c = this.client = new DapClient(Duplex.from({ readable: proc.stdout!, writable: proc.stdin! }));
    c.on('warn', (e: unknown) => host.warn(e));
    let onAttach!: (threadId?: number) => void;
    const attachStop = new Promise<number | undefined>(r => { onAttach = r; });
    c.on('event', (e: DapEvent) => {
      if (e.event === 'stopped' && !this.attached) { this.attached = true; onAttach(e.body?.threadId); return; }
      this.onEvent(e);
    });
    const req = (cmd: string, args?: unknown) => host.within(c.request(cmd, args), CONNECT_MS, cmd);
    await req('initialize', {
      clientID: 'breeze', clientName: 'Breeze Code', adapterID: 'gdb', locale: 'en',
      pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true, supportsVariableType: true, supportsRunInTerminalRequest: false,
    });
    await req('attach', { pid, program: gdbPath(this.cmd) });
    const thread = await host.within(attachStop, CONNECT_MS, 'attach');
    for (const [file, bps] of host.bps()) await this.setBreakpoints(file, bps);
    if (host.stopOnEntry && this.build.entry) {
      const { breakpoints = [] }: { breakpoints?: DapBreakpoint[] } = await req('setFunctionBreakpoints', { breakpoints: [{ name: this.build.entry }] });
      this.entry = breakpoints[0]?.id ?? true;
    }
    await this.setExceptions(host.exceptions());
    await req('configurationDone');
    fs.writeFileSync(this.goFile, ''); // the program may go on past its wait now
    await req('continue', { threadId: thread });
    // GDB answers 'threads' only while stopped, and Pause interrupts the whole program whichever thread it names.
    this.threadId = thread ?? null;
    this.running = true;
    host.setState('running');
  }

  request<T = any>(cmd: string, args?: unknown): Promise<T> {
    if (!this.client) return Promise.reject(new Error('The debugger is not connected'));
    return this.client.request(cmd, args);
  }

  onEvent({ event, body = {} }: DapEvent): void {
    const { host } = this;
    switch (event) {
      case 'stopped':
        this.running = false;
        if (this.quiet) { this.quiet(); break; }
        this.stopped(body).catch((e: unknown) => host.warn(e));
        break;
      case 'continued': host.setState('running'); break;
      case 'output':
        // GDB's own chatter ("Breakpoint 1 at …") is category stdout; the program's output comes through its pipes.
        if (body.category === 'console' && body.output) host.output('console', body.output);
        break;
      case 'breakpoint': {
        const b = body.breakpoint;
        if (!b) break;
        for (const [file, list] of this.byFile) {
          const entry = list.find(x => x.id !== undefined && x.id === b.id);
          if (entry && entry.verified !== !!b.verified) { entry.verified = !!b.verified; this.reportBreakpoints(file); }
        }
        break;
      }
    }
  }

  async stopped(body: StoppedBody): Promise<void> {
    const { host } = this;
    if (body.threadId !== undefined) this.threadId = body.threadId;
    for (const f of this.tempFiles) this.setBreakpoints(f, host.bps().get(f) ?? []).catch((e: unknown) => host.warn(e));
    this.tempFiles.clear();
    let frames = await this.framesOf(this.threadId!);
    // Pause stops in a thread Windows starts for it, with no code of the program on it: show a thread that has some.
    if (!frames.some(f => f.file)) {
      const { threads = [] } = await this.request<{ threads?: DapThread[] }>('threads').catch(() => ({} as { threads?: DapThread[] }));
      for (const t of threads) {
        if (t.id === this.threadId) continue;
        const fr = await this.framesOf(t.id).catch(() => [] as DebugFrame[]);
        if (fr.some(f => f.file)) { this.threadId = t.id; frames = fr; break; }
      }
    }
    let reason = body.reason === 'function breakpoint' ? 'breakpoint' : !body.reason || body.reason === 'stopped' ? 'pause' : body.reason;
    // The stop on entry is a function breakpoint on main, gone once hit (or once anything else stops first).
    if (this.entry) {
      if (reason === 'breakpoint' && (body.hitBreakpointIds ?? []).includes(this.entry as number)) reason = 'entry';
      this.entry = false;
      this.request('setFunctionBreakpoints', { breakpoints: [] }).catch((e: unknown) => host.warn(e));
    }
    const ev: { type: string; reason: string; frames: DebugFrame[]; exception?: string } = { type: 'paused', reason, frames };
    if (reason === 'signal' || reason === 'exception') {
      ev.reason = 'exception';
      ev.exception = body.description || body.text || 'The program crashed';
    }
    host.setState('paused');
    host.emit(ev);
  }
  async framesOf(threadId: number): Promise<DebugFrame[]> {
    const { stackFrames = [] } = await this.host.within(this.request<{ stackFrames?: DapFrame[] }>('stackTrace', { threadId, startFrame: 0, levels: 100 }), CONNECT_MS, 'stackTrace');
    return stackFrames.map((f: DapFrame) => ({ id: f.id, name: f.name, file: this.host.rel(f.source?.path), line: f.line, col: f.column }));
  }

  // ---- breakpoints ----

  setBreakpoints(file: string, bps: Bp[], extraLines?: number[]): Promise<void> {
    const run = this.queue.then(() => this.applyBreakpoints(file, bps, extraLines));
    this.queue = run.catch(() => {});
    return run;
  }
  async applyBreakpoints(file: string, bps: Bp[], extraLines: number[] = []): Promise<void> {
    if (!this.client) return;
    const sent: { line: number; condition?: string; hitCondition?: string | null; logMessage?: string; temp?: boolean }[] = [];
    for (const bp of bps) {
      if (!bp || bp.enabled === false || !(bp.line >= 1)) continue;
      if (bp.hitCondition && (checkBp({ hitCondition: bp.hitCondition }) || gdbHit(bp.hitCondition) === null)) continue;
      const b: (typeof sent)[number] = { line: bp.line };
      if (bp.condition && bp.condition.trim()) b.condition = bp.condition;
      if (bp.hitCondition && bp.hitCondition.trim()) b.hitCondition = gdbHit(bp.hitCondition);
      if (bp.logMessage) b.logMessage = bp.logMessage;
      sent.push(b);
    }
    const own = new Set(sent.map(b => b.line));
    for (const line of extraLines) if (!own.has(line)) sent.push({ line, temp: true });
    const { breakpoints = [] } = await this.whileStopped(() => this.request<{ breakpoints?: DapBreakpoint[] }>('setBreakpoints', { source: { path: file }, breakpoints: sent.map(({ temp, ...b }) => b) }));
    this.byFile.set(file, sent.filter(b => !b.temp).map((b, i) => ({ id: breakpoints[i]?.id, line: breakpoints[i]?.line ?? b.line, verified: !!breakpoints[i]?.verified })));
    this.reportBreakpoints(file);
  }
  reportBreakpoints(file: string): void {
    const rel = this.host.rel(file);
    if (rel === null) return;
    const lines = [...new Set((this.byFile.get(file) ?? []).filter(b => b.verified).map(b => b.line))].sort((a, b) => a - b);
    this.host.emit({ type: 'breakpoints', file: rel, lines });
  }

  // C++ exceptions: every throw, or none (an uncaught one ends in a crash, which pauses anyway).
  setExceptions(mode: string): Promise<unknown> {
    if (!this.client) return Promise.resolve();
    return this.whileStopped(() => this.request('setExceptionBreakpoints', { filters: mode === 'all' && this.build.cpp ? ['throw'] : [] }));
  }
  // Runs `fn` with the program stopped: a running one is interrupted first and let go again after, unseen.
  async whileStopped<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.running) return fn();
    const stopped = new Promise<void>(r => { this.quiet = r; });
    try {
      await this.request('pause', { threadId: this.threadId });
      await this.host.within(stopped, CONNECT_MS, 'pause');
      return await fn();
    } finally {
      this.quiet = null;
      if (!this.running && !this.ended) {
        await this.request('continue', { threadId: this.threadId }).catch((e: unknown) => this.host.warn(e));
        this.running = true;
      }
    }
  }

  // ---- running ----

  async thread(): Promise<number> {
    if (this.threadId !== null) return this.threadId;
    const { threads = [] } = await this.request<{ threads?: DapThread[] }>('threads');
    if (!threads.length) throw new Error('The program has no threads to pause');
    return (this.threadId = threads[0].id);
  }
  async go(cmd: string): Promise<void> {
    await this.request(cmd, { threadId: await this.thread() });
    this.running = true;
    this.host.setState('running');
  }
  async pause(): Promise<void> { await this.request('pause', { threadId: await this.thread() }); }
  resume(): Promise<void> { return this.go('continue'); }
  step(kind: string): Promise<void> { return this.go(kind === 'into' ? 'stepIn' : kind === 'out' ? 'stepOut' : 'next'); }
  async runTo(file: string, line: number): Promise<void> {
    this.tempFiles.add(file);
    await this.setBreakpoints(file, this.host.bps().get(file) ?? [], [line]);
    await this.go('continue');
  }

  // ---- values ----

  async scopes(frameId: number): Promise<DebugValue[]> {
    const { scopes = [] } = await this.request<{ scopes?: DapScope[] }>('scopes', { frameId });
    return scopes.filter((s: DapScope) => s.name !== 'Registers').map((s: DapScope) => ({ name: s.name, value: '', type: 'scope', ref: s.variablesReference || 0 }));
  }
  async children(ref: number): Promise<DebugValue[]> {
    const { variables = [] } = await this.request<{ variables?: DapVariable[] }>('variables', { variablesReference: ref });
    return variables.map((v: DapVariable) => ({ name: v.name, value: v.value, type: v.type ?? '', ref: v.variablesReference || 0 }));
  }
  // GDB runs 'repl' text as a GDB command; the console and watch list take expressions, so it's always 'watch'.
  async evaluate(expr: string, frameId?: number): Promise<DebugValue> {
    const r = await this.request('evaluate', { expression: expr, ...(typeof frameId === 'number' ? { frameId } : {}), context: 'watch' });
    return { name: expr, value: r.result, type: r.type ?? '', ref: r.variablesReference || 0 };
  }
  async setValue(ref: number, name: string, value: string): Promise<DebugValue> {
    const r = await this.request('setVariable', { variablesReference: ref, name, value });
    return { name, value: r.value, type: r.type ?? '', ref: r.variablesReference || 0 };
  }

  // ---- ending ----

  async disconnect(): Promise<void> {
    if (this.client && !this.client.closed) await this.request('disconnect', { terminateDebuggee: true }).catch(() => {});
  }
  close(): void {
    this.ended = true;
    try { fs.rmSync(this.goFile, { force: true }); } catch { /* gone */ }
    this.client?.close();
    if (this.proc && this.proc.exitCode === null) this.proc.kill();
  }
}

export { GdbBackend, gdbPath, gdbHit };
