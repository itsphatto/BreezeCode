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
  $('#toolsPill').className = 'pill'; swapText($('#toolsPill'), 'Scanning');
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
function toolHtml(t: DetectedTool): string {
  if (!t.found) {
    const label = t.optional ? `${t.name} not found` : `${t.name} missing`;
    const cls = `pill pill-btn tool-pill-missing ${t.optional ? '' : 'warn'}`.trim();
    const { attrs, does } = toolInstall(t);
    return `<button type="button" class="${cls}" data-tool-id="${escAttr(t.id)}" ${attrs} title="${escAttr(does)}" aria-label="${escAttr(`${label}. ${does}`)}">${esc(label)}</button>`;
  }
  const version = t.version ? ' ' + esc(t.version) : '';
  return `<span class="pill ok">${esc(t.name)}${version} ready</span>`;
}
// The install buttons, here and in Settings → Help & About. An install finishes in its own terminal, so for a while
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

  $('#toolList').innerHTML = d.tools.map(toolHtml).join('');
  bindToolButtons($('#toolList'));
  const missing = d.tools.filter(t => !t.found && !t.optional).map(t => t.name);
  $('#toolsPill').className = missing.length ? 'pill warn' : 'pill ok';
  swapText($('#toolsPill'), missing.length ? `${missing.join(' & ')} missing` : 'Ready');

  const summary = d.tools.filter(t => t.found || !t.optional).map(t => `${t.name.replace('.js', '').replace('C/C++', 'C')} ${t.found ? 'ready' : 'missing'}`).join(' · ');
  $('#sbTools').innerHTML = `<span class="${missing.length ? 'dot-warn' : 'dot-ok'}"></span> ${summary}`;
  renderAgentBar();
  renderHomeAgent();
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

// makeDefault (an agent's own chip): setting its model or effort also makes it the default agent.
// efforts: each model opens a submenu of effort levels; without it a click just picks the model (the prompt's
// menu sets effort with its slider instead).
function modelMenuItems(a: DetectedAgent, makeDefault = false, efforts = true): MenuItem[] {
  const apply = (m: string, eff: EffortLevel) => background(applyModelAndEffort(a, m, eff).then(() => {
    if (makeDefault && a.id !== appState.agent) makeDefaultAgent(a);
  }));
  return (a.models ?? []).map(m => {
    const item: MenuItem = {
      label: versionLabel(m),
      checked: () => (a.version || a.models?.[0]) === m,
      run: () => apply(m, agentEffort(a)),
    };
    if (!efforts) return item;
    return {
      ...item,
      subClass: 'effort-menu',
      sub: () => EFFORTS.map(eff => ({
        label: eff,
        checked: () => (a.version || a.models?.[0]) === m && agentEffort(a) === eff,
        run: () => apply(m, eff),
      })),
    };
  });
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
  // Each model opens its effort levels, so the agent's chip is where model and effort are picked.
  const models: MenuItem[] = ag.models?.length
    ? [{ label: 'Model', enabled: () => false }, ...modelMenuItems(ag, true), { sep: true }]
    : [];
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
// A steady colour per project, so each folder is recognisable at a glance.
const projectHue = (name: string) => [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
// Long paths keep their end, the part that tells two projects apart.
const shortPath = (p: string, max = 52) => p.length > max ? `…${p.slice(-(max - 1))}` : p;
function renderHome(): void {
  renderHomeProfile();
  renderHomeAgent();
  autoRescan(); // no Scan button: Home looks for agents again as it opens (the card redraws when the scan lands)
  renderRecentList();
  const seq = ++homeSeq;
  background(api.fs.recent().catch(() => [] as RecentFolder[]).then(list => {
    if (seq !== homeSeq) return;
    homeRecent = list;
    renderRecentList();
  }));
}
function recentRowHtml(r: RecentFolder, i: number): string {
  const when = r.missing ? 'Folder not found' : r.openedAt ? timeAgo(r.openedAt) : '';
  // The most recent project leads, with its own Continue button.
  const lead = i === 0 && !r.missing;
  const cls = ['recent-row', lead ? 'lead' : '', r.missing ? 'missing' : ''].filter(Boolean).join(' ');
  return `<div class="${cls}" role="listitem" data-hue="${projectHue(r.name)}">
    <button class="recent-open" data-open="${escAttr(r.path)}" title="${escAttr(r.path)}">
      <span class="recent-txt">${lead ? `<span class="eyebrow">Last opened${when ? ` - ${esc(when[0].toUpperCase() + when.slice(1))}` : ''}</span>` : ''}<span class="nm">${esc(r.name)}</span><span class="path">${esc(shortPath(r.path))}</span></span>
      ${lead ? `<span class="recent-go">Continue${svgIcon('chevronRight', 14)}</span>` : `<span class="when">${esc(when)}</span>`}
    </button>
    <button class="icon-btn recent-forget" data-forget="${escAttr(r.path)}" title="Remove from this list" aria-label="Remove ${escAttr(r.name)} from recent projects">${svgIcon('x', 13)}</button>
  </div>`;
}
function renderRecentList(): void {
  const list = homeRecent;
  const el = $('#homeRecent');
  $('#homeRecentCount').textContent = list?.length ? String(list.length) : '';
  const empty = `<div class="recent-empty"><span>Projects you open show up here, so you can jump straight back in.</span></div>`;
  const html = !list ? skeletonRows(4) : list.length ? list.map(recentRowHtml).join('') : empty;
  // Start-up draws Home more than once; redrawing the same rows would replay their rise and make them jump.
  if (html === recentListHtml && el.childElementCount) return;
  // A changed list (opening the last project at start-up turns its "2h ago" into "Just now") keeps the rows that
  // were already on screen still; only new ones rise in.
  const shown = new Set($$<HTMLElement>('.recent-open', el).map(b => b.dataset.open));
  recentListHtml = html;
  el.innerHTML = html;
  // Set here, not in the markup: the page's CSP blocks inline style attributes.
  $$('.recent-row', el).forEach((row, i) => {
    row.style.setProperty('--hue', row.dataset.hue ?? '210');
    row.style.setProperty('--i', String(i));
    if (shown.has(row.querySelector<HTMLElement>('.recent-open')?.dataset.open)) row.classList.add('stay');
  });
}
// Every agent found on this computer: picking a row makes it the default (as "Make default" on its chip does).
// A found agent is a radio (picking it makes it the default); a missing one is greyed out with a Get button that
// opens its download page. The default's "Default ·" label is added by markHomeDefault, not here, so switching the
// default never redraws the rows.
function homeAgentRowHtml(a: DetectedAgent): string {
  const st = AGENT_STYLE[a.id] ?? { letter: a.name[0], tint: a.id };
  const mark = brandMark('start-ico agent-mark', st.tint, st.letter);
  if (!a.found) {
    return `<div class="agent-row missing" role="group" aria-label="${escAttr(`${a.name}, not installed`)}">
      ${mark}<span class="start-txt"><span class="nm">${esc(a.name)}</span><span class="sub">Not installed</span></span>
      <button class="btn btn-sm" data-get="${escAttr(a.url)}" aria-label="${escAttr(`Get ${a.name}`)}" title="${escAttr(`Opens the ${a.name} download page`)}">Get</button>
    </div>`;
  }
  // A local server's vendor line (every server it can talk to) is too long for a row.
  const about = a.api ? 'Runs on this computer' : a.vendor;
  return `<div class="agent-row" role="radio" aria-checked="false" tabindex="-1" data-agent="${escAttr(a.id)}">
    ${mark}<span class="start-txt"><span class="nm">${esc(a.name)}</span><span class="sub">${esc(about)}</span></span>
  </div>`;
}
// When a resize reflows a container (Home's agent cards wrapping onto another row as the window is squeezed, Recent
// projects dropping under the ways in), each block glides from where it stood to its new place and eases to its new
// width, and the container eases to its new height, instead of all jumping there. Never scaled, so no text stretches.
//  - Position: a transform, measured from layout (offsetLeft/Top), which no transform skews.
//  - Width: margin-right. A grid item stretches to its column less its margin, so as the margin eases to nothing the
//    card meets its column as it is now, wherever a drag has got to (a width animated to a fixed end went stale).
//  - Height: margin-bottom on the container, so what wraps it (the agents card, the rest of Home) follows.
// Sizes are read as the layout gives them, never as an animation has them: the column is the card's width plus its
// animated margin, and a box's own margin never changes its height. Read with the animation in, the next frame saw a
// jump that wasn't there, started a bigger one, and the cards swung wildly.
// A gentle start: a card crossing to the next row travels most of the card's width, and a curve that set off at full
// speed covered 100 px a frame and read as a leap.
const REFLOW_GLIDE: KeyframeAnimationOptions = { duration: 420, easing: 'cubic-bezier(.4, 0, .2, 1)' };
// Only a jump eases (a card moving to another row, the cards widening as one leaves their row): dragging the window
// narrower also shifts and narrows them a pixel or two every frame, and an animation started for each of those
// cancelled the jump's a frame later.
const REFLOW_JUMP = 24;
const px = (v: string) => Number.parseFloat(v) || 0;
function glideOnReflow(container: HTMLElement): void {
  const at = new WeakMap<Element, { x: number; y: number; w: number }>();
  const baseMb = px(getComputedStyle(container).marginBottom);
  let height = container.offsetHeight;
  const restart = (el: HTMLElement) => { for (const a of el.getAnimations()) if (a.id === 'reflow-glide') a.cancel(); };
  new ResizeObserver(() => {
    // A maximize, restore or snap is instant (win-jump, platform.ts): everything just takes its new place.
    const still = reduceMotion.matches || document.documentElement.classList.contains('win-jump');
    const opts = { ...REFLOW_GLIDE, id: 'reflow-glide' };
    for (const el of container.children) {
      if (!(el instanceof HTMLElement) || !el.offsetParent) continue;
      const cs = getComputedStyle(el), mr = px(cs.marginRight);
      const now = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth + mr }, was = at.get(el);
      at.set(el, now);
      if (!was || still) continue;
      const dx = was.x - now.x, dy = was.y - now.y, dw = was.w - now.w;
      if (Math.hypot(dx, dy) < REFLOW_JUMP && Math.abs(dw) < REFLOW_JUMP) continue;
      // From wherever a glide still running has it, so a second jump carries on from there.
      const cur = new DOMMatrix(cs.transform === 'none' ? undefined : cs.transform);
      restart(el);
      el.animate([
        { transform: `translate(${dx + cur.e}px, ${dy + cur.f}px)`, marginRight: `${mr - dw}px` },
        { transform: 'none', marginRight: '0px' },
      ], opts);
    }
    const h = container.offsetHeight, dh = height - h;
    height = h;
    if (still || Math.abs(dh) < REFLOW_JUMP) return;
    const mb = px(getComputedStyle(container).marginBottom);
    restart(container);
    container.animate([{ marginBottom: `${mb + dh}px` }, { marginBottom: `${baseMb}px` }], opts);
  }).observe(container);
}
glideOnReflow($('#homeAgents'));
glideOnReflow($('.home-grid'));
let homeAgentsHtml = '';
function renderHomeAgent(): void {
  const el = $('#homeAgents');
  if (!appState.detect) { homeAgentsHtml = ''; el.innerHTML = skeletonRows(2); return; }
  const agents = appState.detect.agents;
  const found = agents.filter(a => a.found);
  // Found agents first, so the ones you can pick sit together.
  const html = [...found, ...agents.filter(a => !a.found)].map(homeAgentRowHtml).join('');
  $('#homeAgentNote').textContent = found.length
    ? 'New chats and plans go to the one you pick.'
    : 'None installed yet. The editor, terminal and Git work without one.';
  // The same agents as last time (a rescan that found nothing new, or a new default): keep the rows, just move the
  // selection, so nothing rises in again.
  if (html !== homeAgentsHtml || !el.childElementCount) {
    homeAgentsHtml = html;
    el.innerHTML = html;
    // Each agent rises in turn, so the roster reads as the scan's result.
    $$('.agent-row', el).forEach((row, i) => row.style.setProperty('--i', String(i)));
    $$<HTMLElement>('[data-get]', el).forEach(b => b.onclick = () => background(api.sys.openExternal(b.dataset.get ?? '')));
  }
  markHomeDefault();
}
// Moves the default's look and "Default ·" label onto the current default's row, gliding over from the old one.
function markHomeDefault(): void {
  const el = $('#homeAgents');
  const rows = $$<HTMLElement>('.agent-row[role="radio"]', el);
  const old = el.querySelector<HTMLElement>('.agent-row.on');
  const now = rows.find(r => r.dataset.agent === appState.agent) ?? null;
  if (old === now && now) return;
  const from = old?.getBoundingClientRect();
  old?.querySelector('.def')?.remove();
  for (const r of rows) {
    const on = r === now;
    r.classList.toggle('on', on);
    r.setAttribute('aria-checked', String(on));
    r.tabIndex = on ? 0 : -1;
  }
  now?.querySelector('.sub')?.insertAdjacentHTML('afterbegin', '<span class="def"><b>Default</b> · </span>');
  // Keyboard focus lands on the default; with none picked yet, on the first row.
  if (!now && rows.length) rows[0].tabIndex = 0;
  slideSelected(now, from);
}
function pickHomeAgent(id: string): void {
  const ag = appState.detect?.agents.find(a => a.id === id && a.found);
  if (!ag || ag.id === appState.agent) return;
  makeDefaultAgent(ag);
  markHomeDefault();
  $(`#homeAgents .agent-row[data-agent="${CSS.escape(id)}"]`).focus();
}
$('#homeAgents').addEventListener('click', e => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.agent-row[role="radio"]');
  if (row) pickHomeAgent(row.dataset.agent ?? '');
});
// A radio group: the arrows move the default between installed agents, Enter or Space picks the focused row.
$('#homeAgents').addEventListener('keydown', e => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.agent-row[role="radio"]');
  if (!row || e.target !== row) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickHomeAgent(row.dataset.agent ?? ''); return; }
  const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
  if (!d) return;
  e.preventDefault();
  const rows = $$('.agent-row[role="radio"]', $('#homeAgents'));
  pickHomeAgent(rows[(rows.indexOf(row) + d + rows.length) % rows.length].dataset.agent ?? '');
});
function leaveHome(): void {
  enterMode(appState.mode);
}
function goHome(): void {
  closeMenu();
  swapScreen('#onboard');
  goStep(STEP.home);
}
$('#logoHome').onclick = goHome;
async function openFromHome(dir: string, row: HTMLElement): Promise<void> {
  const r = homeRecent?.find(x => x.path === dir);
  if (r?.missing) { toast(`${r.name} was moved or deleted. Remove it with ×.`); return; }
  if (rootInfo?.root !== dir) {
    if (!(await confirmDiscard())) return;
    row.classList.add('busy');
    try { await loadWorkspace(await api.fs.openRecent(dir)); } catch (e) { row.classList.remove('busy'); toast(errMsg(e)); renderHome(); return; }
  }
  leaveHome();
}
$('#homeRecent').addEventListener('click', e => {
  const t = e.target as HTMLElement;
  const forget = t.closest<HTMLElement>('[data-forget]');
  if (forget) {
    const dir = forget.dataset.forget ?? '';
    const name = homeRecent?.find(x => x.path === dir)?.name ?? dir;
    homeRecent = (homeRecent ?? []).filter(x => x.path !== dir);
    renderRecentList();
    background(api.fs.forgetRecent(dir).then(() => toast(`Removed ${name} from recent projects`)));
    return;
  }
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
// "Open file" picks one file, "New file" names and creates one. Either opens it in the editor, with its folder as the
// project unless it sits inside the one already open.
async function chooseFile(create: boolean): Promise<void> {
  if (!(await confirmDiscard())) return;
  const r = await (create ? api.fs.newFile() : api.fs.openFile());
  if (!r) return;
  if (rootInfo?.root !== r.root) await loadWorkspace(r);
  if (r.open) openFile(r.open);
  toast(create ? `Created ${r.open ?? r.name}` : `Opened ${r.open ?? r.name}`);
  enterMode('ide');
}
$('#pickFolder').onclick = () => background(chooseProject(false));
$('#createFolder').onclick = () => background(chooseProject(true));
$('#pickFile').onclick = () => background(chooseFile(false));
$('#createFile').onclick = () => background(chooseFile(true));
// The shortcuts Home shows; the IDE's own handler ignores keys while Home is up.
const HOME_KEYS: Record<string, () => Promise<void>> = {
  o: () => chooseProject(false),
  N: () => chooseProject(true),
  n: () => chooseFile(true),
  k: () => chooseFile(false),
};
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const run = HOME_KEYS[e.shiftKey ? e.key.toUpperCase() : e.key.toLowerCase()];
  if (!run) return;
  if ($('.home-step').classList.contains('hidden') || $('#onboard').classList.contains('hidden') || modalOpen()) return;
  e.preventDefault();
  background(run());
});
// Switching between the onboarding, the IDE and Breeze Box: the old screen fades back, the new one rises in.
let swapTimer: TimeoutId | undefined;
let swapSeq = 0;
let booted = false;
// Startup work that fills the screen (git status, fonts, pictures) is collected here, so start-up only counts as
// finished (and sounds come on) once the app looks finished.
let startupWaits: Promise<unknown>[] | null = [];
const holdStartup = <T>(p: Promise<T>): Promise<T> => { startupWaits?.push(p.catch(() => undefined)); return p; };
// True until the app has faded in over the launch (init.ts). Background work that starts processes (git, tool
// checks) waits for it: on Windows each process start freezes the main process, which drives that fade.
let launching = true;
function swapScreen(to: string): void {
  const next = $(to);
  const screens = ['#onboard', '#ide', '#box'].map(id => $(id));
  // At launch the remembered screen just appears; the animation is for switching.
  if (!booted) {
    for (const el of screens) {
      el.classList.toggle('hidden', el !== next);
    }
    return;
  }

  const prev = screens.find(el => el !== next && !el.classList.contains('hidden') && !el.classList.contains('screen-out') && !el.classList.contains('screen-prep'));
  clearTimeout(swapTimer);

  for (const el of screens) {
    if (el !== next && el !== prev) {
      el.classList.remove('screen-out', 'screen-prep');
      el.classList.add('hidden');
    }
  }

  if (!next.classList.contains('hidden') && !next.classList.contains('screen-out') && !next.classList.contains('screen-prep')) return; // already showing
  next.classList.remove('hidden', 'screen-out', 'screen-in');
  queueDiscord();
  // The new screen is laid out and painted unseen first (the caller fills it in right after this), and the swap only
  // plays once frames come steadily, so a slow machine doesn't stutter through it.
  next.classList.add('screen-prep');
  const seq = ++swapSeq;
  void settleFrames(700).then(() => {
    if (seq !== swapSeq) return; // switched again meanwhile
    next.classList.remove('screen-prep');
    next.classList.add('screen-in');
    next.addEventListener('animationend', () => next.classList.remove('screen-in'), { once: true });
    if (!prev) return;
    prev.classList.add('screen-out');
    // Hidden once its fade has actually finished, not after a fixed 260 ms: opening a project keeps the page busy
    // just then, the fade starts late, and the timer cut it off still 40% visible (Home's bright profile picture
    // vanished in a flash). The timer stays as a fallback for a fade that never gets to run.
    const done = () => {
      prev.removeEventListener('animationend', onEnd);
      if (!prev.classList.contains('screen-out')) return; // switched back to it meanwhile
      prev.classList.remove('screen-out');
      prev.classList.add('hidden');
    };
    const onEnd = (e: AnimationEvent) => { if (e.target === prev && e.animationName === 'screenOut') done(); };
    prev.addEventListener('animationend', onEnd);
    swapTimer = setTimeout(done, 900);
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

