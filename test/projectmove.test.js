// A project folder renamed or moved: its chats, agent sessions and second brain follow it (projectmove.ts, movecore.ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { noteOpened, readMarker, movedPath, moveRecent, claudeSlug, copyClaudeSessions, moveLlmSessions } = require('../src/main/projectmove');
const { BrainStore, BRAIN_DIR } = require('../src/main/secondbrain');
const { MemoryStore } = require('../src/main/agentmemory');

const ctx = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(fs.readFileSync(require.resolve('../src/renderer/breeze/movecore.ts'), 'utf8')), ctx);
const [movedFolderPath, movedStorageKey, planFolderMove] = ['movedFolderPath', 'movedStorageKey', 'planFolderMove'].map(n => vm.runInContext(n, ctx));
const plain = v => JSON.parse(JSON.stringify(v));

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-move-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a folder opened for the first time gets a marker and is not moved', t => {
  const dir = path.join(tmp(t), 'Old');
  fs.mkdirSync(dir);
  assert.deepEqual(noteOpened(dir, undefined, 'linux').moved, []);
  assert.equal(readMarker(dir).path, dir);
  assert.deepEqual(noteOpened(dir, undefined, 'linux').moved, []);
});

test('a renamed folder reports where it was; an install that saw the move already does not move again', t => {
  const base = tmp(t), old = path.join(base, 'Old'), now = path.join(base, 'New');
  fs.mkdirSync(old);
  const { id } = noteOpened(old, undefined, 'linux');
  fs.renameSync(old, now);
  assert.deepEqual(plain(noteOpened(now, () => old, 'linux')), { id, moved: [old] });
  assert.deepEqual(readMarker(now), { id, path: now, was: [old] });
  assert.deepEqual(noteOpened(now, () => now, 'linux').moved, []);
});

test('another install that never saw the folder still moves its data from every earlier path', t => {
  const base = tmp(t), a = path.join(base, 'A'), b = path.join(base, 'B'), c = path.join(base, 'C');
  fs.mkdirSync(a);
  noteOpened(a, undefined, 'linux');
  fs.renameSync(a, b);
  noteOpened(b, () => a, 'linux'); // the dev build moved its own
  fs.renameSync(b, c);
  assert.deepEqual(noteOpened(c, () => undefined, 'linux').moved, [a, b]);
  assert.deepEqual(readMarker(c).was, [a, b]);
});

test('a copy (the old folder still there) is a project of its own, not a move', t => {
  const base = tmp(t), old = path.join(base, 'Old'), copy = path.join(base, 'Copy');
  fs.mkdirSync(old);
  noteOpened(old, undefined, 'linux');
  fs.cpSync(old, copy, { recursive: true });
  assert.deepEqual(noteOpened(copy, () => old, 'linux').moved, []);
  assert.notEqual(readMarker(copy).id, readMarker(old).id);
});

test('paths inside the old folder move, other folders with a longer name do not', () => {
  assert.equal(movedPath('C:\\A\\Old', 'c:\\a\\old', 'C:\\A\\New', 'win32'), 'C:\\A\\New');
  assert.equal(movedPath('C:\\A\\Old\\src', 'C:\\A\\Old', 'C:\\A\\New', 'win32'), 'C:\\A\\New\\src');
  assert.equal(movedPath('C:\\A\\Older', 'C:\\A\\Old', 'C:\\A\\New', 'win32'), null);
  assert.equal(movedPath('/a/Old', '/a/old', '/a/New', 'linux'), null);
  assert.equal(movedFolderPath('C:\\A\\OLD\\x', 'C:\\A\\Old', 'C:\\A\\New'), 'C:\\A\\New\\x');
  assert.equal(movedFolderPath('C:\\A\\Older', 'C:\\A\\Old', 'C:\\A\\New'), null);
});

test('the recent list swaps the old path for the new one without doubling it', () => {
  const r = moveRecent(['/a/New', '/b', '/a/Old'], { '/a/New': 5, '/b': 3, '/a/Old': 9 }, '/a/Old', '/a/New', 'linux');
  assert.deepEqual(r.recent, ['/a/New', '/b']);
  assert.equal(r.recentAt['/a/New'], 9);
});

test('Claude Code sessions are copied to the new folder\'s project dir, the old ones kept', t => {
  const projects = tmp(t);
  const from = 'C:\\Users\\me\\Breeze-IDE', to = 'C:\\Users\\me\\BreezeCode';
  assert.equal(claudeSlug(from), 'C--Users-me-Breeze-IDE');
  const src = path.join(projects, claudeSlug(from));
  fs.mkdirSync(path.join(src, 's1'), { recursive: true });
  fs.writeFileSync(path.join(src, 's1.jsonl'), 'one');
  fs.writeFileSync(path.join(src, 's2.jsonl'), 'two');
  fs.mkdirSync(path.join(projects, claudeSlug(to)));
  fs.writeFileSync(path.join(projects, claudeSlug(to), 's2.jsonl'), 'newer');
  assert.equal(copyClaudeSessions(projects, from, to), 1);
  assert.equal(fs.readFileSync(path.join(projects, claudeSlug(to), 's1.jsonl'), 'utf8'), 'one');
  assert.equal(fs.readFileSync(path.join(projects, claudeSlug(to), 's2.jsonl'), 'utf8'), 'newer');
  assert.ok(fs.existsSync(path.join(projects, claudeSlug(to), 's1')));
  assert.ok(fs.existsSync(path.join(src, 's1.jsonl')));
});

test('local agent sessions from the old folder run in the new one', t => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ base: '/p/Old', messages: [] }));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ base: '/p/Other', messages: [] }));
  assert.equal(moveLlmSessions(dir, '/p/Old', '/p/New', 'linux'), 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'a.json'), 'utf8')).base, '/p/New');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'b.json'), 'utf8')).base, '/p/Other');
});

test('second brain memories kept in app data under the old path join the new folder', t => {
  const base = tmp(t), file = path.join(base, 'second-brain.json'), old = path.join(base, 'Old'), now = path.join(base, 'New');
  // A brain from the app-data file only (as for a folder opened before .breezecode).
  fs.writeFileSync(file, JSON.stringify({ folders: { [old]: [{ id: 'abc', kind: 'fact', text: 'Breeze runs agents side by side.', at: 1, agent: 'x', hits: 1 }] }, read: { [old]: { chat1: 10 } } }));
  fs.mkdirSync(now);
  const s = new BrainStore(file, 'linux');
  assert.equal(s.moveFolder(old, now), true);
  s.open(now);
  assert.deepEqual(s.graph(now).nodes.map(n => n.id), ['abc']);
  const j = JSON.parse(fs.readFileSync(path.join(now, BRAIN_DIR, 'brain.json'), 'utf8'));
  assert.deepEqual(j.read, { chat1: 10 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).folders, {});
});

test('agent memory facts move to the new folder\'s scope', t => {
  const m = new MemoryStore(path.join(tmp(t), 'mem.json'), 'linux');
  m.add('Uses pnpm for installs', '/p/Old');
  m.add('Uses pnpm for installs', '/p/New');
  m.add('Tests run with node --test', '/p/Old');
  assert.equal(m.moveScope('/p/Old', '/p/New'), 1);
  assert.deepEqual(m.list().map(x => x.scope).sort(), ['/p/New', '/p/New']);
});

test('saved keys naming the old folder are renamed; others are left alone', () => {
  const from = 'C:\\Users\\me\\Breeze-IDE', to = 'C:\\Users\\me\\BreezeCode';
  assert.equal(movedStorageKey(`breeze.history:${from}`, from, to), `breeze.history:${to}`);
  assert.equal(movedStorageKey(`breeze.agentSession:${from}:claude`, from, to), `breeze.agentSession:${to}:claude`);
  assert.equal(movedStorageKey(`breeze.board.${from}`, from, to), `breeze.board.${to}`);
  assert.equal(movedStorageKey(`breeze.draft:commit:${from.toLowerCase()}`, from, to), `breeze.draft:commit:${to}`);
  assert.equal(movedStorageKey(`breeze.session:${from}-Web`, from, to), null);
  assert.equal(movedStorageKey('breeze.theme', from, to), null);
});

test('a folder move merges chat histories and refiles Breeze Space chats', () => {
  const from = 'C:\\Users\\me\\Breeze-IDE', to = 'C:\\Users\\me\\BreezeCode';
  const plan = planFolderMove([
    [`breeze.history:${from}`, [{ id: 'a', at: 1, folder: from }, { id: 'b', at: 3, folder: from }]],
    [`breeze.history:${to}`, [{ id: 'c', at: 2, folder: to }]],
    [`breeze.session:${from}`, { tabs: ['old'] }],
    [`breeze.session:${to}`, { tabs: ['new'] }],
    [`breeze.chatId:${from}`, 'a'],
    ['breeze.history:box', [{ id: 'd', at: 1, folder: from }, { id: 'e', at: 1, folder: 'C:\\Other' }]],
  ], from, to);
  const set = Object.fromEntries(plain(plan.set));
  assert.deepEqual(set[`breeze.history:${to}`].map(e => [e.id, e.folder]), [['b', to], ['c', to], ['a', to]]);
  assert.equal(set[`breeze.session:${to}`], undefined); // the new folder's own tabs win
  assert.equal(set[`breeze.chatId:${to}`], 'a');
  assert.deepEqual(set['breeze.history:box'].map(e => e.folder), [to, 'C:\\Other']);
  assert.deepEqual(plain(plan.del).sort(), [`breeze.chatId:${from}`, `breeze.history:${from}`, `breeze.session:${from}`]);
});
