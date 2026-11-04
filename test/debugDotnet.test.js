const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DebugManager, debugKind } = require('../src/main/debug');

// The folder name has a space on purpose, as in debug.test.js.
const FIX = path.join(__dirname, 'fixtures', 'debug space');
const FILE = path.join(FIX, 'Ask.cs');
const HOOK_SRC = path.join(__dirname, '..', 'runtime', 'BreezeDebugHook');

test('debugKind: C#', () => assert.equal(debugKind('Program.cs'), 'dotnet'));

test('dotnet: without netcoredbg it asks to install it', { timeout: 20000 }, async () => {
  const m = new DebugManager();
  const events = [];
  m.on('event', e => events.push(e));
  await m.start({ file: FILE, root: FIX, dotnet: 'dotnet', netcoredbg: path.join(os.tmpdir(), 'no-such', 'netcoredbg.exe'), hookSrc: HOOK_SRC, hookDir: os.tmpdir() });
  assert.equal(events.find(e => e.type === 'error')?.hint, 'install-netcoredbg');
});

// ---- live sessions: the .NET 10 SDK, and netcoredbg named by BREEZE_TEST_NETCOREDBG ----

const NETCOREDBG = process.env.BREEZE_TEST_NETCOREDBG;
let sdk = 0;
try { sdk = Number(/^(\d+)/.exec(execFileSync('dotnet', ['--version'], { encoding: 'utf8', windowsHide: true }))?.[1] || 0); } catch { /* none */ }
const withDbg = NETCOREDBG && fs.existsSync(NETCOREDBG) && sdk >= 10 ? test : test.skip;
const HOOK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-hook-'));

function recorder(m, t) {
  const events = [];
  let cursor = 0;
  m.on('event', e => events.push(e));
  t.after(() => m.stop());
  return {
    async next(pred, ms = 60000, what = 'event') {
      const end = Date.now() + ms;
      for (;;) {
        const i = events.findIndex((e, k) => k >= cursor && pred(e));
        if (i !== -1) { cursor = i + 1; return events[i]; }
        if (Date.now() > end) throw new Error(`no ${what} within ${ms} ms; got ${JSON.stringify(events)}`);
        await new Promise(r => setTimeout(r, 10));
      }
    },
    output: () => events.filter(e => e.type === 'output').map(e => e.text).join(''),
  };
}
const start = (m, bps, extra = {}) => m.start({
  file: FILE, root: FIX, dotnet: 'dotnet', netcoredbg: NETCOREDBG, hookSrc: HOOK_SRC, hookDir: HOOK_DIR,
  breakpoints: { [FILE]: bps.map(line => ({ line, enabled: true })) }, ...extra,
});

withDbg('dotnet: input, a breakpoint, locals, evaluate, step into, finish', { timeout: 240000 }, async t => {
  const m = new DebugManager();
  const r = recorder(m, t);
  await start(m, [8]);
  await r.next(e => e.type === 'state' && e.state === 'running', 200000, 'running');
  assert.equal(m.stdin('bob\n'), true);
  const p = await r.next(e => e.type === 'paused', 30000, 'pause');
  assert.equal(p.reason, 'breakpoint');
  assert.deepEqual([p.frames[0].file, p.frames[0].line], ['Ask.cs', 8]);
  const locals = (await m.scopes(p.frames[0].id))[0];
  const vars = await m.children(locals.ref);
  assert.equal(vars.find(v => v.name === 'name')?.value, '"bob"');
  assert.equal((await m.evaluate('x + 40', p.frames[0].id, 'repl')).value, '42');
  await m.step('into');
  const p2 = await r.next(e => e.type === 'paused', 30000, 'pause in Add');
  assert.equal(p2.frames[0].line, 3);
  await m.continue();
  assert.equal((await r.next(e => e.type === 'exited', 30000, 'exit')).code, 0);
  assert.match(r.output(), /hi bob 5/);
});

withDbg('dotnet: stop on entry, then an uncaught exception pauses with its message', { timeout: 240000 }, async t => {
  const m = new DebugManager();
  const r = recorder(m, t);
  await start(m, [], { stopOnEntry: true, exceptions: 'uncaught' });
  const p = await r.next(e => e.type === 'paused', 200000, 'pause');
  assert.equal(p.reason, 'entry');
  await m.setBreakpoints(FILE, [{ line: 9, enabled: true }]);
  await m.continue();
  m.stdin('zed\n');
  const p2 = await r.next(e => e.type === 'paused', 30000, 'breakpoint');
  const locals = (await m.scopes(p2.frames[0].id))[0];
  await m.setValue(locals.ref, 'z', '500');
  await m.continue();
  const p3 = await r.next(e => e.type === 'paused', 30000, 'exception');
  assert.equal(p3.reason, 'exception');
  assert.match(p3.exception, /too big: 500/);
  await m.stop();
});
