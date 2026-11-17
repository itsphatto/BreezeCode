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

/* ----- Sizes the person drags: the same layouts as a tree of splits ----- */
// A split lays its parts side by side ('row') or stacked ('col'); a number is a box, by its place on the board.
// 2: [a|b]   3: [a|(b/c)]   4 and 5-8: two rows stacked, each row split on its own, so a box in one row can widen
// without moving the boxes of the other. Each split's sizes are kept under its key ("3", "3.1"…), one per box count.
interface BoardSplit { dir: 'row' | 'col'; kids: (BoardSplit | number)[] }
interface TileRect { x: number; y: number; w: number; h: number }
// The gap between two parts of split `key`, as a handle: `span` is the room its parts share along `dir`.
interface TileSash { key: string; index: number; count: number; dir: 'row' | 'col'; span: number; rect: TileRect }

function boardTree(n: number): BoardSplit | number {
  n = Math.max(1, Math.min(8, Math.floor(n)));
  if (n === 1) return 0;
  if (n === 2) return { dir: 'row', kids: [0, 1] };
  if (n === 3) return { dir: 'row', kids: [0, { dir: 'col', kids: [1, 2] }] };
  const perRow = n === 4 ? [2, 2] : BOARD_ROWS[n];
  let i = 0;
  return { dir: 'col', kids: perRow.map(c => ({ dir: 'row' as const, kids: Array.from({ length: c }, () => i++) })) };
}
// Shares that add up to 1; anything unusable (missing, the wrong count, not positive) is an even split.
function splitShares(s: number[] | undefined, k: number): number[] {
  if (!Array.isArray(s) || s.length !== k || s.some(v => !(typeof v === 'number' && v > 0 && isFinite(v)))) return Array(k).fill(1 / k);
  const total = s.reduce((a, v) => a + v, 0);
  return s.map(v => v / total);
}
// Where each box and each handle sits, in px from the board's top left.
function boardTiles(n: number, w: number, h: number, gap: number, sizes: Record<string, number[]>): { boxes: TileRect[]; sashes: TileSash[] } {
  const boxes: TileRect[] = [], sashes: TileSash[] = [];
  const walk = (node: BoardSplit | number, r: TileRect, key: string): void => {
    if (typeof node === 'number') { boxes[node] = r; return; }
    const k = node.kids.length, row = node.dir === 'row';
    const span = Math.max(0, (row ? r.w : r.h) - gap * (k - 1));
    const shares = splitShares(sizes[key], k);
    let at = row ? r.x : r.y;
    node.kids.forEach((kid, i) => {
      const len = span * shares[i];
      walk(kid, row ? { x: at, y: r.y, w: len, h: r.h } : { x: r.x, y: at, w: r.w, h: len }, `${key}.${i}`);
      at += len;
      if (i === k - 1) return;
      sashes.push({ key, index: i, count: k, dir: node.dir, span, rect: row ? { x: at, y: r.y, w: gap, h: r.h } : { x: r.x, y: at, w: r.w, h: gap } });
      at += gap;
    });
  };
  walk(boardTree(n), { x: 0, y: 0, w, h }, String(Math.max(1, Math.min(8, Math.floor(n)))));
  return { boxes, sashes };
}
// Handle `index` moved `dpx`: the parts on either side of it trade room, neither going under `min` px.
function dragShares(cur: number[] | undefined, count: number, index: number, dpx: number, span: number, min: number): number[] {
  const fr = splitShares(cur, count);
  if (span <= 0 || index < 0 || index >= count - 1) return fr;
  const pair = fr[index] + fr[index + 1], lo = Math.min(min / span, pair / 2);
  const a = Math.min(Math.max(fr[index] + dpx / span, lo), pair - lo);
  fr[index] = a;
  fr[index + 1] = pair - a;
  return fr;
}
