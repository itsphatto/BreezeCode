const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DebugManager, debugKind } = require('../src/main/debug');
const { typeName, packageOf } = require('../src/main/debugJava');
const { Writer, Reader, TAG } = require('../src/main/jdwp');

// The folder name has a space on purpose, as in debug.test.js.
const FIX = path.join(__dirname, 'fixtures', 'debug space');
const SIZES = { field: 8, method: 8, object: 8, ref: 8, frame: 8 };

test('debugKind: Java', () => assert.equal(debugKind('src/Main.java'), 'java'));

test('typeName and packageOf', () => {
  assert.equal(typeName('Lcom/x/Main$Inner;'), 'Main$Inner');
  assert.equal(typeName('[[I'), 'int[][]');
  assert.equal(packageOf('// package no;\npackage com.x;\nclass A {}'), 'com.x');
  assert.equal(packageOf('class A {}'), '');
});

test('jdwp Writer and Reader agree on values, ids and locations', () => {
  const w = new Writer(SIZES);
  w.value(TAG.INT, -5).value(TAG.LONG, 2n ** 40n).value(TAG.BOOLEAN, 1).value(TAG.DOUBLE, 1.5).value(TAG.CHAR, 65).str('héllo').object('ab');
  w.location({ tag: 1, cls: '01', method: '02', index: '0000000000000010' });
  const r = new Reader(w.bytes(), SIZES);
  assert.deepEqual(r.value(), { tag: TAG.INT, v: -5 });
  assert.deepEqual(r.value(), { tag: TAG.LONG, v: 2n ** 40n });
  assert.deepEqual(r.value(), { tag: TAG.BOOLEAN, v: true });
  assert.deepEqual(r.value(), { tag: TAG.DOUBLE, v: 1.5 });
  assert.deepEqual(r.value(), { tag: TAG.CHAR, v: 65 });
  assert.equal(r.str(), 'héllo');
  assert.equal(r.object(), '00000000000000ab');
  assert.deepEqual(r.location(), { tag: 1, cls: '0000000000000001', method: '0000000000000002', index: '0000000000000010' });
});

// ---- live sessions, when a JDK is on the PATH ----

const which = n => { try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', [n], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0].trim(); } catch { return null; } };
const JAVAC = which('javac');
const JAVA = JAVAC && which('java');
const withJdk = JAVAC && JAVA ? test : test.skip;
const FILE = path.join(FIX, 'Ask.java');

function recorder(m, t) {
  const events = [];
  let cursor = 0;
  m.on('event', e => events.push(e));
  t.after(async () => { await m.stop(); fs.rmSync(path.join(FIX, 'build', 'java'), { recursive: true, force: true }); });
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
const start = (m, bps, extra = {}) => m.start({
  file: FILE, root: FIX, java: JAVA, javac: JAVAC, breakpoints: { [FILE]: bps.map(line => ({ line, enabled: true })) }, ...extra,
});

withJdk('java: input, a breakpoint, locals, fields of an array, evaluate, step into, set a value, finish', { timeout: 90000 }, async t => {
  const m = new DebugManager();
  const r = recorder(m, t);
  await start(m, [10]);
  assert.deepEqual(await r.next(e => e.type === 'breakpoints' && e.lines.length > 0, 60000, 'verified breakpoints'), { type: 'breakpoints', file: 'Ask.java', lines: [10] });
  assert.equal(m.stdin('bob\n'), true);
  const p = await r.next(e => e.type === 'paused', 30000, 'pause');
  assert.equal(p.reason, 'breakpoint');
  assert.deepEqual([p.frames[0].file, p.frames[0].line, p.frames[0].name], ['Ask.java', 10, 'Ask.main']);
  const [locals] = await m.scopes(p.frames[0].id);
  const vars = await m.children(locals.ref);
  assert.equal(vars.find(v => v.name === 'x').value, '2');
  assert.equal(vars.find(v => v.name === 'name').value, '"bob"');
  const nums = vars.find(v => v.name === 'nums');
  assert.equal(nums.value, 'int[2]');
  assert.deepEqual((await m.children(nums.ref)).map(v => v.value), ['4', '5']);
  assert.equal((await m.evaluate('nums[1]', p.frames[0].id, 'watch')).value, '5');
  await assert.rejects(m.evaluate('x + 1', p.frames[0].id, 'repl'), /variables/);
  assert.equal((await m.setValue(locals.ref, 'x', '200')).value, '200');
  await m.step('into');
  const p2 = await r.next(e => e.type === 'paused', 30000, 'pause in add');
  assert.equal(p2.frames[0].name, 'Ask.add');
  await m.step('out');
  await r.next(e => e.type === 'paused', 30000, 'pause back in main');
  await m.continue();
  await r.next(e => e.type === 'exited', 30000, 'exit');
  assert.match(r.output(), /hi bob 205/);
});

withJdk('java: stop on entry, then an uncaught exception pauses with its message', { timeout: 90000 }, async t => {
  const m = new DebugManager();
  const r = recorder(m, t);
  await start(m, [], { stopOnEntry: true, exceptions: 'uncaught' });
  const p = await r.next(e => e.type === 'paused', 60000, 'pause');
  assert.equal(p.reason, 'entry');
  assert.equal(p.frames[0].line, 6);
  const [locals] = await m.scopes(p.frames[0].id);
  await m.setBreakpoints(FILE, [{ line: 11, enabled: true }]);
  await m.continue();
  m.stdin('zed\n');
  const p2 = await r.next(e => e.type === 'paused', 30000, 'breakpoint');
  const [l2] = await m.scopes(p2.frames[0].id);
  await m.setValue(l2.ref, 'z', '500');
  await m.continue();
  const p3 = await r.next(e => e.type === 'paused', 30000, 'exception');
  assert.equal(p3.reason, 'exception');
  assert.equal(p3.exception, 'IllegalStateException: too big: 500');
  assert.ok(locals.ref > 0);
  await m.stop();
});
