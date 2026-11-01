const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DebugManager, debugKind, nodeSupportsTs, launchArgs, killTree, relOf } = require('../src/main/debug');
const { PythonBackend } = require('../src/main/debugPython');
const { DapReader, frame } = require('../src/main/dap');

// The folder name has a space on purpose: breakpoints must bind in a path like `…\Breeze Code\…`.
const FIX = path.join(__dirname, 'fixtures', 'debug space');
const LOOP_JS = path.join(FIX, 'loop.js');
const LOOP_PY = path.join(FIX, 'loop.py');
const BOOM_JS = path.join(FIX, 'boom.js');

// ---- pure helpers ----

test('debugKind: Python, JavaScript and TypeScript files, nothing else', () => {
  assert.equal(debugKind('app.py'), 'python');
  assert.equal(debugKind('C:\\x\\APP.PY'), 'python');
  for (const f of ['a.js', 'a.mjs', 'a.cjs', 'a.ts', 'dir/a.mts']) assert.equal(debugKind(f), 'node', f);
  for (const f of ['a.tsx', 'a.txt', 'Makefile', 'a.py.bak', '', 'js']) assert.equal(debugKind(f), null, f);
});

test('nodeSupportsTs: 22.18+, 23.6+, any 24+', () => {
  assert.equal(nodeSupportsTs('v22.17.0'), false);
  assert.equal(nodeSupportsTs('v22.18.0'), true);
  assert.equal(nodeSupportsTs('v23.5.0'), false);
  assert.equal(nodeSupportsTs('v23.6.0'), true);
  assert.equal(nodeSupportsTs('v24.0.0'), true);
  assert.equal(nodeSupportsTs('v25.1.2'), true);
  assert.equal(nodeSupportsTs('v20.11.1'), false);
  assert.equal(nodeSupportsTs('22.18.1'), true);
  assert.equal(nodeSupportsTs('garbage'), false);
});

test('launchArgs: debugpy and node --inspect-brk command lines', () => {
  assert.deepEqual(launchArgs('python', 'C:\\a b\\x.py', { port: 5678 }),
    { args: ['-Xfrozen_modules=off', '-m', 'debugpy', '--listen', '127.0.0.1:5678', '--wait-for-client', 'C:\\a b\\x.py'] });
  assert.deepEqual(launchArgs('node', '/a b/x.js', { ts: false }), { args: ['--inspect-brk=127.0.0.1:0', '/a b/x.js'] });
  assert.deepEqual(launchArgs('node', '/a b/x.ts', { ts: true }),
    { args: ['--inspect-brk=127.0.0.1:0', '--experimental-strip-types', '/a b/x.ts'] });
});

test('killTree is exported', () => assert.equal(typeof killTree, 'function'));

test('DebugManager: stop with no session resolves; commands without a session reject', async () => {
  const m = new DebugManager();
  await m.stop();
  await assert.rejects(m.scopes(0), /not running/i);
  await assert.rejects(m.evaluate('1', 0, 'repl'), /not running/i);
});

test('DebugManager: a file it cannot debug reports an error and ends stopped', async () => {
  const m = new DebugManager();
  const events = [];
  m.on('event', e => events.push(e));
  await m.start({ file: path.join(FIX, 'notes.txt'), root: FIX, node: process.execPath });
  assert.equal(events.find(e => e.type === 'error')?.type, 'error');
  assert.deepEqual(events.at(-1), { type: 'state', state: 'stopped' });
});

test('DebugManager: a missing Node reports not-found and ends stopped', async () => {
  const m = new DebugManager();
  const events = [];
  m.on('event', e => events.push(e));
  await m.start({ file: LOOP_JS, root: FIX, node: path.join(FIX, 'no-such-node.exe') });
  await waitUntil(() => events.some(e => e.type === 'state' && e.state === 'stopped'), 5000);
  assert.equal(events.find(e => e.type === 'error')?.hint, 'not-found');
  assert.ok(!events.some(e => e.type === 'exited'), 'nothing ran, so nothing exited');
});

// ---- helpers for live sessions ----

async function waitUntil(cond, ms) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms`);
    await new Promise(r => setTimeout(r, 10));
  }
}

// Records a manager's events; `next(pred)` resolves with the first matching event after the last one returned.
function recorder(m, t) {
  const events = [];
  let cursor = 0;
  m.on('event', e => events.push(e));
  // Every child is gone when the test ends, pass or fail.
  t.after(async () => {
    const pid = m.pid;
    await m.stop();
    if (pid) try { process.kill(pid); } catch { /* already gone */ }
  });
  return {
    events,
    async next(pred, ms = 15000, what = 'event') {
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
const isState = s => e => e.type === 'state' && e.state === s;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ---- Node (the test runner's own Node) ----

test('node: break, read a local, evaluate, step over, finish', { timeout: 30000 }, async t => {
  const m = new DebugManager();
  const r = recorder(m, t);
  await m.start({ file: LOOP_JS, root: FIX, node: process.execPath, breakpoints: { [LOOP_JS]: [{ line: 3, enabled: true }] } });
  const bps = await r.next(e => e.type === 'breakpoints' && e.lines.length > 0, 15000, 'verified breakpoints');
  assert.deepEqual(bps, { type: 'breakpoints', file: 'loop.js', lines: [3] });
  const p = await r.next(e => e.type === 'paused', 15000, 'pause');
  assert.equal(p.reason, 'breakpoint');
  assert.equal(p.frames[0].file, 'loop.js');
  assert.equal(p.frames[0].line, 3);
  const frameId = p.frames[0].id;

  const scopes = await m.scopes(frameId);
  const locals = scopes.find(s => s.name === 'Locals');
  assert.ok(locals && locals.ref > 0, JSON.stringify(scopes));
  assert.ok(scopes.some(s => s.name === 'Globals'));
  const vars = await m.children(locals.ref);
  assert.equal(vars.find(v => v.name === 'i')?.value, '3');

  assert.equal((await m.evaluate('i * 2', frameId, 'watch')).value, '6');
  await assert.rejects(m.evaluate('nope.x', frameId, 'repl'), /nope/);

  await m.step('over');
  const p2 = await r.next(e => e.type === 'paused', 10000, 'pause after step');
  assert.equal(p2.frames[0].line, 4);
  assert.equal(p2.reason, 'step');

  await m.setBreakpoints(LOOP_JS, []);
  await m.continue();
  const ex = await r.next(e => e.type === 'exited', 10000, 'exit');
  assert.equal(ex.code, 0);
  await r.next(isState('stopped'), 5000, 'stopped');
  assert.match(r.output(), /i = 3/);
  assert.match(r.output(), /total 12/);
  assert.doesNotMatch(r.output(), /Debugger (listening|attached)|Waiting for the debugger/);
});

test('node: hit count binds in a path with a space; an invalid condition is not sent', { timeout: 30000 }, async t => {
  const m = new DebugManager();
  const r = recorder(m, t);
  await m.start({
    file: LOOP_JS, root: FIX, node: process.execPath,
    breakpoints: { 'loop.js': [{ line: 3, enabled: true, hitCondition: '2' }, { line: 4, enabled: true, condition: 'i +++' }, { line: 6, enabled: false }] },
  });
  const bps = await r.next(e => e.type === 'breakpoints' && e.lines.length > 0, 15000, 'verified breakpoints');
  assert.deepEqual(bps.lines, [3]);
  const p = await r.next(e => e.type === 'paused', 15000, 'pause');
  assert.equal(p.frames[0].line, 3);
  assert.equal((await m.evaluate('i', p.frames[0].id, 'hover')).value, '4'); // the second hit
  await m.stop();
  await r.next(isState('stopped'), 5000, 'stopped');
});

test('node: a program that throws at once ends stopped with the error in Output', { timeout: 20000 }, async t => {
  const m = new DebugManager();
  const r = recorder(m, t);
  const t0 = Date.now();
  await m.start({ file: BOOM_JS, root: FIX, node: process.execPath });
  const ex = await r.next(e => e.type === 'exited', 5000, 'exit');
  assert.notEqual(ex.code, 0);
  await r.next(isState('stopped'), 5000 - (Date.now() - t0), 'stopped');
  assert.match(r.output(), /Error: boom/);
  assert.ok(!r.events.some(e => e.type === 'paused'));
});

test('node: a script that does not exist ends stopped with the reason in Output', { timeout: 20000 }, async t => {
  const m = new DebugManager();
  const r = recorder(m, t);
  await m.start({ file: path.join(FIX, 'missing.js'), root: FIX, node: process.execPath });
  assert.notEqual((await r.next(e => e.type === 'exited', 5000, 'exit')).code, 0);
  await r.next(isState('stopped'), 2000, 'stopped');
  assert.match(r.output(), /Cannot find module/);
});

test('node: stop right after start ends stopped and nothing is left running', { timeout: 10000 }, async t => {
  const m = new DebugManager();
  const r = recorder(m, t);
  m.start({ file: LOOP_JS, root: FIX, node: process.execPath });
  const t0 = Date.now();
  await m.stop();
  await r.next(isState('stopped'), 2000, 'stopped');
  assert.ok(Date.now() - t0 < 2000);
  await new Promise(res => setTimeout(res, 200));
  assert.equal(m.pid, null, 'no child was started after the stop');
});

test('node: stop while still connecting kills the child', { timeout: 10000 }, async t => {
  const m = new DebugManager();
  const r = recorder(m, t);
  m.start({ file: LOOP_JS, root: FIX, node: process.execPath });
  await waitUntil(() => m.pid, 5000);
  const pid = m.pid;
  const t0 = Date.now();
  await m.stop();
  await r.next(isState('stopped'), 2000, 'stopped');
  assert.ok(Date.now() - t0 < 2000);
  assert.throws(() => process.kill(pid, 0));
});

test('node: start while a session runs stops the old one first', { timeout: 30000 }, async t => {
  const m = new DebugManager();
  const r = recorder(m, t);
  await m.start({ file: LOOP_JS, root: FIX, node: process.execPath, stopOnEntry: true });
  await r.next(e => e.type === 'paused', 15000, 'entry pause');
  const first = m.pid;
  await m.start({ file: LOOP_JS, root: FIX, node: process.execPath, stopOnEntry: true });
  await r.next(isState('stopped'), 5000, 'old session stopped');
  await r.next(isState('starting'), 5000, 'new session starting');
  const p = await r.next(e => e.type === 'paused', 15000, 'entry pause');
  assert.equal(p.reason, 'entry');
  assert.ok(!alive(first));
  assert.notEqual(m.pid, first);
});

test('node: Restart pressed twice while running: one debuggee, and no old event after the newest start', { timeout: 30000 }, async t => {
  const m = new DebugManager();
  const r = recorder(m, t);
  await m.start({ file: LOOP_JS, root: FIX, node: process.execPath, stopOnEntry: true });
  await r.next(e => e.type === 'paused', 15000, 'entry pause');
  const first = m.pid;
  const mark = r.events.length;
  m.restart();
  await m.restart();
  await r.next(e => e.type === 'paused', 15000, 'entry pause of the new session');
  const after = r.events.slice(mark);
  const starts = after.map((e, i) => (isState('starting')(e) ? i : -1)).filter(i => i !== -1);
  assert.equal(starts.length, 1, `one session started: ${JSON.stringify(after)}`);
  const tail = after.slice(starts[0] + 1);
  assert.ok(!tail.some(e => e.type === 'exited' || isState('stopped')(e)), `no old-session event after 'starting': ${JSON.stringify(after)}`);
  assert.deepEqual(after.slice(0, starts[0]).filter(e => e.type === 'exited' || e.type === 'state').map(e => e.type === 'state' ? e.state : 'exited'), ['exited', 'stopped']);
  assert.ok(!alive(first));
  assert.ok(alive(m.pid));
});

test('node: stop while paused does not let the program run on', { timeout: 20000 }, async t => {
  const m = new DebugManager();
  const r = recorder(m, t);
  await m.start({ file: LOOP_JS, root: FIX, node: process.execPath, breakpoints: { [LOOP_JS]: [{ line: 3, enabled: true }] } });
  await r.next(e => e.type === 'paused', 15000, 'pause');
  const mark = r.events.length;
  await m.stop();
  const ex = await r.next(e => e.type === 'exited', 5000, 'exit');
  assert.notEqual(ex.code, 0);
  const later = r.events.slice(mark).filter(e => e.type === 'output' && e.stream === 'stdout').map(e => e.text).join('');
  assert.equal(later, '', 'no program output after the stop');
});

test('node: killNow kills the paused debuggee at once, awaiting nothing, and the session ends stopped', { timeout: 20000 }, async t => {
  const m = new DebugManager();
  const r = recorder(m, t);
  await m.start({ file: LOOP_JS, root: FIX, node: process.execPath, breakpoints: { [LOOP_JS]: [{ line: 3, enabled: true }] } });
  await r.next(e => e.type === 'paused', 15000, 'pause');
  const pid = m.pid;
  assert.ok(alive(pid));
  assert.equal(m.killNow(), undefined);
  const end = Date.now() + 2000;
  while (alive(pid) && Date.now() < end) await new Promise(res => setTimeout(res, 20));
  assert.ok(!alive(pid), 'the debuggee is gone within 2 s');
  await r.next(isState('stopped'), 5000, 'stopped');
  assert.equal(m.state, 'stopped');
  m.killNow(); // with no session it does nothing
});

test('node: uncaught exceptions pause with the message when asked', { timeout: 20000 }, async t => {
  const m = new DebugManager();
  const r = recorder(m, t);
  await m.start({ file: BOOM_JS, root: FIX, node: process.execPath, exceptions: 'uncaught' });
  const p = await r.next(e => e.type === 'paused', 15000, 'pause');
  assert.equal(p.reason, 'exception');
  assert.equal(p.exception, 'Error: boom');
  assert.equal(p.frames[0].line, 1);
  await m.continue();
  assert.notEqual((await r.next(e => e.type === 'exited', 10000, 'exit')).code, 0);
});

test('node: TypeScript breaks on the right line', { timeout: 20000 }, async t => {
  const m = new DebugManager();
  const r = recorder(m, t);
  const file = path.join(FIX, 'typed.ts');
  await m.start({ file, root: FIX, node: process.execPath, breakpoints: { [file]: [{ line: 3, enabled: true }] } });
  const p = await r.next(e => e.type === 'paused', 15000, 'pause');
  assert.deepEqual([p.frames[0].file, p.frames[0].line, p.frames[0].name], ['typed.ts', 3, 'twice']);
  assert.equal((await m.evaluate('r', p.frames[0].id, 'hover')).value, '42');
  await m.continue();
  assert.equal((await r.next(e => e.type === 'exited', 10000, 'exit')).code, 0);
  assert.match(r.output(), /twice 42/);
});

test('node: stdin reaches the program; set a closure variable; run to a line', { timeout: 20000 }, async t => {
  const m = new DebugManager();
  const r = recorder(m, t);
  const file = path.join(FIX, 'echo.js');
  await m.start({ file, root: FIX, node: process.execPath, breakpoints: { [file]: [{ line: 3, enabled: true }] } });
  await r.next(isState('running'), 15000, 'running');
  assert.equal(m.stdin('hello\n'), true);
  const p = await r.next(e => e.type === 'paused', 15000, 'pause');
  assert.equal(p.frames[0].line, 3);
  const closure = (await m.scopes(p.frames[0].id)).find(s => s.name === 'Closure');
  assert.ok(closure, 'the module scope is a closure of the callback');
  assert.equal((await m.setValue(closure.ref, 'n', '40 + 1')).value, '41');
  await m.runTo(file, 4);
  const p2 = await r.next(e => e.type === 'paused', 10000, 'pause at the run-to line');
  assert.equal(p2.frames[0].line, 4);
  await m.continue();
  assert.equal((await r.next(e => e.type === 'exited', 10000, 'exit')).code, 0);
  assert.match(r.output(), /got hello 42/);
});

// ---- Python (real debugpy, when installed) ----

// BREEZE_TEST_PYTHON picks the interpreter (a venv with debugpy, say); otherwise `python` on the PATH.
const PYTHON = process.env.BREEZE_TEST_PYTHON || 'python';
let hasDebugpy = false;
try { execFileSync(PYTHON, ['-m', 'debugpy', '--version'], { stdio: 'ignore', timeout: 15000, windowsHide: true }); hasDebugpy = true; } catch { /* not installed */ }
const withDebugpy = hasDebugpy ? test : test.skip;

withDebugpy('python: break, read a local, evaluate, step over, finish', { timeout: 60000 }, async t => {
  const m = new DebugManager();
  const r = recorder(m, t);
  await m.start({ file: LOOP_PY, root: FIX, python: PYTHON, breakpoints: { 'loop.py': [{ line: 3, enabled: true }] } });
  const bps = await r.next(e => e.type === 'breakpoints' && e.lines.length > 0, 20000, 'verified breakpoints');
  assert.deepEqual(bps, { type: 'breakpoints', file: 'loop.py', lines: [3] });
  const p = await r.next(e => e.type === 'paused', 20000, 'pause');
  assert.equal(p.frames[0].file, 'loop.py');
  assert.equal(p.frames[0].line, 3);
  const frameId = p.frames[0].id;
  const locals = (await m.scopes(frameId)).find(s => /^Locals$/.test(s.name));
  assert.ok(locals && locals.ref > 0);
  assert.equal((await m.children(locals.ref)).find(v => v.name === 'i')?.value, '3');
  assert.equal((await m.evaluate('i * 2', frameId, 'watch')).value, '6');
  await m.step('over');
  const p2 = await r.next(e => e.type === 'paused', 10000, 'pause after step');
  assert.equal(p2.frames[0].line, 4);
  await m.setBreakpoints(LOOP_PY, []);
  await m.continue();
  assert.equal((await r.next(e => e.type === 'exited', 15000, 'exit')).code, 0);
  await r.next(isState('stopped'), 5000, 'stopped');
  assert.match(r.output(), /i = 3/);
});

// The process and every descendant of `pid`, by pid.
function treeOf(pid) {
  const out = process.platform === 'win32'
    ? execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'], { windowsHide: true }).toString()
    : execFileSync('ps', ['-A', '-o', 'pid=,ppid=']).toString();
  const kids = new Map();
  for (const line of out.split(/\r?\n/)) {
    const [p, pp] = line.trim().split(/\s+/).map(Number);
    if (p) kids.set(pp, [...(kids.get(pp) ?? []), p]);
  }
  const all = [pid];
  for (let i = 0; i < all.length; i++) all.push(...(kids.get(all[i]) ?? []));
  return all;
}

withDebugpy('python: natural end, logpoints once, and debugpy leaves nothing running', { timeout: 60000 }, async t => {
  const m = new DebugManager();
  const r = recorder(m, t);
  await m.start({ file: LOOP_PY, root: FIX, python: PYTHON, breakpoints: { 'loop.py': [{ line: 3, enabled: true }, { line: 4, enabled: true, logMessage: 'log i={i}' }] } });
  await r.next(e => e.type === 'paused', 20000, 'pause');
  const tree = treeOf(m.pid);
  assert.ok(tree.length >= 2, `debugpy's adapter runs beside the program: ${tree}`);
  await m.setBreakpoints(LOOP_PY, [{ line: 4, enabled: true, logMessage: 'log i={i}' }]);
  await m.continue();
  assert.equal((await r.next(e => e.type === 'exited', 15000, 'exit')).code, 0);
  await r.next(isState('stopped'), 5000, 'stopped');
  const out = r.events.filter(e => e.type === 'output');
  const text = s => out.filter(e => e.stream === s).map(e => e.text).join('');
  assert.equal(text('stdout').match(/i = \d/g)?.length, 3, 'print() output arrives once');
  assert.equal(text('console').match(/log i=\d/g)?.length, 3, 'each logpoint arrives once');
  assert.doesNotMatch(text('stdout') + text('stderr'), /log i=|frozen modules|Debugger warning/);
  await waitUntil(() => tree.every(pid => !alive(pid)), 5000);
});

withDebugpy('python: stop while paused ends the program there', { timeout: 60000 }, async t => {
  const m = new DebugManager();
  const r = recorder(m, t);
  await m.start({ file: LOOP_PY, root: FIX, python: PYTHON, breakpoints: { 'loop.py': [{ line: 3, enabled: true }] } });
  await r.next(e => e.type === 'paused', 20000, 'pause');
  const tree = treeOf(m.pid);
  const mark = r.events.length;
  await m.stop();
  await r.next(isState('stopped'), 5000, 'stopped');
  assert.equal(r.events.slice(mark).filter(e => e.type === 'output' && e.stream === 'stdout').length, 0, 'no program output after the stop');
  await waitUntil(() => tree.every(pid => !alive(pid)), 5000);
});

withDebugpy('python: stop while still starting kills debugpy and the program', { timeout: 30000 }, async t => {
  const m = new DebugManager();
  const r = recorder(m, t);
  m.start({ file: LOOP_PY, root: FIX, python: PYTHON });
  await waitUntil(() => m.pid, 15000);
  const pid = m.pid;
  const t0 = Date.now();
  await m.stop();
  await r.next(isState('stopped'), 2000, 'stopped');
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(!alive(pid));
  assert.ok(!r.events.some(e => e.type === 'output' && e.stream === 'stdout'), 'the program never ran');
});

withDebugpy('python: stop on entry pauses on the first line', { timeout: 60000 }, async t => {
  const m = new DebugManager();
  const r = recorder(m, t);
  await m.start({ file: LOOP_PY, root: FIX, python: PYTHON, stopOnEntry: true, breakpoints: { 'loop.py': [{ line: 4, enabled: true }] } });
  const p = await r.next(e => e.type === 'paused', 20000, 'entry pause');
  assert.deepEqual([p.reason, p.frames[0].file, p.frames[0].line], ['entry', 'loop.py', 1]);
  await m.continue();
  const p2 = await r.next(e => e.type === 'paused', 10000, 'the user breakpoint, not a one-off one');
  assert.deepEqual([p2.reason, p2.frames[0].line], ['breakpoint', 4]);
  assert.ok(!r.events.some(e => e.type === 'breakpoints' && e.lines.some(l => l !== 4)), 'one-off lines are never reported');
});

// ---- Python backend against a stand-in adapter (runs without debugpy) ----

// A tiny DAP adapter on a TCP port: answers like debugpy does (attach is answered only after configurationDone)
// and records every request it gets.
function fakeAdapter(root) {
  const got = [];
  const socks = new Set();
  const server = net.createServer(sock => {
    socks.add(sock);
    const reader = new DapReader();
    let seq = 1, attachSeq = null;
    const send = m => sock.write(frame({ seq: seq++, ...m }));
    const reply = (req, body = {}) => send({ type: 'response', request_seq: req.seq, command: req.command, success: true, body });
    sock.on('data', c => {
      for (const req of reader.push(c)) {
        got.push(req);
        const a = req.arguments || {};
        switch (req.command) {
          case 'initialize': reply(req, { supportsConfigurationDoneRequest: true }); break;
          case 'attach': attachSeq = req; send({ type: 'event', event: 'initialized' }); break;
          case 'setBreakpoints':
            reply(req, { breakpoints: a.breakpoints.map((b, i) => ({ id: i + 1, verified: b.line !== 99, line: b.line })) });
            break;
          case 'configurationDone':
            reply(req);
            reply(attachSeq);
            send({ type: 'event', event: 'output', body: { category: 'console', output: 'logpoint says hi\n' } });
            send({ type: 'event', event: 'output', body: { category: 'telemetry', output: 'x' } });
            send({ type: 'event', event: 'stopped', body: { reason: 'breakpoint', threadId: 7 } });
            break;
          case 'stackTrace':
            reply(req, { stackFrames: [
              { id: 11, name: '<module>', source: { path: path.join(root, 'sub', 'loop.py') }, line: 3, column: 1 },
              { id: 12, name: 'runpy', source: { path: path.join(path.dirname(root), 'elsewhere.py') }, line: 9, column: 5 },
            ] });
            break;
          case 'scopes': reply(req, { scopes: [{ name: 'Locals', variablesReference: 5 }, { name: 'Globals', variablesReference: 6 }] }); break;
          case 'variables': reply(req, { variables: [{ name: 'i', value: '3', type: 'int', variablesReference: 0 }, { name: 'xs', value: '[1, 2]', type: 'list', variablesReference: 9 }] }); break;
          case 'evaluate':
            if (a.expression === 'bad') send({ type: 'response', request_seq: req.seq, command: 'evaluate', success: false, message: "name 'bad' is not defined" });
            else reply(req, { result: '6', type: 'int', variablesReference: 0 });
            break;
          case 'setVariable': reply(req, { value: a.value, type: 'int', variablesReference: 0 }); break;
          default: reply(req);
        }
      }
    });
    sock.on('error', () => {});
  });
  const close = () => { for (const s of socks) s.destroy(); server.close(); };
  return { server, got, close };
}

test('PythonBackend: retries the connection, configures in debugpy order and maps the session', { timeout: 15000 }, async t => {
  const root = path.join(FIX, 'py root');
  const port = await new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const { server, got, close } = fakeAdapter(root);
  let b;
  t.after(() => { b?.close(); close(); });
  const events = [];
  const states = [];
  const file = path.join(root, 'sub', 'loop.py');
  const host = {
    root, file, stopOnEntry: false,
    bps: () => new Map([[file, [
      { line: 3, enabled: true, hitCondition: '2' },
      { line: 4, enabled: true, condition: 'i > 1', logMessage: 'i is {i}' },
      { line: 5, enabled: false },
      { line: 6, enabled: true, hitCondition: 'often' },
      { line: 99, enabled: true },
    ]]]),
    exceptions: () => 'uncaught',
    emit: e => events.push(e),
    setState: s => states.push(s),
    output: (stream, text) => events.push({ type: 'output', stream, text }),
    alive: () => true,
    warn: e => { throw e; },
    within: p => p,
    rel: abs => relOf(abs, root),
  };
  b = new PythonBackend(host, { python: 'python' });
  b.port = port;
  setTimeout(() => server.listen(port, '127.0.0.1'), 300); // debugpy takes a moment to listen
  await b.connect();

  assert.deepEqual(got.map(r => r.command).slice(0, 5), ['initialize', 'attach', 'setBreakpoints', 'setExceptionBreakpoints', 'configurationDone']);
  const sb = got.find(r => r.command === 'setBreakpoints').arguments;
  assert.equal(sb.source.path, file);
  assert.deepEqual(sb.breakpoints, [
    { line: 3, hitCondition: '>= 2' }, // a bare count means "from the 2nd hit on", as in the Node backend
    { line: 4, condition: 'i > 1', logMessage: 'i is {i}' },
    { line: 99 },
  ]);
  assert.deepEqual(got.find(r => r.command === 'setExceptionBreakpoints').arguments, { filters: ['uncaught'] });
  await waitUntil(() => events.some(e => e.type === 'paused'), 5000);
  assert.deepEqual(events.find(e => e.type === 'breakpoints'), { type: 'breakpoints', file: 'sub/loop.py', lines: [3, 4] });
  assert.deepEqual(events.find(e => e.type === 'output'), { type: 'output', stream: 'console', text: 'logpoint says hi\n' });
  assert.equal(events.filter(e => e.type === 'output').length, 1, 'telemetry is dropped');
  const p = events.find(e => e.type === 'paused');
  assert.equal(p.reason, 'breakpoint');
  assert.deepEqual(p.frames, [
    { id: 11, name: '<module>', file: 'sub/loop.py', line: 3, col: 1 },
    { id: 12, name: 'runpy', file: null, line: 9, col: 5 },
  ]);
  assert.deepEqual(states, ['paused']);

  assert.deepEqual(await b.scopes(11), [{ name: 'Locals', value: '', type: 'scope', ref: 5 }, { name: 'Globals', value: '', type: 'scope', ref: 6 }]);
  assert.deepEqual(await b.children(5), [{ name: 'i', value: '3', type: 'int', ref: 0 }, { name: 'xs', value: '[1, 2]', type: 'list', ref: 9 }]);
  assert.deepEqual(await b.evaluate('i * 2', 11, 'watch'), { name: 'i * 2', value: '6', type: 'int', ref: 0 });
  await assert.rejects(b.evaluate('bad', 11, 'repl'), /not defined/);
  assert.equal(got.find(r => r.command === 'evaluate').arguments.context, 'watch');
  assert.deepEqual(await b.setValue(5, 'i', '10'), { name: 'i', value: '10', type: 'int', ref: 0 });

  await b.step('over');
  assert.deepEqual(got.at(-1).command, 'next');
  assert.equal(got.at(-1).arguments.threadId, 7);
  assert.equal(states.at(-1), 'running');
  await b.disconnect();
  assert.equal(got.at(-1).command, 'disconnect');
  b.close();
});
