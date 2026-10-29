// Workspace sync between computers signed in to the same account.
// A GitHub account keeps it in a private repo, <login>/breeze-sync; a Google account keeps it in Drive's hidden
// app folder. Both stores hold the same layout:
//   index.json          { workspaces: { <id>: { name, rev, device, updatedAt } } }
//   settings.json       the app settings the renderer chose to share
//   ws/<id>/<path>      one project's files
// A file is known by its git blob sha1 (what GitHub trees report), so unchanged files are never sent twice.
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { resolveUnder } = require('./guard');

const SYNC_REPO = 'breeze-sync';
const INDEX = 'index.json';
const SETTINGS = 'settings.json';
const MAX_SYNC_BYTES = 50 * 1024 * 1024;
const MAX_SYNC_FILES = 10000;
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', '.cache', '__pycache__', '.venv']);
// Secrets and OS clutter never leave the computer.
const SKIP_FILE = /^(?:\.env(?:\..*)?|\.DS_Store|Thumbs\.db|desktop\.ini)$/i;
const KEEP_FILE = /^\.env\.(?:example|sample|template)$/i;

class SyncError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
const reauth = provider => new SyncError(`Sign in to ${provider} again to let Breeze sync your workspaces.`, 'reauth');

const blobSha = buf => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
const wsPrefix = id => `ws/${id}/`;
const newWorkspaceId = () => crypto.randomBytes(8).toString('hex');

// Runs fn over items, at most n at a time.
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/* ================= Local files ================= */
// Every file worth syncing under dir, as { rel: sha }. Big files are left out and counted.
async function scanDir(dir) {
  const files = {};
  let skipped = 0, count = 0;
  const walk = async rel => {
    let entries;
    try { entries = await fsp.readdir(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name)) await walk(r); continue; }
      if (!d.isFile() || (SKIP_FILE.test(d.name) && !KEEP_FILE.test(d.name))) continue;
      const abs = path.join(dir, r);
      const st = await fsp.stat(abs).catch(() => null);
      if (!st || st.size > MAX_SYNC_BYTES) { skipped++; continue; }
      if (++count > MAX_SYNC_FILES) throw new SyncError(`This folder has more than ${MAX_SYNC_FILES} files, too many to sync.`, 'too-big');
      files[r] = blobSha(await fsp.readFile(abs));
    }
  };
  await walk('');
  return { files, skipped };
}

/* ================= What to do ================= */
// Three-way compare: base is what both sides had at the last sync.
// 'sync' keeps both sides' edits; 'pull' makes this computer match the cloud (files only here and never synced stay).
function planSync(base, local, remote, mode = 'sync') {
  const p = { upload: [], download: [], removeLocal: [], removeRemote: [], conflicts: [] };
  for (const rel of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
    const b = base[rel], l = local[rel], r = remote[rel];
    if (l === r) continue;
    if (mode === 'pull') {
      if (r) p.download.push(rel);
      else if (b) p.removeLocal.push(rel);
    } else if (l === b) (r ? p.download : p.removeLocal).push(rel);
    else if (r === b) (l ? p.upload : p.removeRemote).push(rel);
    else if (!l) p.download.push(rel);    // deleted here, edited there: keep the edit
    else if (!r) p.upload.push(rel);      // deleted there, edited here: keep the edit
    else p.conflicts.push(rel);
  }
  for (const k of Object.keys(p)) p[k].sort();
  return p;
}

// "src/app.js" → "src/app (conflict Laptop-1).js"
function conflictName(rel, device) {
  const dir = path.posix.dirname(rel), ext = path.posix.extname(rel), stem = path.posix.basename(rel, ext);
  const name = `${stem} (conflict ${String(device).replace(/[\\/:*?"<>|]/g, '-')})${ext}`;
  return dir === '.' ? name : `${dir}/${name}`;
}

/* ================= Engine ================= */
async function readJson(store, listing, file, fallback) {
  if (!listing.has(file)) return fallback;
  try { return JSON.parse((await store.read(file)).toString('utf8')); } catch { return fallback; }
}
const writeJson = obj => Buffer.from(JSON.stringify(obj, null, 2));

// Each computer gets a number the first time it syncs: PC 1, PC 2, … A new one takes the next free number.
function numberDevice(devices, device) {
  if (!devices[device]) devices[device] = Math.max(0, ...Object.values(devices)) + 1;
  return devices;
}

// Remote workspaces, newest first, each with its computer's number.
async function listWorkspaces(store) {
  const listing = await store.list();
  const { workspaces = {}, devices: saved = {} } = await readJson(store, listing, INDEX, {});
  const list = Object.entries(workspaces).map(([id, w]) => ({ id, ...w }));
  // Clouds synced before numbering existed: number their computers oldest first.
  const devices = { ...saved };
  for (const w of [...list].sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))) numberDevice(devices, w.device);
  return list.map(w => ({ ...w, deviceNo: devices[w.device] })).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

// Brings dir and the cloud copy of a workspace together. link is { id, rev, base } from the last sync, or null.
// Returns the new link and what happened. Local files about to be replaced while holding unsynced edits are copied to backupDir.
async function syncWorkspace({ store, dir, link, mode = 'sync', device, name, backupDir, now = () => new Date().toISOString() }) {
  const listing = await store.list();
  const index = await readJson(store, listing, INDEX, {});
  const workspaces = { ...(index.workspaces || {}) };
  // An unlinked folder joins a cloud workspace of the same name, or starts a new one.
  let id = link?.id;
  if (!id) id = Object.entries(workspaces).find(([, w]) => w.name === name)?.[0] || newWorkspaceId();
  const meta = workspaces[id];
  const base = link?.id === id ? link.base || {} : {};
  const prefix = wsPrefix(id);
  const remote = {};
  for (const [p, sha] of listing) if (p.startsWith(prefix)) remote[p.slice(prefix.length)] = sha;
  const { files: local, skipped } = await scanDir(dir);
  const plan = planSync(base, local, remote, mode);

  const target = rel => resolveUnder(dir, rel); // refuses paths that leave the folder
  const backedUp = [];
  const backup = async rel => {
    if (!backupDir || local[rel] === undefined || local[rel] === base[rel]) return;
    const to = path.join(backupDir, ...rel.split('/'));
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(target(rel), to);
    backedUp.push(rel);
  };
  const fetchRemote = async rel => {
    const buf = await store.read(prefix + rel);
    if (blobSha(buf) !== remote[rel]) throw new SyncError(`${rel} came back damaged from the cloud. Try again.`);
    return buf;
  };

  // Download first: if the upload then fails, nothing here was lost and the next sync picks up again.
  await pool(plan.download, 6, async rel => {
    // Never let the cloud write into .git, which Windows also knows as "GIT~1" or ".git.".
    if (rel.split(/[\\/]/).some(part => /^(?:\.git|git~1)[. ]*$/i.test(part))) return;
    const buf = await fetchRemote(rel);
    await backup(rel);
    const abs = target(rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, buf);
  });
  for (const rel of plan.removeLocal) {
    await backup(rel);
    await fsp.rm(target(rel), { force: true });
  }
  // A conflict keeps this computer's file and puts the cloud's version beside it; both go up.
  const puts = new Map(plan.upload.map(rel => [rel, null]));
  const conflictFiles = [];
  for (const rel of plan.conflicts) {
    const copy = conflictName(rel, meta?.device || 'cloud');
    const buf = await fetchRemote(rel);
    await fsp.writeFile(target(copy), buf);
    puts.set(rel, null).set(copy, buf);
    conflictFiles.push(copy);
  }

  const remoteAfter = { ...remote };
  const changed = puts.size > 0 || plan.removeRemote.length > 0 || !meta;
  let rev = meta?.rev || 0;
  if (changed) {
    const upload = await pool([...puts], 4, async ([rel, buf]) => {
      const data = buf || await fsp.readFile(target(rel));
      remoteAfter[rel] = blobSha(data);
      return { path: prefix + rel, data };
    });
    for (const rel of plan.removeRemote) delete remoteAfter[rel];
    rev += 1;
    workspaces[id] = { name: meta?.name || name, rev, device, updatedAt: now() };
    const devices = numberDevice({ ...(index.devices || {}) }, device);
    upload.push({ path: INDEX, data: writeJson({ ...index, workspaces, devices }) });
    await store.commit({ puts: upload, removes: plan.removeRemote.map(rel => prefix + rel), message: `Sync ${workspaces[id].name} from ${device}` });
  }
  return {
    link: { id, rev, base: remoteAfter },
    summary: {
      id, rev, uploaded: plan.upload.length, downloaded: plan.download.length,
      removed: plan.removeLocal.length + plan.removeRemote.length, conflicts: conflictFiles, backedUp, skipped,
    },
  };
}

// Is the cloud ahead of what this computer last synced?
async function workspaceStatus(store, link) {
  const list = await listWorkspaces(store);
  const remote = link ? list.find(w => w.id === link.id) || null : null;
  return { remote, newer: !!(remote && remote.rev > (link?.rev || 0)), workspaces: list };
}

// Settings carry their own time; the newer side wins.
async function syncSettings(store, local) {
  const listing = await store.list();
  const remote = await readJson(store, listing, SETTINGS, null);
  if (remote && (!local || String(remote.updatedAt) > String(local.updatedAt))) return { settings: remote, pulled: true };
  if (local && (!remote || String(local.updatedAt) > String(remote.updatedAt))) {
    await store.commit({ puts: [{ path: SETTINGS, data: writeJson(local) }], removes: [], message: 'Sync settings' });
  }
  return { settings: local, pulled: false };
}

/* ================= Stores ================= */
// Each store: list() → Map(path → sha), read(path) → Buffer, commit({ puts: [{ path, data }], removes: [path], message }).

async function jsonOrNull(res) { try { return await res.json(); } catch { return null; } }

// GitHub: one commit per sync through the Git data API. The branch update fails if another computer pushed
// in the meantime, so two syncs never overwrite each other.
function githubStore({ token, login, fetch: f = fetch }) {
  const repo = `${login}/${SYNC_REPO}`;
  let branch = null, head = null, shas = new Map();
  const gh = async (method, url, body) => {
    const res = await f(`https://api.github.com${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Breeze-IDE', 'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = res.status === 204 ? null : await jsonOrNull(res);
    if (res.ok) return data;
    if (method === 'GET' && (res.status === 404 || res.status === 409)) return null; // 409: the repo has no commits yet
    if (res.status === 401 || (res.status === 403 && !/rate limit/i.test(data?.message || ''))) throw reauth('GitHub');
    throw new SyncError(`GitHub: ${data?.message || res.status}`, res.status === 422 ? 'conflict' : undefined);
  };
  const ensure = async () => {
    if (branch) return;
    let r = await gh('GET', `/repos/${repo}`);
    if (!r) {
      r = await gh('POST', '/user/repos', { name: SYNC_REPO, private: true, auto_init: true, description: 'Breeze Code workspace sync' });
    }
    if (!r.private) throw new SyncError(`${repo} is public. Make it private or delete it, then sync again.`);
    branch = r.default_branch || 'main';
  };
  return {
    async list() {
      await ensure();
      let ref = null;
      for (let i = 0; i < 5 && !ref; i++) { // a new repo takes a moment to get its first commit
        ref = await gh('GET', `/repos/${repo}/git/ref/heads/${branch}`);
        if (!ref) await new Promise(res => setTimeout(res, 800));
      }
      if (!ref) throw new SyncError('The sync repo is not ready yet. Try again in a minute.');
      head = ref.object.sha;
      const commit = await gh('GET', `/repos/${repo}/git/commits/${head}`);
      const tree = await gh('GET', `/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`);
      if (tree.truncated) throw new SyncError('The sync repo holds too many files to read at once.', 'too-big');
      shas = new Map(tree.tree.filter(e => e.type === 'blob').map(e => [e.path, e.sha]));
      return new Map(shas);
    },
    async read(p) {
      const sha = shas.get(p);
      if (!sha) throw new SyncError(`${p} is not in the cloud`);
      const blob = await gh('GET', `/repos/${repo}/git/blobs/${sha}`);
      return Buffer.from(blob.content, 'base64');
    },
    async commit({ puts, removes, message }) {
      const commit = await gh('GET', `/repos/${repo}/git/commits/${head}`);
      const entries = await pool(puts, 4, async ({ path: p, data }) => {
        const b = await gh('POST', `/repos/${repo}/git/blobs`, { content: data.toString('base64'), encoding: 'base64' });
        return { path: p, mode: '100644', type: 'blob', sha: b.sha };
      });
      for (const p of removes) if (shas.has(p)) entries.push({ path: p, mode: '100644', type: 'blob', sha: null });
      const tree = await gh('POST', `/repos/${repo}/git/trees`, { base_tree: commit.tree.sha, tree: entries });
      const next = await gh('POST', `/repos/${repo}/git/commits`, { message, tree: tree.sha, parents: [head] });
      try {
        await gh('PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha: next.sha, force: false });
      } catch (err) {
        if (err.code === 'conflict') throw new SyncError('Another computer synced at the same time. Sync again.', 'conflict');
        throw err;
      }
      head = next.sha;
      for (const e of entries) e.sha ? shas.set(e.path, e.sha) : shas.delete(e.path);
    },
  };
}

// Google Drive: files live in the hidden app folder, named by their path, with their sha kept as an app property.
const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
function driveStore({ accessToken, fetch: f = fetch }) {
  let ids = new Map();
  const call = async (url, init = {}) => {
    const res = await f(url, { ...init, headers: { Authorization: `Bearer ${accessToken}`, ...(init.headers || {}) } });
    if (res.status === 401 || res.status === 403) throw reauth('Google');
    if (!res.ok) throw new SyncError(`Google Drive: ${(await jsonOrNull(res))?.error?.message || res.status}`);
    return res;
  };
  const multipart = (meta, data) => {
    const b = `breeze${crypto.randomBytes(8).toString('hex')}`;
    return {
      headers: { 'Content-Type': `multipart/related; boundary=${b}` },
      body: Buffer.concat([
        Buffer.from(`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: application/octet-stream\r\n\r\n`),
        data, Buffer.from(`\r\n--${b}--`),
      ]),
    };
  };
  return {
    async list() {
      const found = new Map();
      ids = new Map();
      let page = '';
      do {
        const q = new URLSearchParams({ spaces: 'appDataFolder', fields: 'nextPageToken,files(id,name,appProperties)', pageSize: '1000', ...(page ? { pageToken: page } : {}) });
        const data = await (await call(`${DRIVE}/files?${q}`)).json();
        for (const file of data.files || []) {
          if (ids.has(file.name)) continue;
          ids.set(file.name, file.id);
          found.set(file.name, file.appProperties?.sha || '');
        }
        page = data.nextPageToken || '';
      } while (page);
      return found;
    },
    async read(p) {
      const id = ids.get(p);
      if (!id) throw new SyncError(`${p} is not in the cloud`);
      return Buffer.from(await (await call(`${DRIVE}/files/${id}?alt=media`)).arrayBuffer());
    },
    async commit({ puts, removes }) {
      await pool(puts, 4, async ({ path: p, data }) => {
        const id = ids.get(p);
        const appProperties = { sha: blobSha(data) };
        const req = multipart(id ? { appProperties } : { name: p, parents: ['appDataFolder'], appProperties }, data);
        const res = await call(id ? `${DRIVE_UPLOAD}/files/${id}?uploadType=multipart&fields=id` : `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id`, { method: id ? 'PATCH' : 'POST', ...req });
        ids.set(p, (await res.json()).id);
      });
      await pool(removes.filter(p => ids.has(p)), 4, async p => {
        await call(`${DRIVE}/files/${ids.get(p)}`, { method: 'DELETE' });
        ids.delete(p);
      });
    },
  };
}

// Swaps a Google refresh token for an access token that can reach the app folder.
async function googleAccessToken({ clientId, clientSecret, refreshToken, fetch: f = fetch }) {
  if (!refreshToken) throw reauth('Google');
  const res = await f('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}), refresh_token: refreshToken, grant_type: 'refresh_token' }),
  });
  const tok = await jsonOrNull(res);
  if (!res.ok || !tok?.access_token) throw reauth('Google');
  if (tok.scope && !tok.scope.split(' ').includes(DRIVE_SCOPE)) throw reauth('Google');
  return tok.access_token;
}

module.exports = {
  SyncError, SYNC_REPO, DRIVE_SCOPE, blobSha, scanDir, planSync, conflictName,
  listWorkspaces, syncWorkspace, workspaceStatus, syncSettings, githubStore, driveStore, googleAccessToken,
};
