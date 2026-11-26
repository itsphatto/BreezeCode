/* ===================== Second brain: a folder's memory as a graph or a list =====================
   Opened from the Agent board's side bar (under MCP, for the open folder; or right-click a folder's name). It takes the
   boxes' place on the page: they stay laid out and running underneath, and closing it shows them again. Each dot is one memory that an
   agent's compaction, a prompt or Summarize left behind (main secondbrain.ts); a line means two memories name the
   same file, share words, or an agent linked them. Dots grow with their links, files are hubs, and memories linked to
   nothing drift on a ring at the edge.
   What it borrows from graph tools and research on them: search highlights and dims instead of hiding (Obsidian's
   most asked-for graph change), names fade in as you zoom and never overlap (semantic zoom), a click opens a card with
   the memory's links to hop along, Focus shows one memory's neighbourhood (a local graph), and a plain List view,
   which many people read faster than any graph. */

interface BrainDot extends BrainNode { x: number; y: number; vx: number; vy: number; deg: number; r: number; fixed: boolean }
const BRAIN_KINDS: { kind: BrainKind; label: string }[] = [
  { kind: 'decision', label: 'Decisions' }, { kind: 'task', label: 'Tasks' }, { kind: 'fact', label: 'Facts' }, { kind: 'file', label: 'Files' },
];
const brain = {
  el: null as HTMLElement | null,
  canvas: null as HTMLCanvasElement | null,
  folder: '',
  dots: [] as BrainDot[],
  byId: new Map<string, BrainDot>(),
  links: [] as { a: BrainDot; b: BrainDot; w: number }[],
  near: new Map<string, Set<string>>(),
  hidden: new Set<BrainKind>(),
  view: { x: 0, y: 0, k: 1 },
  alpha: 0,
  frame: 0,
  fly: 0,
  hover: null as BrainDot | null, // under the pointer: a ring only
  held: null as BrainDot | null, // hovered for BRAIN_HOLD_MS: its links light up, fading in by heldT
  heldT: 0,
  holdTimer: 0,
  heldFrame: 0,
  pinned: null as BrainDot | null, // the memory open in the side panel
  focus: false, // Focus: only the open memory and what it links to
  query: '',
  matches: null as Set<string> | null, // null: no search
  mode: 'graph' as 'graph' | 'list',
  colors: {} as Record<string, string>,
  back: null as HTMLElement | null,
  off: null as (() => void) | null,
};
const brainStill = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const brainQ = <T extends HTMLElement = HTMLElement>(sel: string) => brain.el!.querySelector<T>(sel)!;

function brainBuild(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'brain';
  el.id = 'secondBrain';
  el.setAttribute('role', 'region');
  el.tabIndex = -1; // a click on the graph keeps the keys (Esc, /, F) here
  el.setAttribute('aria-labelledby', 'brainTitle');
  el.innerHTML = `<header class="brain-head">
      <div class="brain-heading"><h2 class="brain-title" id="brainTitle">Second brain</h2><div class="brain-sub"></div></div>
      <button type="button" class="btn btn-sm brain-summarize" title="Your agent reads this folder's chats and adds what's worth remembering. Uses tokens; you see an estimate first."><span>Summarize chats</span></button>
      <button type="button" class="icon-btn brain-close" title="Close (Esc)" aria-label="Close second brain">${svgIcon('x', 16)}</button>
    </header>
    <div class="brain-bar">
      <label class="brain-search">${svgIcon('search', 14)}<input type="search" placeholder="Search memories" aria-label="Search memories" spellcheck="false" autocomplete="off"><kbd>/</kbd><span class="brain-count" aria-live="polite"></span></label>
      <div class="brain-legend" role="group" aria-label="Show or hide each kind of memory">${BRAIN_KINDS.map(k =>
        `<button type="button" class="brain-chip" data-kind="${k.kind}" aria-pressed="true"><i></i><span>${k.label}</span><b></b></button>`).join('')}</div>
      <span class="flex-1"></span>
      <div class="brain-seg" role="tablist" aria-label="View"><button type="button" role="tab" data-mode="graph" aria-selected="true">Graph</button><button type="button" role="tab" data-mode="list" aria-selected="false">List</button></div>
    </div>
    <div class="brain-body">
      <div class="brain-stage">
        <canvas class="brain-canvas" aria-label="Memory graph. The List view shows the same memories as text."></canvas>
        <div class="brain-list hidden" role="list" aria-label="Memories"></div>
        <div class="brain-empty hidden"><h3>Nothing remembered yet</h3><p>Memories show up here each time a chat in this folder finishes a reply. Deleting a chat forgets what only it said. Summarize chats adds older ones.</p></div>
        <div class="brain-hover hidden" aria-hidden="true"></div>
        <div class="brain-zoom" role="group" aria-label="Zoom">
          <button type="button" class="icon-btn" data-zoom="in" title="Zoom in (+)" aria-label="Zoom in">${svgIcon('plus', 14)}</button>
          <button type="button" class="icon-btn" data-zoom="out" title="Zoom out (−)" aria-label="Zoom out">${svgIcon('minus', 14)}</button>
          <button type="button" class="icon-btn" data-zoom="fit" title="Fit to screen (F)" aria-label="Fit to screen">${svgIcon('maximize', 14)}</button>
        </div>
        <div class="brain-hint">Drag to move · scroll to zoom · click a dot to open it</div>
      </div>
      <aside class="brain-panel" aria-label="Memory" aria-hidden="true"></aside>
    </div>`;
  $('.board-main').appendChild(el);
  brain.el = el;
  brain.canvas = brainQ<HTMLCanvasElement>('canvas');
  brainQ('.brain-close').addEventListener('click', closeSecondBrain);
  const sum = brainQ<HTMLButtonElement>('.brain-summarize');
  sum.addEventListener('click', () => void brainSummarize(sum));
  const input = brainQ<HTMLInputElement>('.brain-search input');
  input.addEventListener('input', () => brainSearch(input.value));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); brainOpenBest(); }
    else if (e.key === 'Escape' && input.value) { e.preventDefault(); e.stopPropagation(); input.value = ''; brainSearch(''); }
  });
  el.addEventListener('keydown', brainKeys);
  for (const chip of el.querySelectorAll<HTMLButtonElement>('.brain-chip')) chip.addEventListener('click', () => {
    const k = chip.dataset.kind as BrainKind;
    if (brain.hidden.has(k)) brain.hidden.delete(k); else brain.hidden.add(k);
    chip.setAttribute('aria-pressed', String(!brain.hidden.has(k)));
    if (brain.pinned && brain.hidden.has(brain.pinned.kind)) brainSelect(null);
    brainRefresh();
  });
  for (const b of el.querySelectorAll<HTMLButtonElement>('.brain-seg button')) b.addEventListener('click', () => brainMode(b.dataset.mode as 'graph' | 'list'));
  for (const b of el.querySelectorAll<HTMLButtonElement>('[data-zoom]')) b.addEventListener('click', () => {
    if (b.dataset.zoom === 'fit') brainFlyFit(); else brainZoomBy(b.dataset.zoom === 'in' ? 1.4 : 1 / 1.4);
  });
  brainQ('.brain-list').addEventListener('click', e => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-id]');
    if (row) brainSelect(brain.byId.get(row.dataset.id!) ?? null);
  });
  brainQ('.brain-panel').addEventListener('click', brainPanelClick);
  brainPointer(brain.canvas);
  new ResizeObserver(() => brainDraw()).observe(brain.canvas);
  return el;
}

// The colors come from the theme (breeze.css --brain-*), read once per open so a theme change is picked up.
function brainColors(): void {
  const cs = getComputedStyle(brain.el!);
  for (const k of ['fact', 'decision', 'task', 'file', 'link', 'link-hi', 'ring', 'label', 'halo']) brain.colors[k] = cs.getPropertyValue(`--brain-${k}`).trim() || '#888';
  brain.colors.font = cs.getPropertyValue('--font-ui').trim() || 'sans-serif';
}

const brainOpen = () => $('#board').classList.contains('brain-open');
// The boxes are hidden, not removed: agents keep working in them and they come back as they were.
function brainCover(on: boolean): void {
  $('#board').classList.toggle('brain-open', on);
  $('#boardGrid').inert = on;
  $('#boardSideBrain').setAttribute('aria-pressed', String(on));
}
$('#boardSideBrain').onclick = () => {
  if (brainOpen()) closeSecondBrain();
  else if (rootInfo) void openSecondBrain(rootInfo.root);
  else toast('Open a folder first');
};

async function openSecondBrain(folder: string): Promise<void> {
  if (!folder) return;
  if (!brainOpen()) brain.back = document.activeElement as HTMLElement | null;
  const el = brain.el ?? brainBuild();
  brain.folder = folder;
  brain.view = { x: 0, y: 0, k: 1 };
  brain.dots = [];
  brain.focus = false;
  brainQ<HTMLInputElement>('.brain-search input').value = '';
  brain.query = '';
  brain.matches = null;
  brainSelect(null);
  brainQ('.brain-sub').textContent = folderName(folder);
  brainCover(true);
  el.classList.remove('hidden', 'closing');
  el.classList.add('opening');
  requestAnimationFrame(() => el.classList.remove('opening'));
  brainColors();
  brainQ('.brain-close').focus();
  brain.off?.();
  brain.off = api.brain.onChange(m => { if (m && folderKey(m.folder) === folderKey(brain.folder)) void brainLoad(true); });
  await brainLoad(false);
}

function closeSecondBrain(): void {
  const el = brain.el;
  if (!el || !brainOpen()) return;
  brainCover(false);
  brain.off?.();
  brain.off = null;
  cancelAnimationFrame(brain.frame);
  cancelAnimationFrame(brain.fly);
  brain.frame = brain.fly = 0;
  el.classList.add('closing');
  // Not if it was opened again meanwhile.
  const done = () => { if (el.classList.contains('closing')) { el.classList.add('hidden'); el.classList.remove('closing'); } };
  if (brainStill()) done(); else setTimeout(done, 400);
  brain.back?.focus?.();
}

// `keep`: a refresh while open, so dots already on screen stay where they are.
async function brainLoad(keep: boolean): Promise<void> {
  let g: BrainGraph;
  try { g = await api.brain.graph(brain.folder); } catch { g = { nodes: [], links: [] }; }
  const old = keep ? brain.byId : new Map<string, BrainDot>();
  const deg = new Map<string, number>();
  for (const l of g.links) for (const id of [l.a, l.b]) deg.set(id, (deg.get(id) ?? 0) + 1);
  const linked = g.nodes.filter(n => deg.get(n.id)).length;
  const spread = 30 + Math.sqrt(linked) * 22;
  brain.dots = g.nodes.map((n, i) => {
    const was = old.get(n.id);
    const d = deg.get(n.id) ?? 0;
    const a = i * 2.39996, rr = d ? spread * Math.sqrt((i + 0.5) / Math.max(1, g.nodes.length)) : spread * 1.35;
    return { ...n, x: was?.x ?? Math.cos(a) * rr, y: was?.y ?? Math.sin(a) * rr, vx: 0, vy: 0, deg: d,
      r: (n.kind === 'file' ? 3.5 : 2.5) + 1.7 * Math.sqrt(d) + Math.min(n.hits - 1, 4) * 0.4, fixed: false };
  });
  brain.byId = new Map(brain.dots.map(d => [d.id, d]));
  brain.links = g.links.map(l => ({ a: brain.byId.get(l.a)!, b: brain.byId.get(l.b)!, w: l.w })).filter(l => l.a && l.b);
  brain.near = new Map();
  for (const l of brain.links) {
    if (!brain.near.has(l.a.id)) brain.near.set(l.a.id, new Set());
    if (!brain.near.has(l.b.id)) brain.near.set(l.b.id, new Set());
    brain.near.get(l.a.id)!.add(l.b.id);
    brain.near.get(l.b.id)!.add(l.a.id);
  }
  brainHover(null);
  const still = brain.pinned && brain.byId.get(brain.pinned.id);
  brainSelect(still || null, false);
  brainQ('.brain-empty').classList.toggle('hidden', brain.dots.length > 0);
  const count = (k: BrainKind) => brain.dots.filter(d => d.kind === k).length;
  for (const chip of brain.el!.querySelectorAll<HTMLElement>('.brain-chip')) chip.querySelector('b')!.textContent = String(count(chip.dataset.kind as BrainKind));
  const mems = brain.dots.length - count('file');
  brainQ('.brain-sub').textContent = `${folderName(brain.folder)} · ${mems} ${mems === 1 ? 'memory' : 'memories'}`;
  brainSearch(brain.query);
  brain.alpha = keep ? Math.max(brain.alpha, 0.4) : 1;
  if (brainStill()) { for (let i = 0; i < 300 && brain.alpha > 0.01; i++) brainTick(); brain.alpha = 0; }
  else if (!keep) for (let i = 0; i < 40; i++) brainTick(); // a head start, so it opens shaped, not as a blob
  if (!keep) brainFit();
  brainRun();
}

/* ----- What's visible: kinds switched off, a search, Focus ----- */
const brainShown = (d: BrainDot) => !brain.hidden.has(d.kind)
  && (!brain.focus || !brain.pinned || d === brain.pinned || !!brain.near.get(brain.pinned.id)?.has(d.id));
const brainMatch = (d: BrainDot) => !brain.matches || brain.matches.has(d.id);
// Every word of the search must appear in the memory; files match on their path too.
function brainSearch(q: string): void {
  brain.query = q.trim();
  const words = brain.query.toLowerCase().split(/\s+/).filter(Boolean);
  brain.matches = words.length ? new Set(brain.dots.filter(d => { const t = d.text.toLowerCase(); return words.every(w => t.includes(w)); }).map(d => d.id)) : null;
  const n = brain.matches ? brain.dots.filter(d => brain.matches!.has(d.id) && brainShown(d)).length : 0;
  brainQ('.brain-count').textContent = brain.matches ? `${n} ${n === 1 ? 'match' : 'matches'}` : '';
  brainQ('.brain-search').classList.toggle('has-query', !!brain.matches);
  brainRefresh();
}
// Enter in the search: the best match (most linked) opens and the graph flies to it.
function brainOpenBest(): void {
  const best = brain.dots.filter(d => brain.matches?.has(d.id) && brainShown(d)).sort((a, b) => b.deg - a.deg || b.hits - a.hits)[0];
  if (best) brainSelect(best);
}
function brainRefresh(): void {
  if (brain.mode === 'list') brainList();
  brainDraw();
}
function brainMode(mode: 'graph' | 'list'): void {
  brain.mode = mode;
  for (const b of brain.el!.querySelectorAll<HTMLElement>('.brain-seg button')) b.setAttribute('aria-selected', String(b.dataset.mode === mode));
  brain.canvas!.classList.toggle('hidden', mode !== 'graph');
  brainQ('.brain-zoom').classList.toggle('hidden', mode !== 'graph');
  brainQ('.brain-hint').classList.toggle('hidden', mode !== 'graph');
  brainQ('.brain-list').classList.toggle('hidden', mode !== 'list');
  brainQ('.brain-hover').classList.add('hidden');
  brainRefresh();
}

/* ----- Keys: / searches, F fits, + and − zoom, Esc clears, closes the card, then closes ----- */
function brainKeys(e: KeyboardEvent): void {
  const typing = (e.target as HTMLElement).matches('input, textarea');
  if (e.key === 'Escape') {
    e.stopPropagation();
    if (brain.pinned) brainSelect(null);
    else closeSecondBrain();
    return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); brainQ<HTMLInputElement>('.brain-search input').focus(); }
  else if (brain.mode !== 'graph') return;
  else if (e.key === 'f' || e.key === 'F') brainFlyFit();
  else if (e.key === '+' || e.key === '=') brainZoomBy(1.4);
  else if (e.key === '-' || e.key === '_') brainZoomBy(1 / 1.4);
}

/* ----- Summarize: the user's agent reads this folder's chats; costs tokens, so it asks with an estimate first ----- */
const brainTokens = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
function brainConfirm(plan: { chats: number; requests: number; more: boolean; tokens: number; agent: string | null }): Promise<boolean> {
  return new Promise<boolean>(res => {
    const finish = settleOnce(res);
    const who = agentNameOf(plan.agent ?? '');
    openModal(`<h3>Summarize this folder's chats?</h3>
      <p class="sub">${esc(who)} reads ${plan.chats} ${plan.chats === 1 ? 'chat' : 'chats'} in ${plan.requests} ${plan.requests === 1 ? 'request' : 'requests'}: about <b>${brainTokens.format(plan.tokens)} tokens</b>. Only what it hasn't read before is sent, so the next time costs less.${plan.more ? ' There is more than one go can take; press Summarize again for the rest.' : ''}</p>
      <div class="row end"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="brainSumGo">Summarize</button></div>`, m => {
      $('#brainSumGo', m).onclick = () => { modalOnClose = null; closeModal(); finish(true); };
    }, () => finish(false));
  });
}
async function brainSummarize(btn: HTMLButtonElement): Promise<void> {
  if (btn.disabled) return;
  const folder = brain.folder, label = btn.querySelector('span')!;
  const say = (t: string) => { label.textContent = t; };
  btn.disabled = true;
  say('Reading chats…');
  let off: (() => void) | null = null;
  try {
    const chats = await boardFolderChats(folder);
    const plan = await api.brain.summarizePlan(folder, chats);
    if (!plan.requests) { toast(chats.length ? 'Nothing new to summarize since last time' : 'No chats in this folder yet'); return; }
    if (!plan.agent) { toast('Set up an agent first: none is available to summarize'); return; }
    say('Summarize chats');
    if (!await brainConfirm(plan)) return;
    say('Summarizing…');
    off = api.brain.onProgress(m => { if (folderKey(m.folder) === folderKey(folder) && m.done < m.total) say(`Summarizing ${m.done + 1} of ${m.total}…`); });
    const r = await api.brain.summarize(folder, chats);
    toast(r.added ? `Added ${r.added} ${r.added === 1 ? 'memory' : 'memories'} to the second brain` : 'Nothing new worth remembering');
  } catch (err) {
    toast(`Couldn't summarize: ${(err as Error)?.message ?? err}`);
  } finally {
    off?.();
    btn.disabled = false;
    say('Summarize chats');
  }
}

/* ----- Layout: pushed apart, pulled along links, held to the middle; loners on a ring ----- */
function brainTick(): void {
  const dots = brain.dots, alpha = brain.alpha;
  if (!dots.length) return;
  // Repulsion between near dots only, found through a grid, so a big brain stays cheap.
  const CELL = 70, grid = new Map<string, BrainDot[]>();
  for (const d of dots) { const k = `${Math.floor(d.x / CELL)},${Math.floor(d.y / CELL)}`; (grid.get(k) ?? grid.set(k, []).get(k)!).push(d); }
  for (const d of dots) {
    const cx = Math.floor(d.x / CELL), cy = Math.floor(d.y / CELL);
    for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
      for (const o of grid.get(`${gx},${gy}`) ?? []) {
        if (o === d) continue;
        let dx = d.x - o.x, dy = d.y - o.y, dd = dx * dx + dy * dy;
        if (dd > CELL * CELL) continue;
        if (dd < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; dd = 0.25; }
        const f = (alpha * 90 * (1 + o.r / 6)) / dd;
        d.vx += dx * f; d.vy += dy * f;
      }
    }
  }
  for (const l of brain.links) {
    const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y, dist = Math.hypot(dx, dy) || 1;
    const rest = 18 + l.a.r + l.b.r;
    const f = ((dist - rest) / dist) * 0.06 * alpha * (0.5 + l.w);
    const wa = l.b.deg / (l.a.deg + l.b.deg), wb = 1 - wa; // the hub moves less
    l.a.vx += dx * f * wa; l.a.vy += dy * f * wa;
    l.b.vx -= dx * f * wb; l.b.vy -= dy * f * wb;
  }
  const linked = dots.filter(d => d.deg).length;
  const ring = 60 + Math.sqrt(linked) * 26;
  for (const d of dots) {
    if (d.deg) { d.vx -= d.x * 0.006 * alpha; d.vy -= d.y * 0.006 * alpha; }
    else { const r = Math.hypot(d.x, d.y) || 1, f = ((ring - r) / r) * 0.05 * alpha; d.vx += d.x * f; d.vy += d.y * f; }
    if (d.fixed) { d.vx = d.vy = 0; continue; }
    d.vx *= 0.6; d.vy *= 0.6;
    d.x += Math.max(-20, Math.min(20, d.vx)); d.y += Math.max(-20, Math.min(20, d.vy));
  }
  brain.alpha *= 0.985;
}
function brainRun(): void {
  if (brain.frame) return;
  const step = () => {
    brain.frame = 0;
    if (!brain.el || brain.el.classList.contains('hidden')) return;
    if (brain.alpha > 0.01) brainTick();
    brainDraw();
    if (brain.alpha > 0.01) brain.frame = requestAnimationFrame(step);
  };
  brain.frame = requestAnimationFrame(step);
}
function brainHeat(to: number): void { if (brainStill()) { brainDraw(); return; } brain.alpha = Math.max(brain.alpha, to); brainRun(); }

/* ----- The view: fit, zoom, and flying to a memory with the panel easing ----- */
function brainSize(): { w: number; h: number; dpr: number } {
  const c = brain.canvas!, dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  return { w, h, dpr };
}
function brainFitView(): { x: number; y: number; k: number } {
  const shown = brain.dots.filter(brainShown);
  const { w, h } = brainSize();
  if (!shown.length || !w || !h) return { x: 0, y: 0, k: 1 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const d of shown) { x0 = Math.min(x0, d.x - d.r); y0 = Math.min(y0, d.y - d.r); x1 = Math.max(x1, d.x + d.r); y1 = Math.max(y1, d.y + d.r); }
  const k = Math.max(0.15, Math.min(2.5, Math.min((w - 120) / (x1 - x0 || 1), (h - 120) / (y1 - y0 || 1))));
  return { k, x: -((x0 + x1) / 2) * k, y: -((y0 + y1) / 2) * k };
}
function brainFit(): void { brain.view = brainFitView(); }
// The panel's curve, cubic-bezier(.32, .72, 0, 1), close enough for a camera move.
const brainEase = (t: number) => 1 - Math.pow(1 - t, 4);
function brainFlyTo(to: { x: number; y: number; k: number }): void {
  cancelAnimationFrame(brain.fly);
  if (brainStill()) { brain.view = to; brainDraw(); return; }
  const from = { ...brain.view }, start = performance.now(), ms = 450;
  const step = (now: number) => {
    const t = brainEase(Math.min(1, (now - start) / ms));
    brain.view = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, k: from.k + (to.k - from.k) * t };
    brainDraw();
    brain.fly = t < 1 ? requestAnimationFrame(step) : 0;
  };
  brain.fly = requestAnimationFrame(step);
}
function brainFlyFit(): void { brainFlyTo(brainFitView()); }
function brainFlyToDot(d: BrainDot): void {
  const k = Math.max(brain.view.k, 1.6);
  brainFlyTo({ k, x: -d.x * k, y: -d.y * k });
}
function brainZoomBy(f: number): void {
  const v = brain.view, k = Math.max(0.1, Math.min(6, v.k * f));
  brainFlyTo({ k, x: (v.x / v.k) * k, y: (v.y / v.k) * k });
}

/* ----- Drawing ----- */
function brainDraw(): void {
  const c = brain.canvas;
  if (!c || !brain.el || brain.el.classList.contains('hidden') || brain.mode !== 'graph') return;
  const { w, h, dpr } = brainSize();
  const g = c.getContext('2d')!;
  const { x, y, k } = brain.view, col = brain.colors;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.setTransform(dpr * k, 0, 0, dpr * k, dpr * (w / 2 + x), dpr * (h / 2 + y));
  // A held dot (hovered a second) lights its links, fading in by t; an open memory stays lit (t = 1).
  const held = brain.held && brainShown(brain.held) ? brain.held : null;
  const focus = held ?? brain.pinned;
  const t = held ? brain.heldT : focus ? 1 : 0;
  const near = focus ? brain.near.get(focus.id) ?? new Set<string>() : null;
  const near1 = (d: BrainDot) => !!focus && (d === focus || near!.has(d.id));
  const lit = (d: BrainDot) => (focus && t >= 0.5 ? near1(d) : brainMatch(d));
  const searching = !!brain.matches;
  const mix = (a: number, b: number) => a + (b - a) * t;
  // Links: faint, the open or held memory's brighter; during a search only links between matches stay.
  const base = searching ? 0.3 : 1;
  g.lineWidth = 1 / k;
  g.strokeStyle = col.link;
  g.globalAlpha = focus ? mix(base, 0.3) : base;
  g.beginPath();
  for (const l of brain.links) {
    if (!brainShown(l.a) || !brainShown(l.b) || (focus && (l.a === focus || l.b === focus))) continue;
    if (searching && !(brainMatch(l.a) && brainMatch(l.b))) continue;
    g.moveTo(l.a.x, l.a.y); g.lineTo(l.b.x, l.b.y);
  }
  g.stroke();
  if (focus) {
    g.beginPath();
    for (const l of brain.links) if ((l.a === focus || l.b === focus) && brainShown(l.a) && brainShown(l.b)) { g.moveTo(l.a.x, l.a.y); g.lineTo(l.b.x, l.b.y); }
    if (t < 1) { g.globalAlpha = (1 - t) * base; g.stroke(); }
    g.globalAlpha = t;
    g.strokeStyle = col['link-hi'];
    g.lineWidth = 1.5 / k;
    g.stroke();
  }
  for (const d of brain.dots) {
    if (!brainShown(d)) continue;
    const plain = brainMatch(d) ? 1 : 0.16;
    g.globalAlpha = focus ? mix(plain, near1(d) ? 1 : 0.16) : plain;
    g.fillStyle = col[d.kind];
    g.beginPath();
    g.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    g.fill();
  }
  // Search hits get a halo, so they stand out even zoomed out.
  if (searching && t < 1) {
    g.globalAlpha = 1 - t;
    g.strokeStyle = col.halo;
    g.lineWidth = 2 / k;
    g.beginPath();
    for (const d of brain.dots) if (brainShown(d) && brainMatch(d)) { g.moveTo(d.x + d.r + 3 / k, d.y); g.arc(d.x, d.y, d.r + 3 / k, 0, Math.PI * 2); }
    g.stroke();
  }
  for (const d of [brain.pinned, brain.hover]) {
    if (!d || !brainShown(d)) continue;
    g.globalAlpha = 1;
    g.strokeStyle = col.ring;
    g.lineWidth = 2 / k;
    g.beginPath();
    g.arc(d.x, d.y, d.r + 3 / k, 0, Math.PI * 2);
    g.stroke();
  }
  g.globalAlpha = 1;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  brainLabels(g, w, h, lit, (!!focus && t >= 0.5) || searching);
  brainHoverCard();
}

// Names fade in as dots grow on screen; the open memory, its links and search hits are named first, then the most
// linked. A name that would overlap one already placed is left out (semantic zoom: no overlapping labels).
const brainLabelOf = (d: BrainDot) => {
  const t = d.kind === 'file' ? d.text.split('/').pop()! : d.text.replace(/^[^\s:]+\.\w+:\s*/, '');
  return t.length > 34 ? `${t.slice(0, 33)}…` : t;
};
function brainLabels(g: CanvasRenderingContext2D, w: number, h: number, lit: (d: BrainDot) => boolean, picking: boolean): void {
  const { x, y, k } = brain.view, col = brain.colors;
  const sx = (d: BrainDot) => w / 2 + x + d.x * k, sy = (d: BrainDot) => h / 2 + y + d.y * k;
  const must = (d: BrainDot) => d === brain.pinned || (d === brain.held && brain.heldT >= 0.5) || (picking && lit(d));
  // How much a name shows: by the dot's size on screen, unless it has to show.
  // File hubs are named first; a memory's sentence waits until its dot is bigger on screen.
  const fade = (d: BrainDot) => (must(d) ? 1 : picking ? 0 : Math.max(0, Math.min(1, (d.r * k - (d.kind === 'file' ? 4.5 : 7)) / 3)));
  const order = brain.dots.filter(d => brainShown(d) && fade(d) > 0)
    .sort((a, b) => Number(must(b)) - Number(must(a)) || b.deg - a.deg || b.hits - a.hits);
  g.font = `500 11px ${col.font}`;
  g.textAlign = 'center';
  g.textBaseline = 'top';
  const placed: [number, number, number, number][] = [];
  for (const d of order.slice(0, 160)) {
    const px = sx(d), py = sy(d) + d.r * k + 4;
    if (px < -100 || px > w + 100 || py < -20 || py > h + 20) continue;
    const text = brainLabelOf(d), tw = g.measureText(text).width;
    const box: [number, number, number, number] = [px - tw / 2 - 3, py - 1, px + tw / 2 + 3, py + 14];
    if (placed.some(p => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1])) continue;
    placed.push(box);
    g.globalAlpha = fade(d) * (lit(d) || !picking ? 1 : 0.3);
    g.fillStyle = col.label;
    g.fillText(text, px, py);
  }
  g.globalAlpha = 1;
}

/* ----- Hover: a small card beside the dot. Click opens the side panel. ----- */
const BRAIN_KIND_NAME: Record<BrainKind, string> = { fact: 'Fact', decision: 'Decision', task: 'Task', file: 'File' };
const BRAIN_AGENT_NAME: Record<string, string> = { you: 'Your prompt', claude: 'Claude Code', codex: 'Codex' };
const brainWho = (d: BrainNode) => BRAIN_AGENT_NAME[d.agent] ?? agentNameOf(d.agent);
const brainWhen = (d: BrainNode) => new Date(d.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
function brainHoverCard(): void {
  const card = brainQ('.brain-hover');
  const d = brain.held === brain.hover ? brain.held : null;
  if (!d || d === brain.pinned || !brainShown(d) || brain.mode !== 'graph') { card.classList.add('hidden'); delete card.dataset.id; return; }
  if (card.dataset.id !== d.id) {
    card.dataset.id = d.id;
    card.innerHTML = `<div class="brain-kind" data-kind="${d.kind}"><i></i>${BRAIN_KIND_NAME[d.kind]}</div><p>${esc(d.text)}</p><div class="brain-meta">${esc(brainWho(d))} · ${esc(brainWhen(d))} · click to open</div>`;
  }
  const { w, h } = brainSize();
  const sx = w / 2 + brain.view.x + d.x * brain.view.k, sy = h / 2 + brain.view.y + d.y * brain.view.k;
  const cw = card.offsetWidth, ch = card.offsetHeight, gap = d.r * brain.view.k + 12;
  const left = sx + gap + cw > w - 12 ? sx - gap - cw : sx + gap;
  const top = Math.max(12, Math.min(h - ch - 12, sy - ch / 2));
  card.style.transform = `translate(${Math.round(Math.max(12, left))}px, ${Math.round(top)}px)`;
  card.classList.remove('hidden');
}

/* ----- The side panel: one memory, what it links to, Focus, Copy, Forget ----- */
function brainSelect(d: BrainDot | null, fly = true): void {
  brain.pinned = d;
  if (!d) brain.focus = false;
  const panel = brainQ('.brain-panel');
  brain.el!.classList.toggle('panel-open', !!d);
  panel.setAttribute('aria-hidden', String(!d));
  if (d) {
    const links = [...(brain.near.get(d.id) ?? [])].map(id => brain.byId.get(id)!).filter(Boolean)
      .sort((a, b) => BRAIN_KINDS.findIndex(k => k.kind === a.kind) - BRAIN_KINDS.findIndex(k => k.kind === b.kind) || b.deg - a.deg);
    panel.innerHTML = `<div class="brain-panel-top"><div class="brain-kind" data-kind="${d.kind}"><i></i>${BRAIN_KIND_NAME[d.kind]}</div>
        <button type="button" class="icon-btn" data-act="close" title="Close (Esc)" aria-label="Close this memory">${svgIcon('x', 14)}</button></div>
      <p class="brain-panel-text">${esc(d.text)}</p>
      <div class="brain-meta">${esc(brainWho(d))} · ${esc(brainWhen(d))}${d.hits > 1 ? ` · seen ${d.hits} times` : ''}</div>
      <div class="brain-panel-acts">
        <button type="button" class="btn btn-sm" data-act="focus" aria-pressed="${brain.focus}" title="Show only this memory and what it links to">${brain.focus ? 'Show all' : 'Focus'}</button>
        <button type="button" class="btn btn-sm" data-act="copy">Copy</button>
        ${brain.mode === 'list' ? '<button type="button" class="btn btn-sm" data-act="graph">Show in graph</button>' : ''}
        <span class="flex-1"></span>
        <button type="button" class="btn btn-sm brain-forget" data-act="forget">Forget</button>
      </div>
      <h4 class="brain-panel-h">Linked memories <b>${links.length}</b></h4>
      ${links.length ? `<div class="brain-links" role="list">${links.map(n => brainRow(n)).join('')}</div>`
        : '<p class="brain-panel-none">Nothing links here yet. Memories link when they name the same file or share words, or when an agent links them.</p>'}`;
    if (fly && brain.mode === 'graph') brainFlyToDot(d);
  }
  brainRefresh();
}
// A memory written under a file ("src/a.ts: what it does") shows the file as a small tag, not as part of the sentence.
function brainRow(n: BrainDot, q = ''): string {
  const pre = n.kind === 'file' ? null : /^([^\s:]+\.\w+):\s+(.+)$/s.exec(n.text);
  const body = pre ? pre[2] : n.text;
  let text = esc(body);
  for (const w of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    const at = body.toLowerCase().indexOf(w);
    if (at >= 0) { text = `${esc(body.slice(0, at))}<mark>${esc(body.slice(at, at + w.length))}</mark>${esc(body.slice(at + w.length))}`; break; }
  }
  const links = brain.near.get(n.id)?.size ?? 0;
  const file = pre ? `<span class="brain-row-file" title="${escAttr(pre[1])}">${esc(pre[1].split('/').pop()!)}</span>` : '';
  return `<button type="button" class="brain-row${n === brain.pinned ? ' on' : ''}" role="listitem" data-id="${n.id}" data-kind="${n.kind}"><i></i>
    <span class="brain-row-text">${file}${text}</span><span class="brain-meta">${esc(brainWho(n))} · ${esc(brainWhen(n))} · ${links} ${links === 1 ? 'link' : 'links'}</span></button>`;
}
function brainPanelClick(e: MouseEvent): void {
  const t = e.target as HTMLElement;
  const row = t.closest<HTMLElement>('.brain-row');
  if (row) { brainSelect(brain.byId.get(row.dataset.id!) ?? null); return; }
  const act = t.closest<HTMLElement>('[data-act]')?.dataset.act, d = brain.pinned;
  if (!act || !d) return;
  if (act === 'close') brainSelect(null);
  else if (act === 'focus') { brain.focus = !brain.focus; brainSelect(d, false); if (brain.mode === 'graph') brainFlyFit(); }
  else if (act === 'copy') void navigator.clipboard?.writeText(d.text).then(() => toast('Copied'), () => {});
  else if (act === 'graph') { brainMode('graph'); brainSelect(d); }
  else if (act === 'forget') {
    brainSelect(null);
    void api.brain.remove(brain.folder, d.id).then(ok => { if (ok) { toast('Forgotten'); void brainLoad(true); } });
  }
}

/* ----- The list: every memory as text, by kind, newest first; the same search and kind switches ----- */
function brainList(): void {
  const list = brainQ('.brain-list');
  const shown = brain.dots.filter(d => brainShown(d) && brainMatch(d));
  if (!brain.dots.length) { list.innerHTML = ''; return; }
  if (!shown.length) { list.innerHTML = `<p class="brain-list-none">${brain.query ? `No memories match “${esc(brain.query)}”.` : 'Every kind is switched off.'}</p>`; return; }
  list.innerHTML = BRAIN_KINDS.map(({ kind, label }) => {
    const rows = shown.filter(d => d.kind === kind).sort((a, b) => b.at - a.at);
    return rows.length ? `<section class="brain-group"><h4 class="brain-panel-h">${label} <b>${rows.length}</b></h4>${rows.map(d => brainRow(d, brain.query)).join('')}</section>` : '';
  }).join('');
}

/* ----- Hover: a ring at once; links light up only after the pointer rests on a dot for a second,
   so sweeping across the graph doesn't flash the whole thing on and off. ----- */
const BRAIN_HOLD_MS = 1000;
function brainHover(dot: BrainDot | null): void {
  if (dot === brain.hover) return;
  brain.hover = dot;
  clearTimeout(brain.holdTimer);
  if (dot) brain.holdTimer = window.setTimeout(() => { if (brain.hover === dot) { brain.held = dot; brainEaseHold(1); } }, BRAIN_HOLD_MS);
  if (brain.held) brainEaseHold(0);
  brainDraw();
}
// Fades the held dot's links in (300ms) or out (200ms) with the panel easing's feel; reduced motion jumps.
function brainEaseHold(to: 0 | 1): void {
  cancelAnimationFrame(brain.heldFrame);
  const done = () => { if (!to) brain.held = null; brainDraw(); };
  if (brainStill()) { brain.heldT = to; done(); return; }
  const from = brain.heldT, t0 = performance.now(), ms = to ? 300 : 200;
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / ms);
    brain.heldT = from + (to - from) * (1 - (1 - p) ** 3);
    if (p < 1) { brainDraw(); brain.heldFrame = requestAnimationFrame(step); } else done();
  };
  brain.heldFrame = requestAnimationFrame(step);
}

/* ----- Pointer: hover, drag a dot, pan, zoom ----- */
function brainAt(c: HTMLCanvasElement, e: MouseEvent): { wx: number; wy: number; dot: BrainDot | null } {
  const r = c.getBoundingClientRect(), { x, y, k } = brain.view;
  const wx = (e.clientX - r.left - r.width / 2 - x) / k, wy = (e.clientY - r.top - r.height / 2 - y) / k;
  let best: BrainDot | null = null, bestD = Infinity;
  for (const d of brain.dots) {
    if (!brainShown(d)) continue;
    const dd = Math.hypot(d.x - wx, d.y - wy), reach = d.r + 6 / k;
    if (dd <= reach && dd < bestD) { best = d; bestD = dd; }
  }
  return { wx, wy, dot: best };
}
function brainPointer(c: HTMLCanvasElement): void {
  let drag: { dot: BrainDot | null; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null = null;
  c.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    cancelAnimationFrame(brain.fly);
    const { dot } = brainAt(c, e);
    drag = { dot, sx: e.clientX, sy: e.clientY, vx: brain.view.x, vy: brain.view.y, moved: false };
    if (dot) dot.fixed = true;
    c.setPointerCapture(e.pointerId);
    c.classList.add('grabbing');
  });
  c.addEventListener('pointermove', e => {
    if (!drag) {
      const { dot } = brainAt(c, e);
      c.classList.toggle('over-dot', !!dot);
      brainHover(dot);
      return;
    }
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (!drag.moved) return;
    if (drag.dot) {
      const { wx, wy } = brainAt(c, e);
      drag.dot.x = wx; drag.dot.y = wy;
      brainHeat(0.25);
    } else { brain.view.x = drag.vx + dx; brain.view.y = drag.vy + dy; }
    brainDraw();
  });
  const up = () => {
    if (!drag) return;
    if (drag.dot) drag.dot.fixed = false;
    // A click: a dot opens (or closes, if it is the open one); empty space closes the panel.
    if (!drag.moved) brainSelect(drag.dot && drag.dot !== brain.pinned ? drag.dot : null, false);
    drag = null;
    c.classList.remove('grabbing');
  };
  c.addEventListener('pointerup', up);
  c.addEventListener('pointercancel', up);
  c.addEventListener('pointerleave', () => { if (!drag) brainHover(null); });
  c.addEventListener('wheel', e => {
    e.preventDefault();
    cancelAnimationFrame(brain.fly);
    const r = c.getBoundingClientRect(), v = brain.view;
    const px = e.clientX - r.left - r.width / 2, py = e.clientY - r.top - r.height / 2;
    const k = Math.max(0.1, Math.min(6, v.k * Math.exp(-e.deltaY * 0.0015)));
    // The point under the pointer stays under it.
    v.x = px - ((px - v.x) / v.k) * k; v.y = py - ((py - v.y) / v.k) * k; v.k = k;
    brainDraw();
  }, { passive: false });
  c.addEventListener('dblclick', e => { if (!brainAt(c, e).dot) brainFlyFit(); });
}
