// Agent board layouts: where each box sits for how many there are. Pure, no DOM and no globals from other files, so
// test/boardlayout.test.js can load it. board.ts applies a layout as grid lines on #boardGrid.
//   1: the whole page        2: side by side          3: one tall on the left, two stacked on the right
//   4: two by two            5–8: two rows, the top one fuller (3+2, 3+3, 4+3, 4+4), each box in a row as wide
// When the page is too narrow for that many across, the boxes go two to a row and the rows scroll.

interface BoardCell { col: number; colSpan: number; row: number; rowSpan: number } // 1-based grid lines
interface BoardLayout { cols: number; rows: number; scroll: boolean; cells: BoardCell[] }

const BOARD_MIN_BOX_W = 340; // narrower than this, a chat and its prompt get cramped

// Boxes in each row, top first, for 5 to 8 boxes.
const BOARD_ROWS: Record<number, number[]> = { 5: [3, 2], 6: [3, 3], 7: [4, 3], 8: [4, 4] };

function boardLayout(n: number, width: number): BoardLayout {
  n = Math.max(1, Math.min(8, Math.floor(n)));
  if (n === 1) return { cols: 1, rows: 1, scroll: false, cells: [{ col: 1, colSpan: 1, row: 1, rowSpan: 1 }] };
  if (n === 2) return { cols: 2, rows: 1, scroll: false, cells: [{ col: 1, colSpan: 1, row: 1, rowSpan: 1 }, { col: 2, colSpan: 1, row: 1, rowSpan: 1 }] };
  const across = n <= 4 ? 2 : BOARD_ROWS[n][0];
  if (width > 0 && width / across < BOARD_MIN_BOX_W) return stackedLayout(n, width);
  if (n === 3) {
    return { cols: 2, rows: 2, scroll: false, cells: [
      { col: 1, colSpan: 1, row: 1, rowSpan: 2 },
      { col: 2, colSpan: 1, row: 1, rowSpan: 1 },
      { col: 2, colSpan: 1, row: 2, rowSpan: 1 },
    ] };
  }
  const perRow = n === 4 ? [2, 2] : BOARD_ROWS[n];
  // Columns enough for both rows to split evenly: 3 and 2 boxes share 6, 4 and 3 share 12.
  const cols = perRow[0] === perRow[1] ? perRow[0] : perRow[0] * perRow[1];
  const cells: BoardCell[] = [];
  perRow.forEach((count, r) => {
    const span = cols / count;
    for (let i = 0; i < count; i++) cells.push({ col: 1 + i * span, colSpan: span, row: r + 1, rowSpan: 1 });
  });
  return { cols, rows: 2, scroll: false, cells };
}

// Two to a row (one, on a very narrow page), half the page high, scrolling; an odd one out takes the whole last row.
function stackedLayout(n: number, width: number): BoardLayout {
  const cols = width >= BOARD_MIN_BOX_W * 2 ? 2 : 1;
  const rows = Math.ceil(n / cols);
  const cells: BoardCell[] = [];
  for (let i = 0; i < n; i++) {
    const last = i === n - 1 && n % cols !== 0;
    cells.push({ col: 1 + (i % cols), colSpan: last ? cols : 1, row: 1 + Math.floor(i / cols), rowSpan: 1 });
  }
  return { cols, rows, scroll: rows > 2, cells };
}
