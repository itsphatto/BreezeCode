/* ================= Settings ================= */
// One pop-up for everything: the gear opens it (in the IDE and in Breeze Box) and turns while it is open.
type SettingsTab = 'general' | 'appearance' | 'agents' | 'misc' | 'discord' | 'help' | 'dev';
const SETTINGS_TABS: [SettingsTab, string, string][] = [
  ['general', 'General', 'gear'],
  ['appearance', 'Appearance', 'palette'],
  ['agents', 'Agents', 'terminal'],
  ['discord', 'Discord', 'img:discord.png'],
  ['help', 'Help & About', 'info'],
  ['misc', 'Miscellaneous', 'more'],
  ['dev', 'Developer', 'code'],
];
// Developer stays out of the list until its code is entered under Miscellaneous.
const DEV_CODE = 'developermode';
const visibleSettingsTabs = () => SETTINGS_TABS.filter(([id]) => id !== 'dev' || appState.devMode);
// Agents the user has come first, then this order; anything else keeps its place after.
const AGENT_ORDER = ['claude', 'codex', 'antigravity', 'ollama'];
const agentRank = (a: DetectedAgent) => (a.found ? 0 : 100) + (AGENT_ORDER.indexOf(a.id) + 1 || AGENT_ORDER.length + 1);
let settingsTab: SettingsTab = 'general';
let justSwitched = false;
const settingsRoot = () => document.querySelector<HTMLElement>('#modalRoot .scrim:not(.closing) .settings-modal');
// The on/off switch (styles under "on/off switch" in breeze.css): a rounded track and a square knob that stretches as it slides.
const switchHtml = (id: string, on: boolean, label: string) =>
  `<button class="switch ${on ? 'on' : ''}" id="${id}" role="switch" aria-checked="${on}" aria-label="${escAttr(label)}"><span class="sw-knob"></span></button>`;

// Tap a switch to flip it, or drag the knob: it follows the pointer and lands on the nearer side.
// A drag that ends on the side it started from swallows the click, so it changes nothing.
(() => {
  let drag: { el: HTMLButtonElement; x0: number; from: number; moved: boolean } | null = null;
  let swallow: HTMLElement | null = null;
  const end = (e: PointerEvent) => {
    if (!drag) return;
    const { el, from, moved } = drag;
    drag = null;
    delete el.dataset.active;
    delete el.dataset.dragging;
    if (!moved) return;
    const at = Number.parseFloat(el.style.getPropertyValue('--complete')) || 0;
    el.style.removeProperty('--complete');   // eases from where the knob was let go
    if ((at >= 50) === (from === 100) || e.type === 'pointercancel') swallow = el;
  };
  document.addEventListener('pointerdown', e => {
    const el = (e.target as HTMLElement).closest<HTMLButtonElement>('button.switch');
    if (!el || el.disabled || e.button !== 0) return;
    drag = { el, x0: e.clientX, from: el.classList.contains('on') ? 100 : 0, moved: false };
    el.dataset.active = 'true';
    el.setPointerCapture(e.pointerId);
  });
  document.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    if (!drag.moved && Math.abs(dx) < 3) return;
    drag.moved = true;
    drag.el.dataset.dragging = 'true';
    // The knob travels the switch's width less its height (one knob plus the padding on both sides).
    const travel = Math.max(1, drag.el.clientWidth - drag.el.clientHeight);
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

// Settings → Appearance. Each card shows a small picture of the window in that theme.
const THEMES: [Theme, string, string][] = [
  ['dark', 'Default Dark', 'Soft charcoal.'],
  ['contrast', 'High Contrast Dark', 'True black, sharper edges.'],
  ['light', 'Light', 'Bright and airy.'],
];
const themeCardHtml = ([id, name, sub]: [Theme, string, string]) =>
  `<button class="set-theme ${id === theme ? 'on' : ''}" data-theme-pick="${id}" aria-pressed="${id === theme}">
    <span class="theme-swatch" data-swatch="${id}" aria-hidden="true"><span class="sw-bar"><i></i><i></i><i></i></span><span class="sw-side"><b></b><b></b><b></b></span><span class="sw-main"><b></b><b></b><b></b><b></b></span></span>
    <span class="nm">${esc(name)}</span><span class="set-sub">${esc(sub)}</span></button>`;
function setTheme(t: Theme): void {
  if (t === theme) return;
  theme = t;
  store.set('breeze.theme', t);
  const root = document.documentElement;
  // Every colour eases over to the new theme for a moment, then transitions go back to normal.
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    root.classList.add('theme-fading');
    setTimeout(() => root.classList.remove('theme-fading'), 300);
  }
  root.dataset.theme = t;
  background(api.win.theme(t));
}

// The account card sits at the top of General.
function accountHtml(): string {
  const others = accounts.accounts.map(a => `<div class="set-row"><div class="set-text"><div class="set-title">${esc(a.name)}</div><div class="set-sub">${esc(a.email ?? a.provider)}</div></div>
      <div class="set-ctl set-acct-ctl">${accountKey(a) === accounts.active ? '<span class="pill ok set-active">Active</span>' : `<button class="btn btn-sm" data-switch-acct="${escAttr(accountKey(a))}">Switch</button>`}${holdDelHtml(a.email ?? a.name, `data-remove-acct="${escAttr(accountKey(a))}"`)}</div></div>`).join('');
  return `<div class="set-user">${avatarHtml(user, user?.name ?? 'Not signed in')}<div class="set-user-text"><div class="set-title">${user ? esc(user.name) : 'Not signed in'}</div><div class="set-sub">${user ? esc(user.provider) : 'Sign in to sync your name and picture.'}</div></div>
      <div class="set-user-actions"><button class="btn btn-sm" id="sAddAcct">Add account</button>${user ? '<button class="btn btn-sm btn-danger" id="sSignOut">Sign out</button>' : ''}</div></div>
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
    // Only Claude and Codex report their plan; theirs appears once they've run since the last reset.
    const none = a.api ? 'No limit · runs on this computer'
      : a.id in u.limits ? 'Plan limits show up after its next run' : `${a.name} doesn't share its limits`;
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
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { show(to); return; }
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
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    void el.offsetWidth; // lay the bars out empty first, so setting their width below slides them
    $$<HTMLElement>('[data-n]', el).forEach(n => countTo(n, 0, Number(n.dataset.n)));
  }
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
      ${settingRow('Workspace', 'Full editor, or chat only.', segHtml('sMode', [['ide', 'Breeze Code'], ['box', 'Breeze Box']], appState.mode))}
      ${settingRow('Sound', 'Clicks, typing ticks and agent chimes.', `<div class="set-volume"><button class="set-volume-ico" id="sVolumeIco" title="Mute" aria-label="Mute">${svgIcon(volumeIcon(sfx.volume), 14)}</button><input type="range" id="sVolume" min="0" max="100" step="1" value="${sfx.volume}" aria-label="Sound volume"><span class="set-volume-val" id="sVolumeVal">${sfx.volume}%</span></div>`)}
      <h5>Layout</h5>
      ${settingRow('Side bar', 'Ctrl+B', switchHtml('sSide', layout.sideOpen, 'Side bar'))}
      ${settingRow('Agents panel', 'Ctrl+Alt+B', switchHtml('sAgents', layout.agentsOpen, 'Agents panel'))}
      ${settingRow('Terminal', 'Ctrl+`', switchHtml('sTerm', layout.termOpen, 'Terminal'))}
      ${settingRow('Preview', '', switchHtml('sPreview', layout.previewOpen, 'Preview'))}
      ${settingRow('Reset layout', 'Put every panel back where it started.', '<button class="btn btn-sm" id="sResetLayout">Reset</button>')}`;
    case 'appearance': return `<h4>Appearance</h4>
      <h5>Theme</h5>
      <div class="set-themes">${THEMES.map(themeCardHtml).join('')}</div>
      <p class="set-sub">Sign-in and Home keep their dark glass over the river photo in every theme.</p>`;
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
        ${agents.some(a => a.found) ? `<h5>Usage</h5><div class="usage-list" id="sUsage">${usageHtml(usageAgents())}</div>` : ''}`;
    }
    case 'misc': return `<h4>Miscellaneous</h4>
      <h5>Vibe Code Mode</h5>
      ${settingRow('Vibe Code Mode', 'Play your feed while agents work.', switchHtml('sVibe', appState.vibeArmed, 'Vibe Code Mode'))}
      <h5>Feed</h5>
      <div class="social-grid ${appState.vibeArmed ? '' : 'off'}" id="sFeeds"${appState.vibeArmed ? '' : ' inert'}></div>
      <h5>Code</h5>
      ${settingRow('Enter code', appState.devMode ? 'Developer is unlocked.' : 'Unlock hidden sections.', '<div class="set-code"><input class="input" id="sCode" aria-label="Code" placeholder="Code" autocomplete="off" spellcheck="false"><button class="btn btn-sm" id="sCodeGo">Enter</button></div>')}`;
    case 'discord': {
      const a = discordActivity();
      const status = { on: 'Connected', off: 'Off', error: 'Not connected' }[discordState.state];
      return `<h4>Discord</h4>
        ${settingRow('Rich presence', `Status: ${status}${discordState.why ? ` · ${esc(discordState.why)}` : ''}`, switchHtml('sDiscord', appState.discord, 'Discord presence'))}
        ${settingRow('Show project and file names', 'Names can include client or employer names.', switchHtml('sDiscordDetails', appState.discordDetails, 'Show project and file names'))}
        <h5>Friends will see</h5>
        <div class="setup-card discord-preview"><b>Breeze Code</b><div class="text-2">${esc(a.details ?? '')}</div><div class="text-2">${esc(a.state ?? '')}</div><div class="text-3 fs-12">elapsed time</div></div>
        <p class="set-sub">The Discord app must be running on this computer.</p>`;
    }
    case 'help': {
      const engine = /Electron\/[\d.]+|Chrome\/[\d.]+/.exec(navigator.userAgent)?.[0] ?? '';
      return `<h4>Help & About</h4>
      ${settingRow('Keyboard shortcuts', '', '<button class="btn btn-sm" data-set-cmd="help.keys">Show</button>')}
      ${settingRow('About Breeze Code', `${engine ? `${esc(engine)} · ` : ''}v${esc(appVersion)}`, '')}`;
    }
    case 'dev': return `<h4>Developer</h4>
      ${settingRow('Run setup again', 'Pick your agent and workspace again.', '<button class="btn btn-sm" data-set-cmd="help.setup">Start</button>')}
      ${settingRow('Developer tools', 'Ctrl+Shift+I', '<button class="btn btn-sm" data-set-cmd="win.devtools">Toggle</button>')}
      ${settingRow('Reload window', 'Ctrl+R', '<button class="btn btn-sm" data-set-cmd="win.reload">Reload</button>')}
      ${settingRow('Turn off Developer', 'Hide this section again.', '<button class="btn btn-sm" id="sDevOff">Turn off</button>')}`;
  }
}

function settingsNavHtml(): string {
  return visibleSettingsTabs().map(([id, label, icon]) => {
    const iconHtml = icon.startsWith('img:')
      ? '<img class="set-nav-img" src="../../assets/icons/' + icon.slice(4) + '" width="17" height="17" alt="" draggable="false">'
      : svgIcon(icon, 17);
    return '<button data-set-tab="' + id + '">' + iconHtml + '<span>' + esc(label) + '</span></button>';
  }).join('');
}

function bindSettings(m: HTMLElement): void {
  if (settingsTab === 'dev' && !appState.devMode) settingsTab = 'general';
  // Developer was unlocked or turned off: redraw the section list under the heading.
  const nav = $('.set-nav', m);
  if (nav && $$('[data-set-tab]', nav).length !== visibleSettingsTabs().length) {
    $$('[data-set-tab]', nav).forEach(b => b.remove());
    nav.insertAdjacentHTML('beforeend', settingsNavHtml());
  }
  const pane = $('.set-pane', m);
  // Switches are rebuilt with the pane, so remember where each knob was (mid-drag or mid-slide too) and slide on from there.
  const prevSwitch = new Map<string, string>();
  pane.querySelectorAll<HTMLElement>('.switch').forEach(s => prevSwitch.set(s.id, getComputedStyle(s).getPropertyValue('--complete')));
  pane.innerHTML = settingsBody(settingsTab);
  // A new section's rows come in one after another; redraws of the same section (a switch flipped) just appear.
  if (pane.dataset.tab !== settingsTab) {
    pane.dataset.tab = settingsTab;
    staggerIn(pane.children);
    staggerIn(pane.querySelectorAll('.set-agents > *'), 2);
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
  // A CSS transition can't be relied on for a freshly built element (it never starts if its style was resolved
  // already), so the slide from the old place is played as a Web Animation of --complete instead.
  pane.querySelectorAll<HTMLElement>('.switch').forEach(s => {
    const was = Number.parseFloat(prevSwitch.get(s.id) ?? '');
    const to = s.classList.contains('on') ? 100 : 0;
    if (Number.isNaN(was) || Math.abs(was - to) < .5 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    s.animate([{ '--complete': String(was) }, { '--complete': String(to) }],
      { duration: 220 * Math.abs(to - was) / 100, easing: 'cubic-bezier(.65, 0, .35, 1)' });
  });
  $$('[data-set-tab]', m).forEach(b => b.classList.toggle('on', b.dataset.setTab === settingsTab));
  const on = (id: string, fn: (el: HTMLElement) => void) => { const el = $(`#${id}`, pane); if (el) el.onclick = () => fn(el); };
  const layoutSwitch = (id: string, act: string) => on(id, () => { run(act); refreshSettings(); });
  const seg = (id: string, fn: (v: string) => void) => $$(`#${id} button`, pane).forEach(b => b.onclick = () => fn(b.dataset.v ?? ''));

  // General
  seg('sMode', v => { if (v !== appState.mode) { closeModal(); enterMode(v as WorkMode); } });
  layoutSwitch('sSide', 'view.toggleSide');
  layoutSwitch('sAgents', 'view.toggleAgents');
  layoutSwitch('sTerm', 'term.toggle');
  layoutSwitch('sPreview', 'view.togglePreview');
  layoutSwitch('sResetLayout', 'view.resetLayout');
  // Appearance
  $$('[data-theme-pick]', pane).forEach(b => b.onclick = () => {
    const from = pane.querySelector('.set-theme.on')?.getBoundingClientRect();
    setTheme(b.dataset.themePick as Theme);
    refreshSettings();
    slideSelected(pane.querySelector<HTMLElement>(`[data-theme-pick="${CSS.escape(theme)}"]`), from);
  });
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
  const usageEl = pane.querySelector<HTMLElement>('#sUsage');
  if (usageEl) {
    fillUsageBars(usageEl);
    usageShown = usageHtml(usageAgents());
    updateUsage(usageEl);
    // Kept current while it's on screen; the timer ends once this pane is redrawn or closed.
    const tick = setInterval(() => { if (usageEl.isConnected) updateUsage(usageEl); else clearInterval(tick); }, 15_000);
  }
  if (settingsTab === 'agents') autoRescan();
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
    appState.devMode = true; saveApp();
    toast('Developer unlocked');
    settingsTab = 'dev';
    refreshSettings();
  };
  on('sCodeGo', tryCode);
  if (codeIn) codeIn.onkeydown = e => { if (e.key === 'Enter') tryCode(); };
  on('sDevOff', () => { appState.devMode = false; saveApp(); settingsTab = 'misc'; refreshSettings(); });
  // Discord
  on('sDiscord', el => {
    if (appState.discord) { discordOff(); return; }
    (el as HTMLButtonElement).disabled = true;
    void discordOn(appState.discordDetails).then(refreshSettings);
  });
  on('sDiscordDetails', () => { appState.discordDetails = !appState.discordDetails; saveApp(); queueDiscord(); refreshSettings(); });
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
  $$('[data-remove-acct]', pane).forEach(b => holdToDelete(b, () => {
    const a = accounts.accounts.find(x => accountKey(x) === b.dataset.removeAcct);
    if (a) background(removeAccount(a).then(refreshSettings));
  }));
  on('sAddAcct', () => addAccount());
  on('sSignOut', () => background(signOut().then(refreshSettings)));
  // Help and Developer
  // A command that opens a modal replaces Settings and leads back to it; setup and reload close Settings first.
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

function openSettings(gear: HTMLElement, tab?: SettingsTab): void {
  if (settingsRoot()) { closeModal(); return; }
  closeMenu();
  if (tab) settingsTab = tab;
  const gears = [$('#settingsBtn'), $('#boxSettings')];
  gears.forEach(g => { g.classList.add('open'); g.setAttribute('aria-expanded', 'true'); });
  openModal(`<div class="settings-modal" aria-label="Settings">
      <nav class="set-nav"><h3>Settings</h3>${settingsNavHtml()}</nav>
      <div class="set-main"><button class="set-close tab-close" data-close title="Close (Esc)" aria-label="Close"><svg class="tab-close-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button><div class="set-pane"></div></div>
    </div>`, m => {
    m.classList.add('settings-shell');
    const root = $('.settings-modal', m);
    // Delegated, so the Developer button works when it is added after the code is entered.
    $('.set-nav', root).addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-set-tab]');
      if (!b || settingsTab === b.dataset.setTab) return;
      settingsTab = b.dataset.setTab as SettingsTab;
      const pane = $('.set-pane', root);
      if (pane) {
        pane.style.animation = 'none';
        forceReflow(pane);
        pane.style.animation = '';
      }
      bindSettings(root);
    });
    background(refreshAccounts().then(refreshSettings));
    bindSettings(root);
    gear.blur();
  }, () => gears.forEach(g => { g.classList.remove('open'); g.setAttribute('aria-expanded', 'false'); }));
}
commands['settings.open'] = () => openSettings($('#settingsBtn'));
$('#settingsBtn').onclick = e => openSettings(e.currentTarget as HTMLElement);
$('#boxSettings').onclick = e => openSettings(e.currentTarget as HTMLElement);

// Buttons with data-act anywhere in the page run the matching command.
document.addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (b && !b.closest('.menu')) { e.stopPropagation(); run(b.dataset.act as string); }
});

