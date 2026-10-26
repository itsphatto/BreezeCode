const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const nav = document.querySelector('.nav'); // only the landing page has one
if (nav) document.documentElement.style.setProperty('--nav-h', `${nav.offsetHeight + parseFloat(getComputedStyle(nav).marginTop)}px`);

// Pinned hero: while the first ~1.6 screens scroll past, the hero holds still and plays its reveal (styles.css).
// shortcut: decided once at load, so crossing the size breakpoint needs a reload; fine for a landing page.
const hero = document.querySelector('.hero');
if (hero && matchMedia('(min-width: 768px) and (min-height: 560px) and (prefers-reduced-motion: no-preference)').matches) {
  hero.classList.add('is-pinned');
  const update = () => {
    const run = hero.offsetHeight - innerHeight;
    const p = Math.min(1, Math.max(0, -hero.getBoundingClientRect().top / run));
    hero.style.setProperty('--e', (p * p * (3 - 2 * p)).toFixed(4)); // smoothstep: eases in and out
    hero.classList.toggle('copy-gone', p > 0.5); // faded words stop taking clicks
  };
  addEventListener('scroll', update, { passive: true });
  addEventListener('resize', update);
  update();
}

// Smooth, eased scrolling for the wheel and for in-page links. Skipped when the visitor asks for less motion.
// When GSAP is here it drives Lenis from its own ticker so pinned sections and smooth scroll share one clock.
let lenis;
if (window.Lenis && !reduceMotion) {
  lenis = new Lenis({ autoRaf: !window.gsap, lerp: 0.1, anchors: true });
  // Fonts and images change the page height while loading; measure again so the last link lands exactly.
  addEventListener('load', () => lenis.resize());
}

// Scroll animations. Everything starts visible in the HTML; GSAP only hides what it is about to play in,
// and gsap.matchMedia undoes all of it if the visitor turns on reduced motion or the screen crosses a breakpoint.
if (window.gsap && window.ScrollTrigger && window.SplitText) {
  gsap.registerPlugin(ScrollTrigger, SplitText);
  if (lenis) {
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add((t) => lenis.raf(t * 1000));
    gsap.ticker.lagSmoothing(0);
  }

  const out = 'expo.out';
  const lines = (el, vars) => SplitText.create(el, {
    type: 'lines',
    mask: 'lines',
    autoSplit: true, // re-split when fonts load or the width changes; returning the tween keeps its progress
    onSplit: (self) => gsap.from(self.lines, { yPercent: 110, duration: 1.1, ease: out, stagger: 0.09, ...vars }),
  });
  // Play a group in as it scrolls into view, in batches so a row that arrives together staggers together.
  const reveal = (targets, from, play) => {
    if (!targets.length) return;
    gsap.set(targets, from);
    ScrollTrigger.batch(targets, { start: 'top 88%', once: true, onEnter: play });
  };
  const rise = (els, vars) => gsap.to(els, { y: 0, autoAlpha: 1, duration: 0.9, ease: out, stagger: 0.08, ...vars });

  gsap.matchMedia().add({
    motion: '(prefers-reduced-motion: no-preference)',
    wide: '(min-width: 768px) and (min-height: 560px)',
  }, ({ conditions: { motion, wide } }) => {
    if (!motion) return;
    // Created top to bottom so each trigger measures after the pins above it.

    // Hero: the headline rises line by line, then the words and buttons under it, then the screenshot.
    lines('.hero h1', { delay: 0.1 });
    gsap.fromTo('.hero-copy > :not(h1)', { y: 18, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 1, ease: out, stagger: 0.08, delay: 0.45 });
    gsap.set('.hero-copy > h1', { autoAlpha: 1 }); // the lines carry this entrance, not the block
    gsap.fromTo('.hero-shot', { autoAlpha: 0 }, { autoAlpha: 1, duration: 1.4, ease: 'power2.out', delay: 0.7 });

    // Headings rise out of a mask; the paragraph under each follows.
    gsap.utils.toArray('.section-head h2, .compare h3, .extras-title, .download h2').forEach((h) => {
      lines(h, { scrollTrigger: { trigger: h, start: 'top 88%' } });
    });
    reveal(gsap.utils.toArray('.section-head p, .compare > p, .note'), { y: 20, autoAlpha: 0 }, (els) => rise(els, { delay: 0.2 }));

    // Pillars and extras: each hairline draws across, then its words settle under it.
    const ruled = (sel) => {
      const items = gsap.utils.toArray(sel);
      const kids = (els) => els.flatMap((el) => [...el.children]);
      gsap.set(kids(items), { y: 20, autoAlpha: 0 });
      reveal(items, { '--rule': '0%' }, (els) => {
        gsap.to(els, { '--rule': '100%', duration: 1.2, ease: 'expo.inOut', stagger: 0.12 });
        rise(kids(els), { delay: 0.25 });
      });
    };
    ruled('.pillar');

    // Pillar icons draw themselves in, then act out their idea: the eye blinks, the arrows trade places,
    // the lock clicks shut, the spinner turns. Hovering a pillar plays it again.
    const gestures = {
      eye: (svg) => gsap.to(svg, { scaleY: 0.1, duration: 0.12, ease: 'power2.in', yoyo: true, repeat: 1 }),
      swap: ({ children: [a, b] }) => gsap.timeline({ defaults: { duration: 0.28, ease: 'power2.inOut', yoyo: true, repeat: 1 } })
        .to(a, { x: -3 }).to(b, { x: 3 }, 0),
      lock: ({ children: [, shackle] }) => gsap.timeline().to(shackle, { y: -3, duration: 0.2, ease: 'power2.out' })
        .to(shackle, { y: 0, duration: 0.5, ease: 'back.out(3)' }),
      spark: (svg) => gsap.to(svg, { rotation: '+=180', duration: 0.9, ease: 'power3.inOut' }),
    };
    const icons = gsap.utils.toArray('.pillar .ic');
    const play = (svg) => {
      if (!svg.gesture?.isActive()) svg.gesture = gestures[svg.dataset.icon](svg);
    };
    for (const el of icons.flatMap((svg) => [...svg.children])) {
      const len = el.getTotalLength();
      gsap.set(el, { strokeDasharray: len, strokeDashoffset: len });
    }
    ScrollTrigger.batch(icons, {
      start: 'top 88%',
      once: true,
      onEnter: (els) => els.forEach((svg, i) => {
        gsap.timeline({ delay: 0.3 + i * 0.12, onComplete: () => { svg.drawn = true; play(svg); } })
          .to(svg.children, { strokeDashoffset: 0, duration: 0.8, ease: 'power2.inOut', stagger: 0.12 });
      }),
    });
    const hovers = icons.map((svg) => {
      const pillar = svg.closest('.pillar');
      const onHover = () => play(svg);
      pillar.addEventListener('mouseenter', onHover);
      return () => pillar.removeEventListener('mouseenter', onHover);
    });
    // Idle: while the pillars are on screen the icons take turns, one every 1.2 s, and rest once scrolled away.
    let turn = 0;
    const idle = gsap.timeline({ repeat: -1, paused: true }).call(() => {
      const svg = icons[turn++ % icons.length];
      if (svg.drawn) play(svg);
    }, null, 1.2);
    ScrollTrigger.create({ trigger: '.pillars', onToggle: (self) => (self.isActive ? idle.play() : idle.pause()) });
    reveal(gsap.utils.toArray('.table tr'), { y: 16, autoAlpha: 0 }, (els) => rise(els, { stagger: 0.06 }));

    // Features: pin the section and turn vertical scroll into a sideways ride along the cards.
    const section = document.querySelector('.hs');
    if (wide && section) {
      section.classList.add('is-pinned');
      const pin = section.querySelector('.hs-pin');
      const track = section.querySelector('.hs-track');
      const distance = () => Math.max(0, track.scrollWidth - (pin.clientWidth - 2 * parseFloat(getComputedStyle(pin).paddingLeft)));
      const ride = gsap.to(track, {
        x: () => -distance(),
        ease: 'none', // linear, so a scroll of N px moves the row N px
        scrollTrigger: { trigger: pin, pin: true, start: 'top top', end: () => `+=${distance()}`, scrub: true, invalidateOnRefresh: true },
      });

      // Each card lifts into place as it slides in, and its screenshot drifts the other way for depth.
      gsap.utils.toArray('.feature', section).forEach((card) => {
        gsap.fromTo(card, { yPercent: 10, autoAlpha: 0.2 }, {
          yPercent: 0, autoAlpha: 1, ease: 'power2.out',
          scrollTrigger: { trigger: card, containerAnimation: ride, start: 'left 100%', end: 'left 62%', scrub: true },
        });
        const img = card.querySelector('.shot img');
        if (img) gsap.fromTo(img, { scale: 1.12, xPercent: 5 }, {
          xPercent: -5, ease: 'none',
          scrollTrigger: { trigger: card, containerAnimation: ride, start: 'left right', end: 'right left', scrub: true },
        });
      });
    } else if (section) {
      reveal(gsap.utils.toArray('.feature', section), { y: 24, autoAlpha: 0 }, (els) => rise(els));
    }
    ruled('.extra');
    reveal(gsap.utils.toArray('.langs img'), { scale: 0.4, autoAlpha: 0 },
      (els) => gsap.to(els, { scale: 1, autoAlpha: 1, duration: 0.6, ease: 'back.out(2)', stagger: 0.05, delay: 0.5 }));

    // Download: the light rises from the bottom as the finale arrives, then the icon and button land.
    gsap.fromTo('.finale', { '--glow': 0 }, {
      '--glow': 1, ease: 'none',
      scrollTrigger: { trigger: '.finale', start: 'top bottom', end: 'top 15%', scrub: true },
    });
    reveal(gsap.utils.toArray('.download > img'), { scale: 0.6, rotation: -12, autoAlpha: 0 },
      (els) => gsap.to(els, { scale: 1, rotation: 0, autoAlpha: 1, duration: 1.1, ease: out }));
    reveal(gsap.utils.toArray('.download > p, .download .cta'), { y: 20, autoAlpha: 0 }, (els) => rise(els, { delay: 0.25 }));

    return () => {
      section?.classList.remove('is-pinned');
      hovers.forEach((off) => off());
    };
  });
}

// FAQ: answers slide open and shut instead of snapping. The height animates from wherever it is now,
// so a second click mid-animation reverses smoothly. Native <details> still works without this.
if (!reduceMotion) document.querySelectorAll('details.faq').forEach((faq) => {
  const summary = faq.querySelector('summary');
  const answer = faq.querySelector('.faq-a');
  const ease = 'cubic-bezier(.16, 1, .3, 1)';
  let anim;
  summary.addEventListener('click', (e) => {
    e.preventDefault();
    const from = faq.offsetHeight;
    const closing = faq.open && faq.dataset.state !== 'closing';
    anim?.cancel();
    faq.open = true; // keep the answer in the layout while it animates
    const to = closing ? summary.offsetHeight + faq.offsetHeight - faq.clientHeight : faq.offsetHeight;
    faq.dataset.state = closing ? 'closing' : 'opening';
    faq.style.overflow = 'hidden';
    anim = faq.animate({ height: [`${from}px`, `${to}px`] }, { duration: closing ? 260 : 380, easing: ease });
    if (!closing) answer.animate({ opacity: [0, 1], transform: ['translateY(-6px)', 'none'] }, { duration: 380, easing: ease });
    anim.onfinish = () => {
      if (closing) faq.open = false;
      faq.style.overflow = '';
      delete faq.dataset.state;
      anim = null;
    };
  });
});

// Footer links open in a new tab; replay the press animation on every click (styles.css .is-opening).
document.querySelectorAll('.footer a[target="_blank"]').forEach((a) => {
  a.addEventListener('click', () => {
    a.classList.remove('is-opening');
    void a.offsetWidth; // restart the animation if it is still running
    a.classList.add('is-opening');
  });
  a.addEventListener('animationend', () => a.classList.remove('is-opening'));
});

// Point download buttons straight at the latest installer and show its version and size.
// If GitHub can't be reached, the buttons keep linking to the releases page.
if (document.querySelector('[data-download]')) {
  fetch('https://api.github.com/repos/itsphatto/BreezeCode/releases/latest')
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((release) => {
      const exe = release.assets.find((a) => a.name.endsWith('.exe'));
      if (!exe) return;
      document.querySelectorAll('[data-download]').forEach((a) => { a.href = exe.browser_download_url; });
      document.querySelectorAll('[data-version]').forEach((el) => { el.textContent = release.tag_name; });
      document.querySelectorAll('[data-size]').forEach((el) => { el.textContent = `${Math.round(exe.size / 1048576)} MB`; });
    })
    .catch(() => {});
}
