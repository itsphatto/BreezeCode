// The DebugManager's C# backend: netcoredbg (Samsung's MIT-licensed .NET debugger) over the Debug Adapter Protocol.
// prepare() builds the program with `dotnet build` and a startup hook (runtime/BreezeDebugHook) that holds it before
// Main; the manager starts `dotnet Program.dll` and owns its stdio; connect() attaches netcoredbg, sets the
// breakpoints and then lets the program go by creating the hook's "go" file.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { Duplex } = require('node:stream');
const { DapClient } = require('./dap');

const CONNECT_MS = 15000;
const BUILD_MS = 180000;
// The hook's own build, kept in Breeze's data folder (the app's folder may be read-only).
const HOOK_DLL = 'BreezeDebugHook.dll';

class DotnetBackend {
  // `hookSrc`: runtime/BreezeDebugHook; `hookDir`: where its build is kept; `project`: the .csproj, or null for a lone
  // file (a .NET 10 file-based app).
  constructor(host, { dotnet, netcoredbg, env, hookSrc, hookDir, project }) {
    this.host = host;
    this.cmd = dotnet;
    this.netcoredbg = netcoredbg;
    this.baseEnv = env || process.env;
    this.hookSrc = hookSrc;
    this.hookDir = hookDir;
    this.project = project;
    this.goFile = path.join(os.tmpdir(), `breeze-debug-${process.pid}-${Date.now()}.go`);
    this.client = null;
    this.proc = null;
    this.threadId = null;
    this.byFile = new Map();
    this.queue = Promise.resolve();
    this.tempFiles = new Set();
    this.entry = false;
    this.ended = false;
  }

  env() {
    return { ...this.baseEnv, DOTNET_NOLOGO: '1', DOTNET_STARTUP_HOOKS: path.join(this.hookDir, 'bin', HOOK_DLL), BREEZE_DEBUG_GO: this.goFile };
  }

  exec(file, args, cwd, what) {
    return new Promise((resolve, reject) => execFile(file, args, { cwd, env: { ...this.baseEnv, DOTNET_NOLOGO: '1' }, windowsHide: true, timeout: BUILD_MS, maxBuffer: 16 * 1024 * 1024 }, (e, out, err) => {
      if (!e) { resolve(String(out)); return; }
      const text = [out, err].filter(Boolean).join('');
      if (text) this.host.output('stderr', text);
      reject(Object.assign(new Error(e.code === 'ENOENT' ? `${file} wasn't found` : `${what} failed: the Output shows why`), { hint: 'build-failed' }));
    }));
  }

  async prepare() {
    const { host } = this;
    if (!this.netcoredbg || !fs.existsSync(this.netcoredbg)) {
      throw Object.assign(new Error('Debugging C# needs netcoredbg, a free debugger Breeze can download for you'), { hint: 'install-netcoredbg' });
    }
    if (!fs.existsSync(path.join(this.hookDir, 'bin', HOOK_DLL))) {
      host.output('console', '> Building Breeze\'s debug helper (once)\n');
      const src = path.join(this.hookDir, 'src');
      fs.mkdirSync(src, { recursive: true });
      for (const f of fs.readdirSync(this.hookSrc)) fs.copyFileSync(path.join(this.hookSrc, f), path.join(src, f));
      // Not into a folder holding the source: the build leaves out the files under its output folder.
      await this.exec(this.cmd, ['build', path.join(src, 'BreezeDebugHook.csproj'), '-c', 'Release', '-o', path.join(this.hookDir, 'bin'), '-nologo', '-v', 'q'], src, 'Building the debug helper');
    }
    // File-based apps turn startup hooks off by default; Debug keeps locals and lines exact.
    const target = this.project ?? host.file;
    const cwd = path.dirname(target);
    const props = ['-c', 'Debug', '-p:StartupHookSupport=true'];
    host.output('console', `> dotnet build "${path.basename(target)}"\n`);
    await this.exec(this.cmd, ['build', target, ...props, '-nologo', '-v', 'q'], cwd, 'The build');
    const out = await this.exec(this.cmd, ['build', target, ...props, '-getProperty:TargetPath'], cwd, 'Finding the program');
    this.dll = out.trim().split(/\r?\n/).pop().trim();
    if (!this.dll || !fs.existsSync(this.dll)) throw Object.assign(new Error('The build made no program to debug'), { hint: 'build-failed' });
    try { fs.rmSync(this.goFile, { force: true }); } catch { /* not there */ }
    return { args: [this.dll] };
  }

  stderr(text) { return text; }
  exited() { this.ended = true; }

  async connect() {
    const { host } = this;
    const pid = host.pid();
    if (!pid) throw new Error("The program didn't start");
    const proc = this.proc = spawn(this.netcoredbg, ['--interpreter=vscode'], { cwd: host.root, env: { ...this.baseEnv }, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    proc.on('error', () => { /* the client closes with its streams */ });
    const c = this.client = new DapClient(Duplex.from({ readable: proc.stdout, writable: proc.stdin }));
    c.on('warn', e => host.warn(e));
    c.on('event', e => this.onEvent(e));
    const req = (cmd, args) => host.within(c.request(cmd, args), CONNECT_MS, cmd);
    await req('initialize', {
      clientID: 'breeze', clientName: 'Breeze Code', adapterID: 'coreclr', locale: 'en',
      pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true, supportsVariableType: true, supportsRunInTerminalRequest: false,
    });
    await req('attach', { processId: pid, justMyCode: true });
    for (const [file, bps] of host.bps()) await this.setBreakpoints(file, bps);
    // Top-level statements compile to <Main>$, a classic program to Main.
    if (host.stopOnEntry) {
      await req('setFunctionBreakpoints', { breakpoints: [{ name: '<Main>$' }, { name: 'Main' }] });
      this.entry = true;
    }
    await this.setExceptions(host.exceptions());
    await req('configurationDone');
    fs.writeFileSync(this.goFile, '');
    host.setState('running');
  }

  request(cmd, args) {
    if (!this.client) return Promise.reject(new Error('The debugger is not connected'));
    return this.client.request(cmd, args);
  }

  onEvent({ event, body = {} }) {
    const { host } = this;
    switch (event) {
      case 'stopped': this.stopped(body).catch(e => host.warn(e)); break;
      case 'continued': host.setState('running'); break;
      case 'output':
        // The program's own output comes through its pipes; netcoredbg's 'console' lines are its messages.
        if (body.category === 'console' && body.output) host.output('console', body.output);
        break;
      case 'breakpoint': {
        const b = body.breakpoint;
        if (!b) break;
        for (const [file, list] of this.byFile) {
          const entry = list.find(x => x.id !== undefined && x.id === b.id);
          if (entry && (entry.verified !== !!b.verified || (b.line && entry.line !== b.line))) {
            entry.verified = !!b.verified;
            if (b.line) entry.line = b.line;
            this.reportBreakpoints(file);
          }
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
    const { stackFrames = [] } = await host.within(this.request('stackTrace', { threadId: this.threadId, startFrame: 0, levels: 100 }), CONNECT_MS, 'stackTrace');
    const frames = stackFrames.map(f => ({ id: f.id, name: f.name, file: host.rel(f.source?.path), line: f.line, col: f.column }));
    // .NET throws and catches its own exceptions (loading the startup hook does, while netcoredbg attaches): one with
    // none of the program's code on the stack only stops when "all exceptions" is on.
    if (body.reason === 'exception' && !frames.some(f => f.file) && host.exceptions() !== 'all') {
      await this.request('continue', { threadId: this.threadId }).catch(e => host.warn(e));
      return;
    }
    let reason = body.reason === 'function breakpoint' ? 'breakpoint' : body.reason || 'pause';
    if (this.entry) {
      // The first stop, unless it's at one of the user's own breakpoints, is the one at Main.
      const own = new Set([...this.byFile.values()].flat().map(x => x.id));
      if (reason === 'breakpoint' && !(body.hitBreakpointIds ?? []).some(id => own.has(id))) reason = 'entry';
      this.entry = false;
      this.request('setFunctionBreakpoints', { breakpoints: [] }).catch(e => host.warn(e));
    }
    const ev = { type: 'paused', reason, frames };
    if (body.reason === 'exception') {
      const info = await this.request('exceptionInfo', { threadId: this.threadId }).catch(() => null);
      ev.exception = info ? [info.exceptionId, info.description].filter(Boolean).join(': ') : body.text || body.description || 'Exception';
    }
    host.setState('paused');
    host.emit(ev);
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
      const b = { line: bp.line };
      if (bp.condition && bp.condition.trim()) b.condition = bp.condition;
      if (bp.hitCondition && bp.hitCondition.trim()) b.hitCondition = bp.hitCondition.trim();
      if (bp.logMessage) b.logMessage = bp.logMessage;
      sent.push(b);
    }
    const own = new Set(sent.map(b => b.line));
    for (const line of extraLines) if (!own.has(line)) sent.push({ line, temp: true });
    const { breakpoints = [] } = await this.request('setBreakpoints', { source: { path: file }, breakpoints: sent.map(({ temp, ...b }) => b) });
    // Pending breakpoints (their code isn't loaded yet) are fine: netcoredbg binds them as the program loads.
    this.byFile.set(file, sent.filter(b => !b.temp).map((b, i) => ({ id: breakpoints[i]?.id, line: breakpoints[i]?.line ?? b.line, verified: !!breakpoints[i]?.verified })));
    this.reportBreakpoints(file);
  }
  reportBreakpoints(file) {
    const rel = this.host.rel(file);
    if (rel === null) return;
    const lines = [...new Set((this.byFile.get(file) ?? []).filter(b => b.verified).map(b => b.line))].sort((a, b) => a - b);
    this.host.emit({ type: 'breakpoints', file: rel, lines });
  }

  setExceptions(mode) {
    if (!this.client) return Promise.resolve();
    const filters = mode === 'all' ? ['all'] : mode === 'uncaught' ? ['user-unhandled'] : [];
    return this.request('setExceptionBreakpoints', { filters });
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
    return scopes.map(s => ({ name: s.name, value: '', type: 'scope', ref: s.variablesReference || 0 }));
  }
  async children(ref) {
    const { variables = [] } = await this.request('variables', { variablesReference: ref });
    return variables.map(v => ({ name: v.name, value: v.value, type: v.type ?? '', ref: v.variablesReference || 0 }));
  }
  async evaluate(expr, frameId, context) {
    const r = await this.request('evaluate', { expression: expr, ...(typeof frameId === 'number' ? { frameId } : {}), context });
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
    this.client?.close();
    if (this.proc && this.proc.exitCode === null) this.proc.kill();
    try { fs.rmSync(this.goFile, { force: true }); } catch { /* gone */ }
  }
}

module.exports = { DotnetBackend };
