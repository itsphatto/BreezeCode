const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DebugManager, debugKind } = require('../src/main/debug');
const { debugPlan } = require('../src/main/toolchains');
const { gdbPath, gdbHit } = require('../src/main/debugGdb');

// The folder name has a space on purpose, as in debug.test.js.
const FIX = path.join(__dirname, 'fixtures', 'debug space');
const HEADERS = { stdioHeader: path.join(__dirname, '..', 'runtime', 'breeze_stdio.h'), debugHeader: path.join(__dirname, '..', 'runtime', 'breeze_debug.h') };

test('debugKind: C, C++ and Rust go to GDB', () => {
  for (const f of ['a.c', 'a.cpp', 'A.CC', 'a.cxx', 'src/main.rs']) assert.equal(debugKind(f), 'native', f);
  assert.equal(debugKind('a.h'), null);
});

test('gdbPath and gdbHit', () => {
  assert.equal(gdbPath('C:\\a b\\x.exe'), 'C:/a b/x.exe');
  assert.equal(gdbHit(' 3 '), '3');
  assert.equal(gdbHit('>= 3'), null);
});

test('debugPlan: C waits for GDB, Rust links the wait object, a project uses cargo', () => {
  const tools = { cc: { path: 'gcc.exe', name: 'gcc' }, cxx: { path: 'g++.exe', name: 'g++' }, rustc: { path: 'rustc.exe', name: 'rustc' }, cargo: { path: 'cargo.exe', name: 'cargo' } };
  const c = debugPlan('C:\\p\\a.c', tools, 'win32', HEADERS);
  assert.equal(c.exe, 'C:\\p\\build\\a.exe');
  assert.equal(c.entry, 'main');
  assert.ok(c.steps[0].args.includes('-O0') && c.steps[0].args.includes(HEADERS.debugHeader));
  assert.equal(debugPlan('C:\\p\\a.cpp', tools, 'win32', HEADERS).cpp, true);
  const rs = debugPlan('C:\\p\\my-app.rs', tools, 'win32', HEADERS);
  assert.equal(rs.entry, 'my_app::main');
  assert.ok(rs.steps[1].args.includes('link-arg=C:\\p\\build\\breeze_debug.o'));
  const cargo = debugPlan('C:\\p\\src\\main.rs', tools, 'win32', HEADERS, { cargoToml: 'C:\\p\\Cargo.toml' });
  assert.deepEqual(cargo.steps[1].env.CARGO_ENCODED_RUSTFLAGS.split('\x1f'), ['-C', 'link-arg=C:\\p\\target\\breeze_debug.o', '-C', 'link-arg=-lkernel32']);
  assert.match(debugPlan('C:\\p\\a.rs', { rustc: tools.rustc }, 'win32', HEADERS).error, /GCC/);
});

// ---- live sessions, when gcc and gdb (14+) are on the PATH ----

const which = n => { try { return execFileSync('where', [n], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0].trim(); } catch { return null; } };
const GCC = process.platform === 'win32' ? which('gcc') : null;
const GDB = process.platform === 'win32' ? which('gdb') : null;
const RUSTC = process.platform === 'win32' ? which('rustc') : null;
const withGdb = GCC && GDB ? test : test.skip;
const tools = { cc: GCC && { path: GCC, name: 'gcc' }, cxx: GCC && { path: GCC.replace(/gcc(\.exe)?$/i, 'g++$1'), name: 'g++' }, rustc: RUSTC && { path: RUSTC, name: 'rustc' } };

function recorder(m, t) {
  const events = [];
  let cursor = 0;
  m.on('event', e => events.push(e));
  t.after(() => m.stop());
  return {
    async next(pred, ms = 30000, what = 'event') {
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
const start = (m, file, bps, extra = {}) => m.start({
  file, root: FIX, gdb: GDB, build: debugPlan(file, tools, 'win32', HEADERS), breakpoints: { [file]: bps.map(line => ({ line, enabled: true })) }, ...extra,
});

withGdb('gdb: C program takes input, breaks, steps into a function, reads locals, finishes', { timeout: 90000 }, async t => {
  const m = new DebugManager();
  const r = recorder(m, t);
  const file = path.join(FIX, 'ask.c');
  await start(m, file, [8]);
  await r.next(e => e.type === 'state' && e.state === 'running', 60000, 'running');
  assert.equal(m.stdin('bob\n'), true);
  const p = await r.next(e => e.type === 'paused', 30000, 'pause');
  assert.equal(p.reason, 'breakpoint');
  assert.equal(p.frames[0].file, 'ask.c');
  assert.equal(p.frames[0].line, 8);
  const locals = (await m.scopes(p.frames[0].id)).find(s => /local/i.test(s.name));
  const vars = await m.children(locals.ref);
  assert.equal(vars.find(v => v.name === 'x')?.value, '2');
  assert.equal((await m.evaluate('x + y', p.frames[0].id, 'repl')).value, '5');
  await m.step('into');
  const p2 = await r.next(e => e.type === 'paused', 30000, 'pause in add');
  assert.equal(p2.frames[0].name, 'add');
  await m.setBreakpoints(file, []);
  await m.continue();
  assert.equal((await r.next(e => e.type === 'exited', 30000, 'exit')).code, 0);
  assert.match(r.output(), /hi bob/);
  assert.match(r.output(), /z = 5/);
});

withGdb('gdb: stop on entry pauses at main', { timeout: 90000 }, async t => {
  const m = new DebugManager();
  const r = recorder(m, t);
  await start(m, path.join(FIX, 'ask.c'), [], { stopOnEntry: true });
  const p = await r.next(e => e.type === 'paused', 60000, 'pause');
  assert.equal(p.reason, 'entry');
  assert.equal(p.frames[0].name, 'main');
  await m.stop();
});

withGdb('gdb: C++ pauses in the program, takes a breakpoint while running, stops', { timeout: 90000 }, async t => {
  const m = new DebugManager();
  const r = recorder(m, t);
  const file = path.join(FIX, 'spin.cpp');
  await start(m, file, []);
  await r.next(e => e.type === 'state' && e.state === 'running', 60000, 'running');
  await new Promise(res => setTimeout(res, 300)); // past the wait before main (breeze_debug.h)
  await m.pause();
  const p = await r.next(e => e.type === 'paused', 30000, 'pause');
  assert.equal(p.frames.find(f => f.file)?.file, 'spin.cpp');
  await m.continue();
  await r.next(e => e.type === 'state' && e.state === 'running', 10000, 'running again');
  await m.setBreakpoints(file, [{ line: 7, enabled: true }]);
  const p2 = await r.next(e => e.type === 'paused', 30000, 'pause at the new breakpoint');
  assert.equal(p2.frames[0].line, 7);
  await m.stop();
  await r.next(e => e.type === 'state' && e.state === 'stopped', 10000, 'stopped');
});

(GCC && GDB && RUSTC ? test : test.skip)('gdb: Rust program breaks and reads input', { timeout: 120000 }, async t => {
  const m = new DebugManager();
  const r = recorder(m, t);
  const file = path.join(FIX, 'ask.rs');
  await start(m, file, [7]);
  await r.next(e => e.type === 'state' && e.state === 'running', 90000, 'running');
  m.stdin('ann\n');
  const p = await r.next(e => e.type === 'paused', 30000, 'pause');
  assert.equal(p.frames[0].file, 'ask.rs');
  assert.equal(p.frames[0].line, 7);
  await m.continue();
  assert.equal((await r.next(e => e.type === 'exited', 30000, 'exit')).code, 0);
  assert.match(r.output(), /hi ann 5/);
});
