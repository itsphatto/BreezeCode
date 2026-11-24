// The DebugManager's Go backend: Delve's own Debug Adapter Protocol server (`dlv dap`). The manager starts
// `dlv dap --listen=127.0.0.1:<port>` and owns its stdio; Delve builds the program (no optimising, no inlining) and
// launches it itself, and the program inherits Delve's stdin/stdout/stderr, so its output reaches the Output through
// the manager's pipes like every other backend's. connect() dials the port and sends the launch request.
// Inside a Go module (`goMod`), the file's package is debugged (`program` is its folder), as `go run .` runs it.
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
import type { Socket } from 'node:net';
import { DapClient } from './dap';
import type { DapEvent, DapFrame, DapScope, DapVariable, DapBreakpoint, DapThread } from './dap';
import { checkBp } from './cdp';
import { pythonHit, freePort } from './debugPython';
import type { Backend, Bp, DebugFrame, DebugValue, Host, Launch } from './debugTypes';

const CONNECT_MS = 15000;
const BUILD_MS = 180000; // the launch request builds the program first, which takes a while on a cold cache
const DIAL_MS = 10000;
const DIAL_EVERY = 100;
const DLV_INSTALL = 'go install github.com/go-delve/delve/cmd/dlv@latest';
// What Delve prints on stdout once it listens; the program's own output follows on the same pipe.
const BANNER_RE = /^DAP server listening at:[^\n]*\n?/m;

// What `dlv dap` is started with, and what its launch request asks for.
const dlvArgs = (port: number) => ['dap', `--listen=127.0.0.1:${port}`];
function goLaunchArgs(file: string, goMod: string | null | undefined, output: string) {
  const pkg = !!goMod; // a module: the file's package, which is the file's folder
  return { request: 'launch', mode: 'debug', program: pkg ? path.dirname(file) : file, cwd: path.dirname(file), output, stopOnEntry: false };
}

interface GoBreakpoint { id?: number; line: number; verified: boolean }
interface StoppedBody { threadId?: number; reason?: string; description?: string; text?: string; hitBreakpointIds?: number[] }

class GoBackend implements Backend {
  host: Host;
  cmd: string;
  goTool: string | null;
  goMod: string | null;
  baseEnv: NodeJS.ProcessEnv;
  port = 0;
  output = path.join(os.tmpdir(), `breeze-debug-${process.pid}-${Date.now()}${process.platform === 'win32' ? '.exe' : ''}`);
  client: DapClient | null = null;
  socket: Socket | null = null;
  threadId: number | null = null;
  byFile = new Map<string, GoBreakpoint[]>();
  queue: Promise<unknown> = Promise.resolve();
  tempFiles = new Set<string>();
  entry: number | boolean = false; // the function breakpoint on main.main that stops on entry, until it is hit
  banner = false;                  // Delve's "listening" line has gone by (it is not the program's output)
  code: number | null | undefined; // the program's exit code, from Delve's 'exited' event (Delve's own is 0)
  ended = false;

  constructor(host: Host, { dlv, go, env, goMod }: { dlv: string; go?: string | null; env?: NodeJS.ProcessEnv; goMod?: string | null }) {
    this.host = host;
    this.cmd = dlv;
    this.goTool = go ?? null;
    this.goMod = goMod ?? null;
    this.baseEnv = env || process.env;
  }

  env(): NodeJS.ProcessEnv { return { ...this.baseEnv }; }

  async prepare(): Promise<Launch> {
    if (!this.goTool) throw Object.assign(new Error("Go wasn't found. Install it from https://go.dev/dl/"), { hint: 'install-go' });
    await new Promise<void>((resolve, reject) => execFile(this.cmd, ['version'], { windowsHide: true, timeout: CONNECT_MS, env: this.env() }, (e: ExecFileException | null) => {
      if (!e) resolve();
      else reject(Object.assign(new Error(`Debugging Go needs Delve. Install it with: ${DLV_INSTALL}`), { hint: 'install-dlv' }));
    }));
    this.port = await freePort();
    return { args: dlvArgs(this.port) };
  }

  stdout(text: string): string {
    if (this.banner) return text;
    return text.replace(BANNER_RE, () => { this.banner = true; return ''; });
  }
  stderr(text: string) { return text; }
  exited() { this.ended = true; }
  exitCode(): number | null | undefined { return this.code; }

  async dial(): Promise<Socket> {
    const end = Date.now() + DIAL_MS;
    for (;;) {
      if (!this.host.alive() || this.ended) throw new Error('The debug session ended');
      const sock = await new Promise<Socket | null>(resolve => {
        const s = net.connect({ host: '127.0.0.1', port: this.port });
        s.once('connect', () => { s.removeAllListeners('error'); resolve(s); });
        s.once('error', () => { s.destroy(); resolve(null); });
      });
      if (sock) return sock;
      if (Date.now() > end) throw new Error(`Could not reach Delve on port ${this.port}`);
      await new Promise(r => setTimeout(r, DIAL_EVERY));
    }
  }

  async connect(): Promise<void> {
    const { host } = this;
    const sock = this.socket = await this.dial();
    if (!host.alive()) { sock.destroy(); return; }
    const c = this.client = new DapClient(sock);
    c.on('warn', (e: unknown) => host.warn(e));
    let initialized!: () => void;
    const ready = new Promise<void>(r => { initialized = r; });
    c.on('event', (e: DapEvent) => {
      if (e.event === 'initialized') initialized();
      else this.onEvent(e);
    });
    const req = (cmd: string, args?: unknown, ms = CONNECT_MS) => host.within(c.request(cmd, args), ms, cmd);
    await req('initialize', {
      clientID: 'breeze', clientName: 'Breeze Code', adapterID: 'go', locale: 'en',
      pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true, supportsVariableType: true, supportsRunInTerminalRequest: false,
    });
    const launch = goLaunchArgs(host.file, this.goMod, this.output);
    host.output('console', `> dlv dap: building ${this.goMod ? `the package in ${path.basename(launch.program)}` : `"${path.basename(host.file)}"`}\n`);
    try {
      await req('launch', launch, BUILD_MS);
    } catch (e) {
      // Delve's message holds the compiler's errors ("Build error: …").
      const msg = (e as Error).message || '';
      if (/build/i.test(msg)) {
        host.output('stderr', msg.endsWith('\n') ? msg : msg + '\n');
        throw Object.assign(new Error('The build failed: the Output shows why'), { hint: 'build-failed' });
      }
      throw e;
    }
    await host.within(ready, CONNECT_MS, 'initialized');
    for (const [file, bps] of host.bps()) await this.setBreakpoints(file, bps);
    if (host.stopOnEntry) {
      const { breakpoints = [] }: { breakpoints?: DapBreakpoint[] } = await req('setFunctionBreakpoints', { breakpoints: [{ name: 'main.main' }] });
      this.entry = breakpoints[0]?.id ?? true;
    }
    await req('configurationDone');
  }

  request<T = any>(cmd: string, args?: unknown): Promise<T> {
    if (!this.client) return Promise.reject(new Error('The debugger is not connected'));
    return this.client.request(cmd, args);
  }

  onEvent({ event, body = {} }: DapEvent): void {
    const { host } = this;
    switch (event) {
      case 'stopped': this.stopped(body).catch((e: unknown) => host.warn(e)); break;
      case 'continued': host.setState('running'); break;
      case 'output':
        // The program's own output comes through Delve's pipes; these are Delve's messages and logpoints.
        if (!body.output || body.category === 'telemetry') break;
        host.output(body.category === 'stderr' ? 'stderr' : 'console', body.output);
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
      case 'exited': if (typeof body.exitCode === 'number') this.code = body.exitCode; break;
      // The program is gone, but `dlv dap` waits for the client to let go: disconnect, and Delve exits.
      case 'terminated': this.disconnect().catch((e: unknown) => host.warn(e)); break;
    }
  }

  async stopped(body: StoppedBody): Promise<void> {
    const { host } = this;
    if (body.threadId !== undefined) this.threadId = body.threadId;
    for (const f of this.tempFiles) this.setBreakpoints(f, host.bps().get(f) ?? []).catch((e: unknown) => host.warn(e));
    this.tempFiles.clear();
    const { stackFrames = [] } = await host.within(this.request<{ stackFrames?: DapFrame[] }>('stackTrace', { threadId: this.threadId, startFrame: 0, levels: 100 }), CONNECT_MS, 'stackTrace');
    const frames: DebugFrame[] = stackFrames.map((f: DapFrame) => ({ id: f.id, name: f.name, file: host.rel(f.source?.path), line: f.line, col: f.column }));
    let reason = body.reason === 'function breakpoint' ? 'breakpoint' : body.reason || 'pause';
    // The stop on entry is a function breakpoint on main.main, gone once hit (or once anything else stops first).
    if (this.entry) {
      if (body.reason === 'function breakpoint') reason = 'entry';
      this.entry = false;
      this.request('setFunctionBreakpoints', { breakpoints: [] }).catch((e: unknown) => host.warn(e));
    }
    const ev: { type: string; reason: string; frames: DebugFrame[]; exception?: string } = { type: 'paused', reason, frames };
    // A panic (or a fatal runtime error) stops as an exception; Delve's exceptionInfo says which.
    if (reason === 'exception' || reason === 'panic') {
      ev.reason = 'exception';
      const info = await host.within(this.request<{ exceptionId?: string; description?: string }>('exceptionInfo', { threadId: this.threadId }), CONNECT_MS, 'exceptionInfo').catch(() => null);
      ev.exception = info ? [info.exceptionId, info.description].filter(Boolean).join(': ') : (body.description || body.text || 'panic');
    }
    host.setState('paused');
    host.emit(ev);
  }

  // ---- breakpoints ----

  setBreakpoints(file: string, bps: Bp[], extraLines?: number[]): Promise<void> {
    const run = this.queue.then(() => this.applyBreakpoints(file, bps, extraLines));
    this.queue = run.catch(() => {});
    return run;
  }
  // Delve sets breakpoints while the program runs too (it halts and resumes it itself).
  async applyBreakpoints(file: string, bps: Bp[], extraLines: number[] = []): Promise<void> {
    if (!this.client) return;
    const sent: { line: number; condition?: string; hitCondition?: string | null; logMessage?: string; temp?: boolean }[] = [];
    for (const bp of bps) {
      if (!bp || bp.enabled === false || !(bp.line >= 1)) continue;
      if (bp.hitCondition && checkBp({ hitCondition: bp.hitCondition })) continue; // unverified: the page says why
      const b: (typeof sent)[number] = { line: bp.line };
      if (bp.condition && bp.condition.trim()) b.condition = bp.condition;
      // Delve reads a bare count as "only that hit"; Breeze means "from that hit on", as debugpy's backend does.
      if (bp.hitCondition && bp.hitCondition.trim()) b.hitCondition = pythonHit(bp.hitCondition);
      if (bp.logMessage) b.logMessage = bp.logMessage;
      sent.push(b);
    }
    const own = new Set(sent.map(b => b.line));
    for (const line of extraLines) if (!own.has(line)) sent.push({ line, temp: true });
    const { breakpoints = [] } = await this.request<{ breakpoints?: DapBreakpoint[] }>('setBreakpoints', { source: { path: file }, breakpoints: sent.map(({ temp, ...b }) => b) });
    this.byFile.set(file, sent.filter(b => !b.temp).map((b, i) => ({ id: breakpoints[i]?.id, line: breakpoints[i]?.line ?? b.line, verified: !!breakpoints[i]?.verified })));
    this.reportBreakpoints(file);
  }
  reportBreakpoints(file: string): void {
    const rel = this.host.rel(file);
    if (rel === null) return;
    const lines = [...new Set((this.byFile.get(file) ?? []).filter(b => b.verified).map(b => b.line))].sort((a, b) => a - b);
    this.host.emit({ type: 'breakpoints', file: rel, lines });
  }
  // Delve has no exception filters: an unrecovered panic always stops the program (as an exception), whatever the mode.
  setExceptions(): Promise<unknown> { return Promise.resolve(); }

  // ---- running ----

  async thread(): Promise<number> {
    if (this.threadId !== null) return this.threadId;
    const { threads = [] } = await this.request<{ threads?: DapThread[] }>('threads');
    if (!threads.length) throw new Error('The program has no goroutines to pause');
    return (this.threadId = threads[0].id);
  }
  async go(cmd: string): Promise<void> {
    await this.request(cmd, { threadId: await this.thread() });
    this.host.setState('running'); // DAP sends no 'continued' for a request the client made
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
  // Delve takes 'watch', 'repl' and 'hover' alike for expressions ('repl' also runs `dlv <command>` and `call f()`).
  async evaluate(expr: string, frameId: number | undefined, context: string): Promise<DebugValue> {
    const r = await this.request('evaluate', { expression: expr, ...(typeof frameId === 'number' ? { frameId } : {}), context });
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
    if (this.client) this.client.close(); else this.socket?.destroy();
    // Delve removes the program it built; this is in case it was killed first.
    setTimeout(() => { try { fs.rmSync(this.output, { force: true }); } catch { /* still in use, or gone */ } }, 1000).unref?.();
  }
}

export { GoBackend, dlvArgs, goLaunchArgs, DLV_INSTALL };
