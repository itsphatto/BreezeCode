const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const ctx = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(fs.readFileSync(require.resolve('../src/renderer/breeze/conflictcore.ts'), 'utf8')), ctx);
const { parseConflicts, applyChoice, hasMarkers, duelPrompts, extractCodeBlock, withoutCodeBlock, blockContext } = vm.runInContext('({ parseConflicts, applyChoice, hasMarkers, duelPrompts, extractCodeBlock, withoutCodeBlock, blockContext })', ctx);
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

const duelInput = { path: 'src/app.ts', before: 'import a;\n', ours: 'const x = 1;\n', theirs: 'const x = 2;\n', after: 'export x;\n' };

test('duelPrompts: both advocates see the path, both versions and the context', () => {
  const p = duelPrompts(duelInput);
  for (const prompt of [p.ours, p.theirs]) {
    assert.ok(prompt.includes('src/app.ts'));
    assert.ok(prompt.includes('const x = 1;'));
    assert.ok(prompt.includes('const x = 2;'));
    assert.ok(prompt.includes('import a;'));
    assert.ok(prompt.includes('export x;'));
    assert.ok(/120 words/.test(prompt));
  }
  assert.notEqual(p.ours, p.theirs);
  assert.ok(/ours/i.test(p.ours));
  assert.ok(/theirs/i.test(p.theirs));
});

test('duelPrompts: the judge gets both arguments and asks for one fenced block', () => {
  const j = duelPrompts(duelInput).judge('Ours is safer.', 'Theirs is newer.');
  assert.ok(j.includes('src/app.ts'));
  assert.ok(j.includes('const x = 1;') && j.includes('const x = 2;'));
  assert.ok(j.includes('Ours is safer.') && j.includes('Theirs is newer.'));
  assert.ok(/80 words/.test(j));
  assert.ok(/exactly one/i.test(j) && j.includes('```'));
});

test('extractCodeBlock: first fenced block without its fence line or language tag', () => {
  assert.equal(extractCodeBlock('Verdict…\n```ts\nconst a = 1;\n```'), 'const a = 1;');
  assert.equal(extractCodeBlock('Both.\n```\na\nb\n```\nthen\n```\nc\n```\n'), 'a\nb');
  assert.equal(extractCodeBlock('x\r\n```js\r\nline\r\n```\r\n'), 'line');
});

test('extractCodeBlock: a longer fence holds code that has a ``` line itself', () => {
  assert.equal(extractCodeBlock('Verdict.\n````md\nintro\n```ts\nconst a = 1;\n```\noutro\n````\n'), 'intro\n```ts\nconst a = 1;\n```\noutro');
  assert.equal(extractCodeBlock('````\na\n```\nb\n````'), 'a\n```\nb');
  assert.equal(extractCodeBlock('```\nplain\n```'), 'plain'); // three backticks still work
  assert.equal(extractCodeBlock('~~~\nno\n~~~'), null);
});

test('extractCodeBlock: the closing fence is a line of its own, at least as long as the opener', () => {
  assert.equal(extractCodeBlock('```\nabc ```def\nghi\n```'), 'abc ```def\nghi');
  assert.equal(extractCodeBlock('````\na\n```\n'), null);
  assert.equal(extractCodeBlock('```\nx\n`````\n'), 'x'); // longer closer is fine
  assert.equal(extractCodeBlock('```\n```\nfoo\n```\nbar'), '');
});

test('duelPrompts: code goes in four-backtick fences, the judge is asked for one too, and no tools are allowed', () => {
  const p = duelPrompts({ ...duelInput, ours: 'a\n```\nb\n' });
  for (const prompt of [p.ours, p.theirs, p.judge('x', 'y')]) {
    assert.ok(prompt.includes('````\nconst x = 1;\n````') || prompt.includes('````\na\n```\nb\n````'));
    assert.ok(prompt.includes('Do not run commands, read files or use any tools; answer only from the text in this message.'));
  }
  assert.ok(/four backticks/i.test(p.judge('x', 'y')));
  const wide = duelPrompts({ ...duelInput, ours: 'a\n````\nb\n' }).ours;
  assert.ok(wide.includes('`````\na\n````\nb\n`````')); // a fence longer than any run in the code
});

test('extractCodeBlock: null without a fence, or with one that never closes', () => {
  assert.equal(extractCodeBlock('No code here.'), null);
  assert.equal(extractCodeBlock('```ts\nconst a = 1;\n'), null);
  assert.equal(extractCodeBlock(''), null);
});

test('extractCodeBlock: an empty block is an empty merge', () => {
  assert.equal(extractCodeBlock('Drop both.\n```\n```'), '');
});

test('withoutCodeBlock: the reply minus its first fenced block', () => {
  assert.equal(withoutCodeBlock('Verdict.\n\n```ts\nconst a = 1;\n```\n'), 'Verdict.');
  assert.equal(withoutCodeBlock('A\n```\nx\n```\nB\n```\ny\n```'), 'A\nB\n```\ny\n```');
  assert.equal(withoutCodeBlock('No code.'), 'No code.');
});

test('blockContext: up to N lines on each side of the block', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `l${i}`);
  const text = [...lines.slice(0, 50), '<<<<<<< HEAD', 'o', '=======', 't', '>>>>>>> main', ...lines.slice(50)].join('\n') + '\n';
  const [b] = parseConflicts(text);
  const ctx40 = plain(blockContext(text, b));
  assert.equal(ctx40.before.split('\n').length - 1, 40);
  assert.ok(ctx40.before.startsWith('l10\n') && ctx40.before.endsWith('l49\n'));
  assert.ok(ctx40.after.startsWith('l50\n') && ctx40.after.endsWith('l89\n'));
  const ctx2 = plain(blockContext(text, b, 2));
  assert.equal(ctx2.before, 'l48\nl49\n');
  assert.equal(ctx2.after, 'l50\nl51\n');
});

test('blockContext: short files, and a block at the very start or end', () => {
  const t = '<<<<<<< HEAD\no\n=======\nt\n>>>>>>> main\nrest\nend';
  const [b] = parseConflicts(t);
  assert.deepEqual(plain(blockContext(t, b)), { before: '', after: 'rest\nend' });
  const u = 'top\n<<<<<<< HEAD\no\n=======\nt\n>>>>>>> main';
  const [c] = parseConflicts(u);
  assert.deepEqual(plain(blockContext(u, c)), { before: 'top\n', after: '' });
  const v = '\n<<<<<<< HEAD\no\n=======\nt\n>>>>>>> main\n';
  assert.equal(plain(blockContext(v, parseConflicts(v)[0])).before, '\n');
});
