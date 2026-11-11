// The text engine: one Rust sidecar (runtime/breeze-engine) that holds large documents so the page doesn't.
// Requests and replies are JSON lines; every reply names its request's id. The process starts on the first
// request and starts again on the next one after it dies. Emits 'down' once each time it exits on its own.
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const fs = require('node:fs');

const NOT_BUILT = "The Breeze engine isn't built. Run npm run build:engine";

class Engine extends EventEmitter {
  constructor({ exe, journalDir }) {
    super();
    this.exe = exe;
    this.journalDir = journalDir;
    this.child = null;   // the current ChildProcess, or null; public so a test can kill it
    this.stderr = '';    // the end of the engine's stderr, for a debugger only
    this.nextId = 1;
    this.session = null; // { pending: Map(id → { resolve, reject }), parts } for the current child
  }

  get running() { return this.child !== null; }

  request(op, args = {}) {
    let s;
    try { s = this.start(); } catch (e) { return Promise.reject(e); }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      s.pending.set(id, { resolve, reject });
      // id and op go last so an argument can't override them. JSON.stringify never emits a raw newline.
      this.child.stdin.write(JSON.stringify({ ...args, id, op }) + '\n');
    });
  }

  start() {
    if (this.child) return this.session;
    if (!fs.existsSync(this.exe)) throw new Error(NOT_BUILT);
    let child;
    try {
      child = spawn(this.exe, ['--journal-dir', this.journalDir], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      throw e?.code === 'ENOENT' ? new Error(NOT_BUILT) : e;
    }
    // Each process gets its own session, so a late event from a dead one can't touch the next one's requests.
    const s = { pending: new Map(), parts: [] };
    this.child = child;
    this.session = s;
    // A multi-byte character can be split between two chunks; the decoder holds the partial one back.
    const dec = new StringDecoder('utf8');
    child.stdout.on('data', b => {
      // A reply is one line and can be tens of MB, so the newline is looked for only in the piece just decoded,
      // and the pieces are joined once, when the line ends. (Re-scanning everything received would be quadratic.)
      let piece = dec.write(b);
      for (let i = piece.indexOf('\n'); i !== -1; i = piece.indexOf('\n')) {
        s.parts.push(piece.slice(0, i));
        const line = s.parts.join('');
        s.parts = [];
        piece = piece.slice(i + 1);
        this.reply(s, line);
      }
      if (piece) s.parts.push(piece);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', t => { this.stderr = (this.stderr + t).slice(-2000); });
    // Writing to a process that just died raises EPIPE here; the close event rejects what was waiting.
    child.stdin.on('error', () => {});
    const gone = e => {
      if (this.child !== child) return; // stop() already let go of it
      this.child = null;
      this.session = null;
      // A spawn that failed after returning (a blocked exe: EACCES, EPERM) keeps its "spawn ..." message, so the page
      // can tell the engine can't start from the engine stopping.
      const fromSpawn = e && (String(e.syscall ?? '').startsWith('spawn') || String(e.message ?? '').startsWith('spawn'));
      const why = e?.code === 'ENOENT' ? new Error(NOT_BUILT) : fromSpawn ? new Error(e.message) : new Error('The engine stopped');
      for (const p of s.pending.values()) p.reject(why);
      s.pending.clear();
      this.emit('down');
    };
    child.on('error', gone);
    // 'close', not 'exit': it comes after stdout has been read to its end, so a reply written just before the exit isn't lost.
    child.on('close', () => gone());
    return s;
  }

  // One reply line: settle the request it names. A line that isn't JSON, or names nobody, is ignored.
  reply(s, line) {
    let reply;
    try { reply = JSON.parse(line); } catch { return; }
    const p = reply && s.pending.get(reply.id);
    if (!p) return;
    s.pending.delete(reply.id);
    if (reply.ok) {
      const { id, ok, ...rest } = reply;
      p.resolve(rest);
    } else {
      p.reject(new Error(reply.error));
    }
  }

  stop() {
    const child = this.child, s = this.session;
    if (!child) return;
    this.child = null;
    this.session = null;
    for (const p of s.pending.values()) p.reject(new Error('The engine stopped'));
    s.pending.clear();
    child.kill();
  }
}

module.exports = { Engine, NOT_BUILT };
