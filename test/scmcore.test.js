const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const ctx = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(fs.readFileSync(require.resolve('../src/renderer/breeze/scmcore.ts'), 'utf8')), ctx);
const { parsePatch, prStatus, prListState } = vm.runInContext('({ parsePatch, prStatus, prListState })', ctx);
const plain = (v) => JSON.parse(JSON.stringify(v));

test('parsePatch numbers lines from the hunk header', () => {
  const rows = plain(parsePatch('@@ -10,3 +10,4 @@ fn\n a\n-b\n+B\n+C\n c'));
  assert.deepEqual(rows, [
    { kind: 'hunk', text: '@@ -10,3 +10,4 @@ fn', old: null, new: null },
    { kind: 'ctx', text: 'a', old: 10, new: 10 },
    { kind: 'del', text: 'b', old: 11, new: null },
    { kind: 'add', text: 'B', old: null, new: 11 },
    { kind: 'add', text: 'C', old: null, new: 12 },
    { kind: 'ctx', text: 'c', old: 12, new: 13 },
  ]);
});

test('parsePatch handles "No newline" notes, empty patches, trailing newline and multiple hunks', () => {
  const rows = plain(parsePatch('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n'));
  assert.deepEqual(rows.map((r) => r.kind), ['hunk', 'del', 'note', 'add', 'note']);
  assert.deepEqual(rows[2], { kind: 'note', text: '\\ No newline at end of file', old: null, new: null });
  assert.deepEqual(plain(parsePatch('')), []);
  const two = plain(parsePatch('@@ -1,1 +1,1 @@\n x\n@@ -20,1 +25,1 @@\n y'));
  assert.deepEqual([two[1].old, two[1].new, two[3].old, two[3].new], [1, 1, 20, 25]);
});

test('prStatus picks draft, conflict, checking, ready in that order', () => {
  assert.equal(prStatus({ mergeable: true, mergeableState: 'clean', draft: false }), 'ready');
  assert.equal(prStatus({ mergeable: false, mergeableState: 'unknown', draft: false }), 'conflict');
  assert.equal(prStatus({ mergeable: true, mergeableState: 'dirty', draft: false }), 'conflict');
  assert.equal(prStatus({ mergeable: null, mergeableState: 'unknown', draft: false }), 'checking');
  assert.equal(prStatus({ mergeable: true, mergeableState: 'clean', draft: true }), 'draft');
  assert.equal(prStatus({ mergeable: false, mergeableState: 'dirty', draft: true }), 'draft');
});

test('prListState reports no-branch first, then loading, errors and ok', () => {
  assert.equal(prListState({ signedIn: true, branch: null, result: null }), 'no-branch');
  assert.equal(prListState({ signedIn: false, branch: null, result: null }), 'no-branch');
  assert.equal(prListState({ signedIn: false, branch: 'main', result: null }), 'signed-out');
  assert.equal(prListState({ signedIn: true, branch: 'main', result: null }), 'loading');
  assert.equal(prListState({ signedIn: true, branch: 'main', result: { ok: false, error: 'rate-limited' } }), 'rate-limited');
  assert.equal(prListState({ signedIn: true, branch: 'main', result: { ok: true, data: [] } }), 'ok');
});
