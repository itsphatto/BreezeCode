/* ----- Vibe Mode feeds (the feed picker) ----- */
// Sites the user connected live in appState.vibeSites; signedIn says which of them have a session cookie.
let signedIn: Record<string, boolean> = {};
const siteById = (id: string | null) => SOCIAL_SITES.find(s => s.id === id);
const connectedSites = () => SOCIAL_SITES.filter(s => appState.vibeSites.includes(s.id));
function feedCardHtml(s: SocialSite): string {
  const connected = appState.vibeSites.includes(s.id);
  const cls = ['social-card', connected ? 'connected' : '', s.id === appState.vibeSite ? 'on' : ''].filter(Boolean).join(' ');
  let sub = 'Not connected';
  if (connected) sub = 'Signed in';
  const connectLabel = connected ? 'Disconnect' : 'Connect';
  return `<div class="${cls}" data-site="${s.id}" role="button" tabindex="0">
    ${brandMark('mark', s.id, s.mark)}<span class="sc-text"><span class="nm">${esc(s.name)}</span><span class="sub">${sub}</span></span>
    <button class="btn btn-sm" data-connect="${s.id}">${connectLabel}</button></div>`;
}
async function renderFeedChoices(root: HTMLElement): Promise<void> {
  signedIn = await api.vibe.status().catch(() => ({}));
  // A feed whose sign-in has expired or been cleared is no longer connected.
  const stale = appState.vibeSites.filter(id => id in signedIn && !signedIn[id]);
  if (stale.length) {
    appState.vibeSites = appState.vibeSites.filter(id => !stale.includes(id));
    if (appState.vibeSite && stale.includes(appState.vibeSite)) appState.vibeSite = appState.vibeSites[0] ?? null;
    saveApp();
  }
  let first = true;
  const draw = () => {
    root.innerHTML = SOCIAL_SITES.map(feedCardHtml).join('');
    if (first) { first = false; staggerIn(root.children, 3); }
    $$('[data-site]', root).forEach(card => {
      const id = card.dataset.site ?? '';
      const pick = (onButton: boolean) => {
        // A connected card's body makes it the feed Vibe Mode plays; the button connects or disconnects.
        if (!onButton && appState.vibeSites.includes(id)) {
          const from = root.querySelector('.social-card.on')?.getBoundingClientRect();
          appState.vibeSite = id; saveApp(); draw();
          slideSelected(root.querySelector<HTMLElement>(`[data-site="${CSS.escape(id)}"]`), from);
          return;
        }
        background(toggleFeed(id).then(draw));
      };
      card.onclick = e => pick(!!(e.target as HTMLElement).closest('[data-connect]'));
      card.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === card) { e.preventDefault(); pick(false); } };
    });
  };
  draw();
}
// Signing in to a feed: the app blurs behind a rounded frame and the site loads into it (a view laid over the
// frame's body by the desktop app). Close, Esc or a click on the backdrop ends it.
function connectFeed(site: SocialSite): Promise<boolean> {
  const scrim = document.createElement('div');
  scrim.className = 'feed-connect';
  scrim.innerHTML = `<div class="feed-connect-frame" role="dialog" aria-label="Sign in to ${escAttr(site.name)}">
      <div class="feed-connect-head">${brandMark('mark', site.id, site.mark)}<span>Sign in to ${esc(site.name)}</span>
        <button class="btn btn-sm btn-primary" data-fc-done>Done</button></div>
      <div class="feed-connect-body"><div class="spinner"></div></div></div>`;
  document.body.append(scrim);
  const body = $('.feed-connect-body', scrim);
  const rect = (): Rect => { const r = body.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; };
  const place = () => background(api.vibe.connectBounds(rect()));
  addEventListener('resize', place);
  const close = () => background(api.vibe.connectClose());
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  $('[data-fc-done]', scrim).onclick = close;
  scrim.onmousedown = e => { if (e.target === scrim) close(); };
  // The view is placed once the frame has finished growing in, so it lands on the frame's final box.
  const opened = new Promise<void>(r => setTimeout(r, 320));
  return opened.then(() => api.vibe.connect(site.id, rect())).catch(() => false).finally(() => {
    removeEventListener('resize', place);
    document.removeEventListener('keydown', onKey, true);
    scrim.classList.add('closing');
    setTimeout(() => scrim.remove(), 260);
  });
}
async function toggleFeed(id: string): Promise<void> {
  const site = siteById(id);
  if (!site) return;
  if (appState.vibeSites.includes(id)) {
    await api.vibe.disconnect(id);
    appState.vibeSites = appState.vibeSites.filter(x => x !== id);
    signedIn[id] = false;
    if (appState.vibeSite === id) appState.vibeSite = appState.vibeSites[0] ?? null;
    saveApp();
    toast(`${site.name} disconnected`);
    return;
  }
  // A feed only counts as connected once the site really has a sign-in; closing the window unsigned adds nothing.
  signedIn[id] = await connectFeed(site);
  if (!signedIn[id]) { toast(`Couldn't confirm a ${site.name} sign-in, so it isn't connected. Try Connect again and sign in first.`); return; }
  appState.vibeSites = [...appState.vibeSites, id];
  appState.vibeSite = id;
  saveApp();
  setVibeArmed(true);
  toast(`${site.name} connected`);
}

/* ----- AI agent detection ----- */
const AGENT_STYLE: Record<string, { letter: string; tint: string }> = {
  codex: { letter: 'Cx', tint: 'codex' },
  claude: { letter: 'Cc', tint: 'claude' },
  antigravity: { letter: 'Ag', tint: 'antigravity' },
  local: { letter: 'Ol', tint: 'local' },
  ollama: { letter: 'Ol', tint: 'local' },
};
let detecting: Promise<Detection> | null = null;

function detectTools(force = false): Promise<Detection> {
  if (detecting !== null) return detecting;
  $('#aiPill').className = 'pill'; swapText($('#aiPill'), 'Scanning');
  if (!appState.detect) $('#agentList').innerHTML = '<div class="row text-3"><div class="spinner sm"></div>Checking this computer</div>';
  detecting = api.sys.detect(force).then(d => {
    appState.detect = d;
    fixSelectedAgent();
    renderDetection();
    return d;
  }).catch((e: unknown) => {
    $('#aiPill').className = 'pill warn'; swapText($('#aiPill'), 'Scan failed');
    $('#aiHint').textContent = errMsg(e);
    throw e;
  }).finally(() => { detecting = null; });
  return detecting;
}
// No Scan button: Breeze looks again on its own when it comes back into focus (an agent may have been installed or
// signed in meanwhile) and when Home, Settings → Agents or Help & About opens, at most every 30 seconds. Settings redraws if
// anything changed. For ten minutes after an install starts (even during setup), every return to the window looks again.
let lastAutoScan = 0;
function autoRescan(): void {
  if (launching || detecting || (!appState.onboarded && !installStarted) || Date.now() - lastAutoScan < 30_000) return;
  lastAutoScan = Date.now();
  const before = JSON.stringify(appState.detect);
  detectTools(true).then(d => {
    if (JSON.stringify(d) !== before && (settingsTab === 'agents' || settingsTab === 'help') && settingsRoot()) refreshSettings();
  }, () => { /* the agent card shows the error */ });
}
window.addEventListener('focus', () => {
  if (Date.now() - installStarted < 10 * 60_000) lastAutoScan = 0;
  autoRescan();
});
// Keep the chosen agent if it is still usable, else fall back to the first one that is.
function fixSelectedAgent(): void {
  const found = appState.detect?.agents.filter(a => a.found) ?? [];
  if (!appState.agent || !found.some(a => a.id === appState.agent)) appState.agent = found[0]?.id ?? null;
  saveApp();
}

const pillClass = (on: boolean) => (on ? 'blue' : 'ok');
// The local LLM card: an API key to connect with (the server is found on this computer),
// or (once connected) its address and a model picker.
function localAgentHtml(a: DetectedAgent, on: boolean, mark: string): string {
  const name = `<span class="nm">${esc(a.name)} <small>API</small></span>`;
  if (!a.found) {
    return `<div class="agent-opt api missing">${mark}${name}
      <button class="get side" data-get="${escAttr(a.url)}"><span class="get-label">Get Ollama</span></button>
      <span class="sub">Finds Ollama or LM Studio running on this computer</span>
      <div class="key-row"><input class="input" type="password" data-llm-key aria-label="API key" placeholder="API key" autocomplete="off" spellcheck="false"><button class="btn btn-sm" data-llm-connect>Connect</button></div>
      <div class="key-err hidden"></div></div>`;
  }
  const label = on ? 'Selected' : 'Ready';
  const options = (a.models ?? []).map(m => `<option value="${escAttr(m)}"${m === a.version ? ' selected' : ''}>${esc(m)}</option>`).join('');
  return `<div class="agent-opt api ${on ? 'on' : ''}" role="button" tabindex="0" data-agent="${a.id}">${mark}${name}
    <span class="side row gap-6"><span class="pill ${pillClass(on)}">${label}</span><button class="get" data-llm-off title="Forget this server"><span class="get-label">Remove</span></button></span>
    <span class="sub" title="${escAttr(a.path ?? '')}">${esc(a.path ?? '')}</span>
    <div class="key-row"><select class="select" data-llm-model aria-label="Model">${options}</select></div></div>`;
}
// A version number reads "v2.1.4"; a one-word model alias ("haiku") reads as a name, "Haiku". Anything else
// ("gpt-5.5-codex") is shown as it is.
function versionLabel(v: string | null | undefined): string {
  if (!v) return '';
  if (/^\d/.test(v)) return `v${v}`;
  return /^[a-z]+$/.test(v) ? v[0].toUpperCase() + v.slice(1) : v;
}
function cliAgentHtml(a: DetectedAgent, on: boolean, mark: string, demo: boolean): string {
  const where = a.path ?? (demo ? 'browser preview' : '');
  const version = versionLabel(a.version) || 'Installed';
  const sub = a.found ? [version, where].filter(Boolean).join(' · ') : a.vendor + ' · not installed';
  const label = on ? 'Selected' : 'Detected';
  const side = a.found
    ? `<span class="pill ${pillClass(on)} side">${label}</span>`
    : `<button class="get side" data-get="${escAttr(a.url)}"><span class="get-label">Get it</span></button>`;
  // A found agent shows just its name; the model and path stay in the tooltip.
  const attrs = a.found ? `role="button" tabindex="0" data-agent="${a.id}" title="${escAttr(sub)}"` : '';
  let modelOptions = '';
  if (a.found && a.models?.length && a.id !== 'codex' && a.id !== 'antigravity' && a.id !== 'claude') {
    const opts = a.models.map(m => {
      const sel = m === a.version ? ' selected' : '';
      return `<option value="${escAttr(m)}"${sel}>${esc(m)}</option>`;
    }).join('');
    modelOptions = `<div class="key-row"><select class="select" data-agent-model="${a.id}" aria-label="Model">${opts}</select></div>`;
  }
  return `<div class="agent-opt ${a.found ? '' : 'missing'} ${on ? 'on' : ''}" ${attrs}>
    ${mark}<span class="nm">${esc(a.name)}</span>${side}
    ${a.found ? '' : `<span class="sub" title="${escAttr(sub)}">${esc(sub)}</span>`}${modelOptions}</div>`;
}
function agentOptionsHtml(d: Detection): string {
  return d.agents.map(a => {
    const st = AGENT_STYLE[a.id] ?? { letter: a.name[0], tint: 'default' };
    const on = a.found && a.id === appState.agent;
    const mark = brandMark('mark', st.tint, st.letter);
    return a.api ? localAgentHtml(a, on, mark) : cliAgentHtml(a, on, mark, !!d.demo);
  }).join('');
}
function bindLocalLlm(root: HTMLElement, onChange: () => void): void {
  const local = () => appState.detect?.agents.find(a => a.id === 'local');
  const connect = root.querySelector<HTMLButtonElement>('[data-llm-connect]');
  if (connect) {
    const key = $<HTMLInputElement>('[data-llm-key]', root);
    const save = async () => {
      const err = root.querySelector<HTMLElement>('.key-err');
      connect.disabled = true; swapText(connect, 'Connecting');
      try {
        const r = await api.llm.connect('', key.value);
        Object.assign(local() ?? {}, { found: true, path: r.url ?? null, version: r.model, models: r.models });
        if (!selectedAgent()) appState.agent = 'local';
        saveApp();
        toast(`Connected · ${r.model}`);
        onChange();
      } catch (e) {
        connect.disabled = false; swapText(connect, 'Connect');
        if (err) { err.textContent = errMsg(e); err.classList.remove('hidden'); }
      }
    };
    connect.onclick = () => void save();
    key.onkeydown = e => { if (e.key === 'Enter') void save(); };
  }
  const model = root.querySelector<HTMLSelectElement>('[data-llm-model]');
  if (model) model.onchange = () => background(api.llm.setModel(model.value).then(() => {
    Object.assign(local() ?? {}, { version: model.value });
    saveApp();
    renderAgentBar();
    toast(`Ollama model · ${model.value}`);
  }));
  root.querySelector<HTMLElement>('[data-llm-off]')?.addEventListener('click', e => {
    e.stopPropagation();
    background(api.llm.disconnect().then(() => {
      Object.assign(local() ?? {}, { found: false, path: null, version: null, models: [] });
      fixSelectedAgent();
      onChange();
    }));
  });
}
function bindAgentOptions(root: HTMLElement, onChange: () => void): void {
  $$('[data-agent]', root).forEach(el => {
    const pick = () => {
      const from = root.querySelector('.agent-opt.on')?.getBoundingClientRect();
      appState.agent = el.dataset.agent ?? null;
      const curTab = surfaceTabs['ide']?.find(t => t.id === activeTabId['ide']);
      if (curTab && appState.agent) curTab.agentId = appState.agent;
      saveApp();
      onChange();
      updateScmGenBtn();
      slideSelected(root.querySelector<HTMLElement>(`[data-agent="${CSS.escape(appState.agent ?? '')}"]`), from);
    };
    el.onclick = e => { if (!(e.target as HTMLElement).closest('button, input, select')) pick(); };
    el.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === el) { e.preventDefault(); pick(); } };
  });

  $$('[data-agent-model]', root).forEach(sel => {
    (sel as HTMLSelectElement).onchange = async () => {
      const agId = (sel as HTMLElement).dataset.agentModel;
      const modelVal = (sel as HTMLSelectElement).value;
      const targetAgent = appState.detect?.agents.find(a => a.id === agId);
      if (agId === 'codex') {
        await api.agent.setModel('codex', modelVal);
        if (targetAgent) targetAgent.version = modelVal;
        saveApp();
        renderAgentBar();
        toast(`Codex model · ${modelVal}`);
      } else if (agId === 'antigravity' || agId === 'claude') {
        await api.agent.setModel(agId, modelVal);
        if (targetAgent) targetAgent.version = modelVal;
        saveApp();
        renderAgentBar();
        toast(`${targetAgent?.name ?? agId} model · ${modelVal}`);
      }
    };
  });

  $$('[data-get]', root).forEach(b => b.onclick = e => { e.stopPropagation(); background(api.sys.openExternal(b.dataset.get ?? '')); });
  bindLocalLlm(root, onChange);
}

// What a missing tool's button does: run its install command in a terminal, or open its download page.
// `does` says which, as the button's tooltip and in its accessible name.
function toolInstall(t: DetectedTool): { attrs: string; does: string } {
  const cmd = t.cmd || (t.hint && /^(?:winget|brew|xcode-select)\b/.test(t.hint) ? t.hint : null);
  if (cmd) return { attrs: `data-run-cmd="${escAttr(cmd)}"`, does: `Installs ${t.name} in a terminal: ${cmd}` };
  if (t.url) return { attrs: `data-get="${escAttr(t.url)}"`, does: `Opens the ${t.name} download page: ${t.url}` };
  return { attrs: '', does: t.hint ?? '' };
}
// The install buttons in Settings → Help & About. An install finishes in its own terminal, so for a while
// after one starts Breeze looks again every time it comes back into focus (see autoRescan).
let installStarted = 0;
function bindToolButtons(root: HTMLElement): void {
  $$('[data-get]', root).forEach(b => b.onclick = () => background(api.sys.openExternal(b.dataset.get ?? '')));
  $$('[data-run-cmd]', root).forEach(b => {
    b.onclick = async () => {
      const cmd = b.dataset.runCmd;
      if (!cmd) return;
      b.classList.add('busy');
      const prev = b.textContent;
      swapText(b, 'Running');
      try {
        if (await api.sys.runCommand(cmd)) { installStarted = Date.now(); toast(`Launched terminal command: ${cmd}`); }
        else toast(`Breeze can't run that command. Run it yourself: ${cmd}`);
      } catch (err) {
        toast(`Failed to run command: ${errMsg(err)}`);
      } finally {
        setTimeout(() => {
          b.classList.remove('busy');
          swapText(b, prev);
        }, 2000);
      }
    };
  });
}
function renderDetection(): void {
  const d = appState.detect;
  if (!d) return;
  const found = d.agents.filter(a => a.found);
  $('#agentList').innerHTML = agentOptionsHtml(d);
  bindAgentOptions($('#agentList'), renderDetection);
  $('#aiPill').className = found.length ? 'pill ok' : 'pill warn';
  swapText($('#aiPill'), found.length ? `${found.length} ready` : 'None ready');
  $('#aiHint').textContent = found.length
    ? 'Pick the agent Breeze hands work to. Installed agents use their own sign-in; a local LLM runs on your own computer.'
    : 'No coding agent found. Install one and rescan, or connect a local LLM server.';
  if (d.demo) $('#aiHint').textContent += ' (Browser preview.)';

  const missing = d.tools.filter(t => !t.found && !t.optional).map(t => t.name);

  const summary = d.tools.filter(t => t.found || !t.optional).map(t => `${t.name.replace('.js', '').replace('C/C++', 'C')} ${t.found ? 'ready' : 'missing'}`).join(' · ');
  $('#sbTools').innerHTML = `<span class="${missing.length ? 'dot-warn' : 'dot-ok'}"></span> ${summary}`;
  renderAgentBar();
  // Home's Agent tab, if it's showing, picks up agents the scan just found.
  if (!$('.home-view[data-view="agent"]').classList.contains('hidden')) renderAgentDash();
}
$('#rescan').onclick = () => { detectTools(true).catch(() => { /* the agent card shows the error */ }); };

function selectedAgent(): DetectedAgent | null {
  return appState.detect?.agents.find(a => a.id === appState.agent && a.found) ?? null;
}
function modelLabel(a: DetectedAgent | null): string {
  if (!a) return 'no agent';
  return a.api && a.version ? a.version : a.name;
}

const EFFORTS = ['Low', 'Medium', 'High', 'Extra'] as const;
type EffortLevel = typeof EFFORTS[number];
const EFFORT_HINTS: Record<EffortLevel, string> = {
  Low: 'Quick answers, light thinking',
  Medium: 'Balanced speed and depth',
  High: 'Thinks harder, a little slower',
  Extra: 'Deepest thinking, slowest',
};

function currentEffort(): EffortLevel {
  const stored = store.get<string>('breeze.effort', 'Medium');
  return (EFFORTS.find(e => e.toLowerCase() === stored.toLowerCase()) ?? 'Medium') as EffortLevel;
}

function setEffort(eff: EffortLevel): void {
  store.set('breeze.effort', eff);
}

// Each agent keeps its own effort; one never picked follows the global setting.
function agentEffort(a: DetectedAgent): EffortLevel {
  const stored = store.get<string>(`breeze.effort.${a.id}`, '');
  return (EFFORTS.find(e => e.toLowerCase() === stored.toLowerCase()) ?? currentEffort()) as EffortLevel;
}

async function applyModelAndEffort(a: DetectedAgent, model: string, effort: EffortLevel): Promise<void> {
  if (!a.api) store.set(`breeze.effort.${a.id}`, effort);
  if (a.id === 'codex') {
    await api.agent.setModel('codex', model, effort.toLowerCase());
    a.version = model;
    saveApp();
    renderAgentBar();
    toast(`Codex model set to ${versionLabel(model)} (${effort} effort)`);
  } else if (a.id === 'antigravity' || a.id === 'claude') {
    await api.agent.setModel(a.id, model, effort.toLowerCase());
    a.version = model;
    saveApp();
    renderAgentBar();
    toast(`${a.name} model set to ${versionLabel(model)} (${effort} effort)`);
  } else if (a.api) {
    await api.llm.setModel(model);
    a.version = model;
    saveApp();
    renderAgentBar();
    toast(`Ollama model set to ${model}`); // a local server has no effort setting
  }
}

// "Switch Model": the agent's models in a flat list, then a slider for its effort (a local server has none).
// Every surface that picks a model uses this, so Breeze Space and the agents panel behave the same.
// makeDefault (an agent's own chip): setting its model or effort also makes it the default agent.
function modelPickerItems(a: DetectedAgent, makeDefault = false): MenuItem[] {
  const current = () => a.version || a.models?.[0] || '';
  const apply = (m: string, eff: EffortLevel) => background(applyModelAndEffort(a, m, eff).then(() => {
    if (makeDefault && a.id !== appState.agent) makeDefaultAgent(a);
  }));
  const models: MenuItem[] = (a.models ?? []).map(m => ({
    label: versionLabel(m),
    checked: () => current() === m,
    run: () => apply(m, agentEffort(a)),
  }));
  const effort: MenuItem[] = a.api ? [] : [{ slider: {
    label: `${agentShortName(a)} effort`,
    steps: EFFORTS,
    value: () => EFFORTS.indexOf(agentEffort(a)),
    set: i => apply(current(), EFFORTS[i]),
    hint: i => EFFORT_HINTS[EFFORTS[i]],
  } }];
  return [{ label: 'Switch Model', enabled: () => false }, ...models, ...effort];
}

/* ----- Agent bar: one chip per installed agent; a chip inserts its @mention ----- */
// Mention names must match src/main/mentions.js: the short name, the full name and the id, lowercased.
const AGENT_SHORT_NAMES = new Map([['claude', 'Claude'], ['codex', 'Codex'], ['antigravity', 'Antigravity'], ['local', 'Local']]);
function agentShortName(a: DetectedAgent): string {
  return AGENT_SHORT_NAMES.get(a.id) || a.name;
}
function agentMentionNames(a: DetectedAgent): string[] {
  return [...new Set([agentShortName(a), a.name, a.id].map(n => String(n).toLowerCase()))];
}
// An agent's short name by id, whether or not the last scan found it.
function agentNameOf(id: string): string {
  const a = appState.detect?.agents.find(x => x.id === id);
  return a ? agentShortName(a) : AGENT_SHORT_NAMES.get(id) ?? id;
}
// The logo and short name that mark an agent's lines in a team chat.
function agentBadge(agentId: string): string {
  const name = agentNameOf(agentId);
  return `<span class="agent-tag">${brandMark('agent-tag-logo', agentId, name[0] ?? '?')}<b>${esc(name)}</b></span>`;
}

function makeDefaultAgent(ag: DetectedAgent): void {
  appState.agent = ag.id;
  const curTab = surfaceTabs['ide']?.find(t => t.id === activeTabId['ide']);
  if (curTab) curTab.agentId = ag.id;
  saveApp();
  renderAgentBar();
  updateScmGenBtn();
}
function agentChipMenuItems(ag: DetectedAgent): MenuItem[] {
  // The agent's chip is where its model and effort are picked, as in Breeze Space's agent menu.
  const models: MenuItem[] = ag.models?.length ? [...modelPickerItems(ag, true), { sep: true }] : [];
  return [
    ...models,
    { label: 'Make default', checked: () => ag.id === appState.agent, enabled: () => ag.id !== appState.agent, run: () => makeDefaultAgent(ag) },
    { sep: true },
    { label: 'Manage agents', run: openAgentPicker },
  ];
}
// Opens (or, if it is already open, closes) a popup under a chip.
function openChipMenu(chip: HTMLElement, items: MenuItem[]): void {
  if (chip.classList.contains('open') || (justClosedTrigger === chip && Date.now() - justClosedAt < 350)) {
    closeMenu();
    return;
  }
  closeMenu();
  chip.classList.add('open');
  const r = chip.getBoundingClientRect();
  popupMenu(r.left, r.bottom + 4, items, () => chip.classList.remove('open'), chip);
}

function agentChipHtml(a: DetectedAgent, on: boolean): string {
  const short = agentShortName(a);
  const logo = BRAND_ICONS[a.id] ? `<img class="pill-logo" src="../../assets/icons/${BRAND_ICONS[a.id]}" alt="" draggable="false">` : '';
  return `<button type="button" class="agent-chip${on ? ' on' : ''}" data-agent="${escAttr(a.id)}" aria-label="Mention @${escAttr(short)}" aria-pressed="${on}">${logo}<span class="chip-name">${esc(short)}</span><span class="chip-more" role="button" aria-label="Options for ${escAttr(short)}" aria-haspopup="menu">${svgIcon('chevronDown', 10)}</span></button>`;
}

// Chips that do not fit the bar move into a trailing "+N" chip. As the bar is squeezed or widened, a chip that
// folds away shrinks out where it stood, one that comes back grows in, and the "+N" chip grows in or pops its count.
let agentBarFolded = new Set<string>();
let agentBarRest = 0; // the "+N" count last shown, 0 for none
function fitAgentBar(): void {
  const bar = $('#agentBar');
  const before = new Map($$<HTMLElement>('.agent-chip[data-agent]:not(.hidden)', bar).map(c => [c.dataset.agent as string, c]));
  const rects = new Map([...before].map(([id, c]) => [id, c.getBoundingClientRect()]));
  layoutAgentBar(bar);
  bar.classList.remove('measuring');
  const nowFolded = new Set($$<HTMLElement>('.agent-chip[data-agent].hidden', bar).map(c => c.dataset.agent as string));
  const rest = bar.querySelector<HTMLElement>('.chip-rest');
  const restCount = rest ? nowFolded.size : 0;
  // Not while the window itself resizes (layout.ts): the chips just take their places as the screen grows.
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches && bar.offsetParent && !document.documentElement.classList.contains('win-resizing')) {
    const grow = { duration: 260, easing: 'cubic-bezier(.175, .885, .32, 1.275)' };
    for (const c of $$<HTMLElement>('.agent-chip[data-agent]:not(.hidden)', bar)) {
      if (agentBarFolded.has(c.dataset.agent as string)) c.animate([{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'none' }], grow);
    }
    for (const id of nowFolded) {
      const from = before.get(id), r = rects.get(id);
      if (from && r && !agentBarFolded.has(id)) shrinkOut(bar, from, r);
    }
    if (rest && !agentBarRest) rest.animate([{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'none' }], grow);
    else if (rest && restCount !== agentBarRest) rest.animate([{ transform: 'scale(1.12)' }, { transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.2, .8, .2, 1)' });
  }
  agentBarFolded = nowFolded;
  agentBarRest = restCount;
}
// A copy of the chip, left in the bar where it stood, shrinks and fades while the real one is already folded away.
// It stays inside the bar so it keeps the bar's chip styles, and drops data-agent so the bar never counts it.
function shrinkOut(bar: HTMLElement, chip: HTMLElement, r: DOMRect): void {
  const ghost = chip.cloneNode(true) as HTMLElement;
  ghost.classList.remove('hidden', 'open');
  ghost.classList.add('chip-ghost');
  ghost.removeAttribute('data-agent');
  ghost.setAttribute('aria-hidden', 'true');
  if (getComputedStyle(bar).position === 'static') bar.style.position = 'relative';
  const b = bar.getBoundingClientRect();
  Object.assign(ghost.style, { position: 'absolute', left: `${r.left - b.left + bar.scrollLeft}px`, top: `${r.top - b.top + bar.scrollTop}px`, width: `${r.width}px`, height: `${r.height}px`, margin: '0', pointerEvents: 'none' });
  bar.append(ghost);
  ghost.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.6)' }], { duration: 200, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' }).onfinish = () => ghost.remove();
  setTimeout(() => ghost.remove(), 300); // a hidden window doesn't run animations, so a timer makes sure it goes
}
function layoutAgentBar(bar: HTMLElement): void {
  bar.querySelector('.chip-rest')?.remove();
  const chips = $$('.agent-chip[data-agent]', bar);
  chips.forEach(c => c.classList.remove('hidden'));
  // Measured at full size: in a tight bar the kept chip may shrink (see .agent-bar), which mustn't skew the fit.
  bar.classList.add('measuring');
  const _reflow = bar.offsetWidth;
  const avail = bar.clientWidth;
  if (chips.length < 2 || avail <= 0) return;
  const gap = Number.parseFloat(getComputedStyle(bar).columnGap) || 0;
  const widths = chips.map(c => c.offsetWidth);
  if (widths.reduce((sum, w) => sum + w, 0) + gap * (chips.length - 1) <= avail) return;
  // A chip still fits if its logo, arrow and a few letters of its name do: the chips then shrink their names
  // (with an ellipsis) to share the room, rather than folding one away while there's space for most of it.
  const minWidths = chips.map((c, i) => {
    const name = c.querySelector<HTMLElement>('.chip-name');
    return name ? widths[i] - name.scrollWidth + Math.min(name.scrollWidth, 30) : widths[i];
  });
  if (minWidths.reduce((sum, w) => sum + w, 0) + gap * (chips.length - 1) <= avail) return;
  const rest = document.createElement('button');
  rest.type = 'button';
  rest.className = 'agent-chip chip-rest';
  rest.setAttribute('aria-haspopup', 'menu');
  rest.textContent = `+${chips.length}`; // the widest label it can get
  bar.append(rest);
  let used = rest.offsetWidth;
  let keep = 0;
  for (const w of minWidths) {
    if (used + gap + w > avail) break;
    used += gap + w;
    keep++;
  }
  keep = Math.max(keep, 1);
  const hiddenChips = chips.slice(keep);
  hiddenChips.forEach(c => c.classList.add('hidden'));
  rest.textContent = `+${hiddenChips.length}`;
  rest.dataset.hidden = hiddenChips.map(c => c.dataset.agent).join(',');
  rest.setAttribute('aria-label', `${hiddenChips.length} more agents`);
}

function renderAgentBar(): void {
  const a = selectedAgent();
  const bar = $('#agentBar');
  const found = (appState.detect?.agents ?? []).filter(x => x.found);
  // The default agent comes first, so it is the last chip to be folded into "+N".
  found.sort((x, y) => Number(y.id === a?.id) - Number(x.id === a?.id));
  // Where each chip was, so a new default can glide to the front instead of jumping there.
  const before = new Map($$<HTMLElement>('.agent-chip[data-agent]:not(.hidden)', bar).map(c => [c.dataset.agent, c.getBoundingClientRect().left]));
  if (found.length) {
    bar.innerHTML = found.map(x => agentChipHtml(x, x.id === a?.id)).join('');
  } else {
    bar.innerHTML = '<button type="button" class="agent-chip on chip-choose">Choose an agent</button>';
  }
  const prev = bar.dataset.current;
  bar.dataset.current = a?.id ?? '';
  const on = bar.querySelector<HTMLElement>('.agent-chip.on');
  if (on && prev && prev !== bar.dataset.current) {
    on.classList.add('agent-swap');
    on.addEventListener('animationend', () => on.classList.remove('agent-swap'), { once: true });
  }
  fitAgentBar();
  if (prev !== bar.dataset.current && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    for (const c of $$<HTMLElement>('.agent-chip[data-agent]:not(.hidden)', bar)) {
      const x = before.get(c.dataset.agent);
      const dx = x == null ? 0 : x - c.getBoundingClientRect().left;
      if (dx) c.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.16, 1, .3, 1)' });
    }
  }
  const model = a?.api && a.version ? ' · ' + a.version : '';
  const label = a ? a.name + model : 'Choose an agent';
  // The agent's logo first, as in the menu it opens.
  $('#boxModel').innerHTML = `${a ? brandMark('menu-ico', a.id, a.name[0]) : ''}${esc(label)}${svgIcon('chevronDown', 12)}`;
  for (const k of Object.values(agentsDef)) k.model = modelLabel(a);
  renderAgents();
  renderPromptModels();
  updateScmGenBtn();
}

$('#agentBar').addEventListener('click', e => {
  const t = e.target as HTMLElement;
  const chip = t.closest<HTMLElement>('.agent-chip');
  if (!chip) return;
  if (chip.classList.contains('chip-choose')) { closeMenu(); openAgentPicker(); return; }
  if (chip.classList.contains('chip-rest')) {
    const ids = (chip.dataset.hidden ?? '').split(',');
    const hidden = (appState.detect?.agents ?? []).filter(x => ids.includes(x.id));
    // Each agent opens its own options (model, effort, default), the same menu as its chip's arrow.
    openChipMenu(chip, hidden.map(x => ({ label: agentShortName(x), icon: brandMark('menu-ico', x.id, x.name[0]), run: () => insertMention(x), sub: () => agentChipMenuItems(x), clickRuns: true })));
    const m = chip.classList.contains('open') ? $('#menuRoot .menu') : null;
    if (m) {
      m.style.minWidth = '160px';
      m.style.left = `${Math.max(8, Math.min(chip.getBoundingClientRect().left, innerWidth - m.offsetWidth - 8))}px`;
    }
    return;
  }
  const ag = appState.detect?.agents.find(x => x.id === chip.dataset.agent);
  if (!ag) return;
  if (t.closest('.chip-more')) { openChipMenu(chip, agentChipMenuItems(ag)); return; }
  closeMenu();
  insertMention(ag);
});
$('#agentBar').addEventListener('keydown', e => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('.agent-chip[data-agent]');
  const ag = chip && appState.detect?.agents.find(x => x.id === chip.dataset.agent);
  if (chip && ag && e.key === 'ArrowDown') { e.preventDefault(); openChipMenu(chip, agentChipMenuItems(ag)); }
});
new ResizeObserver(fitAgentBar).observe($('#agentBar'));

// Inserts "@<Short> " where the caret is in the agents panel's prompt (a space before it if the text there needs one).
function insertMention(a: DetectedAgent): void {
  const ta = SURFACES.ide.prompt;
  const from = ta.selectionStart ?? ta.value.length;
  const to = ta.selectionEnd ?? from;
  const before = ta.value.slice(0, from);
  const text = `${before && !/\s$/.test(before) ? ' ' : ''}@${agentShortName(a)} `;
  ta.setRangeText(text, from, to, 'end');
  ta.focus();
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

function openAgentPicker(): void {
  openModal(`<h3>Choose your AI agent</h3><p class="sub">Installed coding agents are found automatically. A local LLM connects by its server address.</p>
    <div class="agent-list" id="pickList"></div>
    <div class="row between spaced"><button class="btn btn-sm btn-ghost" id="pickRescan">Scan again</button><button class="btn btn-primary" data-close>Done</button></div>`, m => {
    const scanning = '<div class="text-3">Scanning</div>';
    const render = () => {
      if (!appState.detect) { $('#pickList', m).innerHTML = scanning; return; }
      $('#pickList', m).innerHTML = agentOptionsHtml(appState.detect);
      bindAgentOptions($('#pickList', m), () => { render(); renderDetection(); });
    };
    render();
    $('#pickRescan', m).onclick = () => { $('#pickList', m).innerHTML = scanning; detectTools(true).then(render, () => { /* shown in the agent card */ }); };
  });
}

/* ----- Home: jump back into a recent project, or start one ----- */
// null until the first list arrives, so Home shows placeholder rows instead of flashing its empty layout.
let homeRecent: RecentFolder[] | null = null;
let recentListHtml = '';
let homeSeq = 0;
// Long paths keep their end, the part that tells two projects apart.
const shortPath = (p: string, max = 52) => p.length > max ? `…${p.slice(-(max - 1))}` : p;
// No Scan button: Home looks again as it opens and on each section (the cards redraw when the scan lands).
function scanForHome(): void {
  if (appState.detect) autoRescan();
  else detectTools().catch(() => { /* the cards show the error */ });
}
// Home's rail switches its panel between these views.
function showHomeView(view: string): void {
  $$<HTMLElement>('.home-rail [data-home-view]').forEach(b => {
    const on = b.dataset.homeView === view;
    b.classList.toggle('on', on);
    b.ariaCurrent = on ? 'page' : null;
  });
  $$('.home-view').forEach(v => v.classList.toggle('hidden', v.dataset.view !== view));
  $('.home-main').scrollTop = 0;
  if (view === 'agent') loadAgentDash();
}

/* ----- Home → Agent: one agent's token use, and the other agents ----- */
// The tabs pick the agent shown (the default first); the table lists the agents that aren't the default, and a row
// shows that agent above. Numbers: this month's tokens (agent:usage) and the last 14 days by kind (agent:history).
let dashAgent: string | null = null;
let dashUsage: AgentUsage | null = null;
let dashHistory: AgentHistory | null = null;
let dashSeq = 0;
const DASH_KINDS: [keyof TokenDay, string][] = [['input', 'Input'], ['cacheWrite', 'Cache write'], ['cacheRead', 'Cache read'], ['output', 'Output'], ['other', 'Tokens']];
const compact = (n: number) => tokenCount.format(Math.round(n));
const dayTotal = (d?: TokenDay) => (d ? d.input + d.output + d.cacheWrite + d.cacheRead + d.other : 0);
// Every installed agent, the default first; an agent that isn't installed but has history still shows.
function dashAgents(): DetectedAgent[] {
  const all = appState.detect?.agents ?? [];
  const used = new Set(Object.keys(dashHistory?.agents ?? {}));
  const list = all.filter(a => a.found || used.has(a.id)).sort((a, b) => agentRank(a) - agentRank(b));
  const def = list.findIndex(a => a.id === appState.agent);
  if (def > 0) list.unshift(...list.splice(def, 1));
  return list;
}
function loadAgentDash(): void {
  renderAgentDash();
  const seq = ++dashSeq;
  background(Promise.all([api.agent.usage(), api.agent.history()]).then(([u, h]) => {
    if (seq !== dashSeq) return;
    dashUsage = u;
    dashHistory = h;
    renderAgentDash();
  }));
}
function renderAgentDash(): void {
  const agents = dashAgents();
  if (!dashAgent || !agents.some(a => a.id === dashAgent)) dashAgent = agents[0]?.id ?? null;
  const cur = agents.find(a => a.id === dashAgent) ?? null;
  // Tabs: one per agent.
  $('#adTabs').innerHTML = agents.length
    ? agents.map(a => `<button class="ad-tab${a.id === dashAgent ? ' on' : ''}" role="tab" aria-selected="${a.id === dashAgent}" data-dash-agent="${escAttr(a.id)}">${brandMark('ad-mark', a.id, a.name[0])}<span>${esc(a.name)}</span>${a.id === appState.agent ? '<small>Default</small>' : ''}</button>`).join('')
    : '<p class="ad-empty">No agents on this computer yet. Install one in Settings → Agents.</p>';
  renderDashUsage(cur);
  renderDashChart(cur);
  renderDashTable(agents);
}
// The usage card: this month's tokens, how the last week compares with the week before, and a few facts.
function renderDashUsage(a: DetectedAgent | null): void {
  const h = a && dashHistory?.agents[a.id];
  const month = a ? dashUsage?.usage[a.id] ?? 0 : 0;
  $('#adBig').textContent = !a ? '—' : dashUsage ? compact(month) : '…';
  const days = dashDays();
  const sum = (from: number, to: number) => days.slice(from, to).reduce((n, d) => n + dayTotal(h?.days[d]), 0);
  const last = sum(days.length - 7, days.length), prev = sum(days.length - 14, days.length - 7);
  const trend = $('#adTrend');
  if (h && prev > 0) {
    const pct = Math.round((last - prev) / prev * 100);
    trend.textContent = pct === 0 ? 'Same as the week before' : `${pct > 0 ? 'Up' : 'Down'} ${Math.abs(pct)}% from the week before`;
    trend.dataset.dir = pct >= 0 ? 'up' : 'down';
  } else { trend.textContent = h && last ? `${compact(last)} in the last 7 days` : ''; delete trend.dataset.dir; }
  const facts: [string, string][] = [];
  if (h) {
    if (h.tools) facts.push(['Tool calls', h.tools.toLocaleString()]);
    if (h.last) facts.push(['Last used', timeAgo(h.last)]);
  }
  const lim = a ? dashUsage?.limits[a.id]?.[0] : null;
  if (lim) facts.push([`${lim.label} limit`, `${Math.round(100 - lim.used)}% left`]);
  $('#adFacts').innerHTML = facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
}
// The history's days, oldest first.
function dashDays(): string[] {
  const n = dashHistory?.days ?? 14, from = dashHistory ? Date.parse(`${dashHistory.from}T00:00:00Z`) : Date.now() - 13 * 86_400_000;
  return Array.from({ length: n }, (_, i) => new Date(from + i * 86_400_000).toISOString().slice(0, 10));
}
const dashDayLabel = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
// A bar a day, stacked by kind of token; hovering one shows its numbers.
function renderDashChart(a: DetectedAgent | null): void {
  const h = a && dashHistory?.agents[a.id];
  const days = dashDays();
  const totals = days.map(d => dayTotal(h?.days[d]));
  const max = Math.max(...totals, 0);
  // A round top for the scale, so its labels read cleanly.
  const step = max ? 10 ** Math.floor(Math.log10(max)) : 1;
  const top = max ? Math.ceil(max / step) * step : 1;
  const all = totals.reduce((x, y) => x + y, 0);
  $('#adChartTotal').textContent = h ? `${compact(all)} over ${days.length} days` : '';
  $('#adY').innerHTML = [top, top / 2, 0].map(v => `<span>${max ? compact(v) : ''}</span>`).join('');
  const bars = $('#adBars');
  bars.setAttribute('aria-label', a ? `${a.name}: ${compact(all)} tokens over the last ${days.length} days` : 'No agent');
  bars.textContent = '';
  days.forEach((d, i) => {
    const col = document.createElement('div');
    col.className = 'ad-bar';
    col.dataset.day = d;
    const day = h?.days[d];
    for (const [k] of DASH_KINDS) {
      const v = day?.[k] ?? 0;
      if (!v) continue;
      const seg = document.createElement('i');
      seg.dataset.k = k;
      seg.style.height = `${v / top * 100}%`; // set from script: the page's CSP blocks inline style attributes
      col.append(seg);
    }
    if (!totals[i]) col.classList.add('empty');
    bars.append(col);
  });
  // Every other day named under the bars (each one when there's room), the last always.
  $('#adX').innerHTML = days.map((d, i) => `<span>${i % 2 === (days.length - 1) % 2 ? esc(dashDayLabel(d)) : ''}</span>`).join('');
  // The legend shows only kinds this agent has, with their totals; an agent whose tokens aren't split by kind has
  // just the total (a "Tokens" entry would only repeat it).
  let sums = DASH_KINDS.map(([k, label]) => [k, label, days.reduce((n, d) => n + (h?.days[d]?.[k] ?? 0), 0)] as const).filter(([, , n]) => n > 0);
  if (sums.length === 1 && sums[0][0] === 'other') sums = [];
  $('#adLegend').innerHTML = h && all
    ? `<span class="ad-leg-total">Total <b>${compact(all)}</b></span>${sums.map(([k, label, n]) => `<span><i data-k="${k}"></i>${esc(label)} <b>${compact(n)}</b></span>`).join('')}`
    : `<span class="ad-leg-none">${a ? `${esc(a.name)} hasn't used any tokens in the last ${days.length} days.` : ''}</span>`;
}
function showDashTip(bar: HTMLElement): void {
  const h = dashAgent ? dashHistory?.agents[dashAgent] : null;
  const d = bar.dataset.day ?? '';
  const day = h?.days[d];
  const tip = $('#adTip');
  const rows = DASH_KINDS.filter(([k]) => (day?.[k] ?? 0) > 0).map(([k, label]) => `<div><i data-k="${k}"></i>${esc(label)}<b>${compact(day![k])}</b></div>`).join('');
  tip.innerHTML = `<div class="ad-tip-day">${esc(dashDayLabel(d))}</div>${rows || '<div class="ad-tip-none">No tokens</div>'}`;
  tip.classList.remove('hidden');
  const card = $('.ad-chart'), cr = card.getBoundingClientRect(), br = bar.getBoundingClientRect();
  const left = Math.min(br.right - cr.left + 8, cr.width - tip.offsetWidth - 8);
  tip.style.left = `${left < br.left - cr.left ? br.left - cr.left - tip.offsetWidth - 8 : left}px`;
  tip.style.top = `${Math.max(8, br.top - cr.top)}px`;
}
// The other agents: everything but the default. Picking a row shows that agent above.
function renderDashTable(agents: DetectedAgent[]): void {
  const others = agents.filter(a => a.id !== appState.agent);
  const days = dashDays();
  const head = '<div class="ad-tr ad-th" role="row"><span role="columnheader">Agent</span><span role="columnheader">Status</span><span role="columnheader">Tool calls</span><span role="columnheader">Tokens</span><span role="columnheader">Last used</span><span role="columnheader"></span></div>';
  const rows = others.map(a => {
    const h = dashHistory?.agents[a.id];
    const tokens = dashUsage?.usage[a.id] ?? 0;
    const spark = h ? days.slice(-7).map(d => dayTotal(h.days[d])) : [];
    const sparkMax = Math.max(...spark, 1);
    const sparkHtml = spark.length ? `<span class="ad-spark" aria-hidden="true">${spark.map(v => `<i data-h="${Math.round(v / sparkMax * 100)}"></i>`).join('')}</span>` : '';
    return `<div class="ad-tr${a.id === dashAgent ? ' on' : ''}" role="row" tabindex="0" data-dash-agent="${escAttr(a.id)}">
      <span role="cell" class="ad-name">${brandMark('ad-mark', a.id, a.name[0])}${esc(a.name)}</span>
      <span role="cell"><span class="ad-status" data-s="${a.found ? 'ready' : 'missing'}">${a.found ? 'Ready' : 'Not installed'}</span></span>
      <span role="cell">${sparkHtml}${h?.tools ? h.tools.toLocaleString() : '—'}</span>
      <span role="cell">${dashUsage ? compact(tokens) : '…'}</span>
      <span role="cell">${h?.last ? esc(timeAgo(h.last)) : '—'}</span>
      <span role="cell">${a.found ? `<button class="btn btn-sm" data-dash-default="${escAttr(a.id)}">Make default</button>` : ''}</span>
    </div>`;
  }).join('');
  const el = $('#adTable');
  el.innerHTML = others.length ? head + rows : '<p class="ad-empty">No other agents yet. Install more in Settings → Agents.</p>';
  $$<HTMLElement>('.ad-spark i', el).forEach(i => i.style.height = `${Math.max(8, Number(i.dataset.h))}%`);
  $('.ad-table-wrap').classList.toggle('hidden', !agents.length);
}
function pickDashAgent(id: string): void {
  if (!id || id === dashAgent) return;
  dashAgent = id;
  renderAgentDash();
}
$('#adTabs').addEventListener('click', e => pickDashAgent((e.target as HTMLElement).closest<HTMLElement>('[data-dash-agent]')?.dataset.dashAgent ?? ''));
$('#adTable').addEventListener('click', e => {
  const t = e.target as HTMLElement;
  const def = t.closest<HTMLElement>('[data-dash-default]');
  if (def) {
    const ag = appState.detect?.agents.find(a => a.id === def.dataset.dashDefault && a.found);
    if (ag) { makeDefaultAgent(ag); dashAgent = ag.id; renderAgentDash(); toast(`${ag.name} is now the default agent`); }
    return;
  }
  pickDashAgent(t.closest<HTMLElement>('[data-dash-agent]')?.dataset.dashAgent ?? '');
});
$('#adTable').addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = (e.target as HTMLElement).closest<HTMLElement>('.ad-tr[data-dash-agent]');
  if (!row || e.target !== row) return;
  e.preventDefault();
  pickDashAgent(row.dataset.dashAgent ?? '');
});
$('#adBars').addEventListener('pointerover', e => { const b = (e.target as HTMLElement).closest<HTMLElement>('.ad-bar'); if (b) showDashTip(b); });
$('#adBars').addEventListener('pointerleave', () => $('#adTip').classList.add('hidden'));
$$<HTMLElement>('.home-rail [data-home-view]').forEach(b => b.onclick = () => showHomeView(b.dataset.homeView ?? 'session'));
$('#homeSpace').onclick = () => enterMode('box');
function renderHome(): void {
  showHomeView('session');
  renderHomeProfile();
  scanForHome();
  renderRecentList();
  const seq = ++homeSeq;
  background(api.fs.recent().catch(() => [] as RecentFolder[]).then(list => {
    if (seq !== homeSeq) return;
    homeRecent = list;
    renderRecentList();
  }));
}
// The folder a project sits in: the row names the project itself.
const parentDir = (p: string) => p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '') || p;
// A recent project, as on an editor's start page: its name, then where it is.
function recentRowHtml(r: RecentFolder): string {
  const when = r.missing ? 'Folder not found' : r.openedAt ? timeAgo(r.openedAt) : '';
  return `<div class="recent-row${r.missing ? ' missing' : ''}" role="listitem">
    <button class="recent-open" data-open="${escAttr(r.path)}" title="${escAttr(when ? `${r.path} · ${when}` : r.path)}">
      <span class="nm">${esc(r.name)}</span><span class="path">${esc(shortPath(parentDir(r.path)))}</span>
    </button>
  </div>`;
}
// Ten at first; More shows the rest.
const RECENT_SHOWN = 10;
let recentAll = false;
function renderRecentList(): void {
  const list = homeRecent;
  const el = $('#homeRecent');
  const shown = list && !recentAll ? list.slice(0, RECENT_SHOWN) : list;
  const more = list && shown && list.length > shown.length ? '<button class="home-link recent-more" data-more>More</button>' : '';
  const html = !list || !shown ? skeletonRows(4)
    : list.length ? shown.map(recentRowHtml).join('') + more
    : '<div class="recent-empty">Folders you open show up here.</div>';
  // Start-up draws Home more than once; redrawing the same rows would make them flicker.
  if (html === recentListHtml && el.childElementCount) return;
  recentListHtml = html;
  el.innerHTML = html;
}
function leaveHome(): void {
  enterMode(appState.mode);
}
function goHome(): void {
  closeMenu();
  swapScreen('#onboard');
  goStep(STEP.home);
}
$('#logoHome').onclick = goHome;
$('#boxLogoHome').onclick = goHome;
async function openFromHome(dir: string, row: HTMLElement): Promise<void> {
  const r = homeRecent?.find(x => x.path === dir);
  // A folder that's gone can't be opened; with no × on the list any more, picking it takes it off.
  if (r?.missing) {
    homeRecent = (homeRecent ?? []).filter(x => x.path !== dir);
    renderRecentList();
    background(api.fs.forgetRecent(dir).then(() => toast(`${r.name} was moved or deleted, so it's off the list`)));
    return;
  }
  if (rootInfo?.root !== dir) {
    if (!(await confirmDiscard())) return;
    row.classList.add('busy');
    try { await loadWorkspace(await api.fs.openRecent(dir)); } catch (e) { row.classList.remove('busy'); toast(errMsg(e)); renderHome(); return; }
  }
  leaveHome();
}
$('#homeRecent').addEventListener('click', e => {
  const t = e.target as HTMLElement;
  if (t.closest('[data-more]')) { recentAll = true; renderRecentList(); return; }
  const open = t.closest<HTMLElement>('[data-open]');
  if (open) background(openFromHome(open.dataset.open ?? '', open.parentElement as HTMLElement));
});
// Up and down move between projects, like a menu.
$('#homeRecent').addEventListener('keydown', e => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const rows = $$('.recent-open', $('#homeRecent'));
  const i = rows.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  e.preventDefault();
  rows[(i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length].focus();
});
// "Open folder" picks an existing folder; "Create new" makes a new, empty project folder. Both open it.
async function chooseProject(create: boolean): Promise<void> {
  if (!(await confirmDiscard())) return;
  const r = await (create ? api.fs.createFolder() : api.fs.openFolder());
  if (!r) return;
  await loadWorkspace(r);
  toast(create ? `Created ${r.name}` : `Opened ${r.name}`);
  leaveHome();
}
// "Open file" picks one file and opens it in the editor, with its folder as the project unless it sits inside the
// one already open.
async function chooseFile(): Promise<void> {
  if (!(await confirmDiscard())) return;
  const r = await api.fs.openFile();
  if (!r) return;
  if (rootInfo?.root !== r.root) await loadWorkspace(r);
  if (r.open) openFile(r.open);
  toast(`Opened ${r.open ?? r.name}`);
  enterMode('ide');
}
// "New file" goes straight to the IDE and asks only for a name; the file is written once it is saved or run, which
// asks where to put it (see saveUntitled).
async function newUntitledFile(): Promise<void> {
  enterMode('ide');
  const name = (await askName('New file', 'untitled.txt', 'Create'))?.replaceAll('\\', '/').split('/').pop()?.trim();
  if (!name) return;
  const b = untitledBuffer(name);
  openTabs.push(b.path);
  setActive(b.path);
  b.ta?.focus();
}
// Clone Repository: a bar over the greeting takes the address. Enter asks where to put it, clones and opens it;
// Esc, or clicking away while it's empty, puts the bar away. Errors stay in the bar so the address can be fixed.
const cloneForm = $<HTMLFormElement>('#homeClone'), cloneUrl = $<HTMLInputElement>('#homeCloneUrl'), cloneHint = $('#homeCloneHint');
const CLONE_HINT = 'Press Enter to pick a folder and clone, or Esc to cancel.';
let cloning = false;
function openCloneBar(): void {
  cloneForm.classList.remove('hidden', 'err');
  cloneHint.textContent = CLONE_HINT;
  cloneUrl.focus();
  cloneUrl.select();
}
function closeCloneBar(): void {
  if (cloning) return;
  cloneForm.classList.add('hidden');
  cloneUrl.value = '';
  $('#cloneRepo').focus({ preventScroll: true });
}
async function cloneRepo(url: string): Promise<void> {
  if (!(await confirmDiscard())) return;
  cloning = true;
  cloneForm.classList.remove('err');
  cloneForm.classList.add('busy');
  cloneUrl.readOnly = true;
  cloneHint.textContent = 'Pick a folder, then Breeze clones into it…';
  try {
    const r = await api.fs.clone(url);
    if (!r) { cloneHint.textContent = CLONE_HINT; return; }
    await loadWorkspace(r);
    toast(`Cloned ${r.name}`);
    cloning = false;
    closeCloneBar();
    leaveHome();
  } catch (e) {
    cloneForm.classList.add('err');
    cloneHint.textContent = errMsg(e);
    cloneUrl.focus();
  } finally {
    cloning = false;
    cloneForm.classList.remove('busy');
    cloneUrl.readOnly = false;
  }
}
$('#cloneRepo').onclick = openCloneBar;
cloneForm.onsubmit = e => {
  e.preventDefault();
  const url = cloneUrl.value.trim();
  if (!url || cloning) return;
  background(cloneRepo(url));
};
cloneUrl.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCloneBar(); } });
cloneUrl.addEventListener('input', () => {
  if (!cloneForm.classList.contains('err')) return;
  cloneForm.classList.remove('err');
  cloneHint.textContent = CLONE_HINT;
});
cloneUrl.addEventListener('blur', () => { if (!cloneUrl.value.trim()) setTimeout(closeCloneBar, 0); });
$('#pickFolder').onclick = () => background(chooseProject(false));
$('#createFolder').onclick = () => background(chooseProject(true));
$('#pickFile').onclick = () => background(chooseFile());
$('#createFile').onclick = () => background(newUntitledFile());
// The shortcuts Home shows; the IDE's own handler ignores keys while Home is up.
const HOME_KEYS: Record<string, () => Promise<void>> = {
  o: () => chooseProject(false),
  N: () => chooseProject(true),
  n: newUntitledFile,
  k: chooseFile,
};
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const run = HOME_KEYS[e.shiftKey ? e.key.toUpperCase() : e.key.toLowerCase()];
  if (!run) return;
  if ($('.home-step').classList.contains('hidden') || $('#onboard').classList.contains('hidden') || modalOpen()) return;
  e.preventDefault();
  background(run());
});
// Switching between the onboarding, the IDE and Breeze Space: the old screen fades back, the new one rises in.
let swapTimer: TimeoutId | undefined;
let swapSeq = 0;
let stopTeam: (() => void) | null = null;
let stopFlight: (() => void) | null = null; // a flight to or from Breeze Space under way (space.ts)
let booted = false;
// Startup work that fills the screen (git status, fonts, pictures) is collected here, so start-up only counts as
// finished (and sounds come on) once the app looks finished.
let startupWaits: Promise<unknown>[] | null = [];
const holdStartup = <T>(p: Promise<T>): Promise<T> => { startupWaits?.push(p.catch(() => undefined)); return p; };
// True until the app has faded in over the launch (init.ts). Background work that starts processes (git, tool
// checks) waits for it: on Windows each process start freezes the main process, which drives that fade.
let launching = true;
const SCREEN_KEY = 'breeze.screen'; // the screen showing, for a reload or the next launch to come back to (init.ts)
function swapScreen(to: string): void {
  store.set(SCREEN_KEY, to);
  const next = $(to);
  const screens = ['#onboard', '#ide', '#box', '#debug'].map(id => $(id));
  $('#debugBtn').classList.toggle('on', to === '#debug'); // the activity bar's Debug stays lit while its page shows
  // At launch the remembered screen just appears; the animation is for switching.
  if (!booted) {
    for (const el of screens) {
      el.classList.toggle('hidden', el !== next);
    }
    return;
  }

  const prev = screens.find(el => el !== next && !el.classList.contains('hidden') && !el.classList.contains('screen-out') && !el.classList.contains('screen-prep'));
  clearTimeout(swapTimer);
  stopTeam?.();
  stopTeam = null;
  const seq = ++swapSeq; // a swap still waiting to play is cancelled, even if `to` is already showing

  for (const el of screens) {
    if (el !== next && el !== prev) {
      el.classList.remove('screen-out', 'screen-prep', 'screen-lift', 'screen-drop', 'screen-soft');
      el.classList.add('hidden');
    }
  }

  if (!next.classList.contains('hidden') && !next.classList.contains('screen-out') && !next.classList.contains('screen-prep')) return; // already showing
  stopFlight?.();
  next.classList.remove('hidden', 'screen-out', 'screen-in', 'screen-soft-in', 'screen-soft', 'screen-lift', 'screen-drop');
  queueDiscord();
  // The new screen is laid out and painted unseen first (the caller fills it in right after this), and the swap only
  // plays once frames come steadily, so a slow machine doesn't stutter through it.
  next.classList.add('screen-prep');
  void settleFrames(700).then(() => {
    if (seq !== swapSeq) return; // switched again meanwhile
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Into or out of the debugger. Exaggerated: the debugger takes over panel by panel (teamswap.ts). Otherwise the
    // two pages, whose title and activity bars match, cross-fade in place, so it reads as one window changing page.
    const debugSwap = !!prev && (prev.id === 'debug' || next.id === 'debug');
    const team = debugSwap && bigAnim && !still;
    const soft = debugSwap && !team;
    if (team) { // teamswap.ts
      prev.classList.add('screen-team');
      next.classList.add('screen-team');
    }
    const climb = bigAnim && !still && (prev?.id === 'ide' || prev?.id === 'onboard') && next.id === 'box';
    const fall = bigAnim && !still && prev?.id === 'box' && (next.id === 'ide' || next.id === 'onboard');
    next.classList.remove('screen-prep');
    if (climb || fall) flyBetween(next, fall); // space.ts
    // The terminal goes back to the IDE, on the way down once Space's contents have faded, so the conversation doesn't jump.
    if (fall) setTimeout(() => { if (appState.mode === 'ide') terminalBack(); }, 450);
    else if (next.id === 'ide') terminalBack();
    else if (!team) {
      const cls = soft ? 'screen-soft-in' : 'screen-in';
      next.classList.add(cls);
      // Its own end only: the soft page's content has an animation of its own, whose end bubbles up here.
      const ended = (e: AnimationEvent) => { if (e.target !== next) return; next.classList.remove(cls); next.removeEventListener('animationend', ended); };
      next.addEventListener('animationend', ended);
    }
    if (!prev) return;
    prev.classList.add('screen-out');
    if (soft) prev.classList.add('screen-soft');
    if (climb) prev.classList.add('screen-lift');
    if (fall) prev.classList.add('screen-drop');
    // Hidden once its fade has actually finished, not after a fixed 260 ms: opening a project keeps the page busy
    // just then, the fade starts late, and the timer cut it off still 40% visible (Home's bright profile picture
    // vanished in a flash). The timer stays as a fallback for a fade that never gets to run.
    const done = () => {
      prev.removeEventListener('animationend', onEnd);
      stopTeam?.();
      stopTeam = null;
      if (!prev.classList.contains('screen-out')) return; // switched back to it meanwhile
      prev.classList.remove('screen-out', 'screen-lift', 'screen-drop', 'screen-soft');
      prev.classList.add('hidden');
    };
    const onEnd = (e: AnimationEvent) => { if (e.target === prev && !e.pseudoElement && ['screenOut', 'screenLift', 'screenSoftOut'].includes(e.animationName)) done(); };
    prev.addEventListener('animationend', onEnd);
    swapTimer = setTimeout(done, climb || fall ? LIFT_MS : 900);
    if (team) {
      const play = teamSwap(prev, next, done);
      stopTeam = play.stop;
      clearTimeout(swapTimer);
      swapTimer = setTimeout(done, play.ms + 500);
    }
  });
}

function showIde(): void {
  swapScreen('#ide');
  useSurface('ide');
  renderUser();
  applyLayout();
  renderEditor();
  updateActIndicator(true);
}

/* ================= Agents (data) ================= */
const agentsDef: Record<AgentKey, Agent> = {
  assistant: { name: 'Assistant', letter: 'A', tint: 'assistant', model: 'no agent', status: 'idle', task: 'Waiting for a question', used: 0 },
  planner: { name: 'Planner', letter: 'P', tint: 'planner', model: 'no agent', status: 'idle', task: 'Waiting for a prompt', used: 0 },
  builder: { name: 'Builder', letter: 'B', tint: 'builder', model: 'no agent', status: 'idle', task: 'Waiting for a plan', used: 0 },
};
const statusLabel: Record<AgentStatus, string> = { idle: 'Idle', working: 'Working', waiting: 'Waiting for you', done: 'Done' };

