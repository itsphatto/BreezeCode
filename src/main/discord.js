// Discord Rich Presence over Discord's local IPC socket (no dependencies).
// Each frame is: op (int32 LE) · length (int32 LE) · JSON body.
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

function encode(op, data) {
  const body = Buffer.from(JSON.stringify(data));
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

// Discord's frames are small JSON messages; anything bigger (or a negative length) is not Discord talking.
const MAX_FRAME = 1024 * 1024;

// Turns a byte stream into whole frames, however the chunks are cut. Throws on a length no frame can have.
class FrameReader {
  constructor(onFrame) { this.buf = Buffer.alloc(0); this.onFrame = onFrame; }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 8) {
      const len = this.buf.readInt32LE(4);
      if (len < 0 || len > MAX_FRAME) {
        this.buf = Buffer.alloc(0);
        throw new Error('Discord sent a message Breeze could not read');
      }
      if (this.buf.length < 8 + len) return;
      const op = this.buf.readInt32LE(0);
      const body = this.buf.subarray(8, 8 + len).toString('utf8');
      this.buf = this.buf.subarray(8 + len);
      let data = null;
      try { data = JSON.parse(body); } catch { /* ignore a malformed frame */ }
      this.onFrame(op, data);
    }
  }
}

// Discord listens on discord-ipc-0 … discord-ipc-9 (the first free one).
function ipcPaths(platform = process.platform, env = process.env) {
  const names = Array.from({ length: 10 }, (_, i) => `discord-ipc-${i}`);
  if (platform === 'win32') return names.map(n => `\\\\?\\pipe\\${n}`);
  const base = env.XDG_RUNTIME_DIR || env.TMPDIR || env.TMP || env.TEMP || '/tmp';
  // Snap and Flatpak builds of Discord put the socket one folder deeper.
  const dirs = [base, path.posix.join(base, 'snap.discord'), path.posix.join(base, 'app', 'com.discordapp.Discord')];
  return dirs.flatMap(d => names.map(n => path.posix.join(d, n)));
}

function tryConnect(p, timeout) {
  return new Promise((res, rej) => {
    const sock = net.createConnection(p);
    const t = setTimeout(() => { sock.destroy(); rej(new Error('timeout')); }, timeout);
    sock.once('connect', () => { clearTimeout(t); res(sock); });
    sock.once('error', err => { clearTimeout(t); rej(err); });
  });
}

class DiscordRpc {
  constructor(clientId, { paths = ipcPaths(), pid = process.pid, timeout = 4000 } = {}) {
    this.clientId = String(clientId);
    this.paths = paths;
    this.pid = pid;
    this.timeout = timeout;
    this.sock = null;
    this.pending = new Map(); // nonce -> { res, rej }
    this.onClose = null;
  }
  get connected() { return !!this.sock; }

  async connect() {
    if (this.sock) return this.user;
    let sock = null;
    for (const p of this.paths) {
      sock = await tryConnect(p, 800).catch(() => null);
      if (sock) break;
    }
    if (!sock) throw new Error("Discord isn't running on this computer. Open the Discord app, then try again.");
    return new Promise((res, rej) => {
      const fail = err => { this.drop(); rej(err); };
      const t = setTimeout(() => fail(new Error('Discord did not answer')), this.timeout);
      const reader = new FrameReader((op, data) => {
        if (op === OP.PING) { sock.write(encode(OP.PONG, data)); return; }
        if (op === OP.CLOSE) { clearTimeout(t); fail(new Error(data?.message || 'Discord closed the connection')); return; }
        if (data?.evt === 'READY') { clearTimeout(t); this.user = data.data?.user ?? null; res(this.user); return; }
        if (data?.evt === 'ERROR' && !data.nonce) { clearTimeout(t); fail(new Error(data.data?.message || 'Discord refused the connection')); return; }
        const wait = data?.nonce && this.pending.get(data.nonce);
        if (!wait) return;
        this.pending.delete(data.nonce);
        if (data.evt === 'ERROR') wait.rej(new Error(data.data?.message || 'Discord refused the request'));
        else wait.res(data.data);
      });
      this.sock = sock;
      // A stream that can't be framed can't be trusted any further: drop the connection.
      sock.on('data', c => {
        try { reader.push(c); } catch (err) { clearTimeout(t); fail(err); }
      });
      sock.on('error', () => { /* 'close' follows */ });
      sock.on('close', () => { clearTimeout(t); this.drop(); rej(new Error('Discord closed the connection')); });
      sock.write(encode(OP.HANDSHAKE, { v: 1, client_id: this.clientId }));
    });
  }

  request(cmd, args) {
    if (!this.sock) return Promise.reject(new Error('Not connected to Discord'));
    const nonce = crypto.randomUUID();
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(nonce); rej(new Error('Discord did not answer')); }, this.timeout);
      this.pending.set(nonce, { res: v => { clearTimeout(t); res(v); }, rej: e => { clearTimeout(t); rej(e); } });
      this.sock.write(encode(OP.FRAME, { cmd, args, nonce }));
    });
  }

  // `activity` null clears the presence.
  setActivity(a) {
    if (!a) return this.request('SET_ACTIVITY', { pid: this.pid });
    const activity = { details: a.details, state: a.state, instance: false };
    if (a.startTimestamp) activity.timestamps = { start: a.startTimestamp };
    if (a.largeImageKey) activity.assets = { large_image: a.largeImageKey, large_text: a.largeImageText || undefined };
    if (a.largeImageKey && a.smallImageKey) Object.assign(activity.assets, { small_image: a.smallImageKey, small_text: a.smallImageText || undefined });
    return this.request('SET_ACTIVITY', { pid: this.pid, activity });
  }

  drop() {
    const was = this.sock;
    this.sock = null;
    for (const w of this.pending.values()) w.rej(new Error('Discord closed the connection'));
    this.pending.clear();
    if (was) { was.destroy(); this.onClose?.(); }
  }
  close() {
    if (this.sock) { try { this.sock.write(encode(OP.CLOSE, {})); } catch { /* already gone */ } }
    this.drop();
  }
}

// Rich Presence for the app: one connection to Discord, and the status it should show.
// - Discord often ignores a new handshake soon after a disconnect, so turning presence off keeps the
//   connection and turning it back on reuses it; it closes once presence has stayed off for `idleMs`.
// - Discord allows about 5 status updates per 20 seconds, so showing and hiding share one throttle and only
//   the latest wanted state is ever sent: a fast on/off burst can't have its final "off" rate-limited away.
// - A set() still connecting when presence is turned off shows nothing; an old socket closing late never
//   drops a newer one.
class DiscordPresence {
  constructor(makeRpc, { idleMs = 60000, gapMs = 4000, onError = () => {} } = {}) {
    this.makeRpc = makeRpc;
    this.idleMs = idleMs;
    this.gapMs = gapMs;
    this.onError = onError;
    this.rpc = null;
    this.connecting = null;
    this.idleTimer = null;
    this.epoch = 0;         // bumped by every clear()
    this.wanted = null;     // the activity to show, or null for hidden
    this.sent = undefined;  // what Discord was last told (JSON, or null), so repeats are skipped
    this.sentAt = -Infinity;
    this.flushTimer = null;
  }
  get connected() { return !!this.rpc?.connected; }
  connect() {
    clearTimeout(this.idleTimer);
    if (this.connecting) return this.connecting;
    if (this.rpc?.connected) return Promise.resolve(this.rpc.user);
    const rpc = this.makeRpc();
    rpc.onClose = () => { if (this.rpc === rpc) this.rpc = null; };
    this.rpc = rpc;
    this.sent = undefined; // a new connection starts with nothing shown
    const pending = rpc.connect();
    this.connecting = pending;
    pending.finally(() => { if (this.connecting === pending) this.connecting = null; }).catch(() => {});
    return pending;
  }
  // Shows `activity` (connecting first if needed). Resolves with the Discord user.
  async set(activity) {
    const epoch = this.epoch;
    const user = await this.connect();
    if (epoch === this.epoch) {
      this.wanted = activity;
      this.flush();
    }
    return user;
  }
  // Hides the status and keeps the connection for a quick "on" until it has idled.
  clear() {
    this.epoch++;
    this.wanted = null;
    this.flush();
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), this.idleMs);
    this.idleTimer.unref?.();
  }
  flush() {
    clearTimeout(this.flushTimer);
    if (!this.rpc?.connected) return;
    const next = this.wanted ? JSON.stringify(this.wanted) : null;
    if (next === this.sent) return;
    const wait = this.sentAt + this.gapMs - Date.now();
    if (wait > 0) {
      this.flushTimer = setTimeout(() => this.flush(), wait);
      this.flushTimer.unref?.();
      return;
    }
    this.sentAt = Date.now();
    this.sent = next;
    this.rpc.setActivity(this.wanted).catch(err => { this.sent = undefined; this.onError(err); });
  }
  close() {
    clearTimeout(this.idleTimer);
    clearTimeout(this.flushTimer);
    const rpc = this.rpc;
    this.rpc = null;
    this.connecting = null;
    rpc?.close();
  }
}

module.exports = { encode, FrameReader, ipcPaths, DiscordRpc, DiscordPresence, OP };
