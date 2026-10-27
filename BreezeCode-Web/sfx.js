// Breeze Code sound effects: tiny synthesized blips (Web Audio, no audio files) and the site's click/hover sounds.
// The IDE demo calls window.sfx.play(name) for its own events. Nothing plays until the visitor's first click or key press.
(() => {
  const KEY = 'bz-sound';
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let muted = false;
  // There is no mute button any more, but a visitor who muted before stays muted.
  try { muted = localStorage.getItem(KEY) === 'off'; } catch { /* storage blocked: default to on */ }

  let ctx = null;
  let master = null;
  let unlocked = false;

  // Browsers only allow audio after a gesture, so the context is made on the first one.
  function unlock() {
    if (unlocked) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
      unlocked = true;
    } catch { /* no audio available */ }
  }
  ['pointerdown', 'keydown'].forEach(t => addEventListener(t, unlock, { capture: true, passive: true }));

  // One blip: a pitch (optionally sliding) with a fast attack and a fade-out.
  function tone(freq, dur, { type = 'sine', vol = 0.1, to = freq, at = 0 } = {}) {
    const t0 = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to !== freq) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  // A plane flying past from the left to the right: engine noise and a whine that swell as it nears and drop in pitch
  // once it has passed (the Doppler effect), panning across the speakers like the photo wiping in.
  function plane() {
    const dur = 2.6;
    const t0 = ctx.currentTime;
    const peak = t0 + dur * 0.5;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    // Roar: noise through a low-pass that closes after the plane passes.
    const roar = ctx.createBiquadFilter();
    roar.type = 'lowpass';
    roar.Q.value = 0.6;
    roar.frequency.setValueAtTime(500, t0);
    roar.frequency.exponentialRampToValueAtTime(1500, peak);
    roar.frequency.exponentialRampToValueAtTime(350, t0 + dur);
    // Whine: a turbine tone that falls in pitch as it goes by.
    const whine = ctx.createOscillator();
    whine.type = 'sawtooth';
    whine.frequency.setValueAtTime(440, t0);
    whine.frequency.setValueAtTime(420, peak - 0.1);
    whine.frequency.exponentialRampToValueAtTime(290, t0 + dur);
    const whineLp = ctx.createBiquadFilter();
    whineLp.type = 'lowpass';
    whineLp.frequency.value = 1100;
    const whineGain = ctx.createGain();
    whineGain.gain.value = 0.07;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(1, peak);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    noise.connect(roar).connect(g);
    whine.connect(whineLp).connect(whineGain).connect(g);
    if (ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      pan.pan.setValueAtTime(-0.95, t0);
      pan.pan.linearRampToValueAtTime(0.95, t0 + dur);
      g.connect(pan).connect(master);
    } else g.connect(master);
    noise.start(t0);
    whine.start(t0);
    whine.stop(t0 + dur);
  }

  const jitter = n => 1 + (Math.random() - 0.5) * n;
  const SOUNDS = {
    click: () => tone(1500 * jitter(0.06), 0.05, { to: 900, vol: 0.09 }),
    hover: () => tone(2400, 0.025, { vol: 0.025 }),
    key: () => tone(1900 * jitter(0.25), 0.022, { type: 'triangle', vol: 0.035 }),
    tab: () => tone(520, 0.08, { to: 760, vol: 0.09 }),
    close: () => tone(720, 0.08, { to: 420, vol: 0.08 }),
    menu: () => tone(420, 0.09, { to: 640, type: 'triangle', vol: 0.07 }),
    whoosh: () => { tone(300, 0.16, { to: 900, type: 'triangle', vol: 0.05 }); tone(150, 0.16, { to: 450, vol: 0.05 }); },
    save: () => { tone(660, 0.12, { vol: 0.09 }); tone(990, 0.2, { vol: 0.09, at: 0.09 }); },
    tick: () => tone(1250, 0.03, { type: 'triangle', vol: 0.06 }),
    ping: () => tone(880, 0.16, { vol: 0.08, to: 920 }),
    // Guided tour and agent chat
    coach: () => { tone(784, 0.14, { vol: 0.07 }); tone(1175, 0.24, { vol: 0.06, at: 0.1 }); },
    send: () => tone(480, 0.12, { to: 1000, type: 'triangle', vol: 0.07 }),
    msg: () => tone(640, 0.09, { to: 470, vol: 0.07 }),
    tool: () => tone(1500 * jitter(0.1), 0.03, { type: 'triangle', vol: 0.035 }),
    plan: () => [523, 659, 784].forEach((f, i) => tone(f, 0.16, { vol: 0.07, at: i * 0.08 })),
    approve: () => { tone(523, 0.12, { type: 'triangle', vol: 0.08 }); tone(784, 0.2, { type: 'triangle', vol: 0.08, at: 0.07 }); },
    build: () => tone(200, 0.35, { to: 620, type: 'sawtooth', vol: 0.03 }),
    success: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i === 3 ? 0.4 : 0.14, { vol: 0.08, at: i * 0.09 })),
    plane,
    launch: () => { tone(330, 0.16, { to: 660, type: 'triangle', vol: 0.08 }); tone(1320, 0.05, { vol: 0.05, at: 0.14 }); },
  };
  // Fast repeating sounds (typing, tool lines) are spaced out so they stay ticks and don't buzz.
  const GAP = { key: 30, tool: 40 };
  const last = {};

  function play(name) {
    if (muted || !unlocked || document.hidden || reduceMotion.matches) return;
    if (ctx.state === 'suspended') ctx.resume();
    const gap = GAP[name];
    if (gap) {
      const now = performance.now();
      if (now - (last[name] ?? -Infinity) < gap) return;
      last[name] = now;
    }
    SOUNDS[name]?.();
  }

  /* ----- Site sounds: the IDE demo makes its own, so it is left out here ----- */
  const inDemo = el => el.closest('#bzDemo');
  document.addEventListener('click', e => {
    const el = e.target.closest('a, button, summary');
    if (el && !inDemo(el)) play('click');
  }, true);
  document.addEventListener('pointerover', e => {
    if (e.pointerType !== 'mouse') return;
    const el = e.target.closest('.btn');
    if (el && !inDemo(el) && !el.contains(e.relatedTarget)) play('hover');
  });

  window.sfx = { play };
})();
