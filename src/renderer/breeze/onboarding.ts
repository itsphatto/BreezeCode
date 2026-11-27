/* ================= App state (survives reloads) ================= */
type WorkMode = 'ide' | 'box';
interface AppState {
  onboarded: boolean; step: number; name: string | null; termsAcceptedAt: number | null;
  user: User | null; agent: string | null; detect: Detection | null;
  vibeArmed: boolean; vibeSites: string[]; vibeSite: string | null; mode: WorkMode;
  discord: boolean; discordDetails: boolean; devMode: boolean;
  // Super Error Alert (Settings → Miscellaneous): a run that fails flashes the window's corners red and sounds a siren.
  superErrorAlert: boolean;
}
const savedApp = store.get<Partial<AppState>>('breeze.app', {});
const appState: AppState = {
  onboarded: false, step: 0, name: null, termsAcceptedAt: null, user: null, agent: null, detect: null, vibeArmed: false, vibeSites: [], vibeSite: null, mode: 'ide',
  discord: false, discordDetails: true, devMode: false, superErrorAlert: false,
  ...savedApp,
};
// The separate Breeze Agent workspace is now part of Breeze Space: a save from that build comes back to Space.
if ((appState.mode as string) === 'agent') appState.mode = 'box';
// A save from before the name screen has no `name` (every save since does) and counts the later steps one lower.
if (savedApp.name === undefined && savedApp.step) appState.step++;
const saveApp = () => store.set('breeze.app', appState);
// The blue app icon, or in developer mode the flipped one (white tile, blue wind).
const appIcon = () => `../../assets/brand/${appState.devMode ? 'IconDev' : 'Icon'}.png`;

/* ================= Onboarding: welcome → name → account → tools → home ================= */
// Home is also where every later launch lands (see init.ts).
const STEP = { welcome: 0, name: 1, signIn: 2, tools: 3, home: 4 };
let step = Math.min(appState.step, STEP.home);
let user: User | null = appState.user;
// Who to greet: the name they gave us wins over the one their account came with.
const displayName = () => appState.name || user?.name || null;
const nameInput = $<HTMLInputElement>('#obName'), nameNext = $<HTMLButtonElement>('#obNameNext');
const termsBox = $<HTMLInputElement>('#obTerms'), accountNext = $<HTMLButtonElement>('#obAccountNext');
$$<HTMLImageElement>('.ob-icon').forEach(i => { i.src = appIcon(); });
function goStep(n: number): void {
  // Hidden sections can't be measured, so the logo's old spot is read before they swap (mid-flight: where it is on screen).
  const prev = step, oldLogo = stepLogo(prev);
  const from = oldLogo?.getClientRects().length ? oldLogo.getBoundingClientRect() : null;
  const fromSurface = surfaceBox(prev);
  $$('.ob-prewarm').forEach(s => { s.classList.remove('ob-prewarm'); s.inert = false; });
  // Clicked on mid-flight: pieces still waiting under their ghosts are shown first, or their copies would be invisible.
  obBtnGhosts.forEach(g => g.remove());
  obBtnGhosts = [];
  const held = $$('.ob-held');
  instantly(held, () => held.forEach(e => e.classList.remove('ob-held')));
  const moving = prev !== n && !appState.onboarded && !motionOff() && !reducedMotion();
  const fromEls = moving ? stepButtons(prev) : [];
  const fromButtons = fromEls.map(b => shootButton(b));
  const oldHeading = moving && n < prev ? stepHeading(prev) : null;
  const fromHeading = oldHeading?.getClientRects().length ? [shootText(oldHeading)] : [];
  stopObMotion();
  // The old step leaves on screen: pinned where it is and faded out under the new one (playStep), not cut away.
  const leaving = moving && !stepEl(prev).classList.contains('hidden') ? stepEl(prev) : null;
  if (leaving) pinLeaving(leaving);
  step = n; appState.step = n; saveApp();
  $$('.ob-step').forEach(s => s.classList.toggle('hidden', Number(s.dataset.step) !== n && s !== leaving));
  $$('.ob-dots span').forEach((d, i) => {
    d.classList.toggle('on', i === n); d.classList.toggle('back', i < n); d.tabIndex = i < n ? 0 : -1;
    d.setAttribute('aria-disabled', String(i >= n));
    if (i === n) d.setAttribute('aria-current', 'step'); else d.removeAttribute('aria-current');
  });
  if (n === STEP.name || n === STEP.signIn) $$<HTMLImageElement>('.ob-icon').forEach(i => { i.src = appIcon(); }); // developer mode may have flipped it
  if (n === STEP.name) { nameInput.value = (displayName() ?? '').slice(0, 40).replace(/[\uD800-\uDBFF]$/, ''); syncNameNext(); } // the cut mustn't split an emoji
  if (n === STEP.signIn) { renderConnected(); termsBox.checked = !!appState.termsAcceptedAt; syncAccountNext(); }
  // The tool scan starts on the name step, so its list (and the tools card's height) is usually final before the tools
  // step shows; a scan landing mid-flight re-centred the whole step in one frame.
  if (n === STEP.name || n === STEP.tools) detectTools().catch(() => { /* the tools card shows the error */ });
  if (n === STEP.home && Date.now() - homeReadyAt > 15_000) renderHome();
  // Once set up, Home is a screen of its own rather than a setup step, so the progress dots go.
  $('#onboard').classList.toggle('settled', appState.onboarded);
  syncTitleBar(); // Home's title bar is the theme's, setup's is the sky
  playStep(prev, n, oldLogo, from, fromSurface, fromButtons, fromHeading, fromEls, leaving);
}
$$('[data-next]').forEach(b => b.onclick = () => goStep(step + 1));
// Home is built while the tools step is up, at idle, so the click that opens it doesn't also have to build it; then it
// stays drawn, nearly invisible and still .hidden, behind that step (.ob-prewarm), so its fade-in starts from a finished
// picture instead of waiting a few frames for one and jumping to catch up. Only once the tools step has landed
// (playStep): drawn behind the tools card's glass mid-flight, it had the glass re-blur it every frame.
let homeReadyAt = 0;
function prepareHome(): void {
  const build = () => {
    if (step !== STEP.tools) return;
    renderHome();
    homeReadyAt = Date.now();
    const home = stepEl(STEP.home);
    home.classList.add('ob-prewarm');
    home.inert = true;
  };
  if ('requestIdleCallback' in window) requestIdleCallback(build, { timeout: 1500 }); else setTimeout(build, 300);
}

/* ----- Motion between setup steps. One clock: everything that travels (the morphing pieces, the logo, the surface's
   clip, the heading going back) takes OB_D on OB_EASE, so pieces that move together stay together. The old step fades
   out where it was while the new one comes in; going forward the new heading's letters hop in, going back its parts
   fade in once the pieces have passed. ----- */
const OB_SOFT = 'cubic-bezier(.16, 1, .3, 1)';
const OB_CURVE = 'cubic-bezier(.22, .72, .2, 1)'; // softer off the mark than OB_SOFT, or the curve is over before it's seen
const OB_MOVE = SPRING; // reshaping in place (the launch's logo morph, the account form's glide)
const OB_PACE = 1.3; // stretches every step transition (durations and delays) evenly; 1 is the original pace
const OB_D = 760 * OB_PACE; // one flight
// A cubic-bezier as a linear() curve that is exactly at rest for its last 3%. A plain curve is still a hundredth of a
// pixel short on the last frame, enough to round an edge to the other device pixel, so a ghost landed one pixel off
// its piece and the piece flicked as it took over. (The tail it drops is under a quarter pixel on the longest flight.)
function restingEase(x1: number, y1: number, x2: number, y2: number, n = 64): string {
  const at = (s: number, a: number, b: number) => 3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s * s * b + s ** 3;
  const pts = Array.from({ length: n }, (_, i) => [at(i / n, x1, x2), at(i / n, y1, y2)]).filter(([x]) => x < .97);
  return `linear(${pts.map(([x, y]) => `${+y.toFixed(5)} ${+(x * 100).toFixed(3)}%`).join(', ')}, 1 97%, 1 100%)`;
}
// Off the mark at once (a slow start reads as a stall after the click) and into place without overshoot.
const OB_EASE = restingEase(.3, 0, .2, 1);
// A ghost hands over to its real piece this long after it lands. Its copies' own animations have ended by then and
// hold nothing (fill 'backwards'): an animation still in effect draws its element through a transform, unsnapped to
// the pixel grid, so the hand-off shifted the picture a fraction of a pixel; for these last frames it already draws
// exactly as the piece will.
const OB_TAIL = 50;
// Fades: a gentle start, so one late frame can't jump far.
const OB_FADE = 'cubic-bezier(.4, 0, .2, 1)';
// SPRING, but exactly at rest for its last stretch: an animation still a hair off 1 when it ends is redrawn at its rest
// position a frame later, and the text shimmered as it settled.
const OB_RISE = SPRING.replace(/((?:, \.99\d)+), 1\)$/, (_m, g: string) => `${g.replace(/\.99\d/g, '1')}, 1)`);
const stepEl = (n: number) => $(`.ob-step[data-step="${n}"]`);
const stepLogo = (n: number) => stepEl(n).querySelector<HTMLImageElement>('.ob-logo, .ob-icon');
const motionOff = () => document.documentElement.classList.contains('win-jump');
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
let obAnims: Animation[] = [], obGhost: HTMLElement | null = null, obBtnGhosts: HTMLElement[] = [];
function stopObMotion(): void {
  obAnims.forEach(a => a.cancel());
  obAnims = [];
  obGhost?.remove();
  obGhost = null;
  obBtnGhosts.forEach(g => g.remove());
  obBtnGhosts = [];
  $$('.ob-leaving').forEach(unpinLeaving);
  const held = $$('.ob-held'); // a step left mid-flight shows its pieces as they are
  instantly(held, () => held.forEach(e => e.classList.remove('ob-held')));
  $('#onboard').classList.remove('ob-flying');
}
// A class change that mustn't transition. Hiding a button that has an opacity transition (Continue's .25s) faded it out
// and, on release, back in: a phantom at the start of a flight and a blink after it landed. .ob-settle turns
// transitions off; once the change has applied, it comes off again with nothing left to animate.
function instantly(els: Element[], change: () => void): void {
  if (!els.length) { change(); return; }
  els.forEach(e => e.classList.add('ob-settle'));
  change();
  void getComputedStyle(els[0]).opacity;
  els.forEach(e => e.classList.remove('ob-settle'));
}
// The step being left stays exactly where it is while it fades: every step shares the same grid cell (breeze.css), so
// it and the new one overlap without either moving. (Lifting it out of the flow instead changed its layout, so all of
// it, the glass card included, had to be drawn again; the screen held the old picture until that was done, and the
// fade jumped to catch up.)
function pinLeaving(el: HTMLElement): void {
  el.classList.add('ob-leaving');
  el.inert = true; // whatever had focus in it lets go, and nothing in it takes the keys meanwhile
}
function unpinLeaving(el: HTMLElement): void {
  el.classList.add('hidden');
  el.classList.remove('ob-leaving');
  el.inert = false;
  const held = [...el.querySelectorAll('.ob-held')];
  instantly(held, () => held.forEach(e => e.classList.remove('ob-held')));
}
// Animations that pace themselves (base ms × OB_PACE) and ones on the shared clock (ms as given).
const obAnim = (el: Element, frames: Keyframe[], options: KeyframeAnimationOptions) => {
  const paced = { ...options, duration: Number(options.duration ?? 0) * OB_PACE, delay: (options.delay ?? 0) * OB_PACE };
  const a = el.animate(frames, { fill: 'backwards', ...paced });
  obAnims.push(a);
  return a;
};
const obRun = (el: Element, frames: Keyframe[], options: KeyframeAnimationOptions) => {
  const a = el.animate(frames, { fill: 'backwards', ...options });
  obAnims.push(a);
  return a;
};
const riseIn = (el: Element, delay = 0) => obAnim(el, [{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }], { duration: 560, delay, easing: OB_RISE });
// A rise on the shared clock: starts at `at` ms into the flight, lasts `dur` ms.
const riseAt = (el: Element, at: number, dur = OB_D * .55) => obRun(el, [{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }], { duration: dur, delay: at, easing: OB_RISE });
const fadeAt = (el: Element, at: number, dur = OB_D * .45) => obRun(el, [{ opacity: 0 }, { opacity: 1 }], { duration: dur, delay: at, easing: OB_FADE });
// Splits a heading into one box per letter (once), words kept whole so it wraps as before; the heading keeps its
// text for screen readers and the letters are hidden from them.
function letterBoxes(h: HTMLElement): HTMLElement[] {
  if (!h.dataset.split) {
    const text = h.textContent ?? '';
    h.setAttribute('aria-label', text);
    h.textContent = '';
    text.split(/(\s+)/).forEach(part => {
      if (!part) return;
      if (/^\s+$/.test(part)) { h.append(part); return; }
      const word = document.createElement('span');
      word.className = 'ob-word';
      word.setAttribute('aria-hidden', 'true');
      for (const ch of part) {
        const s = document.createElement('span');
        s.className = 'ob-ch';
        s.textContent = ch;
        word.append(s);
      }
      h.append(word);
    });
    h.dataset.split = '1';
  }
  return [...h.querySelectorAll<HTMLElement>('.ob-ch')];
}
// Each letter in turn hops in from the left along a downward parabola: rising, over the top, and down into place.
// Spaced so the last letter lands with the rest of the flight (about OB_D), and close enough that neighbours don't
// collide on the way.
const LETTER_FRAMES: Keyframe[] = Array.from({ length: 25 }, (_, k) => {
  const t = k / 24;
  return { transform: `translate(${-44 * (1 - t)}px, ${-26 * 4 * t * (1 - t)}px)`, opacity: Math.min(1, t * 2.5) };
});
function lettersIn(h: HTMLElement, at = 0): void {
  const boxes = letterBoxes(h), dur = OB_D * .5;
  const stagger = boxes.length > 1 ? Math.max(6, (OB_D * 1.05 - at - dur) / (boxes.length - 1)) : 0;
  boxes.forEach((s, i) => obRun(s, LETTER_FRAMES, { duration: dur, delay: at + i * stagger, easing: OB_CURVE }));
}
// The surface each screen is built on. Between screens the new one's grows out of the old one's shape (a morph).
const SURFACE = ['.ob-start', '#obName', '.ob-form', '.setup-card'];
const surfaces = (n: number) => SURFACE[n] ? [...stepEl(n).querySelectorAll<HTMLElement>(SURFACE[n])] : [];
// `solid`: whether the old surface is something you can see (a white field, a button, a card) or only a frame for its
// contents (the account form has no background of its own).
interface SurfaceBox { rect: DOMRect; radius: string; solid: boolean }
function surfaceBox(n: number): SurfaceBox | null {
  const els = surfaces(n).filter(e => e.getClientRects().length);
  if (!els.length) return null;
  const rs = els.map(e => e.getBoundingClientRect());
  const l = Math.min(...rs.map(r => r.left)), t = Math.min(...rs.map(r => r.top));
  const rect = new DOMRect(l, t, Math.max(...rs.map(r => r.right)) - l, Math.max(...rs.map(r => r.bottom)) - t);
  const cs = getComputedStyle(els[0]);
  const solid = !/rgba\([^)]*,\s*0\)|transparent/.test(cs.backgroundColor) || cs.backgroundImage !== 'none' || cs.boxShadow !== 'none' || cs.backdropFilter !== 'none';
  return { rect, radius: cs.borderTopLeftRadius, solid };
}
// A clip, not a scale: the corners don't stretch and the glass keeps its blurred backdrop. A surface the old shape
// doesn't cover starts as an empty clip where the old shape was. The start is never square-cornered: Chromium draws an
// inset clip animating from `round 0px` as the start shape until halfway, then jumps. Out of a surface you can't see,
// the new one also fades in as it grows: at full strength from its first frame it appeared as a sudden box.
function morphIn(n: number, from: SurfaceBox | null, skip: HTMLElement[] = []): void {
  surfaces(n).filter(el => !skip.some(s => s.contains(el))).forEach(el => { // a piece morphButtons carries is already on its way
    if (!from) { riseAt(el, 0); return; }
    const to = el.getBoundingClientRect(), a = from.rect, radius = getComputedStyle(el).borderTopLeftRadius;
    const r0 = `${Math.max(1, parseFloat(from.radius) || 0)}px`;
    const fade = from.solid ? [{}, {}, {}] : [{ opacity: 0 }, { opacity: 1 }, { opacity: 1 }];
    obRun(el, [
      { clipPath: `inset(${a.top - to.top}px ${to.right - a.right}px ${to.bottom - a.bottom}px ${a.left - to.left}px round ${r0})`, ...fade[0] },
      { offset: .4, ...fade[1] },
      { clipPath: `inset(-40px round calc(${radius} + 40px))`, ...fade[2] }, // ends outside the box so its shadow is already showing when the clip comes off
    ], { duration: OB_D, easing: OB_EASE });
  });
}
// Where the wind sits inside each logo picture, as fractions of its box (glyph width, centre x, centre y), measured
// from the images. Between two different pictures the winds are lined up, not the boxes (the wind fills Agent.png but
// sits inset in Icon.png's tile).
const LOGO_GLYPH: Record<string, [number, number, number]> = { 'Agent.png': [.944, .502, .544], 'Icon.png': [.784, .502, .5115], 'IconDev.png': [.784, .502, .5115] };
const glyphOf = (img: HTMLImageElement): [number, number, number] => LOGO_GLYPH[img.src.split('/').pop() ?? ''] ?? [1, .5, .5];
// The logo travels from its old spot to its new one. Two different pictures travel together in one ghost, wind on wind,
// cross-fading additively, and the real logo shows when they land. With no logo where it's going, the old one leaves
// with its step.
function glideLogo(logo: HTMLImageElement | null, old: HTMLImageElement, from: DOMRect): void {
  if (!logo) return;
  const to = logo.getBoundingClientRect();
  const timing = { duration: OB_D, easing: OB_EASE, fill: 'both' as FillMode };
  if (logo.src === old.src) {
    const dx = from.left + from.width / 2 - to.left - to.width / 2, dy = from.top + from.height / 2 - to.top - to.height / 2;
    obRun(logo, [{ transform: `translate(${dx}px, ${dy}px) scale(${from.width / to.width})` }, { transform: 'none' }], timing);
    return;
  }
  const [fw, fx, fy] = glyphOf(old), [tw, tx, ty] = glyphOf(logo);
  const s = (from.width * fw) / (to.width * tw); // old wind's size over the new wind's
  const gx = from.left + from.width * fx - (to.left + to.width * tx), gy = from.top + from.height * fy - (to.top + to.height * ty);
  const ghost = obGhost = document.createElement('div');
  ghost.className = 'ob-ghost ob-logo-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  const pic = (src: HTMLImageElement, r: DOMRect, ox: number, oy: number) => {
    const i = document.createElement('img');
    i.src = src.src;
    i.alt = '';
    Object.assign(i.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, transformOrigin: `${r.width * ox}px ${r.height * oy}px` });
    ghost.append(i);
    return i;
  };
  const was = pic(old, from, fx, fy), now = pic(logo, to, tx, ty);
  $('#onboard').append(ghost);
  instantly([logo], () => logo.classList.add('ob-held'));
  // The arriving picture holds nothing past its flight (OB_TAIL); the leaving one stays at its end, unseen.
  const move = obRun(now, [{ transform: `translate(${gx}px, ${gy}px) scale(${s})` }, { transform: 'none' }], { ...timing, fill: 'backwards', endDelay: OB_TAIL });
  obRun(was, [{ transform: 'none' }, { transform: `translate(${-gx}px, ${-gy}px) scale(${1 / s})` }], timing);
  // The cross-fade is over at 60% of the flight. Then the old picture goes and the new one stops adding: drawn in an
  // additive group it's resampled off the pixel grid and looked softer than the real logo it hands over to. The
  // change lands while the logo is still moving, where it can't be seen.
  const xfade = { duration: OB_D * .6 };
  obRun(was, [{ opacity: 1 }, { opacity: 1, offset: 1 / 3 }, { opacity: 0 }], { ...xfade, fill: 'both' }).onfinish = () => {
    was.remove();
    ghost.style.isolation = 'auto';
    now.style.mixBlendMode = 'normal';
  };
  obRun(now, [{ opacity: 0 }, { opacity: 0, offset: 1 / 3 }, { opacity: 1 }], { ...xfade, fill: 'backwards' });
  move.onfinish = () => { ghost.remove(); instantly([logo], () => logo.classList.remove('ob-held')); };
}
/* ----- The step's pieces grow out of the last step's: Get started splits into the name box and Continue, those split
   into the sign-in choices, several merge back into one. A ghost per new piece carries a copy of the old piece to the
   new one's place and shape, cross-fading into a copy of the new one, and the real piece takes over where it lands. ----- */
const OB_BUTTONS = '.ob-field, .ob-start, [data-signin], #obAccountNext';
// A piece as it looks right now: its layout box (where it sits, untransformed), the transform it shows (a hover lift),
// and a deep copy with the properties that draw it written onto it. The rules that styled the piece depend on where it
// sits (.ob-form .signin-btns .btn, #obAccountNext...), so a copy of just its markup would look different elsewhere;
// written out like this it looks exactly like the piece wherever it goes, and the ghost lands on it pixel for pixel.
// `inset`: for a heading, where its text starts inside its box (the ghost carries the text, not the full-width box).
interface ButtonShot { rect: DOMRect; copy: HTMLElement; scale: [number, number]; inset?: [number, number] }
const stepButtons = (n: number) => n === STEP.home ? [] : [...stepEl(n).querySelectorAll<HTMLElement>(OB_BUTTONS)].filter(b => b.getClientRects().length);
// What draws a button, a text box, its label and icons, a heading's letters. (All ~540 computed properties, written
// one by one, cost 15-60ms on the click; this list is what these pieces actually vary.)
const COPY_PROPS = ['display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'box-sizing', 'width', 'height', 'min-width', 'min-height',
  'max-width', 'max-height', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom',
  'padding-left', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-style', 'border-right-style',
  'border-bottom-style', 'border-left-style', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius', 'outline-style', 'outline-width',
  'outline-color', 'outline-offset', 'background-color', 'background-image', 'background-size', 'background-position', 'background-repeat',
  'background-clip', 'background-origin', 'box-shadow', 'opacity', 'visibility', 'overflow-x', 'overflow-y', 'transform', 'transform-origin',
  'filter', 'color', 'caret-color', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-variant', 'font-feature-settings',
  'font-variation-settings', 'font-kerning', 'font-optical-sizing', 'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-indent',
  'text-transform', 'text-decoration-line', 'text-decoration-color', 'text-decoration-style', 'text-shadow', 'text-rendering',
  '-webkit-font-smoothing', 'white-space', 'text-overflow', 'vertical-align', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink',
  'flex-basis', 'align-items', 'align-self', 'align-content', 'justify-content', 'justify-items', 'justify-self', 'row-gap', 'column-gap', 'order',
  'grid-template-columns', 'grid-template-rows', 'grid-auto-flow', 'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap',
  'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'object-fit', 'object-position', 'image-rendering', 'isolation',
  'mix-blend-mode', 'direction', 'unicode-bidi'];
// A heading's letter boxes (letterBoxes) all style alike, so theirs is read once per class: read one by one, they were
// most of the click's work going back to the name step (30ms).
function copyStyles(src: Element, dst: Element, memo = new Map<string, string>()): void {
  const key = src.matches('.ob-ch, .ob-word') ? src.className : '';
  let css = memo.get(key) ?? '';
  if (!css) {
    const cs = getComputedStyle(src);
    // Shared across a class, so no size: every letter took the first one's width and the heading spread apart mid-flight.
    for (const p of COPY_PROPS) if (!key || (p !== 'width' && p !== 'height')) css += `${p}:${cs.getPropertyValue(p)};`;
    if (key) memo.set(key, css);
  }
  // No animation or transition of its own, and no blur: the pieces carry it over opaque white, where it shows nothing,
  // but a blurring copy over the sky changed how the sky was drawn under it.
  (dst as HTMLElement).style.cssText = `${css}animation:none;transition:none;backdrop-filter:none;`;
  // Unique ids stay unique, and no class rule (a hover, an icon's loop) reaches the copy.
  for (const a of ['id', 'for', 'class']) dst.removeAttribute(a);
  if (src instanceof HTMLInputElement) (dst as HTMLInputElement).value = src.value;
  [...src.children].forEach((c, i) => { if (dst.children[i]) copyStyles(c, dst.children[i], memo); });
}
// The box a piece takes in the layout, centred where it shows: a hover lift (scale about the centre) doesn't move its
// centre, and the copy carries the lift itself.
// The size is the shown one undone by the lift's scale, not offsetWidth: that rounds to whole pixels, so the ghost
// landed up to half a pixel off the real piece and the piece snapped as it took over.
function layoutBox(b: HTMLElement, [sx, sy]: [number, number]): DOMRect {
  const r = b.getBoundingClientRect(), w = r.width / sx, h = r.height / sy;
  return new DOMRect(r.left + r.width / 2 - w / 2, r.top + r.height / 2 - h / 2, w, h);
}
// `settled`: where a piece is landing, its look once its own transitions finish (the name box was just focused and its
// lift shadow is still on the way in); otherwise the ghost lands on one look and the real piece shows another.
function shootButton(b: HTMLElement, settled = false): ButtonShot {
  if (settled) b.classList.add('ob-settle'); // ends running transitions at their end values; the piece is hidden meanwhile
  const copy = b.cloneNode(true) as HTMLElement;
  copyStyles(b, copy);
  const t = getComputedStyle(b).transform, m = new DOMMatrixReadOnly(t === 'none' ? undefined : t);
  const scale: [number, number] = [m.a || 1, m.d || 1];
  const rect = layoutBox(b, scale);
  if (settled) b.classList.remove('ob-settle');
  return { rect, copy, scale };
}
// A heading: the ghost is the size of its text (a Range over its contents), not of its box, which may be the column's
// full width; the copy keeps its letter boxes, so its letters sit exactly as the real heading's do.
function shootText(h: HTMLElement): ButtonShot {
  const copy = h.cloneNode(true) as HTMLElement;
  copyStyles(h, copy);
  const box = h.getBoundingClientRect(), range = document.createRange();
  range.selectNodeContents(h);
  const t = range.getBoundingClientRect();
  return { rect: t, copy, scale: [1, 1], inset: [t.left - box.left, t.top - box.top] };
}
// One copy in a ghost. A button or text box fills the ghost and lays itself out at the ghost's size as it changes (its
// words keep their size and place); a heading keeps its own size, placed so its text fills the ghost, and is scaled.
// Returns the layer and the parts of it that are words (they change over on their own, so labels never overlap).
function ghostLayer(s: ButtonShot, text: boolean, keepLift: boolean): { layer: HTMLElement; words: Element[] } {
  const layer = document.createElement('div');
  layer.className = 'ob-layer';
  const c = s.copy.cloneNode(true) as HTMLElement; // one shot can feed several ghosts (a merge)
  const box = { margin: '0', translate: 'none', rotate: 'none', position: 'absolute' };
  if (text) {
    const [x, y] = s.inset ?? [0, 0];
    Object.assign(c.style, box, { left: `${-x}px`, top: `${-y}px`, transform: 'none', transformOrigin: `${x}px ${y}px` });
  } else {
    // The old piece starts with the lift it had (a hovered button is a little larger) and settles out of it.
    const [sx, sy] = s.scale;
    Object.assign(c.style, box, { left: '0', top: '0', width: '100%', height: '100%', whiteSpace: 'nowrap', transformOrigin: '50% 50%', transform: keepLift && (sx !== 1 || sy !== 1) ? `scale(${sx}, ${sy})` : 'none' });
    // A button clips its words while it's narrower than them; a text box's own input does that, and clipping the field
    // would cut off the input's lift shadow.
    if (c.querySelector('input')) c.querySelectorAll<HTMLElement>('input').forEach(i => Object.assign(i.style, { width: '100%', height: '100%' }));
    else c.style.overflow = 'hidden';
  }
  layer.append(c);
  let words: Element[];
  if (text) words = [c];
  else if (c.querySelector('input')) words = [...c.querySelectorAll('label')];
  else {
    // Bare words straight in the button get a box of their own to fade.
    [...c.childNodes].forEach(nd => { if (nd.nodeType === Node.TEXT_NODE && nd.textContent?.trim()) { const sp = document.createElement('span'); nd.replaceWith(sp); sp.append(nd); } });
    words = [...c.children];
  }
  return { layer, words };
}
// Going back, the heading travels too: the old step's title moves and resizes into the new one's, the words cross-fading.
const stepHeading = (n: number) => n === STEP.home ? null : stepEl(n).querySelector<HTMLElement>('h1, h2');
// Returns the elements that arrived this way, so playStep leaves them out of its own rise and fades.
function morphButtons(n: number, from: ButtonShot[]): HTMLElement[] {
  return morphPieces(from, stepButtons(n));
}
// Pieces just landed under a pointer that hasn't moved since: no hover lift until it does (.ob-landed, breeze.css), or
// the landing would be followed at once by a second beat as the piece lifted under the resting pointer.
const obLanded = new Set<HTMLElement>();
document.addEventListener('pointermove', () => {
  if (!obLanded.size) return;
  obLanded.forEach(e => e.classList.remove('ob-landed'));
  obLanded.clear();
}, { passive: true });
function morphPieces(from: ButtonShot[], to: HTMLElement[], text = false): HTMLElement[] {
  if (!from.length || !to.length) return [];
  // In order: each new piece grows out of the old one in its place (the last old one when there are more new ones),
  // and old ones left over merge into the last new one.
  const pairs: [ButtonShot, HTMLElement][] = [
    ...to.map((b, i): [ButtonShot, HTMLElement] => [from[Math.min(i, from.length - 1)], b]),
    ...from.slice(to.length).map((f): [ButtonShot, HTMLElement] => [f, to[to.length - 1]]),
  ];
  const timing = { duration: OB_D, easing: OB_EASE, fill: 'forwards' as FillMode };
  const box = (r: DOMRect): Keyframe => ({ left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  const shots = new Map(to.map(b => [b, text ? shootText(b) : shootButton(b, true)]));
  // The real pieces stay hidden under their ghosts (.ob-held: unseen, and deaf to the pointer).
  instantly(to, () => to.forEach(b => b.classList.add('ob-held')));
  const landsAs = new Set<HTMLElement>(), splitFrom = new Set<ButtonShot>();
  const flights: { ghost: HTMLElement; move: Animation; b: HTMLElement; to: DOMRect; shift: [number, number]; fix?: Animation }[] = [];
  for (const [f, b] of pairs) {
    const t = shots.get(b) as ButtonShot;
    // Several old pieces merging into one: one lands as it; the others fade out under it while they converge. One old
    // piece splitting into several: one leaves as it; the others fade in under it as they separate. Copies of one piece
    // stacked at full strength would add up their shadows and edges.
    const mergeFollower = landsAs.has(b), splitFollower = splitFrom.has(f);
    landsAs.add(b);
    splitFrom.add(f);
    const ghost = document.createElement('div');
    ghost.className = `ob-ghost ob-btn-ghost${text ? ' ob-text-ghost' : ''}`;
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true; // the copies are buttons and a text box too; nothing in here takes focus
    const was = ghostLayer(f, text, true), now = ghostLayer(t, text, false);
    ghost.append(was.layer, now.layer);
    $('#onboard').append(ghost);
    obBtnGhosts.push(ghost);
    const move = ghost.animate([box(f.rect), box(t.rect)], { ...timing, endDelay: OB_TAIL });
    // The hand-over is one change in one task: the ghost goes and the real piece shows, so they reach the screen in
    // the same frame. (Ended by separate animations, the compositor dropped the ghost a frame before the page showed
    // the piece, and it blinked out as it landed.)
    move.onfinish = () => {
      ghost.remove();
      if (mergeFollower) return;
      instantly([b], () => { b.classList.remove('ob-held'); b.classList.add('ob-landed'); });
      obLanded.add(b);
    };
    obAnims.push(move);
    flights.push({ ghost, move, b, to: t.rect, shift: [0, 0] });
    if (mergeFollower) obRun(ghost, [{ opacity: 1 }, { opacity: 1, offset: .2 }, { opacity: 0, offset: .5 }, { opacity: 0 }], { duration: OB_D, fill: 'forwards' });
    else if (splitFollower) obRun(ghost, [{ opacity: 0 }, { opacity: 1, offset: .25 }, { opacity: 1 }], { duration: OB_D, fill: 'backwards' });
    // The two copies cross-fade additively (plus-lighter, breeze.css) over one window on one curve, so the shape never
    // dips or turns see-through and coverage goes straight from the old piece's to the new one's. Words change over
    // apart from it: the old words leave before the new ones come. What arrives holds nothing past the flight
    // (OB_TAIL); what leaves stays gone. Once the cross-fade is over (70% of the flight) the old copy goes and the new
    // one stops adding, as the logo does (glideLogo): drawn additively its words took other anti-aliasing than the
    // real piece's, and changed as it took over.
    const xf = { duration: OB_D, fill: 'forwards' as FillMode }, xfIn = { duration: OB_D, fill: 'backwards' as FillMode };
    obRun(was.layer, [{ opacity: 1 }, { opacity: 1, offset: 3 / 7 }, { opacity: 0 }], { duration: OB_D * .7, fill: 'forwards' }).onfinish = () => {
      was.layer.style.display = 'none';
      now.layer.style.mixBlendMode = 'normal';
      ghost.style.isolation = 'auto';
    };
    obRun(now.layer, [{ opacity: 0 }, { opacity: 0, offset: 3 / 7 }, { opacity: 1 }], { duration: OB_D * .7, fill: 'backwards' });
    if (!text) {
      was.words.forEach(w => obRun(w, [{ opacity: 1 }, { opacity: 0, offset: .42 }, { opacity: 0 }], xf));
      now.words.forEach(w => obRun(w, [{ opacity: 0 }, { opacity: 0, offset: .5 }, { opacity: 1, offset: .8 }, { opacity: 1 }], xfIn));
      if (f.scale[0] !== 1 || f.scale[1] !== 1) obRun(was.layer.firstChild as Element, [{ transform: `scale(${f.scale[0]}, ${f.scale[1]})` }, { transform: 'none', offset: .3 }, { transform: 'none' }], xf);
    } else {
      // A heading's text scales from the old size to the new; done a little before the end, so the last frames draw
      // the words unscaled, as the real heading's are.
      const k = t.rect.width / f.rect.width;
      obRun(was.layer.firstChild as Element, [{ transform: 'none' }, { transform: `scale(${k})` }], timing);
      obRun(now.layer.firstChild as Element, [{ transform: `scale(${1 / k})` }, { transform: 'none', offset: .9 }, { transform: 'none' }], { ...timing, fill: 'backwards' });
    }
  }
  // A piece can move while its ghost is on the way (the tools card grows when its scan comes back, pushing Continue
  // down). The ghost eases over to where the piece is now over the time left, rather than jumping onto its new path or
  // landing on empty card. Only the tools step lays out again mid-flight, so only there is it watched.
  if (to.some(b => b.closest('.tools'))) {
    const follow = () => {
      const live = flights.filter(x => x.move.playState === 'running');
      for (const x of live) {
        const r = x.b.getBoundingClientRect(); // held: unseen but laid out
        const dx = r.left - x.to.left, dy = r.top - x.to.top;
        if (Math.abs(dx) + Math.abs(dy) < .5) continue;
        x.to = r;
        x.shift = [x.shift[0] + dx, x.shift[1] + dy];
        const left = Math.max(16, OB_D - Number(x.move.currentTime ?? 0));
        const cur = getComputedStyle(x.ghost).translate;
        x.fix?.cancel();
        x.fix = obRun(x.ghost, [{ translate: cur === 'none' ? '0px 0px' : cur }, { translate: `${x.shift[0]}px ${x.shift[1]}px` }], { duration: left, easing: OB_FADE, fill: 'forwards' });
      }
      if (live.length) requestAnimationFrame(follow);
    };
    requestAnimationFrame(follow);
  }
  return to;
}
function playStep(prev: number, n: number, oldLogo: HTMLImageElement | null, from: DOMRect | null, fromSurface: SurfaceBox | null,
  fromButtons: ButtonShot[] = [], fromHeading: ButtonShot[] = [], fromEls: HTMLElement[] = [], leaving: HTMLElement | null = null): void {
  const el = stepEl(n), logo = stepLogo(n);
  const settled = () => {
    $('#onboard').classList.remove('ob-flying');
    syncDots();
    if (n === STEP.tools) prepareHome();
    // What had focus just went away with the old screen; a keyboard or screen reader user lands on the new one.
    if (n !== STEP.name && !el.contains(document.activeElement)) el.querySelector<HTMLElement>('h1, h2')?.focus({ preventScroll: true });
  };
  // Focus the name box now, not when the animations end: the heading's stagger would otherwise eat the first keystrokes.
  if (n === STEP.name) { nameInput.focus({ preventScroll: true }); nameInput.setSelectionRange(nameInput.value.length, nameInput.value.length); }
  if (prev !== n && !appState.onboarded && !motionOff()) {
    $('#onboard').classList.add('ob-flying');
    // Coming back to the welcome replays its intro otherwise; Home's own entrance is below, not its CSS rise and view
    // fade on top of it. Only clock-driven ones: a scroll-driven one (the tool list's edge fade) would stay cancelled.
    el.getAnimations({ subtree: true }).filter(a => a.timeline === document.timeline && (n !== STEP.home || (a instanceof CSSAnimation && ['rise', 'fade'].includes(a.animationName)))).forEach(a => a.cancel());
    if (reducedMotion()) {
      // Reduced motion: the new screen fades in, nothing travels.
      if (n !== STEP.home) el.querySelectorAll(':scope > :not(.setup-grid), .setup-card').forEach(c => obAnim(c, [{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease' }));
    } else {
      if (oldLogo && from) glideLogo(logo, oldLogo, from);
      else if (logo) fadeAt(logo, OB_D * .2); // no logo on the screen it came from
      // The leaving step's pieces that ghosts carry are hidden in it (and its logo, if this step has one to glide to).
      const carried = [...fromEls];
      if (logo && oldLogo && leaving?.contains(oldLogo)) carried.push(oldLogo);
      if (n !== STEP.home) {
        const own = surfaces(n);
        // Pieces that grew out of the last step's are already on their way; nothing else may move, clip or fade them.
        // The heading travels too going back, unless its path would cross the logo (it would fly over it).
        const heading = stepHeading(n), lb = logo?.getBoundingClientRect();
        const headFrom = fromHeading[0], headTo = heading?.getClientRects().length ? (() => { const r = document.createRange(); r.selectNodeContents(heading); return r.getBoundingClientRect(); })() : null;
        const across = !!(lb && headFrom && headTo) && (lb.top + lb.height / 2 - (headFrom.rect.top + headFrom.rect.height / 2)) * (lb.top + lb.height / 2 - (headTo.top + headTo.height / 2)) < 0;
        const headMoves = !!(heading && headFrom && headTo && !across);
        if (headMoves) { const oldH = leaving && stepHeading(prev); if (oldH) carried.push(oldH); }
        const morphed = [...morphButtons(n, fromButtons), ...(headMoves && heading ? morphPieces(fromHeading, [heading], true) : [])];
        const free = (c: Element) => !morphed.some(b => c.contains(b) || b.contains(c));
        morphIn(n, fromSurface, morphed);
        if (n < prev) {
          // Going back, what didn't travel fades in once the travelling pieces are under way, each part on its own (one
          // fading inside a parent loses its blurred backdrop until the fade ends); a surface's own parts fade too.
          const parts = [...el.querySelectorAll<HTMLElement>(':scope > :not(.ob-logo, .ob-icon, .setup-grid), .setup-card')]
            .flatMap(c => own.includes(c) ? [...c.children] as HTMLElement[] : [c]);
          parts.filter(free).forEach(c => fadeAt(c, OB_D * .25));
        } else if (n === STEP.name) {
          lettersIn($('h2', el), OB_D * .06);
          const label = $('.ob-field label', el);
          if (free(label)) fadeAt(label, OB_D * .35);
          if (free(nameNext)) riseAt(nameNext, OB_D * .4);
        } else if (n === STEP.signIn) {
          // The white card grows in first, then the title's letters hop in and the rest rises in under it.
          const form = $('.ob-form', el);
          lettersIn($('h2', form), OB_D * .2);
          [...form.querySelectorAll(':scope > :not(h2)')].filter(free).forEach((c, i) => riseAt(c, OB_D * (.3 + i * .05)));
        } else {
          [...el.querySelectorAll(':scope > :not(.setup-grid, .setup-card)')].filter(free).forEach((c, i) => riseAt(c, OB_D * i * .05));
          el.querySelectorAll('.setup-card > *').forEach((c, i) => riseAt(c, OB_D * (.25 + i * .04)));
        }
      } else if (prev < n) {
        // Setup's last Continue: Home fades up under the tools step as that fades away, and its panel settles in, all
        // on one clock with a gentle start (Home's first frame is a heavy one; a late frame mustn't jump far).
        obRun(el, [{ opacity: 0 }, { opacity: 1 }], { duration: OB_D * .72, easing: OB_FADE });
        obRun($('.home-shell', el), [{ transform: 'translateY(16px) scale(.985)' }, { transform: 'none' }], { duration: OB_D * .72, easing: OB_EASE });
        obRun($('.home-head', el), [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: OB_D * .62, delay: 90, easing: OB_EASE });
      }
      instantly(carried, () => carried.forEach(e => e.classList.add('ob-held')));
      if (leaving) {
        // The old step fades out where it was, drifting a little the way the flow goes, over the start of the flight.
        // Each part fades itself rather than the step as one group: a fading group cuts the glass card's blur off from
        // the sky behind it, and the card changed its look in a single frame.
        const away = n > prev ? -1 : 1;
        const exits = [...leaving.children].map(c => obRun(c, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateY(${away * 10}px)` }], { duration: OB_D * .36, easing: OB_FADE, fill: 'forwards' }));
        if (exits.length) exits[0].onfinish = () => unpinLeaving(leaving); else unpinLeaving(leaving);
      }
    }
  }
  if (leaving && !obAnims.length) unpinLeaving(leaving);
  if (obAnims.length) Promise.all(obAnims.map(a => a.finished)).then(settled, () => { /* a newer step took over */ });
  else settled();
}
// The first draw of each screen makes the GPU build its shader programs (20-40ms, a stall at the start of that step's
// first transition). Once the welcome has settled, each hidden step is drawn for a few frames, nearly invisible behind
// it, along with the morph's own effects (an additive cross-fade, an animated clip), so those programs exist before
// anyone clicks.
let prewarmed = false;
function prewarmSteps(): void {
  if (prewarmed || step !== STEP.welcome || appState.onboarded || motionOff() || reducedMotion() || $('#onboard').classList.contains('ob-flying')) return;
  prewarmed = true;
  const steps = $$('.ob-step').filter(s => s.classList.contains('hidden'));
  steps.forEach(s => { s.classList.add('ob-prewarm'); s.inert = true; });
  const probe = document.createElement('div');
  probe.className = 'ob-prewarm-probe';
  probe.setAttribute('aria-hidden', 'true');
  probe.innerHTML = '<i></i><i></i>';
  $('#onboard').append(probe);
  probe.animate([{ clipPath: 'inset(0 round 1px)' }, { clipPath: 'inset(4px round 12px)' }], { duration: 120 });
  let frames = 0;
  const done = () => {
    if (++frames < 4) { requestAnimationFrame(done); return; }
    // Home stays drawn ahead if the tools step is up by now (prepareHome).
    steps.forEach(s => { if (s.classList.contains('ob-prewarm') && !(step === STEP.tools && s.classList.contains('home-step'))) { s.classList.remove('ob-prewarm'); s.inert = false; } });
    probe.remove();
  };
  requestAnimationFrame(done);
}
addEventListener('load', () => setTimeout(() => {
  if ('requestIdleCallback' in window) requestIdleCallback(prewarmSteps, { timeout: 2000 }); else prewarmSteps();
}, 4500));

/* ----- Name ----- */
function syncNameNext(): void { nameNext.disabled = !nameInput.value.trim(); }
nameInput.oninput = syncNameNext;
$('#obNameForm').onsubmit = e => {
  e.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;
  appState.name = name;
  goStep(STEP.signIn);
};
// While setup is up, the window buttons sit straight on its sky and draw light. Home has a plain title bar of its own,
// like the IDE's, so they keep the theme's colours there.
function syncTitleBar(): void {
  const ob = $('#onboard');
  const on = !ob.classList.contains('hidden') && !ob.classList.contains('screen-out') && !ob.classList.contains('screen-prep')
    && $('.home-step').classList.contains('hidden');
  document.documentElement.classList.toggle('clear-bar', on);
}
new MutationObserver(syncTitleBar).observe($('#onboard'), { attributes: true, attributeFilter: ['class'] });
syncTitleBar();

// The dots before the current one take you back to that step.
$$('.ob-dots span').forEach((d, i) => {
  d.onclick = () => { if (i < step) goStep(i); };
  d.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); d.click(); } };
  d.setAttribute('role', 'button');
  d.setAttribute('aria-label', `Step ${i + 1}: ${['Welcome', 'Your name', 'Account', 'Tools', 'Home'][i]}`);
});
// Nothing here has a double-click, and the first click may have changed the screen: the second would land on whatever
// is now under the pointer (a theme, a new file).
$('#onboard').addEventListener('click', e => { if (e.detail > 1) { e.preventDefault(); e.stopPropagation(); } }, true);

/* ----- Accounts ----- */
function setUser(u: User | null): void {
  user = u; appState.user = u; saveApp();
  renderUser();
}
const initialsOf = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(w => [...w][0] ?? '').join('').toUpperCase(); // by code point: w[0] splits an emoji
// A guest (no account signed in) gets the classic gray silhouette, head and shoulders cut off by the circle (styles
// under ".avatar.guest" in breeze.css); an account without a picture gets its initials.
const GUEST_FACE = '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="15.5" r="7.5"/><path d="M4 41c0-9.4 7.2-15.5 16-15.5S36 31.6 36 41z"/></svg>';
const guestAvatarHtml = (title: string) => `<span class="avatar guest" title="${escAttr(title)}">${GUEST_FACE}</span>`;
function avatarHtml(u: User | null, title: string): string {
  if (!u) return guestAvatarHtml(title);
  if (u.avatar) return `<img class="avatar" src="${escAttr(u.avatar)}" alt="" title="${escAttr(title)}">`;
  return `<span class="avatar tint-host" title="${escAttr(title)}">${esc(initialsOf(u.name))}</span>`;
}
function renderUser(): void {
  const title = user ? `${user.name} · ${user.provider}` : 'Not signed in';
  $('#avatars').innerHTML = avatarHtml(user, title);
  $('#boxAvatar').innerHTML = avatarHtml(user, title);
  $('#userChip').textContent = user ? `● ${user.name} · ${user.provider}` : 'Not signed in';
  renderHomeProfile();
  renderConnected();
}
// Home's account button (picture, name and email, or an invitation to sign in) and its greeting.
let homeProfileHtml = '';
function renderHomeProfile(): void {
  const who = displayName(), first = who?.split(/\s+/)[0];
  // Signed out there is no one to welcome back, so it invites them in instead.
  $('#homeGreet').textContent = (!appState.onboarded ? 'Ready when you are' : first ? 'Welcome Back' : 'Welcome to Breeze') + (first ? ',' : '');
  $('#homeLead').textContent = !appState.onboarded ? 'Open a project to start building.'
    : first ? timeGreeting()
    : 'Sign in to bring your name and picture along, or just open a project.';
  $('#homeName').textContent = first ?? '';
  const btn = $('#homeProfile');
  // Just the picture, like the IDE's title bar; who it is goes in the tooltip.
  const html = user?.avatar ? avatarHtml(user, '') : user ? `<span class="avatar tint-host">${esc(initialsOf(who ?? user.name))}</span>` : guestAvatarHtml('');
  btn.title = user ? `${who} · ${user.provider}` : 'Sign in';
  // Opening a project redraws the user; redrawing the same picture flashed it out and back as Home left.
  if (html !== homeProfileHtml) { homeProfileHtml = html; btn.innerHTML = html; }
  btn.setAttribute('aria-label', user ? `${who} · ${user.provider}` : `${who ? `${who}. ` : ''}Sign in with GitHub or Google`);
  // Signed in it opens the account menu; signed out it goes straight to signing in.
  btn.setAttribute('aria-haspopup', user ? 'menu' : 'dialog');
  renderHomeContrib();
}

/* ----- Home: the GitHub account's contribution graph ----- */
// Shown only while the signed-in account is a GitHub one. Asked for once per account (main keeps it ten minutes);
// another account, or none, hides it until its own answer lands.
let contribFor: string | null = null;
let contribSeq = 0;
const CONTRIB_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const contribDay = (iso: string) => new Date(`${iso}T00:00:00`);
function renderHomeContrib(): void {
  const box = $('#homeContrib');
  const key = user?.provider === 'GitHub' ? `${user.provider}:${user.login ?? user.name}` : null;
  if (key === contribFor) return;
  contribFor = key;
  box.classList.add('hidden');
  if (!key) return;
  const seq = ++contribSeq;
  background(api.gh.contributions().then(r => {
    if (seq !== contribSeq || !r.ok) return; // signed out meanwhile, or GitHub didn't answer: the graph stays away
    drawContrib(r.data);
    box.classList.remove('hidden');
  }));
}
// A year button: the newest year goes back to the last twelve months, as GitHub's profile does; the graph stays put
// until the year's answer lands, and a failed one leaves it as it was.
function showContribYear(year: number | null): void {
  const seq = ++contribSeq;
  background(api.gh.contributions(year).then(r => {
    if (seq !== contribSeq) return;
    if (r.ok) { const data = r.data; morphContribYear(() => drawContrib(data)); }
    else toast(r.message ?? 'Could not load that year from GitHub');
  }));
}
// The squares cross-fade into the new year's (a view transition, .contrib-morph in breeze.css) while the blue pill
// slides from the old year's button to the new one's and the count scrambles to its new number.
function morphContribYear(change: () => void): void {
  const root = document.documentElement;
  if (!document.startViewTransition || motionOff() || matchMedia('(prefers-reduced-motion: reduce)').matches
    || [...root.classList].some(c => c.endsWith('-morph') || c === 'scm-fade')) { change(); return; }
  const from = document.querySelector('.contrib-year-pill')?.getBoundingClientRect();
  const total = document.querySelector('#homeContribTitle .cg-total')?.textContent;
  root.classList.add('contrib-morph');
  const t = startMorph(change);
  const done = () => root.classList.remove('contrib-morph');
  t.finished.then(done, done);
  t.updateCallbackDone.then(() => {
    const count = document.querySelector<HTMLElement>('#homeContribTitle .cg-total');
    if (count && count.textContent !== total) scrambleText(count);
    const pill = document.querySelector<HTMLElement>('.contrib-year-pill');
    const to = pill?.getBoundingClientRect();
    if (!pill || !from || !to?.width) return;
    pill.animate([
      { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})` },
      { transform: 'none' },
    ], { duration: 510, easing: SPRING });
  }, () => {});
}
function drawContribYears(c: GhContributions): void {
  const box = $('#homeContribYears');
  box.textContent = '';
  if (c.years.length < 2) return;
  const shown = c.year ?? c.years[0];
  for (const y of c.years) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'contrib-year';
    b.textContent = String(y);
    b.setAttribute('aria-pressed', String(y === shown));
    if (y === shown) b.prepend(Object.assign(document.createElement('span'), { className: 'contrib-year-pill' }));
    b.onclick = () => { if (y !== shown) showContribYear(y === c.years[0] ? null : y); };
    box.append(b);
  }
}
// A month's label, named so a year change (.contrib-morph) glides it from its old place to its new one; a month
// that shows twice (the last twelve months can start and end in it) names its second label apart.
function contribMonth(m: number, named: Set<number>): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = 'cg-month';
  s.textContent = CONTRIB_MONTHS[m];
  s.style.setProperty('--cg-vt', `cg-m${m}${named.has(m) ? '-2' : ''}`);
  named.add(m);
  return s;
}
const contribSpan = (c: GhContributions) => c.year ? `in ${c.year}` : 'in the last year';
// The count sits in a span of its own, so a year change can scramble just that number (scrambleText, setup.ts).
function setContribTitle(c: GhContributions, tail: string): void {
  const n = document.createElement('span');
  n.className = 'cg-total';
  n.textContent = c.total.toLocaleString();
  $('#homeContribTitle').replaceChildren(n, ` contribution${c.total === 1 ? '' : 's'}${tail}`);
}
function drawContrib(c: GhContributions): void {
  drawContribYears(c);
  setContribTitle(c, ` ${contribSpan(c)}`);
  const graph = $('#homeContribGraph');
  graph.setAttribute('aria-label', `${c.total} GitHub contributions ${contribSpan(c)}`);
  graph.textContent = '';
  // Placed by grid line (set from script: the page's CSP blocks inline style attributes). Column 1 holds the day
  // names, row 1 the month names; a day sits in its week's column and its weekday's row.
  const put = (el: HTMLElement, col: number, row: number) => { el.style.gridColumn = String(col); el.style.gridRow = String(row); graph.append(el); };
  graph.style.setProperty('--weeks', String(c.weeks.length));
  ['Mon', 'Wed', 'Fri'].forEach((d, i) => {
    const s = document.createElement('span');
    s.className = 'cg-wd';
    s.textContent = d;
    put(s, 1, 3 + i * 2);
  });
  let lastMonth = -1;
  const named = new Set<number>();
  c.weeks.forEach((week, w) => {
    const first = contribDay(week[0].date);
    // A month is named over the first week that starts in it, unless it is too near the end to fit its name.
    const m = first.getMonth();
    if (m !== lastMonth && (w > 0 || first.getDate() <= 7) && w < c.weeks.length - 2) put(contribMonth(m, named), w + 2, 1);
    lastMonth = m;
    for (const d of week) {
      const day = contribDay(d.date);
      const cell = document.createElement('i');
      cell.className = 'cg-day';
      cell.dataset.l = String(d.level);
      // Only days with something on them get a tip (ui.ts shows it); the graph is one image to screen readers.
      if (d.count) cell.dataset.tooltip = `${d.count} contribution${d.count === 1 ? '' : 's'} on ${day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}`;
      put(cell, w + 2, day.getDay() + 2);
    }
  });
  $('#homeContribOpen').onclick = () => background(api.sys.openExternal(`https://github.com/${encodeURIComponent(c.login)}`));
}
// The progress dots sit in the gutter under a step. Once the window is too short for that gutter the step scrolls
// under them, so they go. Every step is watched: each has its own height, and showing one resizes it from nothing.
// Mid-flight nothing can be measured, the flying piece counts as overflow; playStep checks again when it lands.
function syncDots(): void {
  const ob = $('#onboard');
  if (!ob.classList.contains('ob-flying')) ob.classList.toggle('no-dots', ob.scrollHeight > ob.clientHeight);
}
const fitDots = new ResizeObserver(syncDots);
[$('#onboard'), ...$$('.ob-step')].forEach(el => fitDots.observe(el));
let accounts: Accounts = { accounts: [], active: null };
const accountKey = (u: User) => `${u.provider}:${u.login ?? ''}`;
async function refreshAccounts(): Promise<void> {
  accounts = await api.auth.accounts().catch(() => accounts);
  void refreshPrs(); // signing in or out, or switching account, changes what the pull request list can show
}
async function switchAccount(a: User): Promise<void> {
  if (accountKey(a) === accounts.active) return;
  setUser(await api.auth.switchTo(accountKey(a)));
  await refreshAccounts();
  toast(`Switched to ${a.name}`);
}
async function signOut(): Promise<void> {
  const next = await api.auth.signOut();
  setUser(next);
  await refreshAccounts();
  toast(next ? `Signed out — now using ${next.name}` : 'Signed out');
}
// Forgets a remembered account; forgetting the active one moves to the next.
async function removeAccount(a: User): Promise<void> {
  const wasActive = accountKey(a) === accounts.active;
  const next = await api.auth.remove(accountKey(a));
  if (wasActive) setUser(next);
  await refreshAccounts();
  toast(`Removed ${a.email ?? a.name}`);
}
// The hold-to-delete button (same as the branch picker's), used for anything that's hard to undo.
const holdDelHtml = (label: string, attrs = '', tag: 'button' | 'span' = 'button', icon = 'trash') =>
  `<${tag} class="br-del" ${tag === 'span' ? 'role="button" tabindex="0" ' : ''}${attrs} title="Hold for 5 seconds to remove" aria-label="Hold for 5 seconds to remove ${escAttr(label)}">${svgIcon(icon, 14)}</${tag}>`;
function accountItems(): MenuItem[] {
  const list: MenuItem[] = accounts.accounts.map(a => ({
    label: a.name, key: a.provider, checked: () => accountKey(a) === accounts.active, run: () => background(switchAccount(a)),
    remove: () => background(removeAccount(a)),
  }));
  return [...list, ...(list.length ? [{ sep: true }] : []), { label: 'Add account', run: addAccount }];
}
// Clicking your picture: who you are, your other accounts (in a submenu), Settings and signing out.
function openAccountMenu(anchor: HTMLElement): void {
  if (menuWasOpen(anchor)) {
    closeMenu();
    return;
  }
  closeMenu();
  anchor.classList.add('open');
  const r = anchor.getBoundingClientRect();
  const items: MenuItem[] = user
    ? [{ header: user }, { label: 'Accounts', sub: accountItems }, { sep: true }, { label: 'Settings', act: 'settings.open', key: 'Ctrl+,' }, { sep: true }, { label: 'Sign Out', run: () => background(signOut()) }]
    : [{ label: 'Sign in', run: addAccount }, ...(accounts.accounts.length ? [{ label: 'Accounts', sub: accountItems }] : [])];
  popupMenu(r.right, r.bottom + 6, items, () => anchor.classList.remove('open'), anchor);
  const m = $('#menuRoot .menu');
  if (m) {
    m.classList.add('account-menu');
    m.style.left = `${Math.max(8, r.right - m.offsetWidth)}px`;
  }
}
for (const id of ['#avatars', '#boxAvatar', '#homeProfile']) {
  $(id).onclick = e => {
    const anchor = e.currentTarget as HTMLElement;
    if (anchor.id === 'homeProfile' && !user) { closeMenu(); addAccount(); return; }
    if (menuWasOpen(anchor)) {
      closeMenu();
      return;
    }
    background(refreshAccounts().then(() => openAccountMenu(anchor)));
  };
}

/* ----- Sign in (GitHub device flow / Google loopback, handled in main.js) ----- */
// The onboarding step and the "Add account" dialog share this panel; signinRoot is the one in use.
const SIGNIN_PANEL = `<div class="signin-btns" data-si="choices">
    <button class="btn" data-signin="GitHub"><svg width="18" height="18"><use href="#i-gh"/></svg>Continue with GitHub</button>
    <button class="btn" data-signin="Google"><img src="../../assets/icons/google.png" width="18" height="18" alt="">Continue with Google</button>
    <p class="signin-error hidden" data-si="error" role="alert"></p>
  </div>
  <div class="waiting hidden" data-si="wait">
    <div class="spinner"></div><div data-si="msg">Waiting for your browser</div>
    <div class="device-code hidden" data-si="code"><span data-si="codeText"></span><button class="btn btn-sm" data-si="copy">Copy</button><button class="btn btn-sm" data-si="openPage">Open page</button></div>
    <button class="btn btn-sm" data-si="cancel">Cancel</button>
  </div>`;
const onboardSignin = $('#obSignin');
let signinRoot = onboardSignin;
const si = (part: string) => $(`[data-si="${part}"]`, signinRoot);
// The account screen is centred, so the sign-in panel changing height (buttons, waiting, device code, connected)
// jumped everything at once. The pieces glide to their new places instead, and whatever just appeared fades in.
let accountGliding = false;
function glideAccount(change: () => void): void {
  const screen = stepEl(STEP.signIn);
  if (accountGliding || signinRoot !== onboardSignin || screen.classList.contains('hidden') || $('#onboard').classList.contains('ob-flying') || motionOff() || reducedMotion()) { change(); return; }
  // The form is see-through, so moving its children is moving all of it; the panel's own parts only ever fade in.
  const shown = (sel: string) => [...screen.querySelectorAll<HTMLElement>(sel)].filter(e => e.getClientRects().length);
  const MOVERS = ':scope > .ob-icon, .ob-form > *', APPEARS = '#obSignin > *, #obSignin [data-si="code"], #obSignin [data-si="error"]';
  const tops = new Map(shown(MOVERS).map(e => [e, e.getBoundingClientRect().top]));
  const before = new Set(shown(APPEARS));
  accountGliding = true;
  try { change(); } finally { accountGliding = false; }
  for (const e of shown(MOVERS)) {
    const top = tops.get(e), dy = top === undefined ? 0 : top - e.getBoundingClientRect().top;
    if (top === undefined) e.animate([{ opacity: 0, transform: 'scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 360 * OB_PACE, easing: OB_SOFT });
    else if (Math.abs(dy) > 1) e.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 560 * OB_PACE, easing: OB_MOVE });
  }
  for (const e of shown(APPEARS)) if (!before.has(e)) e.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300 * OB_PACE, easing: OB_SOFT });
}
function signinView(waiting: boolean): void {
  const hadFocus = signinRoot.contains(document.activeElement); // the part that has it is about to hide
  glideAccount(() => {
    si('choices').classList.toggle('hidden', waiting);
    si('wait').classList.toggle('hidden', !waiting);
    if (waiting) { si('error').classList.add('hidden'); si('code').classList.add('hidden'); }
  });
  if (hadFocus) (waiting ? si('cancel') : $('[data-signin]', signinRoot)).focus();
}
function signinError(text: string): void {
  glideAccount(() => {
    signinView(false);
    si('error').textContent = text;
    si('error').classList.remove('hidden');
  });
}
async function startSignIn(provider: string): Promise<void> {
  signinView(true);
  si('msg').textContent = `Opening ${provider} in your browser`;
  const r = await api.auth.start(provider).catch((e: unknown) => ({ error: errMsg(e) }) as { error?: string });
  if (r.error === 'not-configured') {
    signinError(`Looks like ${provider} login isn't hooked up yet! Grab a Client ID, add it to .env (or breeze.config.json — there's an example config to help), and give Breeze a restart. Or, skip it for now and jump right in.`);
  } else if (r.error) signinError(r.error);
}
function bindSignin(root: HTMLElement): void {
  $$('[data-signin]', root).forEach(b => b.onclick = () => void startSignIn(b.dataset.signin ?? 'GitHub'));
  $('[data-si="cancel"]', root).onclick = () => { background(api.auth.cancel()); signinView(false); };
  $('[data-si="copy"]', root).onclick = () => background(navigator.clipboard.writeText(si('codeText').textContent ?? '').then(() => toast('Code copied')));
}
bindSignin(onboardSignin);
// Signed in, the account screen's buttons give way to who they're signed in as.
function renderConnected(): void {
  const row = $('#obConnected');
  const html = user ? `${avatarHtml(user, '')}<span class="ob-connected-txt"><span>Connected as <b>${esc(user.name)}</b></span><small>${esc(user.provider)}</small></span>` : '';
  if (row.classList.contains('hidden') === !user && row.innerHTML === html) return; // nothing changed: nothing to glide
  glideAccount(() => {
    $('#obSignin').classList.toggle('hidden', !!user);
    $('#obSkipLine').classList.toggle('hidden', !!user); // signed in, there's nothing to skip
    row.classList.toggle('hidden', !user);
    row.innerHTML = html;
  });
}
function syncAccountNext(): void { accountNext.disabled = !termsBox.checked; }
termsBox.onchange = syncAccountNext;
$$<HTMLAnchorElement>('.ob-terms a').forEach(a => a.onclick = e => { e.preventDefault(); background(api.sys.openExternal(a.href)); });
// Both ways on need the box ticked, with or without an account. Leaving mid sign-in drops that sign-in.
function leaveAccount(): void {
  if (!termsBox.checked) {
    termsBox.focus();
    if (!motionOff()) $('.ob-terms .check').animate([{ transform: 'none' }, { transform: 'scale(1.4)' }, { transform: 'none' }], { duration: 360, easing: OB_SOFT });
    return;
  }
  if (!si('wait').classList.contains('hidden')) { background(api.auth.cancel()); signinView(false); }
  appState.termsAcceptedAt ??= Date.now();
  goStep(STEP.tools);
}
$('#signinSkip').onclick = leaveAccount;
accountNext.onclick = leaveAccount;
function addAccount(): void {
  const intro = user
    ? '<h3>Add an account</h3><p class="sub">Sign in with another GitHub or Google account. Switch between accounts from your picture in the title bar.</p>'
    : `<h3>Sign in to Breeze</h3><p class="sub">Your browser opens to finish signing in, then you're back here.</p>`;
  openModal(`${intro}<div class="signin-modal">${SIGNIN_PANEL}</div>`, m => {
    signinRoot = $('.signin-modal', m);
    bindSignin(signinRoot);
  }, () => {
    if (!si('wait').classList.contains('hidden')) background(api.auth.cancel());
    signinRoot = onboardSignin;
  });
}
api.auth.onEvent(ev => {
  if (ev.t === 'code') {
    glideAccount(() => {
      si('msg').textContent = 'Code copied. Paste it on the GitHub page that just opened:';
      si('codeText').textContent = ev.code ?? '';
      si('code').classList.remove('hidden');
    });
    si('openPage').onclick = () => background(api.sys.openExternal(ev.uri ?? 'https://github.com/login/device'));
  } else if (ev.t === 'waiting') {
    si('msg').textContent = `Finish signing in with ${ev.provider} in your browser`;
  } else if (ev.t === 'done' && ev.user) {
    setUser(ev.user);
    signinView(false);
    background(refreshAccounts());
    // On the account screen the row that replaces the buttons says it; the box to tick is what's next.
    if (signinRoot === onboardSignin) { if (!appState.onboarded && step === STEP.signIn) termsBox.focus(); }
    else { toast(`Signed in as ${ev.user.name}`); closeModal(); }
  } else if (ev.t === 'error') signinError(ev.text ?? 'Sign-in failed');
});


// Hover icons (breeze.css, .icon-live): the loop runs while the pointer is on the button; leaving eases the icon back
// from its current pose, since dropping a CSS animation snaps it home.
const ICON_HOVER = '#onboard .recent-open, #onboard .btn, #homeProfile, #rescan';
document.addEventListener('pointerover', e => (e.target as Element).closest?.(ICON_HOVER)?.classList.add('icon-live'));
document.addEventListener('pointerout', e => {
  const b = (e.target as Element).closest?.(ICON_HOVER);
  if (!b?.classList.contains('icon-live') || b.contains(e.relatedTarget as Node | null)) return;
  const svg = b.querySelector('svg');
  const pose = svg ? getComputedStyle(svg).transform : 'none';
  b.classList.remove('icon-live');
  if (svg && pose !== 'none') svg.animate([{ transform: pose }, { transform: 'none' }], { duration: 480, easing: SPRING });
});
