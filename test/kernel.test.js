const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { Kernels } = require('../src/main/kernel');

const PYTHON = process.env.BREEZE_TEST_PYTHON || 'python';
let hasPython = false;
try { execFileSync(PYTHON, ['--version'], { stdio: 'ignore', windowsHide: true }); hasPython = true; } catch { /* none */ }
const withPython = hasPython ? test : test.skip;

// Runs cells one after another; resolves with each cell's messages (without the closing 'done').
function session(t) {
  const k = new Kernels({ script: path.join(__dirname, '..', 'runtime', 'breeze_kernel.py'), python: async () => ({ cmd: PYTHON, env: process.env }) });
  t.after(() => k.stopAll());
  const got = new Map();
  const waiting = new Map();
  k.on('message', (nb, m) => {
    if (m.type === 'done') { waiting.get(m.id)?.(got.get(m.id) ?? []); return; }
    if (!got.has(m.id)) got.set(m.id, []);
    got.get(m.id).push(m);
  });
  let n = 0;
  return {
    k,
    cell: code => { const id = `c${++n}`; return new Promise(res => { waiting.set(id, res); void k.run('nb', os.tmpdir(), id, code); }); },
  };
}

withPython('kernel: variables carry over, print streams, the last value shows, errors keep the kernel', { timeout: 30000 }, async t => {
  const s = session(t);
  assert.deepEqual(await s.cell('x = 41'), []);
  const out = await s.cell('print("hi")\nx + 1');
  assert.equal(out.filter(m => m.type === 'stream').map(m => m.text).join(''), 'hi\n');
  assert.equal(out.at(-1).type, 'result');
  assert.equal(out.at(-1).data['text/plain'], '42');
  const shown = await s.cell('display(1, "a")');
  assert.deepEqual(shown.map(m => [m.type, m.data['text/plain']]), [['display', '1'], ['display', "'a'"]]);
  const err = await s.cell('1 / 0');
  assert.equal(err[0].type, 'error');
  assert.equal(err[0].ename, 'ZeroDivisionError');
  assert.ok(!err[0].traceback.join('').includes('breeze_kernel.py'));
  assert.deepEqual((await s.cell('x')).map(m => m.data['text/plain']), ['41']);
  assert.match((await s.cell('input()'))[0].evalue, /can't ask for typing/);
  const html = await s.cell('class T:\n  def _repr_html_(self): return "<b>t</b>"\nT()');
  assert.equal(html[0].data['text/html'], '<b>t</b>');
});

withPython('kernel: stop ends a running cell with an error', { timeout: 30000 }, async t => {
  const s = session(t);
  const p = s.cell('import time\ntime.sleep(30)');
  await new Promise(r => setTimeout(r, 500));
  s.k.stop('nb');
  const out = await p;
  assert.equal(out.at(-1).ename, 'KernelDied');
  assert.deepEqual((await s.cell('1')).map(m => m.data['text/plain']), ['1']); // a fresh kernel
});
