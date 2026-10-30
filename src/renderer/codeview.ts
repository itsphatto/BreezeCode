/* ================= Code surface: a virtualized, textarea-shaped editor ================= */
// Shared global scope with editcore.ts and the breeze/ files: no imports or exports here.
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
// A drag keeps the range it started on (a click's spot, a word, a line) and extends in the same unit.
interface SurfaceDrag { unit: number; a: number; b: number; x: number; y: number; raf: number }
const SURFACE_NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

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
  private goal: number | null = null; // visual column kept across vertical moves
  private drag: SurfaceDrag | null = null;
  private clicks = { n: 0, t: -1e9, x: 0, y: 0 }; // last pointerdown, for double and triple clicks
  private readonly resizer: ResizeObserver;

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
    this.input.addEventListener('focus', () => {
      this.root.classList.add('focused');
      this.dispatchEvent(new Event('selectionchange')); // so the app redraws its current line
    });
    this.input.addEventListener('blur', () => this.root.classList.remove('focused'));
    this.root.addEventListener('scroll', () => this.paint());
    // Bubble phase on the input itself, so app keydown listeners (capture, see addEventListener) run first.
    this.input.addEventListener('keydown', e => this.onKey(e));
    this.input.addEventListener('input', e => this.onInput(e as InputEvent));
    this.input.addEventListener('compositionstart', () => { this.input.classList.add('composing'); this.sizeComposing(); });
    this.input.addEventListener('compositionend', () => {
      const t = this.input.value;
      this.input.value = '';
      this.input.classList.remove('composing');
      this.input.style.width = '';
      if (t) this.userEdit(this.selStart, this.selEnd, t, 'insertText', t);
    });
    // The app keeps the only history; the hidden input's own undo must not change anything.
    this.input.addEventListener('beforeinput', e => { if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') e.preventDefault(); });
    this.input.addEventListener('copy', e => this.onCopy(e, false));
    this.input.addEventListener('cut', e => this.onCopy(e, true));
    this.input.addEventListener('paste', e => {
      e.preventDefault();
      const t = e.clipboardData?.getData('text/plain').replace(/\r\n?/g, '\n');
      if (t) this.userEdit(this.selStart, this.selEnd, t, 'insertFromPaste');
    });
    this.root.addEventListener('pointerdown', e => this.onPointerDown(e));
    // Block native selection and focus loss on mousedown, not pointerdown: a canceled pointerdown would
    // suppress mousedown, and app mousedown listeners (menu closing, hiding suggestions) must still run.
    // Every button: the root can't take focus, so an uncanceled right or middle press would move it to <body>.
    this.root.addEventListener('mousedown', e => e.preventDefault());
    // Panel resizes change which lines are visible; repaint so no strip is left without selection or caret.
    this.resizer = new ResizeObserver(() => this.paint());
    this.resizer.observe(this.root);
    this.sizeSpacer();
    this.paint();
  }

  get value() { return this.text; }
  set value(v: string) {
    this.text = v;
    this.starts = null;
    this.goal = null;
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
    this.goal = null; // only vertical moves keep it, and they set it again after this
    this.paint();
    if (changed) this.dispatchEvent(new Event('selectionchange'));
  }

  // Textarea semantics for the selection afterwards (see HTMLTextAreaElement.setRangeText); fires no 'input'.
  setRangeText(text: string, start: number, end: number, mode: 'select' | 'start' | 'end' | 'preserve' = 'preserve') {
    if (start > end) throw new DOMException('start is after end', 'IndexSizeError');
    const len = this.text.length;
    start = Math.min(start, len); end = Math.min(end, len);
    this.text = this.text.slice(0, start) + text + this.text.slice(end);
    this.starts = this.starts && shiftLineStarts(this.starts, start, end, text);
    if (this.starts) rememberLineStarts(this.text, this.starts);
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
  remove() { clearTimeout(this.widthTimer); this.endDrag(); this.resizer.disconnect(); this.root.remove(); }

  // After a font or metric change: re-size the spacer for the new char width and repaint.
  refresh() { this.sizeSpacer(); this.paint(); }

  // Replace the selection as if the user typed `text`.
  insertText(text: string) { this.userEdit(this.selStart, this.selEnd, text, 'insertText', text); }

  // Every user edit: a cancelable 'beforeinput' (the app records history there), the change, then 'input'.
  private userEdit(start: number, end: number, text: string, inputType: string, data: string | null = null) {
    if (!this.dispatchEvent(new InputEvent('beforeinput', { inputType, data, cancelable: true }))) return;
    this.setRangeText(text, start, end, 'end');
    this.revealCaret();
    this.dispatchEvent(new InputEvent('input', { inputType, data }));
  }

  private onInput(e: InputEvent) {
    if (e.isComposing || this.input.classList.contains('composing')) { this.sizeComposing(); return; }
    const t = this.input.value;
    this.input.value = '';
    if (t) this.userEdit(this.selStart, this.selEnd, t, 'insertText', t);
  }
  // A textarea's auto width comes from cols, so the visible IME box is sized to its text, measured
  // rather than counted, since full-width (CJK) characters are wider than charWidth.
  private sizeComposing() {
    this.input.style.width = '0';
    this.input.style.width = this.input.scrollWidth + 2 + 'px';
  }

  private onCopy(e: ClipboardEvent, cut: boolean) {
    if (this.selStart === this.selEnd || !e.clipboardData) return; // nothing selected: copy nothing
    e.clipboardData.setData('text/plain', this.text.slice(this.selStart, this.selEnd));
    e.preventDefault();
    if (cut) this.userEdit(this.selStart, this.selEnd, '', 'deleteByCut');
  }

  private anchor() { return this.selDir === 'backward' ? this.selEnd : this.selStart; }
  private head() { return this.selDir === 'backward' ? this.selStart : this.selEnd; }
  private select(anchor: number, head: number) {
    if (head < anchor) this.setSelectionRange(head, anchor, 'backward');
    else this.setSelectionRange(anchor, head, head > anchor ? 'forward' : 'none');
  }

  // Enter and Tab are the app's (editorKeys, capture phase); they only reach here when it left them alone.
  private onKey(e: KeyboardEvent) {
    if (e.defaultPrevented || e.isComposing || this.input.classList.contains('composing') || e.altKey) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (SURFACE_NAV_KEYS.has(e.key)) {
      e.preventDefault();
      const page = Math.max(1, Math.floor(this.root.clientHeight / this.opts.lineHeight) - 1);
      const vertical = /Up|Down/.test(e.key);
      const r = moveCaret(this.text, this.lines(), { anchor: this.anchor(), head: this.head() }, e.key as NavKey,
        { shift: e.shiftKey, ctrl }, page, vertical ? this.goal : null);
      this.select(r.sel.anchor, r.sel.head);
      this.goal = r.goal;
      this.revealCaret();
    } else if (e.key === 'Delete' && e.shiftKey && !ctrl && this.selStart !== this.selEnd) {
      // Shift+Delete cuts, as in a Windows textarea. The cut command fires 'cut' (onCopy writes the clipboard and
      // deletes); when the page may not run it (no user activation), cut by hand.
      e.preventDefault();
      if (!document.execCommand('cut')) {
        void navigator.clipboard?.writeText(this.text.slice(this.selStart, this.selEnd)).catch(() => {});
        this.userEdit(this.selStart, this.selEnd, '', 'deleteByCut');
      }
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      const [a, b] = deleteSpan(this.text, { anchor: this.anchor(), head: this.head() }, e.key, ctrl);
      const back = e.key === 'Backspace';
      if (a !== b) this.userEdit(a, b, '', ctrl ? (back ? 'deleteWordBackward' : 'deleteWordForward') : (back ? 'deleteContentBackward' : 'deleteContentForward'));
    } else if ((e.key === 'Enter' && !ctrl) || (e.key === 'Tab' && !ctrl && !e.shiftKey)) {
      e.preventDefault();
      this.insertText(e.key === 'Enter' ? '\n' : '\t');
    } else if (ctrl && !e.shiftKey && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      this.setSelectionRange(0, this.text.length);
    }
  }

  // Scroll just enough to show the caret (and the line it sits on).
  private revealCaret() {
    const { lineHeight: lh, pad } = this.opts, starts = this.lines(), head = this.head();
    const line = lineOfOffset(starts, head), y = pad.top + line * lh, x = this.xOf(line, head - starts[line]);
    const r = this.root;
    if (y < r.scrollTop) r.scrollTop = Math.max(0, y - pad.top);
    else if (y + lh > r.scrollTop + r.clientHeight) r.scrollTop = y + lh + pad.bottom - r.clientHeight;
    if (x < r.scrollLeft + pad.left) r.scrollLeft = Math.max(0, x - pad.left);
    else if (x + 2 > r.scrollLeft + r.clientWidth) r.scrollLeft = x + 2 + pad.right - r.clientWidth;
    this.paint(); // the scroll event comes later; paint the new spot now
  }

  // The text offset under a client point: above the first line is 0, below the last is the end.
  offsetAt(cx: number, cy: number): number {
    const { lineHeight: lh, pad } = this.opts, starts = this.lines(), rect = this.root.getBoundingClientRect();
    const x = cx - rect.left + this.root.scrollLeft, y = cy - rect.top + this.root.scrollTop;
    const line = Math.floor((y - pad.top) / lh);
    if (line < 0) return 0;
    if (line >= starts.length) return this.text.length;
    const col = this.opts.colAt?.(line, x) ?? colAtVisual(this.lineText(line), Math.round((x - pad.left) / this.opts.charWidth()));
    return starts[line] + col;
  }
  // The range a click of the given unit picks: 0 a spot, 1 a word, 2 a whole line with its newline.
  private unitAt(off: number, unit: number): [number, number] {
    if (unit === 1) { // past a line's end: its last word (an empty line keeps its own newline)
      const t = this.text;
      return wordAt(t, t[off] === '\n' && off > 0 && t[off - 1] !== '\n' ? off - 1 : off);
    }
    if (unit === 2) {
      const starts = this.lines(), l = lineOfOffset(starts, off);
      return [starts[l], l + 1 < starts.length ? starts[l + 1] : this.text.length];
    }
    return [off, off];
  }
  private extendTo(off: number) {
    const d = this.drag!, [x, y] = this.unitAt(off, d.unit);
    if (x < d.a) this.select(d.b, x);
    else this.select(d.a, Math.max(y, d.b));
  }

  private onPointerDown(e: PointerEvent) {
    if (e.button !== 0) { this.focus({ preventScroll: true }); return; } // keeps the caret and selection
    const rect = this.root.getBoundingClientRect();
    if (e.clientX - rect.left >= this.root.clientWidth || e.clientY - rect.top >= this.root.clientHeight) return; // on a scrollbar
    this.focus({ preventScroll: true });
    this.endDrag();
    const off = this.offsetAt(e.clientX, e.clientY), unit = Math.min(this.clickCount(e), 3) - 1;
    const [a, b] = e.shiftKey ? [this.anchor(), this.anchor()] : this.unitAt(off, unit);
    this.drag = { unit, a, b, x: e.clientX, y: e.clientY, raf: 0 };
    this.extendTo(off);
    try { this.root.setPointerCapture(e.pointerId); } catch { /* synthetic or already-gone pointer */ }
    window.addEventListener('pointermove', this.onDragMove);
    window.addEventListener('pointerup', this.endDrag);
    window.addEventListener('pointercancel', this.endDrag);
  }
  // Chromium leaves pointerdown's detail at 0 (and the canceled pointerdown suppresses mousedown), so count clicks here when it does.
  private clickCount(e: PointerEvent): number {
    const c = this.clicks, near = Math.abs(e.clientX - c.x) < 5 && Math.abs(e.clientY - c.y) < 5;
    c.n = e.detail || (near && e.timeStamp - c.t < 500 ? c.n + 1 : 1);
    c.t = e.timeStamp; c.x = e.clientX; c.y = e.clientY;
    return c.n;
  }
  private onDragMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    if (!(e.buttons & 1)) { this.endDrag(); return; }
    d.x = e.clientX; d.y = e.clientY;
    if (!d.raf) this.dragStep(); // while auto-scrolling, the next frame picks up the new spot
  };
  // Extend to the pointer, clamped to the viewport; outside it vertically, scroll by distance / 4 lines a frame.
  private dragStep = () => {
    const d = this.drag;
    if (!d) return;
    d.raf = 0;
    const rect = this.root.getBoundingClientRect();
    const dist = d.y < rect.top ? d.y - rect.top : d.y > rect.bottom ? d.y - rect.bottom : 0;
    if (dist) this.root.scrollTop += (dist / 4) * this.opts.lineHeight;
    this.extendTo(this.offsetAt(d.x, Math.max(rect.top, Math.min(d.y, rect.bottom - 1))));
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
    return this.starts ??= lineStartsOf(this.text);
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
