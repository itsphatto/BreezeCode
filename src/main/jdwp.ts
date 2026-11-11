// Java Debug Wire Protocol client: the JVM's own debugger protocol (java -agentlib:jdwp=…), over a TCP socket.
// After a 14-byte handshake both sides send packets: length (4), id (4), flags (1), then a command set and command
// (2 bytes) for a command or an error code (2 bytes) for a reply. Numbers are big-endian. Object, class, method,
// field and frame IDs have sizes the VM states (IDSizes); here they are kept as hex strings.
import * as net from 'node:net';
import type { Socket } from 'node:net';
import { EventEmitter } from 'node:events';

export interface Sizes { field: number; method: number; object: number; ref: number; frame: number }
export interface Location { tag: number; cls: string; method: string; index: string }
// A value read off the wire: its tag and the decoded value (a hex id for objects, a bigint for longs).
export interface TaggedValue { tag: number; v: number | bigint | boolean | string | undefined }
export interface JdwpEvent {
  kind: number; requestId: number;
  thread?: string; location?: Location; exception?: TaggedValue; catchLocation?: Location;
  refTag?: number; type?: string; signature?: string; status?: number;
}
export interface JdwpEvents { suspendPolicy: number; events: JdwpEvent[] }

const HANDSHAKE = 'JDWP-Handshake';
const REPLY = 0x80;
const EVENT_SET = 64, COMPOSITE = 100;

// Value tags.
const TAG = { ARRAY: 91, BYTE: 66, CHAR: 67, OBJECT: 76, FLOAT: 70, DOUBLE: 68, INT: 73, LONG: 74, SHORT: 83, VOID: 86, BOOLEAN: 90, STRING: 115, THREAD: 116, GROUP: 103, LOADER: 108, CLASS: 99 };
const OBJECT_TAGS = new Set([TAG.ARRAY, TAG.OBJECT, TAG.STRING, TAG.THREAD, TAG.GROUP, TAG.LOADER, TAG.CLASS]);
// Event kinds.
const EV = { STEP: 1, BREAKPOINT: 2, EXCEPTION: 4, THREAD_START: 6, THREAD_DEATH: 7, CLASS_PREPARE: 8, CLASS_UNLOAD: 9, VM_START: 90, VM_DEATH: 99 };

// Some JDWP error codes, as words.
const ERRORS: Record<number, string> = { 10: 'invalid thread', 13: 'thread not suspended', 20: 'object was collected', 21: 'invalid class', 23: 'invalid method', 30: 'invalid frame', 32: 'type mismatch', 34: 'invalid slot', 35: 'duplicate', 41: 'absent information', 99: 'not implemented', 112: 'VM dead' };

class Writer {
  parts: Buffer[] = [];
  sizes: Sizes;
  constructor(sizes: Sizes) { this.sizes = sizes; }
  u8(n: number) { this.parts.push(Buffer.from([n & 0xff])); return this; }
  i32(n: number) { const b = Buffer.alloc(4); b.writeInt32BE(n); this.parts.push(b); return this; }
  i64(n: number | bigint | string) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n)); this.parts.push(b); return this; }
  str(s: unknown) { const b = Buffer.from(String(s), 'utf8'); this.i32(b.length); this.parts.push(b); return this; }
  id(hex: string, size: number) { const b = Buffer.alloc(size); Buffer.from(hex.padStart(size * 2, '0'), 'hex').copy(b); this.parts.push(b); return this; }
  object(hex: string) { return this.id(hex, this.sizes.object); }
  ref(hex: string) { return this.id(hex, this.sizes.ref); }
  method(hex: string) { return this.id(hex, this.sizes.method); }
  field(hex: string) { return this.id(hex, this.sizes.field); }
  frame(hex: string) { return this.id(hex, this.sizes.frame); }
  location(l: Location) { return this.u8(l.tag).ref(l.cls).method(l.method).id(l.index, 8); }
  // A value tagged with its type (StackFrame.SetValues, ObjectReference.SetValues take untagged ones).
  value(tag: number, v: any): this {
    this.u8(tag);
    return this.untagged(tag, v);
  }
  untagged(tag: number, v: any): this {
    switch (tag) {
      case TAG.BOOLEAN: case TAG.BYTE: return this.u8(Number(v));
      case TAG.CHAR: case TAG.SHORT: { const b = Buffer.alloc(2); b.writeUInt16BE(Number(v) & 0xffff); this.parts.push(b); return this; }
      case TAG.INT: return this.i32(Number(v));
      case TAG.LONG: return this.i64(v);
      case TAG.FLOAT: { const b = Buffer.alloc(4); b.writeFloatBE(Number(v)); this.parts.push(b); return this; }
      case TAG.DOUBLE: { const b = Buffer.alloc(8); b.writeDoubleBE(Number(v)); this.parts.push(b); return this; }
      default: return this.object(v);
    }
  }
  bytes(): Buffer { return Buffer.concat(this.parts); }
}

class Reader {
  b: Buffer;
  i = 0;
  sizes: Sizes;
  constructor(buf: Buffer, sizes: Sizes) { this.b = buf; this.sizes = sizes; }
  u8() { return this.b[this.i++]; }
  i32() { const n = this.b.readInt32BE(this.i); this.i += 4; return n; }
  i64() { const n = this.b.readBigInt64BE(this.i); this.i += 8; return n; }
  str() { const n = this.i32(); const s = this.b.toString('utf8', this.i, this.i + n); this.i += n; return s; }
  id(size: number) { const s = this.b.toString('hex', this.i, this.i + size); this.i += size; return s; }
  object() { return this.id(this.sizes.object); }
  ref() { return this.id(this.sizes.ref); }
  method() { return this.id(this.sizes.method); }
  field() { return this.id(this.sizes.field); }
  frame() { return this.id(this.sizes.frame); }
  location(): Location { return { tag: this.u8(), cls: this.ref(), method: this.method(), index: this.id(8) }; }
  value(): TaggedValue { return this.untagged(this.u8()); }
  untagged(tag: number): TaggedValue {
    switch (tag) {
      case TAG.BOOLEAN: return { tag, v: this.u8() !== 0 };
      case TAG.BYTE: return { tag, v: (this.u8() << 24) >> 24 };
      case TAG.CHAR: { const v = this.b.readUInt16BE(this.i); this.i += 2; return { tag, v }; }
      case TAG.SHORT: { const v = this.b.readInt16BE(this.i); this.i += 2; return { tag, v }; }
      case TAG.INT: return { tag, v: this.i32() };
      case TAG.LONG: return { tag, v: this.i64() };
      case TAG.FLOAT: { const v = this.b.readFloatBE(this.i); this.i += 4; return { tag, v }; }
      case TAG.DOUBLE: { const v = this.b.readDoubleBE(this.i); this.i += 8; return { tag, v }; }
      case TAG.VOID: return { tag, v: undefined };
      default: return { tag, v: this.object() };
    }
  }
}
const isNull = (id: string | null | undefined) => !id || /^0*$/.test(id);

// Emits 'event' ({ suspendPolicy, events: [{ kind, requestId, thread, location, … }] }) and 'close'.
class JdwpClient extends EventEmitter {
  socket: Socket;
  nextId = 1;
  pending = new Map<number, { resolve: (r: Reader) => void; reject: (err: Error) => void }>();
  closed = false;
  sizes: Sizes = { field: 8, method: 8, object: 8, ref: 8, frame: 8 };
  buf: Buffer = Buffer.alloc(0);
  shaken = false;
  onShake?: () => void;
  onShakeFail?: (err: Error) => void;
  constructor(socket: Socket) {
    super();
    this.socket = socket;
    socket.on('data', (c: Buffer) => this.data(c));
    socket.on('error', () => this.shutdown());
    socket.on('close', () => this.shutdown());
  }
  // The handshake, then the VM's ID sizes, which every later packet depends on.
  async start(): Promise<void> {
    const shaken = new Promise<void>((resolve, reject) => { this.onShake = resolve; this.onShakeFail = reject; });
    this.socket.write(HANDSHAKE);
    await shaken;
    const r = await this.cmd(1, 7);
    this.sizes = { field: r.i32(), method: r.i32(), object: r.i32(), ref: r.i32(), frame: r.i32() };
  }
  data(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (!this.shaken) {
      if (this.buf.length < HANDSHAKE.length) return;
      if (this.buf.toString('ascii', 0, HANDSHAKE.length) !== HANDSHAKE) { this.onShakeFail?.(new Error('Not a Java debugger')); this.close(); return; }
      this.buf = this.buf.subarray(HANDSHAKE.length);
      this.shaken = true;
      this.onShake?.();
    }
    while (this.buf.length >= 11) {
      const len = this.buf.readInt32BE(0);
      if (this.buf.length < len) return;
      const pkt = this.buf.subarray(0, len);
      this.buf = this.buf.subarray(len);
      try { this.packet(pkt); } catch (e) { this.emit('warn', e); }
    }
  }
  packet(p: Buffer): void {
    const id = p.readInt32BE(4), flags = p[8];
    const body = p.subarray(11);
    if (flags & REPLY) {
      const w = this.pending.get(id);
      if (!w) return;
      this.pending.delete(id);
      const err = p.readUInt16BE(9);
      if (err) w.reject(Object.assign(new Error(`Java debugger: ${ERRORS[err] ?? `error ${err}`}`), { code: err }));
      else w.resolve(new Reader(body, this.sizes));
      return;
    }
    if (p[9] === EVENT_SET && p[10] === COMPOSITE) this.emit('event', this.events(new Reader(body, this.sizes)));
  }
  events(r: Reader): JdwpEvents {
    const suspendPolicy = r.u8();
    const events: JdwpEvent[] = [];
    for (let n = r.i32(); n > 0; n--) {
      const kind = r.u8(), requestId = r.i32();
      const e: JdwpEvent = { kind, requestId };
      switch (kind) {
        case EV.VM_START: case EV.THREAD_START: case EV.THREAD_DEATH: e.thread = r.object(); break;
        case EV.STEP: case EV.BREAKPOINT: e.thread = r.object(); e.location = r.location(); break;
        case EV.EXCEPTION: e.thread = r.object(); e.location = r.location(); e.exception = r.value(); e.catchLocation = r.location(); break;
        case EV.CLASS_PREPARE: e.thread = r.object(); e.refTag = r.u8(); e.type = r.ref(); e.signature = r.str(); e.status = r.i32(); break;
        case EV.CLASS_UNLOAD: e.signature = r.str(); break;
        case EV.VM_DEATH: break;
        default: events.push(e); return { suspendPolicy, events }; // one we never asked for: the rest can't be read
      }
      events.push(e);
    }
    return { suspendPolicy, events };
  }
  // Sends a command; resolves with a Reader over the reply's data. `build(w)` writes the command's data.
  cmd(set: number, command: number, build?: (w: Writer) => void): Promise<Reader> {
    if (this.closed) return Promise.reject(new Error('The Java debugger connection is closed'));
    const w = new Writer(this.sizes);
    build?.(w);
    const data = w.bytes();
    const id = this.nextId++;
    const head = Buffer.alloc(11);
    head.writeInt32BE(11 + data.length, 0);
    head.writeInt32BE(id, 4);
    head[8] = 0; head[9] = set; head[10] = command;
    return new Promise<Reader>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(Buffer.concat([head, data]));
    });
  }
  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.onShakeFail?.(new Error('The Java debugger connection closed'));
    for (const p of this.pending.values()) p.reject(new Error('The Java debugger connection is closed'));
    this.pending.clear();
    this.emit('close');
  }
  close(): void {
    this.shutdown();
    this.socket.destroy();
  }
}

const connect = (port: number, host = '127.0.0.1') => new Promise<Socket>((resolve, reject) => {
  const s = net.connect({ host, port });
  s.once('connect', () => { s.removeAllListeners('error'); resolve(s); });
  s.once('error', reject);
});

export { JdwpClient, Writer, Reader, TAG, OBJECT_TAGS, EV, isNull, connect };
