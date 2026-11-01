// The DebugManager's Python backend: `python -m debugpy --listen … --wait-for-client` driven over the Debug Adapter
// Protocol (dap.js). The manager spawns the process and owns its stdio; this connects to debugpy's port and maps
// DAP to the session API.
const net = require('node:net');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { DapClient } = require('./dap');
const { checkBp } = require('./cdp');

const CONNECT_MS = 15000;
const DIAL_MS = 10000; // debugpy takes a moment to start listening
const DIAL_EVERY = 100;
const ENTRY_MAX_LINES = 20000; // stop-on-entry puts a one-off breakpoint on every line of the file, up to this many

const HIT_RE = /^\s*(>=|<=|==|=|>|<|%)?\s*(\d+)\s*$/;
// The hit count as debugpy reads it. A bare number means "from that hit on" in both backends (debugpy alone would
// read it as "only that hit"), and `=` is `==`.
function pythonHit(text) {
  const m = HIT_RE.exec(text || '');
  if (!m) return null;
  const op = !m[1] ? '>=' : m[1] === '=' ? '==' : m[1];
  return `${op} ${m[2]}`;
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

class PythonBackend {
  constructor(host, { python, env }) {
    this.host = host;
    this.cmd = python;
    this.baseEnv = env || process.env;
    this.port = 0;
    this.client = null;
    this.socket = null;
    this.threadId = null;
    this.byFile = new Map();  // abs → [{ id, line, verified }]
    this.queue = Promise.resolve(); // breakpoint changes, one at a time
    this.tempFiles = new Set(); // files whose breakpoints carry one-off lines (runTo, stop on entry) until the next stop
    this.entry = false;         // the next stop is the stop on entry
    this.ended = false;
  }

  env() {
    // Unbuffered UTF-8, so print() reaches the Output as it happens; no frozen-modules warning from debugpy.
    return { ...this.baseEnv, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYDEVD_DISABLE_FILE_VALIDATION: '1' };
  }

  async prepare() {
    await new Promise((resolve, reject) => execFile(this.cmd, ['-m', 'debugpy', '--version'], { windowsHide: true, timeout: CONNECT_MS, env: this.env() }, e => {
      if (!e) resolve();
      else if (e.code === 'ENOENT') reject(Object.assign(new Error(`Python wasn't found (${this.cmd})`), { hint: 'not-found' }));
      else reject(Object.assign(new Error('Debugging Python needs debugpy. Install it with: python -m pip install debugpy'), { hint: 'install-debugpy' }));
    }));
    this.port = await freePort();
    return { port: this.port };
  }

  stderr(text) { return text; }
  exited() { this.ended = true; }

  // Connects to debugpy's port, trying again every 100 ms for up to 10 s.
  async dial() {
    const end = Date.now() + DIAL_MS;
    for (;;) {
      if (!this.host.alive() || this.ended) throw new Error('The debug session ended');
      const sock = await new Promise(resolve => {
        const s = net.connect({ host: '127.0.0.1', port: this.port });
        s.once('connect', () => { s.removeAllListeners('error'); resolve(s); });
        s.once('error', () => { s.destroy(); resolve(null); });
      });
      if (sock) return sock;
      if (Date.now() > end) throw new Error(`Could not reach debugpy on port ${this.port}`);
      await new Promise(r => setTimeout(r, DIAL_EVERY));
    }
  }

  async connect() {
    const { host } = this;
    const sock = this.socket = await this.dial();
    if (!host.alive()) { sock.destroy(); return; }
    const c = this.client = new DapClient(sock);
    c.on('warn', e => host.warn(e));
    let initialized;
    const ready = new Promise(r => { initialized = r; });
    c.on('event', e => {
      if (e.event === 'initialized') initialized();
      else this.onEvent(e);
    });
    const req = (cmd, args) => host.within(c.request(cmd, args), CONNECT_MS, cmd);
    await req('initialize', {
      clientID: 'breeze', clientName: 'Breeze Code', adapterID: 'debugpy', locale: 'en',
      pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true,
      supportsVariableType: true, supportsRunInTerminalRequest: false,
    });
    // debugpy answers attach only after configurationDone, so it isn't awaited until then.
    const attached = c.request('attach', { justMyCode: true, redirectOutput: false, subProcess: false });
    attached.catch(() => { /* awaited below */ });
    await host.within(ready, CONNECT_MS, 'initialized');
    for (const [file, bps] of host.bps()) await this.setBreakpoints(file, bps);
    // debugpy's attach has no stop on entry (it ignores `stopOnEntry` there): a one-off breakpoint on every line of
    // the file stops on the first one that runs, wherever the code starts.
    if (host.stopOnEntry) {
      let count = 0;
      try { count = Math.min(fs.readFileSync(host.file, 'utf8').split('\n').length, ENTRY_MAX_LINES); } catch { /* unreadable: runs on */ }
      if (count) {
        this.entry = true;
        this.tempFiles.add(host.file);
        await this.setBreakpoints(host.file, host.bps().get(host.file) ?? [], Array.from({ length: count }, (_, i) => i + 1));
      }
    }
    await this.setExceptions(host.exceptions());
    await req('configurationDone');
    await host.within(attached, CONNECT_MS, 'attach');
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
        if (body.category === 'telemetry' || !body.output) break;
        // The program's own stdout/stderr come through its pipes; these are debugpy's messages and logpoints.
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
      // 'exited' / 'terminated': the process's own exit says it.
    }
  }

  async stopped(body) {
    const { host } = this;
    if (body.threadId !== undefined) this.threadId = body.threadId;
    for (const f of this.tempFiles) this.setBreakpoints(f, host.bps().get(f) ?? []).catch(e => host.warn(e));
    this.tempFiles.clear();
    const entry = this.entry;
    this.entry = false;
    const { stackFrames = [] } = await host.within(this.request('stackTrace', { threadId: this.threadId, startFrame: 0, levels: 100 }), CONNECT_MS, 'stackTrace');
    const frames = stackFrames.map(f => ({ id: f.id, name: f.name, file: host.rel(f.source?.path), line: f.line, col: f.column }));
    let reason = body.reason || 'pause';
    if (entry && reason === 'breakpoint') {
      const top = frames[0];
      const own = top && [...this.byFile].some(([f, list]) => host.rel(f) === top.file && list.some(b => b.line === top.line));
      if (!own) reason = 'entry';
    }
    const ev = { type: 'paused', reason, frames };
    if (body.reason === 'exception') {
      const info = await host.within(this.request('exceptionInfo', { threadId: this.threadId }), CONNECT_MS, 'exceptionInfo').catch(() => null);
      ev.exception = info ? [info.exceptionId, info.description].filter(Boolean).join(': ') : (body.text || body.description || 'Exception');
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
  // `extraLines` are one-off stops (not the user's): sent plainly, never reported.
  async applyBreakpoints(file, bps, extraLines = []) {
    if (!this.client) return; // not connected yet: connect() sends what the manager holds then
    const sent = [];
    for (const bp of bps) {
      if (!bp || bp.enabled === false || !(bp.line >= 1)) continue;
      if (bp.hitCondition && checkBp({ hitCondition: bp.hitCondition })) continue; // unverified: the page says why
      const b = { line: bp.line };
      if (bp.condition && bp.condition.trim()) b.condition = bp.condition;
      if (bp.hitCondition && bp.hitCondition.trim()) b.hitCondition = pythonHit(bp.hitCondition);
      if (bp.logMessage) b.logMessage = bp.logMessage;
      sent.push(b);
    }
    const own = new Set(sent.map(b => b.line));
    for (const line of extraLines) if (!own.has(line)) sent.push({ line, temp: true });
    const { breakpoints = [] } = await this.request('setBreakpoints', {
      source: { path: file }, breakpoints: sent.map(({ temp, ...b }) => b), sourceModified: false,
    });
    this.byFile.set(file, sent.filter(b => !b.temp).map((b, i) => ({ id: breakpoints[i]?.id, line: b.line, verified: !!breakpoints[i]?.verified })));
    this.reportBreakpoints(file);
  }
  reportBreakpoints(file) {
    const rel = this.host.rel(file);
    if (rel === null) return;
    const lines = [...new Set((this.byFile.get(file) ?? []).filter(b => b.verified).map(b => b.line))].sort((a, b) => a - b);
    this.host.emit({ type: 'breakpoints', file: rel, lines });
  }

  setExceptions(mode) {
    if (!this.client) return Promise.resolve(); // not connected yet: connect() sends the manager's mode then
    const filters = mode === 'all' ? ['raised', 'uncaught'] : mode === 'uncaught' ? ['uncaught'] : [];
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
    this.host.setState('running'); // DAP sends no 'continued' for a request the client made
  }
  async pause() { await this.request('pause', { threadId: await this.thread() }); }
  resume() { return this.go('continue'); }
  step(kind) { return this.go(kind === 'into' ? 'stepIn' : kind === 'out' ? 'stepOut' : 'next'); }
  // The file's breakpoints plus one on `line`, until the next stop.
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
    if (this.client) this.client.close(); else this.socket?.destroy();
  }
}

module.exports = { PythonBackend, pythonHit };
