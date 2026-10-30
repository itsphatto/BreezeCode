const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { frame, Reader, LspManager, plainSnippet, hoverText, langOf, findOnPath } = require('../src/main/lsp');

test('Reader splits framed messages arriving in pieces and together', () => {
  const got = [];
  const r = new Reader(m => got.push(m));
  const bytes = Buffer.concat([frame({ id: 1, result: 'é' }), frame({ method: 'x' })]);
  r.push(bytes.subarray(0, 10));
  r.push(bytes.subarray(10, 30));
  assert.equal(got.length, 0);
  r.push(bytes.subarray(30));
  assert.deepEqual(got, [{ id: 1, result: 'é' }, { method: 'x' }]);
});

test('plainSnippet drops tab stops and keeps placeholders', () => {
  assert.equal(plainSnippet('log(${1:msg})$0', true), 'log(msg)');
  assert.equal(plainSnippet('a\\$b', true), 'a$b');
  assert.equal(plainSnippet('log(${1:msg})', false), 'log(${1:msg})');
});

test('hoverText reads every shape of hover contents', () => {
  assert.equal(hoverText({ kind: 'markdown', value: '```ts\nconst x: number\n```' }), 'const x: number');
  assert.equal(hoverText(['a', { language: 'ts', value: 'b' }]), 'a\n\nb');
  assert.equal(hoverText(''), null);
});

test('langOf maps extensions to a server', () => {
  assert.deepEqual(langOf('src/app.tsx'), ['typescriptreact', 'ts']);
  assert.deepEqual(langOf('main.PY'), ['python', 'python']);
  assert.equal(langOf('README.md'), null);
});

test('findOnPath finds a program with a Windows extension', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-lsp-'));
  fs.writeFileSync(path.join(dir, 'gopls.exe'), '');
  assert.equal(findOnPath(['gopls'], dir, 'win32'), path.join(dir, 'gopls.exe'));
  assert.equal(findOnPath(['clangd'], dir, 'win32'), null);
});

const TSC = path.join(__dirname, '..', 'node_modules', '@typescript', `typescript-${process.platform}-${process.arch}`, 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc');
test('TypeScript server: completion, hover, definition, references and rename', { skip: !fs.existsSync(TSC) && 'TypeScript 7 binary not installed', timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-lsp-'));
  const lib = 'export function greet(name: string): string { return name; }\n';
  const main = "import { greet } from './lib';\ngreet('a');\nconst s = 'x';\ns.\n";
  fs.writeFileSync(path.join(dir, 'lib.ts'), lib);
  fs.writeFileSync(path.join(dir, 'main.ts'), main);
  const prefs = { preferences: { useAliasesForRenames: false } }; // as main.js sets it
  const settings = { 'js/ts': prefs, typescript: prefs, javascript: prefs };
  const m = new LspManager({ findServer: async () => ({ cmd: TSC, args: ['--lsp', '--stdio'], settings }), env: async () => process.env });
  m.setRoot(dir);
  try {
    assert.deepEqual(await m.open('main.ts', main), { available: true });
    const items = await m.completion('main.ts', { line: 3, character: 2 });
    assert.ok(items.some(i => i.label === 'toUpperCase'), 'string methods after "s."');
    assert.match(await m.hover('main.ts', { line: 1, character: 1 }), /greet\(name: string\): string/);
    const [def] = await m.definition('main.ts', { line: 1, character: 1 });
    assert.equal(def.path, 'lib.ts');
    assert.equal(def.line, 0);
    const refs = await m.references('main.ts', { line: 1, character: 1 });
    assert.ok(refs.length >= 3, 'declaration, import and call');
    // Renaming where it's used reaches the declaration too, with no "as" alias.
    const edits = await m.rename('main.ts', { line: 1, character: 1 }, 'hello');
    assert.deepEqual(Object.keys(edits).sort(), ['lib.ts', 'main.ts']);
    assert.ok(Object.values(edits).flat().every(e => e.text === 'hello'));
  } finally {
    m.stopAll();
  }
});
