const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const ctx = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(fs.readFileSync(require.resolve('../src/renderer/breeze/treecore.ts'), 'utf8')), ctx);
const generatedFiles = vm.runInContext('generatedFiles', ctx);
const F = name => ({ name, dir: false });
const D = name => ({ name, dir: true });
const hidden = entries => [...generatedFiles(entries)].sort();

test('a .js beside a same-name .ts is generated, and so is its source map', () => {
  assert.deepEqual(hidden([F('agents.ts'), F('agents.js'), F('agents.js.map'), F('core.ts')]), ['agents.js', 'agents.js.map']);
});

test('a .js with no TypeScript twin stays', () => {
  assert.deepEqual(hidden([F('breezescript.js'), F('main.ts')]), []);
});

test('.tsx makes .js and .jsx; .mts makes .mjs; .cts makes .cjs', () => {
  assert.deepEqual(hidden([F('App.tsx'), F('App.js'), F('App.jsx'), F('m.mts'), F('m.mjs'), F('c.cts'), F('c.cjs')]), ['App.js', 'App.jsx', 'c.cjs', 'm.mjs']);
});

test('a .mjs is not hidden by a plain .ts, and folders are never hidden', () => {
  assert.deepEqual(hidden([F('x.ts'), F('x.mjs'), D('y.js'), F('y.ts')]), []);
});

test('names are matched without regard to case', () => {
  assert.deepEqual(hidden([F('Core.TS'), F('Core.js')]), ['Core.js']);
});
