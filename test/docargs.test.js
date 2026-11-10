const test = require('node:test');
const assert = require('node:assert/strict');
const a = require('../src/main/docargs.js');
const bad = fn => assert.throws(fn, { message: 'Bad request' });
test('docId', () => { assert.equal(a.docId(3), 3); for (const v of [0, -1, 1.5, '3', null, 2 ** 31]) bad(() => a.docId(v)); });
test('docPos', () => { assert.deepEqual(a.docPos({ line: 0, col: 7, extra: 1 }), { line: 0, col: 7 }); for (const v of [null, {}, { line: -1, col: 0 }, { line: 0, col: 1.2 }, { line: '0', col: 0 }]) bad(() => a.docPos(v)); });
test('docLine', () => { assert.equal(a.docLine(0), 0); for (const v of [-1, 0.5, '0', 2 ** 31]) bad(() => a.docLine(v)); });
test('docCount', () => { assert.equal(a.docCount(5000), 5000); bad(() => a.docCount(5001)); bad(() => a.docCount(-1)); });
test('docText', () => { assert.equal(a.docText(''), ''); bad(() => a.docText(5)); bad(() => a.docText({ length: 1 })); });
test('docQuery', () => { assert.equal(a.docQuery('x'), 'x'); for (const v of ['', 'a\nb', 'a\rb', 'x'.repeat(1001), 7]) bad(() => a.docQuery(v)); });
test('docKind', () => { for (const k of ['type', 'delete', 'paste', 'other']) assert.equal(a.docKind(k), k); bad(() => a.docKind('eval')); });
test('boundaries', () => {
  assert.equal(a.docText('x'.repeat(52428800)).length, 52428800);
  bad(() => a.docText('x'.repeat(52428801)));
  bad(() => a.docPos({ line: 0, col: 2 ** 31 }));
  assert.deepEqual(a.docPos({ line: 2 ** 31 - 1, col: 2 ** 31 - 1 }), { line: 2 ** 31 - 1, col: 2 ** 31 - 1 });
  assert.equal(a.docCount(0), 0);
  assert.equal(a.docQuery('x'.repeat(1000)).length, 1000);
});
