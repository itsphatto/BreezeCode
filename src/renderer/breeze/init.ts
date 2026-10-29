/* ================= Init ================= */
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
  renderTree(); renderScm();
  if (step === STEP.home) renderHome();
  renderBoxFolder();
  // Refresh the tool and agent status in the background; the cached result shows meanwhile.
  if (appState.onboarded) detectTools().catch(() => { /* shown in the setup card */ });
  // Wait for what the startup above set going, then for every picture on screen (logos, avatar) to be decoded.
  // Work started by that work (a git refresh queuing another) is caught by looping until nothing new was added.
  for (let seen = 0; startupWaits && seen < startupWaits.length;) {
    const batch = startupWaits.slice(seen);
    seen = startupWaits.length;
    await Promise.all(batch);
  }
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
  const welcome = $('.ob-step[data-step="0"]');
  const starting = boot();
  background(starting);
  void Promise.race([starting.catch(() => undefined), new Promise(done => setTimeout(done, 8000))])
    .then(() => document.documentElement.removeAttribute('data-starting'));
  const launch = $('#launch');
  const wait = (ms: number) => new Promise(done => setTimeout(done, ms));
  // The app comes out from hiding under the sky, the welcome rises in, and the light lifts off.
  const showApp = (lift: boolean) => {
    document.documentElement.removeAttribute('data-launching');
    welcome.classList.remove('ob-await');
    if (welcome.getClientRects().length) welcome.classList.add('ob-intro');
    if (!lift) { launch.remove(); return; }
    // Home's greeting blurs into focus as the light lifts (once: a later visit to Home just shows it).
    const home = $('.home-step');
    home.classList.add('home-in');
    setTimeout(() => home.classList.remove('home-in'), 1200);
    launch.classList.add('done');
    launch.addEventListener('animationend', e => { if (e.target === launch) launch.remove(); });
    setTimeout(() => launch.remove(), 1500); // the lift-off never got a frame to play in
  };
  if (window.breeze) {
    // Desktop: the intro plays over the desktop in the splash window (main.js) while this window loads hidden, showing
    // the intro's last frame. Once the intro has played through (about 3.9s in) this window takes over and lifts off;
    // a start-up still running by then finishes in the open. A reload has no splash, so the app just shows.
    launch.classList.add('held');
    void (async () => {
      await Promise.race([starting.catch(() => undefined), wait(3000)]);
      await api.win.theme(theme).catch(() => undefined);
      const ran = await api.win.launchWait().catch(() => null);
      if (ran === null) { showApp(false); return; }
      // The sky's drifting light picks up where the splash's is, so nothing jumps at the hand-off.
      launch.getAnimations({ subtree: true }).forEach(a => { if ((a as CSSAnimation).animationName === 'launch-drift') a.currentTime = ran; });
      await wait(60); // drawn before the window shows
      await api.win.launchShow().catch(() => undefined);
      showApp(true);
    })();
  } else {
    // Browser: the whole intro plays in the page. It lifts 1.8s after the swirl has fully appeared; animations only
    // advance while the page draws frames, so a clock-time cap makes sure it never stays up for good.
    const logoIn = $('.launch-logo', launch).getAnimations()[0]?.finished.catch(() => undefined) ?? Promise.resolve();
    void Promise.race([logoIn.then(() => wait(1800)), wait(6000)]).then(() => showApp(true));
  }
}
