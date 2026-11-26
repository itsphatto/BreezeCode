const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
// preview.ts touches the DOM at load, so only the source-finding and edit-writing helpers are lifted out of it.
const src = stripTypeScriptTypes(fs.readFileSync(require.resolve('../src/renderer/breeze/preview.ts'), 'utf8'));
const code = src.slice(src.indexOf('function inspectedOffset'), src.indexOf('async function readPreviewSource'));
const lifted = vm.runInContext(`${code}; ({ findInspectedSource, applyInspectedEdit })`, vm.createContext({}));
const plain = (v) => JSON.parse(JSON.stringify(v)); // results come from another realm
const findInspectedSource = (s, e) => plain(lifted.findInspectedSource(s, e));
const { applyInspectedEdit } = lifted;

const html = '<!doctype html>\n<body>\n  <div class="a">one</div>\n  <div id="hero.x" class="b">two</div>\n  <p>three</p>\n</body>';
const el = (o) => ({ id: '', classes: [], text: '', index: -1, ...o });

test('findInspectedSource finds a tag by its id, escaping regex characters', () => {
  assert.deepEqual(findInspectedSource(html, [el({ tag: 'div', id: 'hero.x', classes: ['b'], index: 5 })]), { line: 3, col: 2, len: 4 });
});

test('findInspectedSource falls back to the nth tag of its kind', () => {
  assert.deepEqual(findInspectedSource(html, [el({ tag: 'div', classes: ['a'], index: 0 })]), { line: 2, col: 2, len: 4 });
  assert.deepEqual(findInspectedSource(html, [el({ tag: 'p', index: 0 })]), { line: 4, col: 2, len: 2 });
});

test('findInspectedSource skips a tag whose source classes the element lacks, for its ancestor', () => {
  // A script-built div counted as the first div would land on div.a; it has no class "a", so the <p> is used.
  assert.deepEqual(findInspectedSource(html, [el({ tag: 'div', index: 0 }), el({ tag: 'p', index: 0 })]), { line: 4, col: 2, len: 2 });
});

test('findInspectedSource gives up on a missing element or a bad tag', () => {
  assert.equal(findInspectedSource(html, [el({ tag: 'span', index: 0 })]), null);
  assert.equal(findInspectedSource(html, [el({ tag: 'div', index: 9 })]), null);
  assert.equal(findInspectedSource(html, [el({ tag: 'div)(', index: 0 })]), null);
});

test('applyInspectedEdit replaces a changed text node inside its own element only', () => {
  const page = '<p>one</p>\n<p>one <b>bold</b> two</p>';
  assert.equal(applyInspectedEdit(page, [el({ tag: 'p', index: 1 })], [{ from: 'one ', to: 'uno ' }, { from: ' two', to: ' & dos' }]),
    '<p>one</p>\n<p>uno <b>bold</b> &amp; dos</p>');
});

test('applyInspectedEdit finds text the page saw decoded from entities', () => {
  const page = '<h1 id="t">Tom &amp; Jerry</h1>';
  assert.equal(applyInspectedEdit(page, [el({ tag: 'h1', id: 't' })], [{ from: 'Tom & Jerry', to: 'Tom <3' }]), '<h1 id="t">Tom &lt;3</h1>');
});

test('applyInspectedEdit writes plain spaces as spaces and only real non-breaking ones as &nbsp;', () => {
  assert.equal(applyInspectedEdit('<p>a&nbsp;b c</p>', [el({ tag: 'p', index: 0 })], [{ from: 'a b c', to: 'x y z' }]), '<p>x&nbsp;y z</p>');
});

test('applyInspectedEdit puts a script-split line into its heading, not a later element with the same words', () => {
  // GSAP SplitText wraps the h1's lines in divs (two per line: mask and line); the page's 1st div is one of those.
  const page = '<div class="hero"><h1>Code at blazing speed.</h1></div>\n<div class="cta"><p>Code at blazing speed.</p></div>';
  const chain = [el({ tag: 'div', index: 2 }), el({ tag: 'div', index: 1 }), el({ tag: 'h1', index: 0 }), el({ tag: 'div', classes: ['hero'], index: 0 })];
  assert.equal(applyInspectedEdit(page, chain, [{ from: 'Code at blazing ', to: 'Code at fast ' }]),
    '<div class="hero"><h1>Code at fast speed.</h1></div>\n<div class="cta"><p>Code at blazing speed.</p></div>');
});

test('applyInspectedEdit keeps to the element and refuses what it cannot place', () => {
  assert.equal(applyInspectedEdit('<p>one</p><p>two</p>', [el({ tag: 'p', index: 0 })], [{ from: 'two', to: 'y' }]), null);
  assert.equal(applyInspectedEdit('<p>one</p>', [el({ tag: 'p', index: 3 })], [{ from: 'one', to: 'y' }]), null);
  assert.equal(applyInspectedEdit('<p>one</p>', [el({ tag: 'p', index: 0 })], [{ from: '', to: 'y' }]), null);
});

test('applyInspectedEdit matches nested same-name tags to find the closing tag', () => {
  const page = '<div class="o"><div class="i">a</div>b</div><div class="z">b</div>';
  assert.equal(applyInspectedEdit(page, [el({ tag: 'div', classes: ['o'], index: 0 })], [{ from: 'b', to: 'B' }]),
    '<div class="o"><div class="i">a</div>B</div><div class="z">b</div>');
});
