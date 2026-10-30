/* ================= Init ================= */
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
  // And the backdrop video's first frame, so its 9MB load and decoder start-up don't land in the fade (3s at most).
  const video = $<HTMLVideoElement>('.ob-video');
  await Promise.all([
    ...[...document.querySelectorAll<HTMLImageElement>('#ide:not(.hidden) img, #box:not(.hidden) img, #onboard:not(.hidden) img')]
      .map(img => img.decode().catch(() => undefined)),
    video.readyState >= 2 || new Promise(done => {
      video.addEventListener('loadeddata', done, { once: true });
      video.addEventListener('error', done, { once: true });
      setTimeout(done, 3000);
    }),
  ]);
  startupWaits = null;
  // One frame so the last renders are painted before start-up counts as done.
  await new Promise(r => { requestAnimationFrame(() => r(undefined)); setTimeout(r, 100); }); // a hidden window has no frames
}
// Every launch opens behind the launch light (see launch.css); after setup it lifts straight onto Home, so a returning
// user never sees the welcome flash by. A first run's welcome rises in on the same sky as the light lifts; sounds stay
// off until start-up has settled (8s at most).
{
  if (appState.onboarded) goStep(STEP.home);
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
      reveal(true);
      // Let the welcome's first frame (its newly shown logo and text) paint before the fade starts, not during it.
      await settleFrames(500);
      // The sky's drift holds still through the fade: under Home's glass cards every moving frame re-blurs them all.
      document.documentElement.setAttribute('data-handoff', '');
      await api.win.launchFade().catch(() => undefined);
      document.documentElement.removeAttribute('data-handoff');
    })().finally(launched);
  } else {
    // Browser: the whole intro plays in the page. It lifts 1.8s after the swirl has fully appeared; animations only
    // advance while the page draws frames, so a clock-time cap makes sure it never stays up for good.
    const logoIn = $('.launch-logo', launch).getAnimations()[0]?.finished.catch(() => undefined) ?? Promise.resolve();
    void Promise.race([logoIn.then(() => wait(1800)), wait(6000)]).then(() => {
      reveal(true);
      launched();
      launch.classList.add('done');
      launch.addEventListener('animationend', e => { if (e.target === launch) launch.remove(); });
      setTimeout(() => launch.remove(), 1500); // the lift-off never got a frame to play in
    });
  }
}
