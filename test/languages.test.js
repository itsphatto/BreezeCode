const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const ctx = vm.createContext({});
const load = (file) => vm.runInContext(stripTypeScriptTypes(fs.readFileSync(require.resolve(file), 'utf8')), ctx);
load('../src/renderer/editcore.ts');
vm.runInContext("var baseName = (p) => p.slice(p.lastIndexOf('/') + 1); var esc = (s) => s;", ctx);
load('../src/renderer/breeze/languages.ts');
const { langOf, fullToks, relex } = vm.runInContext('({ langOf, fullToks, relex })', ctx);

// The coloured tokens of `text` as [kind, text] pairs.
function toks(text, lexer) {
  const { starts, kinds } = fullToks(text, lexer);
  return [...starts].map((s, k) => [kinds[k], text.slice(s, starts[k + 1] ?? text.length)]).filter(([kind]) => kind);
}
const ofKind = (text, lexer, kind) => toks(text, lexer).filter(([k]) => k === kind).map(([, t]) => t);
const plain = (v) => JSON.parse(JSON.stringify(v)); // arrays made inside the VM aren't deepEqual to ours

test('new file types pick their lexer', () => {
  const lexerOf = (p) => langOf(p)[0];
  assert.equal(lexerOf('.github/workflows/ci.yml'), 'yaml');
  assert.equal(lexerOf('docker-compose.yaml'), 'yaml');
  assert.equal(lexerOf('Cargo.toml'), 'toml');
  assert.equal(lexerOf('scripts/build.sh'), 'sh');
  assert.equal(lexerOf('.bashrc'), 'sh');
  assert.equal(lexerOf('setup.ps1'), 'ps');
  assert.equal(lexerOf('run.bat'), 'bat');
  assert.equal(lexerOf('run.CMD'), 'bat');
  assert.equal(lexerOf('Dockerfile'), 'docker');
  assert.equal(lexerOf('app/Dockerfile.dev'), 'docker');
  assert.equal(lexerOf('web.dockerfile'), 'docker');
  assert.equal(lexerOf('.env'), 'env');
  assert.equal(lexerOf('.env.local'), 'env');
});

test('YAML keys, values and comments', () => {
  const y = 'on:\n  push:\n    branches: [main, "dev"]\n  node: 18.x\nok: true # yes\nsteps:\n  - run: echo hi\n  - &base n: 3\n---\n';
  assert.deepEqual(ofKind(y, 'yaml', 'prop'), ['on', 'push', 'branches', 'node', 'ok', 'steps', 'run']);
  assert.deepEqual(ofKind(y, 'yaml', 'kw'), ['true', '---']);
  assert.deepEqual(ofKind(y, 'yaml', 'num'), ['3']);
  assert.deepEqual(ofKind(y, 'yaml', 'com'), ['# yes']);
  assert.deepEqual(ofKind(y, 'yaml', 'str'), ['"dev"']);
  assert.deepEqual(ofKind(y, 'yaml', 'attr'), ['&base']);
});

test('TOML tables, keys and values', () => {
  const t = '[package]\nname = "breeze" # n\nversion = 1_000\ndeps = { a = true }\nlist = [\n  [1, 2],\n]\n[[bin]]\nd = 1979-05-27\n';
  assert.deepEqual(ofKind(t, 'toml', 'tag'), ['[package]', '[[bin]]']);
  assert.deepEqual(ofKind(t, 'toml', 'prop'), ['name', 'version', 'deps', 'a', 'list', 'd']);
  assert.deepEqual(ofKind(t, 'toml', 'num'), ['1_000', '1', '2', '1979-05-27']);
  assert.deepEqual(ofKind(t, 'toml', 'kw'), ['true']);
});

test('shell commands, variables and comments', () => {
  const s = '#!/bin/bash\nif [ -n "$X" ]; then\n  echo $HOME $# done-ish\nfi\nFOO=1 npm test | grep ok\n';
  assert.deepEqual(ofKind(s, 'sh', 'com'), ['#!/bin/bash']);
  assert.deepEqual(ofKind(s, 'sh', 'kw'), ['if', 'then', 'fi']);
  assert.deepEqual(ofKind(s, 'sh', 'attr'), ['$HOME', '$#']);
  assert.deepEqual(ofKind(s, 'sh', 'prop'), ['echo', 'FOO', 'grep']);
  assert.deepEqual(ofKind(s, 'sh', 'str'), ['"$X"']);
});

test('PowerShell cmdlets, operators and variables', () => {
  const p = '<# block #>\n$env:PATH -eq $null\nGet-ChildItem -Path . | ForEach-Object { [string]$_ }\nforeach ($x in $y) { "a`"b" }\n';
  assert.deepEqual(ofKind(p, 'ps', 'com'), ['<# block #>']);
  assert.deepEqual(ofKind(p, 'ps', 'kw'), ['-eq', '$null', 'foreach', 'in']);
  assert.deepEqual(ofKind(p, 'ps', 'prop'), ['Get-ChildItem', 'ForEach-Object']);
  assert.deepEqual(ofKind(p, 'ps', 'attr'), ['$env:PATH', '-Path', '$_', '$x', '$y']);
  assert.deepEqual(ofKind(p, 'ps', 'tag'), ['[string]']);
  assert.deepEqual(ofKind(p, 'ps', 'str'), ['"a`"b"']);
});

test('Batch comments, labels and variables', () => {
  const b = '@echo off\nREM hi\n:: also\n:start\nset X=%~dp0\necho %X% !Y! %%i\n';
  assert.deepEqual(ofKind(b, 'bat', 'com'), ['REM hi', ':: also']);
  assert.deepEqual(ofKind(b, 'bat', 'tag'), [':start']);
  assert.deepEqual(ofKind(b, 'bat', 'attr'), ['%~dp0', '%X%', '!Y!', '%%i']);
  assert.deepEqual(ofKind(b, 'bat', 'kw'), ['echo', 'off', 'set', 'echo']);
});

test('Dockerfile instructions, flags and variables', () => {
  const d = 'FROM node:20 AS build\n# c\nRUN echo $HOME # not a comment\nCOPY --from=build /a /b\nEXPOSE 8080\n';
  assert.deepEqual(ofKind(d, 'docker', 'kw'), ['FROM', 'AS', 'RUN', 'COPY', 'EXPOSE']);
  assert.deepEqual(ofKind(d, 'docker', 'com'), ['# c']);
  assert.deepEqual(ofKind(d, 'docker', 'attr'), ['$HOME']);
  assert.deepEqual(ofKind(d, 'docker', 'prop'), ['--from']);
});

test('.env keys, comments and references', () => {
  const e = '# c\nexport API_URL=http://x#y\nKEY="v" # note\nREF=${API_URL}\n';
  assert.deepEqual(ofKind(e, 'env', 'com'), ['# c', '# note']);
  assert.deepEqual(ofKind(e, 'env', 'kw'), ['export']);
  assert.deepEqual(ofKind(e, 'env', 'prop'), ['API_URL', 'KEY', 'REF']);
  assert.deepEqual(ofKind(e, 'env', 'attr'), ['${API_URL}']);
});

test('re-lexing after an edit matches a full lex', () => {
  const samples = {
    yaml: 'a:\n  b: 1\n  c: [x, y]\nd: "s"\n',
    toml: '[t]\nk = """\nmulti\n"""\nn = 2\n',
    sh: 'if true; then\n  echo "a\nb" $X\nfi\n',
    ps: '<#\nnote\n#>\nWrite-Host @"\nhi\n"@\n$a -eq 1\n',
    bat: '@echo off\n:loop\nset /a N=%N%+1\n',
    docker: 'FROM a AS b\nRUN x \\\n  && y\n',
    env: 'A=1\nB="two"\n# c\n',
  };
  for (const [lexer, text] of Object.entries(samples)) {
    for (let at = 0; at <= text.length; at++) {
      for (const ins of ['"', '#', 'x', '\n']) {
        const prev = { text, lexer, ...fullToks(text, lexer) };
        const next = text.slice(0, at) + ins + text.slice(at);
        assert.deepEqual(plain(relex(prev, next)), plain(fullToks(next, lexer)), `${lexer}: '${ins}' at ${at}`);
      }
    }
  }
});
