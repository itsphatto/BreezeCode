/* ================= Layout: resizable, collapsible panels ================= */
interface Layout { side: number; agents: number; term: number; preview: number; sideOpen: boolean; agentsOpen: boolean; termOpen: boolean; previewOpen: boolean; view: string; }
type SashKind = 'side' | 'agents' | 'preview' | 'term';
const DEFAULT_LAYOUT: Layout = { side: 240, agents: 340, term: 200, preview: 460, sideOpen: true, agentsOpen: true, termOpen: false, previewOpen: true, view: 'files' };
const layout: Layout = { ...DEFAULT_LAYOUT, ...store.get<Partial<Layout>>('breeze.layout', {}) };
function applyLayout(): void {
  const main = $('#main'), work = $('#work'), t = $('#terminal');
  main.style.setProperty('--side-w', layout.sideOpen ? `${layout.side}px` : '0px');
  main.style.setProperty('--agents-w', layout.agentsOpen ? `${layout.agents}px` : '0px');
  main.classList.toggle('no-side', !layout.sideOpen);
  main.classList.toggle('no-agents', !layout.agentsOpen);
  const maxPreview = work.clientWidth ? work.clientWidth - 220 : layout.preview;
  // The inline width beats the .no-preview rule, so a closed preview has to be zeroed here or its column stays as a blank gap.
  work.style.setProperty('--preview-w', layout.previewOpen ? `${clamp(layout.preview, 220, Math.max(220, maxPreview))}px` : '0px');
  work.classList.toggle('no-preview', !layout.previewOpen);
  t.style.setProperty('--term-h', `${clamp(layout.term, 80, Math.max(80, innerHeight - 220))}px`);
  t.classList.toggle('open', layout.termOpen);
  void setIcon($('#termTitle'), layout.termOpen ? 'chevronDown' : 'chevronRight');
  const icon = (id: string, sym: string, on: boolean) => $(`#${id} use`).setAttribute('href', `#i-${sym}${on ? '-on' : ''}`);
  icon('tglSide', 'left', layout.sideOpen); icon('tglTerm', 'bottom', layout.termOpen); icon('tglAgents', 'right', layout.agentsOpen);
  store.set('breeze.layout', layout);
  syncScroll();
  updateActIndicator();
  setTimeout(placeSashes); // after this script has set the sash layer up
}
window.addEventListener('resize', applyLayout);
// Dragging below a threshold collapses the panel; dragging back out reopens it.
const SASH_DRAG: Record<SashKind, (start: Layout, dx: number, dy: number) => void> = {
  side: (start, dx) => { const w = start.side + dx; layout.sideOpen = w >= 120; if (layout.sideOpen) layout.side = clamp(w, 170, 640); },
  agents: (start, dx) => { const w = start.agents - dx; layout.agentsOpen = w >= 180; if (layout.agentsOpen) layout.agents = clamp(w, 260, 720); },
  preview: (start, dx) => { const w = start.preview - dx; layout.previewOpen = w >= 140; if (layout.previewOpen) layout.preview = clamp(w, 220, $('#work').clientWidth - 220); },
  term: (start, _dx, dy) => { const h = start.term - dy; layout.termOpen = h >= 60; if (layout.termOpen) layout.term = clamp(h, 80, innerHeight - 220); },
};
// Sashes sit in the middle of the gap between two cards: both the grab area and the line it lights.
// The cards clip their contents, so the sashes are lifted out into one fixed layer and placed from their card's box.
const sashLine = document.body.appendChild(document.createElement('div'));
sashLine.className = 'sash-line';
const sashLayer = document.body.appendChild(document.createElement('div'));
sashLayer.className = 'sash-layer';
const sashCards = new Map<HTMLElement, HTMLElement>();
$$<HTMLElement>('[data-sash]').forEach(sash => { sashCards.set(sash, sash.parentElement as HTMLElement); sashLayer.append(sash); });
const SASH_GRAB = 8;
// Where a sash's gap is: [left, top, width, height] of the gap's centre line, or null while its card isn't shown.
function sashGap(sash: HTMLElement): [number, number, number, number] | null {
  const cardEl = sashCards.get(sash);
  if (!cardEl?.offsetParent) return null;
  const kind = sash.dataset.sash;
  if (kind === 'term' && !cardEl.classList.contains('open')) return null;
  // A closed preview keeps its (zero-width) card in the layout; its sash would sit on the editor's edge and resize
  // nothing useful, since the editor and agents already share the sash beside the agents panel.
  if (kind === 'preview' && !layout.previewOpen) return null;
  const card = cardEl.getBoundingClientRect();
  const half = (Number.parseFloat(getComputedStyle($('#main')).getPropertyValue('--gap')) || 6) / 2;
  return kind === 'term'
    ? [card.left, card.top - half, card.width, 0]
    : [kind === 'side' ? card.right + half : card.left - half, card.top, 0, card.height];
}
function placeSashes(): void {
  for (const sash of sashCards.keys()) {
    const g = sashGap(sash);
    sash.hidden = !g;
    if (!g) continue;
    const [x, y, w, h] = g;
    const box = w ? [x, y - SASH_GRAB / 2, w, SASH_GRAB] : [x - SASH_GRAB / 2, y, SASH_GRAB, h];
    Object.assign(sash.style, { left: `${box[0]}px`, top: `${box[1]}px`, width: `${box[2]}px`, height: `${box[3]}px` });
  }
}
const sashWatch = new ResizeObserver(() => placeSashes());
new Set(sashCards.values()).forEach(c => sashWatch.observe(c));
[document.body, $('#main'), $('#work')].forEach(el => sashWatch.observe(el));
// Panels slide when they open, close or reset; settle the sashes once the slide ends.
[$('#main'), $('#work')].forEach(el => el.addEventListener('transitionend', e => { if (e.target === el) placeSashes(); }));
placeSashes();
addEventListener('load', placeSashes);
// The app's intro scales the whole window in; boxes measured mid-intro are off, so settle again when it ends.
$('#ide').addEventListener('animationend', e => { if (e.target === e.currentTarget) placeSashes(); });
$('#main').addEventListener('pointerenter', placeSashes); // a cheap re-check whenever the pointer comes back to the panels
void document.fonts.ready.then(placeSashes);
function placeSashLine(sash: HTMLElement | null): void {
  sashLine.classList.toggle('on', !!sash);
  const g = sash && sashGap(sash);
  if (!g) return;
  const [x, y, w, h] = g;
  const box = w ? [x, y - 1, w, 2] : [x - 1, y, 2, h];
  Object.assign(sashLine.style, { left: `${box[0]}px`, top: `${box[1]}px`, width: `${box[2]}px`, height: `${box[3]}px` });
}
function startSashDrag(sash: HTMLElement, kind: SashKind, e: PointerEvent): void {
  const sx = e.clientX, sy = e.clientY, start = { ...layout };
  if (kind === 'preview') start.preview = $('#previewPane').getBoundingClientRect().width;
  document.body.classList.add(kind === 'term' ? 'resizing-h' : 'resizing');
  sash.classList.add('active');
  placeSashLine(sash);
  const move = (ev: PointerEvent) => { SASH_DRAG[kind](start, ev.clientX - sx, ev.clientY - sy); applyLayout(); placeSashes(); placeSashLine(sash); };
  const up = (ev: PointerEvent) => {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up);
    document.body.classList.remove('resizing', 'resizing-h'); sash.classList.remove('active');
    placeSashLine((ev.target as HTMLElement)?.closest?.<HTMLElement>('[data-sash]') === sash ? sash : null);
    if (layout.side !== start.side || layout.agents !== start.agents || layout.preview !== start.preview || layout.term !== start.term || layout.sideOpen !== start.sideOpen || layout.agentsOpen !== start.agentsOpen || layout.previewOpen !== start.previewOpen || layout.termOpen !== start.termOpen) {
      pushAppAction({ type: 'layout', prev: start, next: { ...layout } });
    }
  };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
}
$$<HTMLElement>('[data-sash]').forEach(sash => {
  const kind = sash.dataset.sash as SashKind;
  sash.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    startSashDrag(sash, kind, e);
  });
  sash.addEventListener('pointerenter', () => { if (!document.querySelector('.sash.active')) { placeSashes(); placeSashLine(sash); } });
  sash.addEventListener('pointerleave', () => { if (!sash.classList.contains('active')) placeSashLine(null); });
  sash.addEventListener('dblclick', () => {
    const prev = { ...layout };
    layout[kind] = DEFAULT_LAYOUT[kind];
    pushAppAction({ type: 'layout', prev, next: { ...layout } });
    applyLayoutAnimated();
  });
});
$('#tglSide').onclick = () => run('view.toggleSide');
$('#tglTerm').onclick = () => run('term.toggle');
$('#tglAgents').onclick = () => run('view.toggleAgents');

