/* ================= Color swatches and picker ================= */
// Every hex colour in a file (#rgb, #rgba, #rrggbb, #rrggbbaa) gets a small box of its colour. The box is drawn in the
// overlay layer (renderCode's hlBoxes), not in the text, so the char grid and the caret never shift: it sits in the
// space before the '#' when there is one, otherwise just after the end of the line. Clicking it opens a picker whose
// changes are written back into the file as one undoable edit per change.

const HEX_RE = /#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const CSS_FILE = /\.(css|scss|sass|less|styl|pcss)$/i;
const SWATCH_MAX_LINE = 2000; // longer lines (minified files) get no swatches

interface HexHit { start: number; end: number; hex: string; }

// The hex colours on one line, with offsets into the line. Skips what only looks like a colour: an id selector in CSS
// (`#fade {`), a private field (`this.#abc`), an HTML entity (`&#123;`), and outside stylesheets an issue number (`#123`).
function hexesOnLine(line: string, cssFile: boolean): HexHit[] {
  if (line.length > SWATCH_MAX_LINE || !line.includes('#')) return [];
  const out: HexHit[] = [];
  HEX_RE.lastIndex = 0;
  for (let m = HEX_RE.exec(line); m; m = HEX_RE.exec(line)) {
    const at = m.index, prev = line[at - 1] ?? '';
    if (/[\w&.$#\\]/.test(prev)) continue;
    const body = m[1];
    if (!cssFile && body.length <= 4 && /^\d+$/.test(body)) continue;
    if (cssFile) {
      // A selector: a '{' follows on the line before any ';' or ':' that would make this a value.
      const rest = line.slice(at + m[0].length);
      const brace = rest.indexOf('{'), stop = rest.search(/[;:]/);
      if (brace >= 0 && (stop < 0 || brace < stop) && !line.slice(0, at).includes(':')) continue;
    }
    out.push({ start: at, end: at + m[0].length, hex: m[0] });
  }
  return out;
}

// The box is drawn inline, in its own space just before the '#', like a code editor's colour decorator. That shifts the
// rest of the line, so lines with boxes are placed by measuring the drawn line (lineMeasurer in editor.ts), and the
// overlay boxes (find hits, squiggles, tag pairs) add the boxes' width through codeX.
let swatchCss = false; // the active file is a stylesheet (set by renderCode)
let swatchW = 0;       // px one box adds to its line, margins included (measured from a drawn box)

// The drawn line's html with an empty box element before each colour's '#'. `html` is lineHtmlOf's: tags count as no
// text and an entity (&amp; &lt; ...) as one char, so the boxes land at text columns.
function withSwatches(html: string, lt: string): string {
  const hits = hexesOnLine(lt, swatchCss);
  if (!hits.length) return html;
  let out = '', col = 0, k = 0, i = 0;
  while (i < html.length && k < hits.length) {
    if (html[i] === '<') { const j = html.indexOf('>', i) + 1; out += html.slice(i, j); i = j; continue; }
    if (col === hits[k].start) { out += `<span class="color-swatch" data-col="${hits[k].start}" data-sw="${hits[k].hex}"></span>`; k++; continue; }
    const j = html[i] === '&' ? html.indexOf(';', i) + 1 : i + 1;
    out += html.slice(i, j); i = j; col++;
  }
  return out + html.slice(i);
}
// Colours the drawn boxes (a style attribute would be refused by the page's CSP) and measures one box's width.
function paintSwatches(lines: HTMLElement): void {
  const all = lines.querySelectorAll<HTMLElement>('.color-swatch');
  for (const s of all) if (s.style.getPropertyValue('--sw') !== s.dataset.sw) s.style.setProperty('--sw', s.dataset.sw ?? '');
  const one = all[0];
  if (one) {
    const cs = getComputedStyle(one);
    swatchW = one.getBoundingClientRect().width + parseFloat(cs.marginLeft) + parseFloat(cs.marginRight);
  }
}
// x of a column on a drawn line of the active file: the char grid plus the boxes at or before it.
function codeX(lt: string, col: number, cw: number): number {
  let x = visualCol(lt, col) * cw;
  if (swatchW && lt.includes('#')) for (const h of hexesOnLine(lt, swatchCss)) if (h.start <= col) x += swatchW;
  return x;
}

/* ----- Colour maths ----- */
type Rgba = { r: number; g: number; b: number; a: number };
type Hsva = { h: number; s: number; v: number; a: number };
function parseHex(hex: string): Rgba | null {
  let h = hex.replace(/^#/, '');
  if (h.length === 3 || h.length === 4) h = [...h].map(c => c + c).join('');
  if (h.length !== 6 && h.length !== 8) return null;
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}
function rgbToHsv({ r, g, b, a }: Rgba): Hsva {
  const R = r / 255, G = g / 255, B = b / 255, max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  let h = 0;
  if (d) h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max, a };
}
function hsvToRgb({ h, s, v, a }: Hsva): Rgba {
  const f = (n: number) => { const k = (n + h / 60) % 6; return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255); };
  return { r: f(5), g: f(3), b: f(1), a };
}
// Back to hex in the original's style: its case, its short form when the colour still fits one, alpha only if it had
// alpha or now isn't opaque.
function toHex(c: Rgba, like: string): string {
  const two = (n: number) => n.toString(16).padStart(2, '0');
  const withAlpha = like.length === 5 || like.length === 9 || c.a < 1;
  let parts = [two(c.r), two(c.g), two(c.b)];
  if (withAlpha) parts.push(two(Math.round(c.a * 255)));
  const short = (like.length === 4 || like.length === 5) && parts.every(p => p[0] === p[1]);
  let out = '#' + (short ? parts.map(p => p[0]) : parts).join('');
  if (like.slice(1) === like.slice(1).toUpperCase() && /[A-F]/.test(like)) out = out.toUpperCase();
  return out;
}

/* ----- The picker ----- */
// One picker for every place that edits a hex colour: the editor's swatches and Settings → Appearance. What it edits is
// behind `PickerIo`: `live` gets each new colour while it is dragged (false: the thing it edits is gone, so it closes),
// `commit` runs on release, `leave` when Enter or Escape hands focus back, and `alpha: false` leaves the opacity bar out.
interface PickerIo { live(next: string): boolean; commit(): void; leave?(): void; alpha?: boolean }
let pickerEl: HTMLElement | null = null;
let pickerCommit: (() => void) | null = null;
let pickerLeave: (() => void) | null = null;
function closeColorPicker(): void {
  const commit = pickerCommit;
  pickerCommit = null;
  pickerLeave = null;
  commit?.();
  pickerEl?.remove();
  pickerEl = null;
}
function showColorPicker(orig: string, anchor: DOMRect, io: PickerIo): void {
  closeColorPicker();
  let shown = orig; // what's drawn now, ahead of the committed colour while dragging
  const start = parseHex(orig);
  if (!start) return;
  let hsv = rgbToHsv(start);
  const withAlpha = io.alpha !== false;
  const el = document.createElement('div');
  el.className = 'color-picker';
  el.innerHTML = `<div class="cp-sv"><div class="cp-sv-knob"></div></div>
    <div class="cp-row"><div class="cp-preview"></div><div class="cp-sliders">
      <div class="cp-hue"><div class="cp-knob"></div></div>
      ${withAlpha ? '<div class="cp-alpha"><div class="cp-alpha-fill"></div><div class="cp-knob"></div></div>' : ''}
    </div></div>
    <input class="input cp-hex" spellcheck="false" aria-label="Hex colour">`;
  document.body.append(el);
  pickerEl = el;
  pickerLeave = io.leave ?? null;
  const sv = $('.cp-sv', el), hue = $('.cp-hue', el), alpha = el.querySelector<HTMLElement>('.cp-alpha'), hexIn = $<HTMLInputElement>('.cp-hex', el);

  const paint = () => {
    const rgb = hsvToRgb(hsv), full = hsvToRgb({ ...hsv, s: 1, v: 1, a: 1 });
    sv.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, rgb(${full.r},${full.g},${full.b}))`;
    $('.cp-sv-knob', el).style.left = `${hsv.s * 100}%`;
    $('.cp-sv-knob', el).style.top = `${(1 - hsv.v) * 100}%`;
    $('.cp-knob', hue).style.left = `${hsv.h / 360 * 100}%`;
    if (alpha) {
      $('.cp-knob', alpha).style.left = `${hsv.a * 100}%`;
      $('.cp-alpha-fill', el).style.background = `linear-gradient(to right, transparent, rgb(${rgb.r},${rgb.g},${rgb.b}))`;
    }
    $('.cp-preview', el).style.setProperty('--sw', `rgba(${rgb.r},${rgb.g},${rgb.b},${rgb.a})`);
    if (document.activeElement !== hexIn) hexIn.value = shown;
  };
  // While dragging: the colour is handed over as it changes; the owner decides what that costs (the editor changes the
  // text on screen only: no undo step, save, lint or language-server update).
  const write = () => {
    const next = toHex(hsvToRgb(hsv), orig);
    if (next === shown) return;
    if (!io.live(next)) { closeColorPicker(); return; }
    shown = next;
  };
  pickerCommit = io.commit;
  const drag = (area: HTMLElement, set: (fx: number, fy: number) => void) => {
    area.addEventListener('pointerdown', e => {
      e.preventDefault();
      area.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const r = area.getBoundingClientRect();
        set(clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1));
        write(); paint();
      };
      move(e);
      area.onpointermove = move;
      area.onpointerup = area.onpointercancel = () => {
        area.onpointermove = null; area.onpointerup = area.onpointercancel = null;
        io.commit(); hexIn.value = shown;
      };
    });
  };
  drag(sv, (x, y) => { hsv.s = x; hsv.v = 1 - y; });
  drag(hue, x => { hsv.h = x * 360; });
  if (alpha) drag(alpha, x => { hsv.a = Math.round(x * 100) / 100; });
  hexIn.oninput = () => {
    const v = hexIn.value.trim(), c = parseHex(v.startsWith('#') ? v : '#' + v);
    if (!c || !/^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return;
    hsv = rgbToHsv(withAlpha ? c : { ...c, a: 1 });
    write(); paint();
  };
  hexIn.onblur = () => io.commit();
  hexIn.onkeydown = e => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); const leave = pickerLeave; closeColorPicker(); leave?.(); } };

  // Under the swatch, flipped above it (and kept inside the window) when there's no room.
  const w = 220, h = el.offsetHeight || 240;
  let x = anchor.left - 8, y = anchor.bottom + 6;
  if (y + h > innerHeight - 8) y = anchor.top - h - 6;
  el.style.left = `${clamp(x, 8, innerWidth - w - 8)}px`;
  el.style.top = `${clamp(y, 8, innerHeight - h - 8)}px`;
  paint();
}
// The editor's swatches: the colour is the text at [off, off + len) of the buffer.
function openColorPicker(b: EditorBuffer & { ta: CodeSurface }, off: number, len: number, anchor: DOMRect): void {
  // `committed`: the colour as the file's history has it; `shown`: what's in the text now, ahead of it while dragging.
  const orig = b.text.slice(off, off + len);
  let committed = orig, shown = orig;
  showColorPicker(orig, anchor, {
    live(next) {
      if (b.text.slice(off, off + shown.length) !== shown) return false; // the file changed under it
      const before = b.text;
      b.ta.setRangeText(next, off, off + shown.length, 'preserve');
      b.text = b.ta.value;
      docSync(b, before, b.text);
      shown = next;
      queueRender();
      return true;
    },
    // On release: the change goes into the file as one edit (one undo step, one save), from the colour it started at.
    commit() {
      if (shown === committed || b.text.slice(off, off + shown.length) !== shown) return;
      const final = shown;
      const before = b.text;
      b.ta.setRangeText(committed, off, off + final.length, 'preserve');
      b.text = b.ta.value;
      docSync(b, before, b.text); // replaceRange below then makes the change through the surface's input handler
      const caret = b.ta.selectionStart;
      replaceRange(b.ta, off, off + committed.length, final, caret, caret);
      committed = shown = final;
    },
    leave: () => b.ta.focus(),
  });
}
// Clicks outside, Escape, or switching files close it.
document.addEventListener('pointerdown', e => {
  const t = e.target as Element;
  if (pickerEl && !pickerEl.contains(t) && !t.closest?.('#editor .code')) closeColorPicker(); // the code area decides below
}, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && pickerEl) { e.stopPropagation(); const leave = pickerLeave; closeColorPicker(); leave?.(); } }, true);

// The swatches sit under the editing surface (which takes the pointer), so a press is matched to one by position.
{
  const area = $('#editor .code');
  const swatchAt = (e: MouseEvent) => [...document.querySelectorAll<HTMLElement>('#editor .color-swatch')].find(s => {
    const r = s.getBoundingClientRect();
    return e.clientX >= r.left - 1 && e.clientX <= r.right + 1 && e.clientY >= r.top - 1 && e.clientY <= r.bottom + 1;
  });
  area.addEventListener('mousemove', e => area.classList.toggle('over-swatch', !!swatchAt(e)));
  area.addEventListener('mouseleave', () => area.classList.remove('over-swatch'));
  area.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const sw = swatchAt(e), b = activeText();
    if (!sw || !b) { closeColorPicker(); return; }
    e.preventDefault(); e.stopPropagation();
    // The box's line is its drawn row's place in the window.
    const row = sw.closest('.ln'), ln = winFirst + [...hlLines.children].indexOf(row as Element);
    const starts = lineStartsOf(b.text);
    if (!row || ln >= starts.length) return;
    const off = starts[ln] + Number(sw.dataset.col), len = (sw.dataset.sw ?? '').length;
    const open = pickerEl?.dataset.off === String(off);
    closeColorPicker();
    if (open) return; // a second click on the same box closes it
    openColorPicker(b, off, len, sw.getBoundingClientRect());
    if (pickerEl) pickerEl.dataset.off = String(off);
  }, true);
}
