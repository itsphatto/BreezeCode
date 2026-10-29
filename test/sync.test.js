const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { blobSha, scanDir, planSync, conflictName, syncWorkspace, workspaceStatus, listWorkspaces, syncSettings, githubStore } = require('../src/main/sync');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-sync-'));
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const has = (dir, rel) => fs.existsSync(path.join(dir, rel));

// The cloud, in memory, with the same three calls as the GitHub and Drive stores.
function memoryStore() {
  const files = new Map();
  return {
    files,
    async list() { return new Map([...files].map(([p, d]) => [p, blobSha(d)])); },
    async read(p) { if (!files.has(p)) throw new Error('missing'); return files.get(p); },
    async commit({ puts, removes }) { for (const { path: p, data } of puts) files.set(p, data); for (const p of removes) files.delete(p); },
  };
}

test('blobSha matches git', () => {
  const dir = tmp();
  write(dir, 'a.txt', 'hello\n');
  const git = execFileSync('git', ['hash-object', path.join(dir, 'a.txt')], { encoding: 'utf8' }).trim();
  assert.equal(blobSha(Buffer.from('hello\n')), git);
});

test('scanDir skips dependencies, git and secrets', async () => {
  const dir = tmp();
  write(dir, 'src/app.js', 'x');
  write(dir, 'node_modules/y/index.js', 'y');
  write(dir, '.git/HEAD', 'ref');
  write(dir, '.env', 'KEY=1');
  write(dir, '.env.local', 'KEY=2');
  write(dir, '.env.example', 'KEY=');
  const { files } = await scanDir(dir);
  assert.deepEqual(Object.keys(files).sort(), ['.env.example', 'src/app.js']);
});

test('planSync is a three-way merge', () => {
  const base = { same: '1', up: '1', down: '1', delHere: '1', delThere: '1', both: '1' };
  const local = { same: '1', up: '2', down: '1', delThere: '1', both: '2', newHere: '9' };
  const remote = { same: '1', up: '1', down: '3', delHere: '1', both: '3', newThere: '8' };
  assert.deepEqual(planSync(base, local, remote), {
    upload: ['newHere', 'up'], download: ['down', 'newThere'], removeLocal: ['delThere'], removeRemote: ['delHere'], conflicts: ['both'],
  });
  // pull: match the cloud, but keep files the cloud never knew about
  assert.deepEqual(planSync(base, local, remote, 'pull'), {
    upload: [], download: ['both', 'delHere', 'down', 'newThere', 'up'], removeLocal: ['delThere'], removeRemote: [], conflicts: [],
  });
});

test('conflictName keeps the folder and extension', () => {
  assert.equal(conflictName('src/app.js', 'LAPTOP-1'), 'src/app (conflict LAPTOP-1).js');
  assert.equal(conflictName('README', 'a/b'), 'README (conflict a-b)');
});

test('case 1: a new computer gets the same workspace', async () => {
  const cloud = memoryStore();
  const laptop1 = tmp(), laptop2 = tmp();
  write(laptop1, 'index.html', '<h1>hi</h1>');
  write(laptop1, 'src/app.js', 'run()');
  const one = await syncWorkspace({ store: cloud, dir: laptop1, link: null, device: 'Laptop1', name: 'BreezeCode' });
  assert.equal(one.summary.uploaded, 2);

  const [ws] = await listWorkspaces(cloud);
  assert.equal(ws.name, 'BreezeCode');
  assert.equal(ws.device, 'Laptop1');
  const two = await syncWorkspace({ store: cloud, dir: laptop2, link: { id: ws.id, rev: 0, base: {} }, mode: 'pull', device: 'Laptop2', name: 'BreezeCode' });
  assert.equal(two.summary.downloaded, 2);
  assert.equal(read(laptop2, 'src/app.js'), 'run()');
  assert.equal(two.link.rev, one.link.rev);
});

test('case 2: an older computer sees the newer version and catches up', async () => {
  const cloud = memoryStore();
  const laptop1 = tmp(), laptop2 = tmp();
  write(laptop1, 'a.txt', 'v1');
  write(laptop1, 'old.txt', 'bye');
  let l1 = (await syncWorkspace({ store: cloud, dir: laptop1, link: null, device: 'Laptop1', name: 'p' })).link;
  let l2 = (await syncWorkspace({ store: cloud, dir: laptop2, link: { id: l1.id, rev: 0, base: {} }, mode: 'pull', device: 'Laptop2', name: 'p' })).link;

  write(laptop1, 'a.txt', 'v2');
  fs.rmSync(path.join(laptop1, 'old.txt'));
  l1 = (await syncWorkspace({ store: cloud, dir: laptop1, link: l1, device: 'Laptop1', name: 'p' })).link;

  const status = await workspaceStatus(cloud, l2);
  assert.equal(status.newer, true);
  assert.equal(status.remote.device, 'Laptop1');

  const r = await syncWorkspace({ store: cloud, dir: laptop2, link: l2, device: 'Laptop2', name: 'p' });
  l2 = r.link;
  assert.equal(read(laptop2, 'a.txt'), 'v2');
  assert.equal(has(laptop2, 'old.txt'), false);
  assert.equal((await workspaceStatus(cloud, l2)).newer, false);
});

test('edits on both sides keep both copies', async () => {
  const cloud = memoryStore();
  const laptop1 = tmp(), laptop2 = tmp();
  write(laptop1, 'a.txt', 'v1');
  let l1 = (await syncWorkspace({ store: cloud, dir: laptop1, link: null, device: 'Laptop1', name: 'p' })).link;
  let l2 = (await syncWorkspace({ store: cloud, dir: laptop2, link: { id: l1.id, rev: 0, base: {} }, mode: 'pull', device: 'Laptop2', name: 'p' })).link;
  write(laptop1, 'a.txt', 'from 1');
  l1 = (await syncWorkspace({ store: cloud, dir: laptop1, link: l1, device: 'Laptop1', name: 'p' })).link;
  write(laptop2, 'a.txt', 'from 2');
  const r = await syncWorkspace({ store: cloud, dir: laptop2, link: l2, device: 'Laptop2', name: 'p' });
  assert.deepEqual(r.summary.conflicts, ['a (conflict Laptop1).txt']);
  assert.equal(read(laptop2, 'a.txt'), 'from 2');
  assert.equal(read(laptop2, 'a (conflict Laptop1).txt'), 'from 1');
  // Laptop 1 then gets both
  await syncWorkspace({ store: cloud, dir: laptop1, link: l1, device: 'Laptop1', name: 'p' });
  assert.equal(read(laptop1, 'a.txt'), 'from 2');
  assert.equal(read(laptop1, 'a (conflict Laptop1).txt'), 'from 1');
});

test('each computer keeps its own number', async () => {
  const cloud = memoryStore();
  const a = tmp(), b = tmp();
  write(a, 'x.txt', '1');
  write(b, 'y.txt', '2');
  const la = (await syncWorkspace({ store: cloud, dir: a, link: null, device: 'Desk', name: 'one' })).link;
  await syncWorkspace({ store: cloud, dir: b, link: null, device: 'Laptop', name: 'two' });
  write(a, 'x.txt', '3');
  await syncWorkspace({ store: cloud, dir: a, link: la, device: 'Desk', name: 'one' });
  const byName = Object.fromEntries((await listWorkspaces(cloud)).map(w => [w.name, w.deviceNo]));
  assert.deepEqual(byName, { one: 1, two: 2 });
});

test('pull backs up unsynced local edits before replacing them', async () => {
  const cloud = memoryStore();
  const laptop1 = tmp(), laptop2 = tmp(), backups = tmp();
  write(laptop1, 'a.txt', 'cloud');
  const l1 = (await syncWorkspace({ store: cloud, dir: laptop1, link: null, device: 'Laptop1', name: 'p' })).link;
  write(laptop2, 'a.txt', 'mine');
  const r = await syncWorkspace({ store: cloud, dir: laptop2, link: { id: l1.id, rev: 0, base: {} }, mode: 'pull', device: 'Laptop2', name: 'p', backupDir: backups });
  assert.equal(read(laptop2, 'a.txt'), 'cloud');
  assert.equal(read(backups, 'a.txt'), 'mine');
  assert.deepEqual(r.summary.backedUp, ['a.txt']);
});

test('cloud paths cannot escape the folder', async () => {
  const cloud = memoryStore();
  const dir = tmp();
  write(dir, 'a.txt', 'x');
  const { link } = await syncWorkspace({ store: cloud, dir, link: null, device: 'L', name: 'p' });
  cloud.files.set(`ws/${link.id}/../evil.txt`, Buffer.from('bad'));
  await assert.rejects(syncWorkspace({ store: cloud, dir, link, device: 'L', name: 'p' }), /outside the project/);
  assert.equal(fs.existsSync(path.join(dir, '..', 'evil.txt')), false);
});

test('the cloud never writes into .git, by any of its names', async () => {
  const cloud = memoryStore();
  const dir = tmp();
  write(dir, 'a.txt', 'x');
  fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
  const { link } = await syncWorkspace({ store: cloud, dir, link: null, device: 'L', name: 'p' });
  for (const rel of ['.git/hooks/a', 'GIT~1/hooks/b', '.git./hooks/c', 'src\\.git\\hooks\\d']) cloud.files.set(`ws/${link.id}/${rel}`, Buffer.from('#!/bin/sh'));
  await syncWorkspace({ store: cloud, dir, link, mode: 'pull', device: 'L', name: 'p' });
  assert.deepEqual(fs.readdirSync(path.join(dir, '.git', 'hooks')), []);
  assert.equal(has(dir, 'src'), false);
});

test('settings: newer side wins', async () => {
  const cloud = memoryStore();
  const first = await syncSettings(cloud, { updatedAt: '2026-01-01', values: { 'breeze.sound': true } });
  assert.equal(first.pulled, false);
  const second = await syncSettings(cloud, { updatedAt: '2025-01-01', values: { 'breeze.sound': false } });
  assert.equal(second.pulled, true);
  assert.equal(second.settings.values['breeze.sound'], true);
});

test('githubStore makes a private repo and commits through the git data API', async () => {
  const calls = [];
  const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const fakeFetch = async (url, init) => {
    const u = url.replace('https://api.github.com', '');
    calls.push(`${init.method} ${u}`);
    if (u === '/repos/me/breeze-sync' && init.method === 'GET') return reply(404, {});
    if (u === '/user/repos') return reply(201, { private: true, default_branch: 'main' });
    if (u.endsWith('/git/ref/heads/main')) return reply(200, { object: { sha: 'c1' } });
    if (u.endsWith('/git/commits/c1')) return reply(200, { tree: { sha: 't1' } });
    if (u.includes('/git/trees/t1')) return reply(200, { tree: [{ path: 'README.md', type: 'blob', sha: 'r' }] });
    if (u.endsWith('/git/blobs')) return reply(201, { sha: 'b1' });
    if (u.endsWith('/git/trees')) return reply(201, { sha: 't2' });
    if (u.endsWith('/git/commits')) return reply(201, { sha: 'c2' });
    if (u.endsWith('/git/refs/heads/main')) return reply(200, {});
    return reply(500, { message: `unexpected ${u}` });
  };
  const store = githubStore({ token: 't', login: 'me', fetch: fakeFetch });
  assert.deepEqual([...await store.list()], [['README.md', 'r']]);
  await store.commit({ puts: [{ path: 'index.json', data: Buffer.from('{}') }], removes: [], message: 'm' });
  assert.ok(calls.includes('POST /user/repos'));
  assert.ok(calls.includes('PATCH /repos/me/breeze-sync/git/refs/heads/main'));
});
