/* ================= Discord ================= */
// Rich Presence through the Discord app on this computer (main.js talks to it); updates are coalesced.
const discordSince = Date.now();
let discordTimer: TimeoutId | undefined;
let discordLive = false;   // connected and showing
function discordActivity(): DiscordActivity {
  const working = Object.values(agentsDef).find(a => a.status === 'working');
  const inBox = appState.mode === 'box';
  const file = active ? baseName(active) : null;
  if (!appState.discordDetails) {
    let details = 'Writing code';
    if (working) details = 'Vibe coding with agents';
    else if (inBox) details = 'Chatting with an agent';
    return { details, state: 'Breeze Code', start: discordSince };
  }
  let details = inBox ? 'Chatting in Breeze Box' : 'Idle';
  if (working) details = `${working.name}: ${working.task}`;
  else if (!inBox && file) details = `Editing ${file}`;
  const lang = !inBox && active ? langOf(active)[1] : '';
  const where = rootInfo ? `in ${rootInfo.name}` : 'Breeze Code';
  return { details, state: lang && !working ? `${lang} · ${where}` : where, start: discordSince };
}
// Settings → Discord shows this state; there is no status bar button any more.
let discordState: { state: 'on' | 'off' | 'error'; why: string } = { state: 'off', why: '' };
function renderDiscord(state: 'on' | 'off' | 'error', why = ''): void {
  discordState = { state, why };
  refreshSettings();
}
async function pushDiscord(): Promise<void> {
  if (!appState.discord) return;
  try {
    await api.discord.set(discordActivity());
    if (!discordLive) renderDiscord('on');
    discordLive = true;
  } catch (e) {
    discordLive = false;
    // Said once, in a toast; Settings only shows "Not connected" until it comes back.
    if (discordState.state !== 'error') toast(errMsg(e));
    renderDiscord('error');
  }
}
function queueDiscord(): void {
  if (!appState.discord) return;
  clearTimeout(discordTimer);
  discordTimer = setTimeout(() => void pushDiscord(), 1200);
}
async function discordOn(details: boolean): Promise<boolean> {
  appState.discordDetails = details;
  try {
    const r = await api.discord.set(discordActivity());
    appState.discord = true; discordLive = true; saveApp();
    renderDiscord('on');
    toast(r.user ? `Showing on Discord as ${r.user}` : 'Discord presence on');
    return true;
  } catch (e) {
    toast(errMsg(e));
    return false;
  }
}
function discordOff(): void {
  appState.discord = false; discordLive = false; saveApp();
  clearTimeout(discordTimer);
  renderDiscord('off');
  background(api.discord.clear());
}
