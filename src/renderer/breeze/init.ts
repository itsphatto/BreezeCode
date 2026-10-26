/* ================= Init ================= */
async function boot(): Promise<void> {
  void holdStartup(Promise.all([
    document.fonts.load('400 12px Inter'),
    document.fonts.load('500 12px Inter'),
    document.fonts.load('600 11px Inter'),
    document.fonts.load('700 12px Inter'),
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
// No loading screen: every launch after setup opens straight onto Home, so a returning user never sees the
// welcome flash by. A first run's welcome rises in; sounds stay off until start-up has settled (8s at most).
{
  if (appState.onboarded) goStep(STEP.home);
  const welcome = $('.ob-step[data-step="0"]');
  welcome.classList.remove('ob-await');
  if (welcome.getClientRects().length) welcome.classList.add('ob-intro');
  const starting = boot();
  background(starting);
  void Promise.race([starting.catch(() => undefined), new Promise(done => setTimeout(done, 8000))])
    .then(() => document.documentElement.removeAttribute('data-starting'));
}
