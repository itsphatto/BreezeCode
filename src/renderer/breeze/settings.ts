/* ================= Settings ================= */
// One pop-up for everything: the gear opens it (in the IDE and in Breeze Space) and turns while it is open.
type SettingsTab = 'general' | 'appearance' | 'controls' | 'agents' | 'misc' | 'discord' | 'friends' | 'help' | 'dev';
// The controller Discord puts beside a game's elapsed time (Lucide's gamepad-2), for the Discord tab's preview.
// The same language art main.js hands Discord, so the preview shows what friends see.
const DC_ICON_URL = 'https://raw.githubusercontent.com/leonardssh/vscord/main/assets/icons/';
const DC_PAD = '<svg class="dc-pad" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 11h4M8 9v4M15 12h.01M18 10h.01"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59l-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258l-.017-.151A4 4 0 0 0 17.32 5z"/></svg>';
const SETTINGS_TABS: [SettingsTab, string, string][] = [
  ['general', 'General', 'gear'],
  ['appearance', 'Appearance', 'palette'],
  ['controls', 'Controls', 'keyboard'],
  ['agents', 'Agents', 'terminal'],
  ['discord', 'Discord', 'discord'],
  ['friends', 'Friends', 'users'],
  ['help', 'Help & About', 'info'],
  ['misc', 'Miscellaneous', 'more'],
  ['dev', 'Developer', 'code'],
];
// Developer stays out of the list until its code is entered under Miscellaneous.
const DEV_CODE = 'developermode';
const visibleSettingsTabs = () => SETTINGS_TABS.filter(([id]) => id !== 'dev' || appState.devMode);
// Developer mode shows on the app icon and the Discord logo.
function applyDevMode(): void {
  background(api.win.devIcon(appState.devMode));
  queueDiscord();
}
// Agents the user has come first, then this order; anything else keeps its place after.
const AGENT_ORDER = ['claude', 'codex', 'antigravity', 'ollama'];
const agentRank = (a: DetectedAgent) => (a.found ? 0 : 100) + (AGENT_ORDER.indexOf(a.id) + 1 || AGENT_ORDER.length + 1);
let settingsTab: SettingsTab = 'general';
let agentFullAccess = false; // the main process keeps the real value; read each time Settings opens
let justSwitched = false;
const settingsRoot = () => document.querySelector<HTMLElement>('#modalRoot .scrim:not(.closing) .settings-modal');
// The on/off switch (styles under "on/off switch" in breeze.css): a rounded track and a square knob that stretches as it slides.
const switchHtml = (id: string, on: boolean, label: string) =>
  `<button class="switch ${on ? 'on' : ''}" id="${id}" role="switch" aria-checked="${on}" aria-label="${escAttr(label)}"><span class="sw-knob"></span></button>`;

// Liquid switch (breeze.css "liquid switch"): the parts that make the glass knob and the goo, put into every
// .switch as it appears. Developer → Classic switches keeps the plain track and square knob instead.
const LIQUID_PARTS = '<div class="knockout"><div class="indicator indicator--masked"><div class="mask"></div></div></div>'
  + '<div class="indicator__liquid"><div class="shadow"></div><div class="wrapper"><div class="liquids"><div class="liquid__shadow"></div><div class="liquid__track"></div></div></div><div class="cover"></div></div>';
let classicSwitch = store.get<boolean>('breeze.classicSwitch', false) === true;
function liquidSwitch(el: HTMLElement): void {
  const liquid = !classicSwitch;
  if (el.classList.contains('liquid-toggle') === liquid) return;
  el.classList.toggle('liquid-toggle', liquid);
  if (liquid) el.insertAdjacentHTML('beforeend', LIQUID_PARTS);
  else el.querySelectorAll(':scope > .knockout, :scope > .indicator__liquid').forEach(p => p.remove());
}
function setClassicSwitch(on: boolean): void {
  classicSwitch = on;
  store.set('breeze.classicSwitch', on);
  document.querySelectorAll<HTMLElement>('button.switch').forEach(liquidSwitch);
}
document.querySelectorAll<HTMLElement>('button.switch').forEach(liquidSwitch);
new MutationObserver(recs => {
  for (const r of recs) for (const n of r.addedNodes) {
    if (!(n instanceof HTMLElement)) continue;
    if (n.matches('button.switch')) liquidSwitch(n);
    n.querySelectorAll<HTMLElement>('button.switch').forEach(liquidSwitch);
  }
}).observe(document.body, { childList: true, subtree: true });

const switchSettle = new WeakMap<HTMLElement, number>();
function settleSwitch(el: HTMLElement, ms: number): void {
  clearTimeout(switchSettle.get(el));
  switchSettle.set(el, window.setTimeout(() => {
    delete el.dataset.active; delete el.dataset.pressed; delete el.dataset.dropped;
    el.style.removeProperty('--delta');
  }, ms));
}

// Tap a switch to flip it, or drag the knob: it follows the pointer and lands on the nearer side.
// A drag that ends on the side it started from swallows the click, so it changes nothing.
// A liquid switch keeps its bubble up until the slide is done, then lets it settle back into the knob.
(() => {
  let drag: { el: HTMLButtonElement; x0: number; lastX: number; from: number; moved: boolean } | null = null;
  let swallow: HTMLElement | null = null;
  const end = (e: PointerEvent) => {
    if (!drag) return;
    const { el, from, moved } = drag;
    drag = null;
    delete el.dataset.dragging;
    if (!el.classList.contains('liquid-toggle')) delete el.dataset.active;
    el.style.removeProperty('--delta');
    if (!moved) { if (el.classList.contains('liquid-toggle')) settleSwitch(el, 200); return; }
    const at = Number.parseFloat(el.style.getPropertyValue('--complete')) || 0;
    if (el.classList.contains('liquid-toggle')) { el.dataset.dropped = 'true'; settleSwitch(el, 100); }
    el.style.removeProperty('--complete');   // eases from where the knob was let go
    if ((at >= 50) === (from === 100) || e.type === 'pointercancel') swallow = el;
  };
  document.addEventListener('pointerdown', e => {
    const el = (e.target as HTMLElement).closest<HTMLButtonElement>('button.switch');
    if (!el || el.disabled || e.button !== 0) return;
    drag = { el, x0: e.clientX, lastX: e.clientX, from: el.classList.contains('on') ? 100 : 0, moved: false };
    clearTimeout(switchSettle.get(el));
    delete el.dataset.dropped;
    el.dataset.active = 'true';
    if (el.classList.contains('liquid-toggle')) el.dataset.pressed = 'true';
    el.setPointerCapture(e.pointerId);
  });
  // Keys flip a liquid switch with the same bubble a tap gets.
  document.addEventListener('keydown', e => {
    const el = e.target instanceof HTMLElement ? e.target.closest<HTMLButtonElement>('button.switch.liquid-toggle') : null;
    if (!el || el.disabled || (e.key !== 'Enter' && e.key !== ' ')) return;
    el.dataset.active = 'true'; el.dataset.pressed = 'true';
    settleSwitch(el, 200);
  });
  document.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    if (drag.el.classList.contains('liquid-toggle')) drag.el.style.setProperty('--delta', String(Math.min(Math.abs(e.clientX - drag.lastX), 12)));
    drag.lastX = e.clientX;
    if (!drag.moved && Math.abs(dx) < 3) return;
    drag.moved = true;
    drag.el.dataset.dragging = 'true';
    // The knob travels the switch's width less its height (one knob plus the padding on both sides).
    // A liquid switch is zoomed, so measure it as drawn; its knob is 60% of the width and swells as it's held.
    const box = drag.el.getBoundingClientRect();
    const travel = Math.max(1, drag.el.classList.contains('liquid-toggle') ? box.width * .5 : drag.el.clientWidth - drag.el.clientHeight);
    drag.el.style.setProperty('--complete', String(clamp(drag.from + dx / travel * 100, 0, 100)));
  });
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
  document.addEventListener('click', e => {
    if (!swallow) return;
    if ((e.target as HTMLElement).closest('button.switch') === swallow) { e.stopPropagation(); e.preventDefault(); }
    swallow = null;
  }, true);
})();
const settingRow = (title: string, sub: string, control: string) =>
  `<div class="set-row"><div class="set-text"><div class="set-title">${title}</div>${sub ? `<div class="set-sub">${sub}</div>` : ''}</div><div class="set-ctl">${control}</div></div>`;
const segHtml = (id: string, opts: [string, string][], cur: string) =>
  `<div class="seg set-seg" id="${id}">${opts.map(([v, l]) => `<button data-v="${v}" class="${v === cur ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>`;
//change from "Active" to "Developer"
const DEVELOPER_EMAILS = new Set(['lovephatto@gmail.com', 'itsphatto@icloud.com', 'yell0wcircle12345@gmail.com']);
const TESTERS_EMAILS = new Set([''])

// Settings → Appearance. Each card shows a small picture of the window in that theme.
// The fourth field marks a description written as a (tongue-in-cheek) warning: it shows in red.
const THEMES: [Theme, string, string, boolean?][] = [
  ['dark', 'Default Dark', 'Soft charcoal.'],
  ['contrast', 'High Contrast Dark', 'True black, sharper edges.'],
  ['light', 'Light', '', true], // its line comes from LIGHT_JOKES
];
// Light's warning is a different joke each visit to Appearance (picking a theme keeps it):
// 40 film and cartoon characters × 25 reactions = 1000.
const LIGHT_WHO = ['Dracula', 'Darth Vader', 'Batman', 'Gollum', 'Gandalf', 'Shrek', 'Wednesday Addams', 'Edward Cullen',
  'Maleficent', 'Voldemort', 'Sauron', 'The Grinch', 'Squidward', 'Garfield', 'Scooby-Doo', 'Nemo', 'Buzz Lightyear', 'Elsa',
  'Kylo Ren', 'Yoda', 'Neo', 'The Predator', 'Jack Skellington', 'Stitch', 'Megamind', 'Gru', 'Kevin the Minion', 'Pikachu',
  'Homer Simpson', 'Bugs Bunny', 'Wile E. Coyote', 'SpongeBob', 'Plankton', 'Shaggy', 'Mr. Burns', 'Simba', 'Scar', 'WALL-E',
  'Olaf', 'Toothless', '@itsphatto'];
const LIGHT_WHAT = ['just squinted at this.', 'asked for sunglasses.', 'went back to the dark side.', 'filed a glare complaint.',
  'thinks this is a jump scare.', 'lost a staring contest to it.', 'says the bugs love it.', 'refuses to code in this.',
  'turned it off in two seconds.', 'needs a nap after one look.', 'now codes in a cave.', 'would rather face a dragon.',
  'says even the moths showed up.', 'packed sunscreen for this.', 'thinks the screen is on fire.', 'got a tan from the editor.',
  'approves, blindfolded.', 'just saw every bug at once.', 'calls this a flashbang.', 'is still seeing spots.',
  'booked an eye exam.', 'says bugs come for the light.', 'only uses it at high noon.', 'hissed at the screen.',
  'asked who turned the sun on.'];
  
const LIGHT_JOKES = LIGHT_WHO.flatMap(who => LIGHT_WHAT.map(what => `${who} ${what}`));

let lightJoke = '';
const themeCardHtml = ([id, name, sub, warn]: [Theme, string, string, boolean?]) =>
  `<button class="set-theme ${id === theme ? 'on' : ''}" data-theme-pick="${id}" aria-pressed="${id === theme}">
    <span class="theme-swatch" data-swatch="${id}" aria-hidden="true"><span class="sw-bar"><i></i><i></i><i></i></span><span class="sw-side"><b></b><b></b><b></b></span><span class="sw-main"><b></b><b></b><b></b><b></b></span></span>
    <span class="nm">${esc(name)}</span><span class="set-sub${warn ? ' set-warn' : ''}">${esc(id === 'light' ? (lightJoke ||= pickOther(LIGHT_JOKES, '')) : sub)}</span></button>`;
// While a new theme paints in, the cards (and the note under them) show as shimmering placeholders for a beat,
// then the real ones rise back in, drawn in the new colours.
function setTheme(t: Theme): void {
  if (t === theme) return;
  theme = t;
  store.set('breeze.theme', t);
  // A view transition cross-fades a snapshot of the window, so it costs the same however big the editor is
  // (easing every element's colours made big files lag behind the click).
  const apply = () => { document.documentElement.dataset.theme = t; applySyntax(); }; // a preset has a light and a dark version
  if (document.startViewTransition) document.startViewTransition(apply);
  else apply();
  background(api.win.theme(t));
}

/* ----- Syntax colours: five presets or three colours of your own. -----
   Code is coloured by the tk-* classes (breeze.css), which read --syn-kw (keywords, tags, attributes), --syn-str (strings)
   and --syn-num (numbers, properties) from :root. Set from script, since the page's CSP blocks inline style. With none
   set, every token keeps the theme's own colour. */
type SynTriple = [kw: string, str: string, num: string];
const SYN_DEFAULTS: { dark: SynTriple; light: SynTriple } = { dark: ['#f9a8d4', '#86efac', '#fdba74'], light: ['#be185d', '#137036', '#a8380a'] };
// Each preset has a version for the dark themes and a darker one for the light theme.
const SYN_PRESETS: { id: string; name: string; dark: SynTriple; light: SynTriple }[] = [
  { id: 'ocean', name: 'Ocean', dark: ['#7dd3fc', '#5eead4', '#a5b4fc'], light: ['#0369a1', '#0f766e', '#4338ca'] },
  { id: 'sunset', name: 'Sunset', dark: ['#fb7185', '#fcd34d', '#fb923c'], light: ['#be123c', '#a16207', '#c2410c'] },
  { id: 'forest', name: 'Forest', dark: ['#86efac', '#bef264', '#6ee7b7'], light: ['#15803d', '#4d7c0f', '#047857'] },
  { id: 'lavender', name: 'Lavender', dark: ['#c4b5fd', '#f0abfc', '#93c5fd'], light: ['#6d28d9', '#a21caf', '#1d4ed8'] },
  { id: 'mono', name: 'High contrast', dark: ['#ffffff', '#fde68a', '#67e8f9'], light: ['#000000', '#854d0e', '#155e75'] },
];
const SYN_SLOTS = [['sSynKw', 'Keywords', '--syn-kw'], ['sSynStr', 'Strings', '--syn-str'], ['sSynNum', 'Numbers', '--syn-num']] as const;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const savedSynCustom = store.get<unknown>('breeze.synCustom', null);
// A saved choice is checked on the way in: a custom triple must be three #rrggbb colours, a preset must still exist.
let synCustom: SynTriple | null = Array.isArray(savedSynCustom) && savedSynCustom.length === 3 && savedSynCustom.every(c => typeof c === 'string' && HEX_COLOR.test(c)) ? savedSynCustom as SynTriple : null;
const savedSynPreset = store.get<string>('breeze.synPreset', 'default');
let synPreset = SYN_PRESETS.some(p => p.id === savedSynPreset) ? savedSynPreset : 'default';
const themeKey = (): 'dark' | 'light' => (theme === 'light' ? 'light' : 'dark');
// The colours in use right now, or null for the theme's own.
function synColors(): SynTriple | null {
  if (synCustom) return synCustom;
  return SYN_PRESETS.find(p => p.id === synPreset)?.[themeKey()] ?? null;
}
function applySyntax(): void {
  const root = document.documentElement.style, c = synColors();
  SYN_SLOTS.forEach(([, , v], i) => { if (c) root.setProperty(v, c[i]); else root.removeProperty(v); });
  mmColors.clear(); // the minimap draws in the same colours
  queueMinimap();
}
function saveSyntax(): void {
  store.set('breeze.synPreset', synPreset);
  store.set('breeze.synCustom', synCustom);
}
function pickSynPreset(id: string): void {
  synPreset = id;
  synCustom = null;
  saveSyntax();
  applySyntax();
}
applySyntax();
const synChipHtml = (id: string, name: string, pressed: boolean) =>
  `<button class="set-syn-chip" data-syn="${id}" aria-pressed="${pressed}"><span class="set-syn-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>${esc(name)}</span></button>`;
function syntaxSettingsHtml(): string {
  const cur = synColors() ?? SYN_DEFAULTS[themeKey()];
  const chips = [synChipHtml('default', 'Default', !synCustom && synPreset === 'default'), ...SYN_PRESETS.map(p => synChipHtml(p.id, p.name, !synCustom && synPreset === p.id))].join('');
  // Each colour is a button that opens the editor's own colour picker (colorpick.ts); its colour goes on from script.
  const picks = SYN_SLOTS.map(([id, label], i) => `<button class="set-syn-pick" id="${id}" aria-label="${label} colour, ${cur[i]}" aria-haspopup="dialog"><i class="set-syn-sw"></i><span>${label}</span><code>${cur[i]}</code></button>`).join('');
  return `<h5>Syntax colours</h5>
      <div class="set-syn" role="group" aria-label="Syntax colour presets">${chips}</div>
      <code class="set-syn-sample" aria-hidden="true"><span class="tk-com">// colours for your code</span>
<span class="tk-kw">const</span> greeting = <span class="tk-str">"Hello, Breeze"</span>;
<span class="tk-kw">return</span> greeting.<span class="tk-prop">length</span> + <span class="tk-num">42</span>;</code>
      <div class="set-syn-custom"><div class="set-title">Custom colours</div><div class="set-sub">Keywords, strings and numbers. Picking one overrides the preset.</div>
        <div class="set-syn-picks">${picks}<button class="btn btn-sm" id="sSynReset"${!synCustom && synPreset === 'default' ? ' disabled' : ''}>Reset</button></div></div>`;
}
// Paints the dots on the chips (colours go on from script) in the theme in use.
function paintSynDots(pane: HTMLElement): void {
  $$<HTMLElement>('[data-syn]', pane).forEach(chip => {
    const c = chip.dataset.syn === 'default' ? SYN_DEFAULTS[themeKey()] : SYN_PRESETS.find(p => p.id === chip.dataset.syn)?.[themeKey()];
    chip.querySelectorAll<HTMLElement>('i').forEach((dot, i) => c && dot.style.setProperty('--c', c[i]));
  });
}
// The colours the custom swatches last showed, so a redraw can morph from them to the new ones.
let synShown: SynTriple | null = null;
const SYN_SAMPLE_SLOT: Record<string, number> = { 'tk-kw': 0, 'tk-str': 1, 'tk-num': 2, 'tk-prop': 2 };
function bindSyntaxSettings(pane: HTMLElement): void {
  if (!pane.querySelector('.set-syn')) return;
  paintSynDots(pane);
  // A new preset: the selected chip's highlight glides over to it (like the theme cards), and the colours morph.
  const pick = (id: string) => {
    const from = pane.querySelector('[data-syn][aria-pressed="true"]')?.getBoundingClientRect();
    pickSynPreset(id);
    refreshSettings();
    slideSelected(pane.querySelector<HTMLElement>(`[data-syn="${CSS.escape(id)}"]`), from);
  };
  $$<HTMLElement>('[data-syn]', pane).forEach(b => b.onclick = () => pick(b.dataset.syn ?? 'default'));
  const buttons = SYN_SLOTS.map(([id]) => $<HTMLButtonElement>(`#${id}`, pane));
  const current = (): SynTriple => synColors() ?? SYN_DEFAULTS[themeKey()];
  // morph: each swatch eases from its old colour, its code blurs in, and the sample's tokens fade over. Off while
  // the picker is dragged (that repaints every move).
  const showSlots = (morph: boolean) => {
    const was = synShown, now = current();
    const ease = { duration: 320, easing: 'cubic-bezier(.2, .8, .2, 1)' };
    buttons.forEach((b, i) => {
      const sw = $('.set-syn-sw', b), code = $('code', b);
      sw.style.setProperty('--c', now[i]);
      code.textContent = now[i];
      b.setAttribute('aria-label', `${SYN_SLOTS[i][1]} colour, ${now[i]}`);
      if (!morph || !was || was[i] === now[i]) return;
      sw.animate([{ backgroundColor: was[i], transform: 'scale(.7)' }, { backgroundColor: now[i], transform: 'none' }], ease);
      code.animate([{ opacity: 0, filter: 'blur(2px)', transform: 'translateY(2px)' }, { opacity: 1, filter: 'blur(0)', transform: 'none' }], ease);
    });
    if (morph && was) $$<HTMLElement>('.set-syn-sample span', pane).forEach(s => {
      const slot = SYN_SAMPLE_SLOT[s.className];
      if (slot != null && was[slot] !== now[slot]) s.animate([{ color: was[slot] }, { color: now[slot] }], ease);
    });
    synShown = [...now];
  };
  showSlots(true);
  // The same picker as the editor's colour swatches, without its opacity bar. Dragging repaints the code as it goes
  // (no redraw of the pane, which would close the picker); the choice is kept as the custom colours.
  buttons.forEach((btn, i) => btn.onclick = () => !pickerWasOpen(btn) && showColorPicker(current()[i], btn.getBoundingClientRect(), {
    alpha: false,
    from: btn,
    live(next) {
      const colors = [...current()] as SynTriple;
      colors[i] = next.toLowerCase();
      synCustom = colors;
      synPreset = 'custom';
      saveSyntax();
      applySyntax();
      showSlots(false);
      $$('[data-syn]', pane).forEach(chip => chip.setAttribute('aria-pressed', 'false'));
      $<HTMLButtonElement>('#sSynReset', pane).disabled = false;
      return true;
    },
    commit() { /* every change is already kept */ },
  }));
  $('#sSynReset', pane).onclick = () => pick('default');
}

/* ----- Backdrops: Glass and a Custom background sit behind the chosen theme, beside and under its cards. -----
   data-backdrop on <html> makes the theme's surfaces see-through (breeze.css). Glass lets the system blur the desktop
   behind the window (main.ts win:glass); a picture is drawn full-window behind the surfaces at --bd-o opacity. */
type Backdrop = 'none' | 'glass' | 'image';
const BACKDROPS: [Exclude<Backdrop, 'none'>, string, string][] = [
  ['image', 'Custom background', 'Your own picture.'],
];
const BG_OPACITY_MIN = 10, BG_OPACITY_MAX = 100, BG_OPACITY_DEFAULT = 40;
const savedBackdrop = store.get<string>('breeze.backdrop', 'none');
const savedBgImage = store.get<unknown>('breeze.bgImage', null) as { url?: unknown; name?: unknown } | null;
// A saved picture is checked on the way in: a file or data URL and a name.
let bgImage: { url: string; name: string } | null = savedBgImage && typeof savedBgImage.url === 'string' && /^(file:|data:image\/)/.test(savedBgImage.url) && typeof savedBgImage.name === 'string'
  ? { url: savedBgImage.url, name: savedBgImage.name } : null;
let backdrop: Backdrop = savedBackdrop === 'glass' || (savedBackdrop === 'image' && bgImage) ? savedBackdrop : 'none';
let bgOpacity = clamp(Math.round(Number(store.get<number>('breeze.bgOpacity', BG_OPACITY_DEFAULT)) || BG_OPACITY_DEFAULT), BG_OPACITY_MIN, BG_OPACITY_MAX);
const BG_BLUR_MAX = 40;
let bgBlur = clamp(Math.round(Number(store.get<number>('breeze.bgBlur', 0)) || 0), 0, BG_BLUR_MAX);
let bgSize = ''; // "1920 × 1080" once the picture has loaded
// The picture, its opacity and its blur (px) as the CSS variables the backdrop layer reads; none without a picture on.
function applyBackdropLook(): void {
  const root = document.documentElement.style;
  if (backdrop === 'image' && bgImage) {
    root.setProperty('--bd-img', `url("${bgImage.url.replace(/"/g, '%22')}")`);
    root.setProperty('--bd-o', String(bgOpacity / 100));
    root.setProperty('--bd-blur', `${bgBlur}px`);
  } else {
    for (const v of ['--bd-img', '--bd-o', '--bd-blur']) root.removeProperty(v);
  }
}
// Turning a backdrop on or off fades the window's background, not the panels or dialogs over it: a sheet in the theme's
// own colour (breeze.css body.bd-fade::before) lies behind the see-through surfaces and fades away once the window
// has gone see-through, or fades in before they go solid again.
let bdSeq = 0;
let bdSheet: Animation | null = null;
function bdFade(to: 0 | 1, ms: number): Promise<boolean> {
  const body = document.body;
  const from = body.classList.contains('bd-fade') ? Number(getComputedStyle(body, '::before').opacity) : 1 - to;
  bdSheet?.cancel();
  body.classList.add('bd-fade');
  const a = bdSheet = body.animate([{ opacity: from }, { opacity: to }], { duration: ms * Math.abs(to - from), easing: 'ease', pseudoElement: '::before', fill: 'forwards' });
  return a.finished.then(() => true, () => false);
}
function bdFadeDone(): void {
  bdSheet?.cancel();
  bdSheet = null;
  document.body.classList.remove('bd-fade');
}
function applyBackdrop(fade = false): void {
  const root = document.documentElement, seq = ++bdSeq, on = backdrop !== 'none';
  const show = () => {
    if (on) root.dataset.backdrop = backdrop; else delete root.dataset.backdrop;
    applyBackdropLook();
    startGlassTune();
  };
  // The window itself goes see-through for Glass only. If this system can't, Glass switches back off.
  const glass = () => api.win.glass(backdrop === 'glass').then(ok => {
    if (ok || backdrop !== 'glass') return;
    setBackdrop('none');
    toast('Glass isn’t available on this system');
    refreshSettings();
  }).catch(() => undefined);
  if (!fade) { show(); void glass().then(tuneGlass); return; }
  if (on) {
    // The sheet goes up at once and stays until the window is see-through (on Windows 10 that takes a moment).
    if (!document.body.classList.contains('bd-fade')) { bdSheet?.cancel(); document.body.classList.add('bd-fade'); }
    show();
    void glass().then(() => seq === bdSeq && bdFade(0, 450)).then(done => { if (done && seq === bdSeq) { bdFadeDone(); void tuneGlass(); } });
  } else {
    void bdFade(1, 260).then(done => {
      if (!done || seq !== bdSeq) return;
      show();
      void glass();
      bdFadeDone();
    });
  }
}
function setBackdrop(next: Backdrop): void {
  const fade = (backdrop === 'none') !== (next === 'none');
  backdrop = next;
  store.set('breeze.backdrop', next);
  applyBackdrop(fade);
}
/* ----- Glass stays readable over whatever is behind the window -----
   A dark theme's light text is lost over a white window, and the light theme's dark ink over a dark one. So while
   Glass is on, the page reads how bright the screen is at a grid of points of the window (from a small picture of
   the display, five frames a second, that never leaves this page), takes away what the page itself paints there
   (each element's background colour, stacked) to get the brightness of what's behind, and makes every surface just
   solid enough (--bd-a) that secondary text keeps about 4.5:1 over the brightest (light theme: darkest) spot. Over a
   backdrop that already reads well, Glass is as see-through as ever.
   The share depends only on what is behind the window, never on which page is showing, so the editor, the debugger,
   Home and Breeze Space always wear the same Glass: the title-bar and status-bar rows count as one layer thick, the
   rows between as two (a panel on the window's base layer), whatever is really there. Breeze Space's one deep-space
   layer stands in for both of those, so it gets a share of its own (--bd-box) worth the two. */
const GLASS_RANGE = { dark: [.34, .86], light: [.52, .9] } as const; // the least is breeze.css's own --bd-a for Glass
const GLASS_TARGET = { dark: 62, light: 197 }; // the surface brightness (0–255) that --text-2 reads on at 4.5:1
const GLASS_LEFT_MIN = .05; // a spot showing less than this much of the backdrop can't be read: its last value stands
const GLASS_COLS = 8, GLASS_ROWS = 6, GLASS_EASE_MS = 200;
let glassA = clamp(Number(store.get<number>('breeze.glassA', 0)) || 0, 0, .9); // the shares last used, kept for the next launch
let glassBox = clamp(Number(store.get<number>('breeze.glassBox', 0)) || 0, 0, .9);
const glassSeen: (number | undefined)[] = []; // the brightness behind each point, when last it could be told
let glassLast: number[] = []; // the screen's brightness at each point at the last reading worked through
let glassTimer = 0, glassStep = 0, glassEaseEnd = 0;
// A CSS colour as [brightness 0–255, opacity]. Brightness is the usual weighted sum, on the colour's own (encoded)
// values: the page blends its layers on those too, so the sum of a stack is the stack of the sums.
function colorLuma(c: string): [number, number] | null {
  const luma = (r: number, g: number, b: number) => .2126 * r + .7152 * g + .0722 * b;
  const rgb = /^rgba?\(([^)]+)\)$/.exec(c);
  if (rgb) { const [r, g, b, a = 1] = rgb[1].split(/[,\s/]+/).map(Number); return [luma(r, g, b), a]; }
  const srgb = /^color\(srgb ([^)]+)\)$/.exec(c);
  if (srgb) { const [r, g, b, a = 1] = srgb[1].split(/[\s/]+/).filter(Boolean).map(Number); return [255 * luma(r, g, b), a]; }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (hex) { const h = hex[1].length === 3 ? hex[1].replace(/./g, '$&$&') : hex[1]; return [luma(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4), 16)), 1]; }
  return null;
}
// What the page paints at a point: its colours' brightness, stacked (`own`), and how much of the backdrop still shows
// (`left`). null where something draws its own picture (a preview, an image), which says nothing about the backdrop.
// Breeze Space's two nebulae, the one painted on top first: a background picture, which the colours below don't cover.
// The same numbers as breeze.css's `.box` gradients (centre, radii in px, colour, strength; each fades out at 70%).
const SPACE_GLOWS: { cx: number; cy: number; rx: number; ry: number; luma: number; a: number }[] = [
  { cx: .78, cy: .08, rx: 900, ry: 500, luma: .2126 * 120 + .7152 * 80 + .0722 * 220, a: .13 },
  { cx: .16, cy: .92, rx: 1000, ry: 620, luma: .7152 * 122 + .0722 * 255, a: .12 },
];
function glassStack(x: number, y: number): { own: number; left: number } | null {
  let own = 0, left = 1;
  for (const el of document.elementsFromPoint(x, y)) {
    if (el.matches('iframe, webview, img, video, canvas')) return null;
    if (el.id === 'box' && theme !== 'light') {
      const r = el.getBoundingClientRect();
      for (const g of SPACE_GLOWS) {
        const d = Math.hypot((x - r.left - g.cx * r.width) / g.rx, (y - r.top - g.cy * r.height) / g.ry) / .7;
        const a = d < 1 ? g.a * (1 - d) : 0;
        own += left * a * g.luma;
        left *= 1 - a;
      }
    }
    const col = colorLuma(getComputedStyle(el).backgroundColor);
    if (!col || !col[1]) continue;
    own += left * col[1] * col[0];
    left *= 1 - col[1];
    if (left < .005) break;
  }
  return { own, left };
}
// The shares in use: --bd-a (every surface) and --bd-box (Breeze Space's base layer), as fractions.
function glassNow(): { a: number; box: number } {
  const cs = getComputedStyle(document.documentElement), a = parseFloat(cs.getPropertyValue('--bd-a')) / 100;
  return { a, box: parseFloat(cs.getPropertyValue('--bd-box')) / 100 || a };
}
// Both shares eased to their new values (each step restyles the window, so it is short), or set at once.
function setGlassA(a: number, box: number, ease = true): void {
  const root = document.documentElement, from = glassNow();
  glassA = a;
  glassBox = box;
  store.set('breeze.glassA', a);
  store.set('breeze.glassBox', box);
  cancelAnimationFrame(glassStep);
  const put = (va: number, vb: number) => {
    root.style.setProperty('--bd-a', `${(va * 100).toFixed(1)}%`);
    root.style.setProperty('--bd-box', `${(vb * 100).toFixed(1)}%`);
  };
  if (!ease || motionOff() || !(from.a > 0)) { put(a, box); return; }
  const t0 = performance.now();
  glassEaseEnd = t0 + GLASS_EASE_MS;
  const step = (now: number) => {
    const p = clamp((now - t0) / GLASS_EASE_MS, 0, 1), e = 1 - (1 - p) ** 3; // a frame's time can be before t0
    put(from.a + (a - from.a) * e, from.box + (box - from.box) * e);
    if (p < 1) glassStep = requestAnimationFrame(step);
  };
  glassStep = requestAnimationFrame(step);
}
// The display the window is on, as a live picture at most 640px wide, five frames a second (reading one takes a few
// ms; asking main for a fresh screenshot each time held its other work up for 0.4s). Stopped whenever Glass is off
// or the window is hidden.
interface GlassCam { source: string; stream: MediaStream; video: HTMLVideoElement; ctx: OffscreenCanvasRenderingContext2D }
let glassCam: GlassCam | null = null;
let glassCamFails = 0; // after three it stops trying: this system won't give a picture
function stopGlassCam(): void {
  glassCam?.stream.getTracks().forEach(t => t.stop());
  glassCam = null;
}
// Where the window is on its display, with that display's picture showing a frame taken just now. null: not offered.
async function glassFrame(): Promise<{ cam: GlassCam; x: number; y: number; w: number; h: number } | null> {
  const at = glassCamFails < 3 ? await api.win.backdropWhere().catch(() => null) : null;
  if (!at) { stopGlassCam(); return null; }
  if (glassCam?.source !== at.source || glassCam.stream.getVideoTracks()[0]?.readyState !== 'live') {
    stopGlassCam();
    // Electron's own constraints for a screen; lib.dom doesn't know them.
    const video = { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: at.source, maxWidth: 640, maxHeight: 640, maxFrameRate: 5 } } as unknown as MediaTrackConstraints;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video }).catch(() => null);
    const el = document.createElement('video');
    el.muted = true;
    el.srcObject = stream;
    const playing = stream ? await el.play().then(() => true, () => false) : false;
    const ctx = playing && el.videoWidth ? new OffscreenCanvas(el.videoWidth, el.videoHeight).getContext('2d', { willReadFrequently: true }) : null;
    if (!stream || !ctx) { stream?.getTracks().forEach(t => t.stop()); glassCamFails++; return null; }
    glassCamFails = 0;
    if (backdrop !== 'glass') { stream.getTracks().forEach(t => t.stop()); return null; } // turned off while it started
    glassCam = { source: at.source, stream, video: el, ctx };
  }
  // The next frame, so the picture and what the page paints (read right after) are of the same moment.
  const cam = glassCam;
  await new Promise<void>(done => {
    const late = setTimeout(done, 400);
    cam.video.requestVideoFrameCallback(() => { clearTimeout(late); done(); });
  });
  return glassCam === cam ? { cam, ...at } : null;
}
// Glass just turned on, or off: the shares last used go on at once (before the first reading), or all of it comes off.
function startGlassTune(): void {
  clearTimeout(glassTimer);
  cancelAnimationFrame(glassStep);
  glassPending = null;
  glassLast = [];
  if (backdrop !== 'glass') {
    stopGlassCam();
    for (const v of ['--bd-a', '--bd-box']) document.documentElement.style.removeProperty(v);
    return;
  }
  const [min, max] = GLASS_RANGE[themeKey()];
  if (glassA) { const a = clamp(glassA, min, max); setGlassA(a, clamp(glassBox, a, max), false); }
  glassTimer = window.setTimeout(tuneGlass, 600);
}
// The page is mid-change: a screen swap, a dialog or panel fading or sliding, a view transition, or the shares easing.
// What it paints then isn't what its colours say (an element fading in counts as all there), so no reading is taken.
function glassPageMoving(): boolean {
  if (performance.now() < glassEaseEnd + 150 || document.querySelector('.screen-prep, .screen-out, .screen-in, .screen-soft-in')) return true;
  const big = innerWidth * innerHeight * .15;
  return document.getAnimations().some(an => {
    const fx = an.effect as KeyframeEffect | null, el = fx?.target;
    // Timed ones only: a scroll-linked animation (the lists' edge fades) is "running" for as long as its list exists.
    return an.playState === 'running' && an.timeline === document.timeline && el instanceof HTMLElement && el.offsetWidth * el.offsetHeight > big && fx?.getComputedTiming().iterations !== Infinity;
  });
}
// One reading, then the next, about four a second while the window shows. Most end at once: the screen at the points is
// as it was. A change is made only when the next reading agrees (so nothing passing counts), about half a second after
// the backdrop changed.
let glassBusy = false;
let glassPending: { a: number; box: number } | null = null; // what the last reading wanted, if it wanted a change
async function tuneGlass(): Promise<void> {
  if (glassBusy) return;
  clearTimeout(glassTimer);
  if (backdrop !== 'glass') return;
  glassBusy = true;
  let next = 250;
  try {
    const shown = document.visibilityState === 'visible' && !document.body.classList.contains('bd-fade');
    if (!shown) { stopGlassCam(); next = 1000; }
    // Only while this is the window in use: behind another one, the picture shows that window, not the backdrop.
    // Getting the focus back reads at once (the listener below).
    const front = shown && document.hasFocus();
    if (shown && !front) { glassPending = null; next = 1000; }
    const shot = front ? await glassFrame() : null;
    const cur = glassNow();
    if (!shot || backdrop !== 'glass' || !(cur.a > 0 && cur.a < 1)) { glassPending = null; if (front && !shot) next = 2000; return; }
    const { cam } = shot, W = cam.ctx.canvas.width, H = cam.ctx.canvas.height, R = 3;
    cam.ctx.drawImage(cam.video, 0, 0, W, H);
    const px = cam.ctx.getImageData(0, 0, W, H).data;
    const key = themeKey(), light = key === 'light', [min, max] = GLASS_RANGE[key], target = GLASS_TARGET[key];
    // The title bar and the status bar, and four rows between. At each point, the surface's own brightness in a patch
    // around it: text and icons are the brighter pixels on a dark theme (the darker on the light one), so the value a
    // fifth of the way up from the dark end (or down from the light one) is the surface without them. The middle
    // value let a label's pixels in, and where little of the backdrop shows a few levels of that read as a bright
    // backdrop. -1 where the window hangs off the display.
    const rows = [22 / innerHeight, .2, .4, .6, .8, 1 - 12 / innerHeight];
    const at = (i: number): [number, number] => [(i % GLASS_COLS + .5) / GLASS_COLS, rows[Math.floor(i / GLASS_COLS)]];
    const lum = Array.from({ length: GLASS_COLS * GLASS_ROWS }, (_, i) => {
      const [fx, fy] = at(i), cx = Math.round((shot.x + fx * shot.w) * W), cy = Math.round((shot.y + fy * shot.h) * H);
      if (cx < R || cy < R || cx >= W - R || cy >= H - R) return -1;
      const patch: number[] = [];
      for (let y = cy - R; y <= cy + R; y++) for (let x = cx - R; x <= cx + R; x++) { const k = (y * W + x) * 4; patch.push(.2126 * px[k] + .7152 * px[k + 1] + .0722 * px[k + 2]); }
      return patch.sort((p, q) => p - q)[Math.floor(patch.length * (light ? .8 : .2))];
    });
    if (!glassPending && lum.length === glassLast.length && lum.every((v, i) => Math.abs(v - glassLast[i]) <= 1.5)) return; // nothing moved
    if (glassPageMoving()) { glassPending = null; return; }
    const base = colorLuma(getComputedStyle(document.documentElement).getPropertyValue('--bd-solid'))?.[0] ?? (light ? 249 : 29);
    // How solid the most demanding spot has to be (`most`), and the share per layer that gets every spot there (`share`).
    let most = 0, share = 0;
    lum.forEach((m, i) => {
      const [fx, fy] = at(i), s = m < 0 ? null : glassStack(fx * innerWidth, fy * innerHeight);
      if (!s) return;
      const fresh = s.left >= GLASS_LEFT_MIN;
      if (fresh) glassSeen[i] = clamp((m - s.own) / s.left, 0, 255);
      const behind = glassSeen[i];
      if (behind === undefined) return;
      // Nothing where the backdrop already reads well (without that check, a backdrop darker than a dark theme's own
      // colour divides two negatives into "all solid").
      const short = light ? target - behind : behind - target;
      const cover = short > 0 ? clamp(short / Math.abs(behind - base), 0, max) : 0;
      // The layers really there (1.0: the bare title or status bar; more under a button or a panel). A bar's row is
      // one layer thick where it really is, everything else two.
      const layers = Math.log(Math.max(s.left, 1e-6)) / Math.log(1 - cur.a), row = Math.floor(i / GLASS_COLS);
      const thin = (row === 0 || row === GLASS_ROWS - 1) && layers < 1.5;
      const need = thin ? cover : 1 - Math.sqrt(1 - cover);
      // A value remembered from when the spot could be read (it can't now: too little of the backdrop shows) counts
      // only if the spot could be read again at the share it asks for. One that couldn't (a button on a bar, three
      // layers deep) would hold the window solid for good after a white window behind it had gone.
      if (!fresh && (1 - Math.max(need, min)) ** layers < GLASS_LEFT_MIN) return;
      most = Math.max(most, cover);
      share = Math.max(share, need);
    });
    // Small differences are left alone, so it doesn't shimmer with every pixel that changes behind.
    const off = (to: number, from: number, least: number) => Math.abs(to - from) >= .03 || (to === least && Math.abs(from - least) > .001);
    const wantA = clamp(share, min, max), a = off(wantA, cur.a, min) ? wantA : cur.a;
    const wantBox = clamp(most, a, max), box = off(wantBox, cur.box, a) ? wantBox : cur.box;
    // Settled (this reading wants nothing): the next ones are skipped until the screen at the points changes. A reading
    // that wants a change, or one dropped above, isn't noted, so it is worked through again.
    if (a === cur.a && box === cur.box) { glassPending = null; glassLast = lum; return; }
    if (glassPending && Math.abs(glassPending.a - a) < .08 && Math.abs(glassPending.box - box) < .08) {
      setGlassA(a, box);
      glassPending = null;
      glassLast = [];
      next = GLASS_EASE_MS + 250; // past the easing and a frame
    } else { glassPending = { a, box }; next = 100; }
  } finally {
    glassBusy = false;
    if (backdrop === 'glass') glassTimer = window.setTimeout(tuneGlass, next);
  }
}
for (const ev of ['resize', 'focus']) window.addEventListener(ev, () => { if (backdrop === 'glass' && !glassBusy) { clearTimeout(glassTimer); glassTimer = window.setTimeout(tuneGlass, 150); } });
document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') stopGlassCam(); });
if (backdrop !== 'none') applyBackdrop();
const backdropCardHtml = ([id, name, sub]: [Exclude<Backdrop, 'none'>, string, string]) =>
  `<button class="set-theme ${id === backdrop ? 'on' : ''}" data-backdrop-pick="${id}" aria-pressed="${id === backdrop}">
    <span class="theme-swatch" data-swatch="${id}" data-base="${theme}" aria-hidden="true"><span class="sw-bar"><i></i><i></i><i></i></span><span class="sw-side"><b></b><b></b><b></b></span><span class="sw-main"><b></b><b></b><b></b><b></b></span></span>
    <span class="nm">${esc(name)}</span><span class="set-sub">${esc(sub)}</span></button>`;
// The themes and Custom background side by side, with Glass and the picture's settings under them, all on one page.
function themePickerHtml(): string {
  const cards = THEMES.map(themeCardHtml).join('') + BACKDROPS.map(backdropCardHtml).join('');
  // Glass is a switch under the themes, not a card. It and a picture are alternatives: turning one on turns the other off.
  const glass = settingRow('Glass', 'See-through, frosted window. Windows 10, 11 and macOS.', switchHtml('sGlass', backdrop === 'glass', 'Glass'));
  // The picture's sliders go grey and still until Custom background is on (like Discord's options under its switch).
  const pictureOn = backdrop === 'image' && !!bgImage;
  const options = `<div class="set-bd">${glass}
      ${settingRow('Background picture', bgImage ? `${esc(bgImage.name)}${bgSize ? ` · ${bgSize}` : ''}` : 'Best at 1920 × 1080. Any picture fills the window.',
        `<span class="set-btns"><button class="btn btn-sm" id="sBgPick">${bgImage ? 'Change' : 'Choose'}</button>${bgImage ? '<button class="btn btn-sm" id="sBgClear">Remove</button>' : ''}</span>`)}
      <div class="set-dim ${pictureOn ? '' : 'off'}"${pictureOn ? '' : ' inert'}>
      ${settingRow('Picture opacity', 'How strongly the picture shows through.', `<div class="set-volume set-font-size"><input type="range" id="sBgOpacity" min="${BG_OPACITY_MIN}" max="${BG_OPACITY_MAX}" step="1" value="${bgOpacity}" aria-label="Picture opacity"${pictureOn ? '' : ' disabled'}><span class="set-volume-val" id="sBgOpacityVal">${bgOpacity}%</span></div>`)}
      ${settingRow('Picture blur', 'Softens the picture behind the panels.', `<div class="set-volume set-font-size"><input type="range" id="sBgBlur" min="0" max="${BG_BLUR_MAX}" step="1" value="${bgBlur}" aria-label="Picture blur"${pictureOn ? '' : ' disabled'}><span class="set-volume-val" id="sBgBlurVal">${bgBlur}px</span></div>`)}
      </div>
    </div>`;
  return `<div class="set-themes">${cards}</div>${options}`;
}
// The picture's size, read once it loads (shown under its name).
function measureBg(): void {
  if (!bgImage) { bgSize = ''; return; }
  const img = new Image(), url = bgImage.url;
  img.onload = () => { if (bgImage?.url === url) { bgSize = `${img.naturalWidth} × ${img.naturalHeight}`; refreshSettings(); } };
  img.onerror = () => { // the file is gone: forget it
    if (bgImage?.url !== url) return;
    bgImage = null; store.del('breeze.bgImage');
    if (backdrop === 'image') setBackdrop('none');
    refreshSettings();
  };
  img.src = url;
}
if (bgImage) measureBg();
function bindBackdropSettings(pane: HTMLElement): void {
  // Sets the picture and puts it on; a cancelled picker changes nothing.
  const choosePicture = async (): Promise<boolean> => {
    const pick = await api.win.pickBackdrop();
    if (!pick) return false;
    bgImage = pick; bgSize = '';
    store.set('breeze.bgImage', pick);
    setBackdrop('image');
    measureBg();
    return true;
  };
  $$<HTMLElement>('[data-backdrop-pick]', pane).forEach(b => b.onclick = () => {
    if (backdrop === 'image') { setBackdrop('none'); refreshSettings(); return; }
    // The first time, Custom background asks for the picture straight away.
    if (!bgImage) { background(choosePicture().then(ok => { if (ok) refreshSettings(); })); return; }
    setBackdrop('image');
    refreshSettings();
  });
  const glassSwitch = $('#sGlass', pane);
  if (glassSwitch) glassSwitch.onclick = () => { setBackdrop(backdrop === 'glass' ? 'none' : 'glass'); refreshSettings(); };
  $('#sBgPick', pane)?.addEventListener('click', () => background(choosePicture().then(ok => { if (ok) refreshSettings(); })));
  $('#sBgClear', pane)?.addEventListener('click', () => {
    bgImage = null; bgSize = '';
    store.del('breeze.bgImage');
    if (backdrop === 'image') setBackdrop('none');
    refreshSettings();
  });
  // The picture's opacity and blur follow their knobs live (no redraw of the pane, which would drop the drag).
  const bdSlider = (id: string, min: number, max: number, unit: string, get: () => number, set: (v: number) => void) => {
    const slider = $<HTMLInputElement>(`#${id}`, pane);
    if (!slider) return;
    const show = (v: number) => {
      set(clamp(Math.round(v), min, max));
      slider.value = String(get());
      slider.style.setProperty('--fill', `${(get() - min) / (max - min) * 100}%`);
      swapText($(`#${id}Val`, pane), `${get()}${unit}`);
      applyBackdropLook();
    };
    show(get());
    slider.oninput = () => show(+slider.value);
    slider.addEventListener('wheel', e => { e.preventDefault(); show(get() + (e.deltaY < 0 || e.deltaX > 0 ? 2 : -2)); }, { passive: false });
  };
  bdSlider('sBgOpacity', BG_OPACITY_MIN, BG_OPACITY_MAX, '%', () => bgOpacity, v => { bgOpacity = v; store.set('breeze.bgOpacity', v); });
  bdSlider('sBgBlur', 0, BG_BLUR_MAX, 'px', () => bgBlur, v => { bgBlur = v; store.set('breeze.bgBlur', v); });
  // The pictures on the Custom background card and the panel's swatch show the chosen picture.
  const sw = pane.querySelector<HTMLElement>('[data-swatch="image"]');
  if (sw) { if (bgImage) sw.style.setProperty('--sw-img', `url("${bgImage.url.replace(/"/g, '%22')}")`); else sw.style.removeProperty('--sw-img'); }
}

// The account card sits at the top of General.
function accountHtml(): string {
  const others = accounts.accounts.map(a => `<div class="set-row"><div class="set-text"><div class="set-title">${esc(a.name)}</div><div class="set-sub">${esc(a.email ?? a.provider)}</div></div>
      <div class="set-ctl set-acct-ctl">${accountKey(a) === accounts.active ? `<span class="pill ok set-active">${DEVELOPER_EMAILS.has(a.email?.toLowerCase() ?? '') ? 'Developer' : 'Active'}</span>` : `<button class="btn btn-sm" data-switch-acct="${escAttr(accountKey(a))}">Switch</button>`}</div></div>`).join('');
  // Signed in: name with its provider beside it, and the email used to sign in under it. Signed out: a Sign in button.
  const who = user
    ? `<div class="set-title set-user-name"><span class="set-user-display">${esc(user.name)}</span><span class="set-user-provider">${esc(user.provider)}</span></div><div class="set-sub">${esc(user.email ?? user.login ?? '')}</div>`
    : '<div class="set-title">Not signed in</div><div class="set-sub">Sign in to sync your name and picture.</div>';
  return `<div class="set-user">${avatarHtml(user, user?.name ?? 'Not signed in')}<div class="set-user-text">${who}</div>
      <div class="set-user-actions">${user ? '<button class="btn btn-sm btn-danger" id="sSignOut">Sign out</button>' : '<button class="btn btn-sm" id="sAddAcct">Sign in</button>'}</div></div>
    ${others ? `<h5>Accounts</h5>${others}` : ''}`;
}

// Settings → Agents → Usage. The last numbers fetched are kept, so a redraw shows them while fresh ones load.
let agentUsage: AgentUsage | null = null;
// When a window resets, written the way Claude's own usage page does: "11:00 PM" today, "Thu 8:00 PM" this week,
// a date after that.
const resetText = (sec: number) => {
  const at = new Date(sec * 1000), now = new Date();
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (at.toDateString() === now.toDateString()) return time;
  if (at.getTime() - now.getTime() < 6 * 86_400_000) return `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return at.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
function usageHtml(agents: DetectedAgent[]): string {
  if (!agentUsage) return '<p class="set-sub shimmer-text">Loading usage</p>';
  const u = agentUsage;
  return agents.map(a => {
    const wins = u.limits[a.id] ?? [];
    // Only Claude and Codex report their plan: Claude when asked (notes says why it couldn't be), Codex once it has
    // run since the last reset.
    const none = a.api ? 'No limit · runs on this computer'
      : u.notes[a.id] ?? (a.id in u.limits ? 'Plan limits show up after its next run' : `${a.name} doesn't share its limits`);
    // data-k names each part that can change, so a refresh updates it in place (see patchUsage).
    const plan = wins.length ? wins.map(w => {
      const left = Math.round(100 - w.used), k = `${a.id}:${w.label}`;
      return `<div class="usage-win"><span class="usage-lbl">${esc(w.label)}</span><span class="usage-bar ${left <= 10 ? 'low' : ''}" data-k="${escAttr(k)}:bar" data-left="${left}"><i></i></span><span class="usage-left"><span data-k="${escAttr(k)}:left" data-n="${left}">${left}</span>% left${w.resetsAt ? ` · <span data-k="${escAttr(k)}:reset">resets ${resetText(w.resetsAt)}</span>` : ''}</span></div>`;
    }).join('') : `<div class="set-sub" data-k="${a.id}:none">${esc(none)}</div>`;
    const tokens = u.usage[a.id] ?? 0;
    // Antigravity never reports its tokens, so a count would only ever say 0.
    const count = a.id === 'antigravity' ? ''
      : `<span class="usage-tokens" title="${tokens.toLocaleString()} tokens"><span data-k="${a.id}:tokens" data-n="${tokens}" data-fmt="tokens">${tokenCount.format(tokens)}</span> tokens this month</span>`;
    return `<div class="usage-agent"><div class="usage-head">${brandMark('usage-mark', a.id, a.name[0])}<span class="set-title">${esc(a.name)}</span>${count}</div>${plan}</div>`;
  }).join('');
}
// "959.5M": Claude's count includes the cached context it re-reads every turn, so it runs into the millions.
const tokenCount = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
// Bar widths are set from script: the page's CSP blocks inline style attributes.
const fillUsageBars = (root: ParentNode) => $$('.usage-bar', root).forEach(b => b.style.setProperty('--left', `${b.dataset.left ?? 0}%`));
// A changed number counts from its old value to the new one, easing in and out.
function countTo(el: HTMLElement, from: number, to: number): void {
  const show = (n: number) => { el.textContent = el.dataset.fmt === 'tokens' ? tokenCount.format(n) : String(n); };
  const t0 = performance.now(), ms = 700;
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / ms), e = t < .5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    show(Math.round(from + (to - from) * e));
    if (t < 1 && el.isConnected && el.dataset.n === String(to)) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
// Numbers that land while the page is already open come in like the rest of it: each agent rises in turn, its bars
// fill from empty and its numbers count up from zero.
function usageArrive(el: HTMLElement): void {
  $$('.usage-agent', el).forEach((a, i) => {
    a.style.setProperty('--i', String(i));
    a.classList.add('usage-in');
    // Dropped once it's in, so later refreshes slide the bars without the entrance delay.
    a.addEventListener('animationend', () => a.classList.remove('usage-in'), { once: true });
  });
  void el.offsetWidth; // lay the bars out empty first, so setting their width below slides them
  $$<HTMLElement>('[data-n]', el).forEach(n => countTo(n, 0, Number(n.dataset.n)));
  fillUsageBars(el);
}
// Same agents and windows as on screen: numbers count, bars slide (their width transitions) and other text rolls in.
// Anything else (an agent or a window came or went) is redrawn.
function patchUsage(el: HTMLElement, html: string): void {
  const fresh = document.createElement('div');
  fresh.innerHTML = html;
  const keys = (r: ParentNode) => $$('[data-k]', r).map(x => x.dataset.k).join('|');
  if (!el.childElementCount || keys(fresh) !== keys(el)) {
    const arriving = !el.querySelector('.usage-agent'); // it was showing "Loading usage"
    el.innerHTML = html;
    if (arriving) usageArrive(el); else fillUsageBars(el);
    return;
  }
  for (const n of $$('[data-k]', fresh)) {
    const o = el.querySelector<HTMLElement>(`[data-k="${CSS.escape(n.dataset.k ?? '')}"]`);
    if (!o) continue;
    if (n.dataset.n !== undefined) {
      if (n.dataset.n !== o.dataset.n) { const from = Number(o.dataset.n); o.dataset.n = n.dataset.n; countTo(o, from, Number(n.dataset.n)); }
      if (o.parentElement && n.parentElement?.title) o.parentElement.title = n.parentElement.title;
    } else if (o.classList.contains('usage-bar')) {
      o.className = n.className;
      o.dataset.left = n.dataset.left;
      o.style.setProperty('--left', `${n.dataset.left}%`);
    } else if (o.textContent !== n.textContent) {
      o.textContent = n.textContent;
      o.animate([{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }], { duration: 280, easing: 'cubic-bezier(.32, .72, 0, 1)' });
    }
  }
}
// Fetches fresh numbers (agents used outside Breeze count too) and updates only if something changed.
let usageShown = '';
let usageTick = 0;
const usageAgents = () => (appState.detect?.agents ?? []).filter(a => a.found).sort((a, b) => agentRank(a) - agentRank(b));
function updateUsage(el: HTMLElement): void {
  background(api.agent.usage().then(u => {
    agentUsage = u;
    const html = usageHtml(usageAgents());
    if (!el.isConnected || (html === usageShown && el.childElementCount)) return;
    usageShown = html;
    patchUsage(el, html);
  }));
}
window.addEventListener('focus', () => {
  const el = settingsRoot()?.querySelector<HTMLElement>('#sUsage');
  if (el) updateUsage(el);
});

function settingsBody(tab: SettingsTab): string {
  switch (tab) {
    case 'general': return `<h4>General</h4>
      ${accountHtml()}
      <h5>Preferences</h5>
      ${settingRow('Workspace', 'Full editor, or chat only.', segHtml('sMode', [['ide', 'Breeze Code'], ['box', 'Breeze Space']], appState.mode))}
      ${settingRow('Sound', 'Clicks, typing ticks and agent chimes.', `<div class="set-volume"><button class="set-volume-ico" id="sVolumeIco" title="Mute" aria-label="Mute">${svgIcon(volumeIcon(sfx.volume), 14)}</button><input type="range" id="sVolume" min="0" max="100" step="1" value="${sfx.volume}" aria-label="Sound volume"><span class="set-volume-val" id="sVolumeVal">${sfx.volume}%</span></div>`)}
      ${settingRow('Performance', powerNote(), segHtml('sPower', [['auto', 'Auto'], ['on', 'Always on'], ['off', 'Off']], powerInfo.mode))}
      <h5>Editor</h5>
      ${settingRow('Auto save', 'Off, a second after you stop typing, or when you switch tabs or windows.', segHtml('sAutoSave', [['off', 'Off'], ['delay', 'After delay'], ['focus', 'On focus change']], autoSave))}
      <h5>Layout</h5>
      ${settingRow('Side bar', esc(keyOf('view.toggleSide')), switchHtml('sSide', layout.sideOpen, 'Side bar'))}
      ${settingRow('Agents panel', esc(keyOf('view.toggleAgents')), switchHtml('sAgents', layout.agentsOpen, 'Agents panel'))}
      ${settingRow('Terminal', esc(keyOf('term.toggle')), switchHtml('sTerm', layout.termOpen, 'Terminal'))}
      ${settingRow('Preview', '', switchHtml('sPreview', layout.previewOpen, 'Preview'))}
      ${settingRow('Reset layout', 'Put every panel back where it started.', '<button class="btn btn-sm" id="sResetLayout">Reset</button>')}
      <h5>Explorer</h5>
      ${settingRow('Compiled JS files', 'Show a .js compiled from the .ts beside it in the file tree.', switchHtml('sGenerated', showGenerated, 'Compiled JS files'))}
      ${settingRow('File path on hover', 'Show a file\'s full path when you hover it in the file tree.', switchHtml('sPathTips', showPathTips, 'File path on hover'))}`;
    case 'appearance': return `<h4>Appearance</h4>
      <h5>Theme</h5>
      ${themePickerHtml()}
      <p class="set-sub"></p>
      ${syntaxSettingsHtml()}
      <h5>Text</h5>
      ${settingRow('Font size', 'Code in the editor and the debugger.', `<div class="set-volume set-font-size"><input type="range" id="sCodeSize" min="${CODE_SIZE_MIN}" max="${CODE_SIZE_MAX}" step="1" value="${codeSize}" aria-label="Code font size"><span class="set-volume-val" id="sCodeSizeVal">${codeSize}px</span></div>`)}
      <h5>Editor</h5>
      ${settingRow('Minimap', 'A zoomed-out view of the file beside the scrollbar. Click or drag it to scroll.', switchHtml('sMinimap', minimapOn, 'Minimap'))}`;
    case 'controls': return `<h4>Controls</h4>
      <h5>Keybinds</h5>
      <p class="set-sub">Click a shortcut, then press the new keys. Backspace removes it, Escape cancels.</p>
      <div class="kb-tools"><input class="input" id="kbSearch" aria-label="Search keybinds" placeholder="Search commands or keys" spellcheck="false" autocomplete="off"><button class="btn btn-sm" id="kbResetAll">Reset all</button></div>
      <div class="kb-list" id="kbList">${keyBindListHtml('')}</div>`;
    case 'agents': {
      const agents =[...appState.detect?.agents ?? []].sort((a, b) => agentRank(a) - agentRank(b));
      const list = agents.length
        ? agents.map(a => a.found
          ? `<button class="set-agent ${a.id === appState.agent ? 'on' : ''}" data-agent-pick="${a.id}" title="${escAttr(a.name)}">${brandMark('set-agent-mark', a.id, a.name[0])}<span class="nm">${esc(a.name)}</span></button>`
          // Not installed: the card stays, dimmed, with an Install button that runs the install command in a terminal.
          : `<div class="set-agent missing" title="${escAttr(a.name)} is not installed">${brandMark('set-agent-mark', a.id, a.name[0])}<span class="nm">${esc(a.name)}</span>
              <button class="btn btn-sm btn-primary set-agent-install" data-agent-install="${a.id}">Install</button></div>`).join('')
        : '<p class="set-sub">No agents found yet. Install one and it shows up here.</p>';
      return `<h4>Agents</h4>
        <div class="set-agents">${list}</div>
        ${settingRow('Manage agents', 'Install, sign in and pick models.', '<button class="btn btn-sm" id="sAgentPicker">Open</button>')}
        <h5>Permissions</h5>
        ${settingRow('Full access', agentFullAccess
          ? '<span class="set-warn">On: in build mode agents run any command, reach any file on this computer (.env and .git too) and skip every check.</span>'
          : 'Off: agents stay in the project, keep out of .env and .git, and Codex runs sandboxed.', switchHtml('sFullAccess', agentFullAccess, 'Full access'))}
        ${agents.some(a => a.found) ? `<h5>Usage</h5><div class="usage-list" id="sUsage">${usageHtml(usageAgents())}</div>` : ''}`;
    }
    case 'misc': return `<h4>Miscellaneous</h4>
      <h5>Vibe Code Mode</h5>
      ${settingRow('Vibe Code Mode', 'Play your feed while agents work.', switchHtml('sVibe', appState.vibeArmed, 'Vibe Code Mode'))}
      <h5>Feed</h5>
      <div class="social-grid ${appState.vibeArmed ? '' : 'off'}" id="sFeeds"${appState.vibeArmed ? '' : ' inert'}></div>
      <h5>Code</h5>
      ${settingRow('Enter code', appState.devMode ? 'Developer is unlocked.' : '', '<div class="set-code"><input class="input" id="sCode" aria-label="Code" placeholder="Code" autocomplete="off" spellcheck="false"><button class="btn btn-sm" id="sCodeGo" disabled>Enter</button></div>')}`;
    case 'discord': {
      const a = discordActivity();
      const status = { on: 'Connected', off: 'Off', error: 'Not connected' }[discordState.state];
      // With presence off, everything under the switch goes grey and can't be used, like the feeds under Vibe Code Mode.
      const off = appState.discord ? '' : 'off';
      return `<h4>Discord</h4>
        ${settingRow('Rich presence', `Status: ${status}${discordState.why ? ` · ${esc(discordState.why)}` : ''}`, switchHtml('sDiscord', appState.discord, 'Discord presence'))}
        <div class="set-dim ${off}"${off ? ' inert' : ''}>
        ${settingRow('Show project and file names', 'Names can include client or employer names.', switchHtml('sDiscordDetails', appState.discordDetails, 'Show project and file names'))}
        <h5>Friends will see</h5>
        <div class="discord-preview" role="img" aria-label="${escAttr(`Playing Breeze Code: ${a.details ?? ''}, ${a.state ?? ''}`)}">
          <div class="dc-head"><span>Playing</span>${svgIcon('more', 16)}</div>
          <div class="dc-body">
            <span class="dc-art-box">${a.icon
              ? `<img class="dc-art" src="${DC_ICON_URL}${a.icon}.png" alt="" draggable="false"><img class="dc-badge" src="${appIcon()}" alt="" draggable="false">`
              : `<img class="dc-art" src="${appIcon()}" alt="" draggable="false">`}</span>
            <div class="dc-txt"><b>Breeze Code</b><span>${esc(a.details ?? '')}</span><span>${esc(a.state ?? '')}</span>
              <span class="dc-time">${DC_PAD}<span data-dc-since="${a.start ?? Date.now()}"></span></span></div>
          </div>
        </div>
        <p class="set-sub">The Discord app must be running on this computer.</p></div>`;
    }
    case 'friends': {
      // With sharing off, the project switch goes grey and can't be used, like Discord's.
      const off = appState.friendsShare ? '' : 'off';
      return `<h4>Friends</h4>
        ${settingRow('Share my activity with friends', 'Friends see whether you are online and what you are doing: coding, building with an agent, debugging or in Breeze Space. Never your files, code or prompts.', switchHtml('sFriendsShare', appState.friendsShare, 'Share my activity with friends'))}
        <div class="set-dim ${off}"${off ? ' inert' : ''}>
        ${settingRow('Show my project name', 'The open folder’s name. Names can include client or employer names.', switchHtml('sFriendsProject', appState.friendsProject, 'Show my project name'))}</div>
        ${friendsConfigured === false ? `<p class="set-sub">${esc(FRIENDS_COPY['not-configured'])}</p>` : ''}`;
    }
    case 'help': {
      const engine = /Electron\/[\d.]+|Chrome\/[\d.]+/.exec(navigator.userAgent)?.[0] ?? '';
      // Git, Node.js and the compilers, each with the setup card's installer when it's missing (bindToolButtons).
      const toolRow = (t: DetectedTool) => {
        if (t.found) return settingRow(esc(t.name), esc(versionLabel(t.version) || 'Installed'), '<span class="pill ok">Ready</span>');
        const { attrs, does } = toolInstall(t);
        return settingRow(esc(t.name), attrs ? 'Not installed' : esc(does),
          attrs ? `<button class="btn btn-sm" ${attrs} title="${escAttr(does)}" aria-label="${escAttr(`Install ${t.name}. ${does}`)}">${attrs.startsWith('data-get') ? 'Download' : 'Install'}</button>` : '');
      };
      const tools = (appState.detect?.tools ?? []).map(toolRow).join('') || '<p class="set-sub shimmer-text">Checking this computer</p>';
      // Language servers: autocomplete, go to definition and problems for each language. Optional, one row each.
      const servers = (appState.detect?.servers ?? []).map(toolRow).join('');
      return `<h4>Help & About</h4>
      ${settingRow('Keyboard shortcuts', '', '<button class="btn btn-sm" data-set-cmd="help.keys">Show</button>')}
      <h5>Tools</h5>
      <div class="set-tools">${tools}</div>
      ${servers ? `<h5>Language servers</h5><p class="set-sub">Autocomplete, go to definition and problems for each language.</p><div class="set-tools">${servers}</div>` : ''}
      ${settingRow('About Breeze Code', `${engine ? `${esc(engine)} · ` : ''}v${esc(appVersion)}`, '')}`;
    }
    case 'dev': return `<h4>Developer</h4>
      ${settingRow('Run setup again', 'Check your build tools and install what is missing.', '<button class="btn btn-sm" data-set-cmd="help.setup">Start</button>')}
      ${settingRow('Developer tools', esc(keyOf('win.devtools')), '<button class="btn btn-sm" data-set-cmd="win.devtools">Toggle</button>')}
      ${settingRow('Reload window', esc(keyOf('win.reload')), '<button class="btn btn-sm" data-set-cmd="win.reload">Reload</button>')}
      ${settingRow('Classic switches', 'Use the flat on/off switch instead of the liquid one.', switchHtml('sClassicSwitch', classicSwitch, 'Classic switches'))}
      ${settingRow('Turn off Developer', 'Hide this section again.', '<button class="btn btn-sm" id="sDevOff">Turn off</button>')}`;
  }
}

/* ----- Controls: key binds ----- */
// The rebindable commands by menu, filtered by name or key; each key is a button that records a new one.
function keyBindListHtml(query: string): string {
  const q = query.trim().toLowerCase();
  const rows = keyBindRows().filter(r => !q || r.label.toLowerCase().includes(q) || keyOf(r.act).toLowerCase().includes(q) || r.menu.toLowerCase().includes(q));
  if (!rows.length) return '<p class="set-sub">No matching commands.</p>';
  let menu = '';
  return rows.map(r => {
    const head = r.menu !== menu ? `<div class="kb-group">${esc((menu = r.menu))}</div>` : '';
    const key = keyOf(r.act), changed = key !== (DEFAULT_KEYS.get(r.act) ?? '');
    const reset = changed ? `<button class="icon-btn kb-reset" data-kb-reset="${escAttr(r.act)}" title="Back to ${escAttr(DEFAULT_KEYS.get(r.act) || 'no key')}" aria-label="Reset ${escAttr(r.label)}">${svgIcon('rotateCcw', 13)}</button>` : '';
    return `${head}<div class="kb-row"><span class="kb-label">${esc(r.label)}</span>${reset}<button class="kb-key${key ? '' : ' none'}${changed ? ' changed' : ''}" data-kb="${escAttr(r.act)}" aria-label="${escAttr(`${r.label}: ${key || 'no key'}. Click to change`)}">${esc(key || 'Add key')}</button></div>`;
  }).join('');
}
// Keys alone (a letter, Enter) would stop working for typing, so a bind needs Ctrl or Alt, or is a function key.
const FN_KEY = /^F\d{1,2}$/;
const MOD_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);
let recording: { el: HTMLElement; done: () => void } | null = null;
function stopRecording(): void {
  if (!recording) return;
  const { done } = recording;
  recording = null;
  done();
}
// Sets a key's text, replaying its fade-in when the text actually changes.
function setKeyText(el: HTMLElement, text: string): void {
  if (el.textContent === text) return;
  el.textContent = text;
  el.classList.remove('kb-swap');
  void el.offsetWidth; // restart the animation
  el.classList.add('kb-swap');
}
function recordKeyBind(el: HTMLElement, redraw: () => void): void {
  if (recording) { // another key was waiting: it shows its key again
    const prev = recording.el;
    prev.classList.remove('recording');
    setKeyText(prev, keyOf(prev.dataset.kb as string) || 'Add key');
    recording = null;
  }
  el.classList.add('recording');
  setKeyText(el, 'Press keys');
  recording = { el, done: redraw };
  el.focus();
}
// Window, capture phase: runs before the app's own shortcuts and before Escape closes Settings.
window.addEventListener('keydown', e => {
  if (!recording) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const { el } = recording;
  const act = el.dataset.kb as string;
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
  if (e.key === 'Escape' && plain) { stopRecording(); return; }
  if ((e.key === 'Backspace' || e.key === 'Delete') && plain) { setKeyBind(act, ''); stopRecording(); return; }
  const mods = [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.shiftKey ? 'Shift' : '', e.altKey ? 'Alt' : ''].filter(Boolean);
  if (MOD_KEYS.has(e.key)) { setKeyText(el, `${mods.join('+')}+…`); return; } // still holding modifiers
  const combo = comboOf(e);
  if (!FN_KEY.test(keyName(e)) && !e.ctrlKey && !e.metaKey && !e.altKey) { setKeyText(el, 'Add Ctrl or Alt'); return; }
  const took = setKeyBind(act, combo);
  stopRecording();
  if (took) toast(`${combo} moved here from ${keyBindRows().find(r => r.act === took)?.label ?? took}`);
}, true);
// Clicking anywhere else, or closing Settings, ends the recording unchanged.
document.addEventListener('pointerdown', e => {
  if (recording && !(e.target as HTMLElement).closest?.('[data-kb]')) stopRecording();
}, true);

// The side tab, top to bottom: who you are, a search box, then the sections in groups.
const SETTINGS_GROUPS: [string, SettingsTab[]][] = [
  ['', ['general', 'appearance', 'controls', 'agents']],
  ['Apps', ['discord', 'friends', 'misc']],
  ['Support', ['help', 'dev']],
];
let settingsQuery = '';
/* ----- Smart search: what's typed finds settings anywhere (a row's title and description, its section and part, a
   shortcut's command and keys), forgiving one typo per word and knowing a few other words for things. While there is a
   query the pane lists the results instead of a section; picking one opens its section on that row. ----- */
interface SettingsHit {
  tab: SettingsTab; part: number; partName: string; title: string; sub: string; key: string;
  sel: string; n: number; // the row in its section: the nth match of sel
  score: number;
}
// What a row is found by, besides its own words.
const SETTINGS_SYNONYMS: Record<string, string> = {
  dark: 'theme', light: 'theme', colour: 'theme syntax', color: 'theme syntax colours', colors: 'theme syntax colours',
  wallpaper: 'background picture', image: 'background picture', photo: 'background picture', transparent: 'glass opacity',
  transparency: 'glass opacity', acrylic: 'glass', frosted: 'glass', mica: 'glass', blur: 'glass picture',
  volume: 'sound', mute: 'sound', audio: 'sound', sfx: 'sound', noise: 'sound',
  shortcut: 'keybinds', shortcuts: 'keybinds', hotkey: 'keybinds', hotkeys: 'keybinds', keyboard: 'keybinds', keys: 'keybinds',
  zoom: 'font size', bigger: 'font size', smaller: 'font size', text: 'font size',
  ai: 'agents', model: 'agents', models: 'agents', llm: 'agents', permission: 'full access', permissions: 'full access', sandbox: 'full access',
  autosave: 'auto save', login: 'sign account', logout: 'sign out', profile: 'account', presence: 'discord rich',
  version: 'about', compiler: 'tools', compilers: 'tools', lsp: 'language servers', sidebar: 'side bar', highlight: 'syntax',
};
const searchWords = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
// One typo apart: a letter wrong, missing or extra, or two side by side swapped.
function oneTypo(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return long.slice(i + 1) === short.slice(i);
}
// How well one typed word fits a field's words: whole word, start of a word, inside one, or a typo off. strict (a
// row's section and part, shared by every row there): whole words and starts only, so it can't flood the results.
function wordFit(q: string, hay: string[], strict = false): number {
  let best = 0;
  for (const w of hay) {
    if (w === q) return 3;
    if (w.startsWith(q)) best = Math.max(best, 2.5);
    else if (strict) continue;
    else if (q.length >= 3 && w.includes(q)) best = Math.max(best, 1.5);
    // A typo in a whole word, or (once five letters are typed) in the start of a longer one: "font" isn't "cont…".
    else if (q.length >= 4 && w.length >= q.length && (oneTypo(q, w) || (q.length >= 5 && oneTypo(q, w.slice(0, q.length))))) best = Math.max(best, 1);
  }
  return best;
}
// Every row of every section, read from its markup (a template doesn't load the images in it). A row belongs to the
// part (h5) above it (-1: before the first heading).
function settingsRows(): Omit<SettingsHit, 'score'>[] {
  const out: Omit<SettingsHit, 'score'>[] = [];
  for (const [tab] of visibleSettingsTabs()) {
    const t = document.createElement('template');
    t.innerHTML = settingsBody(tab);
    let part = -1, partName = '', group = '';
    const seen = new Map<string, number>();
    t.content.querySelectorAll<HTMLElement>('h5, .set-row, .set-theme, .set-agent, .kb-group, .kb-row').forEach(el => {
      const text = (s: string) => el.querySelector(s)?.textContent?.trim() ?? '';
      if (el.matches('.kb-group')) { group = el.textContent?.trim() ?? ''; return; }
      const sel = el.matches('h5') ? 'h5' : el.matches('.set-row') ? '.set-row' : el.matches('.kb-row') ? '.kb-row' : el.matches('.set-agent') ? '.set-agent' : '.set-theme';
      const n = seen.get(sel) ?? 0;
      seen.set(sel, n + 1);
      if (sel === 'h5') { part++; partName = el.textContent?.trim() ?? ''; }
      const title = sel === 'h5' ? partName : sel === '.set-row' ? text('.set-title') : sel === '.kb-row' ? text('.kb-label') : text('.nm');
      if (!title) return;
      const sub = sel === '.kb-row' ? group : sel === '.set-row' || sel === '.set-theme' ? text('.set-sub') : '';
      out.push({ tab, part, partName: sel === 'h5' ? '' : partName, title, sub, key: sel === '.kb-row' ? text('.kb-key') : '', sel, n });
    });
  }
  return out;
}
// The rows that fit every typed word, best first: a title counts most, then the keys, the description, and where it is.
// Words that say how, not what ("dark mode", "turn on sound"): skipped when something else was typed too.
const SEARCH_FILLER = new Set(['mode', 'setting', 'settings', 'option', 'options', 'change', 'enable', 'disable', 'turn', 'on', 'off', 'the', 'a', 'an', 'to', 'how', 'my', 'set']);
function searchSettings(query: string): SettingsHit[] {
  const typed = searchWords(query), whole = query.trim().toLowerCase();
  const qs = typed.some(w => !SEARCH_FILLER.has(w)) ? typed.filter(w => !SEARCH_FILLER.has(w)) : typed;
  if (!qs.length) return [];
  const labels = new Map(SETTINGS_TABS.map(([id, label]) => [id, label]));
  const hits: SettingsHit[] = [];
  for (const r of settingsRows()) {
    const title = searchWords(r.title), sub = searchWords(r.sub), key = searchWords(r.key);
    const where = searchWords(`${labels.get(r.tab) ?? ''} ${r.partName}`);
    let score = 0;
    for (const q of qs) {
      let fit = Math.max(wordFit(q, title) * 4, wordFit(q, key) * 2, wordFit(q, sub) * 1.5, wordFit(q, where, true));
      const alt = SETTINGS_SYNONYMS[q];
      if (alt) for (const a of searchWords(alt)) fit = Math.max(fit, wordFit(a, title, true) * 2.4, wordFit(a, where, true) * 1.2);
      if (!fit) { score = 0; break; }
      score += fit;
    }
    if (!score) continue;
    const t = r.title.toLowerCase();
    if (t.startsWith(whole)) score += 8; else if (t.includes(whole)) score += 4;
    hits.push({ ...r, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 40);
}
// Text with the typed words lit up.
function markHits(text: string, query: string): string {
  const qs = searchWords(query).map(q => q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!qs.length) return esc(text);
  const re = new RegExp(`(${qs.join('|')})`, 'giu');
  return text.split(re).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join('');
}
let settingsHits: SettingsHit[] = [];
// The pane while searching: the results, each with where it lives, or a note that nothing fits.
function renderSettingsSearch(m: HTMLElement): void {
  const pane = $('.set-pane', m);
  const fresh = pane.dataset.tab !== 'search';
  settingsHits = searchSettings(settingsQuery);
  const tabs = new Map(SETTINGS_TABS.map(([id, label, icon]) => [id, { label, icon }]));
  const q = settingsQuery.trim();
  const rows = settingsHits.map((h, i) => {
    const t = tabs.get(h.tab)!;
    const ico = t.icon === 'discord' ? '<span class="set-nav-img" aria-hidden="true"></span>' : svgIcon(t.icon, 16);
    const path = [t.label, h.partName].filter(Boolean).map(esc).join(' › ');
    return `<button class="set-hit" type="button" data-hit="${i}"><span class="set-hit-ico">${ico}</span>
      <span class="set-hit-txt"><span class="set-hit-path">${path}</span><b>${markHits(h.title, q)}</b>${h.sub ? `<small>${markHits(h.sub, q)}</small>` : ''}</span>
      ${h.key ? `<span class="set-hit-key">${esc(h.key)}</span>` : ''}</button>`;
  }).join('');
  pane.innerHTML = `<h4>Search</h4>
    <p class="set-sub set-hit-count">${settingsHits.length ? `${settingsHits.length} result${settingsHits.length === 1 ? '' : 's'} for “${esc(q)}”` : `Nothing matches “${esc(q)}”. Try another word.`}</p>
    <div class="set-results">${rows}</div>`;
  pane.dataset.tab = 'search';
  if (fresh) { $('.set-main', m).scrollTop = 0; staggerIn(pane.querySelectorAll('.set-hit'), 1); }
  $('.set-dash', m)?.classList.add('hidden');
  renderSettingsNav(m);
}
function settingsNavHeadHtml(): string {
  return `<div class="set-profile"></div>
    <label class="set-search">${svgIcon('search', 15)}<input id="setSearch" type="search" placeholder="Search" aria-label="Search settings" autocomplete="off" spellcheck="false"></label>
    <div class="set-nav-list"></div>`;
}
const settingsProfileHtml = () =>
  `${avatarHtml(user, '')}<div class="set-profile-txt"><b>${esc(displayName() ?? 'Not signed in')}</b>
    ${user
      // The email the account signed in with (or its login when the provider gave none); it still opens General.
      ? `<button class="set-profile-edit set-profile-mail" type="button" data-go-tab="general" title="${escAttr(user.email ?? user.login ?? user.provider)}">${esc(user.email ?? user.login ?? user.provider)}</button>`
      : `<button class="set-profile-edit" type="button" data-go-tab="general">Sign in${svgIcon('pencil', 12)}</button>`}</div>`;
// Redraws the side tab where it changed: who you are, and the sections (Developer comes and goes, search narrows them).
function renderSettingsNav(m: HTMLElement): void {
  const prof = $('.set-profile', m), list = $('.set-nav-list', m);
  if (prof) { const html = settingsProfileHtml(); if (prof.innerHTML !== html) prof.innerHTML = html; }
  if (list) { const html = settingsNavListHtml(); if (list.innerHTML !== html) list.innerHTML = html; }
}
function settingsNavListHtml(): string {
  const q = settingsQuery.trim().toLowerCase();
  const labels = new Map(visibleSettingsTabs().map(([id, label, icon]) => [id, { label, icon }]));
  const hits = q ? settingsHits : [];
  const groups = SETTINGS_GROUPS.map(([head, ids]) => {
    const items = ids.filter(id => labels.has(id)).map(id => {
      const { label, icon } = labels.get(id)!;
      // Searching: a section shows when its name or anything in it matches; picking it goes to its best hit's part.
      let at = -1;
      if (q) {
        const best = hits.find(h => h.tab === id);
        if (!best && !label.toLowerCase().includes(q)) return '';
        at = best?.part ?? -1;
      }
      // Discord's logo is drawn by CSS (a mask over the text colour), so it follows the theme.
      const iconHtml = icon === 'discord' ? '<span class="set-nav-img" aria-hidden="true"></span>' : svgIcon(icon, 17);
      const on = id === settingsTab && !q;
      return `<button class="set-item${on ? ' on' : ''}" data-set-tab="${id}"${at > 0 ? ` data-at="${at}"` : ''}${on ? ' aria-current="page"' : ''}>${iconHtml}<span>${esc(label)}</span></button>`;
    }).join('');
    return items ? `<div class="set-group">${head ? `<h6>${esc(head)}</h6>` : ''}${items}</div>` : '';
  }).filter(Boolean);
  return groups.length ? groups.join('<hr class="set-sep">') : '<p class="set-nav-empty">No settings match.</p>';
}
// A new section picked: its highlight flows from the old row (`from`, measured before the side tab was redrawn) to
// the new one. The edge facing the new row runs ahead and the other catches up, so the box stretches between the two
// like a drop and settles; the new row keeps its plain look until it lands.
function flowNavPill(nav: HTMLElement, from: DOMRect | undefined): void {
  const flying = nav.querySelector<HTMLElement>('.set-pill');
  if (flying) from = flying.getBoundingClientRect(); // picked again on the way: it carries on from where it is
  flying?.remove();
  const el = nav.querySelector<HTMLElement>('.set-item.on');
  if (!el || !from || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const to = el.getBoundingClientRect(), box = nav.getBoundingClientRect();
  if (Math.abs(to.top - from.top) < 1) return;
  const k = box.width / nav.offsetWidth || 1; // on-screen pixels per CSS pixel, should the dialog be scaled
  const top = (r: DOMRect) => (r.top - box.top) / k + nav.scrollTop;
  const bottom = (r: DOMRect) => nav.clientHeight - top(r) - r.height / k;
  const pill = document.createElement('div');
  pill.className = 'set-pill';
  Object.assign(pill.style, { left: `${(to.left - box.left) / k}px`, width: `${to.width / k}px`, top: `${top(to)}px`, bottom: `${bottom(to)}px` });
  nav.append(pill);
  const ms = 440, lead = 'cubic-bezier(.22, 1, .36, 1)', trail = 'cubic-bezier(.65, 0, .35, 1)', down = to.top > from.top;
  pill.animate({ top: [`${top(from)}px`, `${top(to)}px`] }, { duration: ms, easing: down ? trail : lead });
  pill.animate({ bottom: [`${bottom(from)}px`, `${bottom(to)}px`] }, { duration: ms, easing: down ? lead : trail }).onfinish = () => pill.remove();
  el.animate([{ background: 'transparent' }, { background: 'transparent' }], { duration: ms });
}
// Scrolls the pane to one of its parts (an h5), as a search result asks.
function showSettingsPart(m: HTMLElement, i: number): void {
  const h = $$('.set-pane h5', m)[i];
  const main = $('.set-main', m);
  if (!h || !main) return;
  const top = h.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - 16;
  main.scrollTo({ top, behavior: 'smooth' });
}

function bindSettings(m: HTMLElement): void {
  if (settingsTab === 'dev' && !appState.devMode) settingsTab = 'general';
  // Searching: the results stand in for the section, through redraws that come in meanwhile too.
  if (settingsQuery.trim()) { renderSettingsSearch(m); return; }
  const pane = $('.set-pane', m);
  // Switches are rebuilt with the pane, so remember where each knob was (mid-drag or mid-slide too) and slide on from there.
  const prevSwitch = new Map<string, string>();
  pane.querySelectorAll<HTMLElement>('.switch').forEach(s => prevSwitch.set(s.id, getComputedStyle(s).getPropertyValue('--complete')));
  // Held switches and how long their bubble stays up: 0.1s after a drag is let go, a tap's whole slide otherwise.
  const prevHeld = new Map([...pane.querySelectorAll<HTMLElement>('.switch[data-active]')].map(s => [s.id, s.dataset.dropped ? 100 : 200]));
  if (pane.dataset.tab !== settingsTab) lightJoke = ''; // a fresh joke for each visit
  // A part greyed out by its switch (Discord presence, Vibe Code Mode's feeds) fades there and back. The pane is
  // rebuilt below, so the new copy takes over from exactly how the old one looked, even mid-fade: turning presence on
  // redraws the pane again when Discord answers, and a fade that restarted from the on/off state was cut short there.
  // Coming back eases in more slowly than greying out.
  const DIMMABLE = ['.set-dim', '.social-grid'];
  const was = pane.dataset.tab === settingsTab ? DIMMABLE.map(s => {
    const el = pane.querySelector(s);
    return el ? { opacity: getComputedStyle(el).opacity, filter: getComputedStyle(el).filter } : null;
  }) : [];
  // Each row's description, by its title, so one that a redraw changes (Full access's On/Off) blurs in.
  const rowText = () => new Map($$<HTMLElement>('.set-row', pane).map(r => [r.querySelector('.set-title')?.textContent ?? '', r.querySelector<HTMLElement>('.set-sub')]));
  const wasText = pane.dataset.tab === settingsTab ? new Map(Array.from(rowText(), ([k, el]) => [k, el?.textContent ?? ''])) : null;
  // The usage bars keep their place through a redraw of the same section (Full access flipped): rebuilt, they filled again.
  const keptUsage = pane.dataset.tab === settingsTab ? pane.querySelector('#sUsage') : null;
  pane.innerHTML = settingsBody(settingsTab);
  if (keptUsage) {
    // Put back into the page, its entrance (staggerIn's class) would play again: it is already in.
    for (const el of [keptUsage, ...keptUsage.querySelectorAll('.stagger-item, .usage-in')]) el.classList.remove('stagger-item', 'usage-in');
    pane.querySelector('#sUsage')?.replaceWith(keptUsage);
  }
  if (wasText) {
    for (const [k, el] of rowText()) {
      if (el && wasText.has(k) && wasText.get(k) !== el.textContent) {
        el.animate([{ opacity: 0, filter: 'blur(2px)', transform: 'translateY(2px)' }, { opacity: 1, filter: 'blur(0)', transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.2, .8, .2, 1)' });
      }
    }
  }
  DIMMABLE.forEach((s, i) => {
    const el = pane.querySelector<HTMLElement>(s), from = was[i];
    if (!el || !from) return;
    const to = { opacity: getComputedStyle(el).opacity, filter: getComputedStyle(el).filter };
    if (to.opacity === from.opacity && to.filter === from.filter) return;
    const off = el.classList.contains('off');
    el.animate([from, to], { duration: off ? 300 : 450, easing: off ? 'ease' : 'cubic-bezier(.4, 0, .2, 1)' });
  });
  // Light's joke stays on one line: one that would wrap is swapped for another that fits.
  const joke = pane.querySelector<HTMLElement>('[data-theme-pick="light"] .set-sub');
  for (let i = 0; joke && joke.scrollWidth > joke.clientWidth && i < 40; i++) joke.textContent = lightJoke = pickOther(LIGHT_JOKES, lightJoke);
  // A new section's rows come in one after another; redraws of the same section (a switch flipped) just appear.
  if (pane.dataset.tab !== settingsTab) {
    pane.dataset.tab = settingsTab;
    staggerIn(pane.children);
    staggerIn(pane.querySelectorAll('.set-agents > *, .set-tools > *, .set-themes > *, .set-bd > *, .set-syn > *, .set-syn-picks > *'), 2);
    pane.querySelector('.set-themes')?.classList.add('grow'); // the theme pictures' code lines grow in
  }
  // Just switched accounts: the account card turns over to the new one and Active pops onto its row.
  if (justSwitched) {
    justSwitched = false;
    $('.set-user', pane)?.animate(
      [{ opacity: 0, transform: 'translateY(8px) scale(.98)', filter: 'blur(3px)' }, { opacity: 1, transform: 'none', filter: 'none' }],
      { duration: 380, easing: 'cubic-bezier(.32, .72, 0, 1)' });
    $('.set-active', pane)?.animate(
      [{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'scale(1.08)', offset: .6 }, { transform: 'scale(1)' }],
      { duration: 420, delay: 120, easing: 'cubic-bezier(.32, .72, 0, 1)', fill: 'backwards' });
    $$('[data-switch-acct]', pane).forEach(b => b.animate([{ opacity: 0, transform: 'scale(.9)' }, { opacity: 1, transform: 'none' }], { duration: 300, delay: 120, easing: 'ease-out', fill: 'backwards' }));
  }
  // A rebuilt switch starts where the old knob was (mid-drag or mid-slide too) and slides on with its own CSS
  // transition, so it moves exactly as fast as a switch that was never rebuilt (the composer's Full access).
  pane.querySelectorAll<HTMLElement>('.switch').forEach(s => {
    const was = Number.parseFloat(prevSwitch.get(s.id) ?? '');
    const to = s.classList.contains('on') ? 100 : 0;
    // A liquid switch held as it flipped keeps its bubble up on the rebuilt one, and slides as a tap (or a drop) does.
    const held = prevHeld.get(s.id);
    if (!classicSwitch && held) {
      s.dataset.active = 'true'; s.dataset.pressed = 'true';
      if (held === 100) s.dataset.dropped = 'true';
      settleSwitch(s, held);
    }
    if (Number.isNaN(was) || Math.abs(was - to) < .5) return;
    // Pinned there with no transition (the pane's earlier style reads may have placed it at the end already), then let go.
    s.style.transition = 'none';
    s.style.setProperty('--complete', String(was));
    void getComputedStyle(s).getPropertyValue('--complete');
    s.style.transition = '';
    s.style.removeProperty('--complete');
  });
  renderSettingsNav(m);
  const on = (id: string, fn: (el: HTMLElement) => void) => { const el = $(`#${id}`, pane); if (el) el.onclick = () => fn(el); };
  const layoutSwitch = (id: string, act: string) => on(id, () => { run(act); refreshSettings(); });
  const seg = (id: string, fn: (v: string) => void) => $$(`#${id} button`, pane).forEach(b => b.onclick = () => fn(b.dataset.v ?? ''));

  // General
  seg('sMode', v => { if (v !== appState.mode) { closeModal(); enterMode(v as WorkMode); } });
  seg('sPower', v => { if (v !== powerInfo.mode) setPowerMode(v as PowerMode); });
  seg('sAutoSave', v => { const m = AUTO_SAVE_MODES.find(x => x === v); if (m && m !== autoSave) { setAutoSave(m); refreshSettings(); } });
  layoutSwitch('sSide', 'view.toggleSide');
  layoutSwitch('sAgents', 'view.toggleAgents');
  layoutSwitch('sTerm', 'term.toggle');
  layoutSwitch('sPreview', 'view.togglePreview');
  layoutSwitch('sResetLayout', 'view.resetLayout');
  // Appearance
  on('sMinimap', () => { setMinimap(!minimapOn); refreshSettings(); });
  on('sGenerated', () => { toggleGenerated(); refreshSettings(); });
  on('sPathTips', () => { togglePathTips(); refreshSettings(); });
  $$('[data-theme-pick]', pane).forEach(b => b.onclick = () => {
    const pick = b.dataset.themePick as Theme;
    if (pick === theme) return;
    const from = pane.querySelector('[data-theme-pick].on')?.getBoundingClientRect();
    setTheme(pick);
    refreshSettings();
    slideSelected(pane.querySelector<HTMLElement>(`[data-theme-pick="${CSS.escape(theme)}"]`), from);
  });
  bindBackdropSettings(pane);
  bindSyntaxSettings(pane);
  // Font size: the code redraws as the knob moves; the arrow keys and the wheel step one pixel.
  const sizeEl = $<HTMLInputElement>('#sCodeSize', pane);
  if (sizeEl) {
    const showSize = (v: number) => {
      setCodeSize(v);
      sizeEl.value = String(codeSize);
      sizeEl.style.setProperty('--fill', `${(codeSize - CODE_SIZE_MIN) / (CODE_SIZE_MAX - CODE_SIZE_MIN) * 100}%`);
      swapText($('#sCodeSizeVal', pane), `${codeSize}px`);
    };
    showSize(codeSize);
    sizeEl.oninput = () => showSize(+sizeEl.value);
    sizeEl.addEventListener('wheel', e => {
      e.preventDefault();
      const was = codeSize;
      showSize(codeSize + (e.deltaY < 0 || e.deltaX > 0 ? 1 : -1));
      if (codeSize !== was) sfx.play('slide');
    }, { passive: false });
  }
  // Controls
  const kbList = $('#kbList', pane), kbSearch = $<HTMLInputElement>('#kbSearch', pane);
  if (kbList && kbSearch) {
    // Keys whose text changed in the redraw (a new bind, a reset, a key moved off another command) fade in.
    const redraw = () => {
      const before = new Map($$<HTMLElement>('[data-kb]', kbList).map(b => [b.dataset.kb, b.textContent]));
      kbList.innerHTML = keyBindListHtml(kbSearch.value);
      $$<HTMLElement>('[data-kb]', kbList).forEach(b => {
        const was = before.get(b.dataset.kb);
        if (was != null && was !== b.textContent) { const now = b.textContent ?? ''; b.textContent = was; setKeyText(b, now); }
      });
    };
    kbSearch.oninput = redraw;
    $('#kbResetAll', pane).onclick = () => { resetKeyBinds(); redraw(); toast('Every shortcut is back to its default'); };
    kbList.onclick = e => {
      const t = e.target as HTMLElement;
      const reset = t.closest<HTMLElement>('[data-kb-reset]');
      if (reset) { resetKeyBinds(reset.dataset.kbReset); redraw(); return; }
      const key = t.closest<HTMLElement>('[data-kb]');
      if (key) recordKeyBind(key, redraw);
    };
  }
  // Agents
  $$('[data-agent-pick]', pane).forEach(b => b.onclick = () => {
    const ag = appState.detect?.agents.find(a => a.id === b.dataset.agentPick);
    if (!ag?.found) return;
    const from = pane.querySelector('.set-agent.on')?.getBoundingClientRect();
    appState.agent = ag.id;
    const curTab = surfaceTabs['ide']?.find(t => t.id === activeTabId['ide']);
    if (curTab) curTab.agentId = ag.id;
    saveApp(); renderAgentBar(); updateScmGenBtn();
    refreshSettings();
    slideSelected(pane.querySelector<HTMLElement>(`[data-agent-pick="${CSS.escape(ag.id)}"]`), from);
  });
  if ($('#sEffort', pane)) seg('sEffort', v => { setEffort(v as EffortLevel); renderAgentBar(); refreshSettings(); });
  $$('[data-agent-install]', pane).forEach(b => b.onclick = async () => {
    const ag = appState.detect?.agents.find(a => a.id === b.dataset.agentInstall);
    if (!ag) return;
    if (!ag.install) { background(api.sys.openExternal(ag.url)); return; }
    (b as HTMLButtonElement).disabled = true;
    swapText(b, 'Installing');
    try {
      if (await api.sys.runCommand(ag.install)) toast(`Installing ${ag.name} in a terminal. It shows up here once it's done.`);
      else { toast(`Run this to install ${ag.name}: ${ag.install}`); background(api.sys.openExternal(ag.url)); }
    } catch (err) { toast(`Couldn't start the install: ${errMsg(err)}`); }
    finally { setTimeout(refreshSettings, 2500); }
  });
  on('sAgentPicker', () => openAgentPicker());
  on('sFullAccess', () => setFullAccess(!agentFullAccess));
  const usageEl = pane.querySelector<HTMLElement>('#sUsage');
  // A kept list (a redraw of this section, Full access flipped) is left exactly as it is, timer and all: no fetch, so
  // nothing in it moves because of the redraw.
  if (usageEl && !keptUsage) {
    fillUsageBars(usageEl);
    usageShown = usageHtml(usageAgents());
    updateUsage(usageEl);
    // Kept current while it's on screen; the timer ends once this pane is redrawn or closed.
    clearInterval(usageTick);
    const tick = usageTick = window.setInterval(() => { if (usageEl.isConnected) updateUsage(usageEl); else clearInterval(tick); }, DASH_REFRESH_MS);
  }
  // Home's agent page sits under the Agents pane, outside it, so the pane's redraws leave it be.
  const dashSlot = m.querySelector<HTMLElement>('.set-dash');
  if (dashSlot) {
    dashSlot.classList.toggle('hidden', settingsTab !== 'agents');
    if (settingsTab === 'agents') mountAgentDash(dashSlot);
  }
  if (settingsTab === 'agents' || settingsTab === 'help') autoRescan();
  if (settingsTab === 'help') bindToolButtons(pane);
  // Vibe
  // Turns on without a feed (it plays nothing until one is connected): the feeds are locked while it's off.
  on('sVibe', () => setVibeArmed(!appState.vibeArmed));
  const feeds = $('#sFeeds', pane);
  if (feeds) void renderFeedChoices(feeds);
  // Code: the right one unlocks Developer and jumps to it.
  const codeIn = $<HTMLInputElement>('#sCode', pane);
  const tryCode = () => {
    const v = codeIn.value.trim().toLowerCase();
    if (!v) return;
    if (v !== DEV_CODE) { toast('That code didn’t work'); codeIn.select(); return; }
    appState.devMode = true; saveApp(); applyDevMode();
    toast('Developer unlocked');
    settingsTab = 'dev';
    refreshSettings();
  };
  on('sCodeGo', tryCode);
  if (codeIn) {
    codeIn.onkeydown = e => { if (e.key === 'Enter') tryCode(); };
    codeIn.oninput = () => { $<HTMLButtonElement>('#sCodeGo', pane).disabled = !codeIn.value.trim(); };
  }
  on('sClassicSwitch', () => { setClassicSwitch(!classicSwitch); refreshSettings(); });
  on('sDevOff', () => { appState.devMode = false; saveApp(); applyDevMode(); settingsTab = 'misc'; refreshSettings(); });
  // Friends
  on('sFriendsShare', () => { appState.friendsShare = !appState.friendsShare; saveApp(); queueFriendsPresence(); refreshSettings(); });
  on('sFriendsProject', () => { appState.friendsProject = !appState.friendsProject; saveApp(); queueFriendsPresence(); refreshSettings(); });
  // Discord
  on('sDiscord', el => {
    if (appState.discord) { discordOff(); return; }
    (el as HTMLButtonElement).disabled = true;
    void discordOn(appState.discordDetails).then(refreshSettings);
  });
  on('sDiscordDetails', () => {
    appState.discordDetails = !appState.discordDetails; saveApp(); queueDiscord();
    // The pane is rebuilt, so put the old lines back and fade them over to the new ones.
    const lines = () => $$('.dc-txt > span:not(.dc-time)', pane);
    const old = lines().map(s => s.textContent ?? '');
    const oldArt = $('.dc-art-box', pane)?.cloneNode(true) as HTMLElement | undefined;
    refreshSettings();
    lines().forEach((s, i) => { const text = s.textContent ?? ''; s.textContent = old[i] ?? text; blurSwap(s, text); });
    // The picture crossfades: the old one, laid over the new, fades and shrinks away while the new one grows in and
    // the Breeze badge pops into its corner.
    const art = $('.dc-art-box', pane);
    if (!art || !oldArt) return;
    oldArt.classList.add('dc-art-old');
    oldArt.setAttribute('aria-hidden', 'true');
    art.append(oldArt);
    const ease = 'cubic-bezier(.32, .72, 0, 1)';
    oldArt.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.9)' }], { duration: 260, easing: ease, fill: 'forwards' }).onfinish = () => oldArt.remove();
    art.querySelector('.dc-art')?.animate([{ opacity: 0, transform: 'scale(.9)', filter: 'blur(4px)' }, { opacity: 1, transform: 'none', filter: 'none' }], { duration: 360, easing: ease });
    art.querySelector('.dc-badge')?.animate([{ opacity: 0, transform: 'scale(.3)' }, { opacity: 1, transform: 'scale(1.12)', offset: .65 }, { transform: 'none' }], { duration: 380, delay: 140, easing: ease, fill: 'backwards' });
  });
  // The preview's elapsed time counts up like Discord's, from when Breeze started; it stops once the tab is gone.
  const since = pane.querySelector<HTMLElement>('[data-dc-since]');
  if (since) {
    const start = Number(since.dataset.dcSince);
    const tick = () => {
      if (!since.isConnected) { clearInterval(timer); return; }
      const s = Math.max(0, Math.floor((Date.now() - start) / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
      const ss = String(s % 60).padStart(2, '0');
      since.textContent = h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
    };
    const timer = setInterval(tick, 1000);
    tick();
  }
  // Sound: drag or scroll to set the level, one tick when it settles so you hear it.
  // Near 25 (the default) the knob snaps to 25; pushing on out of the snap zone turns the snap off until the drag (or scroll) ends.
  const vol = $<HTMLInputElement>('#sVolume', pane);
  if (vol) {
    vol.style.setProperty('--fill', `${vol.value}%`);
    const SNAP = 3;
    let snapArmed = true, snapped = false, wheelIdle = 0;
    const show = (v: number) => {
      vol.value = String(v);
      sfx.setVolume(v);
      vol.style.setProperty('--fill', `${v}%`);
      $('#sVolumeVal', pane).textContent = `${v}%`;
      void setIcon($('#sVolumeIco', pane), volumeIcon(v));
    };
    const SNAP_AT = 25;
    const near = (v: number) => Math.abs(v - SNAP_AT) <= SNAP;
    const settle = (raw: number) => {
      if (snapped && !near(raw)) { snapped = false; snapArmed = false; }
      if (snapArmed && near(raw)) { snapped = true; raw = SNAP_AT; }
      show(raw);
    };
    const rearm = () => { snapArmed = true; snapped = false; };
    vol.oninput = () => settle(+vol.value);
    vol.onchange = () => { sfx.play('tick'); rearm(); };
    // The speaker mutes, and a second press brings back the level it had.
    let unmuteTo = SNAP_AT;
    on('sVolumeIco', () => {
      const cur = +vol.value;
      if (cur) unmuteTo = cur;
      show(cur ? 0 : unmuteTo);
      sfx.play(cur ? 'close' : 'tick');
    });
    vol.addEventListener('wheel', e => {
      e.preventDefault();
      const cur = +vol.value;
      const next = clamp(cur + (e.deltaY < 0 || e.deltaX > 0 ? 1 : -1), 0, 100);
      // A tick away from a snapped 25 is a push out of the snap: let it through.
      if (snapped && cur === SNAP_AT) { snapped = false; snapArmed = false; show(next); }
      else settle(next);
      // The same slide sound a drag makes (setting the value from script fires no input event to play it).
      if (+vol.value !== cur) sfx.play('slide');
      clearTimeout(wheelIdle);
      wheelIdle = window.setTimeout(() => { sfx.play('tick'); rearm(); }, 450);
    }, { passive: false });
  }
  // Account
  $$('[data-switch-acct]', pane).forEach(b => b.onclick = () => {
    const a = accounts.accounts.find(x => accountKey(x) === b.dataset.switchAcct);
    if (a) background(switchAccount(a).then(() => { justSwitched = true; refreshSettings(); }));
  });
  on('sAddAcct', () => addAccount());
  on('sSignOut', () => background(signOut().then(refreshSettings)));
  // Help and Developer
  // A command that opens a modal opens it on top of Settings; setup and reload close Settings first.
  $$('[data-set-cmd]', pane).forEach(b => b.onclick = () => {
    const c = b.dataset.setCmd ?? '';
    if (c === 'help.setup' || c === 'win.reload') closeModal();
    run(c);
  });
}
// Redraws the open pane when something changes elsewhere (Discord connects, a feed signs in, …).
function refreshSettings(): void {
  const m = settingsRoot();
  if (m) bindSettings(m);
}
// Settings → General → Performance: what the power saver does, and whether it is on right now and why.
function powerNote(): string {
  const now = powerInfo.reason === 'battery' ? 'On now: running on battery.'
    : powerInfo.reason === 'lowend' ? 'On now: this machine is light on cores or memory.'
    : powerInfo.reason === 'forced' ? 'On now.'
    : 'Off now.';
  return `Power saver drops blur, looping motion and idle work. Auto turns it on while on battery or on a slower machine. ${now}`;
}
// Unplugging (or plugging in) with Settings open updates the row.
document.addEventListener('powerchange', refreshSettings);

// The switch beside each Send button is the same setting as Settings → Agents → Full access.
function renderAccessSwitches(): void {
  $$<HTMLButtonElement>('[data-full-access]').forEach(b => {
    b.classList.toggle('on', agentFullAccess);
    b.setAttribute('aria-checked', String(agentFullAccess));
    b.closest('.composer-access')?.classList.toggle('on', agentFullAccess);
  });
}
// The switch flips at once instead of after main answers; main's answer only corrects it, and a failure flips it back.
function setFullAccess(on: boolean): void {
  const show = (v: boolean) => { if (v !== agentFullAccess) { agentFullAccess = v; renderAccessSwitches(); refreshSettings(); } };
  show(on);
  background(api.agent.setFullAccess(on).then(v => {
    show(v);
    toast(v ? 'Full access on: agents can run anything in build mode' : 'Full access off');
  }, (e: unknown) => { show(!on); throw e; }));
}
$$<HTMLButtonElement>('[data-full-access]').forEach(b => b.onclick = () => setFullAccess(!agentFullAccess));
background(api.agent.fullAccess().then(v => { agentFullAccess = v; renderAccessSwitches(); }));

function openSettings(gear: HTMLElement, tab?: SettingsTab): void {
  if (settingsRoot()) { closeModal(); return; }
  background(api.agent.fullAccess().then(v => { if (v !== agentFullAccess) { agentFullAccess = v; refreshSettings(); renderAccessSwitches(); } }));
  closeMenu();
  if (tab) settingsTab = tab;
  const gears = [$('#settingsBtn'), $('#boxSettings'), $('#homeSettings')];
  gears.forEach(g => { g.classList.add('open'); g.setAttribute('aria-expanded', 'true'); });
  openModal(`<div class="settings-modal" aria-label="Settings">
      <nav class="set-nav" aria-label="Settings sections">${settingsNavHeadHtml()}</nav>
      <div class="set-main"><button class="set-close tab-close" data-close title="Close (Esc)" aria-label="Close"><svg class="tab-close-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button><div class="set-pane"></div><div class="set-dash hidden"></div></div>
    </div>`, m => {
    m.classList.add('settings-shell');
    const root = $('.settings-modal', m);
    settingsQuery = '';
    // at: a search result's part to scroll to (its h5's index).
    const switchTab = (tab: SettingsTab, at = 0) => {
      const changed = settingsTab !== tab;
      const nav = $('.set-nav', root), from = changed ? nav.querySelector('.set-item.on')?.getBoundingClientRect() : undefined;
      settingsTab = tab;
      const pane = $('.set-pane', root);
      if (changed && pane) {
        pane.style.animation = 'none';
        forceReflow(pane);
        pane.style.animation = '';
      }
      if (changed || settingsQuery) {
        if (settingsQuery) { settingsQuery = ''; $<HTMLInputElement>('#setSearch', root).value = ''; }
        $('.set-main', root).scrollTop = 0;
        bindSettings(root);
      }
      flowNavPill(nav, from);
      if (at) showSettingsPart(root, at); // the new pane is in the page already, so its headings can be measured
    };
    // Delegated, so the Developer button works when it is added after the code is entered.
    $('.set-nav', root).addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-set-tab], [data-go-tab]');
      if (b) switchTab((b.dataset.setTab ?? b.dataset.goTab) as SettingsTab, Number(b.dataset.at ?? 0));
    });
    // A search result opens its section on its row, which is brought into view and glows for a moment. A shortcut
    // opens Controls already filtered to it.
    const openHit = (h: SettingsHit) => {
      switchTab(h.tab);
      const pane = $('.set-pane', root);
      const kb = $<HTMLInputElement>('#kbSearch', pane);
      if (h.sel === '.kb-row' && kb) { kb.value = h.title; kb.dispatchEvent(new Event('input')); }
      const el = h.sel === '.kb-row' ? pane.querySelector<HTMLElement>('.kb-row') : $$<HTMLElement>(h.sel, pane)[h.n];
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.remove('set-found');
      void el.offsetWidth; // restart the glow
      el.classList.add('set-found');
    };
    $('.set-pane', root).addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-hit]');
      const h = b && settingsHits[Number(b.dataset.hit)];
      if (h) openHit(h);
    });
    // Arrow keys walk the results; from the first one, up goes back to the box.
    $('.set-pane', root).addEventListener('keydown', e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-hit]');
      if (!b || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
      e.preventDefault();
      const next = (e.key === 'ArrowDown' ? b.nextElementSibling : b.previousElementSibling) as HTMLElement | null;
      (next ?? (e.key === 'ArrowUp' ? search : b)).focus();
    });
    // Typing searches every section and lists what fits in place of the section; Enter opens the best result.
    const search = $<HTMLInputElement>('#setSearch', root);
    search.addEventListener('input', () => { settingsQuery = search.value; bindSettings(root); });
    search.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (settingsHits[0] && settingsQuery.trim()) openHit(settingsHits[0]);
        else root.querySelector<HTMLElement>('.set-nav-list [data-set-tab]')?.click();
      } else if (e.key === 'ArrowDown') {
        const first = root.querySelector<HTMLElement>('.set-hit');
        if (first) { e.preventDefault(); first.focus(); }
      } else if (e.key === 'Escape' && search.value) {
        e.preventDefault();
        e.stopPropagation();
        search.value = '';
        settingsQuery = '';
        bindSettings(root);
      }
    });
    background(refreshAccounts().then(refreshSettings));
    bindSettings(root);
    gear.blur();
  }, () => { gears.forEach(g => { g.classList.remove('open'); g.setAttribute('aria-expanded', 'false'); }); mountAgentDash(null); });
}
commands['settings.open'] = () => openSettings($('#settingsBtn'));
$('#settingsBtn').onclick = e => openSettings(e.currentTarget as HTMLElement);
$('#boxSettings').onclick = e => openSettings(e.currentTarget as HTMLElement);
$('#homeSettings').onclick = e => openSettings(e.currentTarget as HTMLElement);

// Buttons with data-act anywhere in the page run the matching command.
document.addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (b && !b.closest('.menu')) { e.stopPropagation(); run(b.dataset.act as string); }
});

