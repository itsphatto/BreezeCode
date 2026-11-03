/* ================= Init ================= */
// Ctrl+R reloads the window: the screen it was on (the editor or Breeze Space) comes back instead of Home. The screen
// is kept for this window's session only (swapScreen), so a fresh launch still opens on Home.
const reloadedMode: WorkMode | null = (() => {
  if (!appState.onboarded) return null;
  try {
    const s = sessionStorage.getItem(SCREEN_KEY);
    return s === '#ide' || s === '#debug' ? 'ide' : s === '#box' ? 'box' : null; // a reload ends the debug session: back to the editor
  } catch { return null; }
})();
// Opened from Explorer: straight into the editor with the right-clicked file (setup still comes first on a first run).
function showLaunched(info: LaunchInfo): void {
  if (info.open) openFile(info.open);
  if (appState.onboarded) enterMode('ide');
}
async function boot(): Promise<void> {
  void holdStartup(Promise.all([
    document.fonts.load('400 12px "Instrument Sans"'),
    document.fonts.load('500 12px "Instrument Sans"'),
    document.fonts.load('600 11px "Instrument Sans"'),
    document.fonts.load('700 12px "Instrument Sans"'),
    document.fonts.ready,
  ]));
  buildMenubar();
  applyLayout();
  showView(layout.view);
  renderTree(); renderTabs(); renderEditor(); renderAgents(); renderPreview(); emptyChat(); renderScm(); renderBranch(); bindToasts(); initTooltip();
  void holdStartup(refreshGit());
  renderDetection();
  setVibeArmed(appState.vibeArmed);
  if (appState.discord) { renderDiscord('off', 'Connecting to Discord'); queueDiscord(); }
  if (appState.devMode) background(api.win.devIcon(true));
  // The main process remembers who signed in; it wins over the renderer's copy.
  const signed = await api.auth.user().catch(() => null);
  if (signed || isDesktop) { user = signed; appState.user = signed; saveApp(); }
  await refreshAccounts();
  if (!appState.onboarded) goStep(step);
  booted = true;
  updateActIndicator(true);
  const info = await api.fs.restore().catch(() => null);
  restoringWorkspace = false;
  if (info) await loadWorkspace(info);
  else { term.cwd = await api.term.cwd(); renderPs(); }
  if (info && 'launched' in info) showLaunched(info);
  else if (reloadedMode) enterMode(reloadedMode);
  renderTree(); renderScm();
  if (step === STEP.home) renderHome();
  renderBoxFolder();
  // Wait for what the startup above set going, then for every picture on screen (logos, avatar) to be decoded.
  // Work started by that work (a git refresh queuing another) is caught by looping until nothing new was added.
  for (let seen = 0; startupWaits && seen < startupWaits.length;) {
    const batch = startupWaits.slice(seen);
    seen = startupWaits.length;
    await Promise.all(batch);
  }
  // And the pictures on the screen that's showing, decoded so they don't land in the fade.
  await Promise.all([...document.querySelectorAll<HTMLImageElement>('#ide:not(.hidden) img, #box:not(.hidden) img, #onboard:not(.hidden) img')]
    .map(img => img.decode().catch(() => undefined)));
  startupWaits = null;
  // One frame so the last renders are painted before start-up counts as done.
  await new Promise(r => { requestAnimationFrame(() => r(undefined)); setTimeout(r, 100); }); // a hidden window has no frames
}
// Every launch opens behind the launch light (see launch.css); after setup it lifts straight onto Home, so a returning
// user never sees the welcome flash by. A first run's welcome rises in on the same sky as the light lifts; sounds stay
// off until start-up has settled (8s at most).
{
  if (appState.onboarded) goStep(STEP.home);
  if (reloadedMode) swapScreen(reloadedMode === 'ide' ? '#ide' : '#box'); // before start-up, so Home never flashes by
  const welcome = $('.ob-step[data-step="0"]');
  const starting = boot();
  background(starting);
  // "Open with Breeze Code" while Breeze is already running. Start-up opens its own launch path, so this waits for it.
  api.fs.onLaunchRequest(dir => background((async () => {
    await starting.catch(() => undefined);
    if (rootInfo?.root !== dir && !(await confirmDiscard())) return;
    const info = await api.fs.openLaunch();
    if (!info) return;
    if (rootInfo?.root !== info.root) await loadWorkspace(info);
    showLaunched(info);
  })()));
  void Promise.race([starting.catch(() => undefined), new Promise(done => setTimeout(done, 8000))])
    .then(() => document.documentElement.removeAttribute('data-starting'));
  const launch = $('#launch');
  const wait = (ms: number) => new Promise(done => setTimeout(done, ms));
  // The app comes out of hiding and the welcome rises in; greet: Home's greeting blurs into focus (once: a later visit
  // to Home just shows it).
  const reveal = (greet: boolean) => {
    document.documentElement.removeAttribute('data-launching');
    welcome.classList.remove('ob-await');
    if (welcome.getClientRects().length) welcome.classList.add('ob-intro');
    if (!greet) return;
    const home = $('.home-step');
    home.classList.add('home-in');
    setTimeout(() => home.classList.remove('home-in'), 1200);
  };
  // The welcome's logo parks exactly where the launch left the swirl (middle of the window, launch.css's size and glow);
  // play() then morphs it into its place on the page. null when Home is up, or for reduced motion: there's nothing to morph.
  const parkLogo = (): Animation | null => {
    if (!welcome.getClientRects().length || matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
    const logo = $('.ob-logo', welcome), r = logo.getBoundingClientRect();
    const morph = logo.animate([
      {
        opacity: 1,
        transform: `translate(${innerWidth / 2 - r.left - r.width / 2}px, ${innerHeight / 2 - r.top - r.height / 2}px) scale(${150 / r.width})`,
        filter: 'drop-shadow(0 0 22px rgba(255, 255, 255, .45)) drop-shadow(0 6px 24px rgba(10, 30, 120, .35))',
      },
      { opacity: 1, transform: 'none', filter: 'none' },
    ], { duration: 700, easing: 'cubic-bezier(.77, 0, .175, 1)' });
    morph.pause();
    welcome.classList.add('ob-morph');
    return morph;
  };
  // Once the app is up: refresh the tool and agent status in the background (the cached result shows meanwhile).
  const launched = () => {
    launching = false;
    if (appState.onboarded) detectTools().catch(() => { /* shown in the setup card */ });
  };
  if (window.breeze) {
    // Desktop: the intro plays over the desktop in the splash window (main.js) while this window loads hidden. Once
    // start-up has finished and the intro has played through (about 3.9s in), this window comes up still see-through,
    // draws the welcome (or Home) until its frames come steadily, and only then fades in over the splash, so a slow
    // machine doesn't stutter through the fade. A reload has no splash.
    launch.remove();
    void (async () => {
      await Promise.race([starting.catch(() => undefined), wait(10000)]);
      await api.win.theme(theme).catch(() => undefined);
      const ran = await api.win.launchWait().catch(() => null);
      if (ran === null) { reveal(false); return; }
      const since = performance.now();
      document.documentElement.removeAttribute('data-launching');
      await api.win.launchShow().catch(() => undefined);
      await Promise.all([document.fonts.ready, settleFrames(2500)]);
      // The welcome sky's drifting light picks up where the splash's is, so the fade between them doesn't jump.
      const now = ran + performance.now() - since;
      $('.ob-sky').getAnimations({ subtree: true })
        .forEach(a => { if ((a as CSSAnimation).animationName === 'launch-drift') a.currentTime = now; });
      // The welcome fades in showing only the parked logo, lined up with the splash's; it morphs once the fade is done.
      const morph = parkLogo();
      if (!morph) reveal(true);
      // Let the welcome's first frame (its newly shown logo and text) paint before the fade starts, not during it.
      await settleFrames(500);
      // The sky's drift holds still through the fade: under Home's glass cards every moving frame re-blurs them all.
      document.documentElement.setAttribute('data-handoff', '');
      await api.win.launchFade().catch(() => undefined);
      document.documentElement.removeAttribute('data-handoff');
      if (morph) { reveal(true); morph.play(); }
    })().finally(launched);
  } else {
    // Browser: the whole intro plays in the page. It lifts 1.8s after the swirl has fully appeared; animations only
    // advance while the page draws frames, so a clock-time cap makes sure it never stays up for good.
    const logoIn = $('.launch-logo', launch).getAnimations()[0]?.finished.catch(() => undefined) ?? Promise.resolve();
    void Promise.race([logoIn.then(() => wait(1800)), wait(6000)]).then(() => {
      const morph = parkLogo();
      reveal(true);
      launched();
      // The welcome's sky matches the launch's, so the parked logo takes over from it without a seam.
      if (morph) { morph.play(); launch.remove(); return; }
      launch.classList.add('done');
      launch.addEventListener('animationend', e => { if (e.target === launch) launch.remove(); });
      setTimeout(() => launch.remove(), 1500); // the lift-off never got a frame to play in
    });
  }
}
