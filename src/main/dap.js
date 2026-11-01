// Debug Adapter Protocol client: talks to a debug adapter (debugpy for Python) over a duplex stream, a TCP socket.
// Messages are JSON with a Content-Length header, like the language servers' (lsp.js), but shaped
// { seq, type: 'request' | 'response' | 'event', ... }: a response names its request by `request_seq`.
const { EventEmitter } = require('node:events');

function frame(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

// Splits a byte stream into messages. Content-Length counts bytes, so the stream stays bytes until a whole body
// is in (a multi-byte character may be cut between chunks); a message may arrive in pieces or several in one chunk.
class DapReader {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    for (;;) {
      const end = this.buf.indexOf('\r\n\r\n');
      if (end === -1) return out;
      const len = Number(/content-length:\s*(\d+)/i.exec(this.buf.subarray(0, end).toString('ascii'))?.[1]);
      if (!Number.isFinite(len)) { this.buf = this.buf.subarray(end + 4); continue; } // garbage before a header
      if (this.buf.length < end + 4 + len) return out;
      const body = this.buf.subarray(end + 4, end + 4 + len).toString('utf8');
      this.buf = this.buf.subarray(end + 4 + len);
      try { out.push(JSON.parse(body)); } catch { /* not JSON: skip it */ }
    }
  }
}

// Emits 'event' ({ event, body }) for the adapter's events, 'warn' (an Error) when handling a message threw, and 'close' once, when the stream ends or close() is called.
class DapClient extends EventEmitter {
  constructor(stream) {
    super();
    this.stream = stream;
    this.seq = 1;
    this.pending = new Map(); // seq → { resolve, reject }
    this.closed = false;
    const reader = new DapReader();
    // One bad message or a throwing listener must not drop the rest of the chunk (a lost response leaves its request
    // pending) or escape a stream handler (an uncaught exception in the main process).
    stream.on('data', c => {
      for (const m of reader.push(c)) {
        try { this.receive(m); } catch (e) { this.emit('warn', e); } // 'warn', not 'error': nothing need listen
      }
    });
    stream.on('error', () => this.shutdown());
    stream.on('end', () => this.shutdown());
    stream.on('close', () => this.shutdown());
  }
  // Resolves with the response's body; rejects with its message when the adapter says it failed.
  request(command, args) {
    if (this.closed) return Promise.reject(new Error('The debug adapter connection is closed'));
    const seq = this.seq++;
    return new Promise((resolve, reject) => {
      const data = frame({ seq, type: 'request', command, arguments: args }); // may throw: nothing registered yet
      this.pending.set(seq, { resolve, reject });
      this.stream.write(data);
    });
  }
  receive(m) {
    if (!m || typeof m !== 'object') return; // valid JSON, but not a message
    if (m.type === 'event') { this.emit('event', { event: m.event, body: m.body }); return; }
    if (m.type !== 'response') return; // reverse requests (runInTerminal, startDebugging) are not handled yet
    const p = this.pending.get(m.request_seq);
    if (!p) return;
    this.pending.delete(m.request_seq);
    if (m.success) p.resolve(m.body ?? {}); else p.reject(new Error(m.message || `${m.command ?? 'request'} failed`));
  }
  shutdown() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error('The debug adapter connection is closed'));
    this.pending.clear();
    this.emit('close');
  }
  close() {
    this.shutdown();
    this.stream.destroy();
  }
}

module.exports = { frame, DapReader, DapClient };
