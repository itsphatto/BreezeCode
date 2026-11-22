/* ===================== Second brain: a folder's memory as a graph =====================
   Opened from the Agent board: right-click a folder's name in the chats side bar. Each dot is one memory that an
   agent's compaction left behind (main secondbrain.ts); a line means two memories name the same file or share words.
   Dots grow with their links, files are hubs, and memories linked to nothing drift on a ring at the edge.
   Drawn on one canvas with a small force layout: wheel zooms at the pointer, dragging the background pans,
   dragging a dot moves it, hovering one shows what it says, clicking it keeps that card open. */

interface BrainDot extends BrainNode { x: number; y: number; vx: number; vy: number; deg: number; r: number; fixed: boolean }
const BRAIN_KINDS: { kind: BrainKind; label: string }[] = [
  { kind: 'decision', label: 'Decisions' }, { kind: 'fact', label: 'Facts' }, { kind: 'task', label: 'Tasks' }, { kind: 'file', label: 'Files' },
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
  hover: null as BrainDot | null,
  pinned: null as BrainDot | null,
  colors: {} as Record<string, string>,
  back: null as HTMLElement | null,
  off: null as (() => void) | null,
};
const brainStill = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function brainBuild(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'brain';
  el.id = 'secondBrain';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'brainTitle');
  el.innerHTML = `<header class="brain-head">
      <div class="brain-heading"><h2 class="brain-title" id="brainTitle">Second brain</h2><div class="brain-sub"></div></div>
      <div class="brain-legend" role="group" aria-label="Show or hide each kind of memory">${BRAIN_KINDS.map(k =>
        `<button type="button" class="brain-chip" data-kind="${k.kind}" aria-pressed="true"><i></i><span>${k.label}</span><b></b></button>`).join('')}</div>
      <button type="button" class="btn btn-sm brain-summarize" title="Your agent reads this folder's chats and adds what's worth remembering. Uses tokens; you see an estimate first."><span>Summarize chats</span></button>
      <button type="button" class="icon-btn brain-close" title="Close (Esc)" aria-label="Close second brain">${svgIcon('x', 16)}</button>
    </header>
    <canvas class="brain-canvas" aria-label="Memory graph"></canvas>
    <div class="brain-empty hidden"><h3>Nothing remembered yet</h3><p>Memories show up here when an agent's chat in this folder is compacted.</p></div>
    <div class="brain-card hidden" role="tooltip"></div>
    <div class="brain-hint">Scroll to zoom · drag to move · double-click to fit</div>`;
  document.body.appendChild(el);
  brain.canvas = el.querySelector('canvas')!;
  el.querySelector('.brain-close')!.addEventListener('click', closeSecondBrain);
  const sum = el.querySelector<HTMLButtonElement>('.brain-summarize')!;
  sum.addEventListener('click', () => void brainSummarize(sum));
  el.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closeSecondBrain(); } });
  for (const chip of el.querySelectorAll<HTMLButtonElement>('.brain-chip')) chip.addEventListener('click', () => {
    const k = chip.dataset.kind as BrainKind;
    if (brain.hidden.has(k)) brain.hidden.delete(k); else brain.hidden.add(k);
    chip.setAttribute('aria-pressed', String(!brain.hidden.has(k)));
    if (brain.pinned && brain.hidden.has(brain.pinned.kind)) brainPin(null);
    brainDraw();
  });
  brainPointer(brain.canvas);
  new ResizeObserver(() => brainDraw()).observe(brain.canvas);
  return el;
}

// The colors come from the theme (breeze.css --brain-*), read once per open so a theme change is picked up.
function brainColors(): void {
  const cs = getComputedStyle(brain.el!);
  for (const k of ['fact', 'decision', 'task', 'file', 'link', 'link-hi', 'ring']) brain.colors[k] = cs.getPropertyValue(`--brain-${k}`).trim() || '#888';
}

async function openSecondBrain(folder: string): Promise<void> {
  if (!folder) return;
  brain.back = document.activeElement as HTMLElement | null;
  const el = brain.el ??= brainBuild();
  brain.folder = folder;
  brain.view = { x: 0, y: 0, k: 1 };
  brain.dots = [];
  brainPin(null);
  el.querySelector('.brain-sub')!.textContent = folderName(folder);
  el.classList.remove('hidden', 'closing');
  el.classList.add('opening');
  requestAnimationFrame(() => el.classList.remove('opening'));
  brainColors();
  (el.querySelector('.brain-close') as HTMLElement).focus();
  brain.off?.();
  brain.off = api.brain.onChange(m => { if (m && folderKey(m.folder) === folderKey(brain.folder)) void brainLoad(true); });
  await brainLoad(false);
}

function closeSecondBrain(): void {
  const el = brain.el;
  if (!el || el.classList.contains('hidden')) return;
  brain.off?.();
  brain.off = null;
  cancelAnimationFrame(brain.frame);
  brain.frame = 0;
  el.classList.add('closing');
  const done = () => { el.classList.add('hidden'); el.classList.remove('closing'); };
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
  if (brain.pinned && !brain.byId.has(brain.pinned.id)) brainPin(null);
  else if (brain.pinned) brain.pinned = brain.byId.get(brain.pinned.id)!;
  brain.hover = null;
  const el = brain.el!;
  el.querySelector('.brain-empty')!.classList.toggle('hidden', brain.dots.length > 0);
  const count = (k: BrainKind) => brain.dots.filter(d => d.kind === k).length;
  for (const chip of el.querySelectorAll<HTMLElement>('.brain-chip')) chip.querySelector('b')!.textContent = String(count(chip.dataset.kind as BrainKind));
  const mems = brain.dots.length - count('file');
  el.querySelector('.brain-sub')!.textContent = `${folderName(brain.folder)} · ${mems} ${mems === 1 ? 'memory' : 'memories'}`;
  brain.alpha = keep ? Math.max(brain.alpha, 0.4) : 1;
  if (brainStill()) { for (let i = 0; i < 300 && brain.alpha > 0.01; i++) brainTick(); brain.alpha = 0; }
  else if (!keep) for (let i = 0; i < 40; i++) brainTick(); // a head start, so it opens shaped, not as a blob
  if (!keep) brainFit();
  brainRun();
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

/* ----- Drawing ----- */
function brainSize(): { w: number; h: number; dpr: number } {
  const c = brain.canvas!, dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  return { w, h, dpr };
}
function brainFit(): void {
  const shown = brain.dots.filter(d => !brain.hidden.has(d.kind));
  const { w, h } = brainSize();
  if (!shown.length || !w || !h) { brain.view = { x: 0, y: 0, k: 1 }; return; }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const d of shown) { x0 = Math.min(x0, d.x - d.r); y0 = Math.min(y0, d.y - d.r); x1 = Math.max(x1, d.x + d.r); y1 = Math.max(y1, d.y + d.r); }
  const k = Math.max(0.15, Math.min(3, Math.min((w - 80) / (x1 - x0 || 1), (h - 80) / (y1 - y0 || 1))));
  brain.view = { k, x: -((x0 + x1) / 2) * k, y: -((y0 + y1) / 2) * k };
}
function brainDraw(): void {
  const c = brain.canvas;
  if (!c || !brain.el || brain.el.classList.contains('hidden')) return;
  const { w, h, dpr } = brainSize();
  const g = c.getContext('2d')!;
  const { x, y, k } = brain.view, col = brain.colors;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.setTransform(dpr * k, 0, 0, dpr * k, dpr * (w / 2 + x), dpr * (h / 2 + y));
  const focus = brain.pinned ?? brain.hover;
  const near = focus ? brain.near.get(focus.id) ?? new Set<string>() : null;
  const shown = (d: BrainDot) => !brain.hidden.has(d.kind);
  g.lineWidth = 1 / k;
  g.strokeStyle = col.link;
  g.globalAlpha = focus ? 0.35 : 1;
  g.beginPath();
  for (const l of brain.links) if (shown(l.a) && shown(l.b) && !(focus && (l.a === focus || l.b === focus))) { g.moveTo(l.a.x, l.a.y); g.lineTo(l.b.x, l.b.y); }
  g.stroke();
  if (focus) {
    g.globalAlpha = 1;
    g.strokeStyle = col['link-hi'];
    g.lineWidth = 1.5 / k;
    g.beginPath();
    for (const l of brain.links) if ((l.a === focus || l.b === focus) && shown(l.a) && shown(l.b)) { g.moveTo(l.a.x, l.a.y); g.lineTo(l.b.x, l.b.y); }
    g.stroke();
  }
  for (const d of brain.dots) {
    if (!shown(d)) continue;
    g.globalAlpha = !focus || d === focus || near!.has(d.id) ? 1 : 0.25;
    g.fillStyle = col[d.kind];
    g.beginPath();
    g.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    g.fill();
  }
  if (focus && shown(focus)) {
    g.globalAlpha = 1;
    g.strokeStyle = col.ring;
    g.lineWidth = 2 / k;
    g.beginPath();
    g.arc(focus.x, focus.y, focus.r + 3 / k, 0, Math.PI * 2);
    g.stroke();
  }
  g.globalAlpha = 1;
  brainCard();
}

/* ----- The card: what a memory says ----- */
const BRAIN_KIND_NAME: Record<BrainKind, string> = { fact: 'Fact', decision: 'Decision', task: 'Task', file: 'File' };
const BRAIN_AGENT_NAME: Record<string, string> = { you: 'Your prompt', claude: 'Claude Code', codex: 'Codex' };
function brainCard(): void {
  const card = brain.el!.querySelector<HTMLElement>('.brain-card')!;
  const d = brain.pinned ?? brain.hover;
  if (!d || brain.hidden.has(d.kind)) { card.classList.add('hidden'); delete card.dataset.id; return; }
  if (card.dataset.id !== d.id || card.classList.contains('pinned') !== !!brain.pinned) {
    card.dataset.id = d.id;
    card.classList.toggle('pinned', !!brain.pinned);
    const when = new Date(d.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const links = brain.near.get(d.id)?.size ?? 0;
    card.innerHTML = `<div class="brain-card-kind" data-kind="${d.kind}"><i></i>${BRAIN_KIND_NAME[d.kind]}</div>
      <p class="brain-card-text">${esc(d.text)}</p>
      <div class="brain-card-meta">${esc(BRAIN_AGENT_NAME[d.agent] ?? agentNameOf(d.agent))} · ${esc(when)} · ${links} ${links === 1 ? 'link' : 'links'}${d.hits > 1 ? ` · seen ${d.hits} times` : ''}</div>
      ${brain.pinned ? '<button type="button" class="btn btn-sm brain-forget">Forget</button>' : ''}`;
    card.querySelector('.brain-forget')?.addEventListener('click', async () => {
      const id = d.id;
      brainPin(null);
      if (await api.brain.remove(brain.folder, id)) void brainLoad(true);
    });
  }
  // Beside the dot, kept inside the canvas.
  const { w, h } = brainSize();
  const sx = w / 2 + brain.view.x + d.x * brain.view.k, sy = h / 2 + brain.view.y + d.y * brain.view.k;
  const cw = card.offsetWidth, ch = card.offsetHeight, gap = d.r * brain.view.k + 12;
  const left = sx + gap + cw > w - 12 ? sx - gap - cw : sx + gap;
  const top = Math.max(12, Math.min(h - ch - 12, sy - ch / 2));
  card.style.transform = `translate(${Math.round(Math.max(12, left))}px, ${Math.round(top + brain.canvas!.offsetTop)}px)`;
  card.classList.remove('hidden');
}
function brainPin(d: BrainDot | null): void {
  brain.pinned = d;
  brainDraw();
}

/* ----- Pointer: hover, drag a dot, pan, zoom ----- */
function brainAt(c: HTMLCanvasElement, e: MouseEvent): { wx: number; wy: number; dot: BrainDot | null } {
  const r = c.getBoundingClientRect(), { x, y, k } = brain.view;
  const wx = (e.clientX - r.left - r.width / 2 - x) / k, wy = (e.clientY - r.top - r.height / 2 - y) / k;
  let best: BrainDot | null = null, bestD = Infinity;
  for (const d of brain.dots) {
    if (brain.hidden.has(d.kind)) continue;
    const dd = Math.hypot(d.x - wx, d.y - wy), reach = d.r + 5 / k;
    if (dd <= reach && dd < bestD) { best = d; bestD = dd; }
  }
  return { wx, wy, dot: best };
}
function brainPointer(c: HTMLCanvasElement): void {
  let drag: { dot: BrainDot | null; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null = null;
  c.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
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
      if (dot !== brain.hover) { brain.hover = dot; brainDraw(); }
      return;
    }
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
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
    if (!drag.moved) brainPin(drag.dot && drag.dot !== brain.pinned ? drag.dot : null);
    drag = null;
    c.classList.remove('grabbing');
  };
  c.addEventListener('pointerup', up);
  c.addEventListener('pointercancel', up);
  c.addEventListener('pointerleave', () => { if (!drag && brain.hover) { brain.hover = null; brainDraw(); } });
  c.addEventListener('wheel', e => {
    e.preventDefault();
    const r = c.getBoundingClientRect(), v = brain.view;
    const px = e.clientX - r.left - r.width / 2, py = e.clientY - r.top - r.height / 2;
    const k = Math.max(0.1, Math.min(6, v.k * Math.exp(-e.deltaY * 0.0015)));
    // The point under the pointer stays under it.
    v.x = px - ((px - v.x) / v.k) * k; v.y = py - ((py - v.y) / v.k) * k; v.k = k;
    brainDraw();
  }, { passive: false });
  c.addEventListener('dblclick', () => { brainFit(); brainDraw(); });
}
