// The faster paths for agent logs and terminal progress lines. main.ts needs Electron and terminal.ts is a page script,
// so the functions are lifted out of their source and run on their own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const lift = (src, name) => src.match(new RegExp(`\\n((?:async )?function ${name}\\b[\\s\\S]*?\\n})\\n`))[1];
const main = read('src/main/main.ts');

function mainFns(month = '2026-11') {
  const src = `${lift(main, 'readLog')}\n${lift(main, 'lastLogLine')}`;
  const ctx = vm.createContext({ fs, Buffer, LOG_PIECE: 16, logCache: new Map(), usageMonth: () => month });
  vm.runInContext(stripTypeScriptTypes(src, { mode: 'transform' }), ctx);
  return ctx;
}
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-perf-')), 'log.jsonl');
const lines = (ctx, file) => ctx.readLog('t', file, () => [], (s, l) => { if (l) s.push(l); });

test('readLog reads only what a log gained, a piece at a time, and never half a line', async () => {
  const ctx = mainFns(), file = tmp();
  fs.writeFileSync(file, 'one\ntwo\nthree is longer than a piece\nfour-unfinish');
  assert.deepEqual(await lines(ctx, file), ['one', 'two', 'three is longer than a piece']);
  fs.appendFileSync(file, 'ed\nfive\n');
  assert.deepEqual(await lines(ctx, file), ['one', 'two', 'three is longer than a piece', 'four-unfinished', 'five']);
  assert.equal(ctx.logCache.get(`t:${file}`).offset, fs.statSync(file).size);
});

test('readLog starts over when a log shrinks or the month turns', async () => {
  const file = tmp();
  const ctx = mainFns();
  fs.writeFileSync(file, 'a\nb\n');
  await lines(ctx, file);
  fs.writeFileSync(file, 'c\n');
  assert.deepEqual(await lines(ctx, file), ['c']);
  const next = mainFns('2026-12');
  next.logCache = ctx.logCache;
  assert.deepEqual(await next.readLog('t', file, () => [], (s, l) => { if (l) s.push(l); }), ['c']);
  assert.equal(await ctx.readLog('t', path.join(path.dirname(file), 'missing.jsonl'), () => [], () => {}), null);
});

test('lastLogLine finds the last match from the tail, or in the whole file when it is further back', () => {
  const ctx = mainFns(), file = tmp();
  const filler = `${'x'.repeat(1000)}\n`.repeat(400); // 400 KB: more than the first 256 KB read
  fs.writeFileSync(file, `{"rate_limits":1}\n${filler}{"other":2}\n`);
  assert.equal(ctx.lastLogLine(file, l => l.includes('rate_limits')), '{"rate_limits":1}');
  fs.appendFileSync(file, '{"rate_limits":3}\n');
  assert.equal(ctx.lastLogLine(file, l => l.includes('rate_limits')), '{"rate_limits":3}');
  assert.equal(ctx.lastLogLine(file, l => l.includes('nothing')), undefined);
  fs.writeFileSync(file, '');
  assert.equal(ctx.lastLogLine(file, l => l.includes('rate_limits')), undefined);
});

test('a progress line keeps only its latest frame; a trailing \\r waits for its \\n', () => {
  const ctx = vm.createContext({});
  vm.runInContext(stripTypeScriptTypes(lift(read('src/renderer/breeze/terminal.ts'), 'lastFrame')), ctx);
  assert.equal(ctx.lastFrame('10%\r20%\r30%'), '30%');
  assert.equal(ctx.lastFrame('10%\r20%\r'), '20%\r');
  assert.equal(ctx.lastFrame('\r'), '\r');
  assert.equal(ctx.lastFrame('Name: '), 'Name: ');
  assert.equal(ctx.lastFrame(''), '');
});

test('agent and kernel output look for newlines in the new chunk only', () => {
  assert.doesNotMatch(main, /buf \+= chunk;\s*const lines = buf\.split/);
  assert.doesNotMatch(read('src/main/kernel.ts'), /k\.buf \+= dec\.write/);
});
