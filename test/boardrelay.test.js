const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const ctx = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(fs.readFileSync(require.resolve('../src/renderer/breeze/boardrelay.ts'), 'utf8')), ctx);
const { RelayQueue, relayPrompt, echoesAnswer } = vm.runInContext('({ RelayQueue, relayPrompt, echoesAnswer })', ctx);

let n = 0;
const ask = (from, to, extra = {}) => ({ id: `r${++n}`, from, to, kind: 'ask', note: 'export getUser', ...extra });
const idle = () => true;
const busy = () => false;

test('relayQueue holds a relay until the box is idle', () => {
  const q = new RelayQueue();
  const r = ask('box1', 'box2');
  assert.equal(q.push(r, busy), 'queued');
  assert.deepEqual(JSON.parse(JSON.stringify(q.waiting('box2').map(x => x.id))), [r.id]);
  assert.equal(q.next('box2').id, r.id);
  assert.equal(q.next('box2'), null);
});

test('relayQueue pauses after 3 hops in a row', () => {
  const q = new RelayQueue(3);
  const out = [ask('box1', 'box2'), ask('box2', 'box1'), ask('box1', 'box2'), ask('box2', 'box1')].map(r => q.push(r, idle));
  assert.deepEqual(out, ['start', 'start', 'start', 'paused']);
  q.personSpoke('box1');
  assert.equal(q.push(ask('box1', 'box2'), idle), 'start');
});

test('hops between other boxes do not count', () => {
  const q = new RelayQueue(3);
  for (let i = 0; i < 3; i++) q.push(ask('box1', 'box2'), idle);
  assert.equal(q.push(ask('box3', 'box2'), idle), 'start');
});

test('auto off pauses everything', () => {
  const q = new RelayQueue();
  q.auto = false;
  assert.equal(q.push(ask('box1', 'box2'), idle), 'paused');
});

test('send hands back a paused relay and resets its pair', () => {
  const q = new RelayQueue(1);
  q.push(ask('box1', 'box2'), idle);
  const r = ask('box1', 'box2');
  assert.equal(q.push(r, idle), 'paused');
  assert.equal(q.send(r.id).id, r.id);
  assert.equal(q.send(r.id), null, 'only once');
  assert.equal(q.push(ask('box1', 'box2'), idle), 'start');
});

test('drop forgets a waiting relay', () => {
  const q = new RelayQueue();
  const r = ask('box1', 'box2');
  q.push(r, busy);
  q.drop(r.id);
  assert.equal(q.next('box2'), null);
});

test('stopAll drops waiting relays', () => {
  const q = new RelayQueue(1);
  q.push(ask('box1', 'box2'), busy);
  const p = ask('box1', 'box2');
  q.push(p, idle);
  q.stopAll();
  assert.equal(q.next('box2'), null);
  assert.equal(q.send(p.id), null);
});

test('dropFor forgets every relay to or from a box', () => {
  const q = new RelayQueue();
  q.push(ask('box1', 'box2'), busy);
  q.push(ask('box2', 'box3'), busy);
  q.dropFor('box2');
  assert.equal(q.next('box2'), null);
  assert.equal(q.next('box3'), null);
});

test('relayPrompt includes the diff', () => {
  const p = relayPrompt({ id: 'x', from: 'box1', to: 'box2', kind: 'ask', path: 'api.ts', diff: '@@ line 2\n-a\n+b' }, 'Claude · 1');
  assert.match(p, /Claude · 1/);
  assert.match(p, /api\.ts/);
  assert.match(p, /\+b/);
});

test('relayPrompt for a reply tells the asker to continue', () => {
  const p = relayPrompt({ id: 'x', from: 'box2', to: 'box1', kind: 'reply', note: 'Added getUser.' }, 'Codex · 2');
  assert.match(p, /Codex · 2 answered/);
  assert.match(p, /Added getUser\./);
  assert.match(p, /Continue your task/);
});

test('a note back to the box a run is answering is an echo of the answer', () => {
  const answering = { id: 'a', from: 'box1', to: 'box2', kind: 'ask' };
  assert.equal(echoesAnswer(answering, 'box1'), true, 'the answer already goes back as a reply');
  assert.equal(echoesAnswer(answering, 'box3'), false, 'a third box is a new ask');
  assert.equal(echoesAnswer({ id: 'b', from: 'box2', to: 'box1', kind: 'reply' }, 'box2'), false, 'the asker continuing may ask again (the loop guard counts it)');
  assert.equal(echoesAnswer(undefined, 'box1'), false, "a person's own run asks freely");
});

test('dropFor hands back what it dropped, so the askers can be told', () => {
  const q = new RelayQueue(5);
  const toIt = ask('box1', 'box2');
  q.push(toIt, busy);
  const other = ask('box3', 'box4');
  q.push(other, busy);
  q.auto = false;
  const fromIt = ask('box2', 'box4');
  assert.equal(q.push(fromIt, idle), 'paused');
  const dropped = q.dropFor('box2').map(r => r.id).sort();
  assert.deepEqual(JSON.parse(JSON.stringify(dropped)), [toIt.id, fromIt.id].sort());
  assert.equal(q.next('box4').id, other.id, 'relays between other boxes stay');
});
