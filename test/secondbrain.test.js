const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sb = require('../src/main/secondbrain');
const { BrainStore, extractMemories, filesIn, buildLinks, claudeCompactSummary, codexCompactions, droppedReplies, summaryChunks, summarizePrompt, formatSearch, BRAIN_TOOL_DEFS, MAX_NODES } = sb;

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-brain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'second-brain.json');
}

const CLAUDE_SUMMARY = `This session is being continued from a previous conversation that ran out of context.

Summary:
1. Primary Request and Intent:
   The user wants a dark theme toggle in the settings page.

2. Key Technical Concepts:
   - Theme tokens live in CSS custom properties
   - Electron main process stores state in breeze-state.json

3. Files and Code Sections:
   - src/renderer/settings.ts
      - Added the toggle row
      \`\`\`ts
      const on = { a: 1 };
      function x() { return 2; }
      \`\`\`
   - src/main/main.ts

4. Errors and fixes:
   - The toggle flickered on start: fixed by reading the theme before first paint

6. All user messages:
   - please make it dark
   - thanks

7. Pending Tasks:
   - Add a test for the theme toggle

8. Current Work:
   Wiring the toggle into src/renderer/settings.ts`;

test('a Claude summary becomes typed memories, without code or user messages', () => {
  const m = extractMemories(CLAUDE_SUMMARY);
  const kinds = k => m.filter(x => x.kind === k).map(x => x.text);
  assert.ok(kinds('fact').some(t => /CSS custom properties/.test(t)));
  assert.ok(kinds('decision').some(t => /flickered/.test(t)));
  assert.ok(kinds('task').some(t => /test for the theme toggle/.test(t)));
  assert.deepEqual(kinds('file').sort(), ['breeze-state.json', 'src/main/main.ts', 'src/renderer/settings.ts']);
  assert.ok(kinds('fact').some(t => t === 'src/renderer/settings.ts: Added the toggle row'), 'notes under a file name it');
  assert.ok(!m.some(x => /please make it dark|thanks/.test(x.text)), 'user messages are skipped');
  assert.ok(!m.some(x => /return 2|const on/.test(x.text)), 'fenced code is skipped');
  assert.ok(!m.some(x => /being continued/.test(x.text)), 'the preamble is skipped');
});

test('a plain summary is typed by its words', () => {
  const m = extractMemories('- We decided to use pnpm instead of npm\n- Next: add a lint step\n- The app uses Electron 33');
  assert.deepEqual(m.map(x => x.kind), ['decision', 'task', 'fact']);
});

test('secrets are never kept', () => {
  const m = extractMemories('- api_key = sk-abcdefghijklmnopqrstuvwxyz123456\n- The build runs tsc first');
  assert.equal(m.length, 1);
  assert.match(m[0].text, /tsc/);
});

test('files are found in text', () => {
  assert.deepEqual(filesIn('Edited src/main/a.ts and package.json, see https://x.com/a.html, v1.2 and e.g. stuff').sort(), ['package.json', 'src/main/a.ts']);
});

test('the same summary twice bumps hits instead of doubling', t => {
  const s = new BrainStore(tmpFile(t), 'linux');
  s.addSummary('/code/a', CLAUDE_SUMMARY, 'claude', 1000);
  const n = s.graph('/code/a').nodes.length;
  s.addSummary('/code/a', CLAUDE_SUMMARY, 'claude', 2000);
  const g = s.graph('/code/a');
  assert.equal(g.nodes.length, n);
  assert.ok(g.nodes.every(x => x.hits === 2));
});

test('memory survives a restart and a corrupt file starts empty', t => {
  const file = tmpFile(t);
  new BrainStore(file, 'linux').addFacts('/code/a', ['The app uses Electron'], 'local', 1);
  assert.equal(new BrainStore(file, 'linux').graph('/code/a').nodes.length, 1);
  fs.writeFileSync(file, '{nope');
  assert.equal(new BrainStore(file, 'linux').graph('/code/a').nodes.length, 0);
});

test('each folder has its own brain; Windows folders ignore case', t => {
  const s = new BrainStore(tmpFile(t), 'win32');
  s.addFacts('C:\\Code\\A', ['Fact one about the parser'], 'claude', 1);
  s.addFacts('c:\\code\\a', ['Fact two about the lexer'], 'codex', 2);
  s.addFacts('C:\\Code\\B', ['Fact three'], 'claude', 3);
  assert.equal(s.graph('C:\\CODE\\A').nodes.length, 2);
  assert.equal(s.graph('C:\\Code\\B').nodes.length, 1);
});

test('the cap drops the least-hit oldest memories', t => {
  const s = new BrainStore(null, 'linux');
  s.addFacts('/a', ['the very first memory'], 'x', 0);
  s.addFacts('/a', ['the very first memory'], 'x', 1); // hits 2: survives
  s.addFacts('/a', ['the second memory'], 'x', 2); // hits 1, oldest: dropped first
  const many = Array.from({ length: MAX_NODES - 1 }, (_, i) => `memory number ${i}`);
  s.addFacts('/a', many, 'x', 10);
  const texts = s.graph('/a').nodes.map(n => n.text);
  assert.equal(texts.length, MAX_NODES);
  assert.ok(texts.includes('the very first memory'));
  assert.ok(!texts.includes('the second memory'));
});

test('links join memories that share a file or uncommon words, at most 6 each', () => {
  const node = (id, kind, text) => ({ id, kind, text, at: 0, agent: 'x', hits: 1 });
  const nodes = [
    node('f', 'file', 'src/a.ts'),
    node('1', 'fact', 'The parser lives in src/a.ts'),
    node('2', 'decision', 'Moved tokenizing into src/a.ts'),
    node('3', 'fact', 'Webpack bundles renderer assets quickly'),
    node('4', 'fact', 'Webpack bundles renderer assets slowly'),
    node('5', 'task', 'Buy milk'),
  ];
  const links = buildLinks(nodes);
  const has = (a, b) => links.some(l => (l.a === a && l.b === b) || (l.a === b && l.b === a));
  assert.ok(has('f', '1') && has('f', '2') && has('1', '2'));
  assert.ok(has('3', '4'));
  assert.ok(!links.some(l => l.a === '5' || l.b === '5'));
  const hub = [node('h', 'file', 'x.ts'), ...Array.from({ length: 12 }, (_, i) => node(`m${i}`, 'fact', `item ${i} in x.ts`))];
  const hubLinks = buildLinks(hub);
  assert.equal(hubLinks.filter(l => l.a === 'h' || l.b === 'h').length, 12, 'every memory naming the file joins its hub');
  assert.ok(hubLinks.length < (13 * 12) / 2, 'not everything is linked to everything');
});

test('a Claude session log gives its newest compact summary', () => {
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'old summary' } }),
    JSON.stringify({ type: 'user', isCompactSummary: true, message: { role: 'user', content: [{ type: 'text', text: 'new summary' }] } }),
    'not json',
  ];
  assert.equal(claudeCompactSummary(lines), 'new summary');
  assert.equal(claudeCompactSummary([]), null);
});

test('a Codex rollout gives its compactions', () => {
  const lines = [
    JSON.stringify({ type: 'compacted', payload: { message: 'first' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }),
    JSON.stringify({ type: 'compacted', payload: { message: 'second' } }),
  ];
  assert.deepEqual(codexCompactions(lines), ['first', 'second']);
});

test('dropped assistant replies are found', () => {
  const before = [{ role: 'system', content: 's' }, { role: 'user', content: 'q1' }, { role: 'assistant', content: 'The config lives in tsconfig.json' }, { role: 'user', content: 'q2' }, { role: 'assistant', content: 'kept' }];
  const after = [before[0], before[3], before[4]];
  assert.deepEqual(droppedReplies(before, after), ['The config lives in tsconfig.json']);
  assert.deepEqual(droppedReplies(before, before), []);
});

test('a summary is only taken once', t => {
  const s = new BrainStore(tmpFile(t), 'linux');
  assert.equal(s.seen('abc'), false);
  assert.equal(s.seen('abc'), true);
});

test('agents search the second brain and get linked memories with each hit', () => {
  const s = new BrainStore(null, 'linux');
  s.addSummary('/a', 'Facts:\n- The router lives in src/router.ts\n- Login redirects loop when the token is stale\nDecisions:\n- Chose cookies over localStorage for the session token\nPending Tasks:\n- Write tests for src/router.ts', 'claude', 1);
  s.addFacts('/b', ['The router in the other project is different'], 'x', 1);
  const r = s.search('/a', 'session token cookies', 5);
  assert.ok(r.length >= 1);
  assert.match(r[0].node.text, /cookies/);
  const byFile = s.search('/a', 'src/router.ts');
  assert.ok(byFile.some(h => h.node.kind === 'file'));
  const top = s.search('/a', 'src/router.ts', 1);
  assert.equal(top.length, 1);
  assert.ok(top[0].linked.length > 0, 'a hit brings the memories linked to it');
  assert.ok(!s.search('/a', 'other project different').some(h => /other project/.test(h.node.text)), 'never another folder');
  assert.deepEqual(s.search('/a', 'zebra'), []);
  const text = formatSearch(r);
  assert.match(text, /^\[[0-9a-f]{12}\] \(decision\) /m);
  assert.match(formatSearch([]), /Nothing in the second brain/);
});

test('agents remember a memory and link it to related ones', t => {
  const file = tmpFile(t);
  const s = new BrainStore(file, 'linux');
  s.addFacts('/a', ['Payments go through Stripe'], 'x', 1);
  const pay = s.graph('/a').nodes[0];
  const m = s.remember('/a', 'Refunds are issued from the admin page', 'decision', [pay.id, 'nope'], 'codex', 2);
  assert.equal(m.kind, 'decision');
  assert.equal(m.agent, 'codex');
  const g = new BrainStore(file, 'linux').graph('/a');
  assert.ok(g.links.some(l => [l.a, l.b].sort().join() === [pay.id, m.id].sort().join()), 'the link is kept across restarts');
  assert.throws(() => s.remember('/a', 'password = hunter22', 'fact', [], 'x'), /secret/);
  assert.ok(s.remove('/a', pay.id));
  assert.ok(!s.graph('/a').links.some(l => l.a === pay.id || l.b === pay.id), 'forgetting drops its links');
});

test('deleting a chat forgets what only it said', t => {
  const file = tmpFile(t);
  const s = new BrainStore(file, 'linux');
  s.addSummary('/a', 'Facts:\n- The router lives in src/router.ts\n- Login uses cookies for the token', 'claude', 1, ['A']);
  s.addSummary('/a', 'Facts:\n- Login uses cookies for the token', 'claude', 2, ['B']); // said by A and B
  s.addFacts('/a', ['The build runs with tsc only'], 'you', 3, ['A']);
  s.addFacts('/a', ['The build runs with tsc only'], 'claude', 4); // also said outside any chat: kept for good
  s.markRead('/a', { A: 50, B: 20 });
  const kept = s.remember('/a', 'Releases ship from GitHub', 'fact', [], 'codex', 5, ['A']);
  assert.deepEqual(s.forgetChats(['A']), ['/a']);
  const texts = new BrainStore(file, 'linux').graph('/a').nodes.map(n => n.text).sort();
  assert.deepEqual(texts, ['Login uses cookies for the token', 'The build runs with tsc only'], 'the router fact, its file and the remembered fact went');
  assert.ok(!texts.includes(kept.text));
  assert.equal(s.newText('/a', [{ key: 'A', title: 'A', text: 'x'.repeat(10) }])[0].from, 0, 'A would be read from the start again');
  // A summary of a deleted chat that lands afterwards is dropped.
  assert.equal(s.addSummary('/a', 'Facts:\n- Late news from chat A arrives', 'claude', 6, ['A']), 0);
  assert.throws(() => s.remember('/a', 'Late memory from chat A', 'fact', [], 'x', 6, ['A']), /deleted/);
  assert.deepEqual(s.forgetChats(['B']), ['/a']);
  assert.deepEqual(s.graph('/a').nodes.map(n => n.text), ['The build runs with tsc only']);
});

test('the tools agents get are defined once', () => {
  assert.deepEqual(BRAIN_TOOL_DEFS.map(t => t.name), ['second_brain_search', 'second_brain_remember']);
  for (const t of BRAIN_TOOL_DEFS) assert.equal(t.schema.type, 'object');
});

test('the second brain view has search, labels, a detail panel with Focus, and a list', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/breeze/brain.ts'), 'utf8');
  // Search dims and highlights instead of hiding, and Enter opens the best match.
  for (const s of ['function brainSearch(', 'function brainOpenBest(', "e.key === 'Enter'"]) assert.ok(ui.includes(s), s);
  // Names never overlap: each label checks the boxes already placed.
  assert.match(ui, /placed\.some\(p => box\[0\] < p\[2\]/);
  // A click opens the panel with linked memories; Focus shows one neighbourhood; List shows everything as text.
  for (const s of ['function brainSelect(', 'Linked memories', "data-act=\"focus\"", 'function brainList(', 'data-mode="list"']) assert.ok(ui.includes(s), s);
  // Keys: / searches, F fits, + and - zoom; reduced motion skips the camera move.
  for (const s of ["e.key === '/'", "e.key === 'f'", "e.key === '+'", 'if (brainStill()) { brain.view = to;']) assert.ok(ui.includes(s), s);
});

test('main, preload and the board are wired', () => {
  const src = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const main = src('src/main/main.ts');
  for (const s of ['compact_boundary', "'brain:graph'", 'droppedReplies(messages', 'codexCompactions(']) assert.ok(main.includes(s), s);
  assert.ok(src('src/main/preload.ts').includes('brain:graph'));
  assert.ok(src('src/renderer/breeze/board.ts').includes('openSecondBrain(folder)'));
  assert.ok(src('src/renderer/breeze.html').includes('breeze/brain.js'));
  for (const s of ["brainPrompt(opts?.taskBase", "'brain:summarizePlan'", "'brain:summarize'", 'markRead(folder, chunks[i].upTo)']) assert.ok(main.includes(s), s);
  assert.ok(src('src/renderer/breeze/brain.ts').includes('brainConfirm(plan)'), 'Summarize asks before it spends tokens');
  // Agents reach the second brain: every MCP run, and the local loop's own tools.
  for (const s of ['extra: runId => [...BRAIN_MCP_TOOLS', '...BRAIN_TOOL_DEFS.map(t => ({ name: t.name, description: t.description, parameters: t.schema }))', 'second_brain_search: (ctx, a)', 'second_brain_remember: (ctx, a)']) assert.ok(main.includes(s), s);
});

test('a prompt becomes memories without a model', t => {
  const s = new BrainStore(null, 'linux');
  s.addFacts('/a', ['We decided the API stays REST, not GraphQL. Also check src/api.ts'], 'you', 1);
  const g = s.graph('/a');
  assert.ok(g.nodes.some(n => n.kind === 'decision' && n.agent === 'you'));
  assert.ok(g.nodes.some(n => n.kind === 'file' && n.text === 'src/api.ts'));
});

test('summarize only sends chat text not read before', () => {
  const s = new BrainStore(null, 'linux');
  const chats = [{ key: 'c1', title: 'One', text: 'hello there' }, { key: 'c2', title: 'Two', text: 'abc' }];
  assert.deepEqual(s.newText('/a', chats).map(c => c.text), ['hello there', 'abc']);
  s.markRead('/a', { c1: 11 });
  assert.deepEqual(s.newText('/a', chats).map(c => c.key), ['c2']);
  const grown = [{ key: 'c1', title: 'One', text: 'hello there and more' }];
  assert.deepEqual(s.newText('/a', grown).map(c => c.text), [' and more']);
  assert.deepEqual(s.newText('/b', chats).length, 2, 'per folder');
});

test('chats are cut into chunks that say how far each chat got', () => {
  const chats = [{ key: 'a', title: 'A', text: 'x'.repeat(250) }, { key: 'b', title: 'B', text: 'y'.repeat(50) }];
  const chunks = summaryChunks(chats, 200);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every(c => c.text.length <= 200 + 40));
  const last = Object.assign({}, ...chunks.map(c => c.upTo));
  assert.deepEqual(last, { a: 250, b: 50 });
  assert.match(summarizePrompt('CHATS'), /Decisions:[\s\S]*Pending Tasks:[\s\S]*CHATS/);
});

test('a summarize reply parses into typed memories', () => {
  const m = extractMemories('Facts:\n- The app is an Electron IDE\nDecisions:\n- Chose plain tsc over a bundler\nPending Tasks:\n- Add the summarize button\nFiles:\n- src/main/main.ts: the main process');
  assert.deepEqual([...new Set(m.map(x => x.kind))].sort(), ['decision', 'fact', 'file', 'task']);
});
