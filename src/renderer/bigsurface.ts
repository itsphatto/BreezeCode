/* ================= Big-file surface: a windowed editor over the engine's document ================= */
// Shared global scope with editcore.ts, bigcore.ts and the breeze/ files: no imports or exports here.
// The page never holds the whole text: the engine owns it, and this keeps a LineCache of the lines around the view,
// edits it at once and sends each edit on without waiting. Vertical scrolling is its own (a line index, not pixels),
// so 3,000,000 lines cost the same as 30. Focus, typing, IME and the clipboard go through a 1px input, as in CodeSurface.
interface BigSource {
  lines(first: number, count: number): Promise<DocState & { items: DocLine[] }>;
  edit(start: DocPos, end: DocPos, text: string, kind: DocKind): Promise<DocState & { caret: DocPos }>;
  undo(): Promise<DocState & { caret?: DocPos; none?: true }>;
  redo(): Promise<DocState & { caret?: DocPos; none?: true }>;
  text(start: DocPos, end: DocPos): Promise<string>;
}
interface BigOpts { lineHeight: () => number; charWidth: () => number; tabSize: number; label: string; readOnly: boolean; lines: number; rev: number }
interface BigDrag { unit: number; a: DocPos; b: DocPos; x: number; y: number; raf: number }

// Left padding of the text inside .big-lines (see breeze.css); carets and selection boxes add it to their x.
const BIG_PAD = 4;
// The cache must reach this far past the view before a fetch is asked for, and a fetch asks for this much.
const BIG_KEEP = 40, BIG_FETCH = 200;
const BIG_NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
// One canvas for every surface: it measures non-ASCII prefixes, which aren't charWidth per unit.
let bigMeasureCtx: CanvasRenderingContext2D | null = null;

class BigSurface extends EventTarget {
  readonly root: HTMLDivElement;
  readonly input: HTMLTextAreaElement;
  private readonly src: BigSource;
  private readonly opts: BigOpts;
  private readonly gutter: HTMLDivElement;
  private readonly nums: HTMLDivElement;
  private readonly code: HTMLDivElement;
  private readonly linesEl: HTMLDivElement;
  private readonly selLayer: HTMLDivElement;
  private readonly caretEl: HTMLDivElement;
  private readonly slider: HTMLDivElement;
  private readonly thumb: HTMLDivElement;
  private readonly cache = new LineCache();
  private readonly resizer: ResizeObserver;
  private n: number;                       // line count, updated locally with every edit
  private top = 0;                         // first visible line, fractional: wheel scrolling is smooth
  private anchor: DocPos = { line: 0, col: 0 };
  private head: DocPos = { line: 0, col: 0 };
  private goal: number | null = null;      // column kept across vertical moves
  private rows: HTMLDivElement[] = [];
  private numRows: HTMLDivElement[] = [];
  private painted: { line: number; item: DocLine | undefined }[] = [];
  private fetching: Promise<void> | null = null;
  private gen = 0;                         // bumped by reset: replies asked for before it are dropped
  private pending = 0;                     // edits sent and not answered
  private historyBusy = false;             // an undo or redo is waiting for the engine
  private held = 0;                        // while > 0, input waits in `queue` (see hold)
  private queue: (() => void)[] = [];
  private font = '';
  private caretAt = '';
  private drag: BigDrag | null = null;
  private thumbDrag: { y: number; top: number } | null = null;
  private clicks = { n: 0, t: -1e9, x: 0, y: 0 };

  constructor(host: HTMLElement, src: BigSource, opts: BigOpts) {
    super();
    this.src = src;
    this.opts = opts;
    this.n = Math.max(1, opts.lines);
    this.cache.rev = opts.rev;
    const div = (cls: string) => { const d = document.createElement('div'); d.className = cls; return d; };
    this.root = div('big-surface');
    this.root.style.tabSize = String(opts.tabSize);
    this.gutter = div('big-gutter');
    this.nums = div('big-nums');
    this.gutter.append(this.nums);
    this.code = div('big-code');
    this.selLayer = div('big-sels');
    this.linesEl = div('big-lines');
    this.caretEl = div('code-caret');
    this.input = document.createElement('textarea');
    this.input.className = 'ta code-input';
    this.input.setAttribute('aria-label', opts.label);
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.input.setAttribute('autocapitalize', 'off');
    this.input.wrap = 'off';
    this.code.append(this.selLayer, this.linesEl, this.caretEl, this.input);
    this.slider = div('big-slider');
    this.thumb = div('big-thumb');
    this.slider.append(this.thumb);
    this.root.append(this.gutter, this.code, this.slider);
    host.append(this.root);

    this.input.addEventListener('focus', () => { this.root.classList.add('focused'); this.dispatchEvent(new Event('selectionchange')); });
    this.input.addEventListener('blur', () => this.root.classList.remove('focused'));
    this.input.addEventListener('keydown', e => this.onKey(e));
    this.input.addEventListener('input', e => {
      if ((e as InputEvent).isComposing || this.input.classList.contains('composing')) { this.sizeComposing(); return; }
      const t = this.input.value;
      this.input.value = '';
      if (t) this.insert(t, 'type');
    });
    this.input.addEventListener('compositionstart', () => { this.input.classList.add('composing'); this.sizeComposing(); });
    this.input.addEventListener('compositionend', () => {
      const t = this.input.value;
      this.input.value = '';
      this.input.classList.remove('composing');
      this.input.style.width = '';
      if (t) this.insert(t, 'type');
    });
    // The engine keeps the only history; the hidden input's own undo must not change anything.
    this.input.addEventListener('beforeinput', e => { if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') e.preventDefault(); });
    this.input.addEventListener('copy', e => this.onCopy(e, false));
    this.input.addEventListener('cut', e => this.onCopy(e, true));
    this.input.addEventListener('paste', e => {
      e.preventDefault();
      const t = e.clipboardData?.getData('text/plain').replace(/\r\n?/g, '\n');
      if (t) this.insert(t, 'paste');
    });
    // Vertical scrolling is ours; a native one (focus, the input following the caret) is undone at once.
    this.code.addEventListener('scroll', () => { if (this.code.scrollTop) this.code.scrollTop = 0; });
    this.root.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    this.code.addEventListener('pointerdown', e => this.onPointerDown(e));
    this.slider.addEventListener('pointerdown', e => this.onThumbDown(e));
    // As in CodeSurface: block native selection and focus loss on mousedown, not pointerdown.
    this.root.addEventListener('mousedown', e => e.preventDefault());
    this.resizer = new ResizeObserver(() => this.paint());
    this.resizer.observe(this.root);
    this.refresh();
  }

  get lines() { return this.n; }
  get caret(): DocPos { return { ...this.head }; }
  get selection() { return { anchor: { ...this.anchor }, head: { ...this.head } }; }
  get hasSelection() { return posCmp(this.anchor, this.head) !== 0; }
  get topLine() { return Math.floor(this.top); }
  set topLine(n: number) { this.top = Math.max(0, Math.min(Math.floor(n), this.n - 1)); this.paint(); }
  get classList() { return this.root.classList; }

  setSelection(anchor: DocPos, head: DocPos) { this.goal = null; this.select(this.clamp(anchor), this.clamp(head)); }

  async reveal(pos: DocPos): Promise<void> {
    this.top = this.clampTop(pos.line - this.viewLines() / 3);
    this.paint();
    await this.ensure();
    this.paint();
  }

  insert(text: string, kind: DocKind) {
    if (this.refuse()) return;
    this.act(() => this.edit(posMin(this.anchor, this.head), posMax(this.anchor, this.head), text, kind));
  }
  undo() { return this.history('undo'); }
  redo() { return this.history('redo'); }

  async selectedText(): Promise<string> {
    if (!this.hasSelection) return '';
    return this.src.text(posMin(this.anchor, this.head), posMax(this.anchor, this.head));
  }

  async reset(state: DocState): Promise<void> {
    this.gen++;
    this.cache.clear();
    this.cache.rev = state.rev;
    this.n = Math.max(1, state.lines);
    this.anchor = this.clamp(this.anchor);
    this.head = this.clamp(this.head);
    this.top = this.clampTop(this.top);
    this.paint();
    await this.ensure();
  }

  focus() { this.input.focus({ preventScroll: true }); }
  refresh() {
    const lh = this.opts.lineHeight();
    this.root.style.setProperty('--big-line', lh + 'px');
    const cs = getComputedStyle(this.root);
    this.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    this.painted = [];
    this.paint();
  }
  remove() { this.endDrag(); this.endThumb(); this.resizer.disconnect(); this.root.remove(); }

  /* ---------- editing ---------- */

  private refuse(): boolean {
    if (!this.opts.readOnly) return false;
    this.dispatchEvent(new Event('readonly'));
    return true;
  }

  // Input runs at once unless something holds it (an undo in flight, a fetch the caret's lines wait for): then it
  // queues, in order, and runs when the hold ends, so nothing is computed from a state about to be replaced.
  private run(fn: () => void) { if (this.held) this.queue.push(fn); else fn(); }
  private hold(p: Promise<unknown>) {
    this.held++;
    const done = () => {
      if (--this.held) return;
      const q = this.queue;
      this.queue = [];
      for (const f of q) this.run(f);
    };
    p.then(done, done);
  }
  // An edit needs the caret's line and its neighbours cached (their lengths, a join's column); if they aren't, fetch
  // them first.
  private act(fn: () => void) {
    this.run(() => {
      const l = this.head.line, ok = (k: number) => k < 0 || k >= this.n || !!this.cache.get(k);
      if (ok(l) && ok(l - 1) && ok(l + 1)) { fn(); return; }
      this.queue.push(fn);
      this.revealCaret();
      this.hold(this.ensure());
    });
  }

  // Applied to the cache and painted before the engine hears of it; the reply only reports rev and dirty.
  private edit(start: DocPos, end: DocPos, text: string, kind: DocKind) {
    if (!text && posCmp(start, end) === 0) return;
    this.cache.apply(start, end, text);
    this.n = Math.max(1, this.n + lineDelta(start, end, text));
    const c = posAfterInsert(start, text);
    this.goal = null;
    this.select(c, c, true);
    this.revealCaret();
    const gen = this.gen;
    this.pending++;
    this.src.edit(start, end, text, kind).then(r => {
      this.pending--;
      this.emitChange(r);
      if (gen === this.gen) this.syncCount(r);
    }, e => {
      this.pending--;
      this.fail(e);
      void this.recover();
    });
  }
  // Once nothing is in flight the engine's count and rev are the truth; a mismatch means the cache went wrong.
  private syncCount(r: DocState) {
    if (this.pending || this.historyBusy || (r.lines === this.n && r.rev === this.cache.rev)) return;
    this.n = Math.max(1, r.lines);
    this.cache.rev = r.rev;
    this.cache.clear();
    this.anchor = this.clamp(this.anchor);
    this.head = this.clamp(this.head);
    this.paint();
  }

  private history(which: 'undo' | 'redo'): Promise<void> {
    if (this.refuse() || this.held) return Promise.resolve(); // a second press while one is in flight is dropped
    const p = (async () => {
      this.historyBusy = true;
      try {
        const r = await this.src[which]();
        if (r.none) return;
        this.emitChange(r);
        if (r.caret) { this.anchor = this.head = r.caret; this.goal = null; this.follow(); }
        await this.reset(r);
        this.revealCaret();
        this.dispatchEvent(new Event('selectionchange'));
      } catch (e) {
        this.fail(e);
        await this.recover();
      } finally {
        this.historyBusy = false;
      }
    })();
    this.hold(p);
    return p;
  }

  private emitChange(r: DocState) { this.dispatchEvent(new CustomEvent<DocState>('change', { detail: { rev: r.rev, lines: r.lines, dirty: r.dirty } })); }
  private fail(e: unknown) { this.dispatchEvent(new CustomEvent<string>('error', { detail: e instanceof Error ? e.message : String(e) })); }
  // After a failed call the local copy can't be trusted: start again from what the engine has.
  private async recover() {
    try { await this.reset(await this.src.lines(this.topLine, 1)); } catch { /* the engine is down; its own error says so */ }
  }

  private del(back: boolean) {
    if (this.hasSelection) { this.edit(posMin(this.anchor, this.head), posMax(this.anchor, this.head), '', 'delete'); return; }
    const h = this.head, it = this.cache.get(h.line), t = it?.text ?? '', len = it?.len ?? 0;
    if (back) {
      if (h.col > 0) this.edit({ line: h.line, col: stepLeft(t, h.col) }, h, '', 'delete');
      else if (h.line > 0) { const p = this.cache.get(h.line - 1); if (p) this.edit({ line: h.line - 1, col: p.len }, h, '', 'delete'); }
    } else if (h.col < Math.min(len, BIG_LONG_LINE)) {
      this.edit(h, { line: h.line, col: stepRight(t, h.col) }, '', 'delete');
    } else if (h.col >= len && h.line < this.n - 1) {
      this.edit(h, { line: h.line + 1, col: 0 }, '', 'delete');
    } // on a cut line at BIG_LONG_LINE the next unit is unknown: nothing to delete safely
  }

  private onKey(e: KeyboardEvent) {
    if (e.defaultPrevented || e.isComposing || this.input.classList.contains('composing') || e.altKey) return;
    const ctrl = e.ctrlKey || e.metaKey, k = e.key;
    if (BIG_NAV_KEYS.has(k)) {
      e.preventDefault();
      const mods = { shift: e.shiftKey, ctrl };
      this.run(() => this.move(k, mods));
    } else if (ctrl && (k === 'z' || k === 'Z') && !e.shiftKey) {
      e.preventDefault(); void this.undo();
    } else if (ctrl && ((k === 'y' || k === 'Y') && !e.shiftKey || (k === 'z' || k === 'Z') && e.shiftKey)) {
      e.preventDefault(); void this.redo();
    } else if (ctrl && !e.shiftKey && (k === 'a' || k === 'A')) {
      e.preventDefault(); this.run(() => this.selectAll());
    } else if ((k === 'Backspace' || k === 'Delete') && !ctrl) {
      e.preventDefault();
      if (!this.refuse()) this.act(() => this.del(k === 'Backspace'));
    } else if ((k === 'Enter' || k === 'Tab') && !ctrl && !e.shiftKey) {
      e.preventDefault();
      this.insert(k === 'Enter' ? '\n' : '\t', 'type');
    }
  }

  private move(key: string, mods: BigMods) {
    const lo = posMin(this.anchor, this.head), hi = posMax(this.anchor, this.head);
    if (!mods.shift && this.hasSelection && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      const to = key === 'ArrowLeft' ? lo : hi;
      this.goal = null;
      this.select(to, to);
    } else {
      const vertical = /Up|Down/.test(key), page = Math.max(1, Math.floor(this.viewLines()) - 1);
      const r = bigMove(this.head, key, mods, this.n, page, vertical ? this.goal : null, l => this.editLen(l), l => this.cache.get(l)?.text);
      this.goal = r.goal;
      this.select(mods.shift ? this.anchor : r.head, r.head);
    }
    this.revealCaret(); // a head on an uncached line (End, Ctrl+End) is clamped once its line arrives
  }

  private selectAll() {
    const last = this.n - 1, len = this.editLen(last);
    this.goal = null;
    this.select({ line: 0, col: 0 }, { line: last, col: len ?? BIG_LONG_LINE });
    if (len !== undefined) return;
    // The last line's length is unknown: ask for it, holding input (a copy) until the selection is right.
    const gen = this.gen;
    this.hold(this.src.lines(last, 1).then(r => {
      const it = r.items[0];
      if (gen !== this.gen || !it || this.head.line !== last || this.head.col !== BIG_LONG_LINE) return;
      this.select(this.anchor, { line: last, col: snapCol(it.text, Math.min(it.len, BIG_LONG_LINE)) });
    }, e => this.fail(e)));
  }

  private onCopy(e: ClipboardEvent, cut: boolean) {
    e.preventDefault();
    if (cut && this.refuse()) return;
    this.run(() => {
      if (!this.hasSelection) return;
      // Asked before the cut's edit is sent; the engine answers in order, so this is the text before the cut.
      this.selectedText().then(t => navigator.clipboard.writeText(t)).catch(err => this.fail(err));
      if (cut) this.insert('', 'delete');
    });
  }

  private sizeComposing() {
    this.input.style.width = '0';
    this.input.style.width = this.input.scrollWidth + 2 + 'px';
  }

  /* ---------- selection and positions ---------- */

  private select(anchor: DocPos, head: DocPos, force = false) {
    const changed = force || posCmp(anchor, this.anchor) !== 0 || posCmp(head, this.head) !== 0;
    this.anchor = anchor;
    this.head = head;
    this.paint();
    if (changed) this.dispatchEvent(new Event('selectionchange'));
  }
  // A cached line's editable length: a cut line stops at BIG_LONG_LINE.
  private editLen(line: number): number | undefined {
    const it = this.cache.get(line);
    return it && Math.min(it.len, BIG_LONG_LINE);
  }
  private clamp(p: DocPos): DocPos {
    const line = Math.max(0, Math.min(p.line, this.n - 1)), it = this.cache.get(line);
    let col = Math.max(0, p.col);
    if (it) col = snapCol(it.text, Math.min(col, it.len, BIG_LONG_LINE));
    return { line, col };
  }
  // Columns found before their line arrived (End onto an unknown line, a join past a cut) are fixed once it has.
  private clampSel() {
    const a = this.clamp(this.anchor), h = this.clamp(this.head);
    if (posCmp(a, this.anchor) || posCmp(h, this.head)) this.select(a, h);
  }

  private lineH() { return this.opts.lineHeight(); }
  private viewLines() { return Math.max(1, this.code.clientHeight / this.lineH()); }
  private clampTop(t: number) { return Math.max(0, Math.min(t, this.n - this.viewLines())); }

  // x of a column in a line's text, from the text's left edge. ASCII is charWidth per unit, tabs go to tab stops,
  // anything else is measured.
  private xIn(t: string, col: number): number {
    const cw = this.opts.charWidth(), ts = this.opts.tabSize, pre = t.slice(0, col);
    if (!/[^\x00-\x7f]/.test(pre)) {
      if (pre.indexOf('\t') === -1) return col * cw;
      let v = 0;
      for (let i = 0; i < col; i++) v = pre.charCodeAt(i) === 9 ? v + ts - (v % ts) : v + 1;
      return v * cw;
    }
    const ctx = bigMeasureCtx ??= document.createElement('canvas').getContext('2d')!;
    if (ctx.font !== this.font) ctx.font = this.font;
    const tw = ts * cw;
    let x = 0, s = 0;
    for (let i = pre.indexOf('\t'); i !== -1; i = pre.indexOf('\t', i + 1)) {
      x += ctx.measureText(pre.slice(s, i)).width;
      let stop = (Math.floor(x / tw) + 1) * tw;
      if (stop - x < cw / 2) stop += tw; // as CSS: a tab is never narrower than half a space
      x = stop;
      s = i + 1;
    }
    return x + ctx.measureText(pre.slice(s)).width;
  }
  private xOf(p: DocPos): number {
    const it = this.cache.get(p.line);
    return BIG_PAD + (it ? this.xIn(it.text, p.col) : p.col * this.opts.charWidth());
  }
  // The column nearest x (from the text's left edge), never inside a surrogate pair.
  private colAt(line: number, x: number): number {
    const it = this.cache.get(line);
    if (!it) return 0;
    const t = it.text, max = Math.min(it.len, t.length);
    let lo = 0, hi = max;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.xIn(t, mid) <= x) lo = mid; else hi = mid - 1; }
    let c = lo;
    if (c < max) { const nx = Math.min(stepRight(t, c), max); if (this.xIn(t, nx) - x < x - this.xIn(t, c)) c = nx; }
    return snapCol(t, c);
  }
  private posAt(cx: number, cy: number): DocPos {
    const rect = this.code.getBoundingClientRect();
    const line = Math.max(0, Math.min(Math.floor(this.top + (cy - rect.top) / this.lineH()), this.n - 1));
    return { line, col: this.colAt(line, cx - rect.left + this.code.scrollLeft - BIG_PAD) };
  }

  /* ---------- scrolling and fetching ---------- */

  private setTop(t: number) { this.top = this.clampTop(t); this.paint(); }
  // Just enough vertical scroll to show the head's line.
  private follow() {
    const v = this.viewLines(), l = this.head.line;
    if (l < this.top) this.top = l;
    else if (l + 1 > this.top + v) this.top = this.clampTop(l + 1 - v);
  }
  private revealCaret() {
    this.follow();
    this.paint();
    const c = this.code, x = this.xOf(this.head);
    // At a cut line's end, the "… N more characters" chip comes into view with the caret.
    const more = this.rows[this.head.line - Math.floor(this.top)]?.querySelector<HTMLElement>('.big-more');
    const right = 24 + (more && this.head.col >= BIG_LONG_LINE ? more.offsetWidth + 8 : 0);
    if (x < c.scrollLeft + BIG_PAD) c.scrollLeft = Math.max(0, x - BIG_PAD);
    else if (x + right > c.scrollLeft + c.clientWidth) c.scrollLeft = x + right - c.clientWidth;
  }

  private onWheel(e: WheelEvent) {
    const lh = this.lineH(), unit = e.deltaMode === 1 ? 1 : e.deltaMode === 2 ? this.viewLines() : 1 / lh;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      if (e.shiftKey) { e.preventDefault(); this.code.scrollLeft += e.deltaY * unit * lh; }
      return; // a sideways wheel scrolls .big-code natively
    }
    e.preventDefault();
    this.setTop(this.top + e.deltaY * unit);
  }

  // The window to fetch, or null when the cache already reaches BIG_KEEP lines past the view on both sides.
  private need(): { first: number; count: number } | null {
    const first = Math.floor(this.top), last = Math.min(this.n, Math.ceil(this.top + this.viewLines()));
    if (this.cache.covers(Math.max(0, first - BIG_KEEP), Math.min(this.n, last + BIG_KEEP))) return null;
    const f = Math.max(0, first - BIG_FETCH);
    return { first: f, count: Math.min(this.n, last + BIG_FETCH) - f };
  }
  // One fetch at a time; each round asks for what the view needs now, so a newer need replaces an older one.
  private ensure(): Promise<void> {
    if (!this.fetching && this.need()) this.fetching = this.pump();
    return this.fetching ?? Promise.resolve();
  }
  private async pump() {
    try {
      for (let w = this.need(); w; w = this.need()) {
        const gen = this.gen, r = await this.src.lines(w.first, w.count);
        if (gen !== this.gen) continue;
        const idle = !this.pending && !this.historyBusy;
        // Nothing in flight: this reply reflects every edit, so a rev it lacks means the count went wrong.
        if (!this.cache.put(w.first, r.items, r.rev)) {
          if (!idle) continue; // asked for before a local edit: ask again
          this.cache.rev = r.rev;
          this.cache.put(w.first, r.items, r.rev);
        }
        if (idle && r.lines !== this.n) { this.n = Math.max(1, r.lines); this.top = this.clampTop(this.top); }
        this.clampSel();
        this.paint();
      }
    } catch (e) {
      this.fail(e);
    } finally {
      this.fetching = null;
    }
  }

  /* ---------- painting ---------- */

  private paint() {
    const lh = this.lineH(), cw = this.opts.charWidth(), view = this.viewLines();
    const first = Math.floor(this.top), shift = (first - this.top) * lh;
    const count = Math.ceil(view) + 1;
    // Row pools follow the view's height.
    while (this.rows.length < count) {
      const r = document.createElement('div'), g = document.createElement('div');
      r.className = 'big-line';
      this.linesEl.append(r);
      this.nums.append(g);
      this.rows.push(r); this.numRows.push(g);
    }
    while (this.rows.length > count) { this.rows.pop()!.remove(); this.numRows.pop()!.remove(); }
    this.linesEl.style.top = shift + 'px';
    this.nums.style.top = shift + 'px';
    for (let i = 0; i < count; i++) {
      const line = first + i, item = line < this.n ? this.cache.get(line) : undefined, was = this.painted[i];
      if (was && was.line === line && was.item === item) continue;
      this.painted[i] = { line, item };
      this.numRows[i].textContent = line < this.n ? String(line + 1) : '';
      const row = this.rows[i];
      row.textContent = item ? item.text : '';
      if (item && item.len > item.text.length) {
        const more = document.createElement('span');
        more.className = 'big-more';
        more.textContent = `… ${(item.len - item.text.length).toLocaleString('en-US')} more characters`;
        row.append(more);
      }
    }
    this.gutter.style.width = String(this.n).length * cw + 28 + 'px';
    this.gutter.style.height = this.code.clientHeight + 'px'; // stops above .big-code's horizontal scrollbar
    this.paintSel(first, Math.min(this.n - 1, first + count - 1), lh, cw);
    this.paintSlider(view);
    void this.ensure();
  }

  private paintSel(lo: number, hi: number, lh: number, cw: number) {
    const a = posMin(this.anchor, this.head), b = posMax(this.anchor, this.head), y = (l: number) => (l - this.top) * lh;
    const boxes: HTMLDivElement[] = [];
    for (let l = Math.max(a.line, lo); posCmp(a, b) && l <= Math.min(b.line, hi); l++) {
      const x1 = l === a.line ? this.xOf(a) : BIG_PAD;
      const x2 = l === b.line ? this.xOf(b) : this.xOf({ line: l, col: this.cache.get(l)?.text.length ?? 0 }) + cw;
      if (x2 <= x1) continue;
      const box = document.createElement('div');
      box.className = 'big-sel';
      box.style.cssText = `top:${y(l)}px;left:${x1}px;width:${x2 - x1}px`;
      boxes.push(box);
    }
    this.selLayer.replaceChildren(...boxes);
    const h = this.head, x = this.xOf(h), cy = y(h.line);
    this.caretEl.style.display = h.line >= lo && h.line <= hi ? '' : 'none';
    this.caretEl.style.left = x + 'px';
    this.caretEl.style.top = cy + 'px';
    // The input follows the caret but stays inside the view, so focusing it never scrolls anything.
    this.input.style.left = x + 'px';
    this.input.style.top = Math.max(0, Math.min(cy, this.code.clientHeight - lh)) + 'px';
    const at = x + ',' + cy;
    if (at !== this.caretAt) { this.caretAt = at; for (const an of this.caretEl.getAnimations()) an.currentTime = 0; }
  }

  private thumbGeom(view: number) {
    const track = this.slider.clientHeight, th = Math.min(track, Math.max(24, view / this.n * track));
    return { track, th, range: Math.max(0, this.n - view) };
  }
  private paintSlider(view: number) {
    const { track, th, range } = this.thumbGeom(view);
    this.thumb.style.height = th + 'px';
    this.thumb.style.top = (range ? Math.min(1, this.top / range) * (track - th) : 0) + 'px';
  }

  /* ---------- pointer ---------- */

  // A press off the thumb jumps it there (centred under the pointer), then drags as a press on it would.
  private onThumbDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const view = this.viewLines(), { track, th, range } = this.thumbGeom(view);
    if (e.target !== this.thumb && track > th) {
      const rect = this.slider.getBoundingClientRect();
      this.setTop((e.clientY - rect.top - th / 2) / (track - th) * range);
    }
    this.thumbDrag = { y: e.clientY, top: this.top };
    this.slider.classList.add('drag');
    try { this.slider.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    window.addEventListener('pointermove', this.onThumbMove);
    window.addEventListener('pointerup', this.endThumb);
    window.addEventListener('pointercancel', this.endThumb);
  }
  private onThumbMove = (e: PointerEvent) => {
    const d = this.thumbDrag;
    if (!d) return;
    const { track, th, range } = this.thumbGeom(this.viewLines());
    if (track > th) this.setTop(d.top + (e.clientY - d.y) / (track - th) * range);
  };
  private endThumb = () => {
    if (!this.thumbDrag) return;
    this.thumbDrag = null;
    this.slider.classList.remove('drag');
    window.removeEventListener('pointermove', this.onThumbMove);
    window.removeEventListener('pointerup', this.endThumb);
    window.removeEventListener('pointercancel', this.endThumb);
  };

  private onPointerDown(e: PointerEvent) {
    this.focus();
    if (e.button !== 0) return;
    const rect = this.code.getBoundingClientRect();
    if (e.clientY - rect.top >= this.code.clientHeight) return; // on the horizontal scrollbar
    this.endDrag();
    const p = this.posAt(e.clientX, e.clientY), unit = Math.min(this.clickCount(e), 3) - 1;
    const [a, b] = e.shiftKey ? [this.anchor, this.anchor] : this.unitAt(p, unit);
    this.drag = { unit, a, b, x: e.clientX, y: e.clientY, raf: 0 };
    this.goal = null;
    this.extendTo(p);
    try { this.code.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    window.addEventListener('pointermove', this.onDragMove);
    window.addEventListener('pointerup', this.endDrag);
    window.addEventListener('pointercancel', this.endDrag);
  }
  // As CodeSurface: Chromium leaves pointerdown's detail at 0, so count clicks here when it does.
  private clickCount(e: PointerEvent): number {
    const c = this.clicks, near = Math.abs(e.clientX - c.x) < 5 && Math.abs(e.clientY - c.y) < 5;
    c.n = e.detail || (near && e.timeStamp - c.t < 500 ? c.n + 1 : 1);
    c.t = e.timeStamp; c.x = e.clientX; c.y = e.clientY;
    return c.n;
  }
  // The range a click of the given unit picks: 0 a spot, 1 a word, 2 a whole line with its line break.
  private unitAt(p: DocPos, unit: number): [DocPos, DocPos] {
    if (unit === 1) { const [a, b] = wordAt(this.cache.get(p.line)?.text ?? '', p.col); return [{ line: p.line, col: a }, { line: p.line, col: b }]; }
    if (unit === 2) return [{ line: p.line, col: 0 }, p.line < this.n - 1 ? { line: p.line + 1, col: 0 } : { line: p.line, col: this.editLen(p.line) ?? 0 }];
    return [p, p];
  }
  private extendTo(p: DocPos) {
    const d = this.drag!, [x, y] = this.unitAt(p, d.unit);
    if (posCmp(x, d.a) < 0) this.select(d.b, x);
    else this.select(d.a, posMax(y, d.b));
  }
  private onDragMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    if (!(e.buttons & 1)) { this.endDrag(); return; }
    d.x = e.clientX; d.y = e.clientY;
    if (!d.raf) this.dragStep();
  };
  // Past the top or bottom edge, scroll distance / 4 lines a frame, as CodeSurface does.
  private dragStep = () => {
    const d = this.drag;
    if (!d) return;
    d.raf = 0;
    const rect = this.code.getBoundingClientRect(), bottom = rect.top + this.code.clientHeight;
    const dist = d.y < rect.top ? d.y - rect.top : d.y > bottom ? d.y - bottom : 0;
    if (dist) this.setTop(this.top + dist / 4);
    this.extendTo(this.posAt(Math.max(rect.left, Math.min(d.x, rect.right - 1)), Math.max(rect.top, Math.min(d.y, bottom - 1))));
    if (dist) d.raf = requestAnimationFrame(this.dragStep);
  };
  private endDrag = () => {
    if (!this.drag) return;
    cancelAnimationFrame(this.drag.raf);
    this.drag = null;
    window.removeEventListener('pointermove', this.onDragMove);
    window.removeEventListener('pointerup', this.endDrag);
    window.removeEventListener('pointercancel', this.endDrag);
  };
}
