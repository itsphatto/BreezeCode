const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Engine, NOT_BUILT } = require('../src/main/engine.js');
const exe = path.join(__dirname, '..', 'runtime', process.platform === 'win32' ? 'breeze-engine.exe' : 'breeze-engine');
const skip = fs.existsSync(exe) ? false : 'engine not built: run npm run build:engine';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-engine-'));

test('open, lines, edit, save, close through the real engine', { skip }, async () => {
  const dir = tmp(), file = path.join(dir, 'f.txt'); fs.writeFileSync(file, 'ab\ncd');
  const e = new Engine({ exe, journalDir: path.join(dir, 'j') });
  const o = await e.request('open', { path: file });
  assert.deepEqual({ lines: o.lines, bytes: o.bytes, eol: o.eol, dirty: o.dirty }, { lines: 2, bytes: 5, eol: '\n', dirty: false });
  assert.deepEqual((await e.request('lines', { doc: o.doc, first: 0, count: 9 })).items.map(l => l.text), ['ab', 'cd']);
  const r = await e.request('edit', { doc: o.doc, start: { line: 0, col: 2 }, end: { line: 0, col: 2 }, text: '!', kind: 'type' });
  assert.deepEqual(r.caret, { line: 0, col: 3 });
  await e.request('save', { doc: o.doc });
  assert.equal(fs.readFileSync(file, 'utf8'), 'ab!\ncd');
  await e.request('close', { doc: o.doc });
  e.stop();
});
test('an engine error rejects with its message', { skip }, async () => {
  const e = new Engine({ exe, journalDir: tmp() });
  await assert.rejects(e.request('lines', { doc: 99, first: 0, count: 1 }), /That file isn't open/);
  e.stop();
});
test('the reply carries neither id nor ok', { skip }, async () => {
  const dir = tmp(), file = path.join(dir, 'f.txt'); fs.writeFileSync(file, 'x');
  const e = new Engine({ exe, journalDir: path.join(dir, 'j') });
  const o = await e.request('open', { path: file });
  assert.equal('id' in o, false);
  assert.equal('ok' in o, false);
  e.stop();
});
test('concurrent requests get their own replies', { skip }, async () => {
  const dir = tmp(), file = path.join(dir, 'f.txt'); fs.writeFileSync(file, Array.from({ length: 500 }, (_, i) => `L${i}`).join('\n'));
  const e = new Engine({ exe, journalDir: path.join(dir, 'j') });
  const { doc } = await e.request('open', { path: file });
  const got = await Promise.all([10, 200, 499].map(first => e.request('lines', { doc, first, count: 1 })));
  assert.deepEqual(got.map(g => g.items[0].text), ['L10', 'L200', 'L499']);
  e.stop();
});
test('non-ASCII text survives chunk edges exactly', { skip, timeout: 15000 }, async () => {
  const dir = tmp(), file = path.join(dir, 'u.txt');
  // Many lines of 2-, 3- and 4-byte characters: the reply is hundreds of KB, so it arrives in several chunks
  // and some chunk edge is bound to fall inside a character. The last line is one 200,000-unit line.
  const many = Array.from({ length: 12000 }, (_, i) => `é${i}😀日本語ü😀`);
  const long = 'é'.repeat(200000);
  fs.writeFileSync(file, [...many, long].join('\n'));
  const e = new Engine({ exe, journalDir: path.join(dir, 'j') });
  try {
    const { doc } = await e.request('open', { path: file });
    const got = await e.request('lines', { doc, first: 0, count: many.length });
    assert.deepEqual(got.items.map(l => l.text), many);
    const tail = (await e.request('lines', { doc, first: many.length, count: 1 })).items[0];
    assert.equal(tail.len, 200000);
    assert.equal(tail.text, 'é'.repeat(10000));
  } finally { e.stop(); }
});
test('a killed engine fires down, rejects what was waiting, and the next request restarts it', { skip }, async () => {
  const dir = tmp(), file = path.join(dir, 'f.txt'); fs.writeFileSync(file, 'x');
  const e = new Engine({ exe, journalDir: path.join(dir, 'j') });
  await e.request('open', { path: file });
  const down = new Promise(res => e.once('down', res));
  e.child.kill();                                   // `child` is the current ChildProcess, exposed for this test
  await down;
  assert.equal(e.running, false);
  assert.equal((await e.request('open', { path: file })).doc, 1);   // a fresh process numbers from 1 again
  e.stop();
});
test('a request written to a dying engine rejects instead of throwing EPIPE', { skip }, async () => {
  const dir = tmp(), file = path.join(dir, 'f.txt'); fs.writeFileSync(file, 'x');
  const e = new Engine({ exe, journalDir: path.join(dir, 'j') });
  await e.request('open', { path: file });
  const uncaught = [];
  const onUncaught = err => uncaught.push(err);
  process.on('uncaughtException', onUncaught);
  try {
    e.child.kill();
    // The process is dead (or dying) but its exit hasn't been seen yet: the write goes to a closed pipe.
    await assert.rejects(e.request('lines', { doc: 1, first: 0, count: 1 }), { message: 'The engine stopped' });
    await new Promise(res => setTimeout(res, 100));
  } finally { process.off('uncaughtException', onUncaught); }
  assert.deepEqual(uncaught, []);
  e.stop();
});
test('stop rejects what was waiting, and the next request restarts the engine', { skip }, async () => {
  const dir = tmp(), file = path.join(dir, 'f.txt'); fs.writeFileSync(file, 'x');
  const e = new Engine({ exe, journalDir: path.join(dir, 'j') });
  const waiting = e.request('open', { path: file });
  const rejected = assert.rejects(waiting, { message: 'The engine stopped' });
  e.stop();
  await rejected;
  assert.equal(e.running, false);
  assert.equal((await e.request('open', { path: file })).doc, 1);
  e.stop();
});
test('stop does not fire down', { skip }, async () => {
  const dir = tmp(), file = path.join(dir, 'f.txt'); fs.writeFileSync(file, 'x');
  const e = new Engine({ exe, journalDir: path.join(dir, 'j') });
  await e.request('open', { path: file });
  let fired = 0;
  e.on('down', () => fired++);
  e.stop();
  await new Promise(res => setTimeout(res, 200));
  assert.equal(fired, 0);
});
test('stop on an engine that never started does nothing', () => {
  const e = new Engine({ exe: path.join(tmp(), 'nope.exe'), journalDir: tmp() });
  e.stop();
  assert.equal(e.running, false);
});
test('a missing executable says how to build it', async () => {
  const e = new Engine({ exe: path.join(tmp(), 'nope.exe'), journalDir: tmp() });
  await assert.rejects(e.request('open', { path: 'x' }), { message: NOT_BUILT });
  assert.equal(e.running, false);
});
// engine.js with child_process.spawn replaced by `fake` (which returns a stand-in child), so a spawn error that comes
// after spawn returns (as a blocked exe's EACCES or EPERM does) can be made without a real executable.
function engineWithSpawn(fake) {
  const cp = require('node:child_process');
  const real = cp.spawn, key = require.resolve('../src/main/engine.js'), cached = require.cache[key];
  cp.spawn = fake;
  delete require.cache[key];
  try { return require('../src/main/engine.js'); } finally { cp.spawn = real; require.cache[key] = cached; }
}
function childThatFails(err) {
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.stdin.write = () => true;
  child.kill = () => {};
  process.nextTick(() => { child.emit('error', err); child.emit('close', -4058); });
  return child;
}
const spawnError = (code, file) => Object.assign(new Error(`spawn ${file} ${code}`), { code, errno: -1, syscall: `spawn ${file}`, path: file });

test('a spawn error after spawn returns rejects with the spawn message, so the page can tell the engine is off', async () => {
  const exeFile = __filename; // exists, so start() gets as far as spawn
  const { Engine: E } = engineWithSpawn(() => childThatFails(spawnError('EACCES', exeFile)));
  const e = new E({ exe: exeFile, journalDir: tmp() });
  await assert.rejects(e.request('open', { path: 'x' }), err => /^spawn .* EACCES$/.test(err.message));
  assert.equal(e.running, false);
});
test('an ENOENT spawn error after spawn returns still says how to build it', async () => {
  const exeFile = __filename;
  const { Engine: E, NOT_BUILT: NB } = engineWithSpawn(() => childThatFails(spawnError('ENOENT', exeFile)));
  const e = new E({ exe: exeFile, journalDir: tmp() });
  await assert.rejects(e.request('open', { path: 'x' }), { message: NB });
});
test('a 50 MB reply arrives intact and without quadratic scanning', { skip, timeout: 30000 }, async () => {
  const dir = tmp(), file = path.join(dir, 'big.txt');
  // A reply is one line, so its newline only shows up at the very end: re-scanning everything received so far
  // on each chunk would make this quadratic. 5,000 lines of 10,000 characters: none is cut by the engine.
  const rows = Array.from({ length: 5000 }, (_, i) => String.fromCharCode(97 + (i % 26)).repeat(9990) + String(i).padStart(10, '0'));
  const all = rows.join('\n');
  fs.writeFileSync(file, all);
  const e = new Engine({ exe, journalDir: path.join(dir, 'j') });
  try {
    const { doc } = await e.request('open', { path: file });
    const t0 = process.hrtime.bigint();
    const got = await e.request('text', { doc, start: { line: 0, col: 0 }, end: { line: rows.length - 1, col: 10000 } });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(got.text.length, all.length);
    assert.ok(got.text === all, 'the text came back unchanged');
    assert.ok(ms < 2000, `took ${Math.round(ms)} ms`);
  } finally { e.stop(); }
});
