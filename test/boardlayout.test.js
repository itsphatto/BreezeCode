const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const ctx = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(fs.readFileSync(require.resolve('../src/renderer/breeze/boardlayout.ts'), 'utf8')), ctx);
const { boardLayout, BOARD_MIN_BOX_W } = vm.runInContext('({ boardLayout, BOARD_MIN_BOX_W })', ctx);
const plain = v => JSON.parse(JSON.stringify(v));
const cell = (col, colSpan, row, rowSpan) => ({ col, colSpan, row, rowSpan });
const WIDE = 2400;

test('one box fills the page', () => {
  assert.deepEqual(plain(boardLayout(1, WIDE)), { cols: 1, rows: 1, scroll: false, cells: [cell(1, 1, 1, 1)] });
  assert.deepEqual(plain(boardLayout(0, WIDE)).cells, [cell(1, 1, 1, 1)]); // the one empty box
});

test('two boxes split side by side', () => {
  assert.deepEqual(plain(boardLayout(2, WIDE)), { cols: 2, rows: 1, scroll: false, cells: [cell(1, 1, 1, 1), cell(2, 1, 1, 1)] });
});

test('three: the first runs the full height on the left, two stack on the right', () => {
  assert.deepEqual(plain(boardLayout(3, WIDE)), { cols: 2, rows: 2, scroll: false, cells: [cell(1, 1, 1, 2), cell(2, 1, 1, 1), cell(2, 1, 2, 1)] });
});

test('four: two by two', () => {
  assert.deepEqual(plain(boardLayout(4, WIDE)).cells, [cell(1, 1, 1, 1), cell(2, 1, 1, 1), cell(1, 1, 2, 1), cell(2, 1, 2, 1)]);
});

test('five and seven: two rows, the top one fuller, every box in a row the same width', () => {
  const five = plain(boardLayout(5, WIDE));
  assert.equal(five.cols, 6);
  assert.deepEqual(five.cells.map(c => [c.row, c.colSpan]), [[1, 2], [1, 2], [1, 2], [2, 3], [2, 3]]);
  const seven = plain(boardLayout(7, WIDE));
  assert.equal(seven.cols, 12);
  assert.deepEqual(seven.cells.map(c => [c.row, c.colSpan]), [[1, 3], [1, 3], [1, 3], [1, 3], [2, 4], [2, 4], [2, 4]]);
});

test('six and eight: full rows of three and four', () => {
  assert.deepEqual(plain(boardLayout(6, WIDE)).cols, 3);
  assert.deepEqual(plain(boardLayout(8, WIDE)).cols, 4);
  assert.deepEqual(plain(boardLayout(8, WIDE)).cells.map(c => c.row), [1, 1, 1, 1, 2, 2, 2, 2]);
});

test('too narrow for the boxes side by side: two columns, rows to scroll to', () => {
  const w = BOARD_MIN_BOX_W * 3 - 1; // not enough for 3 across
  const six = plain(boardLayout(6, w));
  assert.equal(six.cols, 2);
  assert.equal(six.rows, 3);
  assert.equal(six.scroll, true);
  assert.deepEqual(six.cells.map(c => [c.col, c.row]), [[1, 1], [2, 1], [1, 2], [2, 2], [1, 3], [2, 3]]);
  // An odd one out takes the whole last row.
  assert.deepEqual(plain(boardLayout(5, w)).cells[4], cell(1, 2, 3, 1));
  // Four still fits two across, so it keeps its own layout.
  assert.equal(plain(boardLayout(4, w)).scroll, false);
});

test('no width yet (the page is hidden): the wide layout', () => {
  assert.equal(plain(boardLayout(8, 0)).cols, 4);
});
