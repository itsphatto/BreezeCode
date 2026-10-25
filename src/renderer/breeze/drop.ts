/* ----- Dropping files from the computer ----- */
// Files dragged in from Explorer are copied into the project: into the clicked folder in the explorer, or the open
// file's folder when dropped on the editor. Anywhere else the drop is refused (it would replace Breeze with the file).
const DROP_MAX_FILES = 500;
const DROP_MAX_BYTES = 50 * 1024 * 1024;
const DROP_SKIP = new Set(['.git', 'node_modules']);
interface Dropped { rel: string; file: File; }
let dropMark: HTMLElement | null = null;
let draggedTreePath: string | null = null;
let draggedTreeIsDir = false;
let agentDropMark: HTMLElement | null = null;
const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
function markDrop(el: HTMLElement | null): void {
  if (dropMark === el) return;
  dropMark?.classList.remove('drop-over');
  dropMark = el;
  el?.classList.add('drop-over');
}
interface BorderSample {
  bx: number;
  by: number;
  nx: number;
  ny: number;
  s: number;
}

interface WaveConfig {
  t: number;
  speed: number;
  baseDepth: number;
  maxSurge: number;
  influenceRadius: number;
  harmonics: [number, number, number, number];
  swellM: number;
  blurRadius: number;
  colorStops: { stop: number; color: string }[];
}

interface FluidCanvasState {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  container: HTMLElement;
  curX: number;
  curY: number;
  targetX: number;
  targetY: number;
  glowS: number;
  targetS: number;
  glowX: number;
  glowY: number;
  energies: Float32Array;
  active: boolean;
  fadeStartTime: number | null;
  animId: number | null;
  time: number;
}

const fluidCanvases = new Map<HTMLElement, FluidCanvasState>();

interface BorderSamplingResult {
  P: number;
  samples: BorderSample[];
}

function sampleBorder(W: number, H: number, R: number, count: number): BorderSamplingResult {
  const r = Math.max(0, Math.min(R, W / 2, H / 2));
  const wStraight = Math.max(0, W - 2 * r);
  const hStraight = Math.max(0, H - 2 * r);
  const cornerLen = r > 0.5 ? (Math.PI / 2) * r : 0;
  const P = 2 * wStraight + 2 * hStraight + 4 * cornerLen;
  if (P <= 0) return { P: 0, samples: [] };

  const samples: BorderSample[] = [];
  for (let i = 0; i < count; i++) {
    const s = (i / count) * P;
    let bx: number, by: number, nx: number, ny: number;

    if (r <= 0.5) {
      if (s <= W) {
        bx = s;
        by = 0;
        nx = 0;
        ny = 1;
      } else if (s <= W + H) {
        bx = W;
        by = s - W;
        nx = -1;
        ny = 0;
      } else if (s <= 2 * W + H) {
        bx = W - (s - W - H);
        by = H;
        nx = 0;
        ny = -1;
      } else {
        bx = 0;
        by = H - (s - 2 * W - H);
        nx = 1;
        ny = 0;
      }
    } else if (s <= wStraight) {
      bx = r + s;
      by = 0;
      nx = 0;
      ny = 1;
    } else if (s <= wStraight + cornerLen) {
      const frac = (s - wStraight) / cornerLen;
      const angle = -Math.PI / 2 + frac * (Math.PI / 2);
      bx = W - r + Math.cos(angle) * r;
      by = r + Math.sin(angle) * r;
      nx = -Math.cos(angle);
      ny = -Math.sin(angle);
    } else if (s <= wStraight + cornerLen + hStraight) {
      const dist = s - (wStraight + cornerLen);
      bx = W;
      by = r + dist;
      nx = -1;
      ny = 0;
    } else if (s <= wStraight + 2 * cornerLen + hStraight) {
      const frac = (s - (wStraight + cornerLen + hStraight)) / cornerLen;
      const angle = frac * (Math.PI / 2);
      bx = W - r + Math.cos(angle) * r;
      by = H - r + Math.sin(angle) * r;
      nx = -Math.cos(angle);
      ny = -Math.sin(angle);
    } else if (s <= 2 * wStraight + 2 * cornerLen + hStraight) {
      const dist = s - (wStraight + 2 * cornerLen + hStraight);
      bx = W - r - dist;
      by = H;
      nx = 0;
      ny = -1;
    } else if (s <= 2 * wStraight + 3 * cornerLen + hStraight) {
      const frac = (s - (2 * wStraight + 2 * cornerLen + hStraight)) / cornerLen;
      const angle = Math.PI / 2 + frac * (Math.PI / 2);
      bx = r + Math.cos(angle) * r;
      by = H - r + Math.sin(angle) * r;
      nx = -Math.cos(angle);
      ny = -Math.sin(angle);
    } else if (s <= 2 * wStraight + 3 * cornerLen + 2 * hStraight) {
      const dist = s - (2 * wStraight + 3 * cornerLen + hStraight);
      bx = 0;
      by = H - r - dist;
      nx = 1;
      ny = 0;
    } else {
      const frac = (s - (2 * wStraight + 3 * cornerLen + 2 * hStraight)) / cornerLen;
      const angle = Math.PI + frac * (Math.PI / 2);
      bx = r + Math.cos(angle) * r;
      by = r + Math.sin(angle) * r;
      nx = -Math.cos(angle);
      ny = -Math.sin(angle);
    }

    samples.push({ bx, by, nx, ny, s });
  }
  return { P, samples };
}

interface BlurFadeParams {
  ctx: CanvasRenderingContext2D;
  samples: BorderSample[];
  P: number;
  energies: Float32Array;
  gx: number;
  gy: number;
  cfg: WaveConfig;
  W: number;
  H: number;
}
function drawFluidBlurFade(p: BlurFadeParams): void {
  const { ctx, samples, P, energies, gx, gy, cfg, W, H } = p;
  const N = samples.length;
  if (N < 4 || P <= 0) return;

  const t = cfg.t * cfg.speed;
  const maxSafeDepth = Math.max(24, Math.min(150, Math.min(W, H) * 0.45));

  const [m1, m2, m3, m4] = cfg.harmonics;
  const k1 = (2 * Math.PI * m1) / P;
  const k2 = (2 * Math.PI * m2) / P;
  const k3 = (2 * Math.PI * m3) / P;
  const k4 = (2 * Math.PI * m4) / P;
  const kSwell = (2 * Math.PI * cfg.swellM) / P;

  const outerPts: [number, number][] = [];
  const innerPts: [number, number][] = [];

  // Buffer offset set to 0 so the blur fade shape fills out directly to the border gap
  const borderBuffer = 0;

  for (let i = 0; i < N; i++) {
    const s = samples[i];
    const S = s.s;

    // Slower, smoother harmonic wave superposition for tranquil breathing motion
    const w1 = Math.sin(k1 * S + t * 0.9);
    const w2 = Math.sin(k2 * S - t * 1.3 + 1.2);
    const w3 = Math.cos(k3 * S + t * 1.7 + 2.5);
    const w4 = Math.sin(k4 * S - t * 2.1 + 3.7);
    const swell = 0.5 + 0.5 * Math.sin(kSwell * S + t * 0.5);

    // Variation factor: a minimal, near-even band with only a gentle ripple along the border
    const variation = Math.max(0.3, 0.6 + 0.14 * swell + 0.12 * w1 + 0.08 * w2 + 0.05 * w3 + 0.03 * w4);

    // Local energy from state.energies[i] (smooth attack on entry, graceful decay on leave)
    const energy = energies ? (energies[i] || 0) : 0;

    // Modulate depth by energy: when leaving, wave smoothly recedes to border (depth -> 0)
    const baseH = cfg.baseDepth * (0.5 + 0.5 * variation);
    const surgeH = cfg.maxSurge * variation;
    const depth = Math.min(maxSafeDepth, (baseH + surgeH) * energy);

    outerPts.push([s.bx + s.nx * borderBuffer, s.by + s.ny * borderBuffer]);
    innerPts.push([s.bx + s.nx * (borderBuffer + depth), s.by + s.ny * (borderBuffer + depth)]);
  }

  // Draw fluid body ribbon as a pure, soft atmospheric blur fade (NO solid lines, NO border contact)
  ctx.save();
  ctx.filter = `blur(${cfg.blurRadius}px)`;

  ctx.beginPath();
  // Outer perimeter loop (buffered inward)
  ctx.moveTo(outerPts[0][0], outerPts[0][1]);
  for (let i = 1; i < N; i++) {
    ctx.lineTo(outerPts[i][0], outerPts[i][1]);
  }
  ctx.closePath();

  // Inner wavy boundary loop in reverse (smooth quadratic curves)
  ctx.moveTo(innerPts[0][0], innerPts[0][1]);
  for (let i = N - 1; i >= 0; i--) {
    const curr = innerPts[i];
    const prev = innerPts[(i - 1 + N) % N];
    const midX = (curr[0] + prev[0]) / 2;
    const midY = (curr[1] + prev[1]) / 2;
    ctx.quadraticCurveTo(curr[0], curr[1], midX, midY);
  }
  ctx.closePath();

  // Radial gradient centered at border focal point (gx, gy)
  const grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, cfg.influenceRadius * 1.35);
  for (const cs of cfg.colorStops) {
    grad.addColorStop(cs.stop, cs.color);
  }
  ctx.fillStyle = grad;
  ctx.fill('evenodd');

  ctx.restore();
}

function getDistToRoundedBorder(x: number, y: number, w: number, h: number, r: number): number {
  const clampR = Math.min(r, w / 2, h / 2);
  if (clampR <= 0.5) {
    return Math.min(x, w - x, y, h - y);
  }
  if (x < clampR && y < clampR) {
    return clampR - Math.hypot(clampR - x, clampR - y);
  }
  if (x > w - clampR && y < clampR) {
    return clampR - Math.hypot(x - (w - clampR), clampR - y);
  }
  if (x < clampR && y > h - clampR) {
    return clampR - Math.hypot(clampR - x, y - (h - clampR));
  }
  if (x > w - clampR && y > h - clampR) {
    return clampR - Math.hypot(x - (w - clampR), y - (h - clampR));
  }
  return Math.min(x, w - x, y, h - y);
}

interface DotGridParams {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  rawR: number;
  gx: number;
  gy: number;
  t: number;
  maxEnergy: number;
}
// How round the glow band's inner edge is at corners, and how wide the hand-off between two edges' waves is.
const CORNER_SOFT_R = 56;
const CORNER_BLEND = 48;
function drawFluidDotGrid(params: DotGridParams): void {
  const { ctx, w, h, rawR, gx, gy, t, maxEnergy } = params;
  if (maxEnergy <= 0.015) return;

  const influenceRadius = 580;
  const influenceRadiusSq = influenceRadius * influenceRadius;
  // High-performance stippled dot matrix field with silky smooth 60fps pacing
  const stepX = 5.0;
  const stepY = 4.2;

  // Active bounding box around glow focal point (gx, gy)
  const minX = Math.max(0, Math.floor((gx - influenceRadius) / stepX) * stepX);
  const maxX = Math.min(w, Math.ceil((gx + influenceRadius) / stepX) * stepX);
  const minY = Math.max(0, Math.floor((gy - influenceRadius) / stepY) * stepY);
  const maxY = Math.min(h, Math.ceil((gy + influenceRadius) / stepY) * stepY);

  const startRow = Math.floor(minY / stepY);
  const endRow = Math.ceil(maxY / stepY);

  // Wave numbers snapped to whole harmonics of the perimeter so the pattern loops seamlessly around corners
  const perim = 2 * (w + h);
  const snapK = (k: number): number => (2 * Math.PI * Math.max(1, Math.round((k * perim) / (2 * Math.PI)))) / perim;
  const k1 = snapK(0.028); // wavelength ~224px
  const k2 = snapK(0.068); // wavelength ~92px
  const k3 = snapK(0.135); // wavelength ~46px
  const kc = snapK(0.018);

  ctx.save();
  ctx.filter = 'none';

  for (let row = startRow; row <= endRow; row++) {
    const dotY = row * stepY;
    if (dotY < 0 || dotY > h) continue;

    const rowOffset = (row % 2 === 1) ? stepX * 0.5 : 0;
    const startCol = Math.floor((minX - rowOffset) / stepX);
    const endCol = Math.ceil((maxX - rowOffset) / stepX);

    for (let col = startCol; col <= endCol; col++) {
      const dotX = col * stepX + rowOffset;
      if (dotX < 0 || dotX > w) continue;

      // Distance to glow center (fast squared distance check first)
      const dx = dotX - gx, dy = dotY - gy;
      const distSq = dx * dx + dy * dy;
      if (distSq > influenceRadiusSq) continue;
      const distToGlow = Math.sqrt(distSq);

      const glowP = Math.max(0, 1 - distToGlow / influenceRadius);
      const energy = glowP * glowP * (3 - 2 * glowP) * maxEnergy;
      if (energy <= 0.02) continue;

      // Distance to border with exact rounded-corner calculation (fills out border gap)
      const trueDist = getDistToRoundedBorder(dotX, dotY, w, h, rawR);
      if (trueDist < 0) continue;
      // Deeper in, measure against a much rounder corner so the band's inner edge sweeps around corners
      // in a soft curve instead of meeting at a sharp right angle.
      const softDist = getDistToRoundedBorder(dotX, dotY, w, h, Math.max(rawR, CORNER_SOFT_R));
      const deep = Math.min(1, trueDist / 20);
      const distToBorder = Math.max(0, trueDist + (softDist - trueDist) * deep * deep * (3 - 2 * deep));

      // Border perimeter coordinate measured along the nearer horizontal and the nearer vertical edge
      // (clockwise from top-left), so wave crests stand straight out from the border.
      const dTop = dotY, dRight = w - dotX, dBottom = h - dotY, dLeft = dotX;
      const uH = dTop <= dBottom ? dotX : w + h + (w - dotX);
      const uV = dRight <= dLeft ? w + dotY : 2 * w + h + (h - dotY);
      const crestAt = (u: number) => {
        const wave1 = Math.sin(k1 * u + t * 1.6);
        const wave2 = Math.sin(k2 * u - t * 2.2 + 1.25);
        const wave3 = Math.cos(k3 * u + t * 3.0 + 2.6);
        return Math.max(0.3, 0.55 + 0.14 * wave1 + 0.09 * wave2 + 0.06 * wave3);
      };
      // Blend the two edges' waves across the corner diagonal instead of switching at it, so there's no seam.
      const blend = Math.max(0, Math.min(1, 0.5 + (Math.min(dLeft, dRight) - Math.min(dTop, dBottom)) / CORNER_BLEND));
      const bs = blend * blend * (3 - 2 * blend);
      const crestFactor = crestAt(uV) + (crestAt(uH) - crestAt(uV)) * bs;
      const u = bs >= 0.5 ? uH : uV;

      // A minimal band: low crests that only ripple a little, matching the blur fade depth
      const maxAllowedDepth = Math.max(20, Math.min(60, Math.min(w, h) * 0.25));
      const targetReach = (16 + 30 * crestFactor) * energy;
      const maxWaveDepth = Math.min(maxAllowedDepth, targetReach);

      if (distToBorder > maxWaveDepth) continue;

      // Depth ratio: 0 at container border to 1.0 at crest peak
      const depthRatio = distToBorder / maxWaveDepth;

      // Soft feathering at crest front and near container boundary (reaches right up to border)
      const crestFeather = Math.max(0, Math.min(1, (1 - depthRatio) / 0.11));
      const borderFeather = Math.max(0, Math.min(1, distToBorder / 2.0));
      const edgeFeather = crestFeather * borderFeather;

      // Crest ridge prominence (dots are largest and brightest along the wave ridge)
      const ridgeProximity = 1 - Math.abs(depthRatio - 0.80) / 0.80;
      const ridgeIntensity = Math.max(0, Math.min(1, ridgeProximity));

      // Delicate micro-stippling dot radius (~0.30px to 1.25px)
      const baseR = 0.40 + 0.18 * energy;
      const ridgeR = 0.55 * (ridgeIntensity * ridgeIntensity);
      const dotRadius = Math.max(0.30, (baseR + ridgeR) * edgeFeather);

      // Dot alpha
      const baseAlpha = 0.38 + 0.54 * (ridgeIntensity * ridgeIntensity);
      const dotAlpha = Math.min(1, baseAlpha * edgeFeather * energy);
      if (dotAlpha <= 0.01) continue;

      // Multi-blue gradients with Google Gemini chromatic wave crest tips
      const chromaticShift = 0.5 + 0.5 * Math.sin(kc * u + t * 0.9);

      let r: number, g: number, b: number;
      if (depthRatio < 0.38) {
        // Deep Royal Sapphire into Vivid Azure
        const f = depthRatio / 0.38;
        r = Math.round(29 + f * (14 - 29));
        g = Math.round(78 + f * (165 - 78));
        b = Math.round(216 + f * (233 - 216));
      } else if (depthRatio < 0.74) {
        // Vivid Azure to Electric Cyan with subtle violet undertone
        const f = (depthRatio - 0.38) / 0.36;
        const targetR = Math.round(56 + chromaticShift * 65);
        const targetG = Math.round(189 - chromaticShift * 55);
        const targetB = Math.round(248 - chromaticShift * 12);
        r = Math.round(14 + f * (targetR - 14));
        g = Math.round(165 + f * (targetG - 165));
        b = Math.round(233 + f * (targetB - 233));
      } else {
        // Crest Ridge: Electric Cyan / Ice Blue transitioning to Google Gemini Violet, Magenta & Coral tips
        const f = (depthRatio - 0.74) / 0.26;
        const crestR = Math.round(168 + chromaticShift * 72);
        const crestG = Math.round(85 - chromaticShift * 20);
        const crestB = Math.round(247 - chromaticShift * 85);

        const mix = 0.32 + 0.68 * chromaticShift * f;
        r = Math.round(56 + (crestR - 56) * mix);
        g = Math.round(189 + (crestG - 189) * mix);
        b = Math.round(248 + (crestB - 248) * mix);
      }

      // Radiant halo glow on crest ridge dots
      if (ridgeIntensity > 0.65 && energy > 0.38) {
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${(dotAlpha * 0.18).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(dotX, dotY, dotRadius * 1.8, 0, Math.PI * 2);
        ctx.fill();
      }

      // Crisp stippled core dot
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${dotAlpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(dotX, dotY, dotRadius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
}

function renderFluidFrame(state: FluidCanvasState): void {
  const { canvas, ctx, container } = state;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (w <= 0 || h <= 0) return;

  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }

  // Slower, smoother easing for tranquil fluid tracking
  const ease = state.active ? 0.09 : 0.06;
  state.curX += (state.targetX - state.curX) * ease;
  state.curY += (state.targetY - state.curY) * ease;
  state.time += 0.009;

  // Read container border radius with frame-level caching to prevent forced reflows
  const stateAny = state as any;
  let rawR = stateAny.cachedR;
  if (rawR === undefined || canvas.width !== pw || canvas.height !== ph) {
    const compStyle = window.getComputedStyle(container);
    rawR = stateAny.cachedR = Number.parseFloat(compStyle.borderRadius) || 0;
  }

  const { P, samples } = sampleBorder(w, h, rawR, 180);
  const N = samples.length;
  if (N < 4 || P <= 0) return;

  // Initialize or resize energies Float32Array if needed
  if (state.energies?.length !== N) {
    state.energies = new Float32Array(N);
  }

  // Find border perimeter point closest to pointer for target perimeter distance
  let bestDistSq = Infinity;
  let bestS = 0;
  for (let i = 0; i < N; i++) {
    const s = samples[i];
    const d2 = (s.bx - state.curX) ** 2 + (s.by - state.curY) ** 2;
    if (d2 < bestDistSq) {
      bestDistSq = d2;
      bestS = s.s;
    }
  }
  state.targetS = bestS;

  // Smoothly glide glowS along the perimeter loop (slower, smoother travelling wave animation between sides)
  const deltaS = ((state.targetS - state.glowS + 1.5 * P) % P) - 0.5 * P;
  state.glowS = (state.glowS + deltaS * 0.08 + P) % P;

  // Interpolate exact (glowX, glowY) from glowS
  const sNorm = (state.glowS / P) * N;
  const i0 = Math.floor(sNorm) % N;
  const i1 = (i0 + 1) % N;
  const fracS = sNorm - Math.floor(sNorm);
  state.glowX = samples[i0].bx + (samples[i1].bx - samples[i0].bx) * fracS;
  state.glowY = samples[i0].by + (samples[i1].by - samples[i0].by) * fracS;

  // Update per-sample energies with asymmetric attack and decay:
  // - Active Attack: smooth, organic swell
  // - Active Decay: graceful wave dissipation when moving between sides (~500ms)
  // - Inactive Decay: fast fade-out when dropped or pointer leaves
  // Increased influence radius for wider perimeter coverage
  const influenceRadius = 580;
  let maxEnergy = 0;
  for (let i = 0; i < N; i++) {
    const s = samples[i];
    const distToCursor = Math.hypot(s.bx - state.curX, s.by - state.curY);
    const p = Math.max(0, 1 - distToCursor / influenceRadius);
    const targetEnergy = state.active ? (p * p * (3 - 2 * p)) : 0;

    if (state.active) {
      if (targetEnergy > state.energies[i]) {
        state.energies[i] += (targetEnergy - state.energies[i]) * 0.12;
      } else {
        state.energies[i] += (targetEnergy - state.energies[i]) * 0.035;
      }
    } else {
      // Slow, graceful decay upon drop / leave (~1.5s)
      state.energies[i] *= 0.955;
    }
    if (state.energies[i] > maxEnergy) {
      maxEnergy = state.energies[i];
    }
  }

  // Update dynamic blur focal coordinates so backdrop filter aligns behind gradient
  container.style.setProperty('--glow-x', `${Math.round(state.glowX)}px`);
  container.style.setProperty('--glow-y', `${Math.round(state.glowY)}px`);

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  // Clip strictly inside container so blur radiates inward without spilling outside
  ctx.beginPath();
  if (typeof (ctx as any).roundRect === 'function' && rawR > 0.5) {
    const r = Math.min(rawR, w / 2, h / 2);
    (ctx as any).roundRect(0, 0, w, h, r);
  } else {
    ctx.rect(0, 0, w, h);
  }
  ctx.clip();

  const gx = state.glowX;
  const gy = state.glowY;
  const t = state.time;

  // 1. Ambient Deep Blur Fade Layer (Wide atmospheric blue haze with increased height and length)
  drawFluidBlurFade({ ctx, samples, P, energies: state.energies, gx, gy, W: w, H: h, cfg: {
    t,
    speed: 0.65,
    baseDepth: 22,
    maxSurge: 22,
    influenceRadius: 620,
    harmonics: [2, 5, 8, 12],
    swellM: 1,
    blurRadius: 48,
    colorStops: [
      { stop: 0, color: 'rgba(56, 189, 248, 0.38)' },
      { stop: 0.20, color: 'rgba(14, 165, 233, 0.30)' },
      { stop: 0.45, color: 'rgba(37, 99, 235, 0.20)' },
      { stop: 0.70, color: 'rgba(29, 78, 216, 0.10)' },
      { stop: 0.88, color: 'rgba(30, 58, 138, 0.04)' },
      { stop: 1, color: 'rgba(15, 23, 42, 0)' }
    ]
  } });

  // 2. Dynamic Fluid Wave Blur Fade Layer (Oceanic Azure & Cobalt undulating wave with increased height and length)
  drawFluidBlurFade({ ctx, samples, P, energies: state.energies, gx, gy, W: w, H: h, cfg: {
    t,
    speed: 0.9,
    baseDepth: 16,
    maxSurge: 16,
    influenceRadius: 540,
    harmonics: [3, 6, 11, 16],
    swellM: 2,
    blurRadius: 28,
    colorStops: [
      { stop: 0, color: 'rgba(56, 189, 248, 0.48)' },
      { stop: 0.22, color: 'rgba(14, 165, 233, 0.35)' },
      { stop: 0.50, color: 'rgba(37, 99, 235, 0.20)' },
      { stop: 0.78, color: 'rgba(29, 78, 216, 0.08)' },
      { stop: 1, color: 'rgba(30, 27, 75, 0)' }
    ]
  } });

  // The haze runs right up to the panel's edge, where the dots thin out, so the last few pixels read as a hard cyan
  // line along the border. Erase a soft band there so the glow fades out before the edge.
  // A blurred stroke fades the band in; a hard one clears the outermost pixels the blur can't fully reach.
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.strokeStyle = '#000';
  ctx.beginPath();
  if (typeof (ctx as any).roundRect === 'function' && rawR > 0.5) (ctx as any).roundRect(0, 0, w, h, Math.min(rawR, w / 2, h / 2));
  else ctx.rect(0, 0, w, h);
  ctx.filter = 'blur(3px)';
  ctx.lineWidth = 10;
  ctx.stroke();
  ctx.filter = 'none';
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.restore();

  // 3. Stippled Wave Dot Grid (Gemini-style undulating micro-dot matrix with chromatic crests and increased density)
  drawFluidDotGrid({ ctx, w, h, rawR, gx, gy, t, maxEnergy });

  ctx.restore();
}

function getFluidState(container: HTMLElement): FluidCanvasState | null {
  let state = fluidCanvases.get(container);
  if (state) return state;
  const canvas = container.querySelector<HTMLCanvasElement>('.agent-fluid-canvas');
  if (!canvas) return null;
  if (!container.querySelector('.agent-fluid-blur')) {
    const blurEl = document.createElement('div');
    blurEl.className = 'agent-fluid-blur';
    blurEl.setAttribute('aria-hidden', 'true');
    container.insertBefore(blurEl, canvas);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const rect = container.getBoundingClientRect();
  const initX = rect.width / 2;
  const initY = 0;
  state = {
    canvas,
    ctx,
    container,
    curX: initX,
    curY: initY,
    targetX: initX,
    targetY: initY,
    glowS: 0,
    targetS: 0,
    glowX: initX,
    glowY: initY,
    energies: new Float32Array(180),
    active: false,
    fadeStartTime: null,
    animId: null,
    time: 0,
  };
  fluidCanvases.set(container, state);
  return state;
}

function updateAgentDragPointer(container: HTMLElement, clientX: number, clientY: number): void {
  const state = getFluidState(container);
  if (!state) return;
  const rect = container.getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
  const y = Math.max(0, Math.min(rect.height, clientY - rect.top));

  state.targetX = x;
  state.targetY = y;
  state.fadeStartTime = null;

  if (!state.active) {
    state.active = true;
    state.curX = x;
    state.curY = y;
    startFluidCanvasLoop(state);
  }
}

function setFluidContainer(container: HTMLElement | null, clientX: number, clientY: number): void {
  const containers = [$('#sidebar'), $('#editorPane'), $('#agents'), $('#box')].filter((x): x is HTMLElement => !!x);
  for (const c of containers) {
    if (c === container) {
      c.classList.add('agent-drop-over', 'drop-over-active');
      updateAgentDragPointer(c, clientX, clientY);
    } else {
      c.classList.remove('agent-drop-over', 'drop-over-active');
      const state = fluidCanvases.get(c);
      if (state?.active) {
        state.active = false;
        state.fadeStartTime = performance.now();
      }
    }
  }
}

function stopAgentDragPointer(immediate = false): void {
  const now = performance.now();
  for (const state of fluidCanvases.values()) {
    state.active = false;
    state.fadeStartTime = now;
    if (immediate && state.energies) {
      for (let i = 0; i < state.energies.length; i++) {
        state.energies[i] *= 0.85;
      }
    }
  }
  $('#agents')?.classList.remove('agent-drop-over', 'drop-over-active');
  $('#box')?.classList.remove('agent-drop-over', 'drop-over-active');
  $('#sidebar')?.classList.remove('agent-drop-over', 'drop-over-active');
  $('#editorPane')?.classList.remove('agent-drop-over', 'drop-over-active');
}

function startFluidCanvasLoop(state: FluidCanvasState): void {
  if (state.animId != null) return;
  function loop(): void {
    if (!state.active) {
      let maxEnergy = 0;
      if (state.energies) {
        for (const energy of state.energies) {
          if (energy > maxEnergy) maxEnergy = energy;
        }
      }
      const elapsed = performance.now() - (state.fadeStartTime ?? 0);
      if (elapsed > 1800 || maxEnergy < 0.005) {
        state.ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
        if (state.energies) state.energies.fill(0);
        state.animId = null;
        return;
      }
    }
    renderFluidFrame(state);
    state.animId = requestAnimationFrame(loop);
  }
  state.animId = requestAnimationFrame(loop);
}

function markAgentDrop(el: HTMLElement | null): void {
  if (agentDropMark === el) return;
  agentDropMark?.classList.remove('agent-drop-over', 'drag-over');
  agentDropMark = el;
  if (el) {
    if (el.classList.contains('composer-box')) el.classList.add('drag-over');
    else el.classList.add('agent-drop-over');
  }
}
function clearAgentDropMarks(): void {
  if (agentDropMark) {
    agentDropMark.classList.remove('agent-drop-over', 'drag-over');
    agentDropMark = null;
  }
  $('#agents')?.classList.remove('agent-drop-over', 'drop-over-active');
  $('#box')?.classList.remove('agent-drop-over', 'drop-over-active');
  $('#sidebar')?.classList.remove('agent-drop-over', 'drop-over-active');
  $('#editorPane')?.classList.remove('agent-drop-over', 'drop-over-active');
  for (const b of $$<HTMLElement>('.composer-box')) b.classList.remove('drag-over');
  for (const t of $$<HTMLElement>('.agent-tab')) t.classList.remove('agent-drop-over');
  for (const t of $$<HTMLElement>('.agent-tab-new')) t.classList.remove('agent-drop-over');
  stopAgentDragPointer(true);
}
interface AgentDropTargetInfo {
  el: HTMLElement;
  surface: Surface;
  tab?: AgentTabState;
  isNewTab?: boolean;
}
function agentDropTarget(e: DragEvent): AgentDropTargetInfo | null {
  const t = e.target as HTMLElement | null;
  if (!t) return null;
  if (t.closest('#tglAgents')) {
    if (!layout.agentsOpen) {
      layout.agentsOpen = true;
      applyLayout();
    }
    return { el: $('#agents'), surface: SURFACES.ide };
  }
  const inBox = t.closest('#box');
  const inAgents = t.closest('#agents');
  if (!inBox && !inAgents) return null;
  const s = inBox ? SURFACES.box : SURFACES.ide;
  const tabEl = t.closest<HTMLElement>('.agent-tab');
  if (tabEl?.dataset.agentTab) {
    const tab = surfaceTabs[s.name]?.find(x => x.id === tabEl.dataset.agentTab);
    if (tab) return { el: tabEl, surface: s, tab };
  }
  const newTabBtn = t.closest<HTMLElement>('#agentNewTab, #boxNewTab');
  if (newTabBtn) {
    return { el: newTabBtn, surface: s, isNewTab: true };
  }
  const composerBox = t.closest<HTMLElement>('.composer-box');
  if (composerBox) {
    return { el: composerBox, surface: s, tab: getActiveTab(s) };
  }
  return { el: inBox ? $('#box') : $('#agents'), surface: s, tab: getActiveTab(s) };
}
function toRelProject(absPath: string): string | null {
  if (!rootInfo || !absPath) return null;
  const normRoot = rootInfo.root.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
  const normAbs = absPath.replaceAll('\\', '/').toLowerCase();
  if (normAbs === normRoot) return '';
  if (normAbs.startsWith(normRoot + '/')) {
    return absPath.slice(rootInfo.root.length).replace(/^[\\/]/, '').replaceAll('\\', '/');
  }
  return null;
}
function getDroppedFilePath(file: File): string {
  try {
    if (api.sys.getPathForFile) return api.sys.getPathForFile(file) || '';
  } catch {}
  return (file as any).path || '';
}
function dropTarget(e: DragEvent): { el: HTMLElement; dir: string } | null {
  if (!rootInfo) return null;
  const t = e.target as HTMLElement;
  if (t.closest('#editorPane')) return { el: $('#editorPane'), dir: targetDir() };
  const row = t.closest<HTMLElement>('#tree [data-path]');
  if (row) { const p = row.dataset.path as string; return { el: row, dir: row.dataset.dir ? p : dirName(p) }; }
  return t.closest('#tree') ? { el: $('#tree'), dir: '' } : null;
}
type TreeDropPos = 'before' | 'after' | 'into';
interface TreeDropTargetInfo {
  el: HTMLElement;
  path: string;
  isDir: boolean;
  pos: TreeDropPos;
  parentDir: string;
}

let currentTreeDropMark: { el: HTMLElement; pos: TreeDropPos } | null = null;

function markTreeDrop(el: HTMLElement | null, pos?: TreeDropPos): void {
  if (currentTreeDropMark && (currentTreeDropMark.el !== el || currentTreeDropMark.pos !== pos)) {
    currentTreeDropMark.el.classList.remove('drop-line-above', 'drop-line-below', 'drop-into');
    currentTreeDropMark = null;
  }
  if (!el || !pos) return;
  if (pos === 'before') el.classList.add('drop-line-above');
  else if (pos === 'after') el.classList.add('drop-line-below');
  else if (pos === 'into') el.classList.add('drop-into');
  currentTreeDropMark = { el, pos };
}

function clearTreeDropMarks(): void {
  if (currentTreeDropMark) {
    currentTreeDropMark.el.classList.remove('drop-line-above', 'drop-line-below', 'drop-into');
    currentTreeDropMark = null;
  }
  for (const el of $$<HTMLElement>('#tree .drop-line-above, #tree .drop-line-below, #tree .drop-into')) {
    el.classList.remove('drop-line-above', 'drop-line-below', 'drop-into');
  }
}

function treeDropTarget(e: DragEvent): TreeDropTargetInfo | null {
  if (!rootInfo) return null;
  const target = e.target as HTMLElement | null;
  if (!target) return null;
  const tree = target.closest<HTMLElement>('#tree');
  if (!tree) return null;

  const row = target.closest<HTMLElement>('#tree .tree-item[data-path]');
  const from = draggedTreePath;

  if (row?.dataset.path) {
    const path = row.dataset.path;
    const isDir = !!row.dataset.dir;
    const parentDir = dirName(path);

    // Cannot drop on oneself
    if (from && path === from) return null;
    // Cannot drop a directory into itself or into one of its children
    if (from && draggedTreeIsDir && (path === from || path.startsWith(from + '/'))) return null;

    const rect = row.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const h = rect.height || 24;
    const ratio = Math.max(0, Math.min(1, y / h));

    let pos: TreeDropPos;
    if (isDir) {
      if (ratio < 0.28) pos = 'before';
      else if (ratio > 0.72) pos = 'after';
      else pos = 'into';
    } else {
      pos = ratio < 0.5 ? 'before' : 'after';
    }

    return { el: row, path, isDir, pos, parentDir };
  }

  // Hovering on empty area of #tree
  const items = $$<HTMLElement>('#tree .tree-item[data-path]');
  if (items.length > 0) {
    const last = items.at(-1);
    if (last?.dataset.path && last.dataset.path !== from) {
      return {
        el: last,
        path: last.dataset.path,
        isDir: !!last.dataset.dir,
        pos: 'after',
        parentDir: dirName(last.dataset.path),
      };
    }
  }

  return { el: tree, path: '', isDir: true, pos: 'into', parentDir: '' };
}

const treeOrderKey = () => `breeze.treeOrder:${rootInfo?.root ?? ''}`;
let treeOrder: Record<string, string[]> = {};

function loadTreeOrder(): void {
  if (!rootInfo) { treeOrder = {}; return; }
  treeOrder = store.get<Record<string, string[]>>(treeOrderKey(), {});
}

function saveTreeOrder(rel: string, names: string[]): void {
  if (!rootInfo) return;
  treeOrder[rel] = names;
  store.set(treeOrderKey(), treeOrder);
}

function sortDirEntries(rel: string, entries: DirEntry[]): DirEntry[] {
  const custom = treeOrder[rel];
  if (!custom?.length) return entries;
  const map = new Map<string, number>();
  custom.forEach((n, i) => map.set(n, i));
  return [...entries].sort((a, b) => {
    const hasA = map.has(a.name);
    const hasB = map.has(b.name);
    if (hasA && hasB) return map.get(a.name)! - map.get(b.name)!;
    if (hasA && !hasB) return -1;
    if (!hasA && hasB) return 1;
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

interface LayoutAction {
  type: 'layout';
  prev: Layout;
  next: Layout;
}

interface TreeOrderAction {
  type: 'tree-order';
  dir: string;
  prevOrder: string[];
  newOrder: string[];
  name: string;
}

interface TreeMoveAction {
  type: 'tree-move';
  from: string;
  to: string;
  fromDir: string;
  targetDir: string;
  prevFromOrder?: string[];
  prevTargetOrder?: string[];
  name: string;
}

interface TreeImportAction {
  type: 'tree-import';
  dir: string;
  topPaths: string[];
  savedPaths: string[];
  names: string[];
  cachedFiles?: { rel: string; data: Uint8Array }[];
}

interface RemoveAttachmentAction {
  type: 'remove-attachment';
  surface: 'ide' | 'box';
  tabId: string;
  attachment: AgentAttachment;
  index: number;
}

type AppUndoAction = LayoutAction | TreeOrderAction | TreeMoveAction | TreeImportAction | RemoveAttachmentAction;

const actionUndoStack: AppUndoAction[] = [];
const actionRedoStack: AppUndoAction[] = [];
const APP_UNDO_MAX = 50;
let lastUserTypeAt = 0;

function pushAppAction(action: AppUndoAction): void {
  (action as any).timestamp = Date.now();
  actionUndoStack.push(action);
  if (actionUndoStack.length > APP_UNDO_MAX) actionUndoStack.shift();
  actionRedoStack.length = 0;
}

function flashUndoItem(path: string): void {
  const row = $(`#tree .tree-item[data-path="${escAttr(path)}"]`);
  if (!row) return;
  row.classList.remove('undo-target');
  const _reflow = row.offsetWidth;
  row.classList.add('undo-target');
  setTimeout(() => row.classList.remove('undo-target'), 800);
}

let layoutAnimTimer: TimeoutId | undefined;
function applyLayoutAnimated(): void {
  clearTimeout(layoutAnimTimer);
  document.body.classList.add('layout-animating');
  applyLayout();
  layoutAnimTimer = setTimeout(() => {
    document.body.classList.remove('layout-animating');
  }, 350);
}

async function undoAppAction(): Promise<boolean> {
  const action = actionUndoStack.pop();
  if (!action) return false;
  actionRedoStack.push(action);

  if (action.type === 'tree-order') {
    if (action.dir) expanded.add(action.dir);
    treeOrder[action.dir] = [...action.prevOrder];
    saveTreeOrder(action.dir, action.prevOrder);
    if (dirCache.has(action.dir)) {
      const list = dirCache.get(action.dir)!;
      dirCache.set(action.dir, sortDirEntries(action.dir, list));
    }
    renderTreeAnimated();
    flashUndoItem(joinPath(action.dir, action.name));
    toast(`Undid rearrange · ${action.name}`);
    return true;
  }

  if (action.type === 'tree-move') {
    if (action.prevFromOrder) {
      treeOrder[action.fromDir] = [...action.prevFromOrder];
      saveTreeOrder(action.fromDir, action.prevFromOrder);
    }
    if (action.prevTargetOrder) {
      treeOrder[action.targetDir] = [...action.prevTargetOrder];
      saveTreeOrder(action.targetDir, action.prevTargetOrder);
    }
    if (action.fromDir) expanded.add(action.fromDir);
    await moveEntry(action.from, action.to);
    flashUndoItem(action.to);
    toast(`Undid move · ${action.name}`);
    return true;
  }

  if (action.type === 'tree-import') {
    for (const p of action.topPaths) {
      try {
        await api.fs.trash(p);
      } catch (err) {
        console.warn('Failed to trash imported file/dir:', p, err);
      }
      const d = dirName(p);
      if (treeOrder[d]) {
        treeOrder[d] = treeOrder[d].filter(n => n !== baseName(p));
        saveTreeOrder(d, treeOrder[d]);
      }
      for (const tabPath of openTabs.filter(x => x === p || x.startsWith(p + '/'))) {
        dropTab(tabPath);
      }
      expanded.delete(p);
    }
    dirCache.clear();
    await refreshTree();
    renderTabs();
    renderEditor();
    saveSession();
    toast(`Undid import · ${action.names.join(', ')}`);
    return true;
  }

  if (action.type === 'layout') {
    Object.assign(layout, action.prev);
    applyLayoutAnimated();
    toast('Undid layout');
    return true;
  }

  if (action.type === 'remove-attachment') {
    const list = attachmentsMap[action.surface] || [];
    list.splice(action.index, 0, action.attachment);
    attachmentsMap[action.surface] = list;
    const tab = surfaceTabs[action.surface]?.find(x => x.id === action.tabId) || getActiveTab(SURFACES[action.surface]);
    if (tab) tab.attachments = [...list];
    renderAttachments(SURFACES[action.surface]);
    toast(`Restored attachment · ${action.attachment.name}`);
    return true;
  }

  return false;
}

async function redoAppAction(): Promise<boolean> {
  const action = actionRedoStack.pop();
  if (!action) return false;
  actionUndoStack.push(action);

  if (action.type === 'tree-order') {
    if (action.dir) expanded.add(action.dir);
    treeOrder[action.dir] = [...action.newOrder];
    saveTreeOrder(action.dir, action.newOrder);
    if (dirCache.has(action.dir)) {
      const list = dirCache.get(action.dir)!;
      dirCache.set(action.dir, sortDirEntries(action.dir, list));
    }
    renderTreeAnimated();
    flashUndoItem(joinPath(action.dir, action.name));
    toast(`Redid rearrange · ${action.name}`);
    return true;
  }

  if (action.type === 'tree-move') {
    await moveEntry(action.to, action.from);
    await refreshTree();
    flashUndoItem(action.from);
    toast(`Redid move · ${action.name}`);
    return true;
  }

  if (action.type === 'tree-import') {
    if (action.cachedFiles && action.cachedFiles.length > 0) {
      for (const item of action.cachedFiles) {
        await api.fs.importFile(action.dir, item.rel, item.data);
      }
      for (let d = action.dir; d; d = dirName(d)) expanded.add(d);
      dirCache.clear();
      await refreshTree();
      renderTabs();
      renderEditor();
      saveSession();
      toast(`Redid import · ${action.names.join(', ')}`);
      return true;
    }
    toast(`Cannot redo file import after items were moved to ${binName()}`);
    return false;
  }

  if (action.type === 'layout') {
    Object.assign(layout, action.next);
    applyLayoutAnimated();
    toast('Redid layout');
    return true;
  }

  if (action.type === 'remove-attachment') {
    attachmentsMap[action.surface] = (attachmentsMap[action.surface] || []).filter(x => x.id !== action.attachment.id);
    const tab = surfaceTabs[action.surface]?.find(x => x.id === action.tabId) || getActiveTab(SURFACES[action.surface]);
    if (tab) tab.attachments = [...attachmentsMap[action.surface]];
    renderAttachments(SURFACES[action.surface]);
    toast(`Removed · ${action.attachment.name}`);
    return true;
  }

  return false;
}

async function rearrangeTreeItem(fromPath: string, targetPath: string, pos: TreeDropPos): Promise<void> {
  if (!fromPath || !rootInfo) return;
  if (fromPath === targetPath && pos !== 'into') return;

  const fromDir = dirName(fromPath);
  const fromName = baseName(fromPath);

  if (pos === 'into') {
    const destDir = targetPath;
    if (fromPath === destDir || destDir.startsWith(fromPath + '/')) return;
    const destPath = destDir ? joinPath(destDir, fromName) : fromName;
    if (destPath === fromPath) {
      const entries = dirCache.get(fromDir);
      if (entries) {
        const fromEntry = entries.find(e => e.name === fromName);
        if (fromEntry) {
          const prevOrder = entries.map(e => e.name);
          const remaining = entries.filter(e => e.name !== fromName);
          remaining.push(fromEntry);
          const newOrder = remaining.map(e => e.name);
          pushAppAction({
            type: 'tree-order',
            dir: fromDir,
            prevOrder,
            newOrder,
            name: fromName,
          });
          dirCache.set(fromDir, remaining);
          saveTreeOrder(fromDir, newOrder);
          renderTreeAnimated();
          toast(`Moved to end · ${fromName}`);
        }
      }
      return;
    }

    const prevFromOrder = (dirCache.get(fromDir) || []).map(e => e.name);
    const prevDestOrder = (dirCache.get(destDir) || []).map(e => e.name);

    if (destDir) expanded.add(destDir);
    const destOrder = treeOrder[destDir] ? [...treeOrder[destDir]] : (dirCache.get(destDir) || []).map(e => e.name);
    if (!destOrder.includes(fromName)) destOrder.push(fromName);
    saveTreeOrder(destDir, destOrder);
    if (treeOrder[fromDir]) {
      saveTreeOrder(fromDir, treeOrder[fromDir].filter(n => n !== fromName));
    }

    pushAppAction({
      type: 'tree-move',
      from: destPath,
      to: fromPath,
      fromDir,
      targetDir: destDir,
      prevFromOrder,
      prevTargetOrder: prevDestOrder,
      name: fromName,
    });

    await moveEntry(fromPath, destPath);
    toast(`Moved ${fromName} into ${destDir ? baseName(destDir) : 'project root'}`);
    return;
  }

  // Dropping before or after targetPath
  const targetDir = dirName(targetPath);
  const targetName = baseName(targetPath);

  if (fromDir === targetDir) {
    // Same directory reordering
    const entries = dirCache.get(fromDir);
    if (!entries) return;
    const fromEntry = entries.find(e => e.name === fromName);
    if (!fromEntry) return;

    const prevOrder = entries.map(e => e.name);
    const remaining = entries.filter(e => e.name !== fromName);
    const targetIdx = remaining.findIndex(e => e.name === targetName);
    if (targetIdx === -1) return;

    const insertIdx = pos === 'before' ? targetIdx : targetIdx + 1;
    remaining.splice(insertIdx, 0, fromEntry);
    const newOrder = remaining.map(e => e.name);

    pushAppAction({
      type: 'tree-order',
      dir: fromDir,
      prevOrder,
      newOrder,
      name: fromName,
    });

    dirCache.set(fromDir, remaining);
    saveTreeOrder(fromDir, newOrder);
    renderTreeAnimated();
    toast(`Reordered · ${fromName}`);
    return;
  }

  // Moving across directories to a specific position
  const destPath = joinPath(targetDir, fromName);
  if (fromPath === destPath) return;
  if (fromPath === targetDir || targetDir.startsWith(fromPath + '/')) return;

  const prevFromOrder = (dirCache.get(fromDir) || []).map(e => e.name);
  const prevTargetOrder = (dirCache.get(targetDir) || []).map(e => e.name);

  if (targetDir) expanded.add(targetDir);
  const currentTargetOrder = treeOrder[targetDir] ? [...treeOrder[targetDir]] : (dirCache.get(targetDir) || []).map(e => e.name);
  const filtered = currentTargetOrder.filter(n => n !== fromName);
  const tIdx = filtered.indexOf(targetName);
  let insIdx = filtered.length;
  if (tIdx !== -1) {
    insIdx = pos === 'before' ? tIdx : tIdx + 1;
  }
  filtered.splice(insIdx, 0, fromName);
  saveTreeOrder(targetDir, filtered);
  if (treeOrder[fromDir]) {
    saveTreeOrder(fromDir, treeOrder[fromDir].filter(n => n !== fromName));
  }

  pushAppAction({
    type: 'tree-move',
    from: destPath,
    to: fromPath,
    fromDir,
    targetDir,
    prevFromOrder,
    prevTargetOrder,
    name: fromName,
  });

  await moveEntry(fromPath, destPath);
  toast(`Moved ${fromName} to ${targetDir ? baseName(targetDir) : 'project root'}`);
}

// A row drops into that folder (or a file's folder), empty explorer space into the project root.
// A folder can't go into itself or anything inside it, and dropping where it already is does nothing.
function moveTarget(e: DragEvent): { el: HTMLElement; dir: string } | null {
  const from = draggedTreePath;
  if (!from) return null;
  const t = e.target as HTMLElement;
  const row = t.closest<HTMLElement>('#tree [data-path]');
  let el: HTMLElement, dir: string;
  if (row) {
    const p = row.dataset.path as string;
    dir = row.dataset.dir ? p : dirName(p);
    el = dir ? $(`#tree .tree-item[data-path="${escAttr(dir)}"]`) ?? row : $('#tree');
  } else if (t.closest('#tree')) { el = $('#tree'); dir = ''; }
  else return null;
  if (dir === dirName(from) || dir === from || dir.startsWith(from + '/')) return null;
  return { el, dir };
}
const entryFile = (e: FileSystemFileEntry) => new Promise<File>((res, rej) => e.file(res, rej));
async function entryChildren(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader(), all: FileSystemEntry[] = [];
  for (; ;) { // readEntries returns at most ~100 at a time
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) return all;
    all.push(...batch);
  }
}
async function collectDropped(entry: FileSystemEntry, prefix: string, out: Dropped[], skipped: string[]): Promise<void> {
  if (DROP_SKIP.has(entry.name)) { skipped.push(entry.name); return; }
  if (out.length >= DROP_MAX_FILES) return;
  if (entry.isFile) { out.push({ rel: prefix + entry.name, file: await entryFile(entry as FileSystemFileEntry) }); return; }
  for (const child of await entryChildren(entry as FileSystemDirectoryEntry)) await collectDropped(child, `${prefix}${entry.name}/`, out, skipped);
}
async function importDropped(entries: FileSystemEntry[], dir: string, openFirst = false): Promise<void> {
  const found: Dropped[] = [], skipped: string[] = [], saved: string[] = [], failed: string[] = [];
  for (const entry of entries) await collectDropped(entry, '', found, skipped);
  const files = found.filter(d => d.file.size <= DROP_MAX_BYTES);
  const cachedFiles: { rel: string; data: Uint8Array }[] = [];
  let totalBytes = 0;
  for (const d of files) {
    try {
      const buf = new Uint8Array(await d.file.arrayBuffer());
      saved.push(await api.fs.importFile(dir, d.rel, buf));
      totalBytes += buf.length;
      if (totalBytes <= 20 * 1024 * 1024) {
        cachedFiles.push({ rel: d.rel, data: buf });
      }
    }
    catch (err) { failed.push(errMsg(err)); }
  }
  for (let d = dir; d; d = dirName(d)) expanded.add(d);
  dirCache.clear();
  await refreshTree(); saveSession();

  if (saved.length > 0) {
    const topPaths = entries.map(e => joinPath(dir, e.name));
    pushAppAction({
      type: 'tree-import',
      dir,
      topPaths,
      savedPaths: [...saved],
      names: entries.map(e => e.name),
      cachedFiles: totalBytes <= 20 * 1024 * 1024 ? cachedFiles : undefined,
    });
  }

  if (saved.length >= 1 && (openFirst || (entries.length === 1 && entries[0].isFile))) {
    openFile(saved[0]);
  }

  const notes = [
    skipped.length ? `skipped ${[...new Set(skipped)].join(', ')}` : '',
    found.length > files.length ? `${plural(found.length - files.length, 'file')} over 50 MB left out` : '',
    found.length >= DROP_MAX_FILES ? `stopped at ${DROP_MAX_FILES} files` : '',
    failed.length ? `${failed.length} failed: ${failed[0]}` : '',
  ].filter(Boolean);
  const noteText = notes.length ? ' · ' + notes.join(' · ') : '';
  toast(`Added ${plural(saved.length, 'file')}${noteText}`);
}
document.addEventListener('dragover', e => {
  if (!hasFiles(e) && !draggedTreePath) return;

  const target = e.target as HTMLElement | null;

  const ag = agentDropTarget(e);
  if (ag) {
    e.preventDefault();
    markDrop(null);
    clearTreeDropMarks();
    markAgentDrop(ag.el);
    const container = ag.surface.name === 'box' ? $('#box') : $('#agents');
    setFluidContainer(container, e.clientX, e.clientY);
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    return;
  }
  if (agentDropMark) {
    agentDropMark.classList.remove('agent-drop-over', 'drag-over');
    agentDropMark = null;
  }

  if (draggedTreePath) {
    if (target?.closest('#editorPane')) {
      e.preventDefault();
      markDrop(null);
      clearTreeDropMarks();
      setFluidContainer($('#editorPane'), e.clientX, e.clientY);
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'link';
      return;
    }

    const treeTarget = treeDropTarget(e);
    if (treeTarget) {
      e.preventDefault();
      markDrop(null);
      markTreeDrop(treeTarget.el, treeTarget.pos);
      setFluidContainer($('#sidebar'), e.clientX, e.clientY);
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      return;
    }

    const mt = moveTarget(e);
    if (mt) {
      e.preventDefault();
      clearTreeDropMarks();
      markDrop(mt.el !== $('#tree') ? mt.el : null);
      setFluidContainer($('#sidebar'), e.clientX, e.clientY);
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      return;
    }

    if (target?.closest('#sidebar')) {
      e.preventDefault();
      clearTreeDropMarks();
      markDrop(null);
      setFluidContainer($('#sidebar'), e.clientX, e.clientY);
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
      return;
    }

    clearTreeDropMarks();
    markDrop(null);
    setFluidContainer(null, 0, 0);
    return;
  }

  clearTreeDropMarks();
  const dt = dropTarget(e);
  if (target?.closest('#editorPane')) {
    e.preventDefault();
    markDrop(null);
    setFluidContainer($('#editorPane'), e.clientX, e.clientY);
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    return;
  }
  if (target?.closest('#sidebar')) {
    e.preventDefault();
    markDrop(dt?.el !== $('#tree') ? (dt?.el ?? null) : null);
    setFluidContainer($('#sidebar'), e.clientX, e.clientY);
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    return;
  }

  markDrop(dt?.el ?? null);
  setFluidContainer(null, 0, 0);
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = dt ? 'copy' : 'none';
  }
});
document.addEventListener('dragleave', e => {
  if (!e.relatedTarget) {
    markDrop(null);
    clearTreeDropMarks();
    clearAgentDropMarks();
  }
});
document.addEventListener('drop', e => {
  if (!hasFiles(e) && !draggedTreePath) return;

  const target = e.target as HTMLElement | null;

  const ag = agentDropTarget(e);
  if (ag) {
    e.preventDefault();
    clearAgentDropMarks();
    clearTreeDropMarks();
    markDrop(null);
    background(handleAgentDrop(e, ag));
    return;
  }

  if (draggedTreePath) {
    const from = draggedTreePath;
    const isDir = draggedTreeIsDir;
    draggedTreePath = null;
    draggedTreeIsDir = false;
    clearAgentDropMarks();
    clearTreeDropMarks();
    markDrop(null);

    if (target?.closest('#editorPane')) {
      e.preventDefault();
      if (!isDir) openFile(from);
      return;
    }

    const treeTarget = treeDropTarget(e);
    if (treeTarget) {
      e.preventDefault();
      background(rearrangeTreeItem(from, treeTarget.path, treeTarget.pos));
      return;
    }

    const mt = moveTarget(e);
    if (mt) {
      e.preventDefault();
      const destDir = mt.dir;
      const fromName = baseName(from);
      const destPath = joinPath(destDir, fromName);
      if (from !== destPath && from !== destDir && !destDir.startsWith(from + '/')) {
        if (destDir) expanded.add(destDir);
        const fromDir = dirName(from);
        const prevFromOrder = (dirCache.get(fromDir) || []).map(entry => entry.name);
        const prevDestOrder = (dirCache.get(destDir) || []).map(entry => entry.name);

        pushAppAction({
          type: 'tree-move',
          from: destPath,
          to: from,
          fromDir,
          targetDir: destDir,
          prevFromOrder,
          prevTargetOrder: prevDestOrder,
          name: fromName,
        });

        background(moveEntry(from, destPath));
        toast(`Moved ${fromName} into ${destDir ? baseName(destDir) : 'project root'}`);
      }
      return;
    }
    return;
  }

  e.preventDefault();
  clearAgentDropMarks();
  clearTreeDropMarks();
  markDrop(null);

  const entries = [...(e.dataTransfer?.items ?? [])].map(i => i.webkitGetAsEntry()).filter((x): x is FileSystemEntry => !!x);
  if (!entries.length) return;

  const inEditor = !!target?.closest('#editorPane');
  const dt = dropTarget(e);
  const destDir = inEditor ? targetDir() : (dt?.dir ?? '');
  background(importDropped(entries, destDir, inEditor));
});

