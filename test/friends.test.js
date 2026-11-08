const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { toFields, fromDoc, normEmail, sha256hex, FriendsError } = require('../src/main/friends');

// ---- Task 1: codec and email helpers ----

test('toFields/fromDoc round-trip strings, numbers, booleans, null and nested maps', () => {
  const x = { s: 'hi', n: 3, f: 1.5, neg: -7, t: true, f2: false, nil: null, nested: { a: 'b', deep: { z: 1 } }, list: ['a', 2, null] };
  assert.deepEqual(fromDoc({ name: 'projects/p/databases/(default)/documents/users/u1', fields: toFields(x) }), { id: 'u1', ...x });
});

test('toFields writes integers as integerValue strings and others as doubleValue', () => {
  const f = toFields({ n: 3, f: 1.5, d: new Date(Date.UTC(2026, 10, 8)), nil: null });
  assert.deepEqual(f.n, { integerValue: '3' });
  assert.deepEqual(f.f, { doubleValue: 1.5 });
  assert.deepEqual(f.d, { timestampValue: '2026-11-08T00:00:00.000Z' });
  assert.deepEqual(f.nil, { nullValue: null });
});

test('fromDoc turns timestampValue into ms', () => {
  const doc = { name: 'projects/p/databases/(default)/documents/presence/u2', fields: { updatedAt: { timestampValue: '2026-11-08T00:00:00Z' } } };
  assert.equal(fromDoc(doc).updatedAt, Date.UTC(2026, 10, 8));
});

test('SERVER_TIME is left out of fields and reported as a transform', () => {
  const { SERVER_TIME, transformsOf } = require('../src/main/friends');
  const obj = { state: 'online', updatedAt: SERVER_TIME };
  assert.deepEqual(Object.keys(toFields(obj)), ['state']);
  assert.deepEqual(transformsOf(obj), [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }]);
});

test('normEmail trims and lowercases', () => {
  assert.equal(normEmail('  Bob@X.com '), 'bob@x.com');
  assert.equal(normEmail('bob'), null);
  assert.equal(normEmail('a@b'), null);
  assert.equal(normEmail(''), null);
  assert.equal(normEmail(null), null);
});

test('sha256hex matches node crypto', () => {
  assert.equal(sha256hex('a@b.co'), crypto.createHash('sha256').update('a@b.co').digest('hex'));
});

test('FriendsError carries a code and a readable message', () => {
  const e = new FriendsError('self');
  assert.equal(e.code, 'self');
  assert.equal(e.message, "That's you.");
  assert.ok(e instanceof Error);
});
