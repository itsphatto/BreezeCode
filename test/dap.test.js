const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Duplex } = require('node:stream');
const { DapReader, DapClient, frame } = require('../src/main/dap');

// Two ends of a connection: what `client` writes arrives on `adapter.in`, what the test writes to `adapter.out` is read by the client.
function pair() {
  const toAdapter = new PassThrough();
  const toClient = new PassThrough();
  const stream = Duplex.from({ readable: toClient, writable: toAdapter });
  return { stream, adapter: { in: toAdapter, out: toClient } };
}
const tick = () => new Promise(r => setImmediate(r));
// The next framed message the client wrote; messages that came in the same chunk are kept for the next call.
const queues = new WeakMap();
const nextMessage = async s => {
  if (!queues.has(s)) queues.set(s, { reader: new DapReader(), msgs: [] });
  const q = queues.get(s);
  while (!q.msgs.length) { const c = s.read(); if (c) q.msgs.push(...q.reader.push(c)); else await tick(); }
  return q.msgs.shift();
};

test('DapReader: a message split across three chunks', () => {
  const r = new DapReader();
  const buf = frame({ seq: 1, type: 'event', event: 'initialized' });
  assert.deepEqual(r.push(buf.subarray(0, 8)), []);   // part of the header
  assert.deepEqual(r.push(buf.subarray(8, 30)), []);  // rest of the header, part of the body
  assert.deepEqual(r.push(buf.subarray(30)), [{ seq: 1, type: 'event', event: 'initialized' }]);
});

test('DapReader: two messages in one chunk', () => {
  const r = new DapReader();
  const a = { seq: 1, type: 'event', event: 'a' }, b = { seq: 2, type: 'event', event: 'b' };
  assert.deepEqual(r.push(Buffer.concat([frame(a), frame(b)])), [a, b]);
});

test('DapReader: a multi-byte character split between chunks (Content-Length counts bytes)', () => {
  const r = new DapReader();
  const msg = { seq: 1, type: 'event', event: 'output', body: { output: 'héllo €' } };
  const buf = frame(msg);
  const cut = buf.indexOf(Buffer.from('€')) + 1; // inside the 3-byte character
  assert.deepEqual(r.push(buf.subarray(0, cut)), []);
  assert.deepEqual(r.push(buf.subarray(cut)), [msg]);
});

test('DapReader: skips a body that is not JSON and keeps going', () => {
  const r = new DapReader();
  const junk = Buffer.from('not json');
  const bad = Buffer.concat([Buffer.from(`Content-Length: ${junk.length}\r\n\r\n`), junk]);
  const good = { seq: 2, type: 'event', event: 'ok' };
  assert.deepEqual(r.push(Buffer.concat([bad, frame(good)])), [good]);
});

test('request writes a framed request and resolves with the matching response body', async () => {
  const { stream, adapter } = pair();
  const c = new DapClient(stream);
  const p = c.request('threads', { a: 1 });
  const sent = await nextMessage(adapter.in);
  assert.equal(sent.type, 'request');
  assert.equal(sent.command, 'threads');
  assert.deepEqual(sent.arguments, { a: 1 });
  assert.equal(typeof sent.seq, 'number');
  adapter.out.write(frame({ seq: 1, type: 'response', request_seq: sent.seq, success: true, command: 'threads', body: { threads: [] } }));
  assert.deepEqual(await p, { threads: [] });
});

test('request: sequence numbers increase and responses match by request_seq, in any order', async () => {
  const { stream, adapter } = pair();
  const c = new DapClient(stream);
  const p1 = c.request('a'), p2 = c.request('b');
  const m1 = await nextMessage(adapter.in);
  const m2 = await nextMessage(adapter.in);
  assert.ok(m2.seq > m1.seq);
  adapter.out.write(Buffer.concat([
    frame({ seq: 1, type: 'response', request_seq: m2.seq, success: true, body: { n: 2 } }),
    frame({ seq: 2, type: 'response', request_seq: m1.seq, success: true, body: { n: 1 } }),
  ]));
  assert.deepEqual(await p1, { n: 1 });
  assert.deepEqual(await p2, { n: 2 });
});

test('request rejects with the message when success is false', async () => {
  const { stream, adapter } = pair();
  const c = new DapClient(stream);
  const p = c.request('evaluate');
  const sent = await nextMessage(adapter.in);
  adapter.out.write(frame({ seq: 1, type: 'response', request_seq: sent.seq, success: false, message: 'not available' }));
  await assert.rejects(p, { message: 'not available' });
});

test('request without a body resolves to an empty object', async () => {
  const { stream, adapter } = pair();
  const c = new DapClient(stream);
  const p = c.request('continue');
  const sent = await nextMessage(adapter.in);
  adapter.out.write(frame({ seq: 1, type: 'response', request_seq: sent.seq, success: true }));
  assert.deepEqual(await p, {});
});

test('events are emitted', async () => {
  const { stream, adapter } = pair();
  const c = new DapClient(stream);
  const got = new Promise(r => c.once('event', r));
  adapter.out.write(frame({ seq: 1, type: 'event', event: 'stopped', body: { reason: 'breakpoint', threadId: 1 } }));
  assert.deepEqual(await got, { event: 'stopped', body: { reason: 'breakpoint', threadId: 1 } });
});

test('close() rejects pending requests and later requests, and emits close', async () => {
  const { stream } = pair();
  const c = new DapClient(stream);
  const closed = new Promise(r => c.once('close', r));
  const p = c.request('threads');
  c.close();
  await assert.rejects(p, /closed/i);
  await closed;
  await assert.rejects(c.request('threads'), /closed/i);
});

test('the stream ending emits close and rejects pending requests', async () => {
  const { stream, adapter } = pair();
  const c = new DapClient(stream);
  const closed = new Promise(r => c.once('close', r));
  const p = c.request('threads');
  adapter.out.end();
  await assert.rejects(p, /closed/i);
  await closed;
});
