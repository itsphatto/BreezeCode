/* ================= Layout: resizable, collapsible panels ================= */
// termDock: the IDE's terminal under the editor ('bottom') or beside it as a side bar ('side', termW wide).
interface Layout { side: number; agents: number; term: number; termW: number; termDock: 'bottom' | 'side'; preview: number; scmLeft: number; sideOpen: boolean; agentsOpen: boolean; termOpen: boolean; previewOpen: boolean; view: string; }
type SashKind = 'side' | 'agents' | 'preview' | 'term' | 'scm';
const DEFAULT_LAYOUT: Layout = { side: 240, agents: 340, term: 200, termW: 420, termDock: 'bottom', preview: 460, scmLeft: 320, sideOpen: true, agentsOpen: true, termOpen: false, previewOpen: true, view: 'files' };
const layout: Layout = { ...DEFAULT_LAYOUT, ...store.get<Partial<Layout>>('breeze.layout', {}) };
// The terminal's own window while it is popped out (popOutTerminal, below).
let termPopup: Window | null = null;
function termPopped(): boolean { return !!termPopup && !termPopup.closed; }
// One terminal panel, shown in the IDE or in Breeze Space. Moving it keeps its sessions and what they've printed.
const termHome = $('#terminal').parentElement as HTMLElement;
function terminalTo(parent: HTMLElement): void {
  const t = $('#terminal');
  if (t.parentElement === parent || termPopped()) return; // a popped-out terminal stays in its window until it closes
  parent.append(t);
  // It arrives closed and laid out, so opening slides it in even if it was open where it came from.
  t.classList.remove('open');
  void t.offsetWidth;
}
function terminalBack(): void {
  if ($('#terminal').parentElement === termHome || termPopped()) return;
  terminalTo(termHome);
  applyLayout();
}
const terminalHere = () => terminalTo(appState.mode === 'box' ? $('#box') : termHome);
function applyLayout(): void {
  const main = $('#main'), work = $('#work'), t = $('#terminal');
  const inSpace = layout.termOpen && t.parentElement === $('#box');
  $('#boxTerm').classList.toggle('on', inSpace);
  $('#boxTerm').setAttribute('aria-pressed', String(inSpace));
  main.style.setProperty('--side-w', layout.sideOpen ? `${layout.side}px` : '0px');
  main.style.setProperty('--agents-w', layout.agentsOpen ? `${layout.agents}px` : '0px');
  // The Source Control page's left column (prs.ts); a layout saved before it existed has no scmLeft.
  $('#scmPage').style.setProperty('--scm-left', `${clamp(layout.scmLeft, 240, 560)}px`);
  main.classList.toggle('no-side', !layout.sideOpen);
  main.classList.toggle('no-agents', !layout.agentsOpen);
  // The work area is hidden while the Source Control page is open, so it has no width to size the preview from; it's
  // sized again when the page closes (an unclamped width left in it would squeeze the editor out when it came back).
  if (!main.classList.contains('scm-page')) {
    const maxPreview = work.clientWidth ? work.clientWidth - 220 : layout.preview;
    // The inline width beats the .no-preview rule, so a closed preview has to be zeroed here or its column stays as a blank gap.
    work.style.setProperty('--preview-w', layout.previewOpen ? `${clamp(layout.preview, 220, Math.max(220, maxPreview))}px` : '0px');
    work.classList.toggle('no-preview', !layout.previewOpen);
  }
  t.style.setProperty('--term-h', `${clamp(layout.term, 80, Math.max(80, innerHeight - 220))}px`);
  termHome.classList.toggle('term-side', layout.termDock === 'side');
  termHome.style.setProperty('--term-w', `${clamp(layout.termW, 260, Math.max(260, innerWidth - 560))}px`);
  t.classList.toggle('open', layout.termOpen || termPopped());
  void setIcon($('#termTitle'), layout.termOpen ? 'chevronDown' : 'chevronRight');
  const icon = (id: string, sym: string, on: boolean) => $(`#${id} use`).setAttribute('href', `#i-${sym}${on ? '-on' : ''}`);
  icon('tglSide', 'left', layout.sideOpen); icon('tglTerm', 'bottom', layout.termOpen); icon('tglAgents', 'right', layout.agentsOpen);
  store.set('breeze.layout', layout);
  syncScroll();
  updateActIndicator();
  setTimeout(placeSashes); // after this script has set the sash layer up
}
// Resizing the window (maximize, restore, dragging its edge) reflows everything at once: the panels and rewrapped text
// take their new sizes straight away instead of each easing on its own while the screen grows (breeze.css, mentions.ts),
// which read as the layout glitching. Set before applyLayout below runs, so its new widths don't ease either.
// Also called by the window's size observer (platform.ts), which hears of a maximize a frame before the event does.
let winResizeTimer: TimeoutId | undefined;
function markWinResizing(): void {
  document.documentElement.classList.add('win-resizing');
  clearTimeout(winResizeTimer);
  winResizeTimer = setTimeout(() => document.documentElement.classList.remove('win-resizing'), 500);
}
window.addEventListener('resize', markWinResizing);
window.addEventListener('resize', applyLayout);
// Dragging below a threshold collapses the panel; dragging back out reopens it.
const SASH_DRAG: Record<SashKind, (start: Layout, dx: number, dy: number) => void> = {
  side: (start, dx) => { const w = start.side + dx; layout.sideOpen = w >= 120; if (layout.sideOpen) layout.side = clamp(w, 170, 640); },
  agents: (start, dx) => { const w = start.agents - dx; layout.agentsOpen = w >= 180; if (layout.agentsOpen) layout.agents = clamp(w, 260, 720); },
  preview: (start, dx) => { const w = start.preview - dx; layout.previewOpen = w >= 140; if (layout.previewOpen) layout.preview = clamp(w, 220, $('#work').clientWidth - 220); },
  scm: (start, dx) => { layout.scmLeft = clamp(start.scmLeft + dx, 240, 560); },
  term: (start, dx, dy) => {
    if (layout.termDock === 'side') { const w = start.termW - dx; layout.termOpen = w >= 160; if (layout.termOpen) layout.termW = clamp(w, 260, innerWidth - 560); return; }
    const h = start.term - dy; layout.termOpen = h >= 60; if (layout.termOpen) layout.term = clamp(h, 80, innerHeight - 220);
  },
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
  if (kind === 'term' && (!cardEl.classList.contains('open') || cardEl.parentElement?.id === 'box' || termPopped())) return null; // it sets the height, which Breeze Space's side bar doesn't use
  // A closed preview keeps its (zero-width) card in the layout; its sash would sit on the editor's edge and resize
  // nothing useful, since the editor and agents already share the sash beside the agents panel.
  if (kind === 'preview' && !layout.previewOpen) return null;
  if (kind === 'side' && $('#main').classList.contains('scm-page')) return null; // the page replaces the side bar
  const card = cardEl.getBoundingClientRect();
  const half = (Number.parseFloat(getComputedStyle($('#main')).getPropertyValue('--gap')) || 6) / 2;
  return kind === 'term' && layout.termDock !== 'side'
    ? [card.left, card.top - half, card.width, 0]
    : [kind === 'side' || kind === 'scm' ? card.right + half : card.left - half, card.top, 0, card.height];
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
  document.body.classList.add(kind === 'term' && layout.termDock !== 'side' ? 'resizing-h' : 'resizing');
  sash.classList.add('active');
  placeSashLine(sash);
  const move = (ev: PointerEvent) => { SASH_DRAG[kind](start, ev.clientX - sx, ev.clientY - sy); applyLayout(); placeSashes(); placeSashLine(sash); };
  const up = (ev: PointerEvent) => {
    removeEventListener('pointermove', move); removeEventListener('pointerup', up);
    document.body.classList.remove('resizing', 'resizing-h'); sash.classList.remove('active');
    placeSashLine((ev.target as HTMLElement)?.closest?.<HTMLElement>('[data-sash]') === sash ? sash : null);
    if (layout.side !== start.side || layout.agents !== start.agents || layout.preview !== start.preview || layout.scmLeft !== start.scmLeft || layout.term !== start.term || layout.termW !== start.termW || layout.sideOpen !== start.sideOpen || layout.agentsOpen !== start.agentsOpen || layout.previewOpen !== start.previewOpen || layout.termOpen !== start.termOpen) {
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
    const key = kind === 'scm' ? 'scmLeft' : kind === 'term' && layout.termDock === 'side' ? 'termW' : kind;
    layout[key] = DEFAULT_LAYOUT[key];
    pushAppAction({ type: 'layout', prev, next: { ...layout } });
    applyLayoutAnimated();
  });
});
$('#tglSide').onclick = () => run('view.toggleSide');
$('#tglTerm').onclick = () => run('term.toggle');
$('#tglAgents').onclick = () => run('view.toggleAgents');

// Titlebar Update button: hidden until main.js finds an update, then Update → Updating… n% → Restart to update.
function renderUpdate(u: UpdateState): void {
  const btn = $<HTMLButtonElement>('#updateBtn');
  btn.hidden = u.state === 'idle';
  btn.disabled = u.state === 'downloading';
  btn.textContent = u.state === 'ready' ? 'Restart to update' : u.state === 'downloading' ? `Updating… ${Math.round(u.percent ?? 0)}%` : 'Update';
  btn.title = u.version ? `Breeze Code ${u.version}` + (u.state === 'ready' ? ' is ready to install' : ' is available') : '';
  btn.onclick = () => background(u.state === 'ready' ? api.update.install() : api.update.download());
}
api.update.onState(renderUpdate);
api.update.get().then(renderUpdate, () => {});


/* ----- The terminal's "..." menu: under the editor, beside it, or in a window of its own ----- */
// Popping out moves the terminal itself (its sessions, what they've printed, the running commands) into a blank
// window the IDE opens (main.js allows just this one). It comes back to the IDE when that window closes.
// The window wears the IDE's stylesheets and theme, and keeps the theme in step while it is open.
function syncPopupLook(d: Document): void {
  const src = document.documentElement;
  for (const a of [...d.documentElement.attributes]) if (!src.hasAttribute(a.name)) d.documentElement.removeAttribute(a.name);
  for (const a of [...src.attributes]) d.documentElement.setAttribute(a.name, a.value);
  d.body.className = `${document.body.className} term-popout`;
}
let popupLookWatch: MutationObserver | null = null;
async function popOutTerminal(): Promise<void> {
  if (termPopped()) { termPopup?.focus(); return; }
  const w = window.open('about:blank', 'breeze-terminal');
  if (!w) { toast('Couldn\'t open a window for the terminal'); return; }
  termPopup = w;
  const d = w.document;
  // A standards-mode page (about:blank has no doctype), so the IDE's styles lay it out as they do the IDE.
  d.open();
  d.write('<!doctype html><html><head><meta charset="utf-8"><title>Terminal - Breeze Code</title></head><body></body></html>');
  d.close();
  const loads: Promise<unknown>[] = [];
  for (const el of document.head.querySelectorAll('link[rel="stylesheet"], style')) {
    const copy = d.importNode(el, true);
    if (el instanceof HTMLLinkElement) {
      (copy as HTMLLinkElement).href = el.href; // absolute: about:blank has no folder
      loads.push(new Promise(done => { copy.addEventListener('load', done, { once: true }); copy.addEventListener('error', done, { once: true }); }));
    }
    d.head.append(copy);
  }
  syncPopupLook(d);
  popupLookWatch = new MutationObserver(() => { if (termPopped()) syncPopupLook(d); });
  popupLookWatch.observe(document.documentElement, { attributes: true });
  popupLookWatch.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  // The terminal moves over once the styles are in, so it never shows unstyled.
  await Promise.race([Promise.all(loads), wait(1500)]);
  if (w.closed) { termPopup = null; popupLookWatch?.disconnect(); return; }
  elsewhere.push(d);
  const t = $('#terminal');
  d.body.append(t);
  t.classList.add('open');
  w.addEventListener('pagehide', dockTerminalBack, { once: true });
  layout.termOpen = false; // nothing is left of it in the IDE
  applyLayoutAnimated();
  w.focus();
  termInput.focus();
}
function dockTerminalBack(): void {
  const w = termPopup;
  if (!w) return;
  termPopup = null;
  popupLookWatch?.disconnect();
  popupLookWatch = null;
  const i = elsewhere.indexOf(w.document);
  if (i >= 0) elsewhere.splice(i, 1);
  const t = w.document.getElementById('terminal');
  if (t) { termHome.append(t); t.classList.remove('open'); void t.offsetWidth; }
  if (!w.closed) w.close();
  terminalHere();
  layout.termOpen = true;
  applyLayoutAnimated();
  termInput.focus();
}
function dockTerminal(dock: Layout['termDock']): void {
  const prev = { ...layout };
  layout.termDock = dock;
  if (termPopped()) { dockTerminalBack(); return; }
  terminalBack();
  layout.termOpen = true;
  pushAppAction({ type: 'layout', prev, next: { ...layout } });
  applyLayoutAnimated();
  termInput.focus();
}
const TERM_DOCKS: [Layout['termDock'] | 'window', string][] = [['bottom', 'Panel Below the Editor'], ['side', 'Side Bar Beside the Editor'], ['window', 'Pop out Terminal']];
function termMoreItems(): MenuItem[] {
  const where = termPopped() ? 'window' : layout.termDock;
  return [
    ...TERM_DOCKS.map(([dock, label]): MenuItem => ({
      label, checked: () => where === dock,
      run: () => (dock === 'window' ? background(popOutTerminal()) : dockTerminal(dock)),
    })),
    { sep: true },
    { label: 'Toggle Terminal', act: 'term.toggle', key: 'Ctrl+`' },
  ];
}
// In the popped-out window the IDE's menus (drawn on the IDE's own page) can't show, so it gets a small one of its own.
function termWindowMenu(btn: HTMLElement): void {
  const d = btn.ownerDocument;
  const open = d.querySelector('.menu.term-win-menu');
  if (open) { open.remove(); return; }
  const items = termMoreItems().filter(it => !it.act && !it.sep);
  const m = d.createElement('div');
  m.className = 'menu term-win-menu';
  m.setAttribute('role', 'menu');
  for (const it of items) {
    const b = d.createElement('button');
    b.className = `menu-item${it.checked?.() ? ' checked' : ''}`;
    b.setAttribute('role', 'menuitem');
    b.innerHTML = `${it.checked?.() ? `<span class="menu-check">${svgIcon('check', 12)}</span>` : ''}<span>${esc(it.label ?? '')}</span>`;
    b.onclick = () => { close(); it.run?.(); };
    m.append(b);
  }
  const view = d.defaultView as Window;
  d.body.append(m);
  const r = btn.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(r.right - m.offsetWidth, view.innerWidth - m.offsetWidth - 8))}px`;
  m.style.top = `${r.bottom + 4}px`;
  btn.setAttribute('aria-expanded', 'true');
  const outside = (e: Event) => { if (!m.contains(e.target as Node) && !btn.contains(e.target as Node)) close(); };
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  function close(): void {
    m.remove();
    btn.setAttribute('aria-expanded', 'false');
    d.removeEventListener('mousedown', outside, true);
    d.removeEventListener('keydown', key, true);
  }
  d.addEventListener('mousedown', outside, true);
  d.addEventListener('keydown', key, true);
}
$('#termMore').onclick = e => {
  e.stopPropagation();
  const btn = e.currentTarget as HTMLElement;
  if (btn.ownerDocument !== document) { termWindowMenu(btn); return; }
  if (btn.classList.contains('open') || (justClosedTrigger === btn && Date.now() - justClosedAt < 350)) { closeMenu(); return; }
  closeMenu();
  const r = btn.getBoundingClientRect();
  popupMenu(Math.max(8, r.right - 230), r.bottom + 4, termMoreItems(), undefined, btn);
};
