// Java Debug Wire Protocol client: the JVM's own debugger protocol (java -agentlib:jdwp=…), over a TCP socket.
// After a 14-byte handshake both sides send packets: length (4), id (4), flags (1), then a command set and command
// (2 bytes) for a command or an error code (2 bytes) for a reply. Numbers are big-endian. Object, class, method,
// field and frame IDs have sizes the VM states (IDSizes); here they are kept as hex strings.
const net = require('node:net');
const { EventEmitter } = require('node:events');

const HANDSHAKE = 'JDWP-Handshake';
const REPLY = 0x80;
const EVENT_SET = 64, COMPOSITE = 100;

// Value tags.
const TAG = { ARRAY: 91, BYTE: 66, CHAR: 67, OBJECT: 76, FLOAT: 70, DOUBLE: 68, INT: 73, LONG: 74, SHORT: 83, VOID: 86, BOOLEAN: 90, STRING: 115, THREAD: 116, GROUP: 103, LOADER: 108, CLASS: 99 };
const OBJECT_TAGS = new Set([TAG.ARRAY, TAG.OBJECT, TAG.STRING, TAG.THREAD, TAG.GROUP, TAG.LOADER, TAG.CLASS]);
// Event kinds.
const EV = { STEP: 1, BREAKPOINT: 2, EXCEPTION: 4, THREAD_START: 6, THREAD_DEATH: 7, CLASS_PREPARE: 8, CLASS_UNLOAD: 9, VM_START: 90, VM_DEATH: 99 };

// Some JDWP error codes, as words.
const ERRORS = { 10: 'invalid thread', 13: 'thread not suspended', 20: 'object was collected', 21: 'invalid class', 23: 'invalid method', 30: 'invalid frame', 32: 'type mismatch', 34: 'invalid slot', 35: 'duplicate', 41: 'absent information', 99: 'not implemented', 112: 'VM dead' };

class Writer {
  constructor(sizes) { this.parts = []; this.sizes = sizes; }
  u8(n) { this.parts.push(Buffer.from([n & 0xff])); return this; }
  i32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n); this.parts.push(b); return this; }
  i64(n) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n)); this.parts.push(b); return this; }
  str(s) { const b = Buffer.from(String(s), 'utf8'); this.i32(b.length); this.parts.push(b); return this; }
  id(hex, size) { const b = Buffer.alloc(size); Buffer.from(hex.padStart(size * 2, '0'), 'hex').copy(b); this.parts.push(b); return this; }
  object(hex) { return this.id(hex, this.sizes.object); }
  ref(hex) { return this.id(hex, this.sizes.ref); }
  method(hex) { return this.id(hex, this.sizes.method); }
  field(hex) { return this.id(hex, this.sizes.field); }
  frame(hex) { return this.id(hex, this.sizes.frame); }
  location(l) { return this.u8(l.tag).ref(l.cls).method(l.method).id(l.index, 8); }
  // A value tagged with its type (StackFrame.SetValues, ObjectReference.SetValues take untagged ones).
  value(tag, v) {
    this.u8(tag);
    return this.untagged(tag, v);
  }
  untagged(tag, v) {
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
  bytes() { return Buffer.concat(this.parts); }
}

class Reader {
  constructor(buf, sizes) { this.b = buf; this.i = 0; this.sizes = sizes; }
  u8() { return this.b[this.i++]; }
  i32() { const n = this.b.readInt32BE(this.i); this.i += 4; return n; }
  i64() { const n = this.b.readBigInt64BE(this.i); this.i += 8; return n; }
  str() { const n = this.i32(); const s = this.b.toString('utf8', this.i, this.i + n); this.i += n; return s; }
  id(size) { const s = this.b.toString('hex', this.i, this.i + size); this.i += size; return s; }
  object() { return this.id(this.sizes.object); }
  ref() { return this.id(this.sizes.ref); }
  method() { return this.id(this.sizes.method); }
  field() { return this.id(this.sizes.field); }
  frame() { return this.id(this.sizes.frame); }
  location() { return { tag: this.u8(), cls: this.ref(), method: this.method(), index: this.id(8) }; }
  value() { return this.untagged(this.u8()); }
  untagged(tag) {
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
const isNull = id => !id || /^0*$/.test(id);

// Emits 'event' ({ suspendPolicy, events: [{ kind, requestId, thread, location, … }] }) and 'close'.
class JdwpClient extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.sizes = { field: 8, method: 8, object: 8, ref: 8, frame: 8 };
    this.buf = Buffer.alloc(0);
    this.shaken = false;
    socket.on('data', c => this.data(c));
    socket.on('error', () => this.shutdown());
    socket.on('close', () => this.shutdown());
  }
  // The handshake, then the VM's ID sizes, which every later packet depends on.
  async start() {
    const shaken = new Promise((resolve, reject) => { this.onShake = resolve; this.onShakeFail = reject; });
    this.socket.write(HANDSHAKE);
    await shaken;
    const r = await this.cmd(1, 7);
    this.sizes = { field: r.i32(), method: r.i32(), object: r.i32(), ref: r.i32(), frame: r.i32() };
  }
  data(chunk) {
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
  packet(p) {
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
  events(r) {
    const suspendPolicy = r.u8();
    const events = [];
    for (let n = r.i32(); n > 0; n--) {
      const kind = r.u8(), requestId = r.i32();
      const e = { kind, requestId };
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
  cmd(set, command, build) {
    if (this.closed) return Promise.reject(new Error('The Java debugger connection is closed'));
    const w = new Writer(this.sizes);
    build?.(w);
    const data = w.bytes();
    const id = this.nextId++;
    const head = Buffer.alloc(11);
    head.writeInt32BE(11 + data.length, 0);
    head.writeInt32BE(id, 4);
    head[8] = 0; head[9] = set; head[10] = command;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(Buffer.concat([head, data]));
    });
  }
  shutdown() {
    if (this.closed) return;
    this.closed = true;
    this.onShakeFail?.(new Error('The Java debugger connection closed'));
    for (const p of this.pending.values()) p.reject(new Error('The Java debugger connection is closed'));
    this.pending.clear();
    this.emit('close');
  }
  close() {
    this.shutdown();
    this.socket.destroy();
  }
}

const connect = (port, host = '127.0.0.1') => new Promise((resolve, reject) => {
  const s = net.connect({ host, port });
  s.once('connect', () => { s.removeAllListeners('error'); resolve(s); });
  s.once('error', reject);
});

module.exports = { JdwpClient, Writer, Reader, TAG, OBJECT_TAGS, EV, isNull, connect };
