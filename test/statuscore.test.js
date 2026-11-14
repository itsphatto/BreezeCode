const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const ctx = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(fs.readFileSync(require.resolve('../src/renderer/breeze/statuscore.ts'), 'utf8')), ctx);
const toolStatus = vm.runInContext('toolStatus', ctx);
const plain = v => JSON.parse(JSON.stringify(v));

const T = (id, name, found, optional = true) => ({ id, name, found, version: null, optional });
const ALL = [T('git', 'Git', true, false), T('node', 'Node.js', true, false), T('cc', 'C/C++', true), T('python', 'Python', true),
  T('rust', 'Rust', true), T('cargo', 'Cargo', false), T('go', 'Go', false), T('perl', 'Perl', true)];

test('only the tool for the open file shows', () => {
  assert.deepEqual(plain(toolStatus(ALL, 'py')), { text: 'Python ready', warn: false });
  assert.deepEqual(plain(toolStatus(ALL, 'ts')), { text: 'Node ready', warn: false });
  assert.deepEqual(plain(toolStatus(ALL, 'cpp')), { text: 'C ready', warn: false });
});

test('a missing tool for the open file shows as missing, with a warning', () => {
  assert.deepEqual(plain(toolStatus(ALL, 'go')), { text: 'Go missing', warn: true });
  assert.deepEqual(plain(toolStatus(ALL, 'rs')), { text: 'Rust ready · Cargo missing', warn: true });
});

test('no file, or a file no tool runs: a short all-clear', () => {
  assert.deepEqual(plain(toolStatus(ALL, '')), { text: 'Tools ready', warn: false });
  assert.deepEqual(plain(toolStatus(ALL, 'md')), { text: 'Tools ready', warn: false });
});

test('a missing required tool (Git, Node) always shows, after the file\'s own', () => {
  const noGit = ALL.map(t => (t.id === 'git' ? { ...t, found: false } : t));
  assert.deepEqual(plain(toolStatus(noGit, 'md')), { text: 'Git missing', warn: true });
  assert.deepEqual(plain(toolStatus(noGit, 'py')), { text: 'Python ready · Git missing', warn: true });
  const noNode = ALL.map(t => (t.id === 'node' ? { ...t, found: false } : t));
  assert.deepEqual(plain(toolStatus(noNode, 'js')), { text: 'Node missing', warn: true }); // listed once
});

test('an extension is matched without regard to case', () => {
  assert.deepEqual(plain(toolStatus(ALL, 'PY')), { text: 'Python ready', warn: false });
});
