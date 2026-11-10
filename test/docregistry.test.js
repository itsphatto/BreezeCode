const test = require('node:test');
const assert = require('node:assert/strict');
const { DocRegistry } = require('../src/main/docregistry.js');

test('record makes an id open', () => {
  const r = new DocRegistry();
  assert.equal(r.isOpen(1), false);
  assert.equal(r.record('/a', 1, r.generation), true);
  assert.equal(r.isOpen(1), true);
  assert.equal(r.isOpen(2), false);
});
test('re-opening a path drops its old id', () => {
  const r = new DocRegistry();
  r.record('/a', 1, r.generation);
  r.record('/b', 2, r.generation);
  r.record('/a', 3, r.generation);
  assert.deepEqual([r.isOpen(1), r.isOpen(2), r.isOpen(3)], [false, true, true]);
  assert.equal(r.byPath.get('/a'), 3);
});
test('forget removes the id and its path', () => {
  const r = new DocRegistry();
  r.record('/a', 1, r.generation);
  r.forget(1);
  assert.equal(r.isOpen(1), false);
  assert.equal(r.byPath.size, 0);
});
test('forgetting an old id leaves the path of a newer one', () => {
  const r = new DocRegistry();
  r.record('/a', 1, r.generation);
  r.record('/a', 2, r.generation);
  r.forget(1);
  assert.equal(r.isOpen(2), true);
  assert.equal(r.byPath.get('/a'), 2);
});
test('clear empties both, bumps the generation and returns the open ids', () => {
  const r = new DocRegistry();
  r.record('/a', 1, r.generation);
  r.record('/b', 2, r.generation);
  const before = r.generation;
  assert.deepEqual(r.clear().sort(), [1, 2]);
  assert.equal(r.ids.size, 0);
  assert.equal(r.byPath.size, 0);
  assert.equal(r.generation, before + 1);
});
test('an open that started before a clear is refused', () => {
  const r = new DocRegistry();
  const started = r.generation;
  r.clear();
  assert.equal(r.record('/a', 1, started), false);
  assert.equal(r.isOpen(1), false);
  assert.equal(r.byPath.size, 0);
  assert.equal(r.record('/a', 1, r.generation), true);
});
