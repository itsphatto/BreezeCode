// Agent teams: several agents build parts of one task at the same time without editing each other's files.
// The pure parts live here (claims, ownership, prompts, snapshots) with no Electron, so test/team.test.js can cover them.
// Paths are relative to the project, use "/", and folders end in "/".

import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { blockedRel } from './guard';
import { shortName } from './mentions';

export interface Member { agentId: string; name: string; task: string; session?: string }
export interface Team { shared?: string; members: Member[] }
export type RunId = number | string;
export type Owners = Record<string, string>;
export type Claims = Record<string, string[]>;
// A rel -> its bytes at the start (null: it did not exist), and the files too big to copy.
export interface Snapshot { files: Map<string, Buffer | null>; skipped: string[] }
// An event of an agent run, as the renderer sees it.
export interface RunEvent { t: string; [key: string]: unknown }
export interface TeamDeps {
  startRun(opts: { agent: string; mode: string; prompt: string; session?: string; team: { coordinator: TeamCoordinator; agentId: string } }): RunId;
  stopRun(runId: RunId): void;
  emit(runId: RunId, ev: RunEvent): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
interface RunState { agentId: string; phase: 'claim' | 'build'; lastText: string; done: boolean; stopping?: boolean }

/* ----- Claims and ownership ----- */
// `p` as a clean project-relative path, or null when it is empty, outside `root`, or off limits to agents.
function cleanRel(p: unknown, root?: string): string | null {
  if (typeof p !== 'string' || !p.trim()) return null;
  let s = p.trim();
  const folder = /[\\/]$/.test(s); // path.relative would drop the trailing slash
  if (path.isAbsolute(s)) {
    if (!root) return null;
    s = path.relative(root, s);
    if (path.isAbsolute(s)) return null; // another drive
  }
  s = path.posix.normalize(s.replace(/\\/g, '/')).replace(/\/+$/, '');
  if (!s || s === '.' || s === '..' || s.startsWith('../')) return null;
  if (blockedRel(s)) return null;
  return folder ? `${s}/` : s;
}

// The paths in the last ```json block of an agent's reply. Anything malformed gives [].
function parseClaim(text: unknown): string[] {
  const blocks = [...String(text ?? '').matchAll(/```json\s*([\s\S]*?)```/gi)];
  if (!blocks.length) return [];
  let data: { paths?: unknown[] };
  try { data = JSON.parse(blocks.at(-1)![1]); } catch { return []; }
  if (!data || !Array.isArray(data.paths)) return [];
  return [...new Set(data.paths.map(p => cleanRel(p)).filter(Boolean) as string[])];
}

// `owned` is a path or a folder (ending in "/"); true when it is `rel` or holds it.
const covers = (owned: string, rel: string) => owned === rel || (owned.endsWith('/') && rel.startsWith(owned));

// Paths claimed by more than one agent, or inside another agent's folder. `path` is the more specific one.
function findClashes(claims: Claims): { path: string; agents: string[] }[] {
  const ids = Object.keys(claims);
  const found = new Map<string, Set<string>>(); // path -> agent ids
  const add = (p: string, ...agents: string[]) => {
    if (!found.has(p)) found.set(p, new Set());
    agents.forEach(a => found.get(p)!.add(a));
  };
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      for (const a of claims[ids[i]]) {
        for (const b of claims[ids[j]]) {
          if (a === b || covers(b, a)) add(a, ids[i], ids[j]);
          else if (covers(a, b)) add(b, ids[i], ids[j]);
        }
      }
    }
  }
  return [...found].map(([p, agents]) => ({ path: p, agents: ids.filter(id => agents.has(id)) }));
}

// Who owns `rel`: the exact match, else the longest folder holding it.
function ownerOf(owners: Owners, rel: string): string | null {
  if (Object.hasOwn(owners, rel)) return owners[rel];
  let best: string | null = null;
  for (const p of Object.keys(owners)) {
    if (p.endsWith('/') && rel.startsWith(p) && (best === null || p.length > best.length)) best = p;
  }
  return best === null ? null : owners[best];
}

// Files no one owns go to whoever edits them first. Returns the owner after the call.
function claimFirstTouch(owners: Owners, rel: string, agentId: string): string {
  const owner = ownerOf(owners, rel);
  if (owner) return owner;
  owners[rel] = agentId;
  return agentId;
}

// Claude Code permission rules that stop `agentId` editing what a teammate owns.
function claudeDenyArgs(owners: Owners, agentId: string): string[] {
  const args: string[] = [];
  for (const [p, owner] of Object.entries(owners)) {
    if (owner === agentId) continue;
    const pattern = p.endsWith('/') ? `${p}**` : p;
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) args.push(`${tool}(${pattern})`);
  }
  return args;
}

// What an agent asked of teammates: the text after a "For <name>:" line, up to the next one.
function notesFor(text: unknown, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const head = new RegExp(`^\\s*For (${names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}):[ \\t]*(.*)$`, 'i');
  let current: string | null = null;
  const parts: Record<string, string[]> = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = names.length ? head.exec(line) : null;
    if (m) {
      current = names.find(n => n.toLowerCase() === m[1].toLowerCase()) ?? null;
      if (current) (parts[current] ??= []).push(m[2]);
    } else if (current) {
      parts[current].push(line);
    }
  }
  for (const [name, lines] of Object.entries(parts)) {
    const note = lines.join('\n').trim();
    if (note) out[name] = note;
  }
  return out;
}

/* ----- Prompts ----- */
// `member` is { agentId, name, task }; `team` is { shared, members } with every member, `member` included.
const teammatesOf = (member: Member, team: Team) => team.members.filter(m => m.agentId !== member.agentId);

function teamIntro(member: Member, team: Team): string[] {
  const mates = teammatesOf(member, team).map(m => `${m.name}: ${m.task}`).join('; ');
  return [
    'You are on a team of coding agents working in this project at the same time.',
    `Shared context: ${team.shared || 'none'}`,
    `Your task: ${member.task}`,
    `Teammates: ${mates || 'none'}`,
  ];
}

// Asked before any work starts: which files will this agent touch? No edits yet.
function claimPrompt(member: Member, team: Team): string {
  return [
    ...teamIntro(member, team),
    'Before anyone starts, list the files and folders you expect to create or edit for YOUR task only.',
    'Folders end with "/". Do not change any files now. Reply with only this block:',
    '```json',
    '{"paths": ["path/one", "folder/"]}',
    '```',
  ].join('\n');
}

// The brief an agent works from once ownership is settled. `owners` maps path -> agentId.
function buildBrief(member: Member, team: Team, owners: Owners): string {
  const nameOf = (id: string) => team.members.find(m => m.agentId === id)?.name || id;
  const own = Object.keys(owners).filter(p => owners[p] === member.agentId);
  const others = Object.keys(owners).filter(p => owners[p] !== member.agentId).map(p => `${p} (${nameOf(owners[p])})`);
  const asks = teammatesOf(member, team).map(m => `"For ${m.name}:"`).join(' or ');
  return [
    ...teamIntro(member, team),
    `You own: ${own.join(', ') || 'any file no teammate owns'}`,
    ...(others.length ? [`Do not edit: ${others.join(', ')}`] : []),
    'Files no one owns belong to whoever edits them first.',
    `If you need a change in a teammate's files, don't make it. At the end of your final message add a line ${asks || '"For <Name>:"'} followed by what you need.`,
  ].join('\n');
}

/* ----- Snapshots ----- */
// Before an agent builds, its files are copied into memory so a failed or cancelled run can be undone.
// `files` maps rel -> Buffer, or null for a file that did not exist yet.
const MAX_FILE = 2 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules']);
// `rel` as a path under `root`. An absolute path, or one that climbs out with "..", throws.
function absOf(root: string, rel: string): string {
  const s = typeof rel === 'string' ? rel.replace(/\\/g, '/') : '';
  const abs = s ? path.join(root, ...s.split('/')) : '';
  const back = abs && path.relative(root, abs);
  if (!s || path.isAbsolute(rel) || s.split('/').includes('..') || !back || back.startsWith('..') || path.isAbsolute(back)) {
    throw new Error(`${rel} is outside the project`);
  }
  return abs;
}
const missing = (err: unknown) => {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

// True when the file or any folder between `root` and it is a symlink or junction, which a write could follow out of the project.
async function throughLink(root: string, rel: string): Promise<boolean> {
  let p = root;
  for (const part of rel.replace(/\\/g, '/').split('/')) {
    p = path.join(p, part);
    try { if ((await fs.lstat(p)).isSymbolicLink()) return true; } catch (err) { if (missing(err)) return false; throw err; }
  }
  return false;
}

// What `abs` holds now: { data: Buffer | null } (null when absent), { big: true }, or {} for a folder or link.
async function readEntry(abs: string): Promise<{ data?: Buffer | null; big?: boolean }> {
  let st: Awaited<ReturnType<typeof fs.lstat>>;
  try { st = await fs.lstat(abs); } catch (err) { if (missing(err)) return { data: null }; throw err; }
  if (!st.isFile()) return {};
  if (st.size > MAX_FILE) return { big: true };
  try { return { data: await fs.readFile(abs) }; } catch (err) { if (missing(err)) return { data: null }; throw err; }
}

// Records `rel` unless it is already there, off limits to agents (.git, .env*), or reached through a link.
async function record(snap: Snapshot, root: string, rel: string): Promise<void> {
  const abs = absOf(root, rel);
  if (snap.files.has(rel) || blockedRel(rel) || await throughLink(root, rel)) return;
  const { data, big } = await readEntry(abs);
  if (snap.files.has(rel)) return; // another call recorded it while this one was reading
  if (big) { if (!snap.skipped.includes(rel)) snap.skipped.push(rel); }
  else if (data !== undefined) snap.files.set(rel, data);
}

async function recordFolder(snap: Snapshot, root: string, rel: string): Promise<void> {
  let entries: Dirent[];
  try { entries = await fs.readdir(absOf(root, rel), { withFileTypes: true }); } catch (err) { if (missing(err)) return; throw err; }
  for (const e of entries) {
    const child = `${rel}/${e.name}`;
    if (SKIP_DIRS.has(e.name) || blockedRel(child)) continue;
    if (e.isDirectory()) await recordFolder(snap, root, child);
    else if (e.isFile()) await record(snap, root, child);
  }
}

// `paths` are project-relative; a folder (or a path that is one) expands to the files in it.
async function snapshot(root: string, paths: string[]): Promise<Snapshot> {
  const snap: Snapshot = { files: new Map(), skipped: [] };
  for (const p of paths) {
    const rel = p.replace(/\/+$/, '');
    let isDir = p.endsWith('/');
    if (!isDir) { try { isDir = (await fs.lstat(absOf(root, rel))).isDirectory(); } catch (err) { if (!missing(err)) throw err; /* absent: recorded as null */ } }
    if (isDir) await recordFolder(snap, root, rel);
    else await record(snap, root, rel);
  }
  return snap;
}

// A file an agent is about to touch that the snapshot did not cover (first touch). Only the first call counts.
const addToSnapshot = (snap: Snapshot, root: string, rel: string) => record(snap, root, rel);

// Put `rel` back as the snapshot has it. Not in the snapshot: nothing to do.
// Refuses a path that leaves the project or runs through a symlink or junction, so a restore can't write or delete elsewhere.
async function restore(root: string, rel: string, snap: Snapshot): Promise<void> {
  const abs = absOf(root, rel);
  if (!snap.files.has(rel)) return;
  if (await throughLink(root, rel)) throw new Error(`${rel} is reached through a link, so it was not restored`);
  const data = snap.files.get(rel);
  if (data === null) {
    let st: Awaited<ReturnType<typeof fs.lstat>>;
    try { st = await fs.lstat(abs); } catch (err) { if (missing(err)) return; throw err; }
    if (!st.isFile()) throw new Error(`${rel} is not a file, so it was not removed`);
    return fs.rm(abs);
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, data as Buffer);
}

// The snapshot entries whose content, or existence, is not what it was.
async function changedSince(root: string, snap: Snapshot): Promise<string[]> {
  const changed: string[] = [];
  for (const [rel, before] of snap.files) {
    if (await throughLink(root, rel)) { changed.push(rel); continue; }
    const { data, big } = await readEntry(absOf(root, rel));
    const now = data ?? null; // a folder or link in its place counts as absent
    if (big || (before === null) !== (now === null) || (before && !before.equals(now!))) changed.push(rel);
  }
  return changed;
}

/* ----- Team coordinator ----- */
// Drives one team: a read-only claim run per member, then one build run each, with ownership enforced on every
// `file` event. It has no Electron; main.js passes `deps` and feeds every run event to `observe`.
const RECHECK_MS = 300; // a write can land after the first restore (Codex reports before it finishes)
const FINISHED = 'That team has finished.';
const inSkippedDir = (rel: string) => rel.split('/').some(part => SKIP_DIRS.has(part)); // never snapshotted, so never restored

class TeamCoordinator {
  id: string;
  root: string;
  shared?: string;
  members: Member[];
  deps: TeamDeps;
  owners: Owners = {};                         // rel -> agentId; main.ts reads it for claudeDenyArgs
  runs = new Map<RunId, RunState>();
  phase = 'new';                               // new -> claiming -> claimed -> starting -> building
  stopped = false;
  sessions: Record<string, string> = {};
  claims: Claims | null = null;
  snap: Snapshot | null = null;
  startOwners: Owners = {};                    // owners as the build started, before any first-touch claims
  buildRuns: Record<string, RunId> = {};      // agentId -> build runId
  reported = new Map<string, Set<string>>();   // agentId -> the rels its `file` events named
  crossed = new Set<string>();
  timers = new Set<unknown>();
  pending = new Set<Promise<unknown>>();
  lanes = new Map<string, Promise<unknown>>(); // rel -> the tail of that path's queue, so restores of one file never overlap
  finished = false;
  onClaimDone: ((agentId: string, paths: string[] | null) => void) | null = null;

  constructor({ id, root, shared, members, deps }: { id: string; root: string; shared?: string; members: (Omit<Member, 'name'> & { name?: string })[]; deps: TeamDeps }) {
    this.id = id;
    this.root = root;
    this.shared = shared;
    this.members = members.map(m => ({ ...m, name: m.name || shortName({ id: m.agentId, name: m.agentId }) }));
    this.deps = deps;
  }

  get team(): Team { return { shared: this.shared, members: this.members }; }

  hasRun(runId: RunId): boolean { return this.runs.has(runId); }

  claim({ timeoutMs = 60000 }: { timeoutMs?: number } = {}) {
    if (this.stopped) return Promise.reject(new Error(FINISHED));
    if (this.phase !== 'new') return Promise.reject(new Error('That team has already claimed its files.'));
    this.phase = 'claiming';
    return new Promise<{ claims: Claims; clashes: { path: string; agents: string[] }[]; failed: string[]; sessions: Record<string, string> }>(resolve => {
      const left = new Map<string, unknown>(); // agentId -> timeout handle
      const claims: Claims = {};
      const failed = new Set<string>();
      this.onClaimDone = (agentId, paths) => {
        if (!left.has(agentId)) return; // already timed out or done
        this.#cancel(left.get(agentId));
        left.delete(agentId);
        if (paths) claims[agentId] = paths; else failed.add(agentId);
        if (left.size) return;
        this.claims = Object.fromEntries(this.members.map(m => [m.agentId, claims[m.agentId] ?? []]));
        this.phase = 'claimed';
        resolve({
          claims: this.claims,
          clashes: findClashes(this.claims),
          failed: this.members.map(m => m.agentId).filter(a => failed.has(a)),
          sessions: { ...this.sessions },
        });
      };
      for (const m of this.members) {
        const runId = this.deps.startRun({
          agent: m.agentId, mode: 'ask', prompt: claimPrompt(m, this.team), session: m.session,
          team: { coordinator: this, agentId: m.agentId },
        });
        this.runs.set(runId, { agentId: m.agentId, phase: 'claim', lastText: '', done: false });
        left.set(m.agentId, this.#later(timeoutMs, () => {
          this.#stopRun(runId);
          this.onClaimDone?.(m.agentId, null);
        }));
      }
    });
  }

  // `exclude`: members taken off the team before it builds. They get no build run, own nothing, are no one's
  // teammate in a brief or deny list, and team-done does not wait for them.
  async start(owners: Owners = {}, { exclude = [] }: { exclude?: string[] } = {}): Promise<Record<string, RunId>> {
    if (this.stopped) throw new Error(FINISHED);
    if (this.phase === 'new' || this.phase === 'claiming') throw new Error('The team has not finished claiming its files.');
    if (this.phase !== 'claimed') throw new Error('That team has already started.');
    const out = new Set(exclude ?? []);
    const members = this.members.filter(m => !out.has(m.agentId));
    if (!members.length) throw new Error('A team needs at least one agent.');
    this.phase = 'starting';
    const merged: Owners = {};
    for (const m of members) {
      for (const p of this.claims![m.agentId]) if (!Object.hasOwn(merged, p)) merged[p] = m.agentId;
    }
    for (const [p, agentId] of Object.entries(owners ?? {})) {
      const rel = cleanRel(p);
      if (rel && members.some(m => m.agentId === agentId)) merged[rel] = agentId;
    }
    try {
      this.snap = await snapshot(this.root, Object.keys(merged));
    } catch (err) {
      this.phase = 'claimed';
      throw err;
    }
    if (this.stopped) throw new Error(FINISHED);
    this.members = members; // briefs, ownership checks and team-done only know the members that build
    this.owners = merged;
    this.startOwners = { ...merged };
    this.phase = 'building';
    const ids: Record<string, RunId> = {};
    for (const m of this.members) {
      const runId = this.deps.startRun({
        agent: m.agentId, mode: 'build', prompt: buildBrief(m, this.team, this.owners),
        session: this.sessions[m.agentId] ?? m.session, team: { coordinator: this, agentId: m.agentId },
      });
      this.runs.set(runId, { agentId: m.agentId, phase: 'build', lastText: '', done: false });
      this.buildRuns[m.agentId] = runId;
      ids[m.agentId] = runId;
    }
    return ids;
  }

  // True when the event must not reach the renderer. Any work it starts is tracked for `settled()`.
  observe(runId: RunId, ev: RunEvent | null | undefined): boolean {
    const run = this.runs.get(runId);
    if (!run || !ev) return false;
    if (run.phase === 'claim') {
      if (run.done) return true;
      if (ev.t === 'text') run.lastText = String(ev.text ?? '');
      else if (ev.t === 'session' && ev.id) this.sessions[run.agentId] = ev.id as string;
      else if (ev.t === 'done') {
        run.done = true;
        this.onClaimDone?.(run.agentId, ev.ok ? parseClaim(run.lastText) : null);
      }
      return true;
    }
    if (ev.t === 'text') run.lastText = String(ev.text ?? '');
    else if (ev.t === 'file') {
      const rel = cleanRel(ev.path, this.root);
      if (rel && !rel.endsWith('/')) {
        if (!this.reported.has(run.agentId)) this.reported.set(run.agentId, new Set());
        this.reported.get(run.agentId)!.add(rel);
        this.#track(this.#inLane(rel, () => this.#onFile(runId, run.agentId, rel)));
      }
    } else if (ev.t === 'done' && !run.done) {
      run.done = true;
      if (this.members.every(m => this.runs.get(this.buildRuns[m.agentId])?.done)) this.#track(this.#finish());
    }
    return false;
  }

  // The owner of `rel` when it is a teammate of `agentId`, else null. An unowned path becomes `agentId`'s.
  async foreignOwner(agentId: string, rel: string): Promise<string | null> {
    const r = cleanRel(rel, this.root);
    if (!r) return null;
    const wasOwned = ownerOf(this.owners, r) !== null;
    const owner = claimFirstTouch(this.owners, r, agentId);
    if (!wasOwned && this.snap) await addToSnapshot(this.snap, this.root, r);
    return owner === agentId ? null : owner;
  }

  async undo(rel: string): Promise<void> {
    if (this.stopped || !this.snap) throw new Error(FINISHED);
    const r = cleanRel(rel, this.root);
    if (!r) throw new Error(`${rel} is outside the project`);
    return this.#inLane(r, () => restore(this.root, r, this.snap!));
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const h of this.timers) this.deps.clearTimeout(h);
    this.timers.clear();
    for (const [runId, run] of this.runs) if (!run.done) this.#stopRun(runId);
  }

  // Resolves once every restore, snapshot read and team-done check started so far has finished (tests await it).
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  async #onFile(runId: RunId, agentId: string, rel: string): Promise<void> {
    let owner: string | null;
    try { owner = await this.foreignOwner(agentId, rel); } catch {
      owner = ownerOf(this.owners, rel);
      if (owner === agentId) owner = null;
    }
    const snap = this.snap!;
    if (!owner) return this.#refresh(rel);
    // Owned at the start but missing from the snapshot, which listed every owned file: it did not exist then.
    if (ownerOf(this.startOwners, rel) !== null && !snap.files.has(rel) && !snap.skipped.includes(rel) && !inSkippedDir(rel)) {
      snap.files.set(rel, null);
    }
    this.crossed.add(rel);
    const ev: RunEvent = { t: 'crossing', path: rel, agent: agentId, owner };
    if (!snap.files.has(rel)) {
      ev.error = snap.skipped.includes(rel) ? `${rel} is over 2 MB, so no copy was kept` : `${rel} had no saved copy`;
    } else {
      try { await restore(this.root, rel, snap); } catch (err) { ev.error = (err as Error).message; }
    }
    this.deps.emit(runId, ev);
    if (ev.error || this.stopped) return;
    this.#later(RECHECK_MS, () => this.#track(this.#inLane(rel, async () => {
      try { await restore(this.root, rel, snap); } catch (err) {
        this.deps.emit(runId, { t: 'crossing', path: rel, agent: agentId, owner, error: (err as Error).message });
      }
    })));
  }

  // The owner changed `rel`: keep its latest version, so a later crossing restores that and not the start.
  async #refresh(rel: string): Promise<void> {
    const snap = this.snap;
    if (!snap || await throughLink(this.root, rel)) return;
    const { data, big } = await readEntry(absOf(this.root, rel));
    const i = snap.skipped.indexOf(rel);
    if (big) {
      snap.files.delete(rel);
      if (i < 0) snap.skipped.push(rel);
    } else if (data !== undefined) {
      snap.files.set(rel, data);
      if (i >= 0) snap.skipped.splice(i, 1);
    }
  }

  async #finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    await Promise.all([...this.lanes.values()]);
    const ev: { t: string; teamId: string; changed: string[]; notes: Record<string, Record<string, string>>; skipped: string[]; error?: string } = { t: 'team-done', teamId: this.id, changed: [], notes: {}, skipped: [...this.snap!.skipped] };
    try {
      const untraced = (rel: string) => !this.crossed.has(rel) && !this.reported.get(ownerOf(this.owners, rel) ?? '')?.has(rel);
      ev.changed = (await changedSince(this.root, this.snap!)).filter(untraced);
    } catch (err) {
      ev.error = (err as Error).message;
    }
    for (const m of this.members) {
      const others = this.members.filter(o => o.agentId !== m.agentId).map(o => o.name);
      ev.notes[m.agentId] = notesFor(this.runs.get(this.buildRuns[m.agentId])!.lastText, others);
    }
    for (const m of this.members) this.deps.emit(this.buildRuns[m.agentId], { ...ev });
  }

  // Runs `fn` after every earlier job queued for `rel`.
  #inLane<T>(rel: string, fn: () => T | Promise<T>): Promise<T> {
    const job = (this.lanes.get(rel) ?? Promise.resolve()).then(fn);
    const tail = job.catch(() => {});
    this.lanes.set(rel, tail);
    tail.then(() => { if (this.lanes.get(rel) === tail) this.lanes.delete(rel); });
    return job;
  }

  #track(promise: Promise<unknown>): Promise<unknown> {
    const p: Promise<unknown> = promise.catch(() => {}).finally(() => this.pending.delete(p));
    this.pending.add(p);
    return p;
  }

  #later(ms: number, fn: () => void): unknown {
    const h = this.deps.setTimeout(() => {
      this.timers.delete(h);
      if (!this.stopped) fn();
    }, ms);
    this.timers.add(h);
    return h;
  }

  #cancel(h: unknown): void {
    if (this.timers.delete(h)) this.deps.clearTimeout(h);
  }

  #stopRun(runId: RunId): void {
    const run = this.runs.get(runId);
    if (!run || run.stopping) return;
    run.stopping = true;
    this.deps.stopRun(runId);
  }
}

export { cleanRel, parseClaim, covers, findClashes, ownerOf, claimFirstTouch, claudeDenyArgs, notesFor, claimPrompt, buildBrief, snapshot, addToSnapshot, restore, changedSince, TeamCoordinator };
