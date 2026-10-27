/* ================= Vibe Mode ================= */
// While an agent works, the IDE fades and blurs away and the user's feed plays in a 9:16 frame.
// In the desktop app main.js lays the live site exactly over #vibeFrame; the browser preview shows a placeholder.
const VIBE_DELAY = 3000; // quick answers don't trigger it
let vibeOn = false;
let vibeTimer: TimeoutId | undefined;
let vibeClock: IntervalId | undefined;
let vibeStarted = 0;
let vibeMuted = false;
let vibeSiteShown: string | null = null;
const vibeFrame = $('#vibeFrame');
const agentWorking = () => Object.values(agentsDef).some(a => a.status === 'working');
function setVibeArmed(on: boolean): void {
  appState.vibeArmed = on;
  saveApp();
  // Flipped in place: rebuilding the Settings pane would redraw (and re-fetch) the feed cards.
  const sw = document.getElementById('sVibe');
  sw?.classList.toggle('on', on);
  sw?.setAttribute('aria-checked', String(on));
  const feeds = document.getElementById('sFeeds');
  feeds?.classList.toggle('off', !on);
  feeds?.toggleAttribute('inert', !on); // greyed out and locked: no clicks, no keyboard focus
}
function openFeedPicker(): void {
  openModal(`<h3>Vibe Mode feeds</h3><p class="sub">Pick what plays while your agents work. Connecting opens the site so you can sign in.</p>
    <div class="social-grid" id="feedPick"></div><div class="row end"><button class="btn btn-primary" data-close>Done</button></div>`,
    m => void renderFeedChoices($('#feedPick', m)), () => { if (connectedSites().length && !appState.vibeArmed) setVibeArmed(true); });
}
commands['vibe.feeds'] = openFeedPicker;

function frameRect(): Rect {
  const r = vibeFrame.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
}
function renderVibeSites(): void {
  $('#vibeSites').innerHTML = connectedSites().map(s =>
    `<button class="${s.id === vibeSiteShown ? 'on' : ''}" data-vibe-site="${s.id}">${brandMark('mark', s.id, s.mark)}<span class="nm">${esc(s.name)}</span></button>`).join('');
  $$('[data-vibe-site]').forEach(b => {
    b.onclick = () => { appState.vibeSite = b.dataset.vibeSite ?? null; saveApp(); showFeed(); };
    b.title = siteById(b.dataset.vibeSite ?? null)?.name ?? '';
  });
  // The card never grows to fit its tabs: when they don't fit, all but the watched one shrink to their icon.
  const row = $('#vibeSites');
  row.classList.remove('tight');
  if (row.scrollWidth > row.clientWidth) row.classList.add('tight');
}
function showFeed(): void {
  const site = siteById(appState.vibeSite) ?? connectedSites()[0];
  vibeSiteShown = site?.id ?? null;
  renderVibeSites();
  const placeholder = $('#vibePlaceholder');
  placeholder.classList.toggle('hidden', isDesktop && !!site);
  placeholder.innerHTML = site
    ? `<div>${brandMark('mark big-mark', site.id, site.mark)}<h4>${esc(site.name)}</h4><div>Your feed plays here in the Breeze desktop app.</div></div>`
    : '<div><h4>No feed connected</h4><div>Open Settings → Vibe Mode Feeds to connect one.</div></div>';
  if (site && isDesktop) background(api.vibe.show(site.id, frameRect()));
}
function tickVibeClock(): void {
  const s = Math.floor((Date.now() - vibeStarted) / 1000);
  $('#vibeClock').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const a = Object.values(agentsDef).find(x => x.status === 'working');
  if (a) swapText($('#vibeTask'), `${a.name}: ${a.task}`);
}
function enterVibe(): void {
  if (vibeOn) return;
  vibeOn = true;
  closeMenu();
  vibeStarted = Date.now();
  $('#vibeReady').classList.add('hidden');
  $('#vibeStatus').classList.remove('hidden');
  $('#vibe').classList.remove('hidden');
  document.body.classList.add('vibing');
  tickVibeClock();
  vibeClock = setInterval(tickVibeClock, 1000);
  // Wait for the stage to settle before laying the live feed over it.
  setTimeout(() => { if (vibeOn) showFeed(); }, 450);
}
function exitVibe(): void {
  if (!vibeOn) return;
  vibeOn = false;
  clearInterval(vibeClock);
  if (isDesktop) background(api.vibe.hide());
  document.body.classList.remove('vibing');
  $('#vibe').classList.add('hidden');
}
// Called whenever an agent's status changes.
function vibeTick(): void {
  if (vibeOn && agentWorking() && !$('#vibeReady').classList.contains('hidden')) { resumeVibe(); return; }
  if (!appState.vibeArmed || !connectedSites().length || vibeOn || vibeTimer != null || !agentWorking()) return;
  vibeTimer = setTimeout(() => {
    vibeTimer = undefined;
    if (agentWorking()) enterVibe();
  }, VIBE_DELAY);
}
// The ready card was showing and the agents started again (e.g. the Builder after plan approval).
function resumeVibe(): void {
  $('#vibeReady').classList.add('hidden');
  $('#vibeStatus').classList.remove('hidden');
  clearInterval(vibeClock);
  tickVibeClock();
  vibeClock = setInterval(tickVibeClock, 1000);
}
// `plan`: the Planner finished and its plan waits for approval.
function vibeDone(ok: boolean, plan = false): void {
  clearTimeout(vibeTimer);
  vibeTimer = undefined;
  if (!vibeOn) return;
  clearInterval(vibeClock);
  $('#vibeStatus').classList.add('hidden');
  $('#vibeReady').classList.remove('hidden');
  $('#vibeReady').classList.toggle('failed', !ok);
  let text = ok ? 'Your code is ready' : 'The agent stopped';
  if (ok && plan) text = 'The plan is ready for you';
  swapText($('#vibeReadyText'), text);
  let backBtnText = 'Back to code';
  if (ok) {
    backBtnText = plan ? 'Review plan' : 'Show me';
  }
  swapText($('#vibeBack'), backBtnText);
  // The feed keeps playing; leaving Vibe Mode stays the user's call. The card pops and the system says so.
  const card = $('#vibeReady');
  card.classList.remove('ping');
  const _reflow = card.offsetWidth;
  card.classList.add('ping');
  notifyVibe(text.replace(/^\W+\s*/, ''), ok ? 'Head back to Breeze when you’re ready. Your feed keeps playing.' : 'Head back to Breeze to see what happened.');
}
// A system notification, so it is noticed over the feed or from another window. Clicking it brings Breeze up.
function notifyVibe(title: string, body: string): void {
  if (typeof Notification === 'undefined') return;
  const show = () => {
    const n = new Notification(title, { body, icon: '../../assets/brand/Icon.png', tag: 'breeze-vibe' });
    n.onclick = () => { window.focus(); n.close(); };
  };
  if (Notification.permission === 'granted') show();
  else if (Notification.permission !== 'denied') void Notification.requestPermission().then(p => { if (p === 'granted') show(); });
}
$('#vibeClose').onclick = exitVibe;
// Clicking the dimmed backdrop around the panel leaves Vibe Mode too.
$('#vibe').addEventListener('click', e => { if (e.target === e.currentTarget) exitVibe(); });
$('#vibeBack').onclick = () => {
  exitVibe();
  const t = lastRunFiles[0];
  if (t) openFile(t);
};
$('#vibeMute').onclick = () => {
  vibeMuted = !vibeMuted;
  void setIcon($('#vibeMute'), vibeMuted ? 'volumeOff' : 'volume');
  $('#vibeMute').title = vibeMuted ? 'Unmute' : 'Mute';
  if (isDesktop) background(api.vibe.mute(vibeMuted));
};
// Keep the live feed glued to the frame when the window changes size.
const glueFeed = () => { if (vibeOn && vibeSiteShown && isDesktop) background(api.vibe.bounds(frameRect())); };
new ResizeObserver(glueFeed).observe(vibeFrame);
addEventListener('resize', glueFeed); // the frame can move without changing size

