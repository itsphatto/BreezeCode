/* ================= Sound effects ================= */
// The website's sounds (BreezeCode-Web/sfx.js): tiny synthesized blips, no audio files. Nothing plays until the
// first click or key press, and the speaker button in the status bar (or Settings › Sound Effects) turns them off.
const sfx = (() => {
  let on = store.get('breeze.sound', true);
  let volume = store.get('breeze.volume', 25); // 0–100; 25 is the default (and where the slider snaps)
  // Levels saved on the old, quieter scale would be far too loud on the new one, so they start over at 25 once.
  if (!store.get('breeze.volumeScale2', false)) {
    volume = 25;
    store.set('breeze.volume', volume);
    store.set('breeze.volumeScale2', true);
  }
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let verb: ConvolverNode | null = null;
  let noise: AudioBuffer | null = null;
  const secureRandom = () => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] / 4294967296; };
  // Where the sound being played sits left–right, and whether it skips the room (set by play() for each sound).
  let panNow = 0;
  let dryNow = false;
  let lastAt = -Infinity; // when a control's sound last played, so a button that makes its own sound doesn't also click
  let anyAt = -Infinity; // when any sound at all last played

  // 25 plays twice as loud as the old fixed level did; the top of the slider is four times that.
  const gainFor = (v: number) => v / 25;

  // Audio may only start after a gesture, so the context is made on the first one.
  function unlock(): void {
    if (ctx) return;
    try {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = gainFor(volume);
      // A gentle compressor on the way out, so a few sounds landing together don't spike.
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.knee.value = 12;
      comp.ratio.value = 3;
      comp.attack.value = 0.003;
      comp.release.value = 0.12;
      master.connect(comp).connect(ctx.destination);
      // A small room, made here rather than loaded: a short stereo burst of decaying noise. Control sounds send a
      // little into it (the "breeze"); fast ambient ticks stay dry so typing never smears.
      verb = ctx.createConvolver();
      const len = Math.floor(ctx.sampleRate * 0.7);
      const ir = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (secureRandom() * 2 - 1) * Math.pow(1 - i / len, 3.2);
      }
      verb.buffer = ir;
      const wet = ctx.createGain();
      wet.gain.value = 0.18;
      const damp = ctx.createBiquadFilter();
      damp.type = 'lowpass';
      damp.frequency.value = 4200;
      verb.connect(damp).connect(wet).connect(master);
      // A 6 ms burst of noise, reused for the physical "tap" at the front of a click.
      const tl = Math.floor(ctx.sampleRate * 0.006);
      noise = ctx.createBuffer(1, tl, ctx.sampleRate);
      const nd = noise.getChannelData(0);
      for (let i = 0; i < tl; i++) nd[i] = (secureRandom() * 2 - 1) * (1 - i / tl);
      // Many Windows audio devices doze after a moment of silence and swallow the first short blip that wakes
      // them (a click after resting on a button, a tab's X, a lone key). A far-below-hearing signal keeps the
      // output awake. It is a tone, not a flat offset: the output chain filters a DC offset out and a 16-bit device
      // rounds one that small to zero, so the line still read as silent. 25 Hz at -66 dB is well under hearing.
      const awake = ctx.createOscillator();
      const hush = ctx.createGain();
      awake.frequency.value = 25;
      hush.gain.value = 0.0005;
      awake.connect(hush).connect(ctx.destination);
      awake.start();
    } catch { ctx = null; } // no audio available
  }
  // A real press or key also ends the start-up hush and wakes a dozing context: start-up waits on slow work (an agent
  // scan, a git refresh) for up to 8s, and every click made meanwhile was silent.
  const wake = (e: Event) => {
    if (!e.isTrusted) return;
    document.documentElement.removeAttribute('data-starting');
    unlock();
    if (ctx && ctx.state !== 'running') void ctx.resume().catch(() => {});
  };
  for (const t of ['pointerdown', 'keydown']) addEventListener(t, wake, { capture: true, passive: true });
  // The desktop window allows audio without a gesture, so the context is ready before the first sound is asked for;
  // coming back to the window wakes it if Chromium put it to sleep meanwhile.
  unlock();
  addEventListener('focus', () => { if (ctx && ctx.state !== 'running') void ctx.resume().catch(() => {}); });

  // Every pitch lands on D-major pentatonic (D E F# A B), in whatever octave it was asked for, so sounds that
  // overlap (a tab and a save, the thinking hum and an answer) always agree. Pitch classes counted from C.
  const SCALE = [2, 4, 6, 9, 11];
  function snap(f: number): number {
    const m = 69 + 12 * Math.log2(f / 440);
    let best = m, dist = Infinity;
    for (let o = Math.floor(m / 12) - 1; o <= Math.floor(m / 12) + 1; o++) {
      for (const pc of SCALE) {
        const n = o * 12 + pc;
        if (Math.abs(n - m) < dist) { dist = Math.abs(n - m); best = n; }
      }
    }
    return 440 * Math.pow(2, (best - 69) / 12);
  }

  // One blip: a pitch (optionally sliding) with a fast attack and a fade-out. It is two voices a few cents apart
  // through a soft lowpass, so it reads warm rather than as a raw beep; `tap` adds a tiny noise click at the front.
  function tone(freq: number, dur: number, { type = 'sine', vol = 0.1, to = freq, at = 0, tap = 0 }: { type?: OscillatorType; vol?: number; to?: number; at?: number; tap?: number } = {}): void {
    const c = ctx as AudioContext;
    // A little ahead of now: a note started at currentTime lands partly in the past and very short ones get lost.
    const t0 = c.currentTime + 0.012 + at;
    // The start snaps to the scale; a slide keeps its shape by moving its end by the same ratio.
    const f0 = snap(freq);
    const f1 = to * (f0 / freq);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(Math.max(f0, f1) * (type === 'sine' ? 6 : 3), 12000);
    lp.Q.value = 0.5;
    const pan = c.createStereoPanner();
    pan.pan.value = panNow;
    g.connect(lp).connect(pan).connect(master as GainNode);
    if (!dryNow && verb) pan.connect(verb);
    for (const [cents, level] of [[0, 1], [7, 0.35]] as const) {
      const osc = c.createOscillator();
      const og = c.createGain();
      osc.type = type;
      osc.detune.value = cents;
      og.gain.value = level;
      osc.frequency.setValueAtTime(f0, t0);
      if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
      osc.connect(og).connect(g);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    }
    if (tap && noise) {
      const src = c.createBufferSource();
      src.buffer = noise;
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 3200;
      bp.Q.value = 0.9;
      const tg = c.createGain();
      tg.gain.value = tap;
      src.connect(bp).connect(tg).connect(pan);
      src.start(t0);
    }
  }

  const jitter = (n: number) => 1 + (secureRandom() - 0.5) * n;
  const SOUNDS = {
    click: () => tone(1500 * jitter(0.06), 0.05, { to: 900, vol: 0.09, tap: 0.05 }),
    hover: () => tone(2400, 0.025, { vol: 0.016 }),
    // Typing: a random step of the scale and a little give in loudness, so a long run never drones.
    key: () => tone(1900 * jitter(0.35), 0.03, { type: 'triangle', vol: 0.035 * jitter(0.5), tap: 0.012 }),
    tab: () => tone(520, 0.08, { to: 760, vol: 0.09 }),
    close: () => tone(720, 0.08, { to: 420, vol: 0.08 }),
    menu: () => tone(420, 0.09, { to: 640, type: 'triangle', vol: 0.07 }),
    whoosh: () => { tone(300, 0.16, { to: 900, type: 'triangle', vol: 0.05 }); tone(150, 0.16, { to: 450, vol: 0.05 }); },
    save: () => { tone(660, 0.12, { vol: 0.09 }); tone(990, 0.2, { vol: 0.09, at: 0.09 }); },
    tick: () => tone(1250, 0.03, { type: 'triangle', vol: 0.06 }),
    ping: () => tone(880, 0.16, { vol: 0.08, to: 920 }),
    // Agent chat
    send: () => tone(480, 0.12, { to: 1000, type: 'triangle', vol: 0.07 }),
    msg: () => tone(640, 0.09, { to: 470, vol: 0.07 }),
    tool: () => tone(1500 * jitter(0.1), 0.03, { type: 'triangle', vol: 0.035 }),
    plan: () => [523, 659, 784].forEach((f, i) => tone(f, 0.16, { vol: 0.07, at: i * 0.08 })),
    approve: () => { tone(523, 0.12, { type: 'triangle', vol: 0.08 }); tone(784, 0.2, { type: 'triangle', vol: 0.08, at: 0.07 }); },
    build: () => tone(200, 0.35, { to: 620, type: 'sawtooth', vol: 0.03 }),
    success: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i === 3 ? 0.4 : 0.14, { vol: 0.08, at: i * 0.09 })),
    launch: () => { tone(330, 0.16, { to: 660, type: 'triangle', vol: 0.08 }); tone(1320, 0.05, { vol: 0.05, at: 0.14 }); },
    // Controls
    toggleOn: () => { tone(700, 0.05, { type: 'triangle', vol: 0.07 }); tone(1180, 0.07, { type: 'triangle', vol: 0.07, at: 0.045 }); },
    toggleOff: () => { tone(1050, 0.05, { type: 'triangle', vol: 0.06 }); tone(620, 0.07, { type: 'triangle', vol: 0.06, at: 0.045 }); },
    select: () => { tone(1320 * jitter(0.04), 0.04, { vol: 0.07 }); tone(1760, 0.06, { vol: 0.05, at: 0.03 }); },
    rowHover: () => tone(3000 * jitter(0.08), 0.018, { vol: 0.011 }),
    focus: () => tone(980, 0.06, { to: 1150, vol: 0.035 }),
    link: () => tone(1200, 0.07, { to: 1600, type: 'triangle', vol: 0.05 }),
    row: () => tone(1100 * jitter(0.08), 0.035, { type: 'triangle', vol: 0.06, tap: 0.03 }),
    drop: () => { tone(500, 0.06, { to: 260, vol: 0.09 }); tone(160, 0.1, { type: 'triangle', vol: 0.05, at: 0.03 }); },
    copy: () => [1568, 2093].forEach((f, i) => tone(f, 0.05, { vol: 0.05, at: i * 0.04 })),
    trash: () => tone(260, 0.16, { to: 110, type: 'sawtooth', vol: 0.03 }),
    deny: () => { tone(220, 0.08, { type: 'square', vol: 0.03 }); tone(185, 0.12, { type: 'square', vol: 0.03, at: 0.08 }); },
    slide: () => tone(900 * jitter(0.1), 0.015, { type: 'triangle', vol: 0.025 }),
    keyDel: () => tone(1300 * jitter(0.2), 0.03, { to: 1000, type: 'triangle', vol: 0.03 }),
    keyEnter: () => tone(1100, 0.04, { to: 800, type: 'triangle', vol: 0.05 }),
    remove: () => { tone(900, 0.07, { to: 300, type: 'triangle', vol: 0.06 }); tone(1800, 0.03, { vol: 0.025, at: 0.01 }); },
    // Agent thinking (a soft questioning lift), answer text streaming in, and a fresh answer arriving
    think: () => { tone(392, 0.14, { to: 440, vol: 0.05 }); tone(587, 0.18, { to: 622, vol: 0.04, at: 0.12 }); },
    stream: () => tone(2100 * jitter(0.15), 0.02, { vol: 0.02 }),
    // While the model thinks: a soft, slightly wandering two-note murmur, repeated (see thinkingHum)
    hum: () => { const f = [440, 494, 523, 587][Math.floor(secureRandom() * 4)]; tone(f, 0.22, { to: f * 1.03, vol: 0.035 }); tone(f * 1.5, 0.26, { to: f * 1.5 * 0.98, type: 'triangle', vol: 0.02, at: 0.14 }); },
    answer: () => { tone(784, 0.1, { vol: 0.07 }); tone(1175, 0.16, { vol: 0.06, at: 0.07 }); },
  };
  type Sound = keyof typeof SOUNDS;
  // Fast repeating sounds (typing, tool lines) are spaced out so they stay ticks and don't buzz.
  const GAP: Partial<Record<Sound, number>> = { key: 18, keyDel: 18, keyEnter: 18, tool: 40, rowHover: 45, slide: 35, stream: 90, remove: 70, trash: 200, drop: 150 };
  const last: Partial<Record<Sound, number>> = {};
  const AMBIENT = new Set<Sound>(['key', 'keyDel', 'keyEnter', 'stream', 'hum', 'tool', 'rowHover', 'hover', 'slide']);
  // Left–right position of the last press, hover or focused box, as a gentle pan (±0.35 at the window edges).
  let place = 0;
  let placeAt = -Infinity;
  const setPlace = (x: number) => { place = Math.max(-1, Math.min(1, (x / Math.max(1, innerWidth)) * 2 - 1)) * 0.35; placeAt = performance.now(); };
  document.addEventListener('pointerdown', e => setPlace(e.clientX), { capture: true, passive: true });
  document.addEventListener('pointerover', e => { if (e.pointerType === 'mouse') setPlace(e.clientX); }, { capture: true, passive: true });
  document.addEventListener('focusin', e => {
    const r = (e.target as Element).getBoundingClientRect?.();
    if (r && r.width) setPlace(r.left + Math.min(r.width / 2, 200));
  }, true);
  document.addEventListener('keydown', () => { placeAt = performance.now(); }, { capture: true, passive: true });

  function play(name: Sound): void {
    if (!on || !volume || document.hidden) return;
    // Silent while Breeze is starting: start-up restores tabs and focuses the editor, which would otherwise
    // tick and chirp before you have touched anything.
    if (document.documentElement.hasAttribute('data-starting')) return;
    if (!ctx) unlock(); // a sound asked for before the first gesture (or after the context was lost)
    if (!ctx) return;
    const now = performance.now();
    const gap = GAP[name];
    if (gap) {
      if (now - (last[name] ?? -Infinity) < gap) return;
      last[name] = now;
    }
    // Background sounds (typing, streaming, the thinking hum, hovers) don't count as a control's own sound, or a
    // click or focus landing next to one would stay silent.
    if (!AMBIENT.has(name)) lastAt = now;
    anyAt = now;
    // Leans toward where you just clicked or typed; a sound nobody asked for (an agent answering) sits centre.
    panNow = now - placeAt < 1500 ? place : 0;
    dryNow = AMBIENT.has(name);
    // Chromium suspends an idle context (and Windows can interrupt one when the audio device changes). Notes
    // scheduled while it is paused would land in the past and be dropped, so they wait for it to run again.
    if (ctx.state !== 'running') {
      const c = ctx;
      c.resume().then(() => { if (c.state === 'running') SOUNDS[name](); }).catch(() => { ctx = null; master = null; });
      return;
    }
    SOUNDS[name]();
  }

  // The menu item mutes; the slider in Settings → General sets the level (0 is silent).
  function toggle(): void {
    unlock();
    on = !on;
    store.set('breeze.sound', on);
    play('tick');
  }
  function setVolume(v: number): void {
    unlock();
    volume = Math.max(0, Math.min(100, Math.round(v)));
    store.set('breeze.volume', volume);
    if (volume && !on) { on = true; store.set('breeze.sound', on); }
    if (master) master.gain.value = gainFor(volume);
  }

  // Everything you can press makes a sound that fits what it is. The kind is read before the click lands (a switch
  // still shows its old state then); it plays after, unless the control's own handler already made a sound.
  const KINDS: [string, Sound | ((el: Element) => Sound)][] = [
    ['.switch, [role="switch"], input[type="checkbox"], input[type="radio"]', el => (el.getAttribute('aria-checked') === 'true' || (el as HTMLInputElement).checked) ? 'toggleOff' : 'toggleOn'],
    ['[data-close], .set-close', 'close'],
    // Closing a tab or dropping a chip is a removal: its sound plays on the press, not after the fold-away.
    ['[data-close-tab], .tab-close, .term-tab-close, .attachment-del, [data-mi-del], .x-btn', 'remove'],
    ['.menu-item', el => el.classList.contains('has-sub') ? 'tick' : 'select'],
    ['.tab, [role="tab"], .agent-tab, [data-set-tab], .seg button', 'tab'],
    // Picking one of a set (Home's agent cards): the same sound as choosing from a menu.
    ['[role="radio"]', 'select'],
    ['[data-copy], .copy-btn', 'copy'],
    ['a[href]', 'link'],
    ['.tree-item, .row, [role="option"], [role="menuitem"], .chat-file-chip, .card', 'row'],
    ['button, [role="button"], summary, select, label, .btn, .pill-btn', 'click'],
    // Source control rows (changes, checkpoints): after buttons, so a row's own stage/discard buttons still click.
    ['.scm-row, .commit, .commit-detail-row', 'row'],
  ];
  const kindOf = (t: EventTarget | null): Sound | null => {
    if (!(t instanceof Element)) return null;
    // Hold-to-delete buttons make their own sound when the hold completes; the release's click stays silent.
    if (t.closest('[data-hold]')) return null;
    for (const [sel, s] of KINDS) {
      const el = t.closest(sel);
      if (!el) continue;
      if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return null; // denied on the press
      return typeof s === 'function' ? s(el) : s;
    }
    return null;
  };
  // What was pressed, read on the press: a control that redraws itself under the pointer hands the click to its
  // parent, which would otherwise make no sound.
  let downKind: Sound | null = null;
  let downAt = -Infinity;
  document.addEventListener('click', e => {
    const kind = kindOf(e.target) ?? (performance.now() - downAt < 800 ? downKind : null);
    downKind = null;
    if (!kind) return;
    // Close buttons often stop the click from bubbling, so a removal sounds right here instead of after.
    if (kind === 'remove') { play('remove'); return; }
    // Played once the click has been handled (many handlers stop it bubbling, so this can't wait for it to come
    // back up), unless the control made its own sound meanwhile.
    const at = performance.now();
    setTimeout(() => { if (lastAt < at) play(kind); }, 0);
  }, true);
  // Disabled buttons swallow clicks, so they're caught on the press instead.
  document.addEventListener('pointerdown', e => {
    if (e.button === 0) { downKind = kindOf(e.target); downAt = performance.now(); }
    const el = (e.target as Element).closest?.('button:disabled, [aria-disabled="true"]');
    if (el && e.button === 0) play('deny');
  }, true);
  // Text boxes chirp on focus; dropdown pickers and sliders answer their changes.
  document.addEventListener('focusin', e => {
    const el = e.target as HTMLElement;
    // A box focused for you as something closes (the next file after a tab's X) stays quiet.
    if (el.matches?.('input:not([type="range"], [type="checkbox"], [type="radio"]), textarea, [contenteditable="true"]') && performance.now() - lastAt > 120 && performance.now() - (last.remove ?? -Infinity) > 600) play('focus');
  });
  document.addEventListener('change', e => { if ((e.target as Element).matches?.('select')) play('select'); });
  document.addEventListener('input', e => { if ((e.target as Element).matches?.('input[type="range"]')) play('slide'); });
  // Caught on the way down: some drop zones stop the event before it would bubble back up here.
  document.addEventListener('drop', () => play('drop'), true);
  // Typing anywhere in Breeze ticks (the editor's own ticks fall inside the same gap, so they never double up).
  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat && e.key !== 'Backspace') return;
    const el = e.target as HTMLElement;
    if (!el.matches?.('input:not([type="range"], [type="checkbox"], [type="radio"]), textarea, [contenteditable="true"], [contenteditable=""]')) return;
    if (e.key === 'Backspace' || e.key === 'Delete') play('keyDel');
    else if (e.key === 'Enter') play('keyEnter');
    else if (e.key.length === 1) play('key');
  }, true);
  // Things that leave the page (a tab, a chip, a toast, a message) make a small falling sound. A redraw that takes
  // items out and puts as many back in the same moment is not a removal, and text edits are never counted.
  const REMOVABLE = '.tab, .agent-tab, .term-tab, .attachment-chip, .chat-file-chip, .chat-img-wrap, .toast, .msg, .card, .tool-line, .run-done';
  const count = (nodes: NodeList[]) => {
    let n = 0;
    for (const list of nodes) for (const node of list) {
      if (!(node instanceof Element)) continue;
      if (node.matches(REMOVABLE)) n++;
      n += node.querySelectorAll(REMOVABLE).length;
    }
    return n;
  };
  const removals = new MutationObserver(all => {
    // Code lines and terminal rows are redrawn constantly; nothing there is a removal worth hearing.
    const records = all.filter(r => !(r.target as Element).closest?.('.editor, .term-body'));
    if (!records.length) return;
    const gone = count(records.map(r => r.removedNodes));
    if (!gone || gone <= count(records.map(r => r.addedNodes))) return;
    // The control that removed it already made its sound (a tab's X sounds on the press, before the fold-away ends).
    if (performance.now() - anyAt < 120 || performance.now() - (last.remove ?? -Infinity) < 700 || performance.now() - (last.trash ?? -Infinity) < 1500) return;
    if (records.some(r => (r.target as Element).closest?.('#menuRoot, #modalRoot, .menu'))) return; // menus and dialogs have their own close sounds
    play('remove');
  });
  addEventListener('DOMContentLoaded', () => removals.observe(document.body, { childList: true, subtree: true }));
  if (document.body) removals.observe(document.body, { childList: true, subtree: true });
  document.addEventListener('copy', () => play('copy'));
  // Buttons hover like the website's; menu rows and list rows give a fainter tick. Only when the pointer itself
  // moved onto them: the page appearing under a still pointer (at start-up, behind the loading screen) or a menu
  // opening beneath it fires the same event, and stays quiet.
  let movedAt = -Infinity;
  document.addEventListener('pointermove', e => { if (e.movementX || e.movementY) movedAt = performance.now(); }, { capture: true, passive: true });
  document.addEventListener('pointerover', e => {
    if (e.pointerType !== 'mouse' || performance.now() - movedAt > 120) return;
    const t = e.target as Element;
    // Home's links, recent projects, rail and icon buttons too.
    const btn = t.closest?.('.btn, #onboard :is(.icon-btn, .home-link, .recent-open, .act-btn, #homeProfile)');
    if (btn) { if (!btn.contains(e.relatedTarget as Node | null)) play('hover'); return; }
    const row = t.closest?.('.menu-item, [role="option"], .tree-item, .scm-row, .commit, .commit-detail-row');
    if (row && !row.contains(e.relatedTarget as Node | null)) play('rowHover');
  });

  return { play, toggle, setVolume, get on() { return on; }, get volume() { return on ? volume : 0; } };
})();

