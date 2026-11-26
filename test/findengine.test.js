// Find in a normal file: the engine's findAll hits, turned into page offsets by editor.ts, are the hits the page's own
// search finds. editor.ts is a page script, so its find helpers are lifted out of the source and run on their own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { Engine } = require('../src/main/engine.js');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const lift = (src, name) => src.match(new RegExp(`\\n((?:async )?function ${name}\\b[\\s\\S]*?\\n})\\n`))[1];
const editor = read('src/renderer/breeze/editor.ts');
const ctx = vm.createContext({ FIND_MAX: 20000 });
vm.runInContext(stripTypeScriptTypes(read('src/renderer/editcore.ts')), ctx);
vm.runInContext(stripTypeScriptTypes(`${lift(editor, 'pageHits')}\n${lift(editor, 'hitOffsets')}`, { mode: 'transform' }), ctx);
const plain = v => JSON.parse(JSON.stringify(v));

const exe = path.join(__dirname, '..', 'runtime', process.platform === 'win32' ? 'breeze-engine.exe' : 'breeze-engine');
const skip = fs.existsSync(exe) ? false : 'engine not built: run npm run build:engine';

test('hitOffsets maps [line, col] pairs to offsets and refuses a hit that is not the query', () => {
  const text = 'ab\nxAB ab\nab';
  assert.deepEqual(plain(ctx.hitOffsets(text, [0, 0, 1, 1, 1, 4, 2, 0], 'ab', false)), [0, 4, 7, 10]);
  assert.equal(ctx.hitOffsets(text, [0, 0, 1, 1], 'ab', true), null);   // AB is not ab with case on
  assert.equal(ctx.hitOffsets(text, [9, 0], 'ab', false), null);        // a line the text doesn't have
  assert.equal(ctx.hitOffsets(text, [0, 1], 'ab', false), null);        // the engine's copy is behind
  assert.deepEqual(plain(ctx.hitOffsets(text, [], 'ab', false)), []);
});

test('pageHits finds non-overlapping hits, folding case unless asked not to', () => {
  assert.deepEqual(plain(ctx.pageHits('aaaa', 'aa', true)), [0, 2]);
  assert.deepEqual(plain(ctx.pageHits('École école', 'ÉCOLE', false)), [0, 6]);
  assert.deepEqual(plain(ctx.pageHits('École école', 'école', true)), [6]);
});

test('the engine finds what the page finds, CRLF files and non-ASCII included', { skip, timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-find-'));
  const e = new Engine({ exe, journalDir: path.join(dir, 'j') });
  let seed = 99;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
  const alphabet = ['a', 'A', 'b', 'é', 'É', '😀', ' ', '\n'];
  try {
    for (let round = 0; round < 12; round++) {
      const text = Array.from({ length: 3000 }, () => alphabet[next() % alphabet.length]).join('');
      const file = path.join(dir, `f${round}.txt`);
      fs.writeFileSync(file, round % 2 ? text.replaceAll('\n', '\r\n') : text);   // the page always holds \n
      const { doc } = await e.request('open', { path: file });
      for (const q of ['a', 'ab', 'Ab', 'é', 'éa', 'a😀', 'É É']) {
        for (const matchCase of [true, false]) {
          const r = await e.request('findAll', { doc, query: q, matchCase, limit: 20000 });
          const got = ctx.hitOffsets(text, r.hits, q, matchCase);
          assert.deepEqual(plain(got), plain(ctx.pageHits(text, q, matchCase)), `round ${round} query ${q} case ${matchCase}`);
          assert.equal(r.len, q.length);
        }
      }
    }
  } finally { e.stop(); }
});
