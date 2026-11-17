const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemoryStore, memoryRefusal, scopeOf, MAX_PER_SCOPE, GLOBAL } = require('../src/main/agentmemory');

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-mem-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'memory.json');
}

test('remembers, recalls and survives a restart', t => {
  const file = tmpFile(t);
  const m = new MemoryStore(file, 'linux');
  m.add('The user prefers pnpm over npm', null);
  m.add('Tests run with vitest here', '/code/a');
  const again = new MemoryStore(file, 'linux');
  const found = again.recall('which package manager pnpm', '/code/a');
  assert.ok(found.some(x => /pnpm/.test(x.text)));
  assert.equal(again.list().length, 2);
});

test('a project’s facts never reach another project', () => {
  const m = new MemoryStore(null, 'linux');
  m.add('Deploys go to staging first', '/code/a');
  m.add('Uses tabs', null);
  const inB = m.recall('deploys staging', '/code/b').map(x => x.text);
  assert.ok(!inB.includes('Deploys go to staging first'));
  assert.ok(m.recall('deploys staging', '/code/a').some(x => x.text === 'Deploys go to staging first'));
  assert.ok(!m.promptBlock('deploys', '/code/b').includes('staging'));
  assert.equal(m.forget('Deploys', '/code/b'), 0); // can't forget another project's fact from here
});

test('secrets, code and long text are refused', () => {
  assert.ok(memoryRefusal('api_key = sk-abcdefghijklmnopqrstuvwxyz'));
  assert.ok(memoryRefusal('password: hunter2'));
  assert.ok(memoryRefusal('x'.repeat(400)));
  assert.ok(memoryRefusal('a\nb\nc\nd\ne\nf'));
  assert.ok(memoryRefusal('   '));
  assert.equal(memoryRefusal('The user likes short answers'), null);
  const m = new MemoryStore(null, 'linux');
  assert.throws(() => m.add('token=ghp_abcdefghijklmnopqrstuvwxyz0123456789', null), /secret/);
});

test('the same fact is not kept twice, and the cap holds', () => {
  const m = new MemoryStore(null, 'linux');
  m.add('Likes dark mode', null);
  m.add('likes dark mode', null);
  assert.equal(m.list().length, 1);
  for (let i = 0; i < MAX_PER_SCOPE + 5; i++) m.add(`fact number ${i}`, '/p');
  assert.equal(m.list().filter(x => x.scope === '/p').length, MAX_PER_SCOPE);
});

test('forget by id or by text, and clear', () => {
  const m = new MemoryStore(null, 'linux');
  const a = m.add('Uses Rust for the engine', '/p');
  m.add('Uses Electron', '/p');
  assert.equal(m.forget(a.id, '/p'), 1);
  assert.equal(m.forget('electron', '/p'), 1);
  m.add('x fact', null);
  m.clear();
  assert.equal(m.list().length, 0);
});

test('Windows scopes ignore case', () => {
  assert.equal(scopeOf('C:\\Code\\App', 'win32'), scopeOf('c:\\code\\app', 'win32'));
  assert.equal(scopeOf(null), GLOBAL);
});

test('promptBlock fits its budget', () => {
  const m = new MemoryStore(null, 'linux');
  for (let i = 0; i < 20; i++) m.add(`global preference ${i} about formatting code nicely`, null);
  const block = m.promptBlock('formatting', null, 200);
  assert.ok(block.length < 300);
  assert.match(block, /What you remember/);
  assert.equal(new MemoryStore(null).promptBlock('x', null), '');
});
