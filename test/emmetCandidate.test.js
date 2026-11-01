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
// editor.ts's highlighted(), minus the cache and the incremental lexing.
vm.runInContext("var highlighted = (b) => { const lexer = langOf(b.path)[0]; return { text: b.text, lexer, ...fullToks(b.text, lexer) }; };", ctx);
load('../src/renderer/breeze/emmet.ts');
const { emmetSyntaxOf, emmetCandidate } = vm.runInContext('({ emmetSyntaxOf, emmetCandidate })', ctx);

// `marked` has | where the caret is. Returns the candidate's abbr and syntax, or null.
function cand(path, marked, selEnd) {
  const caret = marked.indexOf('|'), text = marked.replace('|', '');
  const ta = { value: text, selectionStart: caret, selectionEnd: selEnd ?? caret };
  const c = emmetCandidate({ path, text }, ta);
  return c && `${c.syntax}:${c.abbr}`;
}

test('emmetSyntaxOf maps file types to the eight emmet syntaxes', () => {
  const syn = (path) => emmetSyntaxOf({ path });
  assert.equal(syn('a/index.html'), 'html');
  assert.equal(syn('x.HTM'), 'html');
  assert.equal(syn('x.xhtml'), 'html');
  assert.equal(syn('x.xml'), 'xml');
  assert.equal(syn('logo.svg'), 'xml');
  assert.equal(syn('x.jsx'), 'jsx');
  assert.equal(syn('x.tsx'), 'jsx');
  assert.equal(syn('x.vue'), 'vue');
  assert.equal(syn('x.svelte'), 'svelte');
  assert.equal(syn('x.css'), 'css');
  assert.equal(syn('x.scss'), 'scss');
  assert.equal(syn('x.less'), 'less');
  for (const p of ['x.js', 'x.ts', 'x.md', 'x.json', 'Dockerfile', 'x.sass', 'noext']) assert.equal(syn(p), null, p);
});

test('a markup abbreviation is found before the caret', () => {
  assert.equal(cand('a.html', '<body>\n  ul>li.item*3|\n</body>'), 'html:ul>li.item*3');
  assert.equal(cand('a.html', '<div>x</div> p.a|'), 'html:p.a');
  assert.equal(cand('a.vue', 'div#app|'), 'vue:div#app');
  assert.equal(cand('a.html', 'a:b|'), 'html:a:b'); // colon forms are real snippets (a:link)
});

test('no candidate with a selection, at the start of the file, or for unsupported files', () => {
  assert.equal(cand('a.html', '|ul>li'), null);
  assert.equal(cand('a.html', 'ul>li|', 0), null); // selectionEnd differs from the caret
  assert.equal(cand('a.js', 'ul>li|'), null);
  assert.equal(cand('a.html', 'hello|'), null);
  assert.equal(cand('a.html', 'ul>li|'.padStart(1100, ' ')), null); // a minified-length line
});

test('markup prose is not an abbreviation', () => {
  for (const prose of ['end.', 'Hello:', '1+1', '3*4', '9ul', 'li>', 'ul>li+', 'a^']) assert.equal(cand('a.html', `x ${prose}|`), null, prose);
});

test('script and style blocks hold code, not markup', () => {
  assert.equal(cand('a.html', '<script>\n  console.log|\n</script>'), null);
  assert.equal(cand('a.html', '<style>\n  ul>li|\n</style>'), null);
  assert.equal(cand('a.html', '<script>x</script>\n<body>\n  ul>li|\n</body>'), 'html:ul>li');
  assert.equal(cand('a.html', '<style>a{}</style><p>ul>li|</p>'), 'html:ul>li');
});

test('not inside a string or a comment', () => {
  assert.equal(cand('a.html', '<p class="ul>li|">x</p>'), null);
  assert.equal(cand('a.html', '<!-- ul>li| -->'), null);
  assert.equal(cand('a.jsx', 'const s = "div.foo|";'), null);
  assert.equal(cand('a.css', 'a { /* df| */ }'), null);
});

test('jsx needs a known tag at the head of the abbreviation', () => {
  assert.equal(cand('a.jsx', '<div>\n  div.foo>p|\n</div>'), 'jsx:div.foo>p');
  assert.equal(cand('a.tsx', '<div>\n  ul>li|\n</div>'), 'jsx:ul>li');
  assert.equal(cand('a.jsx', 'props.items|'), null);
  assert.equal(cand('a.tsx', 'this.x|'), null);
});

test('stylesheets expand inside a rule only', () => {
  assert.equal(cand('a.css', 'a {\n  df|\n}'), 'css:df');
  assert.equal(cand('a.scss', 'a {\n  m10|\n}'), 'scss:m10');
  assert.equal(cand('a.css', 'a {\n  color: red|\n}'), null); // a value, not a declaration start
  assert.equal(cand('a.css', 'body|'), null); // a selector outside any rule
  assert.equal(cand('a.css', 'a { color: red; }\nbody|'), null);
});
