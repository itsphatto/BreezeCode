const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanRel, parseClaim, findClashes, ownerOf, claimFirstTouch, claudeDenyArgs, notesFor, claimPrompt, buildBrief, snapshot, addToSnapshot, restore, changedSince, TeamCoordinator } = require('../src/main/team');

/* ----- Claims and ownership ----- */
test('parseClaim reads the last json block', () => {
  const text = [
    'First thoughts:',
    '```json',
    '{"paths": ["ignored.js"]}',
    '```',
    'Final answer:',
    '```json',
    '{"paths":["web/","web\\\\App.tsx","./README.md"]}',
    '```',
  ].join('\n');
  assert.deepEqual(parseClaim(text), ['web/', 'web/App.tsx', 'README.md']);
});

test('parseClaim drops blocked and outside paths', () => {
  const text = '```json\n{"paths":["../x","/etc/passwd",".git/config",".env","src/a.js"]}\n```';
  assert.deepEqual(parseClaim(text), ['src/a.js']);
});

test('cleanRel makes absolute paths relative to the root', () => {
  const root = path.resolve('proj');
  assert.equal(cleanRel(path.join(root, 'web', 'a.js'), root), 'web/a.js');
  assert.equal(cleanRel(path.join(root, 'web') + path.sep, root), 'web/');
  assert.equal(cleanRel(path.resolve('elsewhere', 'a.js'), root), null);
  assert.equal(cleanRel(root, root), null);
  assert.equal(cleanRel(path.join(root, 'a.js')), null);
});

test('parseClaim tolerates junk', () => {
  assert.deepEqual(parseClaim('no block'), []);
  assert.deepEqual(parseClaim('```json {oops'), []);
  assert.deepEqual(parseClaim('```json\n{"paths":"x"}\n```'), []);
});

test('ownerOf: folder covers children, not prefix siblings', () => {
  const o = { 'web/': 'claude', 'server/api.js': 'codex' };
  assert.equal(ownerOf(o, 'web/components/Button.tsx'), 'claude');
  assert.equal(ownerOf(o, 'webapp/x.js'), null);
  assert.equal(ownerOf(o, 'server/api.js'), 'codex');
});

test('ownerOf picks the longest folder', () => {
  const o = { 'web/': 'claude', 'web/api/': 'codex' };
  assert.equal(ownerOf(o, 'web/api/x.ts'), 'codex');
});

test('findClashes', () => {
  const clashes = findClashes({
    claude: ['web/', 'package.json'],
    codex: ['server/', 'package.json', 'web/api.ts'],
  });
  clashes.sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(clashes, [
    { path: 'package.json', agents: ['claude', 'codex'] },
    { path: 'web/api.ts', agents: ['claude', 'codex'] },
  ]);
});

test('claimFirstTouch', () => {
  const o = {};
  assert.equal(claimFirstTouch(o, 'a.js', 'codex'), 'codex');
  assert.equal(claimFirstTouch(o, 'a.js', 'claude'), 'codex');
});

test('claudeDenyArgs', () => {
  const args = claudeDenyArgs({ 'web/': 'claude', 'server/': 'codex', 'x.js': 'codex' }, 'claude');
  assert.ok(args.includes('Edit(server/**)'));
  assert.ok(args.includes('Write(x.js)'));
  assert.ok(args.includes('NotebookEdit(server/**)'));
  assert.ok(!args.some(a => a.includes('web')));
});

test('notesFor', () => {
  assert.deepEqual(
    notesFor('Done.\nFor Codex: add /api/todos\nFor Claude:\nuse port 3001', ['Codex', 'Claude']),
    { Codex: 'add /api/todos', Claude: 'use port 3001' },
  );
  assert.deepEqual(notesFor('Done.', ['Codex']), {});
});

/* ----- Prompts ----- */
const team = {
  shared: 'A todo app',
  members: [
    { agentId: 'claude', name: 'Claude', task: 'build the UI' },
    { agentId: 'codex', name: 'Codex', task: 'build the API' },
  ],
};

test('claimPrompt asks for a json block and no edits', () => {
  const p = claimPrompt(team.members[0], team);
  assert.ok(p.includes('build the UI'));
  assert.ok(p.includes('A todo app'));
  assert.ok(p.includes('Codex: build the API'));
  assert.ok(p.includes('```json'));
  assert.ok(p.includes('{"paths": ['));
  assert.ok(p.includes('Do not change any files'));
});

test("buildBrief lists own and teammates' paths", () => {
  const brief = buildBrief(team.members[0], team, { 'web/': 'claude', 'server/': 'codex' });
  assert.ok(brief.includes('You own: web/'));
  assert.ok(brief.includes('Do not edit: server/ (Codex)'));
  assert.ok(brief.includes('For Codex:'));
  const none = buildBrief(team.members[0], team, {});
  assert.ok(none.includes('You own: any file no teammate owns'));
  assert.ok(!none.includes('Do not edit'));
});

/* ----- Snapshots ----- */
function tempProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-team-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const put = (root, rel, data) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), data);
};

test('snapshot expands folders and records absent files', async t => {
  const root = tempProject(t);
  put(root, 'web/a.js', 'a');
  put(root, 'web/sub/b.js', 'b');
  put(root, 'web/node_modules/dep/index.js', 'x');
  put(root, 'web/.env', 'SECRET=1');
  put(root, 'web/sub/.env.local', 'SECRET=2');
  put(root, 'web/.git/config', 'x');
  const snap = await snapshot(root, ['web/', 'new.js']);
  assert.deepEqual([...snap.files.keys()].sort(), ['new.js', 'web/a.js', 'web/sub/b.js']);
  assert.equal(snap.files.get('new.js'), null);
  assert.equal(snap.files.get('web/a.js').toString(), 'a');
});

test('restore undoes a modify, a create and a delete', async t => {
  const root = tempProject(t);
  put(root, 'web/a.js', 'a');
  put(root, 'web/sub/b.js', 'b');
  const snap = await snapshot(root, ['web/', 'new.js']);
  put(root, 'web/a.js', 'changed');
  put(root, 'new.js', 'created');
  fs.rmSync(path.join(root, 'web/sub'), { recursive: true });
  const changed = await changedSince(root, snap);
  assert.deepEqual(changed.sort(), ['new.js', 'web/a.js', 'web/sub/b.js']);
  for (const rel of changed) await restore(root, rel, snap);
  assert.deepEqual(await changedSince(root, snap), []);
  assert.equal(fs.existsSync(path.join(root, 'new.js')), false);
  assert.equal(fs.readFileSync(path.join(root, 'web/sub/b.js'), 'utf8'), 'b');
});

test('addToSnapshot records a file once, before it changes', async t => {
  const root = tempProject(t);
  put(root, 'x.js', 'one');
  const snap = await snapshot(root, []);
  await addToSnapshot(snap, root, 'x.js');
  put(root, 'x.js', 'two');
  await addToSnapshot(snap, root, 'x.js'); // already seen: the first content stays
  assert.equal(snap.files.get('x.js').toString(), 'one');
  assert.deepEqual(await changedSince(root, snap), ['x.js']);
  await restore(root, 'x.js', snap);
  assert.equal(fs.readFileSync(path.join(root, 'x.js'), 'utf8'), 'one');
  await restore(root, 'unknown.js', snap); // no entry: nothing happens
});

test('snapshot skips large files', async t => {
  const root = tempProject(t);
  put(root, 'big.bin', Buffer.alloc(2 * 1024 * 1024 + 1));
  put(root, 'ok.txt', 'ok');
  const snap = await snapshot(root, ['big.bin', 'ok.txt']);
  assert.deepEqual(snap.skipped, ['big.bin']);
  assert.equal(snap.files.has('big.bin'), false);
  assert.equal(snap.files.has('ok.txt'), true);
});

test('addToSnapshot keeps the first content when calls overlap', async t => {
  const root = tempProject(t);
  put(root, 'x.js', 'one');
  const snap = await snapshot(root, []);
  const first = addToSnapshot(snap, root, 'x.js');
  const second = addToSnapshot(snap, root, 'x.js');
  await Promise.all([first, second]);
  assert.equal(snap.files.get('x.js').toString(), 'one');
  assert.equal(snap.files.size, 1);
});

test('restore refuses a path outside the root', async t => {
  const root = tempProject(t);
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
  fs.writeFileSync(outside, 'keep');
  t.after(() => fs.rmSync(outside, { force: true }));
  const snap = await snapshot(root, []);
  const rel = `../${path.basename(outside)}`;
  await addToSnapshot(snap, root, 'a.js'); // inside is fine
  await assert.rejects(addToSnapshot(snap, root, rel), /outside the project/);
  await assert.rejects(addToSnapshot(snap, root, outside), /outside the project/);
  snap.files.set(rel, Buffer.from('overwrite')); // even a hand-made entry can't escape
  await assert.rejects(restore(root, rel, snap), /outside the project/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
});

test('restore refuses to write through a symlinked file', async t => {
  const root = tempProject(t);
  const outside = path.join(path.dirname(root), `${path.basename(root)}-target.txt`);
  fs.writeFileSync(outside, 'keep');
  t.after(() => fs.rmSync(outside, { force: true }));
  put(root, 'a.js', 'orig');
  const snap = await snapshot(root, ['a.js']);
  fs.rmSync(path.join(root, 'a.js'));
  try { fs.symlinkSync(outside, path.join(root, 'a.js'), 'file'); } catch (err) { return t.skip(`can't create symlinks here: ${err.code}`); }
  assert.deepEqual(await changedSince(root, snap), ['a.js']);
  await assert.rejects(restore(root, 'a.js', snap), /link/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
});

test('restore refuses to write through a symlinked folder', async t => {
  const root = tempProject(t);
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-team-out-'));
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
  put(outsideDir, 'a.js', 'keep');
  put(root, 'web/a.js', 'orig');
  const snap = await snapshot(root, ['web/']);
  fs.rmSync(path.join(root, 'web'), { recursive: true });
  try { fs.symlinkSync(outsideDir, path.join(root, 'web'), process.platform === 'win32' ? 'junction' : 'dir'); } catch (err) { return t.skip(`can't create symlinks here: ${err.code}`); }
  await assert.rejects(restore(root, 'web/a.js', snap), /link/);
  assert.equal(fs.readFileSync(path.join(outsideDir, 'a.js'), 'utf8'), 'keep');
  // a path reached through the link is not recorded at all
  const snap2 = await snapshot(root, ['web/new.js']);
  assert.equal(snap2.files.size, 0);
});

test('restore will not remove a folder that took the place of an absent file', async t => {
  const root = tempProject(t);
  const snap = await snapshot(root, ['new.js']);
  put(root, 'new.js/inner.txt', 'x');
  await assert.rejects(restore(root, 'new.js', snap), /not a file/);
  assert.equal(fs.existsSync(path.join(root, 'new.js', 'inner.txt')), true);
});

/* ----- TeamCoordinator ----- */
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
  return d;
}

const teamMembers = () => [
  { agentId: 'claude', name: 'Claude', task: 'build the UI' },
  { agentId: 'codex', name: 'Codex', task: 'build the API' },
];

function newTeam(t, files = {}) {
  const root = tempProject(t);
  for (const [rel, data] of Object.entries(files)) put(root, rel, data);
  const deps = fakeDeps();
  const co = new TeamCoordinator({ id: 'team-1', root, shared: 'A todo app', members: teamMembers(), deps });
  return { root, deps, co };
}

// Claims finish with nothing claimed (claim runs 1 and 2), then the build starts with `owners` (claude 3, codex 4).
async function building(t, owners, files) {
  const team = newTeam(t, files);
  const claimed = team.co.claim();
  team.co.observe(1, { t: 'done', ok: true });
  team.co.observe(2, { t: 'done', ok: true });
  await claimed;
  team.ids = await team.co.start(owners);
  return team;
}
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function assertCrossing(ev, rel, agent, owner) {
  assert.equal(ev.t, 'crossing');
  assert.equal(ev.path, rel);
  assert.equal(ev.agent, agent);
  assert.equal(ev.owner, owner);
}

test('observe hides claim-phase events', async t => {
  const { co } = newTeam(t);
  const claimed = co.claim();
  assert.equal(co.hasRun(1), true);
  assert.equal(co.observe(1, { t: 'text', text: 'x' }), true);
  co.observe(1, { t: 'done', ok: true });
  co.observe(2, { t: 'done', ok: true });
  await claimed;
  const ids = await co.start({});
  assert.equal(co.hasRun(ids.claude), true);
  assert.equal(co.observe(ids.claude, { t: 'text' }), false);
  assert.equal(co.hasRun(99), false);
});

test('claim collects paths, sessions and failures', async t => {
  const { co } = newTeam(t);
  const claimed = co.claim();
  co.observe(1, { t: 'session', id: 's1' });
  co.observe(1, { t: 'text', text: 'Mine:\n```json\n{"paths":["web/"]}\n```' });
  co.observe(1, { t: 'done', ok: true });
  co.observe(2, { t: 'done', ok: false });
  assert.deepEqual(await claimed, { claims: { claude: ['web/'], codex: [] }, clashes: [], failed: ['codex'], sessions: { claude: 's1' } });
});

test('claim runs are read-only and get the claim prompt', async t => {
  const { co, deps } = newTeam(t);
  co.claim();
  const [claude] = deps.runs;
  assert.equal(claude.opts.agent, 'claude');
  assert.equal(claude.opts.mode, 'ask');
  assert.ok(claude.opts.prompt.includes('```json'));
  assert.equal(claude.opts.team.coordinator, co);
  assert.equal(claude.opts.team.agentId, 'claude');
});

test('claim times out', async t => {
  const { co, deps } = newTeam(t);
  const claimed = co.claim({ timeoutMs: 10 });
  co.observe(1, { t: 'done', ok: true });
  deps.fire(10);
  assert.deepEqual(deps.stopped, [2]);
  const result = await claimed;
  assert.deepEqual(result.failed, ['codex']);
  // the stopped run's late done is still hidden and does not count toward the build
  assert.equal(co.observe(2, { t: 'done', ok: false, stopped: true }), true);
  const ids = await co.start({});
  co.observe(ids.claude, { t: 'done', ok: true });
  await co.settled();
  assert.equal(deps.of('team-done').length, 0);
});

test('start rejects before claim resolves and when called twice', async t => {
  const { co } = newTeam(t);
  await assert.rejects(co.start({}));
  const claimed = co.claim();
  await assert.rejects(co.start({}));
  co.observe(1, { t: 'done', ok: true });
  co.observe(2, { t: 'done', ok: true });
  await claimed;
  await co.start({});
  await assert.rejects(co.start({}));
});

test('start uses the brief and resumes the claim session', async t => {
  const { co, deps } = newTeam(t);
  const claimed = co.claim();
  co.observe(1, { t: 'session', id: 's1' });
  co.observe(1, { t: 'text', text: '```json\n{"paths":["web/"]}\n```' });
  co.observe(1, { t: 'done', ok: true });
  co.observe(2, { t: 'done', ok: true });
  await claimed;
  const ids = await co.start({});
  const { opts } = deps.runs.find(r => r.id === ids.claude);
  assert.equal(opts.agent, 'claude');
  assert.equal(opts.mode, 'build');
  assert.equal(opts.session, 's1');
  assert.equal(opts.team.agentId, 'claude');
  assert.equal(opts.team.coordinator, co);
  assert.ok(opts.prompt.includes('You own: web/'));
  assert.equal(co.owners['web/'], 'claude');
});

test('start lets owners decide clashes', async t => {
  const { co } = newTeam(t);
  const claimed = co.claim();
  co.observe(1, { t: 'text', text: '```json\n{"paths":["package.json"]}\n```' });
  co.observe(2, { t: 'text', text: '```json\n{"paths":["package.json","server/"]}\n```' });
  co.observe(1, { t: 'done', ok: true });
  co.observe(2, { t: 'done', ok: true });
  assert.deepEqual((await claimed).clashes, [{ path: 'package.json', agents: ['claude', 'codex'] }]);
  await co.start({ 'package.json': 'codex' });
  assert.deepEqual(co.owners, { 'package.json': 'codex', 'server/': 'codex' });
});

test('start skips excluded members', async t => {
  const root = tempProject(t);
  const deps = fakeDeps();
  const members = [...teamMembers(), { agentId: 'local', name: 'Local', task: 'write the docs' }];
  const co = new TeamCoordinator({ id: 'team-1', root, shared: 'A todo app', members, deps });
  const claimed = co.claim();
  co.observe(3, { t: 'text', text: '```json\n{"paths":["docs/"]}\n```' });
  for (const id of [1, 2, 3]) co.observe(id, { t: 'done', ok: true });
  await claimed;
  await assert.rejects(co.start({}, { exclude: ['claude', 'codex', 'local'] }));
  const ids = await co.start({ 'docs/': 'local' }, { exclude: ['local'] });
  assert.deepEqual(Object.keys(ids).sort(), ['claude', 'codex']);
  const builds = deps.runs.filter(r => r.opts.mode === 'build');
  assert.deepEqual(builds.map(r => r.opts.agent).sort(), ['claude', 'codex']);
  for (const { opts } of builds) {
    assert.ok(!opts.prompt.includes('Local'), 'an excluded member is not a teammate');
    assert.ok(!opts.prompt.includes('docs/'));
  }
  assert.deepEqual(co.owners, {}); // its claim and the owner given to it are dropped
  assert.deepEqual(claudeDenyArgs(co.owners, 'claude'), []);
  co.observe(ids.claude, { t: 'done', ok: true });
  co.observe(ids.codex, { t: 'done', ok: true });
  await co.settled();
  const done = deps.of('team-done');
  assert.deepEqual(done.map(e => e.runId).sort(), [ids.claude, ids.codex].sort());
  assert.deepEqual(Object.keys(done[0].ev.notes).sort(), ['claude', 'codex']);
});

test('restores a crossing and emits it', async t => {
  const { root, deps, co, ids } = await building(t, { 'web/a.js': 'claude' }, { 'web/a.js': 'orig' });
  put(root, 'web/a.js', 'hacked');
  assert.equal(co.observe(ids.codex, { t: 'file', path: 'web/a.js' }), false);
  await co.settled();
  assert.equal(read(root, 'web/a.js'), 'orig');
  const crossings = deps.of('crossing');
  assert.equal(crossings.length, 1);
  assert.equal(crossings[0].runId, ids.codex);
  assertCrossing(crossings[0].ev, 'web/a.js', 'codex', 'claude');
  assert.equal(crossings[0].ev.error, undefined);
});

test('restores again after 300 ms', async t => {
  const { root, deps, co, ids } = await building(t, { 'web/a.js': 'claude' }, { 'web/a.js': 'orig' });
  put(root, 'web/a.js', 'hacked');
  co.observe(ids.codex, { t: 'file', path: 'web/a.js' });
  await co.settled();
  put(root, 'web/a.js', 'late');
  deps.fire(300);
  await co.settled();
  assert.equal(read(root, 'web/a.js'), 'orig');
});

test('crossing into a new file in an owned folder deletes it', async t => {
  const { root, deps, co, ids } = await building(t, { 'web/': 'claude' }, { 'web/a.js': 'a' });
  put(root, 'web/new.js', 'intruder');
  co.observe(ids.codex, { t: 'file', path: 'web/new.js' });
  await co.settled();
  assert.equal(fs.existsSync(path.join(root, 'web/new.js')), false);
  assertCrossing(deps.of('crossing')[0].ev, 'web/new.js', 'codex', 'claude');
});

test('a failed restore is emitted with its error', async t => {
  const { root, deps, co, ids } = await building(t, { 'web/new.js': 'claude' });
  put(root, 'web/new.js/inner.txt', 'x'); // a folder where the absent file was
  co.observe(ids.codex, { t: 'file', path: 'web/new.js' });
  await co.settled();
  const { ev } = deps.of('crossing')[0];
  assertCrossing(ev, 'web/new.js', 'codex', 'claude');
  assert.match(ev.error, /not a file/);
});

test('normalises absolute and backslash paths', async t => {
  const { root, deps, co, ids } = await building(t, { 'web/a.js': 'claude' }, { 'web/a.js': 'orig' });
  put(root, 'web/a.js', 'hacked');
  co.observe(ids.codex, { t: 'file', path: path.join(root, 'web', 'a.js') });
  await co.settled();
  assert.equal(read(root, 'web/a.js'), 'orig');
  put(root, 'web/a.js', 'hacked');
  co.observe(ids.codex, { t: 'file', path: 'web\\a.js' });
  await co.settled();
  assert.equal(read(root, 'web/a.js'), 'orig');
  const crossings = deps.of('crossing');
  assert.equal(crossings.length, 2);
  for (const { ev } of crossings) assertCrossing(ev, 'web/a.js', 'codex', 'claude');
});

test('two reports of the same crossing both restore', async t => {
  const { root, deps, co, ids } = await building(t, { 'web/a.js': 'claude' }, { 'web/a.js': 'orig' });
  put(root, 'web/a.js', 'hacked');
  co.observe(ids.codex, { t: 'file', path: 'web/a.js' });
  co.observe(ids.codex, { t: 'file', path: 'web/a.js' });
  await co.settled();
  assert.equal(read(root, 'web/a.js'), 'orig');
  assert.equal(deps.of('crossing').length, 2);
});

test('team-done fires when a member fails', async t => {
  const { deps, co, ids } = await building(t, {});
  co.observe(ids.claude, { t: 'done', ok: true });
  co.observe(ids.codex, { t: 'done', ok: false });
  co.observe(ids.codex, { t: 'done', ok: false }); // a repeat does not fire it twice
  await co.settled();
  const done = deps.of('team-done');
  assert.deepEqual(done.map(e => e.runId).sort(), [ids.claude, ids.codex].sort());
  assert.equal(done[0].ev.teamId, 'team-1');
});

test('team-done lists untraced changes and notes', async t => {
  const { root, deps, co, ids } = await building(t, { 'web/': 'claude', 'server/x.js': 'codex' }, { 'web/a.js': 'a', 'server/x.js': 'one' });
  put(root, 'server/x.js', 'two');
  put(root, 'web/a.js', 'traced');
  co.observe(ids.claude, { t: 'file', path: 'web/a.js' });
  co.observe(ids.claude, { t: 'text', text: 'Done.\nFor Codex: add a route' });
  co.observe(ids.claude, { t: 'done', ok: true });
  co.observe(ids.codex, { t: 'done', ok: true });
  await co.settled();
  const { ev } = deps.of('team-done')[0];
  assert.equal(ev.t, 'team-done');
  assert.equal(ev.teamId, 'team-1');
  assert.deepEqual(ev.changed, ['server/x.js']);
  assert.deepEqual(ev.notes.claude, { Codex: 'add a route' });
  assert.deepEqual(ev.notes.codex, {});
  assert.deepEqual(ev.skipped, []);
});

test('first-touch file is claimed and snapshotted', async t => {
  const { root, deps, co, ids } = await building(t, {});
  put(root, 'new.js', 'codex version');
  co.observe(ids.codex, { t: 'file', path: 'new.js' });
  await co.settled();
  assert.equal(co.owners['new.js'], 'codex');
  assert.equal(deps.of('crossing').length, 0);
  put(root, 'new.js', 'claude version');
  co.observe(ids.claude, { t: 'file', path: 'new.js' });
  await co.settled();
  assertCrossing(deps.of('crossing')[0].ev, 'new.js', 'claude', 'codex');
  assert.equal(read(root, 'new.js'), 'codex version');
});

test('foreignOwner claims first touch and names a teammate owner', async t => {
  const { co } = await building(t, { 'web/': 'claude' });
  assert.equal(await co.foreignOwner('codex', 'web/a.js'), 'claude');
  assert.equal(await co.foreignOwner('claude', 'web/a.js'), null);
  assert.equal(await co.foreignOwner('codex', 'server/x.js'), null);
  assert.equal(co.owners['server/x.js'], 'codex');
  assert.equal(await co.foreignOwner('claude', 'server/x.js'), 'codex');
});

test('owner edits refresh the snapshot', async t => {
  const { root, co, ids } = await building(t, { 'web/a.js': 'claude' }, { 'web/a.js': 'orig' });
  put(root, 'web/a.js', 'v2');
  co.observe(ids.claude, { t: 'file', path: 'web/a.js' });
  await co.settled();
  put(root, 'web/a.js', 'hacked');
  co.observe(ids.codex, { t: 'file', path: 'web/a.js' });
  await co.settled();
  assert.equal(read(root, 'web/a.js'), 'v2');
});

test('undo restores a file from the snapshot', async t => {
  const { root, co } = await building(t, { 'server/x.js': 'codex' }, { 'server/x.js': 'one' });
  put(root, 'server/x.js', 'two');
  await co.undo('server/x.js');
  assert.equal(read(root, 'server/x.js'), 'one');
});

test('stop stops every run and team-done still fires', async t => {
  const { root, deps, co, ids } = await building(t, { 'web/a.js': 'claude' }, { 'web/a.js': 'orig' });
  put(root, 'web/a.js', 'hacked');
  co.observe(ids.codex, { t: 'file', path: 'web/a.js' });
  await co.settled();
  co.observe(ids.claude, { t: 'done', ok: true });
  co.stop();
  assert.deepEqual(deps.stopped, [ids.codex]);
  assert.equal(deps.timers.length, 0); // the 300 ms re-check is cancelled
  co.observe(ids.codex, { t: 'done', ok: false, stopped: true });
  await co.settled();
  assert.equal(deps.of('team-done').length, 2);
});

test('undo after stop rejects', async t => {
  const { co } = await building(t, { 'web/a.js': 'claude' }, { 'web/a.js': 'orig' });
  co.stop();
  await assert.rejects(co.undo('web/a.js'), { message: 'That team has finished.' });
});
