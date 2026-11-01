// The DebugManager's Node backend: `node --inspect-brk` driven over the Chrome DevTools Protocol (cdp.js).
// The manager spawns the process and owns its stdio; this reads the inspector's URL from stderr, hides the
// inspector's own lines from the Output, and maps CDP to the session API.
const { execFile } = require('node:child_process');
const { CdpClient, urlRegexFor, cdpCondition, checkBp, valueOf, framesOf } = require('./cdp');

const CONNECT_MS = 15000;
const DIAL_TRIES = 5;

// Node strips TypeScript types without moving positions from 22.18 (23.6 on the 23 line).
function nodeSupportsTs(version) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(version || ''));
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  if (major >= 24) return true;
  if (major === 23) return minor >= 6;
  if (major === 22) return minor >= 18;
  return false;
}

// Lines the inspector writes to the program's stderr: not the program's output.
const BANNER = [/^Debugger listening on ws:\/\//, /^For help, see: /, /^Debugger attached\.$/, /^Waiting for the debugger to disconnect\.\.\.$/, /^Debugger ending on ws:\/\//];
const BANNER_HEADS = ['Debugger listening on ', 'For help, see: ', 'Debugger attached.', 'Waiting for the debugger to disconnect...', 'Debugger ending on '];

const SCOPE_NAMES = { local: 'Locals', closure: 'Closure', global: 'Globals', block: 'Block', catch: 'Catch', script: 'Script', module: 'Module', with: 'With', eval: 'Eval' };
const SETTABLE = new Set(['local', 'closure', 'catch', 'block']); // Debugger.setVariableValue's scopes
const GROUP = 'bz'; // evaluated values are released together on resume

const firstLine = s => String(s ?? '').split('\n')[0];

class NodeBackend {
  constructor(host, { node, env, ts }) {
    this.host = host;
    this.cmd = node;
    this.baseEnv = env || process.env;
    this.ts = !!ts;
    this.client = null;
    this.scripts = new Map();   // scriptId → url
    this.callFrames = [];       // the current pause's frames: a DebugFrame id is an index here
    this.refs = new Map();      // ref → { objectId, scope?: { type, index, frame } }
    this.nextRef = 1;
    this.bpSeq = 0;             // never reused in a session: hit counters in the debuggee are keyed by it
    this.byFile = new Map();    // abs → [{ id, cdpId, line, verified }]
    this.queue = Promise.resolve(); // breakpoint changes, one at a time
    this.entry = true;          // the next pause is --inspect-brk's own
    this.action = null;         // 'step' | 'pause' while one is under way
    this.runToId = null;        // the temporary breakpoint runTo set
    this.err = '';              // stderr text not yet shown (a banner line may arrive in pieces)
    this.urlWaiter = null;
    this.wsUrl = null;
    this.ended = false;
    this.killFirst = true;      // V8 resumes a paused program when the inspector disconnects: stop kills, then closes
  }

  env() { return { ...this.baseEnv }; }

  async prepare() {
    if (this.ts) {
      const v = await new Promise((resolve, reject) => execFile(this.cmd, ['--version'], { windowsHide: true, timeout: CONNECT_MS }, (e, out) => {
        if (e) reject(e.code === 'ENOENT' ? Object.assign(new Error(`Node.js wasn't found (${this.cmd})`), { hint: 'not-found' }) : e);
        else resolve(String(out).trim());
      }));
      if (!nodeSupportsTs(v)) throw Object.assign(new Error(`Debugging TypeScript needs Node 22.18 or newer (this is ${v})`), { hint: 'node-too-old' });
    }
    return { ts: this.ts };
  }

  // The program's stderr, minus the inspector's lines. Finds the inspector's URL on the way.
  stderr(text) {
    this.err += text;
    const lines = this.err.split(/(?<=\n)/);
    // An unfinished last line is held back only while it could still become a banner line.
    const tail = lines.at(-1).endsWith('\n') ? '' : lines.pop();
    const keep = tail && BANNER_HEADS.some(h => h.startsWith(tail) || tail.startsWith(h)) ? tail : '';
    this.err = keep;
    let shown = '';
    for (const line of keep ? lines : [...lines, tail]) {
      const bare = line.replace(/\r?\n$/, '');
      if (!BANNER.some(re => re.test(bare))) { shown += line; continue; }
      const url = /Debugger listening on (ws:\/\/\S+)/.exec(bare)?.[1];
      if (url && !this.wsUrl) { this.wsUrl = url; this.urlWaiter?.resolve(url); }
      // At its end the program waits for the debugger to go: let it go, so it exits with its own code.
      if (/^Waiting for the debugger to disconnect/.test(bare)) { this.ended = true; this.client?.close(); }
    }
    return shown;
  }

  exited() { this.ended = true; this.urlWaiter?.reject(new Error('The program ended')); }

  waitForUrl() {
    if (this.wsUrl) return Promise.resolve(this.wsUrl);
    if (this.ended) return Promise.reject(new Error('The program ended'));
    return this.host.within(new Promise((resolve, reject) => { this.urlWaiter = { resolve, reject }; }), CONNECT_MS, 'starting Node');
  }

  async connect() {
    const { host } = this;
    const url = await this.waitForUrl();
    if (!host.alive()) return;
    const c = await host.within(this.dial(url), CONNECT_MS, 'connecting to Node');
    if (!host.alive() || this.ended) { c.close(); return; }
    this.client = c;
    c.on('warn', e => host.warn(e));
    c.on('Debugger.scriptParsed', p => this.scripts.set(p.scriptId, p.url));
    c.on('Debugger.paused', p => this.paused(p).catch(e => host.warn(e)));
    c.on('Debugger.resumed', () => this.resumed());
    c.on('Debugger.breakpointResolved', p => this.resolved(p));
    const send = (m, p) => host.within(c.send(m, p), CONNECT_MS, m);
    await send('Runtime.enable');
    await send('Debugger.enable');
    await send('Debugger.setPauseOnExceptions', { state: host.exceptions() });
    for (const [file, bps] of host.bps()) await this.setBreakpoints(file, bps);
    await send('Runtime.runIfWaitingForDebugger');
  }

  // The inspector's socket now and then refuses the first handshake (seen once in many runs on Windows): try a few times.
  async dial(url) {
    for (let tries = 1; ; tries++) {
      try { return await CdpClient.connect(url); } catch (e) {
        if (tries >= DIAL_TRIES || !this.host.alive()) throw e;
        this.host.warn(new Error(`${e.message}; trying again`));
        await new Promise(r => setTimeout(r, 200));
      }
    }
  }

  send(method, params) {
    if (!this.client) return Promise.reject(new Error('The debugger is not connected'));
    return this.client.send(method, params);
  }

  // ---- breakpoints ----

  setBreakpoints(file, bps) {
    const run = this.queue.then(() => this.applyBreakpoints(file, bps));
    this.queue = run.catch(() => {});
    return run;
  }
  async applyBreakpoints(file, bps) {
    if (!this.client) return; // not connected yet: connect() sends what the manager holds then
    for (const old of this.byFile.get(file) ?? []) {
      if (old.cdpId) await this.send('Debugger.removeBreakpoint', { breakpointId: old.cdpId }).catch(e => this.host.warn(e));
    }
    const list = [];
    this.byFile.set(file, list);
    for (const bp of bps) {
      if (!bp || bp.enabled === false || !(bp.line >= 1)) continue;
      if (checkBp(bp)) continue; // V8 would drop it without a word: it stays unverified, and the page says why
      const id = ++this.bpSeq;
      const condition = cdpCondition(bp, id);
      const entry = { id, cdpId: null, line: bp.line, verified: false };
      list.push(entry);
      try {
        const r = await this.send('Debugger.setBreakpointByUrl', { lineNumber: bp.line - 1, urlRegex: urlRegexFor(file), ...(condition ? { condition } : {}) });
        entry.cdpId = r.breakpointId;
        entry.verified = (r.locations ?? []).length > 0;
      } catch (e) { this.host.warn(e); }
    }
    this.reportBreakpoints(file);
  }
  resolved({ breakpointId }) {
    for (const [file, list] of this.byFile) {
      const entry = list.find(b => b.cdpId === breakpointId);
      if (entry && !entry.verified) { entry.verified = true; this.reportBreakpoints(file); }
    }
  }
  reportBreakpoints(file) {
    const rel = this.host.rel(file);
    if (rel === null) return;
    const lines = [...new Set((this.byFile.get(file) ?? []).filter(b => b.verified).map(b => b.line))].sort((a, b) => a - b);
    this.host.emit({ type: 'breakpoints', file: rel, lines });
  }

  // Not connected yet: connect() sends the manager's mode then.
  setExceptions(mode) { return this.client ? this.send('Debugger.setPauseOnExceptions', { state: mode }) : Promise.resolve(); }

  // ---- pausing ----

  async paused(p) {
    const { host } = this;
    const hit = (p.hitBreakpoints ?? []).length > 0;
    const isException = p.reason === 'exception' || p.reason === 'promiseRejection';
    const callFrames = p.callFrames ?? [];
    const frames = framesOf(callFrames, this.scripts, host.root);
    let reason;
    if (this.entry) {
      this.entry = false;
      // A breakpoint on the very line the program starts at counts as hit.
      const top = frames[0];
      const atBp = top && !!top.file && [...this.byFile].some(([f, l]) => host.rel(f) === top.file && l.some(b => b.verified && b.line === top.line));
      if (!host.stopOnEntry && !hit && !isException && !atBp) { await this.send('Debugger.resume'); return; }
      reason = hit || atBp ? 'breakpoint' : isException ? 'exception' : 'entry';
    } else {
      reason = hit ? 'breakpoint' : isException ? 'exception' : this.action ?? 'breakpoint'; // no action: a `debugger;` statement
    }
    this.action = null;
    if (this.runToId) {
      const id = this.runToId;
      this.runToId = null;
      this.send('Debugger.removeBreakpoint', { breakpointId: id }).catch(e => host.warn(e));
    }
    this.callFrames = callFrames;
    this.refs.clear();
    const ev = { type: 'paused', reason, frames };
    if (isException) ev.exception = firstLine(p.data?.description ?? p.data?.value ?? 'Exception');
    host.setState('paused');
    host.emit(ev);
  }
  resumed() {
    this.callFrames = [];
    this.refs.clear();
    this.send('Runtime.releaseObjectGroup', { objectGroup: GROUP }).catch(() => {});
    this.host.setState('running');
  }

  pause() { this.action = 'pause'; return this.send('Debugger.pause'); }
  resume() { this.action = null; return this.send('Debugger.resume'); }
  step(kind) {
    this.action = 'step';
    return this.send(kind === 'into' ? 'Debugger.stepInto' : kind === 'out' ? 'Debugger.stepOut' : 'Debugger.stepOver');
  }
  // A one-off breakpoint, removed at the next pause, wherever that is.
  async runTo(file, line) {
    try {
      const r = await this.send('Debugger.setBreakpointByUrl', { lineNumber: line - 1, urlRegex: urlRegexFor(file) });
      this.runToId = r.breakpointId;
    } catch { /* a breakpoint is already there: it will stop anyway */ }
    this.action = 'step';
    await this.send('Debugger.resume');
  }

  // ---- values ----

  refFor(objectId, scope) {
    const ref = this.nextRef++;
    this.refs.set(ref, { objectId, scope });
    return ref;
  }
  frameAt(frameId) {
    const cf = this.callFrames[frameId];
    if (!cf) throw new Error('That frame is gone: the program is not paused there any more');
    return cf;
  }

  async scopes(frameId) {
    const cf = this.frameAt(frameId);
    return (cf.scopeChain ?? []).map((sc, index) => ({
      name: SCOPE_NAMES[sc.type] ?? sc.type,
      value: '',
      type: 'scope',
      ref: sc.object?.objectId ? this.refFor(sc.object.objectId, { type: sc.type, index, frame: frameId }) : 0,
    }));
  }

  async children(ref) {
    const r = this.refs.get(ref);
    if (!r) throw new Error('That value is gone: the program moved on');
    const { result = [] } = await this.send('Runtime.getProperties', { objectId: r.objectId, ownProperties: true, generatePreview: false });
    return result
      .filter(d => d.name !== '__proto__')
      .map(d => d.value ? valueOf(d.name, d.value, id => this.refFor(id))
        : { name: d.name, value: d.get ? '(getter)' : 'undefined', type: d.get ? 'accessor' : 'undefined', ref: 0 });
  }

  // A RemoteObject for `expr`, in the frame when paused, globally otherwise. Throws the program's error message.
  async remote(expr, frameId, context) {
    const hover = context === 'hover';
    const cf = this.callFrames[frameId] ?? (this.callFrames.length ? this.callFrames[0] : null);
    const r = cf
      ? await this.send('Debugger.evaluateOnCallFrame', { callFrameId: cf.callFrameId, expression: expr, objectGroup: GROUP, silent: hover, throwOnSideEffect: hover })
      : await this.send('Runtime.evaluate', { expression: expr, objectGroup: GROUP, silent: hover, throwOnSideEffect: hover, includeCommandLineAPI: context === 'repl' });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(firstLine(d.exception?.description ?? d.exception?.value ?? d.text ?? 'The expression failed'));
    }
    return r.result;
  }

  async evaluate(expr, frameId, context) {
    return valueOf(expr, await this.remote(expr, frameId, context), id => this.refFor(id));
  }

  // `value` is an expression ("5", "'a'", "[1, 2]"), evaluated where the variable lives.
  async setValue(ref, name, value) {
    const r = this.refs.get(ref);
    if (!r) throw new Error('That value is gone: the program moved on');
    const ro = await this.remote(value, r.scope?.frame ?? 0, 'repl');
    const arg = ro.objectId ? { objectId: ro.objectId } : ro.unserializableValue ? { unserializableValue: ro.unserializableValue } : { value: ro.value };
    if (r.scope && SETTABLE.has(r.scope.type)) {
      await this.send('Debugger.setVariableValue', { scopeNumber: r.scope.index, variableName: name, newValue: arg, callFrameId: this.frameAt(r.scope.frame).callFrameId });
      return valueOf(name, ro, id => this.refFor(id));
    }
    const res = await this.send('Runtime.callFunctionOn', {
      objectId: r.objectId,
      functionDeclaration: 'function (k, v) { this[k] = v; return this[k]; }',
      arguments: [{ value: name }, arg],
      objectGroup: GROUP,
    });
    if (res.exceptionDetails) throw new Error(firstLine(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text));
    return valueOf(name, res.result, id => this.refFor(id));
  }

  // ---- ending ----

  async disconnect() { this.close(); }
  close() {
    this.urlWaiter?.reject(new Error('The debug session ended'));
    this.client?.close();
  }
}

module.exports = { NodeBackend, nodeSupportsTs };
