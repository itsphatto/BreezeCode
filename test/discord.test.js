const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { encode, FrameReader, ipcPaths, DiscordRpc, DiscordPresence } = require('../src/main/discord');

test('encode writes op and length as little-endian int32 before the JSON', () => {
  const buf = encode(1, { a: 'é' });
  assert.equal(buf.readInt32LE(0), 1);
  const body = Buffer.from(JSON.stringify({ a: 'é' }));
  assert.equal(buf.readInt32LE(4), body.length);
  assert.deepEqual(buf.subarray(8), body);
});

test('FrameReader joins split chunks and splits joined ones', () => {
  const got = [];
  const r = new FrameReader((op, data) => got.push([op, data]));
  const both = Buffer.concat([encode(1, { n: 1 }), encode(3, { n: 2 })]);
  r.push(both.subarray(0, 5));
  r.push(both.subarray(5, 20));
  r.push(both.subarray(20));
  assert.deepEqual(got, [[1, { n: 1 }], [3, { n: 2 }]]);
});

test('FrameReader refuses a negative or huge length instead of looping or buffering forever', () => {
  for (const len of [-8, -1, 2 ** 30]) {
    const r = new FrameReader(() => assert.fail('no frame should come out'));
    const head = Buffer.alloc(8);
    head.writeInt32LE(1, 0);
    head.writeInt32LE(len, 4);
    assert.throws(() => r.push(head), /could not read/, String(len));
  }
});

test('ipcPaths: Windows named pipes, else the runtime folder', () => {
  assert.equal(ipcPaths('win32', {})[0], '\\\\?\\pipe\\discord-ipc-0');
  assert.equal(ipcPaths('win32', {}).length, 10);
  assert.equal(ipcPaths('linux', { XDG_RUNTIME_DIR: '/run/user/1000' })[0], '/run/user/1000/discord-ipc-0');
});

// A fake Discord client: answers the handshake with READY and records every command.
function fakeDiscord(pipe) {
  const seen = [];
  const server = net.createServer(sock => {
    const reader = new FrameReader((op, data) => {
      seen.push({ op, data });
      if (op === 0) sock.write(encode(1, { cmd: 'DISPATCH', evt: 'READY', data: { user: { username: 'tester' } } }));
      else if (op === 1) sock.write(encode(1, { cmd: data.cmd, nonce: data.nonce, data: {} }));
    });
    sock.on('data', c => reader.push(c));
  });
  return new Promise(res => server.listen(pipe, () => res({ server, seen })));
}
const pipeName = () => (process.platform === 'win32'
  ? `\\\\?\\pipe\\breeze-test-${process.pid}-${Date.now()}`
  : path.join(os.tmpdir(), `breeze-test-${process.pid}-${Date.now()}.sock`));

test('DiscordRpc handshakes with the client id, sets and clears the activity', async () => {
  const pipe = pipeName();
  const { server, seen } = await fakeDiscord(pipe);
  const rpc = new DiscordRpc('123456789', { paths: [pipe], pid: 42 });
  const user = await rpc.connect();
  assert.equal(user.username, 'tester');
  await rpc.setActivity({ details: 'Editing app.js', state: 'my-project', startTimestamp: 1000 });
  await rpc.setActivity({ details: 'Editing App.java', largeImageKey: 'https://x/java.png', largeImageText: 'Java', smallImageKey: 'breeze', smallImageText: 'Breeze Code' });
  await rpc.setActivity(null);
  rpc.close();
  server.close();
  assert.deepEqual(seen[0], { op: 0, data: { v: 1, client_id: '123456789' } });
  assert.equal(seen[1].data.cmd, 'SET_ACTIVITY');
  assert.equal(seen[1].data.args.pid, 42);
  assert.equal(seen[1].data.args.activity.details, 'Editing app.js');
  assert.deepEqual(seen[1].data.args.activity.timestamps, { start: 1000 });
  assert.equal(seen[1].data.args.activity.assets, undefined);
  assert.deepEqual(seen[2].data.args.activity.assets, { large_image: 'https://x/java.png', large_text: 'Java', small_image: 'breeze', small_text: 'Breeze Code' });
  assert.equal(seen[3].data.args.activity, undefined);
});

test('DiscordRpc explains when Discord is not running', async () => {
  const rpc = new DiscordRpc('1', { paths: [pipeName()] });
  await assert.rejects(rpc.connect(), /Discord isn't running/);
});

test('DiscordRpc drops a connection that sends an unreadable frame', async () => {
  const pipe = pipeName();
  const server = net.createServer(sock => sock.once('data', () => {
    const head = Buffer.alloc(8);
    head.writeInt32LE(1, 0);
    head.writeInt32LE(-8, 4);
    sock.write(head);
  }));
  await new Promise(res => server.listen(pipe, res));
  const rpc = new DiscordRpc('1', { paths: [pipe] });
  let closed = false;
  rpc.onClose = () => { closed = true; };
  await assert.rejects(rpc.connect(), /could not read/);
  assert.equal(rpc.connected, false);
  assert.equal(closed, true);
  server.close();
});

// A slower fake Discord for toggle races: READY and the clearing SET_ACTIVITY can be held back, and every
// connection and command is recorded with the connection it came on.
function slowDiscord(pipe, { readyMs = 0, clearMs = 0 } = {}) {
  const log = { connections: 0, open: 0, frames: [] };
  const server = net.createServer(sock => {
    const id = ++log.connections;
    log.open++;
    sock.on('close', () => { log.open--; });
    sock.on('error', () => {});
    const reader = new FrameReader((op, data) => {
      log.frames.push({ id, op, data });
      if (op === 0) setTimeout(() => sock.write(encode(1, { cmd: 'DISPATCH', evt: 'READY', data: { user: { username: `user${id}` } } })), readyMs);
      else if (op === 1) setTimeout(() => sock.write(encode(1, { cmd: data.cmd, nonce: data.nonce, data: {} })), data.args?.activity ? 0 : clearMs);
    });
    sock.on('data', c => { try { reader.push(c); } catch { sock.destroy(); } });
  });
  return new Promise(res => server.listen(pipe, () => res({ server, log })));
}
const tick = ms => new Promise(r => setTimeout(r, ms));

// What the fake Discord was last told to show on any connection: the activity's details, or null for hidden.
const lastShown = log => {
  const sets = log.frames.filter(f => f.op === 1 && f.data.cmd === 'SET_ACTIVITY');
  return sets.length ? (sets.at(-1).data.args.activity?.details ?? null) : undefined;
};
const presence = (pipe, opts) => new DiscordPresence(() => new DiscordRpc('1', { paths: [pipe] }), { gapMs: 0, idleMs: 60000, ...opts });

test('DiscordPresence: a second "on" while connecting shares the one connection', async () => {
  const pipe = pipeName();
  const { server, log } = await slowDiscord(pipe, { readyMs: 150 });
  const p = presence(pipe);
  const [a, b] = await Promise.all([p.set({ details: 'one' }), p.set({ details: 'two' })]);
  assert.equal(a.username, 'user1');
  assert.equal(b.username, 'user1');
  await tick(30);
  assert.equal(log.connections, 1);
  assert.equal(lastShown(log), 'two');
  p.close();
  server.close();
});

test('DiscordPresence: "off" while connecting shows nothing, and the connection is kept for the next "on"', async () => {
  const pipe = pipeName();
  const { server, log } = await slowDiscord(pipe, { readyMs: 150 });
  const p = presence(pipe);
  const on = p.set({ details: 'should never show' });
  await tick(40);
  p.clear();
  await on;
  await tick(30);
  assert.notEqual(lastShown(log), 'should never show');
  assert.equal(p.connected, true);
  await p.set({ details: 'back on' });
  await tick(30);
  assert.equal(log.connections, 1);   // reused, no second handshake
  assert.equal(lastShown(log), 'back on');
  p.close();
  server.close();
});

test('DiscordPresence: off then on reuses the connection instead of handshaking again', async () => {
  const pipe = pipeName();
  const { server, log } = await slowDiscord(pipe);
  const p = presence(pipe);
  for (let i = 0; i < 5; i++) {
    await p.set({ details: `on ${i}` });
    p.clear();
  }
  await p.set({ details: 'final' });
  await tick(30);
  assert.equal(log.connections, 1);
  assert.equal(lastShown(log), 'final');
  p.close();
  server.close();
});

test('DiscordPresence: a rapid burst under the rate limit ends in the last requested state', async () => {
  const pipe = pipeName();
  const { server, log } = await slowDiscord(pipe, { readyMs: 30 });
  const p = presence(pipe, { gapMs: 120 });
  for (const endOn of [false, true]) {
    for (let i = 0; i < 8; i++) {
      if (i % 2 === 0) p.set({ details: `burst ${i}` }).catch(() => {});
      else p.clear();
      await tick(10);
    }
    if (endOn) p.set({ details: 'last' }).catch(() => {});
    await tick(400);
    assert.equal(lastShown(log), endOn ? 'last' : null, `burst ending ${endOn ? 'on' : 'off'}`);
  }
  // Throttled: far fewer updates reached Discord than were requested.
  assert.ok(log.frames.filter(f => f.op === 1).length <= 8);
  assert.equal(log.connections, 1);
  p.close();
  server.close();
});

test('DiscordPresence: closes the connection once presence has stayed off, and reconnects on the next "on"', async () => {
  const pipe = pipeName();
  const { server, log } = await slowDiscord(pipe);
  const p = presence(pipe, { idleMs: 80 });
  await p.set({ details: 'hi' });
  p.clear();
  await tick(150);
  assert.equal(p.connected, false);
  assert.equal(log.open, 0);
  await p.set({ details: 'again' });
  await tick(30);
  assert.equal(log.connections, 2);
  assert.equal(lastShown(log), 'again');
  p.close();
  server.close();
});
