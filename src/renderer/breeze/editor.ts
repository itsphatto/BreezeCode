/* ================= Code editor ================= */
const LINE_H = 21;
const INDENT = '  ';

const hlInner = document.createElement('div');
$('#hl').appendChild(hlInner);
hlInner.style.position = 'relative';
const hlLines = document.createElement('div');   // the rendered window of lines
hlLines.style.position = 'relative';
const hlBoxes = document.createElement('div');   // find hits, squiggles, tag pairs
hlInner.append(hlLines, hlBoxes);
const gutInner = document.createElement('div');
$('#gutter').appendChild(gutInner);
const gutLines = document.createElement('div');
gutLines.style.position = 'relative';
gutInner.append(gutLines);

let charW = 0; //variable
let curLine = -1;//variable
let renderQueued = false;//variable

const activeBuf = (): EditorBuffer | undefined => (active ? buffers.get(active) : undefined);
function activeText(): (EditorBuffer & { ta: CodeSurface }) | undefined {
  const b = activeBuf();
  return b?.kind === 'text' && b.ta ? b as EditorBuffer & { ta: CodeSurface } : undefined;
}
function measureChar(): number {
  if (charW) return charW;
  const s = document.createElement('span');
  s.textContent = 'x'.repeat(1000);
  s.style.visibility = 'hidden';
  hlInner.appendChild(s);
  // offsetWidth is the laid-out width: a scale animation around the editor (the IDE zooming in as a folder opens)
  // would shrink getBoundingClientRect's, and that wrong width would stay cached. 1000 chars keep its whole-pixel
  // rounding under 0.001px a char.
  const w = s.offsetWidth / 1000;
  s.remove();
  // Hidden (#ide not shown yet) measures 0, and before the code font loads it measures the fallback font:
  // use either for now, but measure again next time.
  if (w > 0 && (!document.fonts || document.fonts.check('12px "Google Sans Code"') || document.fonts.status === 'loaded')) charW = w;
  return w || 7.8;
}
void document.fonts?.ready.then(() => { charW = 0; renderCode(); activeText()?.ta.refresh(); splitTa.refresh(); });

// The caret stops of a line: 0, each grapheme's end. Remembered for the last line asked about (clicks and drags repeat it).
const graphemeSeg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
let graphemeMemo = { text: '', cuts: [0] };
function graphemeCuts(text: string): number[] {
  if (graphemeMemo.text !== text) {
    const cuts = [0];
    for (const g of graphemeSeg.segment(text)) cuts.push(g.index + g.segment.length);
    graphemeMemo = { text, cuts };
  }
  return graphemeMemo.cuts;
}

// Where the caret goes on lines the char grid can't place (Thai marks, CJK, emoji): measured on the drawn
// line itself. Pure-ASCII lines, and lines not drawn or drawn from other text, return null (the grid is exact there).
function lineMeasurer(lines: HTMLElement, first: () => number, text: () => string): Pick<SurfaceOpts, 'xAt' | 'colAt'> {
  const lineText = (line: number): string | null => {
    const t = text(), starts = lineStartsOf(t); // memoized, and shared with the rest of the editor
    return line < starts.length ? t.slice(starts[line], lineEnd(t, starts[line])) : null;
  };
  // The drawn line's text nodes, without the error message drawn after it; null unless it shows exactly `want`.
  const nodesOf = (line: number, want: string): Text[] | null => {
    const el = lines.children[line - first()];
    if (!el) return null;
    const out: Text[] = [], walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let drawn = '';
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (n.parentElement?.closest('.diag-msg')) continue;
      out.push(n as Text); drawn += (n as Text).data;
    }
    return drawn === want ? out : null;
  };
  const measure = (nodes: Text[], col: number): number => {
    let n = 0;
    while (n < nodes.length - 1 && col > nodes[n].length) col -= nodes[n++].length;
    const r = document.createRange();
    r.setStart(nodes[n], Math.min(col, nodes[n].length));
    return r.getBoundingClientRect().left - lines.getBoundingClientRect().left + 4; // 4 = pad.left
  };
  const measured = (line: number): Text[] | null => {
    const t = lineText(line);
    return t != null && /[^\x00-\x7f]/.test(t) ? nodesOf(line, t) : null;
  };
  return {
    xAt(line, col) {
      const nodes = measured(line);
      return nodes ? measure(nodes, col) : null;
    },
    colAt(line, x) {
      const nodes = measured(line);
      if (!nodes) return null;
      // Only grapheme boundaries: a caret inside an emoji's surrogate pair or a Thai mark's cluster would split it.
      const cuts = graphemeCuts(lineText(line)!);
      let lo = 0, hi = cuts.length - 1;
      while (lo < hi) { // the first boundary at or right of x
        const mid = (lo + hi) >> 1;
        if (measure(nodes, cuts[mid]) < x) lo = mid + 1; else hi = mid;
      }
      return lo > 0 && x - measure(nodes, cuts[lo - 1]) < measure(nodes, cuts[lo]) - x ? cuts[lo - 1] : cuts[lo];
    },
  };
}

function lineAt(v: string, pos: number): number {
  if (v.length > 20000) return lineOfOffset(lineStartsOf(v), pos);
  let n = 0;
  for (let i = v.indexOf('\n'); i !== -1 && i < pos; i = v.indexOf('\n', i + 1)) n++;
  return n;
}
function offsetOf(v: string, line: number, col: number): number {
  let off = 0;
  for (let i = 0; i < line; i++) {
    const nl = v.indexOf('\n', off);
    if (nl === -1) return v.length;
    off = nl + 1;
  }
  return Math.min(off + col, lineEnd(v, off));
}

function editorNote(b: EditorBuffer): string {
  if (b.kind === 'binary') return 'This file is binary, so Breeze can\'t show it as text.';
  if (b.kind === 'image') return 'Breeze couldn\'t load this image.';
  if (b.kind === 'video') return 'Breeze couldn\'t play this video.';
  if (b.kind === 'pdf') return 'Breeze couldn\'t show this PDF.';
  return `This file is too large to open (${(b.size / 1048576).toFixed(1)} MB).`;
}
function renderEditor(): void {
  hideSuggest();
  const b = activeBuf();
  for (const x of buffers.values()) x.ta?.classList.toggle('hidden', x !== b);
  const empty = $('#editorEmpty');
  if (b?.kind !== 'text') {
    const wasHidden = empty.classList.contains('hidden');
    empty.classList.remove('hidden');
    if (b?.kind === 'image' && b.url) showImage(empty, b);
    else if (b?.kind === 'video' && b.url) showVideo(empty, b);
    else if (b?.kind === 'pdf' && b.url) showPdf(empty, b);
    else {
      empty.classList.remove('img-mode');
      delete empty.dataset.img;
      empty.innerHTML = b ? fileNoteHtml(b.path, editorNote(b)) : welcomeHtml();
    }
    if (wasHidden || !b) {
      empty.classList.remove('enter');
      const _reflow = empty.offsetWidth;
      empty.classList.add('enter');
      empty.addEventListener('animationend', () => empty.classList.remove('enter'), { once: true });
    }
    hlLines.replaceChildren(); hlBoxes.replaceChildren(); gutLines.replaceChildren();
    updateVSlider();
    closeFind();
    updateStatus();
    return;
  }
  empty.classList.add('hidden');
  empty.classList.remove('enter');
  if (findOpen) runFind(false);
  renderCode();
  if (document.activeElement === document.body || (document.activeElement?.classList.contains('ta') && document.activeElement !== splitTa.input)) b.ta?.focus({ preventScroll: true });
}
const fileNoteHtml = (path: string, note: string) => `<div><h4>${esc(baseName(path))}</h4><div>${esc(note)}</div></div>`;
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  return n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}
// Videos open in a player fitted to the editor; Chromium streams the file, so size doesn't matter.
function showVideo(el: HTMLElement, b: EditorBuffer): void {
  el.classList.add('img-mode');
  if (el.dataset.img === b.url) return; // already showing it: keep its place
  el.dataset.img = b.url;
  el.innerHTML = `<div class="img-stage fit"><video src="${escAttr(b.url ?? '')}" controls preload="metadata"></video></div>
    <div class="img-meta"><span class="img-dims">Loading</span><span>${fmtSize(b.size)}</span></div>`;
  const v = $<HTMLVideoElement>('video', el);
  v.onloadedmetadata = () => { $('.img-dims', el).textContent = `${v.videoWidth} × ${v.videoHeight}`; };
  v.onerror = () => { el.classList.remove('img-mode'); delete el.dataset.img; el.innerHTML = fileNoteHtml(b.path, editorNote(b)); };
}
// PDFs open in Chromium's own viewer (pages, zoom, search, print), filling the editor.
function showPdf(el: HTMLElement, b: EditorBuffer): void {
  el.classList.add('img-mode');
  if (el.dataset.img === b.url) return; // already showing it: keep its page
  el.dataset.img = b.url;
  el.innerHTML = `<iframe class="pdf-frame" src="${escAttr(b.url ?? '')}" title="${escAttr(baseName(b.path))}"></iframe>`;
}
// Images open in a viewer: fitted to the editor, click to see them at actual size.
function showImage(el: HTMLElement, b: EditorBuffer): void {
  el.classList.add('img-mode');
  if (el.dataset.img === b.url) return; // already showing it: keep its zoom and scroll
  el.dataset.img = b.url;
  el.innerHTML = `<div class="img-stage fit"><img src="${escAttr(b.url ?? '')}" alt="${escAttr(baseName(b.path))}" draggable="false"></div>
    <div class="img-meta"><span class="img-dims">Loading</span><span>${fmtSize(b.size)}</span><span class="img-zoom hidden"></span></div>`;
  const stage = $('.img-stage', el), img = $<HTMLImageElement>('img', el), zoom = $('.img-zoom', el);
  const shrunk = () => img.naturalWidth > img.clientWidth + 1 || img.naturalHeight > img.clientHeight + 1;
  const hint = () => {
    const fit = stage.classList.contains('fit');
    zoom.textContent = fit ? 'Fit to window · click to zoom' : 'Actual size · click to fit';
    zoom.classList.toggle('hidden', fit && !shrunk());
    stage.classList.toggle('zoomable', !fit || shrunk());
  };
  img.onload = () => { $('.img-dims', el).textContent = `${img.naturalWidth} × ${img.naturalHeight}`; hint(); };
  img.onmouseenter = hint; // panels may have been resized since it loaded
  img.onerror = () => { el.classList.remove('img-mode'); el.innerHTML = fileNoteHtml(b.path, 'Breeze couldn\'t load this image.'); };
  img.onclick = e => {
    const fit = stage.classList.contains('fit');
    if (fit && !shrunk()) return;
    // Zoom in around the clicked point.
    const r = img.getBoundingClientRect(), s = stage.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    stage.classList.toggle('fit');
    if (fit) {
      stage.scrollLeft = img.offsetLeft + fx * img.naturalWidth - (e.clientX - s.left);
      stage.scrollTop = img.offsetTop + fy * img.naturalHeight - (e.clientY - s.top);
    }
    hint();
  };
}
function welcomeHtml(): string {
  const k = (keys: string, what: string) => `<span>${what}</span><kbd>${keys}</kbd>`;
  const keys = rootInfo
    ? k('Ctrl+P', 'Go to file') + k('Ctrl+N', 'New file') + k('Ctrl+Shift+F', 'Search files') + k('Ctrl+`', 'Terminal')
    : k('Ctrl+O', 'Open folder') + k('Ctrl+B', 'Toggle side bar') + k('Ctrl+Alt+B', 'Toggle agents');
  return `<div><img src="../../assets/brand/Agent.png" alt="" draggable="false"><h4>${rootInfo ? 'No file open' : 'Open a folder to start'}</h4><div class="keys">${keys}</div></div>`;
}
function queueRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderCode(); });
}

// Overlay boxes (find hits, squiggles) are placed through the DOM, not style attributes.
function box(cls: string, top: number, left: number, width?: number): HTMLElement {
  const d = document.createElement('div');
  d.className = cls;
  d.style.top = `${top}px`;
  d.style.left = `${left}px`;
  if (width != null) d.style.width = `${width}px`;
  return d;
}
function findBoxes(b: EditorBuffer, cw: number): HTMLElement[] {
  if (!findOpen || !findLen) return [];
  const vis = findHits.length > 3000 ? findHits.slice(Math.max(0, findIdx - 1500), findIdx + 1500) : findHits;
  // Only the hits in the drawn window get a box.
  const starts = lineStartsOf(b.text);
  return vis.filter(off => { const ln = lineOfOffset(starts, off); return ln >= winFirst && ln < winLast; }).map(off => {
    const ln = lineOfOffset(starts, off), ls = starts[ln];
    const lt = b.text.slice(ls, lineEnd(b.text, ls));
    const x = visualCol(lt, off - ls) * cw, w = (visualCol(lt, off - ls + findLen) * cw) - x;
    return box(off === findHits[findIdx] ? 'hit cur' : 'hit', ln * LINE_H, x, Math.max(w, 2));
  });
}
// Syntax errors: a red line, a squiggle under the mistake and the message after the code.
// While an edit has added or removed lines they wait for the next check instead of drifting.
function visibleDiags(b: EditorBuffer, lineCount: number): Map<number, Diag> {
  const errAt = new Map<number, Diag>();
  if (!b.diags?.length || b.diagLines !== lineCount) return errAt;
  for (const d of b.diags) {
    const ln = Math.min(d.line, lineCount - 1);
    if (!errAt.has(ln)) errAt.set(ln, d);
  }
  return errAt;
}
function squiggles(b: EditorBuffer, lineCount: number, cw: number): HTMLElement[] {
  if (!b.diags?.length || b.diagLines !== lineCount) return [];
  const text = b.text, starts = lineStartsOf(text);
  return b.diags.map(d => {
    const ln = Math.min(d.line, starts.length - 1), lt = text.slice(starts[ln], lineEnd(text, starts[ln]));
    const from = Math.min(d.col, lt.length), to = Math.min(lt.length, d.col + d.len);
    const x = visualCol(lt, from) * cw;
    return box('squig', ln * LINE_H + 15, x, Math.max(visualCol(lt, to) * cw - x, cw));
  });
}
/* ----- Matching tags: with the caret in an opening or closing tag, both halves light up ----- */
interface TagSpan { start: number; end: number; nameStart: number; nameEnd: number; }
// Pairs every opening tag with its closing tag (void and self-closing tags have no partner; stray closers are ignored).
function tagPairs(text: string, xml: boolean): [TagSpan, TagSpan][] {
  const re = /<!--[\s\S]*?(?:-->|$)|<(\/?)([A-Za-z][\w:.-]*)([^>]*)>/g;
  const stack: { name: string; span: TagSpan }[] = [];
  const pairs: [TagSpan, TagSpan][] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0].startsWith('<!--')) continue;
    const name = xml ? m[2] : m[2].toLowerCase();
    const nameStart = m.index + 1 + m[1].length;
    const span = { start: m.index, end: m.index + m[0].length, nameStart, nameEnd: nameStart + m[2].length };
    if (m[1]) {
      const at = stack.map(s => s.name).lastIndexOf(name);
      if (at === -1) continue;
      pairs.push([stack[at].span, span]);
      stack.length = at; // anything opened after it was left open
    } else if (!m[3].endsWith('/') && (xml || !VOID_HTML.has(name))) stack.push({ name, span });
  }
  return pairs;
}
// The buffer's tag pairs, found again only when its text changes (the caret moving doesn't rescan the file).
const tagCache = new WeakMap<EditorBuffer, { text: string; pairs: [TagSpan, TagSpan][] }>();
function tagPairsOf(b: EditorBuffer): [TagSpan, TagSpan][] {
  const c = tagCache.get(b);
  if (c?.text === b.text) return c.pairs;
  const pairs = tagPairs(b.text, ['xml', 'svg', 'jsx', 'tsx'].includes(extOf(b.path)));
  tagCache.set(b, { text: b.text, pairs });
  return pairs;
}
// The two tags around the caret as offset ranges to mark: exactly the tag names, so the boxes hug the letters.
function tagMarks(b: EditorBuffer): [number, number][] {
  const lexer = langOf(b.path)[0], ext = extOf(b.path);
  if ((lexer !== 'html' && ext !== 'jsx' && ext !== 'tsx') || b.text.length > 200000) return [];
  if (!b.ta) return [];
  const caret = b.ta.selectionStart;
  const hit = (t: TagSpan, strict: boolean) => (strict ? t.start < caret && caret < t.end : t.start <= caret && caret <= t.end);
  const pairs = tagPairsOf(b);
  const pair = pairs.find(p => p.some(t => hit(t, true))) ?? pairs.find(p => p.some(t => hit(t, false)));
  return pair ? pair.map(t => [t.nameStart, t.nameEnd] as [number, number]) : [];
}
function tagBoxes(b: EditorBuffer, cw: number): HTMLElement[] {
  return tagMarks(b).map(([from, to]) => {
    const ln = lineAt(b.text, from), ls = lineStart(b.text, from);
    const lt = b.text.slice(ls, lineEnd(b.text, ls));
    const x = visualCol(lt, from - ls) * cw;
    return box('tagpair', ln * LINE_H, x, Math.max(visualCol(lt, to - ls) * cw - x, 2));
  });
}
/* ----- Scope guides: a thin line from a tag's or block's first line down to its end ----- */
// from/to are lines: the guide runs below line `from` and stops at the top of line `to`.
interface Block { from: number; to: number; start: number; end: number; col: number; }
const blockCache = new WeakMap<EditorBuffer, { text: string; blocks: Block[] }>();
// Every {} [] () pair as [open, close] offsets, skipping strings and comments.
const OPENER: Record<string, string> = { '}': '{', ']': '[', ')': '(' };
function bracketPairs(text: string): [number, number][] {
  const pairs: [number, number][] = [], stack: number[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      if (nl === -1) {
        break;
      }
      i = nl + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      if (e === -1) {
        break;
      }
      i = e + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c && (c === '`' || text[j] !== '\n')) j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') {
      stack.push(i);
    } else if (OPENER[c]) {
      let at = stack.length - 1;
      while (at >= 0 && text[stack[at]] !== OPENER[c]) at--;
      if (at !== -1) { pairs.push([stack[at], i]); stack.length = at; }
    }
    i++;
  }
  return pairs;
}
function blocksOf(b: EditorBuffer): Block[] {
  const c = blockCache.get(b);
  if (c?.text === b.text) return c.blocks;
  const text = b.text, lexer = langOf(b.path)[0], ext = extOf(b.path);
  const blocks: Block[] = [];
  if (text.length <= 200000) {
    const starts = lineStartsOf(text);
    const indentOf = (ln: number) => {
      const lt = text.slice(starts[ln], lineEnd(text, starts[ln]));
      return visualCol(lt, lt.length - lt.trimStart().length);
    };
    const add = (open: number, close: number) => {
      const from = lineOfOffset(starts, open), to = lineOfOffset(starts, close);
      if (to - from >= 2) blocks.push({ from, to, start: open, end: close + 1, col: Math.min(indentOf(from), indentOf(to)) });
    };
    if (lexer === 'html' || ext === 'jsx' || ext === 'tsx') {
      for (const [o, cl] of tagPairsOf(b)) add(o.start, cl.start);
    }
    if (['js', 'css', 'json', 'java', 'rs', 'cs'].includes(lexer)) for (const [o, cl] of bracketPairs(text)) add(o, cl);
    if (lexer === 'py') {
      // Python blocks are the lines indented under a line that ends with ':'.
      const raw = text.split('\n');
      raw.forEach((lt, i) => {
        if (!/:\s*(?:#.*)?$/.test(lt) || !lt.trim()) return;
        const ind = indentOf(i);
        let last = i;
        for (let j = i + 1; j < raw.length; j++) {
          if (!raw[j].trim()) continue;
          if (indentOf(j) <= ind) break;
          last = j;
        }
        if (last > i) blocks.push({ from: i, to: last + 1, start: starts[i], end: starts[last] + raw[last].length, col: ind });
      });
    }
  }
  blockCache.set(b, { text, blocks });
  return blocks;
}
// Guides for the blocks in view; the innermost one around the caret is brighter.
function guideBoxes(b: EditorBuffer, caret: number, cw: number, first = winFirst, last = winLast): HTMLElement[] {
  const blocks = blocksOf(b);
  let on: Block | undefined;
  for (const k of blocks) if (k.start <= caret && caret <= k.end && (!on || k.end - k.start < on.end - on.start)) on = k;
  return blocks.filter(k => k.to > first && k.from < last).map(k => {
    const d = box(k === on ? 'guide on' : 'guide', (k.from + 1) * LINE_H, k.col * cw);
    d.style.height = `${(k.to - k.from - 1) * LINE_H}px`;
    return d;
  });
}
let tagKey = '';
function lineHtml(h: string, i: number, add: Set<number> | undefined, d: Diag | undefined): string {
  const cls = ['ln', add?.has(i) ? 'added' : '', d ? 'err' : '', i === curLine ? 'cur-line' : ''].filter(Boolean).join(' ');
  const msg = d ? `<span class="diag-msg">${esc(d.msg)}</span>` : '';
  return `<div class="${cls}">${h}${msg}</div>`;
}
function gutterHtml(i: number, d: Diag | undefined, mark?: ChangeMark, marked = false): string {
  const cls = [i === curLine ? 'cur' : '', d ? 'err' : '', mark ? `git-${mark}` : ''].filter(Boolean).join(' ');
  const attrs = (cls ? ` class="${cls}"` : '') + (d ? ` title="${escAttr(d.msg)}"` : '');
  return `<div${attrs}>${markDot(i, marked)}${i + 1}</div>`;
}

/* ----- Line marks ----- */
// A dot before a line number: grey while the pointer is on the line, red once clicked, for marking lines to come
// back to. Kept per file in each folder, and moved with their lines as the file is edited.
const lineMarks = new Map<string, Set<number>>(); // path → 0-based lines
const marksKey = () => `breeze.marks:${rootInfo?.root ?? ''}`;
const markDot = (i: number, on: boolean) => `<span class="mark-dot${on ? ' on' : ''}" data-mark="${i}" title="${on ? 'Remove mark' : 'Mark this line'}"></span>`;
function loadMarks(): void {
  lineMarks.clear();
  for (const [p, lines] of Object.entries(store.get<Record<string, number[]>>(marksKey(), {}))) lineMarks.set(p, new Set(lines));
}
function saveMarks(): void {
  const saved = [...lineMarks].filter(([, s]) => s.size).map(([p, s]) => [p, [...s].sort((a, c) => a - c)]);
  store.set(marksKey(), Object.fromEntries(saved));
}
function repaintMarks(path: string): void {
  if (path === active) queueRender();
  if (path === splitPath) paintSplit();
}
function toggleMark(path: string | null, line: number): void {
  if (!path) return;
  const s = lineMarks.get(path) ?? new Set<number>();
  if (!s.delete(line)) s.add(line);
  lineMarks.set(path, s);
  saveMarks();
  repaintMarks(path);
}
// After an edit, marks below it move with their lines; marks on removed lines go too.
function shiftMarks(path: string, before: string, after: string): void {
  const s = lineMarks.get(path);
  if (!s?.size) return;
  const count = (t: string) => { let n = 0; for (let i = t.indexOf('\n'); i !== -1; i = t.indexOf('\n', i + 1)) n++; return n; };
  const delta = count(after) - count(before);
  if (!delta) return;
  // Where the edit starts: the shared start, measured after the shared end, so a removed line that begins like the
  // next one ("const a…", "const b…") counts as that line and not the text after it.
  let suf = 0;
  while (suf < before.length && suf < after.length && before[before.length - 1 - suf] === after[after.length - 1 - suf]) suf++;
  const most = Math.min(before.length, after.length) - suf;
  let p = 0;
  while (p < most && before[p] === after[p]) p++;
  // The last line the edit leaves in place. Lines added or removed whole, at a line's start, start after the one above.
  let anchor = count(before.slice(0, p));
  if (p === 0 || before[p - 1] === '\n') anchor--;
  const moved = new Set<number>();
  for (const m of s) {
    if (m <= anchor) moved.add(m);
    else if (delta > 0 || m > anchor - delta) moved.add(m + delta);
  }
  lineMarks.set(path, moved);
  saveMarks();
}
// Next or previous mark from the caret, through every marked file in path order, round to the start again.
function jumpMark(dir: 1 | -1): void {
  const before = (a: { path: string; line: number }, b: { path: string; line: number }) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1);
  const all = [...lineMarks].flatMap(([path, s]) => [...s].map(line => ({ path, line }))).sort(before);
  if (!all.length) { toast('No marks yet. Click the dot before a line number to add one.'); return; }
  const b = activeText();
  const here = { path: active ?? '', line: b ? lineAt(b.text, b.ta.selectionStart) : -1 };
  const to = dir > 0 ? all.find(m => before(m, here) > 0) ?? all[0] : [...all].reverse().find(m => before(m, here) < 0) ?? all[all.length - 1];
  openFile(to.path, { line: to.line, col: 0 });
}
// A file or folder was moved: `move` maps each old path to its new one.
function renameMarks(move: (path: string) => string): void {
  const moved = [...lineMarks].map(([p, s]) => [move(p), s] as const);
  lineMarks.clear();
  for (const [p, s] of moved) lineMarks.set(p, s);
  saveMarks();
}
for (const [gutter, path] of [['#gutter', () => active], ['#splitGutter', () => splitPath]] as const) {
  $(gutter).addEventListener('click', e => {
    const dot = (e.target as HTMLElement).closest<HTMLElement>('[data-mark]');
    if (dot) toggleMark(path(), Number(dot.dataset.mark));
  });
}


const OVERSCAN = 40;
let winFirst = 0, winLast = 0, winTotal = 1;
const hlCache = new WeakMap<EditorBuffer, HlDoc>();
// Re-lexes only when the text changed (and then only around the edit), so scrolling never re-highlights.
function highlighted(b: EditorBuffer): HlDoc {
  const lexer = langOf(b.path)[0];
  const c = hlCache.get(b);
  if (c?.text === b.text && c.lexer === lexer) return c;
  const text = b.text;
  const prev = c && c.lexer === lexer && LEXERS[lexer] && text.length <= HL_MAX && c.text.length <= HL_MAX ? c : undefined;
  let toks: HlToks;
  if (prev && INCREMENTAL.has(lexer)) toks = relex(prev, text);
  else if (prev && text.length > HL_EXACT_MAX) { toks = shiftToks(prev, text); exactLater(b); }
  else toks = fullToks(text, lexer);
  const d: HlDoc = { text, lexer, ...toks, lines: lineStartsOf(text), html: [] };
  hlCache.set(b, d);
  return d;
}
// After a pause in typing, a big HTML or CSS file gets its exact colours back.
const exactTimers = new WeakMap<EditorBuffer, TimeoutId>();
function exactLater(b: EditorBuffer): void {
  clearTimeout(exactTimers.get(b));
  exactTimers.set(b, setTimeout(() => {
    const c = hlCache.get(b);
    if (!c || c.text !== b.text) return; // highlighted() runs again on the next draw
    hlCache.set(b, { ...c, ...fullToks(c.text, c.lexer), html: [] });
    if (b.path === active) queueRender();
    if (b.path === splitPath) paintSplit();
  }, 400));
}
function visibleLines(ta: CodeSurface, total: number): [number, number] {
  const first = clamp(Math.floor((ta.scrollTop - 10) / LINE_H), 0, total - 1);
  const last = clamp(Math.ceil((ta.scrollTop + (ta.clientHeight || 800)) / LINE_H), 0, total);
  return [first, last];
}
function renderCode(): void {
  const b = activeText();
  if (!b) return;
  applyPendingScroll(b);
  const doc = highlighted(b);
  const count = doc.lines.length;
  winTotal = count;
  curLine = lineOfOffset(doc.lines, b.ta.selectionStart);
  const cw = measureChar();
  const errAt = visibleDiags(b, count);
  const add = added[b.path];
  const marks = changeMarks(b), marked = lineMarks.get(b.path);
  const [vf, vl] = visibleLines(b.ta, count);
  winFirst = Math.max(0, vf - OVERSCAN);
  winLast = Math.min(count, vl + OVERSCAN);
  const rows: string[] = [], nums: string[] = [];
  for (let i = winFirst; i < winLast; i++) {
    rows.push(lineHtml(lineHtmlOf(doc, i), i, add, errAt.get(i)));
    nums.push(gutterHtml(i, errAt.get(i), marks?.get(i), !!marked?.has(i)));
  }
  hlLines.innerHTML = rows.join('');
  hlLines.style.top = `${winFirst * LINE_H}px`;
  gutLines.innerHTML = nums.join('');
  gutLines.style.top = `${winFirst * LINE_H}px`;
  hlBoxes.replaceChildren(...guideBoxes(b, b.ta.selectionStart, cw), ...findBoxes(b, cw), ...squiggles(b, count, cw), ...tagBoxes(b, cw), ...typingCaretBox(b, cw));
  tagKey = `${b.path}:${b.ta.selectionStart}:${b.text.length}`;
  $('#gutter').style.width = `${Math.max(3, String(count).length) * 8 + 40}px`; // +8 for the mark dot
  // The surface painted before these lines were drawn; repaint so carets on measured (non-ASCII) lines match them.
  b.ta.refresh();
  syncScroll();
  updateStatus();
}
function syncScroll(): void {
  const b = activeText();
  if (!b) return;
  // Scrolled past the rendered window: draw the new one (cheap, the highlighting is cached).
  const [vf, vl] = visibleLines(b.ta, winTotal);
  if (vf < winFirst || vl > winLast) { renderCode(); return; }
  hlInner.style.transform = `translate(${-b.ta.scrollLeft}px, ${-b.ta.scrollTop}px)`;
  gutInner.style.transform = `translateY(${-b.ta.scrollTop}px)`;
  updateVSlider(b.ta);
}

/* ----- Vertical scroll slider on the right edge of an editor (native scrollbars are hidden) ----- */
// Returns the function that brings the slider up to date with its surface. The track fills its editor
// top to bottom, so its room is the editor's height (the track itself measures 0 while it is hidden).
function vSlider(host: HTMLElement, surface: () => CodeSurface | undefined): (ta?: CodeSurface) => void {
  const track = document.createElement('div');
  track.className = 'v-slider';
  const thumb = document.createElement('div');
  thumb.className = 'v-slider-thumb';
  track.append(thumb);
  host.append(track);
  const update = (ta = surface()): void => {
    const room = host.clientHeight;
    const overflow = ta ? ta.scrollHeight - ta.clientHeight : 0;
    track.classList.toggle('on', !!ta && overflow > 0 && room > 0);
    if (!ta || overflow <= 0 || room <= 0) return;
    const h = Math.max(32, room * ta.clientHeight / ta.scrollHeight);
    thumb.style.height = `${h}px`;
    thumb.style.transform = `translateY(${(room - h) * ta.scrollTop / overflow}px)`;
  };
  thumb.addEventListener('pointerdown', e => {
    const ta = surface();
    if (!ta || e.button !== 0) return;
    const startY = e.clientY, startTop = ta.scrollTop;
    try { thumb.setPointerCapture(e.pointerId); } catch { /* pointer already gone: the drag still follows moves over the thumb */ }
    track.classList.add('drag');
    const move = (ev: PointerEvent): void => {
      const travel = host.clientHeight - thumb.offsetHeight;
      if (travel > 0) ta.scrollTop = startTop + (ev.clientY - startY) * (ta.scrollHeight - ta.clientHeight) / travel;
    };
    const up = (): void => {
      track.classList.remove('drag');
      thumb.removeEventListener('pointermove', move);
      thumb.removeEventListener('pointerup', up);
      thumb.removeEventListener('pointercancel', up);
    };
    thumb.addEventListener('pointermove', move);
    thumb.addEventListener('pointerup', up);
    thumb.addEventListener('pointercancel', up);
    e.preventDefault();
  });
  // Clicking the track jumps there, centred on the click.
  track.addEventListener('pointerdown', e => {
    const ta = surface();
    if (e.target !== track || !ta || e.button !== 0) return;
    const r = track.getBoundingClientRect();
    ta.scrollTop = (e.clientY - r.top) / r.height * ta.scrollHeight - ta.clientHeight / 2;
    e.preventDefault();
  });
  // A panel resize changes the room without a scroll.
  new ResizeObserver(() => update()).observe(host);
  return update;
}
const updateVSlider = vSlider($('#editor'), () => activeText()?.ta);



/* ----- Split editor: a second text file on the right, editing the same buffer as its tab ----- */
let splitPath: string | null = null;
const splitLines = document.createElement('div');
splitLines.style.position = 'relative';
const splitInner = document.createElement('div');
splitInner.style.position = 'relative';
splitInner.append(splitLines);
$('#splitHl').appendChild(splitInner);
const splitGutInner = document.createElement('div');
const splitGutLines = document.createElement('div');
splitGutLines.style.position = 'relative';
splitGutInner.append(splitGutLines);
$('#splitGutter').appendChild(splitGutInner);
let splitWin = { first: 0, last: 0, total: 1 };
const splitBuf = () => { const b = splitPath ? buffers.get(splitPath) : undefined; return b?.kind === 'text' ? b : undefined; };
// Measures against the surface's own text; the constructor paints before `splitTa` is assigned, hence the empty text then.
let splitSelf: CodeSurface | null = null;
const splitTa: CodeSurface = splitSelf = new CodeSurface($('.split-editor .code'), {
  lineHeight: LINE_H, charWidth: measureChar, pad: { top: 10, left: 4, right: 24, bottom: 10 }, label: 'Right split editor',
  ...lineMeasurer(splitLines, () => splitWin.first, () => splitSelf?.value ?? ''),
});
const textTabs = () => openTabs.filter(p => buffers.get(p)?.kind === 'text');

function openSplit(path: string | null = active, exact = false): void {
  // Split the file next to the open one when possible, so the two sides start out different.
  const other = textTabs().find(p => p !== active);
  const target = exact || (path && path !== active) ? path : other ?? path;
  if (!target || buffers.get(target)?.kind !== 'text') { toast('Open a text file to split the editor'); return; }
  splitPath = target;
  const split = $('#split');
  // Slides in from the right edge (only when it wasn't already showing).
  if (split.classList.contains('hidden') || split.classList.contains('closing')) {
    split.classList.remove('hidden', 'closing');
    split.classList.add('opening');
    const end = (e?: AnimationEvent) => { if (!e || e.target === split) { split.classList.remove('opening'); split.removeEventListener('animationend', end); } };
    split.addEventListener('animationend', end);
    setTimeout(end, 450); // the animation didn't run (hidden window, reduced motion): settle anyway
  }
  $('#editorRow').classList.add('is-split');
  splitTa.value = '';
  renderSplit();
  splitTa.scrollTop = 0;
  splitTa.focus({ preventScroll: true });
  syncScroll();
}
function closeSplit(): void {
  splitPath = null;
  const split = $('#split');
  if (split.classList.contains('hidden')) return;
  // Slides back out to the right, then hides.
  split.classList.remove('opening');
  split.classList.add('closing');
  const done = () => {
    if (splitPath || !split.classList.contains('closing')) return; // reopened meanwhile
    split.classList.remove('closing');
    split.classList.add('hidden');
    $('#editorRow').classList.remove('is-split');
    splitLines.replaceChildren(); splitGutLines.replaceChildren();
    queueRender();
  };
  const end = (e: AnimationEvent) => { if (e.target === split) { split.removeEventListener('animationend', end); done(); } };
  split.addEventListener('animationend', end);
  setTimeout(done, 400); // no animation (reduced motion): hide anyway
}
// Brings the right side up to date with its buffer (after edits on the left, a save, or an agent's change).
function renderSplit(): void {
  if (!splitPath) return;
  const b = splitBuf();
  if (!b) { closeSplit(); return; }
  const sel = $<HTMLSelectElement>('#splitFile');
  const opts = textTabs();
  const html = opts.map(p => `<option value="${escAttr(p)}"${p === splitPath ? ' selected' : ''}>${esc(baseName(p))}${dirName(p) ? ` — ${esc(dirName(p))}` : ''}</option>`).join('');
  if (sel.innerHTML !== html) sel.innerHTML = html;
  sel.value = splitPath;
  $('#splitIco').innerHTML = fileIcon(splitPath);
  $('#splitDirty').classList.toggle('hidden', !isDirty(b));
  if (splitTa.value !== b.text) {
    const { selectionStart: s, selectionEnd: e, scrollTop } = splitTa;
    splitTa.value = b.text;
    splitTa.setSelectionRange(Math.min(s, b.text.length), Math.min(e, b.text.length));
    splitTa.scrollTop = scrollTop;
  }
  paintSplit();
}
function paintSplit(): void {
  const b = splitBuf();
  if (!b) return;
  const doc = highlighted(b);
  const count = doc.lines.length;
  const cur = lineOfOffset(doc.lines, splitTa.selectionStart);
  const [vf, vl] = visibleLines(splitTa, count);
  splitWin = { first: Math.max(0, vf - OVERSCAN), last: Math.min(count, vl + OVERSCAN), total: count };
  const marks = changeMarks(b);
  const rows: string[] = [], nums: string[] = [];
  for (let i = splitWin.first; i < splitWin.last; i++) {
    rows.push(`<div class="ln${i === cur ? ' cur-line' : ''}">${lineHtmlOf(doc, i)}</div>`);
    const cls = [i === cur ? 'cur' : '', marks?.has(i) ? `git-${marks.get(i)}` : ''].filter(Boolean).join(' ');
    nums.push(`<div${cls ? ` class="${cls}"` : ''}>${markDot(i, !!lineMarks.get(b.path)?.has(i))}${i + 1}</div>`);
  }
  splitLines.innerHTML = rows.join('');
  splitLines.style.top = splitGutLines.style.top = `${splitWin.first * LINE_H}px`;
  splitGutLines.innerHTML = nums.join('');
  $('#splitGutter').style.width = `${Math.max(3, String(count).length) * 8 + 40}px`; // +8 for the mark dot
  splitInner.querySelectorAll('.guide').forEach(g => g.remove());
  splitInner.append(...guideBoxes(b, splitTa.selectionStart, measureChar(), splitWin.first, splitWin.last));
  syncSplitScroll();
  splitTa.refresh(); // the caret was placed against the lines drawn before; measure it against these
}
function syncSplitScroll(): void {
  const [vf, vl] = visibleLines(splitTa, splitWin.total);
  if (vf < splitWin.first || vl > splitWin.last) { paintSplit(); return; }
  splitInner.style.transform = `translate(${-splitTa.scrollLeft}px, ${-splitTa.scrollTop}px)`;
  splitGutInner.style.transform = `translateY(${-splitTa.scrollTop}px)`;
  updateSplitSlider();
}
const updateSplitSlider = vSlider($('.split-editor'), () => (splitBuf() ? splitTa : undefined));
splitTa.addEventListener('scroll', syncSplitScroll);
splitTa.addEventListener('input', () => {
  const b = splitBuf();
  if (!b) return;
  const wasDirty = isDirty(b);
  b.text = splitTa.value;
  // The same file open on the left follows along, keeping its own caret.
  if (b.ta && b.ta.value !== b.text) {
    const { selectionStart: s, selectionEnd: e } = b.ta;
    b.ta.value = b.text;
    b.ta.setSelectionRange(Math.min(s, b.text.length), Math.min(e, b.text.length));
  }
  if (wasDirty !== isDirty(b)) { renderTabs(); renderTree(); }
  if (b.path === active) queueRender();
  paintSplit(); saveSession(); scheduleLint(b);
  $('#splitDirty').classList.toggle('hidden', !isDirty(b));
});
splitTa.addEventListener('beforeinput', e => { const b = splitBuf(); if (b) beforeEdit(b, e as InputEvent, splitTa); });
splitTa.addEventListener('selectionchange', paintSplit);
splitTa.addEventListener('keydown', (e: Event) => {
  const k = e as KeyboardEvent;
  if (k.isComposing) return;
  const b = splitBuf();
  if (!b) return;
  // Ctrl+S goes through file.save, which saves this side's file while it has focus.
  if (k.key === 'Tab' && !k.ctrlKey && !k.altKey) {
    k.preventDefault();
    splitTa.insertText(INDENT);
  }
});
$<HTMLSelectElement>('#splitFile').onchange = e => { splitPath = (e.target as HTMLSelectElement).value; splitTa.value = ''; renderSplit(); splitTa.scrollTop = 0; };
$('#splitClose').onclick = closeSplit;
$('#splitSwap').onclick = () => {
  if (!splitPath) return;
  const left = active, right = splitPath;
  setActive(right);
  if (left && left !== right) { splitPath = left; splitTa.value = ''; renderSplit(); }
};
// Drag the split's left edge to share the width between the two sides.
$('#splitSash').addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  e.preventDefault();
  const row = $('#editorRow'), split = $('#split');
  const sx = e.clientX, startW = split.getBoundingClientRect().width;
  document.body.classList.add('resizing');
  const move = (ev: PointerEvent) => {
    const w = clamp(startW - (ev.clientX - sx), 200, row.clientWidth - 200);
    split.style.flexBasis = `${w}px`;
    paintSplit(); syncScroll();
  };
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); document.body.classList.remove('resizing'); };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
});

function updateCaret(): void {
  const b = activeText();
  if (!b) return;
  const i = lineAt(b.text, b.ta.selectionStart);
  if (i !== curLine) {
    hlLines.children[curLine - winFirst]?.classList.remove('cur-line');
    gutLines.children[curLine - winFirst]?.classList.remove('cur');
    hlLines.children[i - winFirst]?.classList.add('cur-line');
    gutLines.children[i - winFirst]?.classList.add('cur');
    curLine = i;
  }
  // Clicking (or arrowing) into a tag marks it and its partner; the boxes are swapped without redrawing the code.
  const key = `${b.path}:${b.ta.selectionStart}:${b.text.length}`;
  if (key !== tagKey) {
    tagKey = key;
    $$('.tagpair, .guide', hlBoxes).forEach(x => x.remove());
    hlBoxes.prepend(...guideBoxes(b, b.ta.selectionStart, measureChar()));
    hlBoxes.append(...tagBoxes(b, measureChar()));
  }
  updateStatus();

}//end of update caret
function updateStatus(): void {
  const b = activeBuf();
  const tb = activeText();
  $('#sbPos').classList.toggle('hidden', !tb);
  $('#sbLang').textContent = b ? langOf(b.path)[1] : '';
  $('#sbLang').classList.toggle('hidden', !b);
  const eol = b?.eol === '\r\n' ? 'CRLF' : 'LF';
  $('#sbEol').textContent = b?.kind === 'text' ? `${eol} · UTF-8` : '';
  $('#sbEol').classList.toggle('hidden', b?.kind !== 'text');
  const problems = tb?.diags?.length ?? 0;
  const problemsHtml = `${svgIcon('circleX', 12)}<span>${plural(problems, 'problem')}</span>`;
  if ($('#sbProblems').dataset.html !== problemsHtml) { $('#sbProblems').innerHTML = problemsHtml; $('#sbProblems').dataset.html = problemsHtml; }
  $('#sbProblems').classList.toggle('hidden', !problems);
  if (!tb) return;
  const { selectionStart: s, selectionEnd: e } = tb.ta;
  const ls = lineStart(tb.text, s);
  const selected = e > s ? ` (${e - s} selected)` : '';
  $('#sbPos').textContent = `Ln ${lineAt(tb.text, s) + 1}, Col ${s - ls + 1}${selected}`;
}
// F8: move the caret to the next syntax error after it, wrapping around.
function nextProblem(): void {
  const b = activeText();
  if (!b?.diags?.length) { toast('No problems in this file'); return; }
  const offs = b.diags.map(d => offsetOf(b.text, d.line, d.col));
  const off = offs.find(o => o > b.ta.selectionStart) ?? offs[0];
  b.ta.focus();
  b.ta.setSelectionRange(off, off);
  revealOffset(b, off);
}
function revealOffset(b: EditorBuffer, off: number, ta: CodeSurface | null = b.ta): void {
  if (!ta) return;
  const top = lineAt(b.text, off) * LINE_H;
  if (top < ta.scrollTop || top > ta.scrollTop + ta.clientHeight - LINE_H * 3) ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
  const ls = lineStart(b.text, off);
  const x = visualCol(b.text.slice(ls, lineEnd(b.text, ls)), off - ls) * measureChar();
  if (x < ta.scrollLeft || x > ta.scrollLeft + ta.clientWidth - 80) ta.scrollLeft = Math.max(0, x - ta.clientWidth / 2);
  if (ta === splitTa) { syncSplitScroll(); return; }
  syncScroll(); updateCaret();
}

// Replaces a range as one undoable step.
function replaceRange(ta: CodeSurface, start: number, end: number, text: string, selStart?: number, selEnd?: number): void {
  const b = ta === splitTa ? splitBuf() : textareaOwner.get(ta.input);
  if (b) remember(b, 'command', ta);
  ta.focus();
  ta.setRangeText(text, start, end, 'end');
  if (selStart != null) ta.setSelectionRange(selStart, selEnd ?? selStart);
  ta.dispatchEvent(new Event('input'));
}
function selectedLines(ta: CodeSurface): [number, number] {
  const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
  return [lineStart(v, s), lineEnd(v, e > s && v[e - 1] === '\n' ? e - 1 : e)];
}
function indentKey(ta: CodeSurface, outdent: boolean): void {
  const v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
  if (!outdent && !v.slice(s, en).includes('\n')) { replaceRange(ta, s, en, INDENT); return; }
  const [ls, le] = selectedLines(ta);
  const block = v.slice(ls, le);
  const lines = block.split('\n');
  const out = lines.map(l => (outdent ? l.replace(/^(?: {1,2}|\t)/, '') : INDENT + l)).join('\n');
  const firstDelta = out.split('\n')[0].length - lines[0].length;
  replaceRange(ta, ls, le, out, Math.max(ls, s + firstDelta), en + out.length - block.length);
}
// True when `before` ends with an opening tag such as <div class="x">.
function endsWithOpenTag(before: string): boolean {
  const lt = before.lastIndexOf('<');
  if (lt === -1 || !before.endsWith('>')) return false;
  const tag = before.slice(lt);
  return /^<[A-Za-z]/.test(tag) && !tag.endsWith('/>');
}
function enterKey(ta: CodeSurface): void {
  const v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
  const before = v.slice(lineStart(v, s), s);
  const indent = /^[ \t]*/.exec(before)?.[0] ?? '';
  const isPy = langOf(active ?? '')[0] === 'py';
  const opens = /[{[(]\s*$/.test(before) || (isPy && /:\s*$/.test(before)) || (endsWithOpenTag(before) && v.slice(en).startsWith('</'));
  const extra = opens ? INDENT : '';
  // Between a pair like {|} the closing half moves to its own line.
  if (opens && /^\s*[}\])<]/.test(v.slice(en, lineEnd(v, en)))) replaceRange(ta, s, en, `\n${indent}${extra}\n${indent}`, s + 1 + indent.length + extra.length);
  else replaceRange(ta, s, en, `\n${indent}${extra}`);
}
const plainKey = (e: KeyboardEvent) => !e.ctrlKey && !e.altKey && !e.metaKey;
// Auto-closing pairs: typing an opener adds its closer, typing the closer steps over it,
// Backspace inside an empty pair removes both, and a selection gets wrapped.
const AUTO_PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
const AUTO_CLOSERS = new Set(Object.values(AUTO_PAIRS));
function pairKey(e: KeyboardEvent, ta: CodeSurface): boolean {
  if (!plainKey(e) || e.isComposing) return false;
  const v = ta.value, s = ta.selectionStart, en = ta.selectionEnd, ch = e.key;
  if (ch === 'Backspace') {
    if (s !== en || s === 0 || AUTO_PAIRS[v[s - 1]] !== v[s]) return false;
    replaceRange(ta, s - 1, s + 1, '', s - 1);
    return true;
  }
  if (ch.length !== 1) return false;
  if (s === en && AUTO_CLOSERS.has(ch) && v[s] === ch) { ta.setSelectionRange(s + 1, s + 1); updateCaret(); return true; }
  const close = AUTO_PAIRS[ch];
  if (!close) return false;
  if (s !== en) { replaceRange(ta, s, en, ch + v.slice(s, en) + close, s + 1, en + 1); return true; }
  const prev = v[s - 1] ?? '', next = v[s] ?? '';
  // Quotes after a letter are apostrophes (don't), and a pair only opens before a space, a closer or punctuation.
  if (ch === close && (/[\w\\]/.test(prev) || prev === ch)) return false;
  if (next && !/[\s)\]};,:.>]/.test(next)) return false;
  replaceRange(ta, s, en, ch + close, s + 1);
  return true;
}
// Typing '/' just after '<' finishes the closing tag of the innermost open element: <test>…</ becomes <test>…</test>.
function closeTagKey(e: KeyboardEvent, ta: CodeSurface, b: EditorBuffer): boolean {
  if (e.key !== '/' || !plainKey(e)) return false;
  const v = ta.value, s = ta.selectionStart, ext = extOf(b.path);
  if (s !== ta.selectionEnd || v[s - 1] !== '<' || v.length > 200000) return false;
  if (langOf(b.path)[0] !== 'html' && ext !== 'jsx' && ext !== 'tsx') return false;
  const name = openTagAt(v, s - 1, ['xml', 'svg', 'jsx', 'tsx'].includes(ext));
  if (!name) return false;
  const tail = `/${name}>`;
  replaceRange(ta, s, s, tail, s + tail.length);
  return true;
}
function editorKeys(e: KeyboardEvent): void {
  // Mid-composition keys belong to the IME; no shortcut may act on them.
  if (e.isComposing || e.keyCode === 229) return;
  const ta = surfaceOf(e.target);
  if (!ta) return;
  const b = textareaOwner.get(ta.input);
  const k = e.key.toLowerCase();
  if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter')) {
    lastUserTypeAt = Date.now(); // the tick itself comes from sfx's typing listener
  }
  if (suggestKeys(e, ta.input)) return;
  if (e.key === 'F2' && !e.ctrlKey && !e.shiftKey && !e.altKey && ta !== splitTa) { e.preventDefault(); renameSymbol(); return; }
  if (b && closeTagKey(e, ta, b)) { e.preventDefault(); return; }
  if (b && pairKey(e, ta)) { e.preventDefault(); return; }
  if (b && e.ctrlKey && e.key === ' ') { e.preventDefault(); editorSuggest(b, true); return; }
  if (b && (e.ctrlKey || e.metaKey) && !e.altKey && (k === 'z' || k === 'y')) {
    const isUndo = k === 'z' && !e.shiftKey;
    if (isUndo) {
      const topAction = actionUndoStack.at(-1);
      const isRecentTreeAction = topAction && topAction.type.startsWith('tree-') &&
        ((topAction as any).timestamp ?? 0) > (lastUserTypeAt || 0);
      if (isRecentTreeAction) {
        e.preventDefault();
        void undoAppAction();
        return;
      }
      if (b.undo.length > 0) {
        e.preventDefault();
        stepHistory(b, true);
        return;
      }
      if (actionUndoStack.length > 0) {
        e.preventDefault();
        void undoAppAction();
        return;
      }
      e.preventDefault();
      return;
    } else {
      const topRedo = actionRedoStack.at(-1);
      const isRecentTreeRedo = topRedo?.type.startsWith('tree-');
      if (isRecentTreeRedo) {
        e.preventDefault();
        void redoAppAction();
        return;
      }
      if (b.redo.length > 0) {
        e.preventDefault();
        stepHistory(b, false);
        return;
      }
      if (actionRedoStack.length > 0) {
        e.preventDefault();
        void redoAppAction();
        return;
      }
      e.preventDefault();
      return;
    }
  } else if (e.key === 'Tab' && plainKey(e)) {
    e.preventDefault();
    indentKey(ta, e.shiftKey);
  } else if (e.key === 'Enter' && plainKey(e) && !e.shiftKey) {
    e.preventDefault();
    enterKey(ta);
  }
}
// Removes one comment marker pair from a line, keeping its indentation.
function uncommentLine(l: string, open: string, close: string): string {
  const indent = l.length - l.trimStart().length;
  let body = l.slice(indent);
  if (body.startsWith(open)) body = body.slice(open.length).replace(/^ /, '');
  const trimmed = body.trimEnd();
  if (close && trimmed.endsWith(close)) body = trimmed.slice(0, -close.length).replace(/ $/, '');
  return l.slice(0, indent) + body;
}
function toggleComment(): void {
  const fe = focusedEditor();
  if (!fe) return;
  const { b, ta } = fe;
  const c = COMMENT[langOf(b.path)[0]];
  if (!c) { toast('No comment syntax for this file type'); return; }
  const [ls, le] = selectedLines(ta);
  const lines = ta.value.slice(ls, le).split('\n');
  const [open, close] = c;
  const [o, cl] = [open.trim(), close.trim()];
  const isCommented = (l: string) => !l.trim() || (l.trimStart().startsWith(o) && (!cl || l.trimEnd().endsWith(cl)));
  const uncomment = lines.every(isCommented) && lines.some(l => l.trim());
  const minIndent = Math.min(...lines.filter(l => l.trim()).map(l => l.length - l.trimStart().length));
  const out = lines.map(l => {
    if (!l.trim()) return l;
    return uncomment ? uncommentLine(l, o, cl) : l.slice(0, minIndent) + open + l.slice(minIndent) + close;
  }).join('\n');
  replaceRange(ta, ls, le, out, ls, ls + out.length);
}
function moveLines(dir: -1 | 1): void {
  const ta = focusedEditor()?.ta;
  if (!ta) return;
  const v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
  const [ls, le] = selectedLines(ta);
  const block = v.slice(ls, le);
  if (dir < 0) {
    if (ls === 0) return;
    const pls = lineStart(v, ls - 1);
    const prev = v.slice(pls, ls - 1);
    replaceRange(ta, pls, le, `${block}\n${prev}`, s - prev.length - 1, en - prev.length - 1);
  } else {
    if (le >= v.length) return;
    const nle = lineEnd(v, le + 1);
    const next = v.slice(le + 1, nle);
    replaceRange(ta, ls, nle, `${next}\n${block}`, s + next.length + 1, en + next.length + 1);
  }
}
function duplicateLines(): void {
  const ta = focusedEditor()?.ta;
  if (!ta) return;
  const s = ta.selectionStart, en = ta.selectionEnd;
  const [ls, le] = selectedLines(ta);
  const block = ta.value.slice(ls, le);
  replaceRange(ta, le, le, `\n${block}`, s + block.length + 1, en + block.length + 1);
}
function selectLine(): void {
  const ta = focusedEditor()?.ta;
  if (!ta) return;
  const [ls, le] = selectedLines(ta);
  ta.focus();
  ta.setSelectionRange(ls, Math.min(le + 1, ta.value.length));
  if (ta !== splitTa) updateCaret();
}

/* ----- Find in file ----- */
let findOpen = false;
let findHits: number[] = [];
let findIdx = -1;
let findLen = 0;
let findCase = false;
const findInput = $<HTMLInputElement>('#findInput');
const replaceInput = $<HTMLInputElement>('#replaceInput');
function openFind(replace = false): void {
  const b = activeText();
  if (!b) return;
  const sel = b.ta.value.slice(b.ta.selectionStart, b.ta.selectionEnd);
  if (sel && !sel.includes('\n')) findInput.value = sel;
  findOpen = true;
  $('#findbar').classList.remove('hidden');
  showReplace(replace);
  // Ctrl+H with a search already typed goes straight to the replacement.
  const field = replace && findInput.value ? replaceInput : findInput;
  field.focus(); field.select();
  runFind(true);
}
function showReplace(on: boolean): void {
  $('#replaceRow').classList.toggle('hidden', !on);
  $('#findToggle').setAttribute('aria-expanded', String(on));
}
function closeFind(): void {
  if (!findOpen) return;
  findOpen = false; findHits = []; findLen = 0;
  $('#findbar').classList.add('hidden');
  renderCode();
}
function runFind(jump: boolean): void {
  const b = activeText();
  const q = findInput.value;
  findHits = []; findLen = q.length;
  if (b && q) {
    const hay = findCase ? b.text : b.text.toLowerCase(), n = findCase ? q : q.toLowerCase();
    for (let i = hay.indexOf(n); i !== -1 && findHits.length < 20000; i = hay.indexOf(n, i + n.length)) findHits.push(i);
  }
  const from = b ? b.ta.selectionStart : 0;
  findIdx = findHits.length ? Math.max(0, findHits.findIndex(h => h >= from)) : -1;
  if (findIdx === -1 && findHits.length) findIdx = 0;
  if (jump) selectHit(); else { renderFindCount(); queueRender(); }
}
function renderFindCount(): void {
  let text = '';
  if (findInput.value) text = findHits.length ? `${findIdx + 1} of ${findHits.length}` : 'No results';
  $('#findCount').textContent = text;
}
function stepFind(d: number): void {
  if (!findHits.length) return;
  findIdx = (findIdx + d + findHits.length) % findHits.length;
  selectHit();
}
function selectHit(): void {
  const b = activeText();
  renderFindCount();
  if (b && findIdx >= 0) {
    const off = findHits[findIdx];
    b.ta.setSelectionRange(off, off + findLen);
    revealOffset(b, off);
  }
  renderCode();
}
findInput.addEventListener('input', () => runFind(true));
findInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); sfx.play('tick'); stepFind(e.shiftKey ? -1 : 1); }
  if (e.key === 'Escape') { e.stopPropagation(); closeFind(); activeText()?.ta.focus(); }
});
$('#findNext').onclick = () => { sfx.play('tick'); stepFind(1); };
$('#findPrev').onclick = () => { sfx.play('tick'); stepFind(-1); };
$('#findClose').onclick = () => { closeFind(); activeText()?.ta.focus(); };
$('#findCase').onclick = () => { findCase = !findCase; $('#findCase').classList.toggle('on', findCase); runFind(false); };
$('#findToggle').onclick = () => {
  const on = $('#replaceRow').classList.contains('hidden');
  showReplace(on);
  (on ? replaceInput : findInput).focus();
};
// The match under the selection is replaced; otherwise the first press only selects the next one, like VS Code.
function replaceOne(): void {
  const b = activeText();
  if (!b || findIdx < 0) return;
  const off = findHits[findIdx];
  if (b.ta.selectionStart !== off || b.ta.selectionEnd !== off + findLen) { selectHit(); return; }
  const rep = replaceInput.value;
  replaceRange(b.ta, off, off + findLen, rep, off + rep.length);
  runFind(false); // picks up the edit; the next match is the one after the replacement
  findIdx = findHits.findIndex(h => h >= off + rep.length);
  if (findIdx === -1 && findHits.length) findIdx = 0;
  selectHit();
  replaceInput.focus();
}
function replaceAll(): void {
  const b = activeText();
  if (!b || !findHits.length) return;
  const rep = replaceInput.value, n = findHits.length;
  let out = '', at = 0;
  for (const h of findHits) { out += b.text.slice(at, h) + rep; at = h + findLen; }
  out += b.text.slice(at);
  replaceRange(b.ta, 0, b.text.length, out, Math.min(b.ta.selectionStart, out.length)); // one undo step for all of them
  replaceInput.focus();
  toast(`Replaced ${n} ${n === 1 ? 'match' : 'matches'}`);
}
replaceInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.altKey) { e.preventDefault(); replaceAll(); return; }
  if (e.key === 'Enter') { e.preventDefault(); sfx.play('tick'); replaceOne(); }
  if (e.key === 'Escape') { e.stopPropagation(); closeFind(); activeText()?.ta.focus(); }
});
$('#replaceOne').onclick = () => { sfx.play('tick'); replaceOne(); };
$('#replaceAll').onclick = replaceAll;

/* ----- Go to line / file ----- */
function goToLine(): void {
  const b = activeText();
  if (!b) { toast('Open a file first'); return; }
  const total = b.text.split('\n').length;
  openModal(`<input class="input w-full" id="lineIn" aria-label="Line number" placeholder="Go to line (1 – ${total})" inputmode="numeric">`, m => {
    const input = $<HTMLInputElement>('#lineIn', m);
    input.focus();
    input.onkeydown = e => {
      if (e.key !== 'Enter') return;
      const n = clamp(Number.parseInt(input.value, 10) || 1, 1, total);
      closeModal();
      const off = offsetOf(b.text, n - 1, 0);
      b.ta.focus(); b.ta.setSelectionRange(off, off);
      revealOffset(b, off);
    };
  }, undefined, 'top');
}
// How well a path matches a quick-open query: name prefix > name > path > letters in order.
function fileScore(p: string, q: string): number {
  const name = baseName(p).toLowerCase(), full = p.toLowerCase();
  if (!q) return 1;
  if (name.startsWith(q)) return 4;
  if (name.includes(q)) return 3;
  if (full.includes(q)) return 2;
  let i = 0;
  for (const ch of full) if (ch === q[i]) i++;
  return i === q.length ? 1 : 0;
}
function quickOpen(): void {
  if (!rootInfo) { toast('Open a folder first'); return; }
  let all: string[] = [];
  let sel = 0;
  let shown: string[] = [];
  openModal(`<input class="input w-full" id="qoIn" aria-label="Search files by name" placeholder="Search files by name" spellcheck="false"><div class="qo-list" id="qoList"><div class="side-note shimmer-text">Loading</div></div>`, m => {
    const input = $<HTMLInputElement>('#qoIn', m);
    input.focus();
    const render = () => {
      const q = input.value.trim().toLowerCase();
      shown = all.map(p => [p, fileScore(p, q)] as [string, number]).filter(x => x[1] > 0)
        .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).slice(0, 60).map(x => x[0]);
      sel = clamp(sel, 0, Math.max(0, shown.length - 1));
      const rows = shown.map((p, i) => `<div class="qo-item ${i === sel ? 'on' : ''}" data-i="${i}"><span>${fileIcon(p)}&nbsp; ${esc(baseName(p))}</span><small>${esc(dirName(p))}</small></div>`);
      $('#qoList', m).innerHTML = rows.join('') || '<div class="side-note">No matching files.</div>';
      $$('[data-i]', m).forEach(el => el.onclick = () => { closeModal(); openFile(shown[Number(el.dataset.i)]); });
    };
    input.oninput = () => { sel = 0; render(); };
    input.onkeydown = e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel += e.key === 'ArrowDown' ? 1 : -1; render(); $('.qo-item.on', m)?.scrollIntoView({ block: 'nearest' }); }
      if (e.key === 'Enter' && shown[sel]) { closeModal(); openFile(shown[sel]); }
    };
    api.fs.listFiles().then(list => { all = list; render(); }, (err: unknown) => { $('#qoList', m).innerHTML = `<div class="side-note">${esc(errMsg(err))}</div>`; });
  }, undefined, 'top');
}

/* ================= Search across files ================= */
let searchCase = false;
$('#searchCase').onclick = () => { searchCase = !searchCase; $('#searchCase').classList.toggle('on', searchCase); void runSearch(); };
$('#searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') void runSearch(); });
function hitLineHtml(h: SearchHit, i: number, qLen: number): string {
  const start = Math.max(0, h.col - 30);
  const pre = h.text.slice(start, h.col).trimStart(), hit = h.text.slice(h.col, h.col + qLen), post = h.text.slice(h.col + qLen, h.col + qLen + 80);
  return `<div class="result-line" data-p="${escAttr(h.path)}" data-i="${i}">${esc(pre)}<mark>${esc(hit)}</mark>${esc(post)}</div>`;
}
// The search the results show, so they can be run again when files change.
let searched: { q: string; matchCase: boolean; root: string } | null = null;
let searchSeq = 0;
// `again` re-runs the shown search after a file change: no "Searching" flash, and the list keeps its scroll.
async function runSearch(again = false): Promise<void> {
  const q = again && searched ? searched.q : $<HTMLInputElement>('#searchInput').value;
  const matchCase = again && searched ? searched.matchCase : searchCase;
  const out = $('#searchResults');
  searched = null;
  if (!rootInfo) { out.innerHTML = '<p class="side-note">Open a folder to search it.</p>'; return; }
  if (!q) { out.innerHTML = '<p class="side-note">Type and press Enter to search across files.</p>'; return; }
  searched = { q, matchCase, root: rootInfo.root };
  const seq = ++searchSeq, scroll = out.scrollTop;
  if (!again) out.innerHTML = '<p class="side-note">Searching</p>';
  let hits: SearchHit[];
  try { hits = await api.fs.search(q, matchCase); } catch (e) { if (seq === searchSeq) out.innerHTML = `<p class="side-note">${esc(errMsg(e))}</p>`; return; }
  if (seq !== searchSeq) return; // a newer search started meanwhile
  if (again) requestAnimationFrame(() => { out.scrollTop = scroll; });
  if (!hits.length) { out.innerHTML = '<p class="side-note">No results.</p>'; return; }
  const byFile = new Map<string, SearchHit[]>();
  for (const h of hits) byFile.set(h.path, [...(byFile.get(h.path) ?? []), h]);
  const more = hits.length >= 500 ? '+' : '';
  const groups = [...byFile].map(([p, hs]) => `<div class="result-file">${fileIcon(p)} ${esc(baseName(p))} <small>${esc(dirName(p))}</small></div>` + hs.map((h, i) => hitLineHtml(h, i, q.length)).join(''));
  out.innerHTML = `<p class="side-note pt-0">${hits.length}${more} results in ${plural(byFile.size, 'file')}</p>` + groups.join('');
  $$('.result-line', out).forEach(el => el.onclick = () => {
    const h = (byFile.get(el.dataset.p as string) ?? [])[Number(el.dataset.i)];
    if (h) openFile(h.path, { line: h.line, col: h.col, len: q.length });
  });
}
// Files saved, created, deleted or changed by an agent: the shown results follow, a moment after the changes stop.
let searchAgain: TimeoutId | undefined;
api.fs.onChange(() => {
  if (!searched) return;
  clearTimeout(searchAgain);
  searchAgain = setTimeout(() => { if (searched && searched.root === rootInfo?.root) void runSearch(true); }, 400);
});

