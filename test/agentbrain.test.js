const test = require('node:test');
const assert = require('node:assert/strict');
const brain = require('../src/main/agentbrain');

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const big = n => Array.from({ length: n }, (_, i) => `line ${i + 1}: ${'x'.repeat(60)}`).join('\n');
// A tool message must follow an assistant message that made that call; servers reject anything else.
function assertWellFormed(msgs) {
  assert.equal(msgs[0].role, 'system');
  const open = new Set();
  for (const m of msgs) {
    if (m.role === 'assistant') for (const c of m.tool_calls || []) open.add(c.id);
    if (m.role === 'tool') assert.ok(open.has(m.tool_call_id), `orphan tool reply ${m.tool_call_id}`);
  }
}

test('projectMap lists shallow folders first and stays under its size', () => {
  const files = ['index.html', 'src/app.js', 'src/ui/button.js', 'src/ui/menu.js', 'README.md'];
  const map = brain.projectMap(files);
  assert.equal(map.split('\n')[0], './: README.md, index.html');
  assert.match(map, /^src\/: app\.js$/m);
  assert.match(map, /^src\/ui\/: button\.js, menu\.js$/m);
  const many = Array.from({ length: 400 }, (_, i) => `pkg${i}/file.js`);
  const small = brain.projectMap(many, 300);
  assert.ok(small.length < 360);
  assert.match(small, /more folders \(use list_files\)$/);
});

test('projectMap shortens folders with many files', () => {
  const files = Array.from({ length: 20 }, (_, i) => `assets/f${String(i).padStart(2, '0')}.png`);
  assert.match(brain.projectMap(files), /f11\.png, … \(\+8 more\)$/);
});

test('readRange numbers lines and says how to read on', () => {
  const out = brain.readRange(big(300), 'a.js');
  const lines = out.split('\n');
  assert.equal(lines[0], `a.js lines 1-${brain.READ_LINES} of 300 (more: read_file with start_line=${brain.READ_LINES + 1})`);
  assert.equal(lines[1].slice(0, 11), '1| line 1: ');
  assert.equal(lines.length, brain.READ_LINES + 1);
  assert.equal(brain.readRange('a\nb\nc', 'b.txt', 2, 3), 'b.txt lines 2-3 of 3\n2| b\n3| c');
  // Out-of-range starts are clamped, and one call never returns more than READ_MAX_LINES lines.
  assert.match(brain.readRange('a\nb', 'c.txt', 99), /^c\.txt lines 2-2 of 2\n2\| b$/);
  assert.equal(brain.readRange(big(1000), 'd.js', 1, 1000).split('\n').length, brain.READ_MAX_LINES + 1);
});

test('readRange cuts very long lines', () => {
  const out = brain.readRange('x'.repeat(5000), 'min.js');
  assert.ok(out.length < 500);
  assert.ok(out.endsWith('…'));
});

test('applyEdit replaces exactly one match and keeps CRLF', () => {
  assert.deepEqual(brain.applyEdit('a\nb\nc\n', 'b', 'B'), { text: 'a\nB\nc\n', line: 2 });
  assert.equal(brain.applyEdit('one\r\ntwo\r\n', 'two\n', 'TWO\n').text, 'one\r\nTWO\r\n');
  assert.throws(() => brain.applyEdit('x x', 'x', 'y'), /matches 2 places/);
  assert.throws(() => brain.applyEdit('abc', 'zzz', 'y'), /was not found/);
  assert.throws(() => brain.applyEdit('abc', '', 'y'), /old_text is empty/);
});

test('applyEdit ignores line numbers pasted from read_file', () => {
  const text = 'function f() {\n  return 1;\n}\n';
  const r = brain.applyEdit(text, '2|   return 1;', '2|   return 2;');
  assert.equal(r.text, 'function f() {\n  return 2;\n}\n');
  // A snippet where only some lines look numbered is taken literally.
  assert.equal(brain.stripLineNumbers('1| a\nb'), '1| a\nb');
});

test('formatHits groups by file and caps the list', () => {
  const hits = [
    { path: 'a.js', line: 0, text: '  const x = 1;' },
    { path: 'a.js', line: 9, text: 'x++' },
    { path: 'b.js', line: 4, text: 'x()' },
  ];
  assert.equal(brain.formatHits(hits), 'a.js\n  1: const x = 1;\n  10: x++\nb.js\n  5: x()');
  assert.equal(brain.formatHits([]), 'No matches.');
  const many = Array.from({ length: 50 }, (_, i) => ({ path: 'c.js', line: i, text: 'hit' }));
  assert.match(brain.formatHits(many, 40), /… 10 more matches/);
});

test('callKey ignores argument order', () => {
  assert.equal(brain.callKey('read_file', { path: 'a', start_line: 1 }), brain.callKey('read_file', { start_line: 1, path: 'a' }));
  assert.notEqual(brain.callKey('read_file', { path: 'a' }), brain.callKey('read_file', { path: 'b' }));
});

test('settle trims old tool output and the text of applied writes', () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'fix it' },
    { role: 'assistant', content: '', tool_calls: [call('1', 'read_file', { path: 'a.js' })] },
    { role: 'tool', tool_call_id: '1', content: big(100) },
    { role: 'assistant', content: '', tool_calls: [call('2', 'write_file', { path: 'a.js', content: big(50) })] },
    { role: 'tool', tool_call_id: '2', content: 'Saved a.js (50 lines).' },
    { role: 'assistant', content: 'Done.' },
  ];
  const s = brain.settle(msgs);
  assert.match(s[3].content, /^\[Trimmed to save context\. It was read_file \{"path":"a\.js"\}/);
  assert.match(JSON.parse(s[4].tool_calls[0].function.arguments).content, /characters, already applied/);
  assert.equal(s[6].content, 'Done.');
  assert.ok(brain.historyTokens(s) < brain.historyTokens(msgs) / 5);
  assertWellFormed(s);
  // Settling twice changes nothing more.
  assert.deepEqual(brain.settle(s), s);
});

test('compactHistory leaves a small history alone', () => {
  const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }];
  assert.deepEqual(brain.compactHistory(msgs, 1000), msgs);
});

test('compactHistory keeps the newest results and fits the budget', () => {
  const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'task' }];
  for (let i = 0; i < 6; i++) {
    msgs.push({ role: 'assistant', content: '', tool_calls: [call(`c${i}`, 'read_file', { path: `f${i}.js` })] });
    msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: big(40) });
  }
  const out = brain.compactHistory(msgs, 2500);
  assert.ok(brain.historyTokens(out) <= 2500, `${brain.historyTokens(out)} tokens`);
  assert.equal(out.at(-1).content, msgs.at(-1).content); // the newest result is untouched
  assert.match(out[3].content, /^\[Trimmed/); // the oldest one is trimmed
  assert.equal(out[1].content, 'task');
  assertWellFormed(out);
});

test('compactHistory drops whole early exchanges, never leaving orphan tool replies', () => {
  const msgs = [{ role: 'system', content: 'sys' }];
  for (let t = 0; t < 8; t++) {
    msgs.push({ role: 'user', content: `question ${t} ${'q'.repeat(400)}` });
    msgs.push({ role: 'assistant', content: '', tool_calls: [call(`t${t}`, 'search_files', { query: 'x' })] });
    msgs.push({ role: 'tool', tool_call_id: `t${t}`, content: 'a.js\n  1: x' });
    msgs.push({ role: 'assistant', content: `answer ${t} ${'a'.repeat(400)}` });
  }
  msgs.push({ role: 'user', content: 'latest question' });
  const out = brain.compactHistory(msgs, 600);
  assert.ok(brain.historyTokens(out) <= 600);
  assert.equal(out.at(-1).content, 'latest question');
  assertWellFormed(out);
});

test('compactHistory cuts a single result that is too big on its own', () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
    { role: 'assistant', content: '', tool_calls: [call('x', 'read_file', { path: 'huge.js' })] },
    { role: 'tool', tool_call_id: 'x', content: big(2000) },
  ];
  const out = brain.compactHistory(msgs, 3000);
  assert.ok(brain.historyTokens(out) <= 3000);
  assert.match(out[3].content, /cut to fit the context/);
});

test('pathFilter takes a folder, a file name pattern or a path pattern', () => {
  const all = brain.pathFilter('');
  assert.equal(all('anything/at/all.js'), true);
  const folder = brain.pathFilter('src/main/');
  assert.equal(folder('src/main/main.js'), true);
  assert.equal(folder('src/mainly.js'), false);
  assert.equal(brain.pathFilter('README.md')('readme.md'), true);
  const css = brain.pathFilter('*.css');
  assert.equal(css('a/b/site.css'), true);
  assert.equal(css('a/site.css.map'), false);
  const ts = brain.pathFilter('src/**/*.ts');
  assert.equal(ts('src/a.ts'), true);
  assert.equal(ts('src/x/y/a.ts'), true);
  assert.equal(ts('lib/a.ts'), false);
  assert.equal(brain.pathFilter(String.raw`.\src\*.js`)('src/a.js'), true); // Windows separators
});

test('lineMatcher finds plain text or a regex, and explains a bad regex', () => {
  assert.equal(brain.lineMatcher('Foo')('a foo b'), 2);
  assert.equal(brain.lineMatcher('Foo', { caseSensitive: true })('a foo b'), -1);
  assert.equal(brain.lineMatcher('a.c')('abc'), -1); // plain text: the dot is a dot
  assert.equal(brain.lineMatcher(String.raw`function\s+\w+`, { regex: true })('x = function  go() {}'), 4);
  assert.throws(() => brain.lineMatcher('(', { regex: true }), /regex doesn't work/);
  assert.throws(() => brain.lineMatcher(''), /empty/);
});

test('replyReader rebuilds a streamed reply from pieces of any size', () => {
  const seen = [];
  const r = brain.replyReader((text, thinking) => seen.push([text, thinking]), () => 'call_x');
  const events = [
    { choices: [{ delta: { reasoning_content: 'hmm' } }] },
    { choices: [{ delta: { content: 'Hel' } }] },
    { choices: [{ delta: { content: 'lo' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.js"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, function: { name: 'list_files', arguments: '{}' } }] } }] },
    { choices: [], usage: { total_tokens: 42 } },
  ];
  const body = `${events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`;
  for (let i = 0; i < body.length; i += 7) r.push(body.slice(i, i + 7)); // cut mid-line on purpose
  const out = r.end();
  assert.equal(out.usage.total_tokens, 42);
  const msg = out.choices[0].message;
  assert.equal(msg.content, 'Hello');
  assert.deepEqual(msg.tool_calls.map(c => [c.id, c.function.name, c.function.arguments]), [['c1', 'read_file', '{"path":"a.js"}'], ['call_x', 'list_files', '{}']]);
  assert.deepEqual(seen[0], ['', true]);
  assert.ok(seen.some(([t]) => t === 'Hel'));
});

test('replyReader with no tool calls leaves tool_calls out, and throws a streamed error', () => {
  const r = brain.replyReader();
  r.push('data: {"choices":[{"delta":{"content":"hi"}}]}');
  assert.deepEqual(r.end().choices[0].message, { content: 'hi' });
  const bad = brain.replyReader();
  assert.throws(() => bad.push('data: {"error":{"message":"model not loaded"}}\n'), /model not loaded/);
});

test('partialString reads a string field from arguments that are still arriving', () => {
  assert.equal(brain.partialString('{"pa', 'path'), null);
  const args = String.raw`{"path": "src/a.js", "content": "line1\nli`;
  assert.deepEqual(brain.partialString(args, 'path'), { text: 'src/a.js', done: true });
  assert.deepEqual(brain.partialString(args, 'content'), { text: 'line1\nli', done: false });
  const bs = String.fromCharCode(92);
  assert.deepEqual(brain.partialString(`{"content":"say ${bs}"hi${bs}"${bs}`, 'content'), { text: 'say "hi"', done: false }); // half an escape waits
  assert.deepEqual(brain.partialString(`{"content":"${bs}u00e9${bs}u00`, 'content'), { text: String.fromCharCode(0xe9), done: false });
  assert.deepEqual(brain.partialString(String.raw`{"content":"a\\b"}`, 'content'), { text: String.raw`a\b`, done: true });
  assert.equal(brain.partialString(String.raw`{"content":"x \"path\": \"y"`, 'path'), null); // a key inside the text isn't one
});
