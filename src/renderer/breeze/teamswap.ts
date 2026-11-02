/* ================= Into and out of the debugger: a small team rebuilds the window ================= */
// swapScreen plays this between the IDE and the debugger, like watching people work in a shared design file: a few
// mouse cursors take the panels one at a time, cropping or dragging the old ones away and drawing or dropping the new
// ones in. A panel in the same place with the same content on both screens is never touched. The panels are the real
// elements, clipped and moved without any layout; the cursors and selection boxes are drawn on one canvas above them.
const TEAM_BLOCKS = '#logoHome, #menubar, #projectName, #updateBtn, .layout-btns, #avatars, #sidebar, #editorPane, #previewPane, #terminal, #agents, .statusbar, #settingsBtn, [data-rail="settingsBtn"], #dbgTools, #dbgWhat, #dbgBack, #dbgStackPanel, #dbgBpPanel, #dbgCenter, #dbgBottom, #dbgVarsPanel, #dbgWatchPanel';
const TEAM_CREW = [{ name: 'Planner', colour: '#a78bfa' }, { name: 'Builder', colour: '#38bdf8' }, { name: 'Assistant', colour: '#34d399' }, { name: 'Reviewer', colour: '#fbbf24' }, { name: 'Tester', colour: '#f472b6' }];
const TEAM_HOLD_MS = 50; // a beat with the block selected before the drag starts
const TEAM_REST_MS = 30; // and one after letting go
const TEAM_EXIT_MS = 220; // the crew leaving the window
const TEAM_ARROW = 'M0 0 L0 15 L4 11.5 L6.5 17 L9 16 L6.5 10.5 L12 10.5 Z';

interface TeamBlock { el?: HTMLElement; x: number; y: number; w: number; h: number; key: string; }
// ax/ay: the side of the block that stays put while it's cropped (0 left or top, 1 right or bottom, -1 that axis isn't
// cropped). Neither cropped means it's dragged instead, from or to (dx, dy) away.
interface TeamTask { block: TeamBlock; out: boolean; who: number; ax: number; ay: number; dx: number; dy: number; at: number; start: number; end: number; }
type TeamPoint = { x: number; y: number };

function teamBlocks(screen: HTMLElement): TeamBlock[] {
  return Array.from(screen.querySelectorAll<HTMLElement>(TEAM_BLOCKS)).filter(el => el.checkVisibility()).map(el => {
    const r = el.getBoundingClientRect();
    return { el, x: r.left, y: r.top, w: r.width, h: r.height, key: `${[r.left, r.top, r.width, r.height].map(Math.round).join()}|${el.textContent}` };
  }).filter(b => b.w > 2 && b.h > 2);
}

// What differs between two screens: anything in the same place with the same content on both is dropped from both.
function changedBlocks<T extends { key: string }>(from: T[], to: T[]): [T[], T[]] {
  const inFrom = new Set(from.map(b => b.key)), inTo = new Set(to.map(b => b.key));
  return [from.filter(b => !inTo.has(b.key)), to.filter(b => !inFrom.has(b.key))];
}

// The block and the hand on it at p (0 to 1) through a task.
function teamShape(t: TeamTask, p: number): { x: number; y: number; w: number; h: number; alpha: number; cx: number; cy: number } {
  const b = t.block, shown = t.out ? 1 - p : p;
  if (t.ax < 0 && t.ay < 0) {
    const x = b.x + t.dx * (1 - shown), y = b.y + t.dy * (1 - shown);
    return { x, y, w: b.w, h: b.h, alpha: shown, cx: x + b.w / 2, cy: y + b.h / 2 };
  }
  const w = t.ax < 0 ? b.w : b.w * shown, h = t.ay < 0 ? b.h : b.h * shown;
  const x = t.ax === 1 ? b.x + b.w - w : b.x, y = t.ay === 1 ? b.y + b.h - h : b.y;
  return { x, y, w, h, alpha: 1, cx: t.ax < 0 ? x + w / 2 : t.ax === 0 ? x + w : x, cy: t.ay < 0 ? y + h / 2 : t.ay === 0 ? y + h : y };
}

// Who does what, when. Each old block is followed by the new one taking most of its place, and whoever is free next
// takes the next job, so the window changes a few blocks at a time rather than all at once.
function planTeam(old: TeamBlock[], fresh: TeamBlock[], from: TeamPoint[], random: () => number = Math.random): TeamTask[] {
  const shuffled = <T>(list: T[]) => {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  const overlap = (a: TeamBlock, b: TeamBlock) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const left = shuffled(fresh), jobs: { block: TeamBlock; out: boolean }[] = [];
  for (const block of shuffled(old)) {
    jobs.push({ block, out: true });
    const areas = left.map(n => overlap(block, n)), most = Math.max(0, ...areas);
    if (most > 0) jobs.push({ block: left.splice(areas.indexOf(most), 1)[0], out: false });
  }
  for (const block of left) jobs.push({ block, out: false });

  const hands = from.map(p => ({ ...p })), free = from.map((_, i) => i * 80);
  return jobs.map(({ block, out }) => {
    const who = free.indexOf(Math.min(...free)), kind = random(), side = () => (random() < .5 ? 0 : 1);
    const t: TeamTask = { block, out, who, ax: -1, ay: -1, dx: 0, dy: 0, at: free[who], start: 0, end: 0 };
    if (kind < .4) { if (block.h < 60 || random() < .5) t.ax = side(); else t.ay = side(); }
    else if (kind < .75 && block.h >= 60) { t.ax = side(); t.ay = side(); }
    else { const far = (side() ? 1 : -1) * 70; if (side()) t.dx = far; else t.dy = far; }
    const s = teamShape(t, 0), e = teamShape(t, 1), hand = hands[who];
    t.start = t.at + Math.min(240, Math.max(110, Math.hypot(s.cx - hand.x, s.cy - hand.y) / 3.5)) + TEAM_HOLD_MS;
    t.end = t.start + Math.min(320, Math.max(170, Math.sqrt(block.w * block.h) / 1.6));
    hands[who] = { x: e.cx, y: e.cy };
    free[who] = t.end + TEAM_REST_MS;
    return t;
  });
}

const teamEase = (p: number) => (p < .5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);

// Where a cursor is at time t: on its way to the next block, working on it, or leaving once its jobs are done.
function teamHand(tasks: TeamTask[], from: TeamPoint, t: number): TeamPoint & { down: boolean } {
  const lerp = (a: TeamPoint, b: TeamPoint, p: number) => ({ x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p, down: false });
  let last = from;
  for (const k of tasks) {
    const s = teamShape(k, 0), e = teamShape(k, 1);
    if (t < k.at) return lerp(last, last, 0);
    const reach = k.start - TEAM_HOLD_MS;
    if (t < reach) return lerp(last, { x: s.cx, y: s.cy }, teamEase((t - k.at) / (reach - k.at)));
    if (t <= k.end) {
      const now = teamShape(k, teamEase(Math.max(0, (t - k.start) / (k.end - k.start))));
      return { x: now.cx, y: now.cy, down: true };
    }
    last = { x: e.cx, y: e.cy };
  }
  const done = tasks.length ? tasks[tasks.length - 1].end + TEAM_REST_MS : 0;
  return lerp(last, from, teamEase(Math.max(0, Math.min(1, (t - done) / TEAM_EXIT_MS))));
}

function paintTeam(g: CanvasRenderingContext2D, tasks: TeamTask[], from: TeamPoint[], t: number, font: string): void {
  g.clearRect(0, 0, innerWidth, innerHeight);
  // Selection boxes: handles on a block being dragged, crop marks on one being cropped, dashes on one being drawn.
  for (const k of tasks) {
    if (t < k.start - TEAM_HOLD_MS || t > k.end + TEAM_REST_MS) continue;
    const colour = TEAM_CREW[k.who].colour, s = teamShape(k, teamEase(Math.max(0, Math.min(1, (t - k.start) / (k.end - k.start)))));
    const dragged = k.ax < 0 && k.ay < 0, drawn = !k.out && k.ax >= 0 && k.ay >= 0;
    const corners = [[s.x, s.y, 1, 1], [s.x + s.w, s.y, -1, 1], [s.x, s.y + s.h, 1, -1], [s.x + s.w, s.y + s.h, -1, -1]];
    g.strokeStyle = g.fillStyle = colour;
    g.lineWidth = 1.5;
    g.setLineDash(drawn ? [5, 4] : []);
    if (drawn) { g.globalAlpha = .1; g.fillRect(s.x, s.y, s.w, s.h); g.globalAlpha = 1; }
    g.strokeRect(s.x, s.y, s.w, s.h);
    g.setLineDash([]);
    if (drawn) continue;
    for (const [x, y, dx, dy] of corners) {
      if (dragged) {
        g.fillStyle = '#fff';
        g.fillRect(x - 3.5, y - 3.5, 7, 7);
        g.strokeRect(x - 3.5, y - 3.5, 7, 7);
      } else {
        const arm = Math.min(14, s.w / 2, s.h / 2);
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(x + dx * arm, y);
        g.lineTo(x, y);
        g.lineTo(x, y + dy * arm);
        g.stroke();
      }
    }
  }
  const arrow = new Path2D(TEAM_ARROW);
  g.font = `600 11px ${font}`;
  g.textBaseline = 'middle';
  TEAM_CREW.forEach((c, who) => {
    const hand = teamHand(tasks.filter(k => k.who === who), from[who], t);
    g.save();
    g.translate(hand.x, hand.y);
    if (hand.down) g.scale(.88, .88); // the button held down
    g.fillStyle = c.colour;
    g.strokeStyle = '#fff';
    g.lineWidth = 1.25;
    g.fill(arrow);
    g.stroke(arrow);
    const w = g.measureText(c.name).width + 12;
    g.beginPath();
    g.roundRect(11, 17, w, 18, 5);
    g.fill();
    g.fillStyle = '#111114';
    g.fillText(c.name, 17, 26.5);
    g.restore();
  });
}

// Plays it with `next` above `prev` and calls done when it has finished. Gives back how to stop early, and how long it takes.
function teamSwap(prev: HTMLElement, next: HTMLElement, done: () => void): { stop: () => void; ms: number } {
  const [old, fresh] = changedBlocks(teamBlocks(prev), teamBlocks(next));
  const from = [{ x: -30, y: innerHeight * .3 }, { x: innerWidth + 30, y: innerHeight * .2 }, { x: innerWidth * .3, y: innerHeight + 30 }, { x: innerWidth + 30, y: innerHeight * .8 }, { x: innerWidth * .6, y: -30 }];
  const tasks = planTeam(old, fresh, from);
  const total = Math.max(0, ...tasks.map(k => k.end)) + TEAM_REST_MS + TEAM_EXIT_MS;
  const font = getComputedStyle(document.body).fontFamily, dpr = devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.className = 'swap-team';
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  document.body.append(canvas);
  const g = canvas.getContext('2d') as CanvasRenderingContext2D;
  g.scale(dpr, dpr);

  const place = (k: TeamTask, p: number) => {
    const s = teamShape(k, p), b = k.block, el = b.el as HTMLElement;
    if (k.ax < 0 && k.ay < 0) {
      el.style.clipPath = '';
      el.style.transform = `translate(${s.x - b.x}px, ${s.y - b.y}px)`;
      el.style.opacity = String(s.alpha);
    } else el.style.clipPath = `inset(${s.y - b.y}px ${b.x + b.w - s.x - s.w}px ${b.y + b.h - s.y - s.h}px ${s.x - b.x}px)`;
  };
  for (const k of tasks) {
    const el = k.block.el as HTMLElement;
    el.style.transition = 'none';
    if (!k.out) el.style.clipPath = 'inset(50%)';
  }
  const t0 = performance.now();
  let frame = 0;
  const tick = (now: number) => {
    const t = now - t0;
    if (t >= total) { done(); return; }
    for (const k of tasks) {
      if (t < k.start) continue;
      const el = k.block.el as HTMLElement;
      if (t < k.end) place(k, teamEase((t - k.start) / (k.end - k.start)));
      else if (k.out) { el.style.clipPath = 'inset(50%)'; el.style.transform = el.style.opacity = ''; }
      else el.style.clipPath = el.style.transform = el.style.opacity = '';
    }
    paintTeam(g, tasks, from, t, font);
    frame = requestAnimationFrame(tick);
  };
  tick(t0);
  return {
    ms: total,
    stop: () => {
      cancelAnimationFrame(frame);
      canvas.remove();
      for (const k of tasks) {
        const el = k.block.el as HTMLElement;
        el.style.clipPath = el.style.transform = el.style.opacity = el.style.transition = '';
      }
      prev.classList.remove('screen-team');
      next.classList.remove('screen-team');
    },
  };
}
