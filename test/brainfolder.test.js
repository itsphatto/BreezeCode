// The second brain kept inside each project, in .breezecode/ (brain.json for Breeze, brain.md for any agent to read).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BrainStore, BRAIN_DIR } = require('../src/main/secondbrain');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-brainfolder-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project');
  fs.mkdirSync(project);
  return { legacy: path.join(dir, 'userData', 'second-brain.json'), project };
}
const brainJson = project => path.join(project, BRAIN_DIR, 'brain.json');
const brainMd = project => path.join(project, BRAIN_DIR, 'brain.md');

test('open makes .breezecode with brain.json and brain.md, even for an empty brain', t => {
  const { legacy, project } = tmp(t);
  const s = new BrainStore(legacy, 'linux');
  assert.equal(s.open(project), path.join(project, BRAIN_DIR));
  const j = JSON.parse(fs.readFileSync(brainJson(project), 'utf8'));
  assert.deepEqual(j.nodes, []);
  assert.deepEqual(j.links, []);
  assert.match(fs.readFileSync(brainMd(project), 'utf8'), /^# Second brain/);
});

test('memories and links land in the project, not in the app-data file', t => {
  const { legacy, project } = tmp(t);
  const s = new BrainStore(legacy, 'linux');
  s.addFacts(project, ['The parser lives in src/a.ts'], 'claude', 1);
  const j = JSON.parse(fs.readFileSync(brainJson(project), 'utf8'));
  assert.ok(j.nodes.some(n => n.text === 'The parser lives in src/a.ts'));
  assert.ok(j.nodes.some(n => n.kind === 'file' && n.text === 'src/a.ts'));
  assert.ok(j.links.length >= 1, 'the memory links to the file it names');
  const old = fs.existsSync(legacy) ? JSON.parse(fs.readFileSync(legacy, 'utf8')) : { folders: {} };
  assert.equal(Object.keys(old.folders ?? {}).length, 0);
});

test('a fresh store reads the project brain back', t => {
  const { legacy, project } = tmp(t);
  new BrainStore(legacy, 'linux').addFacts(project, ['The app uses Electron'], 'local', 1);
  assert.equal(new BrainStore(legacy, 'linux').graph(project).nodes.length, 1);
  // Even without the app-data file at all: the project carries its own brain.
  fs.rmSync(path.dirname(legacy), { recursive: true, force: true });
  assert.equal(new BrainStore(legacy, 'linux').graph(project).nodes.length, 1);
});

test('a brain kept in app data moves into the project the first time it is opened', t => {
  const { legacy, project } = tmp(t);
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  // Written the old way: one file, one section per folder.
  const scope = path.resolve(project);
  fs.writeFileSync(legacy, JSON.stringify({ folders: { [scope]: [{ id: 'abc123abc123', kind: 'fact', text: 'Old memory from app data', at: 1, agent: 'x', hits: 1 }] }, seen: ['k1'], read: { [scope]: { chat: 5 } }, edges: {} }));
  const s = new BrainStore(legacy, 'linux');
  s.open(project);
  const j = JSON.parse(fs.readFileSync(brainJson(project), 'utf8'));
  assert.ok(j.nodes.some(n => n.text === 'Old memory from app data'));
  assert.deepEqual(j.read, { chat: 5 });
  const old = JSON.parse(fs.readFileSync(legacy, 'utf8'));
  assert.equal(old.folders[scope], undefined, 'app data no longer holds it');
  assert.deepEqual(old.seen, ['k1'], 'what was seen stays in app data');
});

test('brain.md lists memories with their ids and what they link to', t => {
  const { legacy, project } = tmp(t);
  const s = new BrainStore(legacy, 'linux');
  const a = s.remember(project, 'We chose SQLite over Postgres for offline use', 'decision', [], 'claude', 1);
  const b = s.remember(project, 'Migrations run at app start', 'fact', [a.id], 'claude', 2);
  const md = fs.readFileSync(brainMd(project), 'utf8');
  assert.match(md, /## Decisions/);
  assert.ok(md.includes(`[${a.id}] We chose SQLite over Postgres for offline use`));
  assert.ok(md.includes(`[${b.id}] Migrations run at app start`));
  assert.match(md, new RegExp(`linked: \\[${a.id}\\]`), 'the link the agent made shows under the memory');
});

test('remove forgets the memory in the project files too', t => {
  const { legacy, project } = tmp(t);
  const s = new BrainStore(legacy, 'linux');
  const m = s.remember(project, 'A memory to forget soon', 'fact', [], 'x', 1);
  assert.equal(s.remove(project, m.id), true);
  assert.ok(!fs.readFileSync(brainMd(project), 'utf8').includes('A memory to forget soon'));
  assert.equal(JSON.parse(fs.readFileSync(brainJson(project), 'utf8')).nodes.length, 0);
});

test('a damaged brain.json is kept aside, not overwritten', t => {
  const { legacy, project } = tmp(t);
  fs.mkdirSync(path.join(project, BRAIN_DIR));
  fs.writeFileSync(brainJson(project), '{"nodes": [ broken');
  const s = new BrainStore(legacy, 'linux');
  s.addFacts(project, ['Something new to remember here'], 'x', 1);
  const aside = fs.readdirSync(path.join(project, BRAIN_DIR)).filter(n => n.startsWith('brain.json.broken'));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(project, BRAIN_DIR, aside[0]), 'utf8'), '{"nodes": [ broken');
});

test('with a write delay, a burst of memories is written once, and flush writes what is waiting', t => {
  const { legacy, project } = tmp(t);
  const s = new BrainStore(legacy, 'linux', { writeDelay: 60_000 });
  s.open(project); // the empty brain is written at once
  s.addFacts(project, ['The parser lives in src/a.ts'], 'x', 1);
  s.addFacts(project, ['Webpack bundles renderer assets'], 'x', 2);
  assert.equal(JSON.parse(fs.readFileSync(brainJson(project), 'utf8')).nodes.length, 0, 'not written yet');
  assert.equal(s.graph(project).nodes.length, 3, 'but already searchable');
  s.flush();
  assert.equal(JSON.parse(fs.readFileSync(brainJson(project), 'utf8')).nodes.length, 3);
});

test('a folder that does not exist keeps its brain in app data, as before', t => {
  const { legacy } = tmp(t);
  const s = new BrainStore(legacy, 'linux');
  s.addFacts('/no/such/folder', ['The app uses Electron'], 'x', 1);
  assert.equal(s.open('/no/such/folder'), null);
  assert.equal(new BrainStore(legacy, 'linux').graph('/no/such/folder').nodes.length, 1);
});
