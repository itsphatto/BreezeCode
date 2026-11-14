const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const ctx = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(fs.readFileSync(require.resolve('../src/renderer/breeze/explaincore.ts'), 'utf8')), ctx);
const { explainPrompt, explainContext, placeCard, tidyExplain, askDraft, EXPLAIN_MAX } = vm.runInContext('({ explainPrompt, explainContext, placeCard, tidyExplain, askDraft, EXPLAIN_MAX })', ctx);
const plain = v => JSON.parse(JSON.stringify(v));

test('the prompt names the file, the lines, the code and its surroundings', () => {
  const p = explainPrompt({ path: 'src/a.ts', lang: 'TypeScript', first: 3, last: 5, code: 'let x = 1;', before: '// above', after: '// below' });
  assert.match(p, /src\/a\.ts/);
  assert.match(p, /lines 3-5/);
  assert.match(p, /TypeScript/);
  assert.match(p, /```\nlet x = 1;\n```/);
  assert.match(p, /\/\/ above/);
  assert.match(p, /\/\/ below/);
  assert.doesNotMatch(p, /\(cut\)/);
});

test('a single line says "line", not a range', () => {
  const p = explainPrompt({ path: 'a.py', lang: 'Python', first: 7, last: 7, code: 'x', before: '', after: '' });
  assert.match(p, /line 7\b/);
  assert.doesNotMatch(p, /lines 7-7/);
});

test('code longer than EXPLAIN_MAX is cut and the prompt says so', () => {
  assert.equal(EXPLAIN_MAX, 12000);
  const p = explainPrompt({ path: 'a.js', lang: 'JavaScript', first: 1, last: 1, code: 'a'.repeat(15000), before: '', after: '' });
  assert.ok(p.includes('a'.repeat(12000)));
  assert.ok(!p.includes('a'.repeat(12001)));
  assert.match(p, /\(cut\)/);
});

test('context is up to 20 lines each side, with 1-based line numbers', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `L${i + 1}`);
  const text = lines.join('\n');
  const start = text.indexOf('L30'), end = text.indexOf('L32') + 3;
  const c = plain(explainContext(text, start, end));
  assert.equal(c.first, 30);
  assert.equal(c.last, 32);
  assert.equal(c.before.split('\n').length, 20);
  assert.equal(c.before.split('\n')[0], 'L10');
  assert.equal(c.before.split('\n').at(-1), 'L29');
  assert.equal(c.after.split('\n')[0], 'L33');
  assert.equal(c.after.split('\n').length, 20);
});

test('context near the top of the file is shorter, and a selection ending on a line break stops at that line', () => {
  const text = 'a\nb\nc\nd\n';
  const c = plain(explainContext(text, 0, 4)); // "a\nb\n"
  assert.equal(c.first, 1);
  assert.equal(c.last, 2);
  assert.equal(c.before, '');
  assert.equal(c.after, 'c\nd\n');
});

test('the card sits below the point, flips above near the bottom, and stays inside the window', () => {
  assert.deepEqual(plain(placeCard(100, 100, 300, 200, 1200, 800)), { left: 100, top: 112 });
  assert.deepEqual(plain(placeCard(100, 700, 300, 200, 1200, 800)), { left: 100, top: 488 });
  assert.deepEqual(plain(placeCard(1100, 100, 300, 200, 1200, 800)), { left: 892, top: 112 });
  assert.deepEqual(plain(placeCard(100, 150, 300, 600, 1200, 700)), { left: 100, top: 92 }); // fits neither way: as low as it still fits whole
});

test('Markdown headings in the reply become bold lines, and code fences are left alone', () => {
  assert.equal(tidyExplain('## What it does\n\nIt adds.\n### How'), '**What it does**\n\nIt adds.\n**How**');
  assert.equal(tidyExplain('```\n# a comment\n```'), '```\n# a comment\n```');
  assert.equal(tidyExplain('#notaheading'), '#notaheading');
});

test('the prompt asks for a short answer in plain words', () => {
  const p = explainPrompt({ path: 'a.js', lang: 'JavaScript', first: 1, last: 2, code: 'x()', before: '', after: '' });
  assert.match(p, /plain, simple words/);
  assert.match(p, /under 80 words/);
  assert.match(p, /no headings/i);
  assert.match(p, /jargon/);
});

test('the Ask draft names the file and lines, and carries short code', () => {
  const d = askDraft({ path: 'src/a.ts', first: 3, last: 4, code: 'let x = 1;\nx++;\n' });
  assert.equal(d, 'About src/a.ts lines 3–4:\n```\nlet x = 1;\nx++;\n```\n\n');
  assert.equal(askDraft({ path: 'a.py', first: 7, last: 7, code: 'x' }), 'About a.py line 7:\n```\nx\n```\n\n');
});

test('the Ask draft leaves out code longer than 40 lines: the agent can read the file', () => {
  const code = Array.from({ length: 41 }, (_, i) => `l${i}`).join('\n');
  assert.equal(askDraft({ path: 'big.c', first: 10, last: 50, code }), 'About big.c lines 10–50:\n\n');
});
