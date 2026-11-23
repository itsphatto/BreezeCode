// Debugging .jsx, .tsx and .cts files with the Node backend: compile, then break in the source through its source map.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { DebugManager, debugKind, launchArgs } = require('../src/main/debug');
const { bundledTsc, jsxProject } = require('./helpers/jsxProject');

test('debugKind: .cts, .jsx and .tsx are Node files', () => {
  for (const f of ['a.cts', 'a.jsx', 'a.tsx', 'dir/App.TSX']) assert.equal(debugKind(f), 'node', f);
});

test('launchArgs: a compiled file runs from its output with the source-map and import hooks first', () => {
  assert.deepEqual(launchArgs('node', '/p/a.tsx', { ts: false, entry: '/p/build/jsx/a.js', nodeArgs: ['--enable-source-maps'] }),
    { args: ['--inspect-brk=127.0.0.1:0', '--enable-source-maps', '/p/build/jsx/a.js'] });
  assert.deepEqual(launchArgs('node', '/p/a.cts', { ts: true }), { args: ['--inspect-brk=127.0.0.1:0', '--experimental-strip-types', '/p/a.cts'] });
});

async function waitUntil(cond, ms) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms`);
    await new Promise(r => setTimeout(r, 10));
  }
}
function recorder(m, t) {
  const events = [];
  let cursor = 0;
  m.on('event', e => events.push(e));
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

test('node: a .cts file breaks on the right line', { timeout: 20000 }, async t => {
  const p = jsxProject();
  t.after(p.cleanup);
  const file = p.put('calc.cts', 'function twice(n: number): number {\n  const r = n * 2;\n  return r;\n}\nconsole.log("twice", twice(21));\n');
  const m = new DebugManager();
  const r = recorder(m, t);
  await m.start({ file, root: p.dir, node: process.execPath, breakpoints: { [file]: [{ line: 3, enabled: true }] } });
  const paused = await r.next(e => e.type === 'paused', 15000, 'pause');
  assert.deepEqual([paused.frames[0].file, paused.frames[0].line, paused.frames[0].name], ['calc.cts', 3, 'twice']);
  await m.continue();
  assert.equal((await r.next(e => e.type === 'exited', 10000, 'exit')).code, 0);
  assert.match(r.output(), /twice 42/);
});

test('node: a .tsx file breaks and steps in the source file, in a project with react in node_modules', { skip: !bundledTsc(), timeout: 60000 }, async t => {
  const p = jsxProject();
  t.after(p.cleanup);
  const m = new DebugManager();
  const r = recorder(m, t);
  // Line 6 of main.tsx is `const twice = p.n * 2;`, inside double(). Lines 4 (a type) has no code: it stays unverified.
  await m.start({ file: p.main, root: p.dir, node: process.execPath, tsc: bundledTsc(), jsRoot: p.dir, breakpoints: { [p.main]: [{ line: 4, enabled: true }, { line: 6, enabled: true }] } });
  const bps = await r.next(e => e.type === 'breakpoints' && e.lines.length > 0, 30000, 'verified breakpoints');
  assert.deepEqual(bps, { type: 'breakpoints', file: 'src/main.tsx', lines: [6] });
  const paused = await r.next(e => e.type === 'paused', 15000, 'pause');
  assert.equal(paused.reason, 'breakpoint');
  assert.deepEqual([paused.frames[0].file, paused.frames[0].line, paused.frames[0].name], ['src/main.tsx', 6, 'double']);
  assert.equal(paused.frames[1].file, 'src/main.tsx'); // the caller, mapped too
  assert.equal(paused.frames[1].line, 10);

  const frameId = paused.frames[0].id;
  assert.equal((await m.evaluate('p.n', frameId, 'watch')).value, '21');

  await m.step('over');
  const next = await r.next(e => e.type === 'paused', 10000, 'pause after step');
  assert.deepEqual([next.frames[0].file, next.frames[0].line], ['src/main.tsx', 7]);

  await m.setBreakpoints(p.main, []);
  await m.continue();
  assert.equal((await r.next(e => e.type === 'exited', 10000, 'exit')).code, 0);
  assert.match(r.output(), /react 19\.0\.0-stand-in 42/);
});

test('node: a breakpoint in a .jsx file that the .tsx file imports binds there', { skip: !bundledTsc(), timeout: 60000 }, async t => {
  const p = jsxProject();
  t.after(p.cleanup);
  const greeting = path.join(p.dir, 'src', 'Greeting.jsx');
  const m = new DebugManager();
  const r = recorder(m, t);
  await m.start({ file: p.main, root: p.dir, node: process.execPath, tsc: bundledTsc(), jsRoot: p.dir, breakpoints: { [greeting]: [{ line: 2, enabled: true }] } });
  const paused = await r.next(e => e.type === 'paused', 45000, 'pause');
  assert.deepEqual([paused.frames[0].file, paused.frames[0].line, paused.frames[0].name], ['src/Greeting.jsx', 2, 'Greeting']);
  await m.continue();
  assert.equal((await r.next(e => e.type === 'exited', 10000, 'exit')).code, 0);
});

test('node: a .tsx file that does not compile ends the session with the compiler\'s message in the Output', { skip: !bundledTsc(), timeout: 60000 }, async t => {
  const p = jsxProject();
  t.after(p.cleanup);
  const m = new DebugManager();
  const r = recorder(m, t);
  await m.start({ file: p.bad, root: p.dir, node: process.execPath, tsc: bundledTsc(), jsRoot: p.dir });
  const err = await r.next(e => e.type === 'error', 30000, 'error');
  assert.match(err.message, /bad\.tsx has errors that stop it compiling/);
  await r.next(e => e.type === 'state' && e.state === 'stopped', 5000, 'stopped');
  assert.match(r.output(), /bad\.tsx\(1,12\): error TS\d+/);
});

test('node: a .tsx file with no compiler available says so', { timeout: 20000 }, async t => {
  const p = jsxProject();
  t.after(p.cleanup);
  const m = new DebugManager();
  const r = recorder(m, t);
  await m.start({ file: p.main, root: p.dir, node: process.execPath });
  const err = await r.next(e => e.type === 'error', 10000, 'error');
  assert.match(err.message, /needs the TypeScript compiler that comes with Breeze/);
  assert.ok(!fs.existsSync(path.join(p.dir, 'build')));
});
