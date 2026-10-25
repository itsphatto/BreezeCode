/* ================= Code surface: a virtualized, textarea-shaped editor ================= */
// Shared global scope with editcore.ts and breezescript.ts: no imports or exports here.
// A full-file <textarea> re-lays out every line per keystroke; this keeps a 1px input for focus and IME
// and paints only the caret and selection boxes near the viewport.
interface SurfaceOpts {
  lineHeight: number;
  charWidth: () => number;
  pad: { top: number; left: number; right: number; bottom: number };
  label: string;
  xAt?: (line: number, col: number) => number | null;
  colAt?: (line: number, x: number) => number | null;
}
type SelDir = 'forward' | 'backward' | 'none';

class CodeSurface extends EventTarget {
  readonly root: HTMLDivElement;
  readonly input: HTMLTextAreaElement;
  private readonly opts: SurfaceOpts;
  private readonly spacer: HTMLDivElement;
  private readonly selLayer: HTMLDivElement;
  private readonly caret: HTMLDivElement;
  private text = '';
  private starts: number[] | null = [0];
  private selStart = 0;
  private selEnd = 0;
  private selDir: SelDir = 'none';
  private widest = 0;           // longest line, in visual columns
  private widthTimer = 0;
  private caretAt = '';         // last painted caret spot, to restart the blink only on moves

  constructor(host: HTMLElement, opts: SurfaceOpts) {
    super();
    this.opts = opts;
    this.root = document.createElement('div');
    this.root.className = 'code-scroll';
    this.spacer = document.createElement('div');
    this.spacer.className = 'code-spacer';
    this.selLayer = document.createElement('div');
    this.selLayer.style.cssText = 'position:absolute;left:0;top:0';
    this.caret = document.createElement('div');
    this.caret.className = 'code-caret';
    this.input = document.createElement('textarea');
    this.input.className = 'ta code-input';
    this.input.setAttribute('aria-label', opts.label);
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.input.setAttribute('autocapitalize', 'off');
    this.input.wrap = 'off';
    this.root.append(this.spacer, this.selLayer, this.caret, this.input);
    host.append(this.root);
    this.input.addEventListener('focus', () => this.root.classList.add('focused'));
    this.input.addEventListener('blur', () => this.root.classList.remove('focused'));
    this.root.addEventListener('scroll', () => this.paint());
    this.sizeSpacer();
    this.paint();
  }

  get value() { return this.text; }
  set value(v: string) {
    this.text = v;
    this.starts = null;
    clearTimeout(this.widthTimer);
    this.widest = this.measureWidest();
    this.clampSel();
    this.sizeSpacer();
    this.paint();
  }

  get selectionStart() { return this.selStart; }
  get selectionEnd() { return this.selEnd; }
  get selectionDirection() { return this.selDir; }

  // Textarea semantics: clamped to the text, and an end before the start collapses onto the end.
  setSelectionRange(start: number, end: number, dir: SelDir = 'none') {
    const len = this.text.length;
    end = Math.max(0, Math.min(end, len));
    start = Math.max(0, Math.min(start, end));
    const changed = start !== this.selStart || end !== this.selEnd || dir !== this.selDir;
    this.selStart = start; this.selEnd = end; this.selDir = dir;
    this.paint();
    if (changed) this.dispatchEvent(new Event('selectionchange'));
  }

  // Textarea semantics for the selection afterwards (see HTMLTextAreaElement.setRangeText); fires no 'input'.
  setRangeText(text: string, start: number, end: number, mode: 'select' | 'start' | 'end' | 'preserve' = 'preserve') {
    if (start > end) throw new DOMException('start is after end', 'IndexSizeError');
    const len = this.text.length;
    start = Math.min(start, len); end = Math.min(end, len);
    this.text = this.text.slice(0, start) + text + this.text.slice(end);
    this.starts = null;
    const newEnd = start + text.length, delta = text.length - (end - start);
    let a = this.selStart, b = this.selEnd;
    if (mode === 'select') { a = start; b = newEnd; }
    else if (mode === 'start') a = b = start;
    else if (mode === 'end') a = b = newEnd;
    else {
      a = a > end ? a + delta : a > start ? start : a;
      b = b > end ? b + delta : b > start ? newEnd : b;
    }
    this.growWidth(start, newEnd);
    this.sizeSpacer();
    this.setSelectionRange(a, b, this.selDir);
  }

  get scrollTop() { return this.root.scrollTop; }
  set scrollTop(v: number) { this.root.scrollTop = v; this.paint(); }
  get scrollLeft() { return this.root.scrollLeft; }
  set scrollLeft(v: number) { this.root.scrollLeft = v; this.paint(); }
  get clientHeight() { return this.root.clientHeight; }
  get clientWidth() { return this.root.clientWidth; }
  get scrollHeight() { return this.root.scrollHeight; }
  get classList() { return this.root.classList; }

  focus(opts?: FocusOptions) { this.input.focus(opts); }
  blur() { this.input.blur(); }
  getBoundingClientRect() { return this.root.getBoundingClientRect(); }
  remove() { clearTimeout(this.widthTimer); this.root.remove(); }

  // After a font or metric change: re-size the spacer for the new char width and repaint.
  refresh() { this.sizeSpacer(); this.paint(); }

  // DOM events go to the element that really fires them; keydown in capture so app handlers beat the surface's own.
  addEventListener(type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) {
    const to = this.routeOf(type);
    if (!to) super.addEventListener(type, fn, opts);
    else to.addEventListener(type, fn, type === 'keydown' ? withCapture(opts) : opts);
  }
  removeEventListener(type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions) {
    const to = this.routeOf(type);
    if (!to) super.removeEventListener(type, fn, opts);
    else to.removeEventListener(type, fn, type === 'keydown' ? withCapture(opts) : opts);
  }
  private routeOf(type: string): EventTarget | null {
    if (type === 'keydown' || type === 'focus' || type === 'blur') return this.input;
    if (type === 'mousedown' || type === 'scroll') return this.root;
    return null;
  }

  private lines(): number[] {
    return this.starts ??= lineStarts(this.text);
  }
  private lineText(line: number): string {
    const s = this.lines()[line];
    return this.text.slice(s, lineEnd(this.text, s));
  }
  private xOf(line: number, col: number): number {
    return this.opts.xAt?.(line, col) ?? this.opts.pad.left + visualCol(this.lineText(line), col) * this.opts.charWidth();
  }

  private clampSel() {
    const len = this.text.length;
    this.selEnd = Math.min(this.selEnd, len);
    this.selStart = Math.min(this.selStart, this.selEnd);
  }

  private measureWidest(): number {
    let w = 0;
    for (const s of this.lines()) {
      const t = this.text.slice(s, lineEnd(this.text, s));
      w = Math.max(w, visualCol(t, t.length));
    }
    return w;
  }
  // An edit can only widen the lines it touched; shrinking waits for a full pass once typing pauses.
  private growWidth(from: number, to: number) {
    for (let s = lineStart(this.text, from); s <= to; ) {
      const e = lineEnd(this.text, s), t = this.text.slice(s, e);
      this.widest = Math.max(this.widest, visualCol(t, t.length));
      s = e + 1;
    }
    clearTimeout(this.widthTimer);
    this.widthTimer = window.setTimeout(() => { this.widest = this.measureWidest(); this.sizeSpacer(); }, 150);
  }
  private sizeSpacer() {
    const { lineHeight, pad } = this.opts;
    this.spacer.style.height = this.lines().length * lineHeight + pad.top + pad.bottom + 'px';
    this.spacer.style.width = this.widest * this.opts.charWidth() + pad.left + pad.right + 'px';
  }

  // Paint selection boxes and the caret for the visible lines plus a 5-line margin; the input follows the caret always.
  private paint() {
    const { lineHeight: lh, pad } = this.opts, starts = this.lines(), cw = this.opts.charWidth();
    const top = this.root.scrollTop;
    const lo = Math.max(0, Math.floor((top - pad.top) / lh) - 5);
    const hi = Math.min(starts.length - 1, Math.floor((top + this.root.clientHeight - pad.top) / lh) + 5);
    const boxes: HTMLDivElement[] = [];
    if (this.selStart !== this.selEnd) {
      const la = lineOfOffset(starts, this.selStart), lb = lineOfOffset(starts, this.selEnd);
      for (let l = Math.max(la, lo); l <= Math.min(lb, hi); l++) {
        const x1 = this.xOf(l, l === la ? this.selStart - starts[l] : 0);
        const x2 = l === lb ? this.xOf(l, this.selEnd - starts[l]) : this.xOf(l, this.lineText(l).length) + cw;
        if (x2 <= x1) continue;
        const box = document.createElement('div');
        box.className = 'code-sel';
        box.style.cssText = `top:${pad.top + l * lh}px;left:${x1}px;width:${x2 - x1}px`;
        boxes.push(box);
      }
    }
    this.selLayer.replaceChildren(...boxes);
    const head = this.selDir === 'backward' ? this.selStart : this.selEnd;
    const line = lineOfOffset(starts, head), x = this.xOf(line, head - starts[line]), y = pad.top + line * lh;
    this.input.style.left = x + 'px';
    this.input.style.top = y + 'px';
    this.caret.style.display = line >= lo && line <= hi ? '' : 'none';
    this.caret.style.left = x + 'px';
    this.caret.style.top = y + 'px';
    const at = x + ',' + y;
    if (at !== this.caretAt) {
      this.caretAt = at;
      for (const a of this.caret.getAnimations()) a.currentTime = 0;
    }
  }
}

function withCapture(opts?: boolean | AddEventListenerOptions | EventListenerOptions): boolean | AddEventListenerOptions {
  return typeof opts === 'object' ? { ...opts, capture: true } : true;
}
