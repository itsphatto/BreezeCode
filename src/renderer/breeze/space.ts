/* ================= Breeze Space: the sky behind the chat ================= */
// A slow climb through stars and dust: the camera goes up, so they fall past it, the nearer ones faster. While an agent
// works the climb speeds up until they streak. It draws only while the screen is showing, and stands still with reduced motion.
const SPACE_IDLE = .00025, SPACE_BUSY = .016; // window heights fallen per 60fps frame by the nearest star; negative is going down
const SPACE_STARS = 170, SPACE_DUST = 60;
let spaceSpeed = SPACE_IDLE;

// A soft round speck, drawn once and stamped for each mote of dust.
function dustSprite(color: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d');
  if (!g) return c;
  const soft = g.createRadialGradient(8, 8, 0, 8, 8, 8);
  soft.addColorStop(0, color);
  soft.addColorStop(1, 'transparent');
  g.fillStyle = soft;
  g.fillRect(0, 0, 16, 16);
  return c;
}

// x and y are fractions of the sky; near runs from 0 (far, slow, faint) to 1 (close, fast, bright).
interface SpaceSpeck { x: number; y: number; near: number; phase: number; }
const scatterSpecks = (n: number): SpaceSpeck[] =>
  Array.from({ length: n }, () => ({ x: Math.random(), y: Math.random(), near: Math.random() ** 2, phase: Math.random() * 6.28 }));
const dustLight = dustSprite('#9db4d8'), dustInk = dustSprite('#6b5a3e');
// Well past the sky's edge, it comes back in beyond the other one: far enough that even the longest streak's tail
// has left first, so nothing vanishes in view.
function fallSpeck(p: SpaceSpeck, by: number): void {
  p.y += by;
  if (p.y > 1.2) { p.y = -.2; p.x = Math.random(); } else if (p.y < -.2) { p.y = 1.2; p.x = Math.random(); }
}
// One frame of stars and dust. k is this frame's length in 60fps frames; warp eases them back as they streak.
function paintSpace(ctx: CanvasRenderingContext2D, w: number, h: number, stars: SpaceSpeck[], dust: SpaceSpeck[], t: number, speed: number, k: number, warp: number): void {
  ctx.clearRect(0, 0, w, h);
  const ink = document.documentElement.dataset.theme === 'light';
  const dim = (ink ? .45 : .85) * (1 - warp * .35); // streaks ease back a little, so the reply over them stays easy to read
  const streak = speed * h * 5; // how far it fell in the last few frames, for the nearest star
  ctx.strokeStyle = ink ? '#463a28' : '#e4edff';
  ctx.lineCap = 'round';
  for (const s of stars) {
    const pace = .25 + s.near * .75;
    fallSpeck(s, speed * pace * k);
    const x = s.x * w, y = s.y * h, size = .6 + s.near * 1.6;
    ctx.globalAlpha = (.35 + s.near * .65) * dim * (.7 + .3 * Math.sin(t * .0015 + s.phase));
    // Always the same line: slow, its length is next to nothing and the round cap makes it a dot, so a star stretches
    // into a streak and back without ever changing shape.
    ctx.lineWidth = size;
    ctx.beginPath(); ctx.moveTo(x, y - streak * pace); ctx.lineTo(x, y); ctx.stroke();
  }
  // Dust is closer than the stars, so it passes faster, swaying a little as it goes.
  const mote = ink ? dustInk : dustLight;
  for (const d of dust) {
    const pace = 1.2 + d.near * .8;
    fallSpeck(d, speed * pace * k);
    const size = 3 + d.near * 7, x = d.x * w + Math.sin(t * .0004 + d.phase) * 8, y = d.y * h;
    ctx.globalAlpha = (.08 + d.near * .22) * dim;
    ctx.drawImage(mote, x - size / 2, y - size / 2 - Math.max(streak, 0) * pace, size, size + Math.abs(streak) * pace);
  }
  ctx.globalAlpha = 1;
}

function startSpace(): void {
  const canvas = $<HTMLCanvasElement>('#spaceSky');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const stars = scatterSpecks(SPACE_STARS), dust = scatterSpecks(SPACE_DUST);
  let w = 0, h = 0, last = 0, frame = 0;
  // Not under a dialog either: its blur hides the drift, and every frame drawn behind one costs the dialog a frame.
  const showing = () => !document.hidden && !$('#box').classList.contains('hidden') && !document.body.matches('.vibing:not(.vibe-side)') // beside Vibe Mode the sky still shows
    && !document.querySelector('#modalRoot > .scrim');
  const fit = () => {
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const step = (t: number) => {
    frame = 0;
    if (!showing()) { last = 0; spaceSpeed = SPACE_IDLE; return; } // the watcher below starts it again; the last picture stays for the way back
    const target = surfaceTabs.box.some(tabBusy) ? SPACE_BUSY : SPACE_IDLE;
    const warp = (Math.abs(spaceSpeed) - SPACE_IDLE) / (SPACE_BUSY - SPACE_IDLE);
    // Idling takes every other frame: it runs for hours, and the drift is too slow to tell.
    if (warp < .02 && target === SPACE_IDLE && last && t - last < 30) { frame = requestAnimationFrame(step); return; }
    if (canvas.clientWidth !== w || canvas.clientHeight !== h) fit();
    const dt = last ? t - last : 16.7;
    const k = Math.min(3, dt / 16.7); // in 60fps frames, so a slow frame doesn't slow the climb
    last = t;
    spaceSpeed += (target - spaceSpeed) * (1 - Math.exp(-dt / 450)); // eases into the new speed over about a second
    paintSpace(ctx, w, h, stars, dust, t, spaceSpeed, k, warp);
    frame = requestAnimationFrame(step);
  };
  // Starts the climb whenever the screen comes up.
  setInterval(() => { if (!frame && showing()) frame = requestAnimationFrame(step); }, 500);
}
startSpace();

// The Breeze Space buttons: while hovered, a little of that sky rises behind the label, faster than the real one moves
// (which would hardly show at this size), and now and then a star shines.
const SPACE_BTN_SPEED = -.004, SHINE_MS = 700, SHINE_CHANCE = .04;
const shineGlow = dustSprite('#ffffff');
for (const btn of $$<HTMLElement>('.space-btn')) {
  const canvas = document.createElement('canvas');
  canvas.className = 'space-btn-sky';
  canvas.setAttribute('aria-hidden', 'true');
  btn.prepend(canvas);
  const ctx = canvas.getContext('2d');
  const stars = scatterSpecks(26), dust = scatterSpecks(8);
  let frame = 0, last = 0;
  let shines: { star: SpaceSpeck; at: number }[] = []; // per frame, about one star in 25 frames starts to shine
  const draw = (t: number) => {
    frame = 0;
    if (!ctx) return;
    const dpr = Math.min(devicePixelRatio || 1, 2), w = btn.clientWidth, h = btn.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintSpace(ctx, w, h, stars, dust, t, SPACE_BTN_SPEED, last ? Math.min(3, (t - last) / 16.7) : 1, 0);
    last = t;
    if (Math.random() < SHINE_CHANCE) shines.push({ star: stars[Math.floor(Math.random() * stars.length)], at: t });
    shines = shines.filter(s => t - s.at < SHINE_MS);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = .6;
    for (const { star, at } of shines) {
      const a = Math.sin((t - at) / SHINE_MS * Math.PI), x = star.x * w, y = star.y * h, reach = 2 + a * 5, glow = 4 + a * 10;
      ctx.globalAlpha = a;
      ctx.drawImage(shineGlow, x - glow / 2, y - glow / 2, glow, glow);
      ctx.beginPath(); ctx.moveTo(x - reach, y); ctx.lineTo(x + reach, y); ctx.moveTo(x, y - reach); ctx.lineTo(x, y + reach); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    frame = requestAnimationFrame(draw);
  };
  // The light theme has no sky on the button (breeze.css): it just fades its hover in like any other button.
  const start = () => { if (!frame && document.documentElement.dataset.theme !== 'light') frame = requestAnimationFrame(draw); };
  const stop = () => { cancelAnimationFrame(frame); frame = 0; last = 0; }; // the last picture stays for the fade out
  btn.addEventListener('pointerenter', start);
  btn.addEventListener('focus', start);
  btn.addEventListener('pointerleave', stop);
  btn.addEventListener('blur', stop);
}
