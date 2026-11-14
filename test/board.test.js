const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BoardCoordinator, boardBrief, lineDiff } = require('../src/main/board');

function tempProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-board-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const put = (root, rel, data) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), data);
};
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// Runs get ids 1, 2, …; timers wait until the test fires them.
function fakeDeps() {
  let next = 1;
  const d = { runs: [], stopped: [], events: [], timers: [] };
  d.startRun = opts => { const id = next++; d.runs.push({ id, opts }); return id; };
  d.stopRun = id => d.stopped.push(id);
  d.emit = (runId, ev) => d.events.push({ runId, ev });
  d.setTimeout = (fn, ms) => { const h = { fn, ms }; d.timers.push(h); return h; };
  d.clearTimeout = h => { d.timers = d.timers.filter(x => x !== h); };
  d.fire = ms => {
    const due = d.timers.filter(h => h.ms === ms);
    d.timers = d.timers.filter(h => !due.includes(h));
    due.forEach(h => h.fn());
  };
  d.of = type => d.events.filter(e => e.ev.t === type);
  d.clock = 1000;
  d.now = () => d.clock;
  return d;
}
function newBoard(t) {
  const root = tempProject(t);
  const deps = fakeDeps();
  return { root, deps, co: new BoardCoordinator({ id: 'board-1', root, deps }) };
}

/* ----- Task 1: ownership and box runs ----- */
test('startBox starts a build run keyed by the box', t => {
  const { deps, co } = newBoard(t);
  const id = co.startBox('box1', { agent: 'claude', name: 'Claude · 1', prompt: 'make UI' });
  assert.equal(id, 1);
  const { opts } = deps.runs[0];
  assert.equal(opts.agent, 'claude');
  assert.equal(opts.mode, 'build');
  assert.equal(opts.team.agentId, 'box1');
  assert.equal(opts.team.coordinator, co);
  assert.deepEqual(co.members, [{ agentId: 'box1', agent: 'claude', name: 'Claude · 1' }]);
  assert.ok(co.hasRun(1));
});

test('same agent in two boxes is two owners', async t => {
  const { co } = newBoard(t);
  co.startBox('box1', { agent: 'claude', name: 'Claude · 1', prompt: 'a' });
  co.startBox('box2', { agent: 'claude', name: 'Claude · 2', prompt: 'b' });
  assert.equal(await co.foreignOwner('box1', 'a.js'), null);
  assert.equal(await co.foreignOwner('box2', 'a.js'), 'box1');
  assert.equal(co.owners['a.js'], 'box1');
});

test('startBox on a running box throws', t => {
  const { co } = newBoard(t);
  co.startBox('box1', { agent: 'claude', name: 'Claude · 1', prompt: 'a' });
  assert.throws(() => co.startBox('box1', { agent: 'claude', name: 'Claude · 1', prompt: 'b' }), /still working/);
  co.observe(1, { t: 'done', ok: true });
  assert.doesNotThrow(() => co.startBox('box1', { agent: 'claude', name: 'Claude · 1', prompt: 'b' }));
});

test('boardBrief lists teammates and what not to edit', () => {
  const me = { agentId: 'box1', agent: 'claude', name: 'Claude · 1' };
  const other = { agentId: 'box2', agent: 'codex', name: 'Codex · 2' };
  const brief = boardBrief(me, 'make UI', { members: [me, other], owners: { 'web/': 'box2', 'ui.ts': 'box1' } });
  assert.match(brief, /make UI/);
  assert.match(brief, /Codex · 2/);
  assert.match(brief, /Do not edit: web\//);
  assert.ok(!/Do not edit:.*ui\.ts/.test(brief), 'own files are not off limits');
  assert.match(brief, /For Codex · 2:/);
});

test('boardBrief with no teammates has no do-not-edit line', () => {
  const me = { agentId: 'box1', agent: 'claude', name: 'Claude · 1' };
  const brief = boardBrief(me, 'make UI', { members: [me], owners: {} });
  assert.ok(!brief.includes('Do not edit'));
});

test('lineDiff trims the common start and end', () => {
  assert.equal(lineDiff('a\nb\nc', 'a\nX\nc'), '@@ line 2\n-b\n+X');
  const before = Array.from({ length: 250 }, (_, i) => `old${i}`).join('\n');
  const after = Array.from({ length: 250 }, (_, i) => `new${i}`).join('\n');
  const out = lineDiff(before, after).split('\n');
  assert.equal(out.length, 202); // header + 200 lines + the "more" line
  assert.equal(out[201], '… 300 more lines');
});

test('release frees a file', async t => {
  const { co } = newBoard(t);
  co.startBox('box1', { agent: 'claude', name: 'Claude · 1', prompt: 'a' });
  co.startBox('box2', { agent: 'codex', name: 'Codex · 2', prompt: 'b' });
  await co.foreignOwner('box1', 'a.js');
  co.release('a.js');
  assert.equal(await co.foreignOwner('box2', 'a.js'), null);
  assert.equal(co.owners['a.js'], 'box2');
});

test('stopAll stops every running box', t => {
  const { deps, co } = newBoard(t);
  co.startBox('box1', { agent: 'claude', name: 'Claude · 1', prompt: 'a' });
  co.startBox('box2', { agent: 'codex', name: 'Codex · 2', prompt: 'b' });
  co.stopAll();
  assert.deepEqual(deps.stopped, [1, 2]);
});

test('stopBox stops only that box', t => {
  const { deps, co } = newBoard(t);
  co.startBox('box1', { agent: 'claude', name: 'Claude · 1', prompt: 'a' });
  co.startBox('box2', { agent: 'codex', name: 'Codex · 2', prompt: 'b' });
  co.stopBox('box2');
  assert.deepEqual(deps.stopped, [2]);
});

/* ----- Task 2: crossings and relays ----- */
async function twoBoxes(t) {
  const b = newBoard(t);
  b.id1 = b.co.startBox('box1', { agent: 'claude', name: 'Claude · 1', prompt: 'UI' });
  b.id2 = b.co.startBox('box2', { agent: 'codex', name: 'Codex · 2', prompt: 'API' });
  return b;
}

test("crossing restores the owner's latest version", async t => {
  const { root, deps, co, id1, id2 } = await twoBoxes(t);
  put(root, 'api.ts', 'v1');
  co.observe(id2, { t: 'file', path: path.join(root, 'api.ts') });
  await co.settled();
  put(root, 'api.ts', 'v2');
  co.observe(id2, { t: 'file', path: 'api.ts' });
  await co.settled();
  put(root, 'api.ts', 'hack');
  co.observe(id1, { t: 'file', path: 'api.ts' }); // Claude asks to write…
  co.observe(id1, { t: 'written', path: 'api.ts' }); // …and the write landed
  await co.settled();
  assert.equal(read(root, 'api.ts'), 'v2');
  const crossing = deps.of('crossing');
  assert.equal(crossing.length, 1);
  assert.equal(crossing[0].runId, id1);
  assert.deepEqual({ ...crossing[0].ev }, { t: 'crossing', path: 'api.ts', agent: 'box1', owner: 'box2' });
  const relay = deps.of('relay');
  assert.equal(relay.length, 1);
  assert.equal(relay[0].runId, id1);
  assert.equal(relay[0].ev.from, 'box1');
  assert.equal(relay[0].ev.to, 'box2');
  assert.equal(relay[0].ev.path, 'api.ts');
  assert.match(relay[0].ev.diff, /-v2/);
  assert.match(relay[0].ev.diff, /\+hack/);
  // a late write is put back again on the recheck
  put(root, 'api.ts', 'late');
  deps.fire(300);
  await co.settled();
  assert.equal(read(root, 'api.ts'), 'v2');
});

test('a For note on done relays', async t => {
  const { deps, co, id1 } = await twoBoxes(t);
  co.observe(id1, { t: 'text', text: 'Built the UI.\n\nFor Codex · 2:\nexport getUser' });
  co.observe(id1, { t: 'done', ok: true });
  await co.settled();
  const relay = deps.of('relay');
  assert.equal(relay.length, 1);
  assert.equal(relay[0].runId, id1);
  assert.deepEqual({ ...relay[0].ev }, { t: 'relay', from: 'box1', to: 'box2', note: 'export getUser' });
});

test('observe never hides board events', async t => {
  const { co, id1 } = await twoBoxes(t);
  for (const ev of [{ t: 'text', text: 'x' }, { t: 'file', path: 'a.js' }, { t: 'tool', label: 'Read' }, { t: 'done', ok: true }]) {
    assert.equal(co.observe(id1, ev), false);
  }
  await co.settled();
});

test('a blocked write relays a note and restores nothing', async t => {
  const { root, deps, co, id1 } = await twoBoxes(t);
  put(root, 'api.ts', 'mine');
  assert.equal(await co.foreignOwner('box2', 'api.ts'), null);
  assert.equal(await co.foreignOwner('box1', 'api.ts'), 'box2');
  assert.equal(deps.of('relay').length, 0, 'asking about an owner relays nothing');
  co.blocked('box1', 'box2', 'api.ts');
  const relay = deps.of('relay');
  assert.equal(relay.length, 1);
  assert.equal(relay[0].runId, id1);
  assert.deepEqual({ ...relay[0].ev }, { t: 'relay', from: 'box1', to: 'box2', path: 'api.ts', note: 'Tried to edit api.ts' });
  assert.equal(deps.of('crossing').length, 0);
  assert.equal(read(root, 'api.ts'), 'mine');
});

test('close stops every box and refuses new runs', async t => {
  const { deps, co } = await twoBoxes(t);
  co.close();
  assert.deepEqual(deps.stopped, [1, 2]);
  assert.throws(() => co.startBox('box3', { agent: 'claude', name: 'Claude · 3', prompt: 'x' }), /closed/);
});

/* ----- Review fixes ----- */
// Claude reports `file` when it asks to write (before the write) and `written` once the write landed.
async function claudeAndCodex(t) {
  const b = newBoard(t);
  b.id1 = b.co.startBox('box1', { agent: 'claude', name: 'Claude · 1', prompt: 'UI' });
  b.id2 = b.co.startBox('box2', { agent: 'codex', name: 'Codex · 2', prompt: 'API' });
  return b;
}

test("a Claude owner's file is kept as written, not as it was before the write", async t => {
  const { root, co, id1, id2 } = await claudeAndCodex(t);
  co.observe(id1, { t: 'file', path: 'a.ts', created: true }); // before the write: a.ts does not exist yet
  await co.settled();
  put(root, 'a.ts', 'mine');
  co.observe(id1, { t: 'written', path: 'a.ts' });
  await co.settled();
  put(root, 'a.ts', 'hack');
  co.observe(id2, { t: 'file', path: 'a.ts' });
  await co.settled();
  assert.equal(read(root, 'a.ts'), 'mine');
});

test('a Claude asker is put back once its write lands, with the diff of what it wrote', async t => {
  const { root, deps, co, id1, id2 } = await claudeAndCodex(t);
  put(root, 'api.ts', 'v1');
  co.observe(id2, { t: 'file', path: 'api.ts' });
  await co.settled();
  co.observe(id1, { t: 'file', path: 'api.ts' }); // asks to write: nothing landed yet
  await co.settled();
  assert.equal(deps.of('crossing').length, 0);
  put(root, 'api.ts', 'hack');
  co.observe(id1, { t: 'written', path: 'api.ts' });
  await co.settled();
  assert.equal(read(root, 'api.ts'), 'v1');
  assert.match(deps.of('relay')[0].ev.diff, /\+hack/);
});

test("a write Claude's deny list refused on a teammate's file is a blocked crossing and a relay", async t => {
  const { root, deps, co, id1, id2 } = await claudeAndCodex(t);
  put(root, 'api.ts', 'v1');
  co.observe(id2, { t: 'file', path: 'api.ts' });
  await co.settled();
  co.observe(id1, { t: 'refused', path: 'api.ts' });
  await co.settled();
  assert.deepEqual({ ...deps.of('crossing')[0].ev }, { t: 'crossing', path: 'api.ts', agent: 'box1', owner: 'box2', blocked: true });
  assert.equal(deps.of('relay').length, 1);
  co.observe(id1, { t: 'refused', path: 'own.ts' }); // its own or a free file: not a crossing
  await co.settled();
  assert.equal(deps.of('crossing').length, 1);
});

test('a stopped or failed run relays nothing on done', async t => {
  const { deps, co, id1, id2 } = await twoBoxes(t);
  co.observe(id1, { t: 'text', text: 'For Codex · 2:\nplease' });
  co.stopBox('box1');
  co.observe(id1, { t: 'done', ok: false, stopped: true });
  co.observe(id2, { t: 'text', text: 'For Claude · 1:\nplease' });
  co.observe(id2, { t: 'done', ok: false });
  await co.settled();
  assert.equal(deps.of('relay').length, 0);
});

test('a crossing still being handled when Stop all comes puts the file back but relays nothing', async t => {
  const { root, deps, co, id1, id2 } = await twoBoxes(t);
  put(root, 'api.ts', 'v1');
  co.observe(id2, { t: 'file', path: 'api.ts' });
  await co.settled();
  put(root, 'api.ts', 'hack');
  co.observe(id1, { t: 'written', path: 'api.ts' });
  co.stopAll();
  await co.settled();
  assert.equal(read(root, 'api.ts'), 'v1');
  assert.equal(deps.of('relay').length, 0);
});

test('the same crossing from one run relays once', async t => {
  const { root, deps, co, id1, id2 } = await twoBoxes(t);
  put(root, 'api.ts', 'v1');
  co.observe(id2, { t: 'file', path: 'api.ts' });
  await co.settled();
  for (const v of ['h1', 'h2']) {
    put(root, 'api.ts', v);
    co.observe(id1, { t: 'written', path: 'api.ts' });
    await co.settled();
  }
  co.blocked('box1', 'box2', 'api.ts');
  assert.equal(deps.of('relay').length, 1);
  assert.equal(deps.of('crossing').length, 2, 'each attempt is still put back and shown');
});

test('clearBox forgets an emptied box and frees its files', async t => {
  const { co, id2 } = await twoBoxes(t);
  await co.foreignOwner('box2', 'api.ts');
  co.observe(id2, { t: 'done', ok: true });
  co.clearBox('box2');
  assert.deepEqual(co.members.map(m => m.agentId), ['box1']);
  assert.equal(co.owners['api.ts'], undefined);
  assert.equal(await co.foreignOwner('box1', 'api.ts'), null);
});

/* ----- Shell writes: a box that writes a file with a command, not its edit tool ----- */
const shell = (co, runId, id, command) => co.observe(runId, { t: 'shell', id, command });
const shellEnd = (co, runId, id) => co.observe(runId, { t: 'shell', id, end: true });

test("a file a shell command names and changes becomes that box's", async t => {
  const { root, deps, co, id1 } = await twoBoxes(t);
  shell(co, id1, 's1', 'echo "// hi" >> util.ts');
  put(root, 'util.ts', '// hi\n');
  co.diskChanged('util.ts');
  await co.settled();
  assert.deepEqual({ ...co.owners }, { 'util.ts': 'box1' });
  assert.equal(deps.of('crossing').length, 0);
});

test("a shell write to a teammate's file is put back and relayed", async t => {
  const { root, deps, co, id1, id2 } = await twoBoxes(t);
  put(root, 'util.ts', 'mine\n');
  co.observe(id2, { t: 'file', path: 'util.ts', written: true });
  await co.settled();
  shell(co, id1, 's1', "sed -i 's/mine/hack/' src/../util.ts");
  put(root, 'util.ts', 'hack\n');
  co.diskChanged('util.ts');
  shellEnd(co, id1, 's1');
  await co.settled();
  assert.equal(read(root, 'util.ts'), 'mine\n');
  assert.equal(deps.of('crossing').length, 1);
  assert.equal(deps.of('crossing')[0].runId, id1);
  const relay = deps.of('relay');
  assert.equal(relay.length, 1);
  assert.equal(relay[0].ev.to, 'box2');
  assert.match(relay[0].ev.diff, /\+hack/);
});

test('Breeze putting a file back is not blamed on a shell that names it', async t => {
  const { root, deps, co, id1, id2 } = await twoBoxes(t);
  put(root, 'util.ts', 'mine\n');
  co.observe(id2, { t: 'file', path: 'util.ts', written: true });
  await co.settled();
  shell(co, id1, 's1', 'cat util.ts');
  co.diskChanged('util.ts'); // the file is as its owner left it
  await co.settled();
  assert.equal(deps.of('crossing').length, 0);
  assert.equal(deps.of('relay').length, 0);
});

test("a change no running shell names is nobody's", async t => {
  const { root, co, id1 } = await twoBoxes(t);
  put(root, 'util.ts', 'x');
  co.diskChanged('util.ts'); // no shell at all
  shell(co, id1, 's1', 'npm install');
  put(root, 'package-lock.json', '{}');
  co.diskChanged('package-lock.json'); // a shell runs, but doesn't name the file
  await co.settled();
  assert.deepEqual({ ...co.owners }, {});
});

test('two running shells that name the same file: neither is blamed', async t => {
  const { root, deps, co, id1, id2 } = await twoBoxes(t);
  shell(co, id1, 's1', 'echo a >> util.ts');
  shell(co, id2, 's2', 'echo b >> util.ts');
  put(root, 'util.ts', 'a\nb\n');
  co.diskChanged('util.ts');
  await co.settled();
  assert.deepEqual({ ...co.owners }, {});
  assert.equal(deps.of('crossing').length, 0);
});

test('a change just after the shell ends still counts; a later one does not', async t => {
  const { root, deps, co, id1 } = await twoBoxes(t);
  shell(co, id1, 's1', 'echo a > a.ts && echo b > b.ts');
  shellEnd(co, id1, 's1');
  deps.clock += 200;
  put(root, 'a.ts', 'a');
  co.diskChanged('a.ts');
  deps.clock += 5000;
  put(root, 'b.ts', 'b');
  co.diskChanged('b.ts');
  await co.settled();
  assert.deepEqual({ ...co.owners }, { 'a.ts': 'box1' });
});

test('shell events stay in main', async t => {
  const { co, id1 } = await twoBoxes(t);
  assert.equal(co.observe(id1, { t: 'shell', id: 's1', command: 'ls' }), true);
  assert.equal(co.observe(id1, { t: 'shell', id: 's1', end: true }), true);
});

test('commandNames matches a file name as a word of its own', () => {
  const { commandNames } = require('../src/main/board');
  assert.ok(commandNames('echo hi >> util.ts', 'util.ts'));
  assert.ok(commandNames("sed -i 's/a/b/' src/util.ts", 'src/util.ts'));
  assert.ok(commandNames(String.raw`cat > "lib\util.ts"`, 'lib/util.ts'));
  assert.ok(!commandNames('echo hi >> myutil.ts', 'util.ts'));
  assert.ok(!commandNames('echo hi >> util.tsx', 'util.ts'));
  assert.ok(!commandNames('npm install', 'package-lock.json'));
});

test("a box's own model and effort go with its run", t => {
  const { deps, co } = newBoard(t);
  co.startBox('box1', { agent: 'claude', name: 'Claude · 1', prompt: 'a', pick: { model: 'opus', effort: 'high' } });
  co.startBox('box2', { agent: 'claude', name: 'Claude · 2', prompt: 'b', pick: { model: 'sonnet' } });
  co.startBox('box3', { agent: 'codex', name: 'Codex · 3', prompt: 'c' });
  assert.deepEqual({ ...deps.runs[0].opts.pick }, { model: 'opus', effort: 'high' });
  assert.deepEqual({ ...deps.runs[1].opts.pick }, { model: 'sonnet' });
  assert.equal(deps.runs[2].opts.pick, null);
});
