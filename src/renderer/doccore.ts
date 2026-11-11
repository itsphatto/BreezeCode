/* ================= Engine document sync: pure edit and queue logic (no DOM) ================= */
// Shared global scope with the breeze/ files: no imports or exports here. DocPos, DocState and DocKind are declared in
// breeze/core.ts; lineStartsOf, textEdit and TextEdit come from editcore.ts. This file only names them, so it also
// runs under the Node test, which loads editcore.ts first.

interface DocEdit { start: DocPos; end: DocPos; text: string }

// An end position past any line: the engine clamps it to the end of the document.
const DOC_END: DocPos = { line: 2147483647, col: 0 };

/** The engine position (line, UTF-16 column) of `offset`, given the line starts of the text it is in. */
function docPosAt(starts: readonly number[], offset: number): DocPos {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return { line: lo, col: offset - starts[lo] };
}

/** The engine edits that turn `before` into `after`. `edits` are the changes as the surface made them (sorted,
 *  not overlapping, in `before`'s offsets); without them the change is found by comparing the two texts. Positions
 *  are in `before`, and the edits come last first, so applying them in order keeps each earlier position valid. */
function docEditsFor(before: string, after: string, edits: readonly TextEdit[] | null): DocEdit[] {
  if (before === after) return [];
  const starts = lineStartsOf(before);
  const list = edits ?? [textEdit(before, after)];
  const out: DocEdit[] = [];
  for (let i = list.length - 1; i >= 0; i--) {
    out.push({ start: docPosAt(starts, list[i].start), end: docPosAt(starts, list[i].end), text: list[i].text });
  }
  return out;
}

/** What kind of change an input event was, for the engine's undo grouping. */
function docKindOf(kind: string | undefined): DocKind {
  if (kind === 'type') return 'type';
  if (kind === 'deleteContentBackward' || kind === 'deleteContentForward') return 'delete';
  if (kind === 'insertFromPaste') return 'paste';
  return 'other';
}

/** The text without one leading byte order mark (the engine keeps the BOM out of the text it holds). */
function stripBom(text: string): string { return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text; }

interface DocIo {
  send(e: DocEdit, kind: DocKind): Promise<DocState>;
  /** Replaces the engine's text with the page's current text. */
  resync(): Promise<DocState>;
  /** The resync failed too: the engine copy can no longer follow the page. */
  dropped(err: unknown): void;
}

/** Sends edits to the engine one at a time, in the order they were pushed. When a send fails, the page's text is
 *  sent whole instead (resync), and every edit pushed before that began is skipped: the text already has it. */
class DocQueue {
  /** Line count from the newest reply, or null before any. */
  lines: number | null = null;
  dead = false;
  private items: { edit: DocEdit; kind: DocKind }[] = [];
  private running = false;
  /** Edits pushed, and edits sent or skipped. Equal when the queue is idle. */
  private pushed = 0;
  private settled = 0;
  private waiters: { upTo: number; resolve: () => void }[] = [];

  private io: DocIo;
  constructor(io: DocIo) { this.io = io; }

  push(edits: DocEdit[], kind: DocKind): void {
    if (this.dead) return;
    for (const edit of edits) { this.items.push({ edit, kind }); this.pushed++; }
    if (!this.running) void this.run();
  }

  /** True when every edit pushed has been sent or skipped and no send or resync is running: the engine holds the
   *  text as of the newest push. */
  get idle(): boolean { return !this.running && this.settled >= this.pushed; }

  /** Resolves when every edit pushed before this call has been sent or skipped, or the queue is dead. Never rejects. */
  flush(): Promise<void> {
    const upTo = this.pushed;
    if (this.settled >= upTo) return Promise.resolve();
    return new Promise(resolve => { this.waiters.push({ upTo, resolve }); });
  }

  private async run(): Promise<void> {
    this.running = true;
    while (this.items.length && !this.dead) {
      const { edit, kind } = this.items.shift()!;
      try {
        this.lines = (await this.io.send(edit, kind)).lines;
        this.settled++;
      } catch {
        // The edits still waiting are in the text the resync sends, so they are skipped.
        // They count as settled only once the resync is done, so a flush still waits for the engine to be whole.
        const skipped = 1 + this.items.length;
        this.items = [];
        try {
          this.lines = (await this.io.resync()).lines;
        } catch (err) {
          this.dead = true;
          this.io.dropped(err);
        }
        this.settled += skipped;
      }
      this.release();
    }
    this.running = false;
    this.release();
  }

  private release(): void {
    if (this.dead) this.settled = this.pushed;
    this.waiters = this.waiters.filter(w => this.settled < w.upTo || (w.resolve(), false));
  }
}
