// Debug Adapter Protocol client: talks to a debug adapter (debugpy for Python) over a duplex stream, a TCP socket.
// Messages are JSON with a Content-Length header, like the language servers' (lsp.js), but shaped
// { seq, type: 'request' | 'response' | 'event', ... }: a response names its request by `request_seq`.
import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';

// The parts of DAP responses that Breeze reads.
export interface DapSource { path?: string }
export interface DapFrame { id: number; name: string; line: number; column: number; source?: DapSource }
export interface DapScope { name: string; variablesReference?: number }
export interface DapVariable { name: string; value: string; type?: string; variablesReference?: number }
export interface DapBreakpoint { id?: number; line?: number; verified?: boolean; message?: string }
export interface DapThread { id: number; name?: string }
// An event the adapter pushes: its name and body.
export interface DapEvent { event?: string; body?: any }

// A message in either direction; the fields past `type` depend on which.
interface DapMessage { seq?: number; type?: string; command?: string; event?: string; body?: any; request_seq?: number; success?: boolean; message?: string; arguments?: unknown }

function frame(msg: DapMessage): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

// Splits a byte stream into messages. Content-Length counts bytes, so the stream stays bytes until a whole body
// is in (a multi-byte character may be cut between chunks); a message may arrive in pieces or several in one chunk.
class DapReader {
  buf: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): DapMessage[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: DapMessage[] = [];
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
  stream: Duplex;
  seq = 1;
  pending = new Map<number, { resolve: (body: any) => void; reject: (err: Error) => void }>(); // seq → its promise
  closed = false;
  constructor(stream: Duplex) {
    super();
    this.stream = stream;
    const reader = new DapReader();
    // One bad message or a throwing listener must not drop the rest of the chunk (a lost response leaves its request
    // pending) or escape a stream handler (an uncaught exception in the main process).
    stream.on('data', (c: Buffer) => {
      for (const m of reader.push(c)) {
        try { this.receive(m); } catch (e) { this.emit('warn', e); } // 'warn', not 'error': nothing need listen
      }
    });
    stream.on('error', () => this.shutdown());
    stream.on('end', () => this.shutdown());
    stream.on('close', () => this.shutdown());
  }
  // Resolves with the response's body; rejects with its message when the adapter says it failed.
  request<T = any>(command: string, args?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The debug adapter connection is closed'));
    const seq = this.seq++;
    return new Promise((resolve, reject) => {
      const data = frame({ seq, type: 'request', command, arguments: args }); // may throw: nothing registered yet
      this.pending.set(seq, { resolve, reject });
      this.stream.write(data);
    });
  }
  receive(m: DapMessage | null): void {
    if (!m || typeof m !== 'object') return; // valid JSON, but not a message
    if (m.type === 'event') { this.emit('event', { event: m.event, body: m.body }); return; }
    if (m.type !== 'response') return; // reverse requests (runInTerminal, startDebugging) are not handled yet
    const p = this.pending.get(m.request_seq!);
    if (!p) return;
    this.pending.delete(m.request_seq!);
    if (m.success) p.resolve(m.body ?? {}); else p.reject(new Error(m.message || `${m.command ?? 'request'} failed`));
  }
  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error('The debug adapter connection is closed'));
    this.pending.clear();
    this.emit('close');
  }
  close(): void {
    this.shutdown();
    this.stream.destroy();
  }
}

export { frame, DapReader, DapClient };
