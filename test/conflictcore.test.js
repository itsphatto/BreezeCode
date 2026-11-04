const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const ctx = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(fs.readFileSync(require.resolve('../src/renderer/breeze/conflictcore.ts'), 'utf8')), ctx);
const { parseConflicts, applyChoice, hasMarkers } = vm.runInContext('({ parseConflicts, applyChoice, hasMarkers })', ctx);
const plain = v => JSON.parse(JSON.stringify(v));

const TWO = ['a', '<<<<<<< HEAD', 'o1', 'o2', '=======', 't1', '>>>>>>> origin/main', 'mid', '<<<<<<< HEAD', 'o3', '=======', 't3', 't4', '>>>>>>> origin/main', 'z', ''].join('\n');

test('parses two blocks with their sides and offsets', () => {
  const blocks = plain(parseConflicts(TWO));
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].ours, 'o1\no2\n');
  assert.equal(blocks[0].theirs, 't1\n');
  assert.equal(blocks[1].ours, 'o3\n');
  assert.equal(blocks[1].theirs, 't3\nt4\n');
  assert.equal(TWO.slice(blocks[0].start, blocks[0].start + 7), '<<<<<<<');
  assert.ok(TWO.slice(blocks[0].start, blocks[0].end).endsWith('>>>>>>> origin/main\n'));
  assert.equal(TWO.slice(blocks[0].end, blocks[0].end + 4), 'mid\n');
  assert.equal(TWO.slice(blocks[1].end), 'z\n');
});

test('no blocks in clean text, and an unfinished block is not parsed', () => {
  assert.deepEqual(plain(parseConflicts('just\ntext\n')), []);
  assert.deepEqual(plain(parseConflicts('<<<<<<< HEAD\nx\n=======\ny\n')), []);
});

test('use ours, theirs and both', () => {
  const [b1, b2] = parseConflicts(TWO);
  assert.equal(applyChoice(TWO, b1, 'ours'), TWO.slice(0, b1.start) + 'o1\no2\n' + TWO.slice(b1.end));
  const theirs = applyChoice(TWO, b1, 'theirs');
  assert.equal(theirs.split('\n').slice(0, 3).join('\n'), 'a\nt1\nmid');
  assert.equal(parseConflicts(theirs).length, 1);
  const both = applyChoice(TWO, b2, 'both');
  assert.ok(both.includes('o3\nt3\nt4\nz\n'));
  assert.equal(parseConflicts(both).length, 1);
});

test('custom text replaces the whole block', () => {
  const [b1] = parseConflicts(TWO);
  const out = applyChoice(TWO, b1, { custom: 'mine\n' });
  assert.ok(out.startsWith('a\nmine\nmid\n'));
});

test('CRLF text keeps its line endings and loses its markers', () => {
  const crlf = TWO.replace(/\n/g, '\r\n');
  const blocks = parseConflicts(crlf);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].theirs, 't1\r\n');
  const out = applyChoice(crlf, blocks[0], 'theirs');
  assert.ok(out.startsWith('a\r\nt1\r\nmid\r\n'));
  const done = applyChoice(out, parseConflicts(out)[0], 'theirs');
  assert.ok(done.includes('\r\n'));
  assert.equal(hasMarkers(done), false);
  assert.equal(parseConflicts(done).length, 0);
});

test('diff3 base section is dropped', () => {
  const t = '<<<<<<< HEAD\nours\n||||||| base\nold\n=======\ntheirs\n>>>>>>> main\n';
  const [b] = parseConflicts(t);
  assert.equal(b.ours, 'ours\n');
  assert.equal(b.theirs, 'theirs\n');
  assert.equal(applyChoice(t, b, 'both'), 'ours\ntheirs\n');
});

test('a block at the end of a file without a final newline', () => {
  const t = 'x\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> main';
  const [b] = parseConflicts(t);
  assert.equal(b.end, t.length);
  assert.equal(applyChoice(t, b, 'theirs'), 'x\nb');
});

test('hasMarkers', () => {
  assert.equal(hasMarkers(TWO), true);
  assert.equal(hasMarkers('<<<<<<< HEAD\nleft behind\n'), true);
  assert.equal(hasMarkers('fine\n=======\nheading underline\n'), false);
  assert.equal(hasMarkers('a <<<<<<< b\n'), false);
  assert.equal(hasMarkers(''), false);
});

test('withEol puts CRLF back, and leaves LF files alone', () => {
  const withEol = vm.runInContext('withEol', ctx);
  assert.equal(withEol('a\nb\r\nc\n', true), 'a\r\nb\r\nc\r\n');
  assert.equal(withEol('a\nb\n', false), 'a\nb\n');
  assert.equal(withEol('', true), '');
});
