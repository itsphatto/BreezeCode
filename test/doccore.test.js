const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const ctx = vm.createContext({});
// doccore uses lineStartsOf and textEdit from editcore, so both load into one context, editcore first.
for (const f of ['editcore.ts', 'doccore.ts']) vm.runInContext(stripTypeScriptTypes(fs.readFileSync(require.resolve('../src/renderer/' + f), 'utf8')), ctx);
const { DOC_END, docPosAt, docEditsFor, docKindOf, stripBom, DocQueue } =
  vm.runInContext('({ DOC_END, docPosAt, docEditsFor, docKindOf, stripBom, DocQueue })', ctx);

const P = (line, col) => ({ line, col });
// Values from a vm context have another prototype, so compare JSON-plain copies.
const eq = (a, b) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b);
const E = text => ({ start: P(0, 0), end: P(0, 0), text });
const state = lines => ({ rev: 0, lines, dirty: true });
const wait = ms => new Promise(r => setTimeout(r, ms));

test('DOC_END is past any line', () => { eq(DOC_END, P(2147483647, 0)); });
test('docPosAt', () => {
  const s = [0, 3, 4]; // "ab\n\ncd"
  eq(docPosAt(s, 0), P(0, 0)); eq(docPosAt(s, 2), P(0, 2)); eq(docPosAt(s, 3), P(1, 0)); eq(docPosAt(s, 4), P(2, 0)); eq(docPosAt(s, 6), P(2, 2));
});
test('docEditsFor: insert, delete, replace', () => {
  eq(docEditsFor('ab\ncd', 'ab\ncXd', null), [{ start: P(1, 1), end: P(1, 1), text: 'X' }]);
  eq(docEditsFor('ab\ncd', 'ad', null), [{ start: P(0, 1), end: P(1, 1), text: '' }]);
  eq(docEditsFor('one\ntwo', 'one\nTWO', null), [{ start: P(1, 0), end: P(1, 3), text: 'TWO' }]);
  eq(docEditsFor('same', 'same', null), []);
});
test('docEditsFor: emoji columns are UTF-16 units', () => {
  eq(docEditsFor('😀a', '😀Xa', null), [{ start: P(0, 2), end: P(0, 2), text: 'X' }]);
});
test('docEditsFor: a lone \\r is not a line break', () => {
  eq(docEditsFor('a\rb\nc', 'a\rb\ncZ', null), [{ start: P(1, 1), end: P(1, 1), text: 'Z' }]);
});
test('docEditsFor: multi-cursor edits come last first, in before offsets', () => {
  // "a\nb\nc" with an "x" typed before each line
  eq(docEditsFor('a\nb\nc', 'xa\nxb\nxc', [{ start: 0, end: 0, text: 'x' }, { start: 2, end: 2, text: 'x' }, { start: 4, end: 4, text: 'x' }]),
    [{ start: P(2, 0), end: P(2, 0), text: 'x' }, { start: P(1, 0), end: P(1, 0), text: 'x' }, { start: P(0, 0), end: P(0, 0), text: 'x' }]);
});
test('docKindOf', () => {
  assert.equal(docKindOf('type'), 'type'); assert.equal(docKindOf('deleteContentBackward'), 'delete');
  assert.equal(docKindOf('deleteContentForward'), 'delete'); assert.equal(docKindOf('insertFromPaste'), 'paste');
  assert.equal(docKindOf('reload'), 'other'); assert.equal(docKindOf(undefined), 'other');
});
test('stripBom', () => { assert.equal(stripBom('﻿ab'), 'ab'); assert.equal(stripBom('ab'), 'ab'); assert.equal(stripBom('﻿﻿'), '﻿'); });

test('DocQueue sends in order and keeps the newest line count', async () => {
  const sent = [];
  const q = new DocQueue({ send: async e => { sent.push(e.text); return state(Number(e.text)); }, resync: async () => state(0), dropped() {} });
  q.push([E('1')], 'type'); q.push([E('2')], 'type'); q.push([E('3')], 'type');
  await q.flush();
  assert.deepEqual(sent, ['1', '2', '3']);
  assert.equal(q.lines, 3);
  assert.equal(q.dead, false);
});
test('DocQueue: one push of several edits sends them in array order, with the kind', async () => {
  const sent = [];
  const q = new DocQueue({ send: async (e, k) => { sent.push(e.text + k); return state(1); }, resync: async () => state(0), dropped() {} });
  q.push([E('b'), E('a')], 'paste');
  await q.flush();
  assert.deepEqual(sent, ['bpaste', 'apaste']);
});
test('DocQueue: flush waits for edits pushed before it', async () => {
  const sent = [];
  const q = new DocQueue({ send: async e => { await wait(10); sent.push(e.text); return state(1); }, resync: async () => state(0), dropped() {} });
  q.push([E('a')], 'type'); q.push([E('b')], 'type');
  await q.flush();
  assert.deepEqual(sent, ['a', 'b']);
});
test('DocQueue: flush with nothing queued resolves', async () => {
  const q = new DocQueue({ send: async () => state(1), resync: async () => state(0), dropped() {} });
  await q.flush();
});
test('DocQueue: a failed edit resyncs once', async () => {
  let resyncs = 0, dropped = 0, calls = 0;
  const q = new DocQueue({
    send: async () => { if (calls++ === 0) throw new Error('boom'); return state(5); },
    resync: async () => { resyncs++; return state(9); },
    dropped() { dropped++; },
  });
  q.push([E('a')], 'type');
  await q.flush();
  assert.equal(resyncs, 1); assert.equal(dropped, 0); assert.equal(q.dead, false);
  assert.equal(q.lines, 9);
  q.push([E('b')], 'type');
  await q.flush();
  assert.equal(q.lines, 5);
});
test('DocQueue: edits queued before a resync are skipped', async () => {
  const sent = [];
  let resyncs = 0;
  const q = new DocQueue({
    send: async e => { sent.push(e.text); if (e.text === 'A') throw new Error('boom'); return state(1); },
    resync: async () => { resyncs++; await wait(10); return state(1); },
    dropped() {},
  });
  q.push([E('A')], 'type'); q.push([E('B')], 'type'); q.push([E('C')], 'type');
  await q.flush();
  assert.deepEqual(sent, ['A']);
  assert.equal(resyncs, 1);
  q.push([E('D')], 'type');
  await q.flush();
  assert.deepEqual(sent, ['A', 'D']);
});
test('DocQueue: an edit pushed while a resync runs is sent after it', async () => {
  const sent = [];
  const q = new DocQueue({
    send: async e => { sent.push(e.text); if (e.text === 'A') throw new Error('boom'); return state(1); },
    resync: async () => { await wait(10); return state(1); },
    dropped() {},
  });
  q.push([E('A')], 'type');
  await wait(0); // A has failed and the resync has started
  q.push([E('B')], 'type');
  await q.flush();
  assert.deepEqual(sent, ['A', 'B']);
});
test('DocQueue: a failed resync kills the queue and calls dropped once', async () => {
  const sent = [];
  const dropped = [];
  const q = new DocQueue({
    send: async e => { sent.push(e.text); throw new Error('send'); },
    resync: async () => { throw new Error('resync'); },
    dropped: err => dropped.push(err),
  });
  q.push([E('A')], 'type'); q.push([E('B')], 'type');
  await q.flush();
  assert.equal(dropped.length, 1); assert.equal(dropped[0].message, 'resync');
  assert.equal(q.dead, true);
  q.push([E('C')], 'type');
  await q.flush();
  assert.deepEqual(sent, ['A']);
  assert.equal(dropped.length, 1);
});
