const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, evaluate, fromRow, show, hitMatches, formatLog, checkJavaBp } = require('../src/main/javaexpr');

// Rows as debugJava.show() makes them: a paused frame with an int, a String, a char, an array, a null and an object.
const ROWS = {
  x: { name: 'x', value: '2', type: 'int', ref: 0 },
  big: { name: 'big', value: '2147483647', type: 'int', ref: 0 },
  n: { name: 'n', value: '5', type: 'Integer', ref: 0 },
  name: { name: 'name', value: '"bob"', type: 'String', ref: 0 },
  c: { name: 'c', value: "'q'", type: 'char', ref: 0 },
  nums: { name: 'nums', value: 'int[3]', type: 'int[]', ref: 1 },
  none: { name: 'none', value: 'null', type: '', ref: 0 },
  p: { name: 'p', value: 'Point', type: 'Point', ref: 2 },
};
const FIELDS = { 2: { x: { name: 'x', value: '7', type: 'int', ref: 0 }, label: { name: 'label', value: 'null', type: '', ref: 0 } } };
const ELEMS = [4, 5, 6];
const R = {
  async name(id) { if (!ROWS[id]) throw new Error(`${id} isn't a variable here`); return fromRow(ROWS[id]); },
  async field(of, name) { const f = FIELDS[of.row.ref]?.[name]; if (!f) throw new Error(`no field ${name}`); return fromRow(f); },
  async element(of, i) { if (i < 0 || i >= ELEMS.length) throw new Error('ArrayIndexOutOfBoundsException'); return fromRow({ name: `[${i}]`, value: String(ELEMS[i]), type: 'int', ref: 0 }); },
};
const run = async src => show(await evaluate(parse(src), R));

test('javaexpr: arithmetic follows Java (int division, wrap-around, promotion)', async () => {
  assert.equal(await run('x + nums[1] * 2'), '12');
  assert.equal(await run('7 / 2'), '3');
  assert.equal(await run('-7 / 2'), '-3');
  assert.equal(await run('7 % 3'), '1');
  assert.equal(await run('7 / 2.0'), '3.5');
  assert.equal(await run('big + 1'), '-2147483648');
  assert.equal(await run('big + 1L'), '2147483648');
  assert.equal(await run('n * 2'), '10');
  assert.equal(await run("c + 1"), '114');
  assert.equal(await run('0x10 + 1'), '17');
  await assert.rejects(run('x / 0'), /by zero/);
});

test('javaexpr: comparisons, logic, ?: and strings', async () => {
  assert.equal(await run('x > 1 && !(x == 3) || false'), 'true');
  assert.equal(await run('name == "bob"'), 'true');
  assert.equal(await run('name.equals("bob") && name.length() == 3'), 'true');
  assert.equal(await run('name.startsWith("b") ? "yes" : "no"'), '"yes"');
  assert.equal(await run('"n=" + x + c'), '"n=2q"');
  assert.equal(await run("c == 'q'"), 'true');
  assert.equal(await run('name.charAt(1)'), "'o'");
  assert.equal(await run('"a\\"b".length()'), '3');
  assert.equal(await run("'\"' == '\"'"), 'true');
  assert.equal(await run('none == null'), 'true');
  assert.equal(await run('p.label == null && p.x == 7'), 'true');
  await assert.rejects(run('p == p'), /compare/);
  await assert.rejects(run('x && true'), /true or false/);
});

test('javaexpr: arrays, nulls and refused method calls', async () => {
  assert.equal(await run('nums.length'), '3');
  assert.equal(await run('nums[nums.length - 1]'), '6');
  assert.equal(await run('nums'), 'int[3]');
  await assert.rejects(run('nums[3]'), /OutOfBounds/);
  await assert.rejects(run('none.length()'), /NullPointerException/);
  await assert.rejects(run('p.toString()'), /can't run methods/);
  await assert.rejects(run('missing + 1'), /isn't a variable/);
});

test('javaexpr: parse errors say where', () => {
  assert.throws(() => parse('x >'), /ends too soon/);
  assert.throws(() => parse('x ) 1'), /Unexpected "\)" at 3/);
  assert.throws(() => parse('(x + 1'), /Expected "\)"/);
  assert.throws(() => parse('x # 1'), /Unexpected "#"/);
  assert.throws(() => parse(''), /Type an expression/);
});

test('javaexpr: hit counts, logpoints and breakpoint checks', async () => {
  assert.equal(hitMatches('3', 2), false);
  assert.equal(hitMatches('3', 3), true);
  assert.equal(hitMatches('== 3', 4), false);
  assert.equal(hitMatches('%2', 4), true);
  assert.equal(hitMatches('> 1', 2), true);
  assert.equal(hitMatches('soon', 1), null);
  assert.equal(await formatLog('x={x}, name={name.toUpperCase()}, bad={nope}', R), "x=2, name=BOB, bad=<error: nope isn't a variable here>");
  assert.equal(checkJavaBp({ condition: 'x > 1;' }), null);
  assert.match(checkJavaBp({ condition: 'x >' }), /^Condition:/);
  assert.match(checkJavaBp({ logMessage: 'v={x +}' }), /^Log message/);
  assert.match(checkJavaBp({ hitCondition: 'often' }), /^Hit count/);
});
