/* ================= Word, PowerPoint, Excel and PDF files ================= */
// main/officefile.ts opens a .docx/.pptx/.xlsx as its XML parts in one text (each after a "breeze part" line) and a
// .pdf as its objects. The buffer is a text buffer holding that source, so saving, undo, unsaved dots and hot exit work
// as for code, and View → Document View switches to editing the source itself. This view shows the file as a
// document: text typed into a paragraph, a slide or a cell is written into the XML, as notebook.ts writes a notebook's
// JSON. A PDF shows in Chromium's viewer (the file as saved) and an SVG as the picture it draws; both are edited as code.
const DOC_FILE = /\.(docx|pptx|xlsx|pdf|svg)$/i;
const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_XML = 'http://www.w3.org/XML/1998/namespace';
const NS_W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
const EMU_PX = 9525; // EMUs in a CSS pixel

interface DfPart { name: string; mark: number; start: number; end: number; } // its XML is text.slice(start, end); its line starts at mark
interface DfState {
  text: string;                     // the buffer text the parts were read from or last written as
  parts: DfPart[];
  xml: Map<string, XMLDocument>;    // parts read so far
  changed: Set<string>;             // parts edited in the view, not yet written into the text
  dropped: Set<string>;             // parts to leave out when it is
  media: Record<string, string> | null;
  sheet: number;                    // the Excel sheet showing
  url?: string;                     // a PDF's viewer address
  commitTimer?: TimeoutId;
}
const dfStates = new Map<string, DfState>();
const dfRaw = new Set<string>(); // files the user switched to their source
const isDocFile = (b: EditorBuffer | undefined): b is EditorBuffer => !!b && b.kind === 'text' && !b.untitled && DOC_FILE.test(b.path);
const dfShown = (b: EditorBuffer | undefined): boolean => isDocFile(b) && !dfRaw.has(b.path);

function dfState(b: EditorBuffer): DfState {
  let s = dfStates.get(b.path);
  if (!s) { s = { text: '\0', parts: [], xml: new Map(), changed: new Set(), dropped: new Set(), media: null, sheet: 0 }; dfStates.set(b.path, s); }
  if (s.text !== b.text) dfParse(s, b.text); // first open, or the text changed under the view (code, undo, disk, an agent)
  return s;
}
function dfParse(s: DfState, text: string): void {
  s.text = text; s.parts = []; s.xml.clear(); s.changed.clear(); s.dropped.clear();
  const marks = [...text.matchAll(/^<!-- breeze part: (.+?) -->$/gm)];
  marks.forEach((m, i) => {
    const mark = m.index as number, start = mark + m[0].length + 1;
    let end = i + 1 < marks.length ? marks[i + 1].index as number : text.length;
    if (text[end - 1] === '\n') end--;
    s.parts.push({ name: m[1].trim(), mark, start: Math.min(start, end), end });
  });
}
function dfXml(s: DfState, name: string): XMLDocument | null {
  const had = s.xml.get(name);
  if (had) return had;
  const p = s.parts.find(x => x.name === name);
  if (!p) return null;
  const d = new DOMParser().parseFromString(s.text.slice(p.start, p.end), 'application/xml');
  const err = d.getElementsByTagName('parsererror')[0];
  if (err) throw new Error(`${name} isn't valid XML (${(err.textContent ?? '').trim().split('\n')[0]})`);
  s.xml.set(name, d);
  return d;
}
function dfSerialize(s: DfState, p: DfPart): string {
  const decl = /^<\?xml[^>]*\?>/.exec(s.text.slice(p.start, p.end))?.[0];
  const body = new XMLSerializer().serializeToString((s.xml.get(p.name) as XMLDocument).documentElement);
  return decl ? `${decl}\n${body}` : body;
}
// Writes the edited parts back into the buffer: one undo step, and the unsaved dot, as an edit would.
function dfCommit(b: EditorBuffer, now = false): void {
  const s = dfStates.get(b.path);
  if (!s || !b.ta) return;
  clearTimeout(s.commitTimer);
  const write = () => {
    s.commitTimer = undefined;
    if (!s.changed.size && !s.dropped.size || !b.ta || buffers.get(b.path) !== b) return;
    let text = '', at = 0;
    const parts: DfPart[] = [];
    for (const p of s.parts) {
      text += s.text.slice(at, p.mark);
      at = p.end + (s.text[p.end] === '\n' ? 1 : 0);
      if (s.dropped.has(p.name)) continue;
      const xml = s.changed.has(p.name) ? dfSerialize(s, p) : s.text.slice(p.start, p.end);
      const mark = text.length;
      text += s.text.slice(p.mark, p.start);
      parts.push({ name: p.name, mark, start: text.length, end: text.length + xml.length });
      text += xml + '\n';
    }
    text += s.text.slice(at);
    for (const n of s.dropped) s.xml.delete(n);
    s.changed.clear(); s.dropped.clear();
    if (text === b.text) return;
    s.text = text; s.parts = parts; // the parts read stay as they are: they are what was written
    if (dfBuilt.path === b.path) dfBuilt.text = text; // the view already shows it
    const focus = document.activeElement as HTMLElement | null;
    remember(b, 'command', b.ta);
    b.ta.setRangeText(text, 0, b.ta.value.length, 'start');
    b.ta.dispatchEvent(new Event('input'));
    focus?.focus({ preventScroll: true });
  };
  if (now) write(); else s.commitTimer = setTimeout(write, 400);
}
// Before saving or switching to the code: what's typed is in the text.
function dfFlush(b: EditorBuffer): void {
  const cell = document.activeElement?.closest<HTMLElement>('.df-cell');
  if (cell && dfView.contains(cell)) dfCellDone(cell);
  if (dfStates.get(b.path)?.commitTimer !== undefined) dfCommit(b, true);
}
function dfClosed(path: string): void {
  clearTimeout(dfStates.get(path)?.commitTimer);
  dfStates.delete(path);
  dfRaw.delete(path);
}

/* ----- Reading the XML ----- */
const kid = (e: Element | null | undefined, local: string): Element | null => e ? [...e.children].find(c => c.localName === local) ?? null : null;
const kids = (e: Element | null | undefined, local: string): Element[] => e ? [...e.children].filter(c => c.localName === local) : [];
const wval = (e: Element | null) => e?.getAttributeNS(NS_W, 'val') ?? e?.getAttribute('w:val') ?? '';
const rid = (e: Element, local = 'id') => e.getAttributeNS(NS_R, local) || e.getAttribute(`r:${local}`) || '';
const num = (e: Element | null, attr: string) => Number(e?.getAttribute(attr) ?? 0) || 0;
const qn = (like: Element, local: string) => like.prefix ? `${like.prefix}:${local}` : local;
const make = (like: Element, local: string) => (like.ownerDocument as XMLDocument).createElementNS(like.namespaceURI, qn(like, local));
const hexColor = (v: string | null | undefined) => v && /^[0-9a-f]{6}$/i.test(v) ? `#${v}` : '';
const fillColor = (e: Element | null) => hexColor(kid(kid(e, 'solidFill'), 'srgbClr')?.getAttribute('val'));

// The part a relationship points to, from the folder of the part that has it.
function joinPart(dir: string, target: string): string {
  const out: string[] = [];
  for (const x of (target.startsWith('/') ? target.slice(1) : dir + target).split('/')) {
    if (x === '..') out.pop(); else if (x && x !== '.') out.push(x);
  }
  return out.join('/');
}
function relsOf(s: DfState, part: string): Map<string, { target: string; type: string }> {
  const dir = part.slice(0, part.lastIndexOf('/') + 1);
  const d = dfXml(s, `${dir}_rels/${part.slice(dir.length)}.rels`);
  const m = new Map<string, { target: string; type: string }>();
  for (const r of d ? [...d.getElementsByTagName('Relationship')] : []) {
    if (r.getAttribute('TargetMode') !== 'External') m.set(r.getAttribute('Id') ?? '', { target: joinPart(dir, r.getAttribute('Target') ?? ''), type: r.getAttribute('Type') ?? '' });
  }
  return m;
}
const relOfType = (s: DfState, part: string, type: string) => [...relsOf(s, part).values()].find(r => r.type.endsWith('/' + type))?.target;

// A paragraph's own pieces (w:p or a:p), in order. Text in a picture (a text box) and deleted text aren't its own.
type DfPiece = { t: 'text' | 'tab' | 'br'; el: Element } | { t: 'img'; el: Element; embed: string };
const NOT_TEXT = new Set(['pPr', 'rPr', 'del', 'moveFrom', 'endParaRPr', 'instrText', 'delText', 'p', 'tbl']);
function pieces(p: Element, out: DfPiece[] = []): DfPiece[] {
  for (const c of p.children) {
    const n = c.localName;
    if (NOT_TEXT.has(n)) continue;
    if (n === 't') out.push({ t: 'text', el: c });
    else if (n === 'tab') out.push({ t: 'tab', el: c });
    else if (n === 'br' || n === 'cr') out.push({ t: 'br', el: c });
    else if (n === 'drawing' || n === 'pict' || n === 'object' || n === 'AlternateContent') {
      const blip = c.getElementsByTagNameNS(NS_A, 'blip')[0];
      const embed = blip ? rid(blip, 'embed') : '';
      if (embed) out.push({ t: 'img', el: c, embed });
    } else pieces(c, out);
  }
  return out;
}
const textEls = (p: Element) => pieces(p).filter(x => x.t === 'text').map(x => x.el);
function setText(t: Element, text: string): void {
  if (t.textContent === text) return;
  t.textContent = text;
  if (t.namespaceURI === NS_W) t.setAttributeNS(NS_XML, 'xml:space', 'preserve');
}
// A run with `text`, for a paragraph that had no text to type into.
function newRun(p: Element, text: string): Element {
  const r = make(p, 'r'), t = make(p, 't');
  r.append(t);
  setText(t, text);
  p.insertBefore(r, kid(p, 'endParaRPr')); // DrawingML keeps its end-of-paragraph properties last
  return t;
}

// The CSS for a run's look: Word's w:rPr or DrawingML's a:rPr (`scale`: CSS pixels per EMU, for its font size).
function runCss(t: Element, scale: number): string {
  const pr = kid(t.parentElement, 'rPr');
  if (!pr) return '';
  const css: string[] = [], deco: string[] = [];
  if (pr.namespaceURI === NS_W) {
    const on = (n: string) => { const e = kid(pr, n); return !!e && !/^(0|false|off)$/.test(wval(e)); };
    if (on('b')) css.push('font-weight:700');
    if (on('i')) css.push('font-style:italic');
    const u = kid(pr, 'u');
    if (u && wval(u) !== 'none') deco.push('underline');
    if (on('strike') || on('dstrike')) deco.push('line-through');
    const color = hexColor(wval(kid(pr, 'color')));
    if (color) css.push(`color:${color}`);
    const sz = Number(wval(kid(pr, 'sz')));
    if (sz) css.push(`font-size:${sz / 2}pt`);
    const hl = wval(kid(pr, 'highlight'));
    if (/^[a-z]+$/i.test(hl) && hl !== 'none') css.push(`background:${hl}`);
    const va = wval(kid(pr, 'vertAlign'));
    if (va === 'superscript' || va === 'subscript') css.push(`vertical-align:${va === 'superscript' ? 'super' : 'sub'};font-size:smaller`);
  } else {
    if (pr.getAttribute('b') === '1') css.push('font-weight:700');
    if (pr.getAttribute('i') === '1') css.push('font-style:italic');
    if ((pr.getAttribute('u') ?? 'none') !== 'none') deco.push('underline');
    if ((pr.getAttribute('strike') ?? 'noStrike') !== 'noStrike') deco.push('line-through');
    const sz = num(pr, 'sz');
    if (sz) css.push(`font-size:${(sz / 100) * 12700 * scale}px`);
    const color = fillColor(pr);
    if (color) css.push(`color:${color}`);
  }
  if (deco.length) css.push(`text-decoration:${deco.join(' ')}`);
  return css.join(';');
}

/* ----- The view ----- */
const dfView = document.createElement('div');
dfView.className = 'df-view hidden';
dfView.setAttribute('role', 'region');
dfView.setAttribute('aria-label', 'Document');
const dfPill = document.createElement('button');
dfPill.className = 'btn btn-sm df-pill hidden';
dfPill.innerHTML = `${svgIcon('file', 12)}<span>Document view</span>`;
dfPill.title = 'Show this file as a document again';
dfPill.onclick = () => run('df.toggleView');
$('#editor').append(dfView, dfPill);
let dfViewPath: string | null = null;
const dfBuilt = { path: '', text: '' };          // the text the view was last built from
const dfParas = new WeakMap<HTMLElement, { part: string; p: Element }>();
let dfElOf = new Map<Element, HTMLElement>();     // a paragraph's element in the view

// Called by renderEditor: true when the active buffer is a document file and this view now shows it.
function renderDocFile(b: EditorBuffer | undefined): boolean {
  dfPill.classList.toggle('hidden', !(isDocFile(b) && dfRaw.has(b.path)));
  if (!b || !dfShown(b)) {
    dfView.classList.add('hidden');
    dfViewPath = null;
    dfBuilt.path = '';
    return false;
  }
  const s = dfState(b);
  dfView.classList.remove('hidden');
  if (dfBuilt.path !== b.path || dfBuilt.text !== s.text) dfBuild(b, s);
  dfViewPath = b.path;
  return true;
}
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const DF_KINDS: Record<string, string> = { docx: 'Word document', pptx: 'PowerPoint slides', xlsx: 'Excel workbook', pdf: 'PDF', svg: 'SVG image' };
function dfBuild(b: EditorBuffer, s: DfState): void {
  const scroll = dfBuilt.path === b.path ? $$<HTMLElement>('.df-body', dfView)[0]?.scrollTop ?? 0 : 0;
  dfBuilt.path = b.path; dfBuilt.text = s.text;
  dfElOf = new Map();
  const kind = extOf(b.path);
  const bar = el('div', 'df-bar');
  bar.append(el('span', 'df-kind', DF_KINDS[kind]));
  const extra = el('span', 'df-extra');
  const end = el('span', 'df-end');
  const code = el('button', 'btn btn-sm');
  code.dataset.df = 'raw';
  code.title = { pdf: 'Edit the PDF\'s objects and page drawing commands', svg: 'Edit the SVG\'s markup' }[kind] ?? 'Edit the file\'s XML';
  code.innerHTML = `${svgIcon('code', 12)}<span>Edit as code</span>`;
  bar.append(extra, end, code);
  const page = el('div', 'df-body');
  dfView.replaceChildren(bar, page);
  if ((kind === 'docx' || kind === 'pptx') && s.media == null) {
    s.media = {};
    void api.fs.docMedia(b.path).then(m => {
      s.media = m;
      if (Object.keys(m).length && dfViewPath === b.path && dfBuilt.text === s.text) dfBuild(b, s);
    }).catch(() => {});
  }
  try {
    if (kind === 'docx') docxView(s, page);
    else if (kind === 'pptx') pptxView(s, page);
    else if (kind === 'xlsx') xlsxView(s, page, extra);
    else if (kind === 'svg') svgView(b, page, extra);
    else pdfView(b, s, page, extra);
  } catch (e) {
    const box = el('div', 'df-broken');
    box.append(el('h4', '', baseName(b.path)), el('div', '', `Breeze couldn't show this as a document: ${errMsg(e)}.`));
    const btn = el('button', 'btn btn-sm', 'Edit as code');
    btn.dataset.df = 'raw';
    box.append(btn);
    page.replaceChildren(box);
  }
  page.scrollTop = scroll;
}

// An editable paragraph, its pieces as spans (data-k: which text element of the paragraph each is).
function paraEl(s: DfState, part: string, p: Element, tag: 'p' | 'div' | `h${1 | 2 | 3 | 4 | 5 | 6}`, scale: number): HTMLElement {
  const e = el(tag, 'df-p');
  e.contentEditable = 'plaintext-only';
  e.spellcheck = true;
  dfParas.set(e, { part, p });
  dfElOf.set(p, e);
  const rels = relsOf(s, part);
  let k = 0;
  for (const x of pieces(p)) {
    if (x.t === 'text') {
      const sp = el('span', '', x.el.textContent ?? '');
      sp.dataset.k = String(k++);
      sp.style.cssText = runCss(x.el, scale);
      e.append(sp);
    } else if (x.t === 'tab') {
      const tab = el('span', 'df-tab');
      tab.contentEditable = 'false';
      e.append(tab);
    } else if (x.t === 'br') e.append(el('br'));
    else {
      const src = s.media?.[rels.get((x as { embed: string }).embed)?.target ?? ''];
      if (!src) continue;
      const img = el('img', 'df-img');
      img.src = src;
      img.contentEditable = 'false';
      img.draggable = false;
      const ext = x.el.getElementsByTagNameNS('*', 'extent')[0];
      if (ext) img.style.width = `${num(ext, 'cx') / EMU_PX}px`;
      e.append(img);
    }
  }
  return e;
}

/* ----- Word ----- */
function docxView(s: DfState, host: HTMLElement): void {
  const part = 'word/document.xml';
  const d = dfXml(s, part);
  const body = d?.getElementsByTagNameNS(NS_W, 'body')[0];
  if (!body) throw new Error('it has no word/document.xml');
  const sheet = el('div', 'df-page');
  const add = (parent: HTMLElement, node: Element) => {
    for (const c of node.children) {
      if (c.namespaceURI !== NS_W) continue;
      if (c.localName === 'p') parent.append(docxPara(s, part, c));
      else if (c.localName === 'tbl') {
        const t = el('table', 'df-table');
        for (const tr of kids(c, 'tr')) {
          const row = t.insertRow();
          for (const tc of kids(tr, 'tc')) {
            const td = row.insertCell();
            const span = Number(wval(kid(kid(tc, 'tcPr'), 'gridSpan')));
            if (span > 1) td.colSpan = span;
            add(td, tc);
          }
        }
        parent.append(t);
      } else if (c.localName === 'sdt') { const content = kid(c, 'sdtContent'); if (content) add(parent, content); }
      else if (c.localName === 'customXml' || c.localName === 'ins') add(parent, c);
    }
  };
  add(sheet, body);
  host.append(sheet);
}
function docxPara(s: DfState, part: string, p: Element): HTMLElement {
  const pr = kid(p, 'pPr');
  const style = wval(kid(pr, 'pStyle'));
  const h = /^(?:heading|Heading)\s?([1-6])$/.exec(style)?.[1];
  const tag = h ? `h${h}` as 'h1' : style === 'Title' ? 'h1' : 'p';
  const e = paraEl(s, part, p, tag, 1);
  if (style === 'Title') e.classList.add('df-title');
  if (style === 'Subtitle') e.classList.add('df-subtitle');
  if (kid(pr, 'numPr')) e.classList.add('df-li');
  const jc = wval(kid(pr, 'jc'));
  if (jc) e.style.textAlign = { center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify' }[jc] ?? '';
  const ind = kid(pr, 'ind');
  const left = Number(ind?.getAttributeNS(NS_W, 'left') ?? ind?.getAttributeNS(NS_W, 'start') ?? 0);
  if (left > 0) e.style.marginLeft = `${left / 15}px`; // twips
  return e;
}

/* ----- PowerPoint ----- */
type Box = [x: number, y: number, w: number, h: number];
const xfrmBox = (x: Element | null): Box | null => {
  const off = kid(x, 'off'), ext = kid(x, 'ext');
  return off && ext ? [num(off, 'x'), num(off, 'y'), num(ext, 'cx'), num(ext, 'cy')] : null;
};
function pptxView(s: DfState, host: HTMLElement): void {
  const pres = dfXml(s, 'ppt/presentation.xml');
  if (!pres) throw new Error('it has no ppt/presentation.xml');
  const size = pres.getElementsByTagNameNS('*', 'sldSz')[0];
  const cx = num(size, 'cx') || 12192000, cy = num(size, 'cy') || 6858000;
  // shortcut: slides are drawn at the view's width when it is built; resizing the panel doesn't redraw them.
  const W = Math.max(320, Math.min(1000, dfView.clientWidth - 64)), scale = W / cx;
  const rels = relsOf(s, 'ppt/presentation.xml');
  [...pres.getElementsByTagNameNS('*', 'sldId')].forEach((id, i) => {
    const part = rels.get(rid(id))?.target;
    const slide = part ? dfXml(s, part) : null;
    if (!part || !slide) return;
    const layout = relOfType(s, part, 'slideLayout');
    const master = layout ? relOfType(s, layout, 'slideMaster') : undefined;
    const box = el('div', 'df-slide');
    box.style.width = `${W}px`;
    box.style.height = `${cy * scale}px`;
    const bg = [slide, layout && dfXml(s, layout), master && dfXml(s, master)].map(d => d && fillColor(d.getElementsByTagNameNS('*', 'bgPr')[0] ?? null)).find(Boolean);
    if (bg) box.style.background = bg;
    const tree = slide.getElementsByTagNameNS('*', 'spTree')[0];
    if (tree) pptxShapes(s, part, [layout, master], tree, box, scale, b => b);
    host.append(el('div', 'df-slide-no', `Slide ${i + 1}`), box);
  });
}
// The layout's (else the master's) shape for a placeholder, which gives what the slide's own shape leaves out.
function placeholderShapes(s: DfState, ph: Element, from: (string | undefined)[]): Element[] {
  const out: Element[] = [];
  const kindOf = (t: string | null) => ({ ctrTitle: 'title', subTitle: 'body', obj: 'body' } as Record<string, string>)[t ?? 'body'] ?? t ?? 'body';
  const type = kindOf(ph.getAttribute('type')), idx = ph.getAttribute('idx');
  for (const part of from) {
    const d = part ? dfXml(s, part) : null;
    for (const sp of d ? [...d.getElementsByTagNameNS('*', 'sp')] : []) {
      const q = sp.getElementsByTagNameNS('*', 'ph')[0];
      if (!q || !(idx != null && q.getAttribute('idx') === idx || kindOf(q.getAttribute('type')) === type)) continue;
      out.push(sp);
      break;
    }
  }
  return out;
}
// Office's own defaults, in points, where neither the slide nor its layout sets a size.
const PH_SIZES: Record<string, number> = { ctrTitle: 54, title: 40, subTitle: 24, body: 24 };
function pptxShapes(s: DfState, part: string, from: (string | undefined)[], tree: Element, host: HTMLElement, scale: number, map: (b: Box) => Box): void {
  const rels = relsOf(s, part);
  const place = (box: Box, e: HTMLElement) => {
    const [x, y, w, h] = map(box);
    Object.assign(e.style, { left: `${x * scale}px`, top: `${y * scale}px`, width: `${w * scale}px`, height: `${h * scale}px` });
    host.append(e);
  };
  for (const c of tree.children) {
    const n = c.localName;
    if (n === 'sp') {
      const pr = kid(c, 'spPr');
      const ph = c.getElementsByTagNameNS('*', 'ph')[0];
      const inherited = ph ? placeholderShapes(s, ph, from) : [];
      const chain = [c, ...inherited];
      const box = chain.map(x => xfrmBox(kid(kid(x, 'spPr'), 'xfrm'))).find(Boolean);
      const body = kid(c, 'txBody');
      if (!box || !body && !fillColor(pr)) continue;
      const e = el('div', 'df-shape');
      const fill = fillColor(pr);
      if (fill) e.style.background = fill;
      const type = ph ? ph.getAttribute('type') ?? 'body' : '';
      const lvl1 = (x: Element) => kid(kid(kid(x, 'txBody'), 'lstStyle'), 'lvl1pPr');
      const sz = chain.map(x => num(kid(lvl1(x), 'defRPr'), 'sz') / 100).find(Boolean) ?? PH_SIZES[type] ?? 18;
      e.style.fontSize = `${sz * 12700 * scale}px`;
      const algn = chain.map(x => lvl1(x)?.getAttribute('algn')).find(Boolean) ?? (type === 'ctrTitle' || type === 'subTitle' ? 'ctr' : '');
      if (algn) e.style.textAlign = { ctr: 'center', r: 'right', just: 'justify' }[algn] ?? '';
      const anchor = chain.map(x => kid(kid(x, 'txBody'), 'bodyPr')?.getAttribute('anchor')).find(Boolean) ?? (type === 'ctrTitle' ? 'b' : type === 'title' ? 'ctr' : 't');
      e.style.justifyContent = anchor === 'ctr' ? 'center' : anchor === 'b' ? 'flex-end' : 'flex-start';
      const bullets = type === 'body' || type === 'obj'; // a content placeholder lists its lines, unless a line says not to
      for (const p of kids(body, 'p')) e.append(pptxPara(s, part, p, scale, bullets));
      place(box, e);
    } else if (n === 'pic') {
      const blip = c.getElementsByTagNameNS(NS_A, 'blip')[0];
      const src = blip && s.media?.[rels.get(rid(blip, 'embed'))?.target ?? ''];
      const box = xfrmBox(kid(kid(c, 'spPr'), 'xfrm'));
      if (!src || !box) continue;
      const img = el('img', 'df-pic');
      img.src = src;
      img.draggable = false;
      place(box, img);
    } else if (n === 'grpSp') {
      const x = kid(kid(c, 'grpSpPr'), 'xfrm');
      const outer = xfrmBox(x), chOff = kid(x, 'chOff'), chExt = kid(x, 'chExt');
      if (!outer || !chOff || !chExt) { pptxShapes(s, part, from, c, host, scale, map); continue; }
      const sx = outer[2] / (num(chExt, 'cx') || 1), sy = outer[3] / (num(chExt, 'cy') || 1);
      pptxShapes(s, part, from, c, host, scale, ([bx, by, bw, bh]) => map([outer[0] + (bx - num(chOff, 'x')) * sx, outer[1] + (by - num(chOff, 'y')) * sy, bw * sx, bh * sy]));
    } else if (n === 'graphicFrame') {
      const tbl = c.getElementsByTagNameNS(NS_A, 'tbl')[0];
      const box = xfrmBox(kid(c, 'xfrm'));
      if (!tbl || !box) continue;
      const t = el('table', 'df-table df-shape-table');
      t.style.fontSize = `${18 * 12700 * scale}px`;
      for (const tr of kids(tbl, 'tr')) {
        const row = t.insertRow();
        for (const tc of kids(tr, 'tc')) {
          if (tc.getAttribute('hMerge') === '1' || tc.getAttribute('vMerge') === '1') continue;
          const td = row.insertCell();
          td.colSpan = num(tc, 'gridSpan') || 1;
          td.rowSpan = num(tc, 'rowSpan') || 1;
          for (const p of kids(kid(tc, 'txBody'), 'p')) td.append(pptxPara(s, part, p, scale));
        }
      }
      const wrap = el('div', 'df-shape');
      wrap.append(t);
      place(box, wrap);
    }
  }
}
function pptxPara(s: DfState, part: string, p: Element, scale: number, bullets = false): HTMLElement {
  const e = paraEl(s, part, p, 'div', scale);
  const algn = kid(p, 'pPr')?.getAttribute('algn');
  if (algn) e.style.textAlign = { ctr: 'center', r: 'right', just: 'justify' }[algn] ?? '';
  const pr = kid(p, 'pPr');
  if (kid(pr, 'buChar') || bullets && !kid(pr, 'buNone') && (p.textContent ?? '').trim()) e.classList.add('df-li');
  return e;
}

/* ----- Excel ----- */
const colName = (n: number) => { let s = ''; for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
const colNum = (s: string) => [...s].reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0) - 1;
interface Sheet { name: string; part: string; }
function xlsxSheets(s: DfState): Sheet[] {
  const wb = dfXml(s, 'xl/workbook.xml');
  if (!wb) throw new Error('it has no xl/workbook.xml');
  const rels = relsOf(s, 'xl/workbook.xml');
  return [...wb.getElementsByTagNameNS('*', 'sheet')].map(e => ({ name: e.getAttribute('name') ?? '', part: rels.get(rid(e))?.target ?? '' })).filter(x => x.part && s.parts.some(p => p.name === x.part));
}
function xlsxStrings(s: DfState): string[] {
  const part = relOfType(s, 'xl/workbook.xml', 'sharedStrings');
  const d = part ? dfXml(s, part) : null;
  return d ? [...d.documentElement.children].filter(c => c.localName === 'si').map(si => [...si.getElementsByTagNameNS('*', 't')].filter(t => t.parentElement?.localName !== 'rPh').map(t => t.textContent).join('')) : [];
}
// Rows and cells by number and reference, giving any without one their place (written with the next edit).
function sheetCells(d: XMLDocument): { data: Element; cells: Map<string, Element>; rows: number; cols: number } {
  const data = d.getElementsByTagNameNS('*', 'sheetData')[0];
  if (!data) throw new Error('a sheet has no cells');
  const cells = new Map<string, Element>();
  let r = 0, rows = 0, cols = 0;
  for (const row of kids(data, 'row')) {
    r = Number(row.getAttribute('r')) || r + 1;
    row.setAttribute('r', String(r));
    let c = -1;
    for (const cell of kids(row, 'c')) {
      const m = /^([A-Z]+)(\d+)$/.exec(cell.getAttribute('r') ?? '');
      c = m ? colNum(m[1]) : c + 1;
      const ref = colName(c) + r;
      cell.setAttribute('r', ref);
      cells.set(ref, cell);
      cols = Math.max(cols, c + 1);
    }
    rows = r;
  }
  return { data, cells, rows, cols };
}
function cellShown(c: Element | undefined, strings: string[]): string {
  if (!c) return '';
  const v = kid(c, 'v')?.textContent ?? '';
  switch (c.getAttribute('t')) {
    case 's': return strings[Number(v)] ?? '';
    case 'inlineStr': return [...(kid(c, 'is')?.getElementsByTagNameNS('*', 't') ?? [])].map(t => t.textContent).join('');
    case 'b': return v === '1' ? 'TRUE' : 'FALSE';
    default: return v;
  }
}
const cellRaw = (c: Element | undefined, strings: string[]) => {
  const f = kid(c, 'f')?.textContent;
  return f ? `=${f}` : cellShown(c, strings);
};
// shortcut: at most this many cells are drawn (rows are cut to fit); the rest of a big sheet is edited as code.
const XLSX_MAX_CELLS = 40_000;
function xlsxView(s: DfState, host: HTMLElement, bar: HTMLElement): void {
  const sheets = xlsxSheets(s);
  if (!sheets.length) throw new Error('it has no sheets');
  s.sheet = Math.min(s.sheet, sheets.length - 1);
  sheets.forEach((sh, i) => {
    const tab = el('button', `btn btn-sm df-sheet${i === s.sheet ? ' on' : ''}`, sh.name);
    tab.dataset.df = 'sheet';
    tab.dataset.i = String(i);
    bar.append(tab);
  });
  const part = sheets[s.sheet].part;
  const { cells, rows, cols: used } = sheetCells(dfXml(s, part) as XMLDocument);
  const strings = xlsxStrings(s);
  const cols = Math.min(200, Math.max(used + 3, 10));
  const all = Math.max(rows + 20, 30), shown = Math.min(all, Math.floor(XLSX_MAX_CELLS / cols));
  const t = el('table', 'df-grid');
  t.dataset.part = part;
  const head = t.createTHead().insertRow();
  head.append(el('th'));
  for (let c = 0; c < cols; c++) head.append(el('th', '', colName(c)));
  const body = t.createTBody();
  for (let r = 1; r <= shown; r++) {
    const row = body.insertRow();
    row.append(el('th', '', String(r)));
    for (let c = 0; c < cols; c++) {
      const ref = colName(c) + r, cell = cells.get(ref);
      const td = row.insertCell();
      td.className = 'df-cell';
      td.dataset.ref = ref;
      td.contentEditable = 'plaintext-only';
      td.spellcheck = false;
      td.textContent = cellShown(cell, strings);
      if (cell && !cell.getAttribute('t') && kid(cell, 'v')) td.classList.add('num');
    }
  }
  host.append(t);
  if (shown < all) host.append(el('div', 'df-note', `Showing the first ${shown} rows. Edit as code to change the rest.`));
}
function dfCellStart(td: HTMLElement): void {
  const a = dfActive();
  const part = td.closest<HTMLElement>('.df-grid')?.dataset.part;
  if (!a || !part || td.dataset.was != null) return;
  const cell = sheetCells(dfXml(a.s, part) as XMLDocument).cells.get(td.dataset.ref ?? '');
  td.dataset.was = cellRaw(cell, xlsxStrings(a.s));
  td.textContent = td.dataset.was;
}
// The cell's typing goes into the sheet: a number, a formula (=…), text, or nothing.
function dfCellDone(td: HTMLElement, keep = true): void {
  const a = dfActive();
  const part = td.closest<HTMLElement>('.df-grid')?.dataset.part;
  const was = td.dataset.was;
  delete td.dataset.was;
  if (!a || !part || was == null) return;
  const raw = (td.textContent ?? '').replace(/\n+$/, '');
  if (keep && raw !== was) {
    setCell(a.s, part, td.dataset.ref ?? '', raw);
    dfCommit(a.b, true);
  }
  const cell = sheetCells(dfXml(a.s, part) as XMLDocument).cells.get(td.dataset.ref ?? '');
  td.textContent = cellShown(cell, xlsxStrings(a.s));
  if (cell?.getAttribute('t') === null && kid(cell, 'f') && !kid(cell, 'v')) td.textContent = cellRaw(cell, []); // a new formula: Excel works it out on opening
  td.classList.toggle('num', !!cell && !cell.getAttribute('t') && !!kid(cell, 'v'));
}
function setCell(s: DfState, part: string, ref: string, raw: string): void {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) return;
  const { data, cells } = sheetCells(dfXml(s, part) as XMLDocument);
  const col = colNum(m[1]), r = Number(m[2]);
  let c = cells.get(ref);
  if (!c) {
    if (!raw) return;
    let row = kids(data, 'row').find(x => Number(x.getAttribute('r')) === r);
    if (!row) {
      row = make(data, 'row');
      row.setAttribute('r', String(r));
      data.insertBefore(row, kids(data, 'row').find(x => Number(x.getAttribute('r')) > r) ?? null);
    }
    c = make(data, 'c');
    c.setAttribute('r', ref);
    row.insertBefore(c, kids(row, 'c').find(x => colNum(/^[A-Z]+/.exec(x.getAttribute('r') ?? '')?.[0] ?? 'A') > col) ?? null);
  }
  const f = kid(c, 'f');
  // A formula other cells share goes with this one: they keep the values it last gave them.
  if (f?.getAttribute('t') === 'shared' && f.hasAttribute('ref')) {
    for (const g of [...data.getElementsByTagNameNS('*', 'f')]) if (g !== f && g.getAttribute('t') === 'shared' && g.getAttribute('si') === f.getAttribute('si')) g.remove();
  }
  for (const x of [...c.children]) x.remove();
  c.removeAttribute('t');
  const formula = raw.length > 1 && raw.startsWith('=');
  if (formula) { const e = make(c, 'f'); e.textContent = raw.slice(1); c.append(e); }
  else if (/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(raw.trim())) { const v = make(c, 'v'); v.textContent = raw.trim(); c.append(v); }
  else if (raw) {
    c.setAttribute('t', 'inlineStr');
    const is = make(c, 'is'), t = make(c, 't');
    t.textContent = raw;
    if (raw.trim() !== raw) t.setAttributeNS(NS_XML, 'xml:space', 'preserve');
    is.append(t); c.append(is);
  } else if (!c.hasAttribute('s')) c.remove();
  s.changed.add(part);
  recalcOnOpen(s, !!(formula || f));
}
// Excel works formulas out again on opening (a value they use may have changed), and when a formula itself changed, its
// list of formula cells (calcChain.xml), now out of date, goes.
function recalcOnOpen(s: DfState, formulas: boolean): void {
  const wb = dfXml(s, 'xl/workbook.xml') as XMLDocument;
  const root = wb.documentElement;
  let calc = kid(root, 'calcPr');
  if (!calc) {
    calc = make(root, 'calcPr');
    const after = new Set(['oleSize', 'customWorkbookViews', 'pivotCaches', 'smartTagPr', 'smartTagTypes', 'webPublishing', 'fileRecoveryPr', 'webPublishObjects', 'extLst']);
    root.insertBefore(calc, [...root.children].find(x => after.has(x.localName)) ?? null);
  }
  if (calc.getAttribute('fullCalcOnLoad') !== '1') { calc.setAttribute('fullCalcOnLoad', '1'); s.changed.add('xl/workbook.xml'); }
  if (!formulas) return;
  const chain = relOfType(s, 'xl/workbook.xml', 'calcChain');
  if (!chain || !s.parts.some(p => p.name === chain)) return;
  s.dropped.add(chain);
  const rels = dfXml(s, 'xl/_rels/workbook.xml.rels');
  for (const r of rels ? [...rels.getElementsByTagName('Relationship')] : []) if ((r.getAttribute('Type') ?? '').endsWith('/calcChain')) r.remove();
  s.changed.add('xl/_rels/workbook.xml.rels');
  const types = dfXml(s, '[Content_Types].xml');
  for (const o of types ? [...types.getElementsByTagName('Override')] : []) if (o.getAttribute('PartName') === `/${chain}`) o.remove();
  s.changed.add('[Content_Types].xml');
}

/* ----- SVG ----- */
// The picture the markup draws, from the editor's text (unsaved changes too). As an <img>, so its scripts never run.
function svgView(b: EditorBuffer, host: HTMLElement, bar: HTMLElement): void {
  const note = (text: string) => host.replaceChildren(el('div', 'df-note', text));
  if (!b.text.trim()) { note('This SVG is empty. Edit as code to draw something.'); return; }
  const stage = el('div', 'df-svg');
  const img = el('img');
  img.alt = baseName(b.path);
  img.draggable = false;
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(b.text)}`;
  const dims = el('span', 'df-note');
  img.onload = () => { dims.textContent = `${img.naturalWidth} × ${img.naturalHeight}`; };
  img.onerror = () => note('This SVG has a mistake in its markup, so it can\'t be drawn. Edit as code to fix it.');
  bar.append(dims);
  stage.append(img);
  host.append(stage);
}

/* ----- PDF ----- */
function pdfView(b: EditorBuffer, s: DfState, host: HTMLElement, bar: HTMLElement): void {
  if (isDirty(b)) bar.append(el('span', 'df-note', 'Showing the saved file. Save to see your code changes here.'));
  const frame = el('iframe', 'pdf-frame df-pdf');
  frame.title = baseName(b.path);
  host.append(frame);
  const load = (url: string) => { frame.src = `${url}?v=${Date.now()}`; }; // a new address, so a saved file loads again
  if (s.url) load(s.url);
  else void api.fs.previewUrl(b.path).then(url => { s.url = url; load(url); }).catch(() => {});
}

/* ----- Editing ----- */
const dfActive = (): { b: EditorBuffer; s: DfState } | null => {
  const b = activeBuf();
  return b && dfShown(b) && dfViewPath === b.path ? { b, s: dfState(b) } : null;
};
// What's typed in a paragraph goes into its text elements: each span into its own, text outside them into the one before.
function readPara(s: DfState, e: HTMLElement): void {
  const info = dfParas.get(e);
  if (!info) return;
  const ts = textEls(info.p);
  const got = ts.map(() => '');
  let last = -1, lead = '';
  const walk = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const text = (n as Text).data.replace(/[ \n]/g, ' ');
    const sp = n.parentElement?.closest<HTMLElement>('[data-k]');
    if (sp && e.contains(sp)) last = Number(sp.dataset.k);
    if (last >= 0) got[last] += text; else lead += text;
  }
  if (lead && !ts.length) { ts.push(newRun(info.p, '')); got.push(''); }
  if (lead) got[0] = lead + got[0];
  ts.forEach((t, k) => setText(t, got[k]));
  s.changed.add(info.part);
}
function caretIn(e: HTMLElement): number | null {
  const sel = getSelection();
  if (!sel?.rangeCount || !sel.isCollapsed || !e.contains(sel.anchorNode)) return null;
  const r = document.createRange();
  r.selectNodeContents(e);
  r.setEnd(sel.anchorNode as Node, sel.anchorOffset);
  return r.toString().length;
}
function placeCaret(e: HTMLElement | undefined, off: number): void {
  if (!e) return;
  e.focus({ preventScroll: true });
  const walk = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
  let n = walk.nextNode() as Text | null, at: [Node, number] = [e, 0];
  for (; n; n = walk.nextNode() as Text | null) {
    if (off <= n.length) { at = [n, off]; break; }
    off -= n.length;
    at = [n, n.length];
  }
  getSelection()?.collapse(at[0], at[1]);
  e.scrollIntoView({ block: 'nearest' });
}
// Enter: the paragraph splits at the caret into two with the same look.
function splitPara(b: EditorBuffer, s: DfState, e: HTMLElement): void {
  const info = dfParas.get(e);
  if (!info) return;
  const sel = getSelection();
  if (sel?.rangeCount) sel.getRangeAt(0).deleteContents();
  readPara(s, e);
  const off = caretIn(e) ?? (e.textContent ?? '').length;
  const p = info.p, q = p.cloneNode(true) as Element;
  // Where the caret is among the pieces: text piece `at`, `o` characters in.
  const ps = pieces(p), qs = pieces(q);
  let at = ps.findIndex(x => x.t === 'text'), o = off;
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].t !== 'text') continue;
    at = i;
    const len = (ps[i].el.textContent ?? '').length;
    if (o <= len) break;
    o -= len;
  }
  ps.forEach((x, i) => { if (at === -1 || i > at) x.t === 'text' ? setText(x.el, '') : x.el.remove(); else if (i === at) setText(x.el, (x.el.textContent ?? '').slice(0, o)); });
  qs.forEach((x, i) => { if (at !== -1 && i < at) x.t === 'text' ? setText(x.el, '') : x.el.remove(); else if (i === at) setText(x.el, (x.el.textContent ?? '').slice(o)); });
  if (p.namespaceURI === NS_W) {
    // The section break stays with the paragraph that ends the section; bookmarks and Word's paragraph ids aren't copied.
    for (const x of [...p.getElementsByTagNameNS(NS_W, 'sectPr')]) x.remove();
    for (const x of [...q.getElementsByTagNameNS(NS_W, 'bookmarkStart'), ...q.getElementsByTagNameNS(NS_W, 'bookmarkEnd')]) x.remove();
    q.removeAttributeNS(NS_W14, 'paraId');
    q.removeAttributeNS(NS_W14, 'textId');
  }
  p.after(q);
  s.changed.add(info.part);
  dfCommit(b, true);
  dfBuild(b, s);
  placeCaret(dfElOf.get(q), 0);
}
// Backspace at a paragraph's start (or Delete at its end): it joins the one before (after).
function joinParas(b: EditorBuffer, s: DfState, first: Element, second: Element, part: string): boolean {
  if (first.localName !== 'p' || second.localName !== 'p' || second.getElementsByTagNameNS(NS_W, 'sectPr').length) return false;
  const caret = textEls(first).reduce((n, t) => n + (t.textContent ?? '').length, 0);
  const end = kid(first, 'endParaRPr');
  for (const c of [...second.children]) if (c.localName !== 'pPr' && c.localName !== 'endParaRPr') first.insertBefore(c, end);
  second.remove();
  s.changed.add(part);
  dfCommit(b, true);
  dfBuild(b, s);
  placeCaret(dfElOf.get(first), caret);
  return true;
}
function dfUndo(b: EditorBuffer, back: boolean): void {
  dfFlush(b);
  if (b.ta) stepHistory(b, back, b.ta); // the text changes under the view, which is built again from it
}

dfView.addEventListener('input', e => {
  const p = (e.target as HTMLElement).closest<HTMLElement>('.df-p');
  const a = dfActive();
  if (!p || !a) return;
  readPara(a.s, p);
  dfCommit(a.b);
});
dfView.addEventListener('beforeinput', e => {
  if (e.inputType !== 'historyUndo' && e.inputType !== 'historyRedo') return;
  const a = dfActive();
  if (!a) return;
  e.preventDefault();
  dfUndo(a.b, e.inputType === 'historyUndo');
});
dfView.addEventListener('focusin', e => {
  const td = (e.target as HTMLElement).closest<HTMLElement>('.df-cell');
  if (td) dfCellStart(td);
});
dfView.addEventListener('focusout', e => {
  const td = (e.target as HTMLElement).closest<HTMLElement>('.df-cell');
  if (td) dfCellDone(td);
});
dfView.addEventListener('click', e => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-df]');
  if (!btn) return;
  if (btn.dataset.df === 'raw') { run('df.toggleView'); return; }
  const a = dfActive();
  if (btn.dataset.df === 'sheet' && a) { a.s.sheet = Number(btn.dataset.i); dfBuilt.path = ''; dfBuild(a.b, a.s); }
});
dfView.addEventListener('keydown', e => {
  const t = e.target as HTMLElement;
  const a = dfActive();
  if (!a) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey && (e.key === 'z' || e.key === 'Z' || e.key === 'y')) {
    e.preventDefault(); e.stopPropagation();
    dfUndo(a.b, e.key === 'z' && !e.shiftKey);
    return;
  }
  const td = t.closest<HTMLTableCellElement>('.df-cell');
  if (td) {
    if (e.key === 'Escape') { e.preventDefault(); dfCellDone(td, false); td.blur(); return; }
    if (e.key !== 'Enter' && e.key !== 'Tab' || mod || e.altKey) return;
    e.preventDefault(); e.stopPropagation();
    const row = td.parentElement as HTMLTableRowElement, i = td.cellIndex;
    const next = e.key === 'Tab'
      ? row.cells[i + (e.shiftKey ? -1 : 1)]
      : (row.parentElement as HTMLTableSectionElement).rows[row.sectionRowIndex + (e.shiftKey ? -1 : 1)]?.cells[i];
    if (next?.classList.contains('df-cell')) next.focus(); else td.blur();
    return;
  }
  const p = t.closest<HTMLElement>('.df-p');
  const info = p && dfParas.get(p);
  if (!p || !info || mod || e.altKey) return;
  if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); splitPara(a.b, a.s, p); return; }
  const at = caretIn(p);
  if (e.key === 'Backspace' && at === 0) {
    const prev = info.p.previousElementSibling;
    if (prev && joinParas(a.b, a.s, prev, info.p, info.part)) e.preventDefault();
  } else if (e.key === 'Delete' && at === (p.textContent ?? '').length) {
    const next = info.p.nextElementSibling;
    if (next && joinParas(a.b, a.s, info.p, next, info.part)) e.preventDefault();
  }
});

// View → Document View: the file as a document, or its source in the editor.
let dfFade: Animation | null = null;
commands['df.toggleView'] = () => {
  const b = activeBuf();
  if (!isDocFile(b)) { toast('Open a Word, PowerPoint, Excel, PDF or SVG file first'); return; }
  const toDoc = dfRaw.has(b.path);
  if (toDoc) dfRaw.delete(b.path); else { dfFlush(b); dfRaw.add(b.path); }
  dfFade?.cancel();
  renderEditor();
  // The document view lies over the code, so fading it in or out cross-fades the two. Going to code, it stays up
  // (click-through) just long enough to fade away.
  if (!toDoc) { dfView.classList.remove('hidden'); dfView.style.pointerEvents = 'none'; }
  const fade = dfFade = dfView.animate([{ opacity: toDoc ? 0 : 1 }, { opacity: toDoc ? 1 : 0 }], { duration: 200, easing: 'ease-out' });
  if (!toDoc) fade.onfinish = fade.oncancel = () => { dfView.style.pointerEvents = ''; if (dfViewPath == null) dfView.classList.add('hidden'); };
};
