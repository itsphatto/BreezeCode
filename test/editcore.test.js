const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const ctx = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(fs.readFileSync(require.resolve('../src/renderer/editcore.ts'), 'utf8')), ctx);
const { lineStarts, colAtVisual, wordLeft, wordRight, wordAt, moveCaret, deleteSpan, openTagAt } =
  vm.runInContext('({ lineStarts, colAtVisual, wordLeft, wordRight, wordAt, moveCaret, deleteSpan, openTagAt })', ctx);

const T = 'ab cd\n  ef\n\nxyz';           // lines start at 0, 6, 11, 12; length 15
const S = lineStarts(T);
const mv = (off, key, o = {}) => moveCaret(T, S, o.sel ?? { anchor: off, head: off }, key,
  { shift: !!o.shift, ctrl: !!o.ctrl }, o.page ?? 10, o.goal ?? null);
const plain = (v) => JSON.parse(JSON.stringify(v));

test('lineStarts finds every line start', () => {
  assert.deepEqual(plain(lineStarts(T)), [0, 6, 11, 12]);
});

test('arrow keys move, extend and collapse selections', () => {
  assert.deepEqual(plain(mv(0, 'ArrowRight').sel), { anchor: 1, head: 1 });
  assert.deepEqual(plain(mv(0, 'ArrowRight', { shift: true }).sel), { anchor: 0, head: 1 });
  assert.deepEqual(plain(mv(0, 'ArrowLeft', { sel: { anchor: 1, head: 4 } }).sel), { anchor: 1, head: 1 });
  assert.deepEqual(plain(mv(0, 'ArrowRight', { sel: { anchor: 4, head: 1 } }).sel), { anchor: 4, head: 4 });
});

test('vertical moves keep a goal column', () => {
  const a = mv(4, 'ArrowDown');
  assert.equal(a.sel.head, 10);
  assert.equal(a.goal, 4);
  const b = mv(10, 'ArrowDown', { goal: 4 });
  assert.equal(b.sel.head, 11);
  assert.equal(b.goal, 4);
  assert.equal(mv(11, 'ArrowDown', { goal: 4 }).sel.head, 15);
});

test('vertical moves clamp at the document edges', () => {
  assert.equal(mv(3, 'ArrowUp').sel.head, 0);
  assert.equal(mv(13, 'ArrowDown').sel.head, 15);
});

test('Home is smart and End/ctrl variants work', () => {
  assert.equal(mv(10, 'Home').sel.head, 8);
  assert.equal(mv(8, 'Home').sel.head, 6);
  assert.equal(mv(7, 'End').sel.head, 10);
  assert.equal(mv(7, 'Home', { ctrl: true }).sel.head, 0);
  assert.equal(mv(7, 'End', { ctrl: true }).sel.head, 15);
});

test('ctrl+arrows move by word', () => {
  assert.equal(mv(0, 'ArrowRight', { ctrl: true }).sel.head, 2);
  assert.equal(mv(2, 'ArrowRight', { ctrl: true }).sel.head, 5);
  assert.equal(mv(5, 'ArrowRight', { ctrl: true }).sel.head, 6);
  assert.equal(mv(5, 'ArrowLeft', { ctrl: true }).sel.head, 3);
  assert.equal(mv(3, 'ArrowLeft', { ctrl: true }).sel.head, 0);
});

test('PageDown moves by page lines', () => {
  assert.equal(mv(0, 'PageDown', { page: 2 }).sel.head, 11);
});

test('horizontal moves reset the goal column', () => {
  assert.equal(mv(10, 'ArrowLeft', { goal: 4 }).goal, null);
});

test('surrogate pairs are never split', () => {
  const E = 'a😀b';
  assert.equal(moveCaret(E, lineStarts(E), { anchor: 1, head: 1 }, 'ArrowRight', { shift: false, ctrl: false }, 10, null).sel.head, 3);
  assert.deepEqual(plain(deleteSpan(E, { anchor: 3, head: 3 }, 'Backspace', false)), [1, 3]);
});

test('deleteSpan covers selections, chars and words', () => {
  assert.deepEqual(plain(deleteSpan(T, { anchor: 4, head: 4 }, 'Backspace', false)), [3, 4]);
  assert.deepEqual(plain(deleteSpan(T, { anchor: 1, head: 4 }, 'Backspace', false)), [1, 4]);
  assert.deepEqual(plain(deleteSpan(T, { anchor: 5, head: 5 }, 'Backspace', true)), [3, 5]);
  assert.deepEqual(plain(deleteSpan(T, { anchor: 15, head: 15 }, 'Delete', false)), [15, 15]);
  assert.deepEqual(plain(deleteSpan(T, { anchor: 0, head: 0 }, 'Backspace', false)), [0, 0]);
  assert.deepEqual(plain(deleteSpan(T, { anchor: 0, head: 0 }, 'Delete', true)), [0, 2]);
});

test('colAtVisual maps visual columns to indices', () => {
  assert.equal(colAtVisual('\tab', 5), 2);
  assert.equal(colAtVisual('\tab', 1), 0);
  assert.equal(colAtVisual('abc', 99), 3);
});

test('wordAt returns the run around an offset', () => {
  assert.deepEqual(plain(wordAt('foo.bar baz', 5)), [4, 7]);
  assert.deepEqual(plain(wordAt('foo.bar baz', 3)), [3, 4]);
  assert.deepEqual(plain(wordAt('foo.bar baz', 7)), [4, 7]);
});

test('word jumps skip whitespace', () => {
  assert.equal(wordRight('a  b', 1), 4);
  assert.equal(wordLeft('a  b', 3), 0);
});

test('openTagAt finds the element a closing tag should close', () => {
  // `at` is where the '<' of the new closing tag sits: the end of each sample.
  const open = (t, xml = false) => openTagAt(t, t.length, xml);
  assert.equal(open('<test>hello '), 'test');
  assert.equal(open('<div class="a>b"><span>x</span>'), 'div');
  assert.equal(open('<ul>\n  <li>a</li>\n  <li>b'), 'li');
  assert.equal(open('<p>a<br><img src=x><input/>'), 'p');
  assert.equal(open('<Div>x', false), 'Div');
  assert.equal(open('<a><b>x</a>'), null);
  assert.equal(open('<a></a>'), null);
  assert.equal(open('<x><!-- <y> --> '), 'x');
  assert.equal(open('<x><!-- note '), null);
  assert.equal(open('<script>if (a < b) { s = "<div>" } '), 'script');
  assert.equal(open('<body><script>"<i>"</script> '), 'body');
  assert.equal(open('<Foo.Bar><Baz/>', true), 'Foo.Bar');
  assert.equal(open('<g><circle r="1"/><rect></rect>', true), 'g');
  assert.equal(open('plain text'), null);
});
