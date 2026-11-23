const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { SourceMap } = require('../src/main/sourcemap');

const dir = path.resolve('some', 'build');
const mapFile = path.join(dir, 'out.js.map');
const src = path.resolve('some', 'src.tsx');

// out.js line 0: "use strict" (no source); line 1: two segments for src line 4; line 2: one for src line 5.
// mappings: ';' per generated line, VLQ fields [genCol, source, srcLine, srcCol] as deltas.
//   line 0: (empty)   line 1: AAIA  = col 0 -> src 0, line +4, col 0  then  KAAK = col +5, line +0, col +5
//   line 2: AACA = col 0, line +1, col 0
const json = JSON.stringify({ version: 3, file: 'out.js', sourceRoot: '', sources: ['../src.tsx'], names: [], mappings: ';AAIA,KAAK;AACA' });

test('parse: sources resolve against the map\'s folder', () => {
  const m = SourceMap.parse(json, mapFile);
  assert.deepEqual(m.sources, [src]);
  assert.ok(m.has(src));
});

test('original: the segment at or before the position, the first one before any', () => {
  const m = SourceMap.parse(json, mapFile);
  assert.deepEqual(m.original(1, 0), { source: src, line: 4, col: 0 });
  assert.deepEqual(m.original(1, 3), { source: src, line: 4, col: 0 });
  assert.deepEqual(m.original(1, 5), { source: src, line: 4, col: 5 });
  assert.deepEqual(m.original(2, 40), { source: src, line: 5, col: 5 }); // source columns are deltas that carry across lines
  assert.deepEqual(m.original(0, 0), { source: src, line: 4, col: 0 }); // the "use strict" line
});

test('generated: where a source line first runs; null for a line with no code', () => {
  const m = SourceMap.parse(json, mapFile);
  assert.deepEqual(m.generated(src, 4), { line: 1, col: 0 });
  assert.deepEqual(m.generated(src, 5), { line: 2, col: 0 });
  assert.equal(m.generated(src, 6), null);
  assert.equal(m.generated(path.resolve('other.tsx'), 4), null);
});

test('parse: a map that is not usable is null', () => {
  assert.equal(SourceMap.parse('not json', mapFile), null);
  assert.equal(SourceMap.parse(JSON.stringify({ version: 2, sources: [], mappings: '' }), mapFile), null);
  assert.equal(SourceMap.parse(JSON.stringify({ version: 3, sources: ['a'], mappings: 'AAAA,!' }), mapFile), null);
  assert.equal(SourceMap.parse(JSON.stringify({ version: 3, sources: ['a'], mappings: 'ACAA' }), mapFile), null); // source index out of range
});

test('parse: large and negative VLQ numbers', () => {
  const enc = n => { let v = n < 0 ? (-n << 1) | 1 : n << 1, s = ''; do { let d = v & 31; v >>>= 5; if (v) d |= 32; s += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'[d]; } while (v); return s; };
  const mappings = enc(0) + enc(0) + enc(1000) + enc(0) + ';' + enc(0) + enc(0) + enc(-999) + enc(0);
  const m = SourceMap.parse(JSON.stringify({ version: 3, sources: ['a.js'], mappings }), mapFile);
  assert.equal(m.original(0, 0).line, 1000);
  assert.equal(m.original(1, 0).line, 1);
});
