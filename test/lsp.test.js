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

test('langOf maps the added languages to their servers, each with an install hint', () => {
  const { SERVERS, INSTALL } = require('../src/main/lsp');
  const want = {
    go: ['go', 'go'], rb: ['ruby', 'ruby'], rake: ['ruby', 'ruby'], gemspec: ['ruby', 'ruby'], kt: ['kotlin', 'kotlin'], kts: ['kotlin', 'kotlin'],
    swift: ['swift', 'swift'], dart: ['dart', 'dart'], zig: ['zig', 'zig'], scala: ['scala', 'scala'], sc: ['scala', 'scala'],
    ex: ['elixir', 'elixir'], exs: ['elixir', 'elixir'], hs: ['haskell', 'haskell'], r: ['r', 'r'], pl: ['perl', 'perl'], pm: ['perl', 'perl'],
    groovy: ['groovy', 'groovy'], gradle: ['groovy', 'groovy'], java: ['java', 'java'], php: ['php', 'php'],
  };
  for (const [ext, pair] of Object.entries(want)) {
    assert.deepEqual(langOf(`a/file.${ext}`), pair, ext);
    assert.ok(SERVERS[pair[1]]?.length && INSTALL[pair[1]], pair[1]);
  }
  assert.deepEqual(SERVERS.dart[0], { bin: 'dart', args: ['language-server'] });
});

test('lspInstalls lists each server once for the Tools list, with a command or a download page', () => {
  const { lspInstalls } = require('../src/main/lsp');
  const list = lspInstalls('win32');
  assert.equal(new Set(list.map(i => i.name)).size, list.length);
  assert.ok(list.every(i => i.cmd || i.url));
  assert.ok(list.some(i => i.kind === 'css') && !list.some(i => i.kind === 'html' || i.kind === 'ts'));
  assert.equal(list.find(i => i.kind === 'clangd').cmd, 'winget install LLVM.LLVM');
  assert.equal(lspInstalls('linux').find(i => i.kind === 'clangd').cmd, null);
});

test('a missing language server is looked for again on the next open', async () => {
  let calls = 0;
  const m = new LspManager({ findServer: async () => { calls++; return null; }, env: async () => process.env });
  m.setRoot(os.tmpdir());
  const r = await m.open('a.go', 'package a');
  assert.equal(r.available, false);
  assert.match(r.install, /gopls/);
  await m.open('b.go', 'package b');
  assert.equal(calls, 2);
});

test('findOnPath finds a program with a Windows extension', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-lsp-'));
  fs.writeFileSync(path.join(dir, 'gopls.exe'), '');
  assert.equal(findOnPath(['gopls'], dir, 'win32'), path.join(dir, 'gopls.exe'));
  assert.equal(findOnPath(['clangd'], dir, 'win32'), null);
});

const TSC = path.join(__dirname, '..', 'node_modules', '@typescript', `typescript-${process.platform}-${process.arch}`, 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc');
test('lspPos counts lines and UTF-16 columns', () => {
  const { lspPos } = require('../src/main/lsp');
  const t = 'ab\nc😀d\n\nx';
  assert.deepEqual(lspPos(t, 0), { line: 0, character: 0 });
  assert.deepEqual(lspPos(t, 2), { line: 0, character: 2 });
  assert.deepEqual(lspPos(t, 3), { line: 1, character: 0 });
  assert.deepEqual(lspPos(t, 6), { line: 1, character: 3 });
  assert.deepEqual(lspPos(t, 8), { line: 2, character: 0 });
  assert.deepEqual(lspPos(t, 9), { line: 3, character: 0 });
  assert.deepEqual(lspPos(t, t.length), { line: 3, character: 1 });
});

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
    // An edit sent as a range: "s." on line 3 becomes "n." on a new number, so number methods come back.
    const at = main.indexOf('s.\n');
    await m.change('main.ts', { start: at, end: at, text: 'const n = 1;\nn' });
    await m.change('main.ts', { start: at + 'const n = 1;\nn'.length, end: at + 'const n = 1;\nn'.length + 1, text: '' }); // drop the old "s"
    const nums = await m.completion('main.ts', { line: 4, character: 2 });
    assert.ok(nums.some(i => i.label === 'toFixed'), 'number methods after the ranged edits');
  } finally {
    m.stopAll();
  }
});

test('toDiags keeps errors and warnings, one line long at most', () => {
  const { toDiags } = require('../src/main/lsp');
  const r = (l1, c1, l2, c2) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });
  assert.deepEqual(toDiags([
    { range: r(2, 4, 2, 9), message: 'Undefined name\nmore detail', severity: 1 },
    { range: r(0, 0, 3, 1), message: 'Spans lines', severity: 2 },
    { range: r(1, 0, 1, 1), message: 'Unused', severity: 4 },
    { range: r(1, 2, 1, 2), message: 'No severity' },
  ]), [
    { line: 0, col: 0, len: 1, msg: 'Spans lines', sev: 2 },
    { line: 1, col: 2, len: 1, msg: 'No severity', sev: 1 },
    { line: 2, col: 4, len: 5, msg: 'Undefined name', sev: 1 },
  ]);
  assert.deepEqual(toDiags(null), []);
});

test('TypeScript server: problems for the open file, cleared once fixed', { skip: !fs.existsSync(TSC) && 'TypeScript 7 binary not installed', timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-lsp-'));
  const bad = "const x: number = 'a';\n";
  fs.writeFileSync(path.join(dir, 'a.ts'), bad);
  const seen = [];
  let wake = () => undefined;
  const next = () => new Promise(res => { wake = res; });
  const m = new LspManager({ findServer: async () => ({ cmd: TSC, args: ['--lsp', '--stdio'] }), env: async () => process.env, onDiagnostics: (rel, d, lines) => { seen.push({ rel, d, lines }); wake(); } });
  m.setRoot(dir);
  try {
    let got = next();
    await m.open('a.ts', bad);
    await got;
    assert.equal(seen.at(-1).rel, 'a.ts');
    assert.equal(seen.at(-1).lines, 2);
    assert.match(seen.at(-1).d[0].msg, /not assignable/);
    got = next();
    await m.change('a.ts', 'const x: number = 1;\n');
    await got;
    assert.deepEqual(seen.at(-1).d, []);
  } finally {
    m.stopAll();
  }
});
