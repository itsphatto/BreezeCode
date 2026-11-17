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

const { boardTiles, dragShares } = vm.runInContext('({ boardTiles, dragShares })', ctx);
const round = r => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });

test('boardTiles: two boxes share the width, a handle in the gap', () => {
  const t = plain(boardTiles(2, 1006, 500, 6, {}));
  assert.deepEqual(t.boxes.map(round), [{ x: 0, y: 0, w: 500, h: 500 }, { x: 506, y: 0, w: 500, h: 500 }]);
  assert.deepEqual(t.sashes.map(s => [s.key, s.index, s.dir, round(s.rect)]), [['2', 0, 'row', { x: 500, y: 0, w: 6, h: 500 }]]);
});

test('boardTiles: saved sizes move the line, and three keeps one tall box with two stacked', () => {
  const two = plain(boardTiles(2, 1006, 500, 6, { 2: [3, 1] }));
  assert.equal(Math.round(two.boxes[0].w), 750);
  const three = plain(boardTiles(3, 1006, 506, 6, { 3: [1, 1], '3.1': [1, 3] }));
  assert.deepEqual(three.boxes.map(round), [{ x: 0, y: 0, w: 500, h: 506 }, { x: 506, y: 0, w: 500, h: 125 }, { x: 506, y: 131, w: 500, h: 375 }]);
  assert.deepEqual(three.sashes.map(s => s.key), ['3', '3.1']);
});

test('boardTiles: from four up, each row splits on its own', () => {
  const five = plain(boardTiles(5, 1212, 406, 6, {}));
  assert.equal(five.boxes.length, 5);
  assert.deepEqual(five.sashes.map(s => [s.key, s.index]), [['5.0', 0], ['5.0', 1], ['5', 0], ['5.1', 0]]);
  assert.ok(five.boxes.every(b => b.w > 0 && b.h > 0));
});

test('dragShares trades room between neighbours, never under the minimum', () => {
  assert.deepEqual(plain(dragShares(undefined, 2, 0, 100, 1000, 200)).map(v => +v.toFixed(2)), [0.6, 0.4]);
  assert.deepEqual(plain(dragShares([1, 1], 2, 0, -900, 1000, 200)).map(v => +v.toFixed(2)), [0.2, 0.8]);
  assert.deepEqual(plain(dragShares([1, 1, 1], 3, 1, 50, 900, 100)).map(v => +v.toFixed(3)), [0.333, 0.389, 0.278]);
  assert.deepEqual(plain(dragShares([0, 'x'], 2, 0, 0, 1000, 200)), [0.5, 0.5]); // bad saved values: an even split
});
