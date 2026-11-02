const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const ctx = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(fs.readFileSync(require.resolve('../src/renderer/breeze/teamswap.ts'), 'utf8')), ctx);
const { changedBlocks, planTeam, teamShape } = vm.runInContext('({ changedBlocks, planTeam, teamShape })', ctx);

const block = (key, x, y, w, h) => ({ key, x, y, w, h });
const crew = [{ x: -30, y: 0 }, { x: 900, y: 0 }, { x: 0, y: 700 }, { x: 900, y: 700 }];
const oldBlocks = [block('side', 44, 50, 240, 800), block('editor', 290, 50, 700, 600), block('agents', 1000, 50, 340, 800), block('status', 0, 870, 1400, 24)];
const newBlocks = [block('stack', 44, 50, 280, 400), block('bps', 44, 460, 280, 400), block('source', 330, 50, 700, 600), block('vars', 1040, 50, 300, 400), block('back', 1200, 8, 120, 28)];

test('a block in the same place on both screens is left out', () => {
  const [out, typed] = changedBlocks([{ key: 'rail' }, { key: 'old' }], [{ key: 'rail' }, { key: 'new' }]);
  assert.deepEqual(Array.from(out, b => b.key), ['old']);
  assert.deepEqual(Array.from(typed, b => b.key), ['new']);
});

test('every block gets one job, and nobody works on two at once', () => {
  for (let run = 0; run < 25; run++) {
    const tasks = planTeam(oldBlocks, newBlocks, crew);
    assert.equal(tasks.length, oldBlocks.length + newBlocks.length);
    assert.equal(new Set(tasks.map(t => t.block.key)).size, tasks.length);
    assert.equal(tasks.filter(t => t.out).length, oldBlocks.length);
    for (const who of [0, 1, 2, 3]) {
      const mine = tasks.filter(t => t.who === who);
      mine.forEach((t, i) => {
        assert.ok(t.at < t.start && t.start < t.end);
        if (i) assert.ok(mine[i - 1].end <= t.at, 'one job at a time');
      });
    }
  }
});

test('the blocks do not all change together', () => {
  for (let run = 0; run < 25; run++) {
    const tasks = planTeam(oldBlocks, newBlocks, crew);
    for (const t of tasks) {
      const busy = tasks.filter(o => o.start <= t.start && t.start < o.end).length;
      assert.ok(busy <= crew.length && busy < tasks.length, `${busy} blocks at once`);
    }
  }
});

test('a new block takes over from the old one it mostly replaces', () => {
  const tasks = planTeam([block('editor', 290, 50, 700, 600)], newBlocks, crew);
  assert.equal(tasks[0].block.key, 'editor');
  assert.equal(tasks[1].block.key, 'source');
});

test('cropping away ends with nothing showing, drawing in ends with all of it, and the hand stays on the moving edge', () => {
  const b = block('b', 100, 50, 200, 100);
  const base = { block: b, dx: 0, dy: 0 };
  assert.equal(teamShape({ ...base, out: true, ax: 0, ay: -1 }, 1).w, 0);
  const mid = teamShape({ ...base, out: true, ax: 0, ay: -1 }, .5);
  assert.deepEqual([mid.x, mid.w, mid.cx, mid.cy], [100, 100, 200, 100]);
  const fromRight = teamShape({ ...base, out: false, ax: 1, ay: 1 }, .25);
  assert.deepEqual([fromRight.x, fromRight.y, fromRight.cx, fromRight.cy], [250, 125, 250, 125]);
  const whole = teamShape({ ...base, out: false, ax: 1, ay: 0 }, 1);
  assert.deepEqual([whole.x, whole.y, whole.w, whole.h], [100, 50, 200, 100]);
});

test('a dragged block lands exactly in place and leaves faded out', () => {
  const b = block('b', 100, 50, 200, 100);
  const task = { block: b, ax: -1, ay: -1, dx: 70, dy: 0 };
  const landed = teamShape({ ...task, out: false }, 1);
  assert.deepEqual([landed.x, landed.y, landed.alpha], [100, 50, 1]);
  const gone = teamShape({ ...task, out: true }, 1);
  assert.deepEqual([gone.x, gone.alpha], [170, 0]);
});
