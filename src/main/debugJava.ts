// The DebugManager's Java backend: the JVM's own debugger, JDWP (jdwp.js). prepare() compiles the file with javac -g
// (so locals have names) into build/java; the manager starts `java -agentlib:jdwp=…,suspend=y` and owns its stdio;
// connect() attaches, sets the breakpoints as their classes load and lets the program go.
// JDWP has no expression evaluator, so javaexpr.ts computes expressions from the variables read here; it also
// decides breakpoint conditions, hit counts and logpoints when a breakpoint fires (the VM is resumed if it shouldn't stop).
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import { execFile } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';
import { JdwpClient, TAG, OBJECT_TAGS, EV, isNull, connect } from './jdwp';
import type { JdwpEvent, JdwpEvents, Location, TaggedValue, Writer, Reader } from './jdwp';
import type { Backend, Bp, DebugFrame, DebugValue, Host, Launch } from './debugTypes';
import { parse, evaluate as evalExpr, fromRow, show as showVal, hitMatches, formatLog, checkJavaBp } from './javaexpr';
import type { Resolver, Val } from './javaexpr';

interface MethodInfo { name: string; sig: string; mods: number }
interface ClassInfo { sig: string; file: string | null; methods: Map<string, MethodInfo> }
interface LineEntry { index: bigint; line: number }
interface FrameInfo { thread: string; frame: string; location: Location }
interface FieldInfo { id: string; name: string; sig: string; mods: number }
type RefEntry = { kind: 'locals'; frameId: number } | { kind: 'object'; id: string } | { kind: 'array'; id: string; sig: string; len: number };
interface LocalVar { start: bigint; name: string; sig: string; len: number; slot: number }
interface Local { row: DebugValue; slot?: number; sig?: string; frame?: FrameInfo }

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

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); });
});
// "Lcom/x/Main$Inner;" → "Main$Inner"; "[I" → "int[]".
const PRIM: Record<string, string> = { I: 'int', J: 'long', D: 'double', F: 'float', Z: 'boolean', C: 'char', S: 'short', B: 'byte', V: 'void' };
function typeName(sig: string | undefined): string {
  if (!sig) return '';
  if (sig[0] === '[') return typeName(sig.slice(1)) + '[]';
  if (sig[0] === 'L') return sig.slice(1, -1).split('/').pop() ?? '';
  return PRIM[sig] ?? sig;
}
const tagOfSig = (sig: string) => (sig[0] === '[' ? TAG.ARRAY : sig[0] === 'L' ? TAG.OBJECT : sig.charCodeAt(0));
// The package a source file declares ("" for none), so the class name and source folder follow from it.
const packageOf = (text: string): string => /^\s*package\s+([\w.]+)\s*;/m.exec(text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''))?.[1] ?? '';

class JavaBackend implements Backend {
  host: Host;
  cmd: string;
  javac: string;
  baseEnv: NodeJS.ProcessEnv;
  client: JdwpClient | null = null;
  port = 0;
  thread: string | null = null;                    // the thread the program is paused in
  classes = new Map<string, ClassInfo>();          // class id → its signature, source file (abs or null) and methods
  lineTables = new Map<string, LineEntry[]>();     // `${cls}:${method}` → its line table
  byFile = new Map<string, { requests: number[]; lines: number[] }>(); // abs → breakpoint requests and the verified lines
  temp: number[] = [];                             // one-off breakpoint requests (stop on entry, run to line), cleared at the next stop
  stepRequest: number | null = null;
  excRequest: number | null = null;
  frames = new Map<number, FrameInfo>();           // frame number → where it is
  refs = new Map<number, RefEntry>();
  next = 1;
  queue: Promise<unknown> = Promise.resolve();
  killFirst = true;                                // a suspended VM resumes if the debugger lets go: stop kills, then closes
  ended = false;
  srcRoot = '';
  mainClass = '';
  out = '';
  entrySet = false;
  why?: Map<number, string>;
  fieldsOf?: Map<string, FieldInfo[]>;
  special = new Map<number, Bp>();                 // breakpoint request → its breakpoint, when it has a condition, hit count or log message
  hits = new Map<number, number>();                // breakpoint request → times its condition held

  constructor(host: Host, { java, javac, env }: { java: string; javac: string; env?: NodeJS.ProcessEnv }) {
    this.host = host;
    this.cmd = java;
    this.javac = javac;
    this.baseEnv = env || process.env;
  }

  env(): NodeJS.ProcessEnv { return { ...this.baseEnv }; }

  async prepare(): Promise<Launch> {
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
    await new Promise<void>((resolve, reject) => execFile(this.javac, args, { cwd: this.srcRoot, env: this.env(), windowsHide: true, timeout: BUILD_MS }, (e: ExecFileException | null, out: string, err: string) => {
      const msg = [out, err].filter(Boolean).join('');
      if (msg) host.output('stderr', msg);
      if (!e) resolve();
      else if (e.code === 'ENOENT') reject(Object.assign(new Error(`The Java compiler wasn't found (${this.javac})`), { hint: 'install-jdk' }));
      else reject(Object.assign(new Error('The build failed: the Output shows why'), { hint: 'build-failed' }));
    }));
    this.port = await freePort();
    return { args: this.launchArgs() };
  }
  launchArgs(): string[] {
    return [`-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,quiet=y,address=127.0.0.1:${this.port}`,
      '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', '-cp', this.out, this.mainClass];
  }

  stderr(text: string) { return text; }
  exited() { this.ended = true; }

  async dial(): Promise<net.Socket> {
    const end = Date.now() + DIAL_MS;
    for (;;) {
      if (!this.host.alive() || this.ended) throw new Error('The debug session ended');
      const s = await connect(this.port).catch(() => null);
      if (s) return s;
      if (Date.now() > end) throw new Error(`Could not reach the Java debugger on port ${this.port}`);
      await new Promise(r => setTimeout(r, 100));
    }
  }

  async connect(): Promise<void> {
    const { host } = this;
    const sock = await this.dial();
    if (!host.alive()) { sock.destroy(); return; }
    const c = this.client = new JdwpClient(sock);
    c.on('warn', (e: unknown) => host.warn(e));
    c.on('event', (e: JdwpEvents) => { this.onEvents(e).catch((err: unknown) => host.warn(err)); });
    await host.within(c.start(), CONNECT_MS, 'connecting to Java');
    // Each class of the program, as it loads: its breakpoints go in before any of its code runs.
    await this.request(15, 1, (w: Writer) => {
      w.u8(EV.CLASS_PREPARE).u8(SUSPEND_ALL).i32(LIBRARY.length);
      for (const p of LIBRARY) w.u8(CLASS_EXCLUDE).str(p);
    });
    await this.setExceptions(host.exceptions());
    await this.request(1, 9); // resume
    host.setState('running');
  }

  request(set: number, cmd: number, build?: (w: Writer) => void): Promise<Reader> {
    if (!this.client) return Promise.reject(new Error('The debugger is not connected'));
    return this.client.cmd(set, cmd, build);
  }
  resumeVm(): Promise<Reader> { return this.request(1, 9); }

  async onEvents({ suspendPolicy, events }: JdwpEvents): Promise<void> {
    let stop: JdwpEvent | null = null;
    for (const e of events) {
      if (e.kind === EV.CLASS_PREPARE) await this.prepared(e.type!).catch((err: unknown) => this.host.warn(err));
      else if (e.kind === EV.VM_DEATH) this.ended = true;
      else if (e.kind === EV.BREAKPOINT || e.kind === EV.STEP || e.kind === EV.EXCEPTION) stop ??= e;
    }
    if (stop && (stop.kind !== EV.BREAKPOINT || await this.shouldStop(stop))) { await this.stopped(stop); return; }
    if (suspendPolicy === SUSPEND_ALL && !this.ended) {
      this.frames.clear();
      this.refs.clear();
      await this.resumeVm().catch(() => { /* the VM ended */ });
    }
  }
  // A plain breakpoint always stops. One with a condition stops when it is true (a condition that can't be worked
  // out stops too, with the reason in the Output), then counts toward its hit count; a logpoint prints and goes on.
  async shouldStop(e: JdwpEvent): Promise<boolean> {
    const bp = this.special.get(e.requestId);
    if (!bp) return true;
    const top = (await this.framesOf(e.thread!))[0];
    const r = this.resolver(top.id);
    const cond = (bp.condition || '').trim().replace(/;$/, '');
    if (cond) {
      try {
        const v = await evalExpr(parse(cond), r);
        if (v.type !== 'boolean') throw new Error(`it gave ${showVal(v)}, not true or false`);
        if (!v.value) return false;
      } catch (err) {
        this.host.output('console', `Breakpoint condition on line ${top.line} (${cond}) couldn't be worked out: ${(err as Error).message}\n`);
        return true;
      }
    }
    const hits = (this.hits.get(e.requestId) ?? 0) + 1;
    this.hits.set(e.requestId, hits);
    if (bp.hitCondition?.trim() && !hitMatches(bp.hitCondition, hits)) return false;
    if (bp.logMessage) { this.host.output('console', (await formatLog(bp.logMessage, r)) + '\n'); return false; }
    return true;
  }

  // ---- classes, lines and breakpoints ----

  async classInfo(cls: string): Promise<ClassInfo> {
    let info = this.classes.get(cls);
    if (info) return info;
    const sig = (await this.request(2, 1, (w: Writer) => w.ref(cls))).str();
    info = { sig, file: null, methods: new Map() };
    try {
      const source = (await this.request(2, 7, (w: Writer) => w.ref(cls))).str();
      const pkgDir = sig.slice(1, -1).split('/').slice(0, -1);
      const abs = path.join(this.srcRoot, ...pkgDir, source);
      if (fs.existsSync(abs)) info.file = abs;
    } catch { /* no source file attribute */ }
    const r = await this.request(2, 5, (w: Writer) => w.ref(cls));
    for (let n = r.i32(); n > 0; n--) { const id = r.method(); info.methods.set(id, { name: r.str(), sig: r.str(), mods: r.i32() }); }
    this.classes.set(cls, info);
    return info;
  }
  async lineTable(cls: string, method: string): Promise<LineEntry[]> {
    const key = `${cls}:${method}`;
    if (this.lineTables.has(key)) return this.lineTables.get(key)!;
    let lines: LineEntry[] = [];
    try {
      const r = await this.request(6, 1, (w: Writer) => w.ref(cls).method(method));
      r.i64(); r.i64(); // start and end
      for (let n = r.i32(); n > 0; n--) lines.push({ index: r.i64(), line: r.i32() });
      lines.sort((a, b) => (a.index < b.index ? -1 : 1));
    } catch { lines = []; } // native or abstract
    this.lineTables.set(key, lines);
    return lines;
  }
  async lineOf(loc: Location): Promise<number> {
    const lines = await this.lineTable(loc.cls, loc.method);
    const at = BigInt('0x' + loc.index);
    let line = 0;
    for (const l of lines) { if (l.index > at) break; line = l.line; }
    return line;
  }
  // The first code at `line` in a class: { tag, cls, method, index } or null.
  async locationAt(cls: string, line: number): Promise<Location | null> {
    const info = await this.classInfo(cls);
    for (const id of info.methods.keys()) {
      const hit = (await this.lineTable(cls, id)).find(l => l.line === line);
      if (hit) return { tag: 1, cls, method: id, index: hit.index.toString(16).padStart(16, '0') };
    }
    return null;
  }
  async prepared(cls: string): Promise<void> {
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
  async breakAt(loc: Location, why = 'breakpoint'): Promise<number> {
    const id = (await this.request(15, 1, (w: Writer) => w.u8(EV.BREAKPOINT).u8(SUSPEND_ALL).i32(1).u8(LOCATION_ONLY).location(loc))).i32();
    (this.why ??= new Map()).set(id, why);
    return id;
  }
  clear(kind: number, id: number) { return this.request(15, 2, (w: Writer) => w.u8(kind).i32(id)).catch(() => { /* already gone */ }); }

  setBreakpoints(file: string, bps: Bp[]): Promise<void> {
    const run = this.queue.then(() => this.applyBreakpoints(file, bps));
    this.queue = run.catch(() => {});
    return run;
  }
  // A condition or log message that doesn't parse leaves its breakpoint unverified.
  async applyBreakpoints(file: string, bps: Bp[]): Promise<void> {
    if (!this.client) return;
    const old = this.byFile.get(file);
    for (const id of old?.requests ?? []) { await this.clear(EV.BREAKPOINT, id); this.special.delete(id); this.hits.delete(id); }
    const entry: { requests: number[]; lines: number[] } = { requests: [], lines: [] };
    this.byFile.set(file, entry);
    const classes = [...this.classes].filter(([, i]) => i.file && path.resolve(i.file) === path.resolve(file)).map(([id]) => id);
    for (const bp of bps) {
      if (!bp || bp.enabled === false || !(bp.line >= 1) || checkJavaBp(bp)) continue;
      for (const cls of classes) {
        const loc = await this.locationAt(cls, bp.line);
        if (!loc) continue;
        const id = await this.breakAt(loc);
        if (bp.condition?.trim() || bp.hitCondition?.trim() || bp.logMessage) this.special.set(id, bp);
        entry.requests.push(id);
        entry.lines.push(bp.line);
        break;
      }
    }
    const rel = this.host.rel(file);
    if (rel !== null) this.host.emit({ type: 'breakpoints', file: rel, lines: [...new Set(entry.lines)].sort((a, b) => a - b) });
  }

  async setExceptions(mode: string): Promise<void> {
    if (!this.client) return;
    if (this.excRequest) { await this.clear(EV.EXCEPTION, this.excRequest); this.excRequest = null; }
    if (mode !== 'all' && mode !== 'uncaught') return;
    const all = mode === 'all';
    this.excRequest = (await this.request(15, 1, (w: Writer) => {
      w.u8(EV.EXCEPTION).u8(SUSPEND_ALL).i32(all ? 1 + LIBRARY.length : 1);
      w.u8(EXCEPTION_ONLY).ref('0').u8(all ? 1 : 0).u8(1);
      if (all) for (const p of LIBRARY) w.u8(CLASS_EXCLUDE).str(p);
    })).i32();
  }

  // ---- stopping ----

  async stopped(e: JdwpEvent): Promise<void> {
    const { host } = this;
    this.thread = e.thread!;
    if (this.stepRequest) { await this.clear(EV.STEP, this.stepRequest); this.stepRequest = null; }
    let reason = e.kind === EV.STEP ? 'step' : e.kind === EV.EXCEPTION ? 'exception' : this.why?.get(e.requestId) ?? 'breakpoint';
    if (e.kind === EV.BREAKPOINT && this.temp.includes(e.requestId) && reason !== 'entry') reason = 'step'; // run to line
    for (const id of this.temp) await this.clear(EV.BREAKPOINT, id);
    this.temp = [];
    const ev: { type: string; reason: string; frames: DebugFrame[]; exception?: string } = { type: 'paused', reason, frames: await this.framesOf(e.thread!) };
    if (e.kind === EV.EXCEPTION) ev.exception = await this.describe(e.exception!);
    host.setState('paused');
    host.emit(ev);
  }
  async framesOf(thread: string): Promise<DebugFrame[]> {
    this.frames.clear();
    this.refs.clear();
    const r = await this.request(11, 6, (w: Writer) => w.object(thread).i32(0).i32(-1));
    const raw: { frame: string; location: Location }[] = [];
    for (let n = r.i32(); n > 0; n--) raw.push({ frame: r.frame(), location: r.location() });
    const out: DebugFrame[] = [];
    for (const f of raw.slice(0, 100)) {
      const info = await this.classInfo(f.location.cls);
      const m = info.methods.get(f.location.method);
      const id = this.next++;
      this.frames.set(id, { thread, ...f });
      out.push({ id, name: `${typeName(info.sig)}.${m?.name ?? '?'}`, file: info.file ? this.host.rel(info.file) : null, line: await this.lineOf(f.location), col: 1 });
    }
    return out;
  }
  async describe(v: TaggedValue): Promise<string> {
    const kids = await this.objectChildren(v.v as string).catch(() => [] as DebugValue[]);
    const cls = typeName((await this.classInfo(await this.typeOf(v.v as string)).catch(() => ({ sig: '' }))).sig);
    const msg = kids.find(k => k.name === 'detailMessage')?.value;
    return msg && msg !== 'null' ? `${cls}: ${JSON.parse(msg)}` : cls || 'Exception';
  }

  // ---- running ----

  async resume(): Promise<void> {
    this.frames.clear();
    this.refs.clear();
    await this.resumeVm();
    this.host.setState('running');
  }
  async pause(): Promise<void> {
    await this.request(1, 8);
    const r = await this.request(1, 4);
    const threads: string[] = [];
    for (let n = r.i32(); n > 0; n--) threads.push(r.object());
    let thread = threads[0];
    for (const t of threads) {
      const name = (await this.request(11, 1, (w: Writer) => w.object(t))).str();
      if (name === 'main') { thread = t; break; }
    }
    this.thread = thread;
    this.host.setState('paused');
    this.host.emit({ type: 'paused', reason: 'pause', frames: await this.framesOf(thread) });
  }
  async step(kind: string): Promise<void> {
    const depth = kind === 'into' ? 0 : kind === 'out' ? 2 : 1;
    this.stepRequest = (await this.request(15, 1, (w: Writer) => {
      w.u8(EV.STEP).u8(SUSPEND_ALL).i32(2 + LIBRARY.length);
      w.u8(STEP_MOD).object(this.thread!).i32(1).i32(depth); // by line
      w.u8(COUNT).i32(1);
      for (const p of LIBRARY) w.u8(CLASS_EXCLUDE).str(p);
    })).i32();
    await this.resume();
  }
  async runTo(file: string, line: number): Promise<void> {
    for (const [cls, info] of this.classes) {
      if (!info.file || path.resolve(info.file) !== path.resolve(file)) continue;
      const loc = await this.locationAt(cls, line);
      if (loc) { this.temp.push(await this.breakAt(loc)); break; }
    }
    await this.resume();
  }

  // ---- values ----

  ref(entry: RefEntry): number { const id = this.next++; this.refs.set(id, entry); return id; }
  async typeOf(obj: string): Promise<string> { const r = await this.request(9, 1, (w: Writer) => w.object(obj)); r.u8(); return r.ref(); }
  async show(v: TaggedValue, name: string): Promise<DebugValue> {
    const { tag } = v;
    const obj = v.v as string;
    const row = (value: string, type: string, ref = 0): DebugValue => ({ name, value, type, ref });
    if (!OBJECT_TAGS.has(tag)) {
      if (tag === TAG.CHAR) return row(JSON.stringify(String.fromCharCode(v.v as number)).replace(/^"|"$/g, "'"), 'char');
      return row(String(v.v), typeName(String.fromCharCode(tag)));
    }
    if (isNull(obj)) return row('null', '');
    if (tag === TAG.STRING) return row(JSON.stringify((await this.request(10, 1, (w: Writer) => w.object(obj))).str()), 'String');
    const info = await this.classInfo(await this.typeOf(obj));
    if (tag === TAG.ARRAY) {
      const len = (await this.request(13, 1, (w: Writer) => w.object(obj))).i32();
      return row(`${typeName(info.sig).replace(/\[\]$/, `[${len}]`)}`, typeName(info.sig), len ? this.ref({ kind: 'array', id: obj, sig: info.sig, len }) : 0);
    }
    if (BOXED.has(info.sig)) {
      const value = (await this.objectChildren(obj)).find(k => k.name === 'value');
      if (value) return row(value.value, typeName(info.sig));
    }
    return row(typeName(info.sig), typeName(info.sig), this.ref({ kind: 'object', id: obj }));
  }
  async scopes(frameId: number): Promise<DebugValue[]> {
    if (!this.frames.has(frameId)) throw new Error('That frame is gone');
    return [{ name: 'Locals', value: '', type: 'scope', ref: this.ref({ kind: 'locals', frameId }) }];
  }
  async children(ref: number): Promise<DebugValue[]> {
    const e = this.refs.get(ref);
    if (!e) return [];
    if (e.kind === 'locals') return (await this.locals(e.frameId)).map(l => l.row);
    if (e.kind === 'object') return this.objectChildren(e.id);
    const count = Math.min(e.len, ARRAY_MAX);
    const r = await this.request(13, 2, (w: Writer) => w.object(e.id).i32(0).i32(count));
    const tag = r.u8();
    const out: DebugValue[] = [];
    for (let i = r.i32(), k = 0; i > 0; i--, k++) {
      const v = OBJECT_TAGS.has(tag) ? r.value() : r.untagged(tag);
      out.push(await this.show(v, `[${k}]`));
    }
    if (e.len > count) out.push({ name: '…', value: `${e.len - count} more`, type: '', ref: 0 });
    return out;
  }
  // The variables in scope at the frame's line (and `this`), with what SetValues needs.
  async locals(frameId: number): Promise<Local[]> {
    const f = this.frames.get(frameId);
    if (!f) throw new Error('That frame is gone');
    const { cls, method, index } = f.location;
    const at = BigInt('0x' + index);
    let vars: LocalVar[] = [];
    try {
      const r = await this.request(6, 2, (w: Writer) => w.ref(cls).method(method));
      r.i32();
      for (let n = r.i32(); n > 0; n--) {
        const v: LocalVar = { start: r.i64(), name: r.str(), sig: r.str(), len: r.i32(), slot: r.i32() };
        if (at >= v.start && at < v.start + BigInt(v.len)) vars.push(v);
      }
    } catch { vars = []; } // compiled without -g
    vars.sort((a, b) => a.slot - b.slot);
    const out: Local[] = [];
    const info = await this.classInfo(cls);
    if (!((info.methods.get(method)?.mods ?? 0) & STATIC)) {
      const r = await this.request(16, 3, (w: Writer) => w.object(f.thread).frame(f.frame));
      out.push({ row: await this.show(r.value(), 'this') });
    }
    if (vars.length) {
      const r = await this.request(16, 1, (w: Writer) => { w.object(f.thread).frame(f.frame).i32(vars.length); for (const v of vars) w.i32(v.slot).u8(tagOfSig(v.sig)); });
      r.i32();
      for (const v of vars) {
        const val = r.value();
        out.push({ row: await this.show(val, v.name), slot: v.slot, sig: v.sig, frame: f });
      }
    }
    return out;
  }
  async objectChildren(obj: string): Promise<DebugValue[]> {
    const fields: FieldInfo[] = [];
    for (let cls = await this.typeOf(obj); !isNull(cls);) {
      const r = await this.request(2, 4, (w: Writer) => w.ref(cls));
      for (let n = r.i32(); n > 0; n--) { const f: FieldInfo = { id: r.field(), name: r.str(), sig: r.str(), mods: r.i32() }; if (!(f.mods & STATIC)) fields.push(f); }
      cls = (await this.request(3, 1, (w: Writer) => w.ref(cls)).catch(() => null))?.ref() ?? '0';
    }
    if (!fields.length) return [];
    const r = await this.request(9, 2, (w: Writer) => { w.object(obj).i32(fields.length); for (const f of fields) w.field(f.id); });
    r.i32();
    const out: DebugValue[] = [];
    for (const f of fields) out.push(await this.show(r.value(), f.name));
    this.fieldsOf ??= new Map();
    this.fieldsOf.set(obj, fields);
    return out;
  }
  // An expression (javaexpr.ts) over the frame's locals and `this`. A plain variable, field or element keeps its
  // row, so it can still be expanded.
  async evaluate(expr: string, frameId: number | undefined, _context?: string): Promise<DebugValue> {
    const node = parse(expr);
    if (typeof frameId !== 'number' || !this.frames.has(frameId)) throw new Error('Pause the program to read its variables');
    const v = await evalExpr(node, this.resolver(frameId));
    return v.row ? { ...v.row, name: expr } : { name: expr, value: showVal(v), type: v.type, ref: 0 };
  }
  // How javaexpr reads the paused program: locals (then fields of `this`), fields, and array elements by index.
  resolver(frameId: number): Resolver {
    let locals: Promise<Local[]> | null = null;
    const rowOf = async (of: Val, name: string): Promise<DebugValue | undefined> => (of.row?.ref ? (await this.children(of.row.ref)).find(k => k.name === name) : undefined);
    return {
      name: async id => {
        const all = await (locals ??= this.locals(frameId));
        let row = all.find(l => l.row.name === id)?.row;
        const self = all.find(l => l.row.name === 'this');
        if (!row && self) row = await rowOf(fromRow(self.row), id);
        if (!row) throw new Error(`${id} isn't a variable here`);
        return fromRow(row);
      },
      field: async (of, name) => {
        const row = await rowOf(of, name);
        if (!row) throw new Error(`${of.row?.name ?? showVal(of)} has no field ${name}`);
        return fromRow(row);
      },
      element: async (of, index) => {
        const e = of.row?.ref ? this.refs.get(of.row.ref) : undefined;
        if (e?.kind !== 'array' || index < 0 || index >= e.len) throw new Error(`ArrayIndexOutOfBoundsException: index ${index}, length ${e?.kind === 'array' ? e.len : 0}`);
        const r = await this.request(13, 2, (w: Writer) => w.object(e.id).i32(index).i32(1));
        const tag = r.u8();
        r.i32();
        return fromRow(await this.show(OBJECT_TAGS.has(tag) ? r.value() : r.untagged(tag), `[${index}]`));
      },
    };
  }
  // Locals and fields of a primitive type or String take a new value.
  async setValue(ref: number, name: string, value: string): Promise<DebugValue> {
    const e = this.refs.get(ref);
    let sig: string;
    let write: (tag: number, v: unknown) => Promise<Reader>;
    if (e?.kind === 'locals') {
      const l = (await this.locals(e.frameId)).find(x => x.row.name === name && x.slot !== undefined);
      if (!l) throw new Error(`${name} can't be changed here`);
      sig = l.sig!;
      write = async (tag, v) => this.request(16, 2, (w: Writer) => w.object(l.frame!.thread).frame(l.frame!.frame).i32(1).i32(l.slot!).value(tag, v));
    } else if (e?.kind === 'object') {
      await this.objectChildren(e.id);
      const f = this.fieldsOf!.get(e.id)?.find(x => x.name === name);
      if (!f) throw new Error(`${name} can't be changed here`);
      sig = f.sig;
      write = async (tag, v) => this.request(9, 3, (w: Writer) => w.object(e.id).i32(1).field(f.id).untagged(tag, v));
    } else throw new Error(`${name} can't be changed here`);
    const tag = tagOfSig(sig);
    const text = String(value).trim();
    let v: unknown;
    if (sig === 'Ljava/lang/String;') {
      const s = text === 'null' ? null : JSON.parse(text.replace(/^'([\s\S]*)'$/, '"$1"'));
      v = s === null ? '0' : (await this.request(1, 11, (w: Writer) => w.str(s))).object();
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
    if (e.kind === 'locals') return (await this.locals(e.frameId)).find(x => x.row.name === name)!.row;
    return (await this.objectChildren(e.id)).find(k => k.name === name)!;
  }

  // ---- ending ----

  async disconnect(): Promise<void> { /* killFirst: the manager kills the program, then close() lets go */ }
  close(): void {
    this.ended = true;
    this.client?.close();
  }
}

export { JavaBackend, typeName, packageOf };
