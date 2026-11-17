const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const ctx = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(fs.readFileSync(require.resolve('../src/renderer/editcore.ts'), 'utf8')), ctx);
const { tagToAutoClose, tagPairAt } = vm.runInContext('({ tagToAutoClose, tagPairAt })', ctx);
const plain = (v) => JSON.parse(JSON.stringify(v));

test('tagToAutoClose names the tag a typed > finishes', () => {
  assert.equal(tagToAutoClose('<a', false), 'a');
  assert.equal(tagToAutoClose('<p>hi <div class="x>y" id=z', false), 'div');
  assert.equal(tagToAutoClose('text<b', false), 'b');
  assert.equal(tagToAutoClose('<br', false), null);
  assert.equal(tagToAutoClose('<br', true), 'br');
  assert.equal(tagToAutoClose('<img src="a" /', false), null);
  assert.equal(tagToAutoClose('<!-- <a', false), null);
  assert.equal(tagToAutoClose('a <', false), null);
  assert.equal(tagToAutoClose('<div class="a', false), null);
  assert.equal(tagToAutoClose('return <Button onClick={() => go()}', true, true), 'Button');
  assert.equal(tagToAutoClose('return <Button onClick={() =', true, true), null);
  assert.equal(tagToAutoClose('const xs: Array<string', true, true), null);
  assert.equal(tagToAutoClose('const f = <T,', true, true), null);
});

test('tagPairAt links an opening and closing tag name', () => {
  const t = '<div><a href="x">hi</a></div>';
  //         0123456789...
  assert.deepEqual(plain(tagPairAt(t, 6, 6, false)), { self: [6, 7], other: [21, 22] });
  assert.deepEqual(plain(tagPairAt(t, 21, 22, false)), { self: [21, 22], other: [6, 7] });
  assert.deepEqual(plain(tagPairAt(t, 1, 4, false)), { self: [1, 4], other: [25, 28] });
  assert.equal(tagPairAt(t, 9, 9, false), null); // in an attribute
  assert.equal(tagPairAt(t, 18, 18, false), null); // in the text
  assert.equal(tagPairAt('<a><b></a>', 4, 4, false), null); // <b> is never closed
  assert.equal(tagPairAt('<br><p></p>', 2, 2, false), null);
  assert.deepEqual(plain(tagPairAt('<DIV>x</div>', 2, 2, false)), { self: [1, 4], other: [8, 11] });
  assert.equal(tagPairAt('<DIV>x</div>', 2, 2, true), null);
  assert.deepEqual(plain(tagPairAt('<>x</>', 1, 1, true)), { self: [1, 1], other: [5, 5] });
  assert.deepEqual(plain(tagPairAt('<ul><li>a</li><li>b</li></ul>', 15, 15, false)), { self: [15, 17], other: [21, 23] });
  assert.deepEqual(plain(tagPairAt('<script>if (a<b>c) {}</script>', 2, 2, false)), { self: [1, 7], other: [23, 29] });
  assert.deepEqual(plain(tagPairAt('<x><!-- <x> --></x>', 1, 1, true)), { self: [1, 2], other: [17, 18] });
});
