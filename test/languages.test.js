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
    go: 'a := `x\ny` // c\n',
    rb: '=begin\nx\n=end\nputs :a # c\n',
    ex: '@doc """\nhi\n"""\n~r/a/ # c\n',
    hs: "{- a\nb -}\nf x' = 1 -- c\n",
    zig: 'const s =\n  \\\\a\n  \\\\b\n;\n',
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

test('Lua, PHP and SQL pick their lexer', () => {
  assert.deepEqual(['game.lua', 'index.php', 'view.phtml', 'schema.SQL'].map(p => langOf(p)[0]), ['lua', 'php', 'php', 'sql']);
});

test('Lua: long comments and strings, keywords and calls', () => {
  const text = '--[==[ a ]] still comment ]==]\nlocal s = [[x\ny]] -- note\nprint(s, nil)';
  assert.deepEqual(plain(ofKind(text, 'lua', 'com')), ['--[==[ a ]] still comment ]==]', '-- note']);
  assert.deepEqual(plain(ofKind(text, 'lua', 'str')), ['[[x\ny]]']);
  assert.deepEqual(plain(ofKind(text, 'lua', 'kw')), ['local', 'nil']);
  assert.deepEqual(plain(ofKind(text, 'lua', 'prop')), ['print']);
});

test('PHP: code between the tags, HTML around them', () => {
  const text = '<h1><?= $title ?></h1>\n<?php\n# note\necho <<<EOT\nhi $name\nEOT;\n$n = count($xs);';
  assert.deepEqual(plain(ofKind(text, 'php', 'tag')), ['<h1', '>', '<?=', '?>', '</h1', '>', '<?php']);
  assert.deepEqual(plain(ofKind(text, 'php', 'attr')), ['$title', '$n', '$xs']);
  assert.deepEqual(plain(ofKind(text, 'php', 'com')), ['# note']);
  assert.deepEqual(plain(ofKind(text, 'php', 'str')), ['<<<EOT\nhi $name\nEOT']);
  assert.deepEqual(plain(ofKind(text, 'php', 'kw')), ['echo']);
});

test('SQL: keywords in any case, quoted names, doubled quotes and parameters', () => {
  const text = "select \"Name\" FROM users -- all\nWHERE note = 'it''s' AND id = :id;";
  assert.deepEqual(plain(ofKind(text, 'sql', 'kw')), ['select', 'FROM', 'WHERE', 'AND']);
  assert.deepEqual(plain(ofKind(text, 'sql', 'prop')), ['"Name"']);
  assert.deepEqual(plain(ofKind(text, 'sql', 'str')), ["'it''s'"]);
  assert.deepEqual(plain(ofKind(text, 'sql', 'attr')), [':id']);
  assert.deepEqual(plain(ofKind(text, 'sql', 'com')), ['-- all']);
});

test('Go, Ruby, Kotlin, Swift, Dart, Zig, Scala, Elixir, Haskell, R, Perl and Groovy pick their lexer', () => {
  const files = {
    'main.go': 'go', 'go.mod': 'go', 'go.sum': 'go', 'app.rb': 'rb', 'tasks.rake': 'rb', 'x.gemspec': 'rb', 'Gemfile': 'rb', 'Rakefile': 'rb',
    'Main.kt': 'kt', 'build.gradle.kts': 'kt', 'App.swift': 'swift', 'main.dart': 'dart', 'build.zig': 'zig', 'A.scala': 'scala', 'w.sc': 'scala',
    'lib/a.ex': 'ex', 'mix.exs': 'ex', 'Main.hs': 'hs', 'plot.R': 'r', 'x.pl': 'pl', 'X.pm': 'pl', 'a.groovy': 'groovy', 'build.gradle': 'groovy',
  };
  for (const [p, lexer] of Object.entries(files)) assert.equal(langOf(p)[0], lexer, p);
  assert.equal(langOf('Gemfile')[1], 'Ruby');
});

test('Go raw strings span lines and hide comments', () => {
  const text = 'x := `a // b\nc` // d\nfunc main() {}';
  assert.deepEqual(plain(ofKind(text, 'go', 'str')), ['`a // b\nc`']);
  assert.deepEqual(plain(ofKind(text, 'go', 'com')), ['// d']);
  assert.deepEqual(plain(ofKind(text, 'go', 'kw')), ['func']);
  assert.deepEqual(plain(ofKind(text, 'go', 'prop')), ['main']);
});

test('Ruby: =begin blocks, :symbols and @ivars', () => {
  const text = "=begin\nx = 1\n=end\nputs :sym, 'a#b', @n # c\nFoo::Bar\n";
  assert.deepEqual(plain(ofKind(text, 'rb', 'com')), ['=begin\nx = 1\n=end', '# c']);
  assert.deepEqual(plain(ofKind(text, 'rb', 'attr')), [':sym', '@n']);
  assert.deepEqual(plain(ofKind(text, 'rb', 'str')), ["'a#b'"]);
});

test('Kotlin, Swift, Scala, Groovy and Dart: triple-quoted strings and @annotations', () => {
  const kt = 'val s = """\n"q" // no\n"""\n@JvmStatic fun f() = 1L';
  assert.deepEqual(plain(ofKind(kt, 'kt', 'str')), ['"""\n"q" // no\n"""']);
  assert.deepEqual(plain(ofKind(kt, 'kt', 'attr')), ['@JvmStatic']);
  assert.deepEqual(plain(ofKind(kt, 'kt', 'kw')), ['val', 'fun']);
  const swift = '@MainActor\nlet s = """\nhi // x\n"""\nfunc f() {}';
  assert.deepEqual(plain(ofKind(swift, 'swift', 'str')), ['"""\nhi // x\n"""']);
  assert.deepEqual(plain(ofKind(swift, 'swift', 'attr')), ['@MainActor']);
  assert.deepEqual(plain(ofKind(swift, 'swift', 'kw')), ['let', 'func']);
  const scala = 'val s = """a "b" c"""\n// d\ndef f(x: Int) = s"$x"';
  assert.deepEqual(plain(ofKind(scala, 'scala', 'str')), ['"""a "b" c"""', '"$x"']);
  assert.deepEqual(plain(ofKind(scala, 'scala', 'kw')), ['val', 'def']);
  const groovy = "def s = '''\nx // y\n'''\nprintln \"${s}\"";
  assert.deepEqual(plain(ofKind(groovy, 'groovy', 'str')), ["'''\nx // y\n'''", '"${s}"']);
  assert.deepEqual(plain(ofKind(groovy, 'groovy', 'kw')), ['def']);
  const dart = "@override\nvar s = '''\nit's // x\n''';";
  assert.deepEqual(plain(ofKind(dart, 'dart', 'str')), ["'''\nit's // x\n'''"]);
  assert.deepEqual(plain(ofKind(dart, 'dart', 'attr')), ['@override']);
  assert.deepEqual(plain(ofKind(dart, 'dart', 'kw')), ['var']);
});

test('Zig: \\ multiline string lines and @builtins', () => {
  const text = String.raw`const s =
    \\hello // not a comment
    \\world
;
// done
const x = @import("std");`;
  assert.deepEqual(plain(ofKind(text, 'zig', 'str')), [String.raw`\\hello // not a comment`, String.raw`\\world`, '"std"']);
  assert.deepEqual(plain(ofKind(text, 'zig', 'com')), ['// done']);
  assert.deepEqual(plain(ofKind(text, 'zig', 'attr')), ['@import']);
});

test('Elixir: heredocs, ~r sigils, :atoms and @attributes', () => {
  const text = '@moduledoc """\nhi # no\n"""\nRegex.match?(~r/a#b/i, :ok) # c\nx :: integer';
  assert.deepEqual(plain(ofKind(text, 'ex', 'str')), ['"""\nhi # no\n"""', '~r/a#b/i']);
  assert.deepEqual(plain(ofKind(text, 'ex', 'attr')), ['@moduledoc', ':ok']);
  assert.deepEqual(plain(ofKind(text, 'ex', 'com')), ['# c']);
  assert.deepEqual(plain(ofKind(text, 'ex', 'prop')), ['match?']);
});

test("Haskell: {- -} and -- comments, primes aren't quotes", () => {
  const text = "{- block -}\nf x' = x' -- note\nc = 'a' where y = \"s\"";
  assert.deepEqual(plain(ofKind(text, 'hs', 'com')), ['{- block -}', '-- note']);
  assert.deepEqual(plain(ofKind(text, 'hs', 'str')), ["'a'", '"s"']);
  assert.deepEqual(plain(ofKind(text, 'hs', 'kw')), ['where']);
});

test('R: # comments, dotted calls and TRUE', () => {
  const text = 'x <- is.na(y) # check\nif (TRUE) "a#b"';
  assert.deepEqual(plain(ofKind(text, 'r', 'com')), ['# check']);
  assert.deepEqual(plain(ofKind(text, 'r', 'prop')), ['is.na']);
  assert.deepEqual(plain(ofKind(text, 'r', 'kw')), ['if', 'TRUE']);
  assert.deepEqual(plain(ofKind(text, 'r', 'str')), ['"a#b"']);
});

test('Perl: $@% sigils, $#array and # comments', () => {
  const text = 'my @xs = (1); # c\nprint $#xs, %h, $a % 2, "a#b";';
  assert.deepEqual(plain(ofKind(text, 'pl', 'attr')), ['@xs', '$#xs', '%h', '$a']);
  assert.deepEqual(plain(ofKind(text, 'pl', 'com')), ['# c']);
  assert.deepEqual(plain(ofKind(text, 'pl', 'str')), ['"a#b"']);
  assert.deepEqual(plain(ofKind(text, 'pl', 'kw')), ['my', 'print']);
});
