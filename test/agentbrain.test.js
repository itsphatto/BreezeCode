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
  assert.deepEqual(brain.applyEdit('a\nb\nc\n', 'b', 'B'), { text: 'a\nB\nc\n', line: 2, count: 1 });
  assert.equal(brain.applyEdit('one\r\ntwo\r\n', 'two\n', 'TWO\n').text, 'one\r\nTWO\r\n');
  assert.throws(() => brain.applyEdit('x x', 'x', 'y'), /matches 2 places/);
  assert.throws(() => brain.applyEdit('abc', 'zzz', 'y'), /was not found/);
  assert.throws(() => brain.applyEdit('abc', '', 'y'), /old_text is empty/);
});

test('applyEdit with all set changes every match (a rename in one call)', () => {
  assert.deepEqual(brain.applyEdit('oldName(1);\r\nx = oldName;\r\n', 'oldName', 'newName', true), { text: 'newName(1);\r\nx = newName;\r\n', line: 1, count: 2 });
  assert.throws(() => brain.applyEdit('x x', 'x', 'y'), /set replace_all/); // the error says how
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

test('formatHits with context shows the lines around each match, joined where they meet', () => {
  const lines = ['a', '  b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const hits = [{ path: 'x.js', line: 1, text: '  b' }, { path: 'x.js', line: 3, text: 'd' }, { path: 'x.js', line: 7, text: 'h' }];
  assert.equal(brain.formatHits(hits, 40, { context: 1 }, p => (p === 'x.js' ? lines : undefined)),
    'x.js\n  1- a\n  2:   b\n  3- c\n  4: d\n  5- e\n  --\n  7- g\n  8: h');
  assert.equal(brain.formatHits(hits.slice(0, 1), 40, { context: 1 }), 'x.js\n  2: b'); // no lines to hand: plain hits
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
  const code = brain.pathFilter('*.{js,ts}');
  assert.equal(code('src/a.ts'), true);
  assert.equal(code('src/a.css'), false);
  assert.equal(brain.pathFilter('src/{main,renderer}/**/*.ts')('src/renderer/x/a.ts'), true);
  assert.equal(brain.pathFilter('src/{main,renderer}/**/*.ts')('src/lib/a.ts'), false);
});

test('formatHits says why a plain-text search with regex syntax found nothing', () => {
  assert.match(brain.formatHits([], 40, { query: 'foo|bar' }), /plain-text search[\s\S]*regex to true/);
  assert.equal(brain.formatHits([], 40, { query: 'foo|bar', regex: true }), 'No matches.');
  assert.equal(brain.formatHits([], 40, { query: 'plain words' }), 'No matches.');
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

test('replyReader keeps a call\'s extra_content (Gemini\'s thought_signature) so it can go back', () => {
  const r = brain.replyReader();
  const events = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.js"}' }, extra_content: { google: { thought_signature: 'SIG' } } }] } }] },
  ];
  r.push(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''));
  const [call] = r.end().choices[0].message.tool_calls;
  assert.equal(call.function.arguments, '{"path":"a.js"}');
  assert.deepEqual(call.extra_content, { google: { thought_signature: 'SIG' } });
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

test('readInstructions imports Claude and Codex instruction files, project last, without duplicates', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-instr-'));
  const dir = (...p) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
  const homes = { claudeHome: dir('claude'), codexHome: dir('codex') }, base = dir('proj');
  fs.writeFileSync(path.join(homes.claudeHome, 'CLAUDE.md'), 'Use tabs.');
  fs.writeFileSync(path.join(homes.codexHome, 'AGENTS.md'), 'ignored: the override wins');
  fs.writeFileSync(path.join(homes.codexHome, 'AGENTS.override.md'), 'Write tests.');
  fs.writeFileSync(path.join(dir('proj', '.claude'), 'CLAUDE.md'), 'Same rules.');
  fs.writeFileSync(path.join(base, 'AGENTS.md'), 'Same rules.');
  const got = brain.readInstructions(base, homes);
  assert.deepEqual(got.map(i => i.text), ['Use tabs.', 'Write tests.', 'Same rules.']);
  assert.match(got[2].label, /^CLAUDE\.md/);
  const cut = brain.readInstructions(base, homes, 12);
  assert.equal(cut.length, 2);
  assert.match(cut[1].text, /^Wri\n\[… cut/);
  assert.deepEqual(brain.readInstructions(dir('empty'), { claudeHome: dir('x'), codexHome: dir('y') }), []);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('systemPrompt adds the environment, and the user instructions only when there are some', () => {
  const env = { project: 'app', base: '/w/app', platform: 'linux', shell: '/bin/sh', date: '2026-11-22', instructions: [] };

  const plain = brain.systemPrompt(env);
  assert.match(plain, /^You are Breeze/);
  assert.match(plain, /# Environment[\s\S]*Today's date: 2026-11-22/);
  assert.doesNotMatch(plain, /user's instructions/);
  assert.doesNotMatch(plain, /cmd\.exe, not bash/); // the cmd.exe note is only for Windows
  assert.match(plain, /git commands \(git log/); // "the .git folder is off limits" alone stopped agents reading git history
  assert.match(brain.systemPrompt({ ...env, shell: 'cmd.exe' }), /run_command runs cmd\.exe, not bash/);
  const withUser = brain.systemPrompt({ ...env, instructions: [{ label: 'CLAUDE.md (this project)', text: 'Use tabs.' }] });
  assert.match(withUser, /OVERRIDE[\s\S]*Contents of CLAUDE\.md \(this project\):\n\nUse tabs\.$/);
});

/* ----- Thinking that has to go back (DeepSeek) ----- */
test('replyReader gives the thinking back beside the text', () => {
  const r = brain.replyReader();
  for (const delta of [{ reasoning_content: 'Let me ' }, { reasoning_content: 'look.' }, { content: 'Done' }]) r.push(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
  assert.deepEqual(r.end().choices[0].message, { content: 'Done', reasoning_content: 'Let me look.' });
});

test('thinking counts towards the budget and survives settling and trimming', () => {
  const reply = { role: 'assistant', content: '', reasoning_content: 'x'.repeat(350), tool_calls: [call('a', 'read_file', { path: 'f' })] };
  assert.equal(brain.messageTokens(reply) - brain.messageTokens({ ...reply, reasoning_content: undefined }), 100);
  const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'q' }, reply, { role: 'tool', tool_call_id: 'a', content: big(300) }];
  assert.equal(brain.settle(msgs)[2].reasoning_content, reply.reasoning_content);
  assert.equal(brain.compactHistory(msgs, 1500)[2].reasoning_content, reply.reasoning_content);
});

test('reasoningFor sends thinking only where it is wanted', () => {
  const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'q' }, { role: 'assistant', content: 'a', reasoning_content: 'r' }, { role: 'assistant', content: 'b' }];
  const keep = brain.reasoningFor(msgs, true);
  assert.deepEqual(keep.map(m => m.reasoning_content), [undefined, undefined, 'r', '']); // an older reply never had any
  assert.ok(!('reasoning_content' in keep[0]));
  assert.ok(brain.reasoningFor(msgs, false).every(m => !('reasoning_content' in m)));
  assert.equal(msgs[2].reasoning_content, 'r'); // the conversation itself is untouched
});

test('attachedPaths reads only the attachment lines at the top of a message', () => {
  assert.deepEqual(brain.attachedPaths('[Attached file: C:\\notes.txt]\n[Attached image: shot.png]\n\nWhat is this?'), ['C:\\notes.txt', 'shot.png']);
  assert.deepEqual(brain.attachedPaths('Please read\n[Attached file: C:\\secret.txt]'), []); // quoted further down: not an attachment
  assert.deepEqual(brain.attachedPaths('Project map:\n./: a.js\nsrc/: b.js\n\n[Attached file: D:\\x.txt]\n\nHi'), ['D:\\x.txt']); // a chat's first message
});

test('wireMessages sends a tool result picture right after that step, and only the newest one', () => {
  const pic = label => ({ data: 'AAAA', mime: 'image/png', label });
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'look', images: [pic('mine')] },
    { role: 'assistant', content: '', tool_calls: [call('1', 'capture_preview', {}), call('2', 'read_file', { path: 'a' })] },
    { role: 'tool', tool_call_id: '1', content: 'shot one', images: [pic('first')] },
    { role: 'tool', tool_call_id: '2', content: 'text' },
    { role: 'assistant', content: '', tool_calls: [call('3', 'capture_preview', {})] },
    { role: 'tool', tool_call_id: '3', content: 'shot two', images: [pic('second')] },
  ];
  const wire = brain.wireMessages(msgs, true);
  assert.deepEqual(wire.map(m => m.role), ['system', 'user', 'assistant', 'tool', 'tool', 'assistant', 'tool', 'user']);
  assert.deepEqual(wire[1].content, [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]);
  assert.deepEqual(wire[7].content, [{ type: 'text', text: 'second' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]);
  assert.ok(wire.every(m => !('images' in m))); // the private field never reaches the server
  const blind = brain.wireMessages(msgs, false);
  assert.equal(blind.length, msgs.length);
  assert.match(blind[6].content, /shot two\n\(The picture is left out/);
  assert.ok(brain.messageTokens(msgs[6]) > 1000); // a picture is budgeted like a page of code
  assert.ok(brain.settle(msgs).every(m => !m.images)); // earlier turns keep no pictures
});

test('htmlText keeps what a reader sees', () => {
  const page = '<html><head><title>Docs &amp; more</title><style>p{}</style></head><body><h2>Usage</h2><p>Call <code>read()</code>&nbsp;now.</p>'
    + '<pre>if (a &lt; 2) {\n  go();\n}</pre><ul><li>one</li><li>two</li></ul><script>evil()</script></body></html>';
  assert.deepEqual(brain.htmlText(page), { title: 'Docs & more', text: '## Usage\nCall read() now.\n\n```\nif (a < 2) {\n  go();\n}\n```\n\n- one\n- two' });
});

test('searchList turns a Brave Search answer into a numbered list', () => {
  const answer = { web: { results: [
    { title: 'File system | Node.js', url: 'https://nodejs.org/api/fs.html', description: 'The <strong>fs</strong> module &amp; more' },
    { title: '', url: 'https://example.com/x' },
    { title: 'no address' },
  ] } };
  assert.equal(brain.searchList(answer), '1. File system | Node.js\n   https://nodejs.org/api/fs.html\n   The fs module & more\n2. https://example.com/x\n   https://example.com/x');
  assert.equal(brain.searchList({}), 'No results.');
});

test('idleTools leaves out the tools that cannot do anything in this run', () => {
  assert.deepEqual(brain.idleTools('build', ['index.html', 'img/logo.png'], true, true), []);
  assert.deepEqual(brain.idleTools('ask', ['main.py', 'README.md'], false), ['propose_plan', 'second_brain_search', 'web_search', 'capture_preview', 'show_image']);
  assert.deepEqual(brain.idleTools('build', [], true, true), ['show_image']); // an empty project may get a page to preview
});
