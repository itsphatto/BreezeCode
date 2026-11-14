// Agent board relays: one box asking another for a change in its files, and the answer going back.
// Pure queue logic, no DOM and no globals from other files, so test/boardrelay.test.js can load it.
// A relay starts at once when its box is idle, waits while that box works, and pauses for the person's Send after
// `limit` relays in a row between the same two boxes (or always, with Auto-relay off).

interface Relay {
  id: string;
  from: string;            // box key
  to: string;              // box key
  kind: 'ask' | 'reply';
  path?: string;
  diff?: string;
  note?: string;
}
type RelayOutcome = 'start' | 'queued' | 'paused';

const pairOf = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

class RelayQueue {
  auto = true;
  limit: number;
  hops = new Map<string, number>();      // pair -> relays in a row with no word from the person
  queued = new Map<string, Relay[]>();   // box -> relays waiting for it to finish
  paused = new Map<string, Relay>();     // id -> relays waiting for Send

  constructor(limit = 3) { this.limit = limit; }

  // `sent`: the person pressed Send on it, so it goes whatever Auto-relay and the loop guard say.
  push(r: Relay, isIdle: (box: string) => boolean, sent = false): RelayOutcome {
    const pair = pairOf(r.from, r.to);
    const hops = (this.hops.get(pair) ?? 0) + 1;
    if (!sent && (!this.auto || hops > this.limit)) {
      this.paused.set(r.id, r);
      return 'paused';
    }
    this.hops.set(pair, hops);
    if (isIdle(r.to)) return 'start';
    const list = this.queued.get(r.to) ?? [];
    list.push(r);
    this.queued.set(r.to, list);
    return 'queued';
  }

  // The next relay waiting for `box`, taken off the queue.
  next(box: string): Relay | null {
    const list = this.queued.get(box);
    const r = list?.shift() ?? null;
    if (list && !list.length) this.queued.delete(box);
    return r;
  }

  waiting(box: string): Relay[] { return [...(this.queued.get(box) ?? [])]; }

  // The person pressed Send on a paused relay: it goes now, and its pair starts counting again.
  send(id: string): Relay | null {
    const r = this.paused.get(id);
    if (!r) return null;
    this.paused.delete(id);
    this.hops.delete(pairOf(r.from, r.to));
    return r;
  }

  // The person wrote in `box`: every pair it is in starts counting again.
  personSpoke(box: string): void {
    for (const pair of [...this.hops.keys()]) if (pair.split('|').includes(box)) this.hops.delete(pair);
  }

  drop(id: string): void {
    this.paused.delete(id);
    for (const [box, list] of this.queued) {
      const rest = list.filter(r => r.id !== id);
      if (rest.length) this.queued.set(box, rest); else this.queued.delete(box);
    }
  }

  // A box was emptied: nothing more goes to it or comes from it. Returns the relays it dropped.
  dropFor(box: string): Relay[] {
    const gone = (r: Relay) => r.from === box || r.to === box;
    const dropped: Relay[] = [];
    for (const [id, r] of [...this.paused]) if (gone(r)) { this.paused.delete(id); dropped.push(r); }
    for (const [key, list] of [...this.queued]) {
      dropped.push(...list.filter(gone));
      const rest = list.filter(r => !gone(r));
      if (rest.length) this.queued.set(key, rest); else this.queued.delete(key);
    }
    return dropped;
  }

  // Returns the relays it dropped.
  stopAll(): Relay[] {
    const dropped = [...this.paused.values(), ...[...this.queued.values()].flat()];
    this.queued.clear();
    this.paused.clear();
    this.hops.clear();
    return dropped;
  }
}

// The message the receiving box's agent gets. `fromName` is the sending box's name ("Claude · 1").
function relayPrompt(r: Relay, fromName: string): string {
  if (r.kind === 'reply') {
    return `${fromName} answered your request:\n${r.note || '(no details)'}\n\nContinue your task.`;
  }
  const what: string[] = [];
  if (r.path) what.push(`File: ${r.path}`);
  if (r.diff) what.push('The change it tried to make (Breeze put the file back):', '```diff', r.diff, '```');
  if (r.note) what.push(r.note);
  return [
    `${fromName} needs a change in your files. It works in this folder at the same time as you.`,
    ...what,
    '',
    'Make the change if it fits your task, then say what you did in one or two lines.',
  ].join('\n');
}

// True when a run answering an ask sends a note back to the box that asked: its answer already goes back as a reply.
// (The asker continuing after a reply may ask again; the loop guard counts those.)
function echoesAnswer(answering: Relay | undefined, to: string): boolean {
  return answering?.kind === 'ask' && answering.from === to;
}
