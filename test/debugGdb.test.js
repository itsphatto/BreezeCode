const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFile, execFileSync } = require('node:child_process');
const { DebugManager, debugKind } = require('../src/main/debug');
const { debugPlan, gccEnv } = require('../src/main/toolchains');
const { gdbPath, gdbHit, gdbEnv, rustTargetHint } = require('../src/main/debugGdb');

// The folder name has a space on purpose, as in debug.test.js.
const FIX = path.join(__dirname, 'fixtures', 'debug space');
const HEADERS = { stdioHeader: path.join(__dirname, '..', 'runtime', 'breeze_stdio.h'), debugHeader: path.join(__dirname, '..', 'runtime', 'breeze_debug.h') };

test('debugKind: C, C++ and Rust go to GDB', () => {
  for (const f of ['a.c', 'a.cpp', 'A.CC', 'a.cxx', 'src/main.rs']) assert.equal(debugKind(f), 'native', f);
  assert.equal(debugKind('a.h'), null);
});

// WinLibs GDB embeds Python 3.9 with its library in <root>\lib\python3.9, but can't find it on its own (and a
// PYTHONHOME left by another Python points it at the wrong one), so `gdb -i=dap` quits at once.
test('gdbEnv points PYTHONHOME at the Python that GDB ships with', () => {
  const root = 'C:\\Users\\Dell NB\\mingw64';
  const files = new Set([root + '\\lib\\python3.9\\os.py']);
  const io = { exists: p => files.has(p), readdir: d => d === root + '\\lib' ? ['gcc', 'python3.9', 'libpython3.9.a'] : [] };
  assert.deepEqual(gdbEnv(root + '\\bin\\gdb.exe', { PYTHONHOME: 'C:\\Python312', Path: 'x' }, 'win32', io), { PYTHONHOME: root, Path: 'x' });
  assert.deepEqual(gdbEnv('C:\\other\\bin\\gdb.exe', { Path: 'x' }, 'win32', io), { Path: 'x' }); // no Python beside it
  assert.deepEqual(gdbEnv('/usr/bin/gdb', { PYTHONHOME: '/opt/py' }, 'linux', io), { PYTHONHOME: '/opt/py' });
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

// GDB can't read the PDB debug info an MSVC Rust writes (breakpoints never bind), so on Windows the debug build targets
// the GNU ABI, which links through gcc and so needs the same GCC_EXEC_PREFIX fix as a C build.
test('debugPlan: Rust on Windows builds for the GNU target, with the gcc env', () => {
  const env = { GCC_EXEC_PREFIX: 'C:/S~1/lib/gcc/' };
  const tools = { cc: { path: 'gcc.exe', name: 'gcc', env }, rustc: { path: 'rustc.exe', name: 'rustc' }, cargo: { path: 'cargo.exe', name: 'cargo' } };
  const rs = debugPlan('C:\\p\\a.rs', tools, 'win32', HEADERS);
  assert.deepEqual(rs.steps[1].args.slice(-2), ['--target', 'x86_64-pc-windows-gnu']);
  assert.deepEqual(rs.steps[1].env, env);
  const cargo = debugPlan('C:\\p\\src\\main.rs', tools, 'win32', HEADERS, { cargoToml: 'C:\\p\\Cargo.toml' });
  assert.deepEqual(cargo.steps[1].args.slice(-2), ['--target', 'x86_64-pc-windows-gnu']);
  assert.equal(cargo.steps[1].env.GCC_EXEC_PREFIX, env.GCC_EXEC_PREFIX);
  assert.ok(cargo.steps[1].env.CARGO_ENCODED_RUSTFLAGS);
  assert.ok(!debugPlan('/p/a.rs', tools, 'linux', HEADERS).steps[1].args.includes('--target'));
});

test('rustTargetHint: a missing GNU target says how to add it', () => {
  assert.match(rustTargetHint("error[E0463]: can't find crate for `std`\n  = note: the `x86_64-pc-windows-gnu` target may not be installed\n"), /rustup target add x86_64-pc-windows-gnu/);
  assert.equal(rustTargetHint('error: expected `;`'), null);
});

// ---- live sessions, when gcc and gdb (14+) are on the PATH ----

const which = n => { try { return execFileSync('where', [n], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0].trim(); } catch { return null; } };
const GCC = process.platform === 'win32' ? which('gcc') : null;
const GDB = process.platform === 'win32' ? which('gdb') : null;
const RUSTC = process.platform === 'win32' ? which('rustc') : null;
// The Rust debug build targets x86_64-pc-windows-gnu (see debugPlan), which rustup doesn't install by default.
const RUST_GNU = RUSTC && (() => { try { return execFileSync('rustup', ['target', 'list', '--installed'], { encoding: 'utf8', windowsHide: true }).includes('x86_64-pc-windows-gnu'); } catch { return true; } })();
const withGdb = GCC && GDB ? test : test.skip;
const tools = { cc: GCC && { path: GCC, name: 'gcc' }, cxx: GCC && { path: GCC.replace(/gcc(\.exe)?$/i, 'g++$1'), name: 'g++' }, rustc: RUSTC && { path: RUSTC, name: 'rustc' } };
// As findTools does: a gcc under a folder with a space needs GCC_EXEC_PREFIX to link (see gccEnv).
test.before(async () => {
  if (!GCC || !/\s/.test(path.dirname(GCC))) return;
  const run = (file, args) => new Promise(res => execFile(file, args, { windowsHide: true }, (err, stdout) => res({ code: err ? 1 : 0, stdout })));
  const env = await gccEnv(path.dirname(path.dirname(GCC)), { exists: fs.existsSync, run, P: path.win32 });
  if (env) { tools.cc.env = env; tools.cxx.env = env; }
});

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

(GCC && GDB && RUSTC && RUST_GNU ? test : test.skip)('gdb: Rust program breaks and reads input', { timeout: 120000 }, async t => {
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
