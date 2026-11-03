/* ================= Breeze Space: the sky behind the chat, and the climb up to it ================= */
// A slow climb through stars and dust: the camera goes up, so they fall past it, the nearer ones faster. While an agent
// works the climb speeds up until they streak. It draws only while the screen is showing, and stands still with reduced motion.
const SPACE_IDLE = .00025, SPACE_BUSY = .016; // window heights fallen per 60fps frame by the nearest star; negative is going down
const SPACE_STARS = 170, SPACE_DUST = 60;
let spaceSpeed = SPACE_IDLE;
// A flight to or from Space sets the pace: from the speed it found, gliding up to a peak (as a fraction of the flight, when
// the sky is moving fastest) and back down to where it ends.
interface SpaceRush { at: number; from: number; peak: number; peakAt: number; to: number; }
let spaceRush: SpaceRush | null = null;
function rushSpeed(r: SpaceRush, now: number): number {
  const p = Math.min(1, Math.max(0, (now - r.at) / LIFT_MS));
  const glide = (u: number) => u * u * u * (u * (u * 6 - 15) + 10); // no sudden change of speed at either end
  return p < r.peakAt ? r.from + (r.peak - r.from) * glide(p / r.peakAt) : r.peak + (r.to - r.peak) * glide((p - r.peakAt) / (1 - r.peakAt));
}

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

function startSpace(): void {
  const canvas = $<HTMLCanvasElement>('#spaceSky');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  // x and y are fractions of the window; near runs from 0 (far, slow, faint) to 1 (close, fast, bright).
  const scatter = () => ({ x: Math.random(), y: Math.random(), near: Math.random() ** 2, phase: Math.random() * 6.28 });
  const stars = Array.from({ length: SPACE_STARS }, scatter);
  const dust = Array.from({ length: SPACE_DUST }, scatter);
  const dustLight = dustSprite('#9db4d8'), dustInk = dustSprite('#6b5a3e');
  let w = 0, h = 0, last = 0, frame = 0;
  const showing = () => !document.hidden && !$('#box').classList.contains('hidden') && !document.body.classList.contains('vibing');
  const fit = () => {
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  // Well past the window's edge, it comes back in beyond the other one: far enough that even the longest streak's tail
  // has left the window first, so nothing vanishes in view.
  const fall = (p: { x: number; y: number }, by: number) => {
    p.y += by;
    if (p.y > 1.2) { p.y = -.2; p.x = Math.random(); } else if (p.y < -.2) { p.y = 1.2; p.x = Math.random(); }
  };

  const step = (t: number) => {
    frame = 0;
    if (!showing()) { last = 0; spaceSpeed = SPACE_IDLE; return; } // the watcher below starts it again; the last picture stays for the way back
    const still = reduceMotion.matches;
    const target = surfaceTabs.box.some(tabBusy) ? SPACE_BUSY : SPACE_IDLE;
    const warp = (Math.abs(spaceSpeed) - SPACE_IDLE) / (SPACE_BUSY - SPACE_IDLE);
    // Idling takes every other frame: it runs for hours, and the drift is too slow to tell.
    if (!still && !spaceRush && warp < .02 && target === SPACE_IDLE && last && t - last < 30) { frame = requestAnimationFrame(step); return; }
    if (canvas.clientWidth !== w || canvas.clientHeight !== h) fit();
    const dt = last ? t - last : 16.7;
    const k = Math.min(3, dt / 16.7); // in 60fps frames, so a slow frame doesn't slow the climb
    last = t;
    if (spaceRush) spaceSpeed = rushSpeed(spaceRush, t);
    else spaceSpeed += (target - spaceSpeed) * (1 - Math.exp(-dt / 450)); // eases into the new speed over about a second
    const speed = spaceSpeed;
    ctx.clearRect(0, 0, w, h);
    const ink = document.documentElement.dataset.theme === 'light';
    const dim = (ink ? .45 : .85) * (1 - warp * .35); // streaks ease back a little, so the reply over them stays easy to read
    const streak = speed * h * 5; // how far it fell in the last few frames, for the nearest star
    ctx.strokeStyle = ink ? '#463a28' : '#e4edff';
    ctx.lineCap = 'round';
    for (const s of stars) {
      const pace = .25 + s.near * .75;
      if (!still) fall(s, speed * pace * k);
      const x = s.x * w, y = s.y * h, size = .6 + s.near * 1.6;
      ctx.globalAlpha = (.35 + s.near * .65) * dim * (still ? .8 : .7 + .3 * Math.sin(t * .0015 + s.phase));
      // Always the same line: slow, its length is next to nothing and the round cap makes it a dot, so a star stretches
      // into a streak and back without ever changing shape.
      ctx.lineWidth = size;
      ctx.beginPath(); ctx.moveTo(x, y - streak * pace); ctx.lineTo(x, y); ctx.stroke();
    }
    // Dust is closer than the stars, so it passes faster, swaying a little as it goes.
    const mote = ink ? dustInk : dustLight;
    for (const d of dust) {
      const pace = 1.2 + d.near * .8;
      if (!still) fall(d, speed * pace * k);
      const size = 3 + d.near * 7, x = d.x * w + (still ? 0 : Math.sin(t * .0004 + d.phase) * 8), y = d.y * h;
      ctx.globalAlpha = (.08 + d.near * .22) * dim;
      ctx.drawImage(mote, x - size / 2, y - size / 2 - Math.max(streak, 0) * pace, size, size + Math.abs(streak) * pace);
    }
    ctx.globalAlpha = 1;
    if (!still) frame = requestAnimationFrame(step);
  };
  // Starts the climb whenever the screen comes up (and, with reduced motion, keeps the still picture fitted).
  setInterval(() => { if (!frame && showing()) frame = requestAnimationFrame(step); }, 500);
}
startSpace();

/* ----- The flight from the IDE: the page rounds off and drops away as the camera rises through blue sky, low clouds and
   a thick deck of them, then thin wisps as the air thins. There are no stars of the flight's own: the sky slowly turns
   see-through onto Breeze Space's canvas, so the stars and dust that come out are the ones you end up with. ----- */
const LIFT_MS = 3600; // the whole flight; breeze.css times the page, the sky and the screen's contents to fit
const LIFT_PEAK = .42; // when the sky moves fastest, as a fraction of the flight (liftAir: the middle of its first 3s)
const CLIMB_CLOUDS = [
  { count: 6, width: 45, widthVary: 45, left: -10, leftVary: 80, opacity: .75, delay: 200, delayVary: 900, duration: 1300, durationVary: 300 }, // low, scattered
  { count: 5, width: 130, widthVary: 50, left: -60, leftVary: 30, opacity: .95, delay: 900, delayVary: 300, duration: 950, durationVary: 200 }, // the deck: fills the window
  { count: 5, width: 70, widthVary: 40, left: -15, leftVary: 80, opacity: .22, delay: 1700, delayVary: 400, duration: 1200, durationVary: 200 }, // high, thin
];

// Soft puffs in a heap, tallest in the middle, shaded a little blue underneath. Soft enough that the low resolution
// doesn't show when it is stretched across the window.
function cloudSprite(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 640; c.height = 260;
  const g = c.getContext('2d');
  if (!g) return c;
  for (let i = 0; i < 40; i++) {
    const along = Math.random(), hump = Math.sin(along * Math.PI);
    const x = 640 * (.1 + along * .8), y = 260 * (.65 - Math.random() * .4 * hump), r = 260 * (.1 + Math.random() * .2) * (.6 + hump * .6);
    const puff = g.createRadialGradient(x, y, 0, x, y, r);
    puff.addColorStop(0, 'rgba(255, 255, 255, .55)');
    puff.addColorStop(1, 'rgba(255, 255, 255, 0)');
    g.fillStyle = puff;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const shade = g.createLinearGradient(0, 60, 0, 260);
  shade.addColorStop(0, 'rgba(140, 170, 210, 0)');
  shade.addColorStop(1, 'rgba(140, 170, 210, .5)');
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = shade;
  g.fillRect(0, 0, 640, 260);
  return c;
}

// `down`: the same flight played backwards, from Space to the IDE, which rises to meet the camera.
function flyBetween(next: HTMLElement, down: boolean): void {
  const sky = document.createElement('div');
  sky.className = down ? 'lift-space down' : 'lift-space';
  const clouds = document.createElement('div');
  clouds.className = 'lift-clouds';
  for (const el of [sky, clouds]) el.setAttribute('aria-hidden', 'true');
  for (const c of CLIMB_CLOUDS) {
    for (let i = 0; i < c.count; i++) {
      const cloud = cloudSprite();
      cloud.style.width = `${c.width + Math.random() * c.widthVary}vw`;
      cloud.style.left = `${c.left + Math.random() * c.leftVary}vw`;
      cloud.style.opacity = String(c.opacity);
      const delay = c.delay + Math.random() * c.delayVary, duration = c.duration + Math.random() * c.durationVary;
      const path = [{ transform: 'translateY(-100%)' }, { transform: 'translateY(110vh)' }];
      // Compositor-run, like the rest of the flight: filling the new screen keeps the page busy just then.
      cloud.animate(down ? path.reverse() : path, { delay: down ? LIFT_MS - delay - duration : delay, duration, fill: 'both' });
      clouds.append(cloud);
    }
  }
  document.body.append(sky, clouds);
  // The stars keep pace with the sky: falling past the camera on the way up and settling into their drift, rising on the way down.
  spaceRush = down
    ? { at: performance.now(), from: spaceSpeed, peak: -SPACE_BUSY, peakAt: 1 - LIFT_PEAK, to: -SPACE_IDLE }
    : { at: performance.now(), from: spaceSpeed, peak: SPACE_BUSY, peakAt: LIFT_PEAK, to: SPACE_IDLE };
  const arriving = down ? 'screen-land' : 'lift-arrive';
  next.classList.add(arriving);
  const finish = () => {
    clearTimeout(timer);
    sky.remove();
    clouds.remove();
    next.classList.remove(arriving);
    spaceRush = null;
    stopFlight = null;
  };
  const timer = setTimeout(finish, LIFT_MS);
  stopFlight = finish;
}
