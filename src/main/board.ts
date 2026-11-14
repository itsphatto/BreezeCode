// Agent board: several boxes, each with its own agent and prompt, run at the same time in the open folder.
// A file belongs to the first box that edits it. A box that edits a teammate's file is stopped or put back, and
// what it wanted goes to the owner's box as a relay (the renderer queues and shows relays).
// No Electron here: main.ts passes `deps` and feeds every run event to `observe`, as it does for teams.

import { absOf, throughLink, readEntry, cleanRel, ownerOf, claimFirstTouch, addToSnapshot, restore, notesFor } from './team';
import type { RunId, Owners, RunEvent, Snapshot } from './team';

export interface BoxMember { agentId: string; agent: string; name: string } // agentId: the box key (box1…box8)
export interface BoardDeps {
  startRun(opts: { agent: string; mode: 'build'; prompt: string; session?: string | null; team: { coordinator: BoardCoordinator; agentId: string } }): RunId;
  stopRun(runId: RunId): void;
  emit(runId: RunId, ev: RunEvent): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
// `preWrite`: the agent reports `file` when it asks to write (Claude Code), so only its `written` event shows what
// landed. `relayed`: "<owner>|<path>" relays this run already sent, so a retry doesn't ask twice.
interface BoxRun { boxKey: string; lastText: string; done: boolean; stopping?: boolean; preWrite: boolean; relayed: Set<string> }
const PRE_WRITE_AGENTS = new Set(['claude']);

const MAX_DIFF = 200;
const RECHECK_MS = 300; // a write can land after the first restore (Codex reports before it finishes)

// The lines between the common start and the common end, as "-" (before) then "+" (after), capped at `max`.
function lineDiff(before: string, after: string, max = MAX_DIFF): string {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const lines = [...a.slice(start, endA).map(l => `-${l}`), ...b.slice(start, endB).map(l => `+${l}`)];
  const shown = lines.slice(0, max);
  if (lines.length > max) shown.push(`… ${lines.length - max} more lines`);
  return [`@@ line ${start + 1}`, ...shown].join('\n');
}

// The build prompt for one box: its task, its teammates, the files it must leave alone, and how to ask for a change.
function boardBrief(member: BoxMember, prompt: string, board: { members: BoxMember[]; owners: Owners; tasks?: Record<string, string> }): string {
  const mates = board.members.filter(m => m.agentId !== member.agentId);
  const out = [prompt];
  if (mates.length) {
    const line = (m: BoxMember) => {
      const task = board.tasks?.[m.agentId]?.split(/\r?\n/)[0]?.trim();
      return `- ${m.name}${task ? ` (working on: ${task})` : ''}`;
    };
    out.push('', `You are ${member.name} on an Agent board. Other agents work in this folder at the same time:`, ...mates.map(line));
    const theirs = Object.entries(board.owners).filter(([, owner]) => owner !== member.agentId && mates.some(m => m.agentId === owner)).map(([p]) => p);
    if (theirs.length) out.push(`Do not edit: ${theirs.join(', ')}`);
    out.push(`If you need a change in a teammate's file, don't make it. Say so at the end of your final message under a line 'For <name>:' (for example 'For ${mates[0].name}:').`);
  }
  return out.join('\n');
}

class BoardCoordinator {
  id: string;
  root: string;
  deps: BoardDeps;
  owners: Owners = {};
  members: BoxMember[] = [];
  tasks: Record<string, string> = {};         // box -> its latest prompt
  runs = new Map<RunId, BoxRun>();
  snap: Snapshot = { files: new Map(), skipped: [] };
  stopped = false;
  timers = new Set<unknown>();
  pending = new Set<Promise<unknown>>();
  lanes = new Map<string, Promise<unknown>>(); // rel -> the tail of that path's queue, so restores of one file never overlap

  constructor({ id, root, deps }: { id: string; root: string; deps: BoardDeps }) {
    this.id = id;
    this.root = root;
    this.deps = deps;
  }

  hasRun(runId: RunId): boolean { return this.runs.has(runId); }

  #running(boxKey: string): RunId | null {
    for (const [id, r] of this.runs) if (r.boxKey === boxKey && !r.done) return id;
    return null;
  }

  startBox(boxKey: string, { agent, name, prompt, session }: { agent: string; name: string; prompt: string; session?: string | null }): RunId {
    if (this.stopped) throw new Error('The board has closed.');
    if (this.#running(boxKey) !== null) throw new Error(`${name} is still working.`);
    const member: BoxMember = { agentId: boxKey, agent, name };
    const i = this.members.findIndex(m => m.agentId === boxKey);
    if (i >= 0) this.members[i] = member; else this.members.push(member);
    this.tasks[boxKey] = prompt;
    const runId = this.deps.startRun({
      agent, mode: 'build', prompt: boardBrief(member, prompt, this), session: session ?? null,
      team: { coordinator: this, agentId: boxKey },
    });
    this.runs.set(runId, { boxKey, lastText: '', done: false, preWrite: PRE_WRITE_AGENTS.has(agent), relayed: new Set() });
    return runId;
  }

  // The owner of `rel` when it is another box, else null. An unowned path becomes `boxKey`'s.
  async foreignOwner(boxKey: string, rel: string): Promise<string | null> {
    const r = cleanRel(rel, this.root);
    if (!r) return null;
    const wasOwned = ownerOf(this.owners, r) !== null;
    const owner = claimFirstTouch(this.owners, r, boxKey);
    if (!wasOwned) await addToSnapshot(this.snap, this.root, r);
    return owner === boxKey ? null : owner;
  }

  // Board events always reach the renderer. A `file` event checks ownership; a `done` relays "For <name>:" notes.
  observe(runId: RunId, ev: RunEvent | null | undefined): boolean {
    const run = this.runs.get(runId);
    if (!run || !ev) return false;
    if (ev.t === 'text') run.lastText = String(ev.text ?? '');
    else if (ev.t === 'file' || ev.t === 'written' || ev.t === 'refused') {
      const rel = cleanRel(ev.path, this.root);
      if (!rel || rel.endsWith('/')) return false;
      // Before the write lands, a pre-write agent's `file` only claims a free path (and keeps what it held).
      if (ev.t === 'file' && run.preWrite) this.#track(this.#inLane(rel, () => this.foreignOwner(run.boxKey, rel)));
      else if (ev.t === 'refused') this.#track(this.#inLane(rel, () => this.#onRefused(runId, run, rel)));
      else this.#track(this.#inLane(rel, () => this.#onFile(runId, run.boxKey, rel)));
    } else if (ev.t === 'done' && !run.done) {
      run.done = true;
      if (ev.ok && !ev.stopped && !run.stopping) this.#relayNotes(runId, run);
    }
    return false;
  }

  // A write main refused before it landed (Local LLM): main emitted the crossing, this sends the relay.
  blocked(fromBox: string, toBox: string, rel: string): void {
    const runId = this.#running(fromBox) ?? this.#lastRun(fromBox);
    if (runId === null) return;
    this.#relay(runId, { t: 'relay', from: fromBox, to: toBox, path: rel, note: `Tried to edit ${rel}` });
  }

  // A box was emptied: it is no one's teammate any more, and its files are free.
  clearBox(boxKey: string): void {
    this.stopBox(boxKey);
    this.members = this.members.filter(m => m.agentId !== boxKey);
    delete this.tasks[boxKey];
    for (const [p, owner] of Object.entries(this.owners)) if (owner === boxKey) this.release(p);
  }

  // Resolves once every restore and snapshot read started so far has finished (tests await it).
  async settled(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  release(rel: string): void {
    const r = cleanRel(rel, this.root) ?? rel;
    delete this.owners[r];
    this.snap.files.delete(r);
  }

  stopBox(boxKey: string): void {
    for (const [id, r] of this.runs) if (r.boxKey === boxKey && !r.done) this.#stopRun(id);
  }

  stopAll(): void {
    for (const h of this.timers) this.deps.clearTimeout(h);
    this.timers.clear();
    for (const [id, r] of this.runs) if (!r.done) this.#stopRun(id);
  }

  // The folder changed or the app is leaving: stop everything for good.
  close(): void {
    this.stopAll();
    this.stopped = true;
  }

  #lastRun(boxKey: string): RunId | null {
    let last: RunId | null = null;
    for (const [id, r] of this.runs) if (r.boxKey === boxKey) last = id;
    return last;
  }

  async #onFile(runId: RunId, boxKey: string, rel: string): Promise<void> {
    let owner: string | null;
    try { owner = await this.foreignOwner(boxKey, rel); } catch {
      owner = ownerOf(this.owners, rel);
      if (owner === boxKey) owner = null;
    }
    if (!owner) return this.#refresh(rel);
    const ev: RunEvent = { t: 'crossing', path: rel, agent: boxKey, owner };
    let attempted = '';
    try {
      const { data } = await readEntry(absOf(this.root, rel));
      attempted = data ? data.toString('utf8') : '';
    } catch { /* unreadable: the relay goes without a diff */ }
    const saved = this.snap.files.get(rel);
    if (!this.snap.files.has(rel)) {
      ev.error = this.snap.skipped.includes(rel) ? `${rel} is over 2 MB, so no copy was kept` : `${rel} had no saved copy`;
    } else {
      try { await restore(this.root, rel, this.snap); } catch (err) { ev.error = (err as Error).message; }
    }
    this.deps.emit(runId, ev);
    const relay: RunEvent = { t: 'relay', from: boxKey, to: owner, path: rel };
    if (saved !== undefined) relay.diff = lineDiff(saved ? saved.toString('utf8') : '', attempted);
    else relay.note = `Tried to edit ${rel}`;
    this.#relay(runId, relay);
    if (ev.error || this.stopped) return;
    this.#later(RECHECK_MS, () => this.#track(this.#inLane(rel, async () => {
      try { await restore(this.root, rel, this.snap); } catch (err) {
        this.deps.emit(runId, { t: 'crossing', path: rel, agent: boxKey, owner, error: (err as Error).message });
      }
    })));
  }

  // Sends a relay unless the board stopped, the run is stopping, or this run already asked for this path.
  #relay(runId: RunId, ev: RunEvent): void {
    const run = this.runs.get(runId);
    if (this.stopped || !run || run.stopping) return;
    const key = `${ev.to}|${ev.path ?? ''}`;
    if (ev.path) {
      if (run.relayed.has(key)) return;
      run.relayed.add(key);
    }
    this.deps.emit(runId, ev);
  }

  // A pre-write agent's write that failed: on a teammate's file, its deny list stopped it.
  async #onRefused(runId: RunId, run: BoxRun, rel: string): Promise<void> {
    const owner = ownerOf(this.owners, rel);
    if (!owner || owner === run.boxKey) return;
    this.deps.emit(runId, { t: 'crossing', path: rel, agent: run.boxKey, owner, blocked: true });
    this.#relay(runId, { t: 'relay', from: run.boxKey, to: owner, path: rel, note: `Tried to edit ${rel}` });
  }

  // The owner changed `rel`: keep its latest version, so a later crossing restores that.
  async #refresh(rel: string): Promise<void> {
    if (await throughLink(this.root, rel)) return;
    const { data, big } = await readEntry(absOf(this.root, rel));
    const i = this.snap.skipped.indexOf(rel);
    if (big) {
      this.snap.files.delete(rel);
      if (i < 0) this.snap.skipped.push(rel);
    } else if (data !== undefined) {
      this.snap.files.set(rel, data);
      if (i >= 0) this.snap.skipped.splice(i, 1);
    }
  }

  #relayNotes(runId: RunId, run: BoxRun): void {
    const mates = this.members.filter(m => m.agentId !== run.boxKey);
    const notes = notesFor(run.lastText, mates.map(m => m.name));
    for (const [name, note] of Object.entries(notes)) {
      const to = mates.find(m => m.name === name)?.agentId;
      if (to) this.#relay(runId, { t: 'relay', from: run.boxKey, to, note });
    }
  }

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

  #stopRun(runId: RunId): void {
    const run = this.runs.get(runId);
    if (!run || run.stopping) return;
    run.stopping = true;
    this.deps.stopRun(runId);
  }
}

export { lineDiff, boardBrief, BoardCoordinator };
