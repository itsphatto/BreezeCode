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
