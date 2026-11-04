// The DebugManager's Java backend: the JVM's own debugger, JDWP (jdwp.js). prepare() compiles the file with javac -g
// (so locals have names) into build/java; the manager starts `java -agentlib:jdwp=…,suspend=y` and owns its stdio;
// connect() attaches, sets the breakpoints as their classes load and lets the program go.
// JDWP has no expression evaluator: the console and watch list read variables and their fields (a.b, arr[0]).
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { JdwpClient, TAG, OBJECT_TAGS, EV, isNull, connect } = require('./jdwp');

const CONNECT_MS = 15000;
const BUILD_MS = 120000;
const DIAL_MS = 10000;
const ARRAY_MAX = 200; // array elements shown
const SUSPEND_ALL = 2;
const STATIC = 0x0008;
// Classes the debugger never stops in when stepping, or for "all exceptions" (their own, caught ones are many).
const LIBRARY = ['java.*', 'javax.*', 'jdk.*', 'sun.*', 'com.sun.*'];
const LOCATION_ONLY = 7, CLASS_EXCLUDE = 6, COUNT = 1, EXCEPTION_ONLY = 8, STEP_MOD = 10;
const BOXED = new Set(['Ljava/lang/Integer;', 'Ljava/lang/Long;', 'Ljava/lang/Double;', 'Ljava/lang/Float;', 'Ljava/lang/Short;', 'Ljava/lang/Byte;', 'Ljava/lang/Character;', 'Ljava/lang/Boolean;']);

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
// "Lcom/x/Main$Inner;" → "Main$Inner"; "[I" → "int[]".
const PRIM = { I: 'int', J: 'long', D: 'double', F: 'float', Z: 'boolean', C: 'char', S: 'short', B: 'byte', V: 'void' };
function typeName(sig) {
  if (!sig) return '';
  if (sig[0] === '[') return typeName(sig.slice(1)) + '[]';
  if (sig[0] === 'L') return sig.slice(1, -1).split('/').pop();
  return PRIM[sig] ?? sig;
}
const tagOfSig = sig => (sig[0] === '[' ? TAG.ARRAY : sig[0] === 'L' ? TAG.OBJECT : sig.charCodeAt(0));
// The package a source file declares ("" for none), so the class name and source folder follow from it.
const packageOf = text => /^\s*package\s+([\w.]+)\s*;/m.exec(text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''))?.[1] ?? '';

class JavaBackend {
  constructor(host, { java, javac, env }) {
    this.host = host;
    this.cmd = java;
    this.javac = javac;
    this.baseEnv = env || process.env;
    this.client = null;
    this.port = 0;
    this.thread = null;            // the thread the program is paused in
    this.classes = new Map();      // class id → { sig, file (abs or null), methods: Map(id → { name, sig, mods }) }
    this.lineTables = new Map();   // `${cls}:${method}` → [{ index: bigint, line }]
    this.byFile = new Map();       // abs → { requests: [id], lines: [verified line] }
    this.temp = [];                // one-off breakpoint requests (stop on entry, run to line), cleared at the next stop
    this.stepRequest = null;
    this.excRequest = null;
    this.frames = new Map();       // frame number → { thread, frame, location }
    this.refs = new Map();         // ref → { kind: 'locals' | 'object' | 'array', … }
    this.next = 1;
    this.queue = Promise.resolve();
    this.killFirst = true;         // a suspended VM resumes if the debugger lets go: stop kills, then closes
    this.ended = false;
  }

  env() { return { ...this.baseEnv }; }

  async prepare() {
    const { host } = this;
    const text = fs.readFileSync(host.file, 'utf8');
    const pkg = packageOf(text);
    const name = path.basename(host.file, '.java');
    // The folder the packages start in: the file's folder, less one level per package part.
    this.srcRoot = pkg ? path.resolve(path.dirname(host.file), ...pkg.split('.').map(() => '..')) : path.dirname(host.file);
    this.mainClass = pkg ? `${pkg}.${name}` : name;
    this.out = path.join(this.srcRoot, 'build', 'java');
    fs.mkdirSync(this.out, { recursive: true });
    const args = ['-g', '-encoding', 'UTF-8', '-d', this.out, '-sourcepath', this.srcRoot, host.file];
    host.output('console', `> javac -g ${path.basename(host.file)}\n`);
    await new Promise((resolve, reject) => execFile(this.javac, args, { cwd: this.srcRoot, env: this.env(), windowsHide: true, timeout: BUILD_MS }, (e, out, err) => {
      const msg = [out, err].filter(Boolean).join('');
      if (msg) host.output('stderr', msg);
      if (!e) resolve();
      else if (e.code === 'ENOENT') reject(Object.assign(new Error(`The Java compiler wasn't found (${this.javac})`), { hint: 'install-jdk' }));
      else reject(Object.assign(new Error('The build failed: the Output shows why'), { hint: 'build-failed' }));
    }));
    this.port = await freePort();
    return { args: this.launchArgs() };
  }
  launchArgs() {
    return [`-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,quiet=y,address=127.0.0.1:${this.port}`,
      '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', '-cp', this.out, this.mainClass];
  }

  stderr(text) { return text; }
  exited() { this.ended = true; }

  async dial() {
    const end = Date.now() + DIAL_MS;
    for (;;) {
      if (!this.host.alive() || this.ended) throw new Error('The debug session ended');
      const s = await connect(this.port).catch(() => null);
      if (s) return s;
      if (Date.now() > end) throw new Error(`Could not reach the Java debugger on port ${this.port}`);
      await new Promise(r => setTimeout(r, 100));
    }
  }

  async connect() {
    const { host } = this;
    const sock = await this.dial();
    if (!host.alive()) { sock.destroy(); return; }
    const c = this.client = new JdwpClient(sock);
    c.on('warn', e => host.warn(e));
    c.on('event', e => { this.onEvents(e).catch(err => host.warn(err)); });
    await host.within(c.start(), CONNECT_MS, 'connecting to Java');
    // Each class of the program, as it loads: its breakpoints go in before any of its code runs.
    await this.request(15, 1, w => {
      w.u8(EV.CLASS_PREPARE).u8(SUSPEND_ALL).i32(LIBRARY.length);
      for (const p of LIBRARY) w.u8(CLASS_EXCLUDE).str(p);
    });
    await this.setExceptions(host.exceptions());
    await this.request(1, 9); // resume
    host.setState('running');
  }

  request(set, cmd, build) {
    if (!this.client) return Promise.reject(new Error('The debugger is not connected'));
    return this.client.cmd(set, cmd, build);
  }
  resumeVm() { return this.request(1, 9); }

  async onEvents({ suspendPolicy, events }) {
    let stop = null;
    for (const e of events) {
      if (e.kind === EV.CLASS_PREPARE) await this.prepared(e.type, e.signature).catch(err => this.host.warn(err));
      else if (e.kind === EV.VM_DEATH) this.ended = true;
      else if (e.kind === EV.BREAKPOINT || e.kind === EV.STEP || e.kind === EV.EXCEPTION) stop ??= e;
    }
    if (stop) { await this.stopped(stop); return; }
    if (suspendPolicy === SUSPEND_ALL && !this.ended) await this.resumeVm().catch(() => { /* the VM ended */ });
  }

  // ---- classes, lines and breakpoints ----

  async classInfo(cls) {
    let info = this.classes.get(cls);
    if (info) return info;
    const sig = (await this.request(2, 1, w => w.ref(cls))).str();
    info = { sig, file: null, methods: new Map() };
    try {
      const source = (await this.request(2, 7, w => w.ref(cls))).str();
      const pkgDir = sig.slice(1, -1).split('/').slice(0, -1);
      const abs = path.join(this.srcRoot, ...pkgDir, source);
      if (fs.existsSync(abs)) info.file = abs;
    } catch { /* no source file attribute */ }
    const r = await this.request(2, 5, w => w.ref(cls));
    for (let n = r.i32(); n > 0; n--) { const id = r.method(); info.methods.set(id, { name: r.str(), sig: r.str(), mods: r.i32() }); }
    this.classes.set(cls, info);
    return info;
  }
  async lineTable(cls, method) {
    const key = `${cls}:${method}`;
    if (this.lineTables.has(key)) return this.lineTables.get(key);
    let lines = [];
    try {
      const r = await this.request(6, 1, w => w.ref(cls).method(method));
      r.i64(); r.i64(); // start and end
      for (let n = r.i32(); n > 0; n--) lines.push({ index: r.i64(), line: r.i32() });
      lines.sort((a, b) => (a.index < b.index ? -1 : 1));
    } catch { lines = []; } // native or abstract
    this.lineTables.set(key, lines);
    return lines;
  }
  async lineOf(loc) {
    const lines = await this.lineTable(loc.cls, loc.method);
    const at = BigInt('0x' + loc.index);
    let line = 0;
    for (const l of lines) { if (l.index > at) break; line = l.line; }
    return line;
  }
  // The first code at `line` in a class: { tag, cls, method, index } or null.
  async locationAt(cls, line) {
    const info = await this.classInfo(cls);
    for (const id of info.methods.keys()) {
      const hit = (await this.lineTable(cls, id)).find(l => l.line === line);
      if (hit) return { tag: 1, cls, method: id, index: hit.index.toString(16).padStart(16, '0') };
    }
    return null;
  }
  async prepared(cls) {
    const info = await this.classInfo(cls);
    if (!info.file) return;
    if (this.host.stopOnEntry && !this.entrySet && info.sig === `L${this.mainClass.replace(/\./g, '/')};`) {
      this.entrySet = true;
      for (const [id, m] of info.methods) {
        if (m.name !== 'main') continue;
        const first = (await this.lineTable(cls, id))[0];
        if (first) this.temp.push(await this.breakAt({ tag: 1, cls, method: id, index: first.index.toString(16).padStart(16, '0') }, 'entry'));
      }
    }
    const bps = this.host.bps().get(info.file);
    if (bps) await this.applyBreakpoints(info.file, bps);
  }
  async breakAt(loc, why = 'breakpoint') {
    const id = (await this.request(15, 1, w => w.u8(EV.BREAKPOINT).u8(SUSPEND_ALL).i32(1).u8(LOCATION_ONLY).location(loc))).i32();
    (this.why ??= new Map()).set(id, why);
    return id;
  }
  clear(kind, id) { return this.request(15, 2, w => w.u8(kind).i32(id)).catch(() => { /* already gone */ }); }

  setBreakpoints(file, bps) {
    const run = this.queue.then(() => this.applyBreakpoints(file, bps));
    this.queue = run.catch(() => {});
    return run;
  }
  // Conditions and hit counts need an expression evaluator, which JDWP lacks: such breakpoints stay unverified.
  async applyBreakpoints(file, bps) {
    if (!this.client) return;
    const old = this.byFile.get(file);
    for (const id of old?.requests ?? []) await this.clear(EV.BREAKPOINT, id);
    const entry = { requests: [], lines: [] };
    this.byFile.set(file, entry);
    const classes = [...this.classes].filter(([, i]) => i.file && path.resolve(i.file) === path.resolve(file)).map(([id]) => id);
    for (const bp of bps) {
      if (!bp || bp.enabled === false || !(bp.line >= 1) || bp.condition?.trim() || bp.hitCondition?.trim() || bp.logMessage) continue;
      for (const cls of classes) {
        const loc = await this.locationAt(cls, bp.line);
        if (!loc) continue;
        entry.requests.push(await this.breakAt(loc));
        entry.lines.push(bp.line);
        break;
      }
    }
    const rel = this.host.rel(file);
    if (rel !== null) this.host.emit({ type: 'breakpoints', file: rel, lines: [...new Set(entry.lines)].sort((a, b) => a - b) });
  }

  async setExceptions(mode) {
    if (!this.client) return;
    if (this.excRequest) { await this.clear(EV.EXCEPTION, this.excRequest); this.excRequest = null; }
    if (mode !== 'all' && mode !== 'uncaught') return;
    const all = mode === 'all';
    this.excRequest = (await this.request(15, 1, w => {
      w.u8(EV.EXCEPTION).u8(SUSPEND_ALL).i32(all ? 1 + LIBRARY.length : 1);
      w.u8(EXCEPTION_ONLY).ref('0').u8(all ? 1 : 0).u8(1);
      if (all) for (const p of LIBRARY) w.u8(CLASS_EXCLUDE).str(p);
    })).i32();
  }

  // ---- stopping ----

  async stopped(e) {
    const { host } = this;
    this.thread = e.thread;
    if (this.stepRequest) { await this.clear(EV.STEP, this.stepRequest); this.stepRequest = null; }
    let reason = e.kind === EV.STEP ? 'step' : e.kind === EV.EXCEPTION ? 'exception' : this.why?.get(e.requestId) ?? 'breakpoint';
    if (e.kind === EV.BREAKPOINT && this.temp.includes(e.requestId) && reason !== 'entry') reason = 'step'; // run to line
    for (const id of this.temp) await this.clear(EV.BREAKPOINT, id);
    this.temp = [];
    const ev = { type: 'paused', reason, frames: await this.framesOf(e.thread) };
    if (e.kind === EV.EXCEPTION) ev.exception = await this.describe(e.exception);
    host.setState('paused');
    host.emit(ev);
  }
  async framesOf(thread) {
    this.frames.clear();
    this.refs.clear();
    const r = await this.request(11, 6, w => w.object(thread).i32(0).i32(-1));
    const raw = [];
    for (let n = r.i32(); n > 0; n--) raw.push({ frame: r.frame(), location: r.location() });
    const out = [];
    for (const f of raw.slice(0, 100)) {
      const info = await this.classInfo(f.location.cls);
      const m = info.methods.get(f.location.method);
      const id = this.next++;
      this.frames.set(id, { thread, ...f });
      out.push({ id, name: `${typeName(info.sig)}.${m?.name ?? '?'}`, file: info.file ? this.host.rel(info.file) : null, line: await this.lineOf(f.location), col: 1 });
    }
    return out;
  }
  async describe(v) {
    const kids = await this.objectChildren(v.v).catch(() => []);
    const cls = typeName((await this.classInfo(await this.typeOf(v.v)).catch(() => ({ sig: '' }))).sig);
    const msg = kids.find(k => k.name === 'detailMessage')?.value;
    return msg && msg !== 'null' ? `${cls}: ${JSON.parse(msg)}` : cls || 'Exception';
  }

  // ---- running ----

  async resume() {
    this.frames.clear();
    this.refs.clear();
    await this.resumeVm();
    this.host.setState('running');
  }
  async pause() {
    await this.request(1, 8);
    const r = await this.request(1, 4);
    const threads = [];
    for (let n = r.i32(); n > 0; n--) threads.push(r.object());
    let thread = threads[0];
    for (const t of threads) {
      const name = (await this.request(11, 1, w => w.object(t))).str();
      if (name === 'main') { thread = t; break; }
    }
    this.thread = thread;
    this.host.setState('paused');
    this.host.emit({ type: 'paused', reason: 'pause', frames: await this.framesOf(thread) });
  }
  async step(kind) {
    const depth = kind === 'into' ? 0 : kind === 'out' ? 2 : 1;
    this.stepRequest = (await this.request(15, 1, w => {
      w.u8(EV.STEP).u8(SUSPEND_ALL).i32(2 + LIBRARY.length);
      w.u8(STEP_MOD).object(this.thread).i32(1).i32(depth); // by line
      w.u8(COUNT).i32(1);
      for (const p of LIBRARY) w.u8(CLASS_EXCLUDE).str(p);
    })).i32();
    await this.resume();
  }
  async runTo(file, line) {
    for (const [cls, info] of this.classes) {
      if (!info.file || path.resolve(info.file) !== path.resolve(file)) continue;
      const loc = await this.locationAt(cls, line);
      if (loc) { this.temp.push(await this.breakAt(loc)); break; }
    }
    await this.resume();
  }

  // ---- values ----

  ref(entry) { const id = this.next++; this.refs.set(id, entry); return id; }
  async typeOf(obj) { const r = await this.request(9, 1, w => w.object(obj)); r.u8(); return r.ref(); }
  async show(v, name) {
    const { tag } = v;
    const row = (value, type, ref = 0) => ({ name, value, type, ref });
    if (!OBJECT_TAGS.has(tag)) {
      if (tag === TAG.CHAR) return row(JSON.stringify(String.fromCharCode(v.v)).replace(/^"|"$/g, "'"), 'char');
      return row(String(v.v), typeName(String.fromCharCode(tag)));
    }
    if (isNull(v.v)) return row('null', '');
    if (tag === TAG.STRING) return row(JSON.stringify((await this.request(10, 1, w => w.object(v.v))).str()), 'String');
    const info = await this.classInfo(await this.typeOf(v.v));
    if (tag === TAG.ARRAY) {
      const len = (await this.request(13, 1, w => w.object(v.v))).i32();
      return row(`${typeName(info.sig).replace(/\[\]$/, `[${len}]`)}`, typeName(info.sig), len ? this.ref({ kind: 'array', id: v.v, sig: info.sig, len }) : 0);
    }
    if (BOXED.has(info.sig)) {
      const value = (await this.objectChildren(v.v)).find(k => k.name === 'value');
      if (value) return row(value.value, typeName(info.sig));
    }
    return row(typeName(info.sig), typeName(info.sig), this.ref({ kind: 'object', id: v.v }));
  }
  async scopes(frameId) {
    if (!this.frames.has(frameId)) throw new Error('That frame is gone');
    return [{ name: 'Locals', value: '', type: 'scope', ref: this.ref({ kind: 'locals', frameId }) }];
  }
  async children(ref) {
    const e = this.refs.get(ref);
    if (!e) return [];
    if (e.kind === 'locals') return (await this.locals(e.frameId)).map(l => l.row);
    if (e.kind === 'object') return this.objectChildren(e.id);
    const count = Math.min(e.len, ARRAY_MAX);
    const r = await this.request(13, 2, w => w.object(e.id).i32(0).i32(count));
    const tag = r.u8();
    const out = [];
    for (let i = r.i32(), k = 0; i > 0; i--, k++) {
      const v = OBJECT_TAGS.has(tag) ? r.value() : r.untagged(tag);
      out.push(await this.show(v, `[${k}]`));
    }
    if (e.len > count) out.push({ name: '…', value: `${e.len - count} more`, type: '', ref: 0 });
    return out;
  }
  // The variables in scope at the frame's line (and `this`), with what SetValues needs.
  async locals(frameId) {
    const f = this.frames.get(frameId);
    if (!f) throw new Error('That frame is gone');
    const { cls, method, index } = f.location;
    const at = BigInt('0x' + index);
    let vars = [];
    try {
      const r = await this.request(6, 2, w => w.ref(cls).method(method));
      r.i32();
      for (let n = r.i32(); n > 0; n--) {
        const v = { start: r.i64(), name: r.str(), sig: r.str(), len: r.i32(), slot: r.i32() };
        if (at >= v.start && at < v.start + BigInt(v.len)) vars.push(v);
      }
    } catch { vars = []; } // compiled without -g
    vars.sort((a, b) => a.slot - b.slot);
    const out = [];
    const info = await this.classInfo(cls);
    if (!((info.methods.get(method)?.mods ?? 0) & STATIC)) {
      const r = await this.request(16, 3, w => w.object(f.thread).frame(f.frame));
      out.push({ row: await this.show(r.value(), 'this') });
    }
    if (vars.length) {
      const r = await this.request(16, 1, w => { w.object(f.thread).frame(f.frame).i32(vars.length); for (const v of vars) w.i32(v.slot).u8(tagOfSig(v.sig)); });
      r.i32();
      for (const v of vars) {
        const val = r.value();
        out.push({ row: await this.show(val, v.name), slot: v.slot, sig: v.sig, frame: f });
      }
    }
    return out;
  }
  async objectChildren(obj) {
    const fields = [];
    for (let cls = await this.typeOf(obj); !isNull(cls);) {
      const r = await this.request(2, 4, w => w.ref(cls));
      for (let n = r.i32(); n > 0; n--) { const f = { id: r.field(), name: r.str(), sig: r.str(), mods: r.i32() }; if (!(f.mods & STATIC)) fields.push(f); }
      cls = (await this.request(3, 1, w => w.ref(cls)).catch(() => null))?.ref() ?? '0';
    }
    if (!fields.length) return [];
    const r = await this.request(9, 2, w => { w.object(obj).i32(fields.length); for (const f of fields) w.field(f.id); });
    r.i32();
    const out = [];
    for (const f of fields) out.push(await this.show(r.value(), f.name));
    this.fieldsOf ??= new Map();
    this.fieldsOf.set(obj, fields);
    return out;
  }
  // A variable, field or element: name(.field | [n])*, read from the frame's locals and `this`.
  async evaluate(expr, frameId) {
    const parts = /^\s*([A-Za-z_$][\w$]*)((?:\s*\.\s*[A-Za-z_$][\w$]*|\s*\[\s*\d+\s*\])*)\s*$/.exec(expr);
    if (!parts) throw new Error("Java's debugger shows variables and their fields: try a name like total, p.x or items[0]");
    if (typeof frameId !== 'number' || !this.frames.has(frameId)) throw new Error('Pause the program to read its variables');
    const locals = await this.locals(frameId);
    let row = locals.find(l => l.row.name === parts[1])?.row;
    if (!row) {
      const self = locals.find(l => l.row.name === 'this')?.row;
      if (self?.ref) row = (await this.children(self.ref)).find(k => k.name === parts[1]);
    }
    if (!row) throw new Error(`${parts[1]} isn't a variable here`);
    for (const step of parts[2].match(/\.\s*[A-Za-z_$][\w$]*|\[\s*\d+\s*\]/g) ?? []) {
      if (!row.ref) throw new Error(`${row.name} has no ${step.replace(/^\.\s*/, '')}`);
      const key = step.startsWith('.') ? step.replace(/^\.\s*/, '') : `[${/\d+/.exec(step)[0]}]`;
      const next = (await this.children(row.ref)).find(k => k.name === key);
      if (!next) throw new Error(`${row.name} has no ${key}`);
      row = next;
    }
    return { ...row, name: expr };
  }
  // Locals and fields of a primitive type or String take a new value.
  async setValue(ref, name, value) {
    const e = this.refs.get(ref);
    let sig, write;
    if (e?.kind === 'locals') {
      const l = (await this.locals(e.frameId)).find(x => x.row.name === name && x.slot !== undefined);
      if (!l) throw new Error(`${name} can't be changed here`);
      sig = l.sig;
      write = async (tag, v) => this.request(16, 2, w => w.object(l.frame.thread).frame(l.frame.frame).i32(1).i32(l.slot).value(tag, v));
    } else if (e?.kind === 'object') {
      await this.objectChildren(e.id);
      const f = this.fieldsOf.get(e.id)?.find(x => x.name === name);
      if (!f) throw new Error(`${name} can't be changed here`);
      sig = f.sig;
      write = async (tag, v) => this.request(9, 3, w => w.object(e.id).i32(1).field(f.id).untagged(tag, v));
    } else throw new Error(`${name} can't be changed here`);
    const tag = tagOfSig(sig);
    const text = String(value).trim();
    let v;
    if (sig === 'Ljava/lang/String;') {
      const s = text === 'null' ? null : JSON.parse(text.replace(/^'([\s\S]*)'$/, '"$1"'));
      v = s === null ? '0' : (await this.request(1, 11, w => w.str(s))).object();
    } else if (tag === TAG.BOOLEAN) {
      if (!/^(true|false)$/.test(text)) throw new Error('Type true or false');
      v = text === 'true' ? 1 : 0;
    } else if (tag === TAG.CHAR) {
      v = (/^'(.)'$/.exec(text)?.[1] ?? text).charCodeAt(0);
    } else if (OBJECT_TAGS.has(tag)) {
      throw new Error('Only numbers, true/false, characters and strings can be changed');
    } else {
      if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?[lLfFdD]?$/i.test(text)) throw new Error(`${text} isn't a number`);
      v = tag === TAG.LONG ? BigInt(text.replace(/[lL]$/, '')) : Number(text.replace(/[fFdD]$/, ''));
    }
    await write(tag, v);
    if (e.kind === 'locals') return (await this.locals(e.frameId)).find(x => x.row.name === name).row;
    return (await this.objectChildren(e.id)).find(k => k.name === name);
  }

  // ---- ending ----

  async disconnect() { /* killFirst: the manager kills the program, then close() lets go */ }
  close() {
    this.ended = true;
    this.client?.close();
  }
}

module.exports = { JavaBackend, typeName, packageOf };
