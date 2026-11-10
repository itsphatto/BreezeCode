const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const ctx = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(fs.readFileSync(require.resolve('../src/renderer/bigcore.ts'), 'utf8')), ctx);
const { BIG_LONG_LINE, posCmp, posMin, posMax, posAfterInsert, lineDelta, LineCache, bigMove } =
  vm.runInContext('({ BIG_LONG_LINE, posCmp, posMin, posMax, posAfterInsert, lineDelta, LineCache, bigMove })', ctx);

const P = (line, col) => ({ line, col });
// Values from a vm context have another prototype, so compare JSON-plain copies.
const eq = (a, b) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b);
const L = (...t) => t.map(text => ({ text, len: text.length }));
const texts = c => c.items.map(i => i.text);

test('BIG_LONG_LINE matches the engine cut', () => { assert.equal(BIG_LONG_LINE, 10000); });
test('posCmp, posMin, posMax', () => {
  assert.ok(posCmp(P(1, 5), P(2, 0)) < 0); assert.ok(posCmp(P(2, 1), P(2, 0)) > 0); assert.equal(posCmp(P(2, 1), P(2, 1)), 0);
  eq(posMin(P(1, 5), P(2, 0)), P(1, 5)); eq(posMax(P(1, 5), P(2, 0)), P(2, 0)); eq(posMax(P(3, 1), P(3, 1)), P(3, 1));
});
test('posAfterInsert', () => { eq(posAfterInsert({ line: 2, col: 3 }, 'ab'), { line: 2, col: 5 }); eq(posAfterInsert({ line: 2, col: 3 }, 'a\nbc\nd'), { line: 4, col: 1 }); });
test('lineDelta', () => { assert.equal(lineDelta(P(0,0), P(0,0), 'a\nb'), 1); assert.equal(lineDelta(P(1,0), P(3,2), ''), -2); assert.equal(lineDelta(P(1,0), P(2,0), 'x\ny'), 0); });
test('put then get', () => { const c = new LineCache(); assert.equal(c.put(10, L('a', 'b'), 0), true); assert.equal(c.get(11).text, 'b'); assert.equal(c.get(12), undefined); assert.equal(c.covers(10, 12), true); assert.equal(c.covers(9, 11), false); assert.equal(c.last, 12); });
test('apply: typing in a line', () => { const c = new LineCache(); c.put(0, L('ab', 'cd'), 0); c.apply(P(0,1), P(0,1), 'X'); eq(texts(c), ['aXb', 'cd']); assert.equal(c.items[0].len, 3); assert.equal(c.rev, 1); });
test('apply: Enter splits, Backspace at line start joins', () => { const c = new LineCache(); c.put(5, L('abcd', 'ef'), 0); c.apply(P(5,2), P(5,2), '\n'); eq(texts(c), ['ab', 'cd', 'ef']); c.apply(P(5,2), P(6,0), ''); eq(texts(c), ['abcd', 'ef']); assert.equal(c.first, 5); });
test('apply: multi-line paste over a multi-line selection', () => { const c = new LineCache(); c.put(0, L('one', 'two', 'three'), 0); c.apply(P(0,1), P(2,2), 'A\nB'); eq(texts(c), ['oA', 'Bree']); assert.deepEqual(c.items.map(i => i.len), [2, 4]); });
test('apply: an edit reaching outside the cache clears it', () => { const c = new LineCache(); c.put(10, L('a', 'b'), 0); c.apply(P(3,0), P(10,1), ''); assert.equal(c.items.length, 0); assert.equal(c.rev, 1); });
test('apply: an edit above the cache clears it', () => { const c = new LineCache(); c.put(10, L('a', 'b'), 0); c.apply(P(2,0), P(2,0), 'x\n'); assert.equal(c.items.length, 0); });
test('apply: an edit below the cache clears it', () => { const c = new LineCache(); c.put(10, L('a', 'b'), 0); c.apply(P(12,0), P(12,0), 'x'); assert.equal(c.items.length, 0); assert.equal(c.rev, 1); });
test('a stale fetch never overwrites newer local text', () => {
  const c = new LineCache(); c.put(0, L('ab'), 0);
  c.apply(P(0,2), P(0,2), 'c');                    // local rev is now 1
  assert.equal(c.put(0, L('ab'), 0), false);       // the reply to a fetch sent before the edit
  eq(texts(c), ['abc']);
  assert.equal(c.put(0, L('abc'), 1), true);       // the engine caught up
  assert.equal(c.rev, 1);
});
test('apply: a cut line clears the cache', () => { const c = new LineCache(); c.put(0, [{ text: 'x'.repeat(10000), len: 50000 }], 0); c.apply(P(0,5), P(0,5), 'y'); assert.equal(c.items.length, 0); });
test('apply: a cut line at the end of the range clears the cache', () => { const c = new LineCache(); c.put(0, [{ text: 'a', len: 1 }, { text: 'x'.repeat(10000), len: 50000 }], 0); c.apply(P(0,0), P(1,3), ''); assert.equal(c.items.length, 0); });
test('apply: an uncut line in the cache is not cleared by a cut one elsewhere', () => { const c = new LineCache(); c.put(0, [{ text: 'a', len: 1 }, { text: 'x'.repeat(10000), len: 50000 }], 0); c.apply(P(0,1), P(0,1), 'b'); assert.equal(c.items.length, 2); assert.equal(c.items[0].text, 'ab'); });
test('clear empties the cache', () => { const c = new LineCache(); c.put(0, L('a'), 0); c.clear(); assert.equal(c.items.length, 0); assert.equal(c.get(0), undefined); assert.equal(c.covers(0, 1), false); });
test('bigMove', () => {
  const lens = [3, 0, 5], lenOf = l => lens[l], textOf = l => ['a😀', '', 'hello'][l], m = { shift: false, ctrl: false };
  const mv = (line, col, key, mods = m, goal = null) => bigMove(P(line, col), key, mods, 3, 2, goal, lenOf, textOf);
  eq(mv(0, 3, 'ArrowRight').head, P(1, 0)); eq(mv(1, 0, 'ArrowLeft').head, P(0, 3));
  eq(mv(0, 1, 'ArrowRight').head, P(0, 3));        // over the surrogate pair
  eq(mv(0, 3, 'ArrowLeft').head, P(0, 1));
  eq(mv(0, 0, 'ArrowLeft').head, P(0, 0)); eq(mv(2, 5, 'ArrowRight').head, P(2, 5));
  const down = mv(2, 4, 'ArrowUp'); eq(down.head, P(1, 0)); assert.equal(down.goal, 4);
  eq(mv(1, 0, 'ArrowUp', m, 4).head, P(0, 3));     // goal 4 clamps to the line's length
  eq(mv(0, 1, 'End').head, P(0, 3)); eq(mv(2, 3, 'Home').head, P(2, 0));
  eq(mv(1, 0, 'End', { shift: false, ctrl: true }).head, P(2, 5)); eq(mv(2, 2, 'Home', { shift: false, ctrl: true }).head, P(0, 0));
  eq(mv(0, 0, 'PageDown').head, P(2, 0)); eq(mv(2, 0, 'PageUp').head, P(0, 0));
  eq(bigMove(P(0, 2), 'ArrowDown', m, 3, 2, null, () => undefined).head, P(1, 2));   // uncached: column kept
});
test('bigMove: goal is reused by vertical moves and dropped by horizontal ones', () => {
  const lens = [10, 2, 10], lenOf = l => lens[l], m = { shift: false, ctrl: false };
  const a = bigMove(P(0, 8), 'ArrowDown', m, 3, 2, null, lenOf); eq(a.head, P(1, 2)); assert.equal(a.goal, 8);
  const b = bigMove(a.head, 'ArrowDown', m, 3, 2, a.goal, lenOf); eq(b.head, P(2, 8)); assert.equal(b.goal, 8);
  assert.equal(bigMove(b.head, 'ArrowLeft', m, 3, 2, b.goal, lenOf).goal, null);
  assert.equal(bigMove(b.head, 'Home', m, 3, 2, b.goal, lenOf).goal, null);
  assert.equal(bigMove(b.head, 'End', m, 3, 2, b.goal, lenOf).goal, null);
});
test('bigMove: the first and last line edges, and a cut line without text', () => {
  const lenOf = () => 4, m = { shift: false, ctrl: false };
  eq(bigMove(P(0, 2), 'ArrowUp', m, 3, 2, null, lenOf).head, P(0, 0));
  eq(bigMove(P(2, 1), 'ArrowDown', m, 3, 2, null, lenOf).head, P(2, 4));
  eq(bigMove(P(0, 1), 'ArrowRight', m, 3, 2, null, lenOf).head, P(0, 2));   // no textOf: one unit
  eq(bigMove(P(0, 2), 'ArrowLeft', m, 3, 2, null, lenOf).head, P(0, 1));
});
test('bigMove: a vertical move never lands inside a surrogate pair', () => {
  const lenOf = l => [4, 4][l], textOf = l => ['abcd', 'a😀b'][l], m = { shift: false, ctrl: false };
  eq(bigMove(P(0, 2), 'ArrowDown', m, 2, 2, null, lenOf, textOf).head, P(1, 1));
});
test('apply: a huge paste never throws, and clears the cache with rev bumped once', () => {
  const c = new LineCache(); c.put(0, L('ab'), 0);
  assert.doesNotThrow(() => c.apply(P(0, 1), P(0, 1), 'x\n'.repeat(300000)));
  assert.equal(c.items.length, 0); assert.equal(c.rev, 1);
});
test('apply: a paste of exactly the line bound is held, one line over clears', () => {
  const max = vm.runInContext('BIG_CACHE_EDIT_LINES', ctx);
  assert.equal(max, 2000);
  const c = new LineCache(); c.put(0, L('ab', 'cd'), 0);
  c.apply(P(0, 1), P(0, 1), '\n'.repeat(max - 1));            // max new lines in all from the first line
  assert.equal(c.items.length, max + 1); assert.equal(c.items[0].text, 'a'); assert.equal(c.items[max - 1].text, 'b'); assert.equal(c.items[max].text, 'cd'); assert.equal(c.rev, 1);
  const d = new LineCache(); d.put(0, L('ab', 'cd'), 0);
  d.apply(P(0, 1), P(0, 1), '\n'.repeat(max));
  assert.equal(d.items.length, 0); assert.equal(d.rev, 1);
});
test('apply: an ordinary 3-line paste in the middle of the cache', () => {
  const c = new LineCache(); c.put(4, L('one', 'two', 'three'), 0);
  c.apply(P(5, 1), P(5, 2), 'A\nB\nC'); eq(texts(c), ['one', 'tA', 'B', 'Co', 'three']); assert.equal(c.first, 4);
});
test('bigMove: End and Down past the last line never land inside a cut surrogate pair', () => {
  const text = 'x'.repeat(9999) + '\uD83D', m = { shift: false, ctrl: false };   // the engine cut a pair after its high half
  const lenOf = () => 10000, textOf = () => text;
  eq(bigMove(P(0, 5), 'End', m, 1, 2, null, lenOf, textOf).head, P(0, 9999));
  eq(bigMove(P(0, 5), 'ArrowDown', m, 1, 2, null, lenOf, textOf).head, P(0, 9999));
  eq(bigMove(P(0, 5), 'End', { shift: false, ctrl: true }, 1, 2, null, lenOf, textOf).head, P(0, 9999));
  eq(bigMove(P(0, 5), 'End', m, 1, 2, null, lenOf).head, P(0, 10000));            // no text: the caller clamps
});
