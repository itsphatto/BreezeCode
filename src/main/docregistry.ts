// Which documents the page may use: the open ids, the id each path currently has, and a generation that changes
// whenever everything is dropped (folder change, engine stop). Pure bookkeeping; main.js talks to the engine.
class DocRegistry {
  ids = new Set<number>();
  byPath = new Map<string, number>(); // absolute path → its current id
  generation = 0;

  isOpen(id: number): boolean { return this.ids.has(id); }

  // Record an open that started in `generation`. The engine's open of an open path gives a new id and drops the old
  // one, so the old one goes too. Returns false (and records nothing) if everything was dropped in the meantime.
  record(abs: string, doc: number, generation: number): boolean {
    if (generation !== this.generation) return false;
    const old = this.byPath.get(abs);
    if (old !== undefined) this.ids.delete(old);
    this.byPath.set(abs, doc);
    this.ids.add(doc);
    return true;
  }

  forget(doc: number): void {
    this.ids.delete(doc);
    for (const [abs, id] of this.byPath) if (id === doc) this.byPath.delete(abs);
  }

  // Drops everything and starts a new generation. Returns the ids that were open.
  clear(): number[] {
    const ids = [...this.ids];
    this.ids.clear();
    this.byPath.clear();
    this.generation++;
    return ids;
  }
}

export { DocRegistry };
