// DebugManager: runs the user's Python or JS/TS file under a debugger and turns either backend into one session API.
// Breeze launches the program itself, so it owns stdin/stdout/stderr; the backend (debugPython.js → debugpy over DAP,
// debugNode.js → node --inspect-brk over CDP) only speaks the protocol. One session at a time.
// Emits 'event' with a DebugEvent ({ type: 'state' | 'paused' | 'output' | 'breakpoints' | 'exited' | 'error', … }).
const { EventEmitter } = require('node:events');
const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const { PythonBackend } = require('./debugPython');
const { NodeBackend, nodeSupportsTs } = require('./debugNode');

const REQUEST_MS = 10000; // an adapter call that takes longer is a hung adapter: reject that call, keep the session
const CONNECT_MS = 15000; // finding, connecting to and configuring the adapter
const STOP_MS = 3000;     // how long stop() waits for the process tree to go before calling it stopped anyway
const OUTPUT_MS = 50;     // program output is coalesced per stream, so a chatty program doesn't flood the page

const TASKKILL = path.join(process.env.SystemRoot || String.raw`C:\Windows`, 'System32', 'taskkill.exe');
function killTree(child) {
  if (process.platform === 'win32') execFile(TASKKILL, ['/pid', String(child.pid), '/T', '/F'], () => { /* already gone */ });
  else child.kill('SIGTERM');
}

const NODE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts']);
function debugKind(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  if (ext === '.py') return 'python';
  return NODE_EXTS.has(ext) ? 'node' : null;
}
const isTs = file => /\.m?ts$/i.test(file);

function launchArgs(kind, file, { port, ts } = {}) {
  if (kind === 'python') return { args: ['-Xfrozen_modules=off', '-m', 'debugpy', '--listen', `127.0.0.1:${port}`, '--wait-for-client', file] };
  return { args: ['--inspect-brk=127.0.0.1:0', ...(ts ? ['--experimental-strip-types'] : []), file] };
}

// Rejects with a clear message when `p` hasn't settled in `ms`; the call it stands for is simply abandoned.
function within(p, ms, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`The debugger did not answer in time (${what})`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

const hinted = (message, hint) => Object.assign(new Error(message), { hint });

// A project-relative path with forward slashes, or null for a file outside `root`.
function relOf(abs, root) {
  if (typeof abs !== 'string' || !abs) return null;
  const rel = path.relative(root, abs); // case-insensitive on Windows
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

class DebugManager extends EventEmitter {
  constructor() {
    super();
    this.session = null;
    this.last = null;            // the last start() options, for restart()
    this.bps = new Map();        // absolute path → Bp[]: kept between sessions
    this.exceptions = 'none';
    this.settled = Promise.resolve(); // every session but the newest has finished (its 'stopped' is out)
  }

  get pid() { return this.session?.child?.pid ?? null; }
  get state() { return this.session?.state ?? 'stopped'; }

  // Never rejects: what goes wrong arrives as an 'error' event, then 'state: stopped'. Resolves once the program is
  // running (or paused), or the attempt is over.
  async start(opts = {}) {
    const prev = this.session;
    // Claimed at once, so a stop() right after start() finds this session even before the old one is gone.
    const s = this.session = { opts, state: null, child: null, backend: null, live: false, dead: false, finished: false, exitCode: undefined, out: { stdout: '', stderr: '' }, timer: null };
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
    if (!kind) { this.fail(s, hinted('Breeze can debug Python, JavaScript and TypeScript files')); return; }
    const host = this.hostFor(s, root, file);
    s.backend = kind === 'python' ? new PythonBackend(host, { python: opts.python || 'python', env: opts.env })
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

  spawn(s, kind, root, file, launch) {
    const { args } = launchArgs(kind, file, launch);
    const child = s.child = spawn(s.backend.cmd, args, { cwd: root, env: s.backend.env(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', t => this.output(s, 'stdout', t));
    child.stderr.on('data', t => {
      const shown = s.backend.stderr(t); // Node's inspector banner is the backend's business, not the program's
      if (shown) this.output(s, 'stderr', shown);
    });
    child.stdin.on('error', () => { /* the program closed its stdin or ended */ });
    child.on('error', e => {
      if (s.exitCode !== undefined || s.finished) return;
      s.spawnFailed = true;
      const what = kind === 'python' ? "Python wasn't found" : "Node.js wasn't found";
      this.emitFor(s, { type: 'error', message: e.code === 'ENOENT' ? `${what} (${s.backend.cmd})` : e.message, hint: e.code === 'ENOENT' ? 'not-found' : undefined });
      this.finish(s, null);
    });
    child.on('exit', code => {
      s.exitCode = code;
      s.backend.exited?.();
      // 'close' waits for every holder of the pipes (debugpy's adapter is one); don't wait on it for long.
      setTimeout(() => this.finish(s, code), 500).unref?.();
    });
    child.on('close', code => this.finish(s, s.exitCode ?? code));
  }

  // What the backends see of the session.
  hostFor(s, root, file) {
    return {
      root, file,
      stopOnEntry: !!s.opts.stopOnEntry,
      bps: () => this.bps,
      exceptions: () => this.exceptions,
      emit: ev => this.emitFor(s, ev),
      setState: st => this.setState(s, st),
      output: (stream, text) => this.output(s, stream, text),
      alive: () => !s.dead && !s.finished && s.exitCode === undefined,
      warn: e => console.warn('[breeze] debug:', e?.message ?? e),
      within,
      rel: abs => relOf(abs, root),
    };
  }

  // A listener that throws must not break the session's bookkeeping (or escape a stream handler in main).
  send(ev) {
    try { this.emit('event', ev); } catch (e) { console.warn('[breeze] debug event listener:', e?.message ?? e); }
  }
  emitFor(s, ev) {
    if (!s.finished) this.send(ev);
  }
  setState(s, state) {
    if (s.finished || s.state === state) return;
    s.state = state;
    this.send({ type: 'state', state });
  }

  output(s, stream, text) {
    if (s.finished || !text) return;
    if (stream === 'console') { this.flush(s); this.emitFor(s, { type: 'output', stream, text }); return; }
    s.out[stream] += text;
    s.timer ??= setTimeout(() => { s.timer = null; this.flush(s); }, OUTPUT_MS);
  }
  flush(s) {
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    for (const stream of ['stdout', 'stderr']) {
      const text = s.out[stream];
      s.out[stream] = '';
      if (text) this.emitFor(s, { type: 'output', stream, text });
    }
  }

  fail(s, e) {
    this.emitFor(s, { type: 'error', message: e?.message || String(e), ...(e?.hint ? { hint: e.hint } : {}) });
    this.stopSession(s);
  }

  // Once per session: the last output, 'exited' if a program ran, then 'stopped'.
  finish(s, code) {
    if (s.finished) return;
    this.flush(s);
    if (s.child && !s.spawnFailed) this.emitFor(s, { type: 'exited', code: code ?? null });
    if (!(s.superseded && s.state === null)) this.setState(s, 'stopped'); // a start replaced before it began says nothing
    s.finished = s.dead = true;
    try { s.backend?.close(); } catch (e) { console.warn('[breeze] debug:', e?.message ?? e); }
    if (s.child && s.child.exitCode === null && s.child.signalCode === null) killTree(s.child); // e.g. the adapter outlived the program
    if (this.session === s) this.session = null;
  }

  // Asks the adapter to let go, then kills the process tree. Always ends in 'stopped', even with a wedged adapter.
  // A backend whose disconnect would let the program run on (Node resumes when its last inspector session goes)
  // has the tree killed first and the connection closed after.
  stopSession(s) {
    if (!s || s.finished) return Promise.resolve();
    if (s.stopping) return s.stopping;
    s.dead = true; // no connection attempt outlives this
    s.stopping = (async () => {
      await s.after; // the sessions before this one are gone first, so their events come before this 'stopped'
      if (s.backend && s.live && !s.backend.killFirst) await within(s.backend.disconnect(), 1500, 'disconnect').catch(() => {});
      if (s.child && s.exitCode === undefined && !s.spawnFailed) {
        const gone = new Promise(r => { s.child.once('exit', r); s.child.once('error', r); });
        killTree(s.child);
        let timer;
        await Promise.race([gone, new Promise(r => { timer = setTimeout(r, STOP_MS); })]);
        clearTimeout(timer);
      }
      try { s.backend?.close(); } catch { /* closing anyway */ }
      this.finish(s, s.exitCode ?? null);
    })();
    return s.stopping;
  }

  stop() { return this.stopSession(this.session); }

  restart() {
    if (!this.last) return Promise.resolve();
    return this.start({ ...this.last, breakpoints: Object.fromEntries(this.bps), exceptions: this.exceptions });
  }

  // The live session's backend, connected; otherwise the call rejects.
  ready() {
    const s = this.session;
    if (!s || s.finished || !s.backend || !s.live) throw new Error('The debugger is not running');
    return s;
  }
  call(what, fn) {
    let s;
    try { s = this.ready(); } catch (e) { return Promise.reject(e); }
    return within(Promise.resolve().then(() => fn(s.backend)), REQUEST_MS, what);
  }
  // Pause / continue / step only mean something in one state; otherwise they do nothing.
  whenState(state, what, fn) {
    if (this.session?.state !== state) return Promise.resolve();
    return this.call(what, fn);
  }

  pause() { return this.whenState('running', 'pause', b => b.pause()); }
  continue() { return this.whenState('paused', 'continue', b => b.resume()); }
  step(kind) {
    if (!['over', 'into', 'out'].includes(kind)) return Promise.reject(new Error(`Unknown step: ${kind}`));
    return this.whenState('paused', 'step', b => b.step(kind));
  }
  runTo(file, line) {
    const s = this.session;
    if (!s) return Promise.resolve();
    return this.whenState('paused', 'run to line', b => b.runTo(path.resolve(path.resolve(s.opts.root), file), line));
  }
  setBreakpoints(file, bps) {
    const root = this.session ? path.resolve(this.session.opts.root) : this.last ? path.resolve(this.last.root) : null;
    const abs = root ? path.resolve(root, file) : path.resolve(file);
    const list = Array.isArray(bps) ? bps : [];
    if (list.length) this.bps.set(abs, list); else this.bps.delete(abs);
    if (!this.session?.live || this.session.finished) return Promise.resolve();
    return this.call('set breakpoints', b => b.setBreakpoints(abs, list));
  }
  setExceptions(mode) {
    this.exceptions = ['uncaught', 'all'].includes(mode) ? mode : 'none';
    if (!this.session?.live || this.session.finished) return Promise.resolve();
    return this.call('exception breakpoints', b => b.setExceptions(this.exceptions));
  }
  scopes(frameId) { return this.call('scopes', b => b.scopes(frameId)); }
  children(ref) { return this.call('variables', b => b.children(ref)); }
  evaluate(expr, frameId, context) { return this.call('evaluate', b => b.evaluate(String(expr), frameId, context || 'repl')); }
  setValue(ref, name, value) { return this.call('set value', b => b.setValue(ref, String(name), String(value))); }
  stdin(text) {
    const child = this.session?.child;
    if (!child || this.session.finished || !child.stdin.writable) return false;
    child.stdin.write(String(text));
    return true;
  }
}

module.exports = { DebugManager, debugKind, nodeSupportsTs, launchArgs, killTree, relOf };
