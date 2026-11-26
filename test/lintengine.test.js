// The structural checks run in two places: the Rust engine (engine/src/lint) for a file it holds, and languages.ts for
// one it doesn't. Both must report exactly the same problems, so each sample here goes through both and is compared.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { Engine } = require('../src/main/engine.js');

const ctx = vm.createContext({});
const load = (file) => vm.runInContext(stripTypeScriptTypes(fs.readFileSync(require.resolve(file), 'utf8')), ctx);
load('../src/renderer/editcore.ts');
vm.runInContext("var baseName = (p) => p.slice(p.lastIndexOf('/') + 1); var esc = (s) => s;", ctx);
load('../src/renderer/breeze/languages.ts');
const { lintStructure, toDiags, lintKind, LINTERS } = vm.runInContext('({ lintStructure, toDiags, lintKind, LINTERS })', ctx);
const plain = v => JSON.parse(JSON.stringify(v));

const exe = path.join(__dirname, '..', 'runtime', process.platform === 'win32' ? 'breeze-engine.exe' : 'breeze-engine');
const skip = fs.existsSync(exe) ? false : 'engine not built: run npm run build:engine';

// A file of each kind, as the page would name it.
const FILES = { json: 'a.json', jsonc: 'tsconfig.json', css: 'a.css', scss: 'a.scss', less: 'a.less', html: 'a.html', xml: 'a.svg', py: 'a.py', java: 'A.java', rs: 'a.rs', js: 'a.ts', jsx: 'a.tsx' };

test('every file the page checks has an engine check, and the names agree', () => {
  for (const ext of Object.keys(LINTERS)) assert.ok(lintKind(`x.${ext}`), ext);
  for (const [kind, file] of Object.entries(FILES)) assert.equal(lintKind(file), kind, file);
  assert.equal(lintKind('.vscode/settings.json'), 'jsonc');
  assert.equal(lintKind('notes.md'), null);
  assert.equal(lintKind('Makefile'), null);
});

const SAMPLES = {
  json: ['', '{"a": [1, 2.5e-3, true, null, "x\\"y"]}', '{"a": 1,}', '{a: 1}', "['x']", '[1 2]', '[1', '"abc', '1 2', '[😀]', '{"a" 1}', '-', '[01]'],
  jsonc: ['// c\n{"a": 1,} /* d */', '{} /* x', '[1,]'],
  css: ['a { color: red; }', 'a { color red; }', 'a {\n  color: red\n  margin: 0;\n}', '@media x { a { b: c } }', "a { x: 'a;b' /* c;d */ }", 'a { (', '/* x', 'a { b: "c }'],
  scss: ['a { // b (\n color red; }', '.a { &:hover { x: y } }', 'a { ('],
  less: ['@x: 1; a { b: @x }', 'a { "x }'],
  html: ['<!doctype html><html><body><p>a<br><img src="x>"><li>b</body></html>', '<div><span></div>', '</div>', '<br></br>', '<div', '<a href="x>',
    '<!-- x', '<script>f(</script>', '<script type="text/template">f(</script>', '<SCRIPT TYPE=Module>f(</Script>', '<style>a { b: \'c }</style>', '<script>f(', '<DİV></div><p>'],
  xml: ['<a><!-- <b> --><![CDATA[<c>]]><?x y?><d/></a>', '<A></a>', '<a><b></a>', '<![CDATA[ x'],
  py: ['def f(a,\n      b):\n    if a:\n        return b\n', 'if x\n    y', 'for x in y:\nz', 'x = {1:\n2}:\ny', 'x\n  y', 'if a:\n    b\n  c', 'if a:\n\tb\n        c', "x = 'a\nif y", 's = """\n odd\n"""', 'async  def f():\n    pass', 'x = 1 \\\n  + 2'],
  java: ['class A { String s = """\n  ( text\n"""; }', 'void f() { g(', '@A("x) void f() {}'],
  rs: ["fn f<'a>(x: &'a str) -> char { let c = '('; let q = '\"'; let e = '\\''; b'[' } fn g() -> u8 { b'\"' }", 'let s = r#"abc"', 'let s = "abc', 'fn f() {', '/* x', 'let s = "a\nb (";', 'let s = "x\\'],
  js: ['const a = `x ${ {b: 1} } y`;', 'f(`${ a`)', 'x = /[)]/; y = a / b / c', "it's", 'a = { b: [ ( ] }', 'http://x (', 'return /a(/ ;'],
  jsx: ["<p>it's</p>", 'const x = <a href="(">{y}</a>;'],
};

// Pieces that matter to some check, joined at random: the generated texts reach the corners the samples miss.
const PIECES = ['(', ')', '[', ']', '{', '}', "'", '"', '`', '/', '*', '\\', '\n', ':', ';', '#', '<', '>', '=', '!', ',', '@', '$', '-',
  'a', 'b', 'r', 'é', 'İ', '😀', ' ', '\t', '    ', '//', '/*', '*/', '${', '"""', "'''", '<div>', '</div>', '<br>', '<p>', '<script>', '</script>',
  '<style>', '</style>', '<!--', '-->', '<![CDATA[', ']]>', '<?', 'if x:', 'def f():', 'else', 'async ', 'r#"', '"#', "b'", 'return ', 'true', 'null',
  '1.5e3', '-0', 'x: y', 'type=module', ' type="x"'];

test('the engine reports exactly what the page reports', { skip, timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-lint-'));
  const file = path.join(dir, 'f.txt');
  fs.writeFileSync(file, '');
  const e = new Engine({ exe, journalDir: path.join(dir, 'j') });
  let seed = 4242;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
  try {
    const { doc } = await e.request('open', { path: file });
    const check = async (kind, text) => {
      await e.request('edit', { doc, start: { line: 0, col: 0 }, end: { line: 2 ** 31 - 1, col: 0 }, text, kind: 'other' });
      const r = await e.request('lint', { doc, kind });
      const want = plain(toDiags(text, lintStructure(text, FILES[kind])));
      assert.deepEqual(r.diags, want, `${kind}: ${JSON.stringify(text)}`);
      return want.length;
    };
    let found = 0;
    for (const [kind, texts] of Object.entries(SAMPLES)) for (const text of texts) found += await check(kind, text);
    assert.ok(found > 40, `the samples find problems (${found})`);
    for (const kind of Object.keys(FILES)) {
      for (let n = 0; n < 1500; n++) {
        const text = Array.from({ length: next() % 80 }, () => PIECES[next() % PIECES.length]).join('');
        await check(kind, text);
      }
    }
  } finally { e.stop(); }
});
