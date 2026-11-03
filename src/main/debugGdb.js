// The DebugManager's C, C++ and Rust backend: GDB's own Debug Adapter Protocol (`gdb -i=dap`, GDB 14 or newer).
// prepare() builds the program with debug info and runtime/breeze_debug.h, which makes it wait before main until a
// debugger is attached. The manager then starts the program and owns its stdio, as for Python and Node; connect()
// starts GDB, attaches it to that process and lets the program go.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { Duplex } = require('node:stream');
const { DapClient } = require('./dap');
const { checkBp } = require('./cdp');

const CONNECT_MS = 15000;
const BUILD_MS = 120000;

// GDB's file commands take a Windows path with forward slashes (it reads backslashes as escapes).
const gdbPath = p => String(p).replace(/\\/g, '/');
// GDB counts a hit condition as "stop from this hit on", the same as Breeze's bare number.
const gdbHit = text => (/^\s*(\d+)\s*$/.exec(text || '') || [])[1] ?? null;

class GdbBackend {
  // `build`: { steps: [{ display, file, args, cwd, env? }], exe, entry } from toolchains.debugPlan().
  constructor(host, { gdb, env, build }) {
    this.host = host;
    this.gdb = gdb;
    this.baseEnv = env || process.env;
    this.build = build;
    this.cmd = build.exe; // what the manager starts, once built
    this.client = null;
    this.proc = null;
    this.threadId = null;
    this.byFile = new Map();  // abs → [{ id, line, verified }]
    this.queue = Promise.resolve();
    this.tempFiles = new Set();
    this.attached = false;    // GDB's own stop on attaching has come (and is not shown)
    this.entry = false;       // the id of the function breakpoint that stops on entry, until it is hit
    this.running = false;     // GDB takes breakpoint changes only while the program is stopped (see whileStopped)
    this.quiet = null;        // resolves the stop whileStopped asked for, which the page never sees
    this.ended = false;
    this.goFile = path.join(os.tmpdir(), `breeze-debug-${process.pid}-${Date.now()}.go`); // see breeze_debug.h
  }

  env() { return { ...this.baseEnv, BREEZE_DEBUG_GO: this.goFile }; }

  async prepare() {
    await new Promise((resolve, reject) => execFile(this.gdb, ['--version'], { windowsHide: true, timeout: CONNECT_MS }, (e, out) => {
      if (e) { reject(Object.assign(new Error('Debugging C, C++ and Rust needs GDB, which comes with MinGW-w64 GCC (MSYS2 or WinLibs)'), { hint: 'install-gdb' })); return; }
      const major = Number(/GNU gdb[^\d]*(\d+)/.exec(String(out))?.[1] || 0);
      if (major && major < 14) reject(Object.assign(new Error(`Debugging needs GDB 14 or newer (this is GDB ${major})`), { hint: 'install-gdb' }));
      else resolve();
    }));
    for (const step of this.build.steps) {
      if (!this.host.alive()) return {};
      this.host.output('console', `> ${step.display}\n`);
      if (step.mkdir) fs.mkdirSync(step.mkdir, { recursive: true }); // gcc and rustc won't create it
      await new Promise((resolve, reject) => execFile(step.file, step.args, {
        cwd: step.cwd, env: step.env ? { ...this.env(), ...step.env } : this.env(), windowsHide: true, timeout: BUILD_MS, maxBuffer: 16 * 1024 * 1024,
      }, (e, out, err) => {
        // Cargo reports what it built as JSON lines on stdout (--message-format): the program is the last executable.
        if (step.cargo) {
          for (const line of String(out).split('\n')) {
            let m;
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

  stderr(text) { return text; }
  exited() { this.ended = true; }

  async connect() {
    const { host } = this;
    const pid = host.pid();
    if (!pid) throw new Error("The program didn't start");
    const proc = this.proc = spawn(this.gdb, ['-q', '-iex', 'set pagination off', '-i=dap'], { cwd: host.root, env: this.env(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    proc.on('error', () => { /* the client closes with its streams */ });
    const c = this.client = new DapClient(Duplex.from({ readable: proc.stdout, writable: proc.stdin }));
    c.on('warn', e => host.warn(e));
    let onAttach;
    const attachStop = new Promise(r => { onAttach = r; });
    c.on('event', e => {
      if (e.event === 'stopped' && !this.attached) { this.attached = true; onAttach(e.body?.threadId); return; }
      this.onEvent(e);
    });
    const req = (cmd, args) => host.within(c.request(cmd, args), CONNECT_MS, cmd);
    await req('initialize', {
      clientID: 'breeze', clientName: 'Breeze Code', adapterID: 'gdb', locale: 'en',
      pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true, supportsVariableType: true, supportsRunInTerminalRequest: false,
    });
    await req('attach', { pid, program: gdbPath(this.cmd) });
    const thread = await host.within(attachStop, CONNECT_MS, 'attach');
    for (const [file, bps] of host.bps()) await this.setBreakpoints(file, bps);
    if (host.stopOnEntry && this.build.entry) {
      const { breakpoints = [] } = await req('setFunctionBreakpoints', { breakpoints: [{ name: this.build.entry }] });
      this.entry = breakpoints[0]?.id ?? true;
    }
    await this.setExceptions(host.exceptions());
    await req('configurationDone');
    fs.writeFileSync(this.goFile, ''); // the program may go on past its wait now
    await req('continue', { threadId: thread });
    // GDB answers 'threads' only while stopped, and Pause interrupts the whole program whichever thread it names.
    this.threadId = thread;
    this.running = true;
    host.setState('running');
  }

  request(cmd, args) {
    if (!this.client) return Promise.reject(new Error('The debugger is not connected'));
    return this.client.request(cmd, args);
  }

  onEvent({ event, body = {} }) {
    const { host } = this;
    switch (event) {
      case 'stopped':
        this.running = false;
        if (this.quiet) { this.quiet(); break; }
        this.stopped(body).catch(e => host.warn(e));
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

  async stopped(body) {
    const { host } = this;
    if (body.threadId !== undefined) this.threadId = body.threadId;
    for (const f of this.tempFiles) this.setBreakpoints(f, host.bps().get(f) ?? []).catch(e => host.warn(e));
    this.tempFiles.clear();
    let frames = await this.framesOf(this.threadId);
    // Pause stops in a thread Windows starts for it, with no code of the program on it: show a thread that has some.
    if (!frames.some(f => f.file)) {
      const { threads = [] } = await this.request('threads').catch(() => ({}));
      for (const t of threads) {
        if (t.id === this.threadId) continue;
        const fr = await this.framesOf(t.id).catch(() => []);
        if (fr.some(f => f.file)) { this.threadId = t.id; frames = fr; break; }
      }
    }
    let reason = body.reason === 'function breakpoint' ? 'breakpoint' : !body.reason || body.reason === 'stopped' ? 'pause' : body.reason;
    // The stop on entry is a function breakpoint on main, gone once hit (or once anything else stops first).
    if (this.entry) {
      if (reason === 'breakpoint' && (body.hitBreakpointIds ?? []).includes(this.entry)) reason = 'entry';
      this.entry = false;
      this.request('setFunctionBreakpoints', { breakpoints: [] }).catch(e => host.warn(e));
    }
    const ev = { type: 'paused', reason, frames };
    if (reason === 'signal' || reason === 'exception') {
      ev.reason = 'exception';
      ev.exception = body.description || body.text || 'The program crashed';
    }
    host.setState('paused');
    host.emit(ev);
  }
  async framesOf(threadId) {
    const { stackFrames = [] } = await this.host.within(this.request('stackTrace', { threadId, startFrame: 0, levels: 100 }), CONNECT_MS, 'stackTrace');
    return stackFrames.map(f => ({ id: f.id, name: f.name, file: this.host.rel(f.source?.path), line: f.line, col: f.column }));
  }

  // ---- breakpoints ----

  setBreakpoints(file, bps, extraLines) {
    const run = this.queue.then(() => this.applyBreakpoints(file, bps, extraLines));
    this.queue = run.catch(() => {});
    return run;
  }
  async applyBreakpoints(file, bps, extraLines = []) {
    if (!this.client) return;
    const sent = [];
    for (const bp of bps) {
      if (!bp || bp.enabled === false || !(bp.line >= 1)) continue;
      if (bp.hitCondition && (checkBp({ hitCondition: bp.hitCondition }) || gdbHit(bp.hitCondition) === null)) continue;
      const b = { line: bp.line };
      if (bp.condition && bp.condition.trim()) b.condition = bp.condition;
      if (bp.hitCondition && bp.hitCondition.trim()) b.hitCondition = gdbHit(bp.hitCondition);
      if (bp.logMessage) b.logMessage = bp.logMessage;
      sent.push(b);
    }
    const own = new Set(sent.map(b => b.line));
    for (const line of extraLines) if (!own.has(line)) sent.push({ line, temp: true });
    const { breakpoints = [] } = await this.whileStopped(() => this.request('setBreakpoints', { source: { path: file }, breakpoints: sent.map(({ temp, ...b }) => b) }));
    this.byFile.set(file, sent.filter(b => !b.temp).map((b, i) => ({ id: breakpoints[i]?.id, line: breakpoints[i]?.line ?? b.line, verified: !!breakpoints[i]?.verified })));
    this.reportBreakpoints(file);
  }
  reportBreakpoints(file) {
    const rel = this.host.rel(file);
    if (rel === null) return;
    const lines = [...new Set((this.byFile.get(file) ?? []).filter(b => b.verified).map(b => b.line))].sort((a, b) => a - b);
    this.host.emit({ type: 'breakpoints', file: rel, lines });
  }

  // C++ exceptions: every throw, or none (an uncaught one ends in a crash, which pauses anyway).
  setExceptions(mode) {
    if (!this.client) return Promise.resolve();
    return this.whileStopped(() => this.request('setExceptionBreakpoints', { filters: mode === 'all' && this.build.cpp ? ['throw'] : [] }));
  }
  // Runs `fn` with the program stopped: a running one is interrupted first and let go again after, unseen.
  async whileStopped(fn) {
    if (!this.running) return fn();
    const stopped = new Promise(r => { this.quiet = r; });
    try {
      await this.request('pause', { threadId: this.threadId });
      await this.host.within(stopped, CONNECT_MS, 'pause');
      return await fn();
    } finally {
      this.quiet = null;
      if (!this.running && !this.ended) {
        await this.request('continue', { threadId: this.threadId }).catch(e => this.host.warn(e));
        this.running = true;
      }
    }
  }

  // ---- running ----

  async thread() {
    if (this.threadId !== null) return this.threadId;
    const { threads = [] } = await this.request('threads');
    if (!threads.length) throw new Error('The program has no threads to pause');
    return (this.threadId = threads[0].id);
  }
  async go(cmd) {
    await this.request(cmd, { threadId: await this.thread() });
    this.running = true;
    this.host.setState('running');
  }
  async pause() { await this.request('pause', { threadId: await this.thread() }); }
  resume() { return this.go('continue'); }
  step(kind) { return this.go(kind === 'into' ? 'stepIn' : kind === 'out' ? 'stepOut' : 'next'); }
  async runTo(file, line) {
    this.tempFiles.add(file);
    await this.setBreakpoints(file, this.host.bps().get(file) ?? [], [line]);
    await this.go('continue');
  }

  // ---- values ----

  async scopes(frameId) {
    const { scopes = [] } = await this.request('scopes', { frameId });
    return scopes.filter(s => s.name !== 'Registers').map(s => ({ name: s.name, value: '', type: 'scope', ref: s.variablesReference || 0 }));
  }
  async children(ref) {
    const { variables = [] } = await this.request('variables', { variablesReference: ref });
    return variables.map(v => ({ name: v.name, value: v.value, type: v.type ?? '', ref: v.variablesReference || 0 }));
  }
  // GDB runs 'repl' text as a GDB command; the console and watch list take expressions, so it's always 'watch'.
  async evaluate(expr, frameId) {
    const r = await this.request('evaluate', { expression: expr, ...(typeof frameId === 'number' ? { frameId } : {}), context: 'watch' });
    return { name: expr, value: r.result, type: r.type ?? '', ref: r.variablesReference || 0 };
  }
  async setValue(ref, name, value) {
    const r = await this.request('setVariable', { variablesReference: ref, name, value });
    return { name, value: r.value, type: r.type ?? '', ref: r.variablesReference || 0 };
  }

  // ---- ending ----

  async disconnect() {
    if (this.client && !this.client.closed) await this.request('disconnect', { terminateDebuggee: true }).catch(() => {});
  }
  close() {
    this.ended = true;
    try { fs.rmSync(this.goFile, { force: true }); } catch { /* gone */ }
    this.client?.close();
    if (this.proc && this.proc.exitCode === null) this.proc.kill();
  }
}

module.exports = { GdbBackend, gdbPath, gdbHit };
