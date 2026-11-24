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
  const opened = new Promise<void>(r => setTimeout(r, 520));
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
  opencode: { letter: 'Oc', tint: 'opencode' },
  local: { letter: 'Ol', tint: 'local' },
  ollama: { letter: 'Ol', tint: 'local' },
  gemini: { letter: 'Ge', tint: 'gemini' },
  openrouter: { letter: 'Or', tint: 'openrouter' },
};
let detecting: Promise<Detection> | null = null;

function detectTools(force = false): Promise<Detection> {
  if (detecting !== null) return detecting;
  // A list already showing (last scan's) stays as it is while this one runs: flashing "Scanning" over it then back
  // read as a flicker.
  if (!appState.detect) {
    $('#obToolPill').className = 'pill'; swapText($('#obToolPill'), 'Scanning');
    $('#obToolList').innerHTML = '<div class="row text-3"><div class="spinner sm"></div>Checking this computer</div>';
  }
  detecting = api.sys.detect(force).then(d => {
    const replacesSpinner = !!$('#obToolList').querySelector('.spinner');
    const moving = replacesSpinner && step === STEP.tools && !motionOff() && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    const card = $('.ob-tools'), before = moving ? card.getBoundingClientRect().height : 0;
    const prev = appState.detect;
    appState.detect = d;
    if (prev) announceAgentChanges(prev, d);
    fixSelectedAgent(); // no agent step any more: the first agent found is the one Breeze starts with (Settings → Agents changes it)
    renderDetection();
    if (moving) {
      // The card grows to the list rather than jumping to it (the step is centred, so a jump moved everything at once),
      // and the rows rise in, all within the step's own motion.
      const after = card.getBoundingClientRect().height;
      if (Math.abs(after - before) > 1) card.animate([{ height: `${before}px` }, { height: `${after}px` }], { duration: 480, easing: 'cubic-bezier(.3, 0, .2, 1)' });
      $$('#obToolList > *').forEach((row, i) => riseIn(row, Math.min(i * 22, 260)));
    }
    return d;
  }).catch((e: unknown) => {
    $('#obToolPill').className = 'pill warn'; swapText($('#obToolPill'), 'Scan failed');
    $('#obToolList').textContent = errMsg(e);
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
// A scan that finds an agent newly installed or connected, or one gone, says so, and the open picker redraws.
function announceAgentChanges(prev: Detection, d: Detection): void {
  const was = new Set(prev.agents.filter(a => a.found).map(a => a.id));
  const now = new Set(d.agents.filter(a => a.found).map(a => a.id));
  const added = d.agents.filter(a => a.found && !was.has(a.id)).map(a => a.name);
  const gone = prev.agents.filter(a => a.found && !now.has(a.id)).map(a => a.name);
  if (added.length) toast(`${added.join(', ')} added`);
  if (gone.length) toast(`${gone.join(', ')} removed`);
  if (added.length || gone.length) pickerRefresh?.();
}
// Keep the chosen agent if it is still usable, else fall back to the first one that is.
function fixSelectedAgent(): void {
  const found = appState.detect?.agents.filter(a => a.found) ?? [];
  if (!appState.agent || !found.some(a => a.id === appState.agent)) appState.agent = found[0]?.id ?? null;
  saveApp();
}

const pillClass = (on: boolean) => (on ? 'blue' : 'ok');
// A connected API agent's card: a model picker and Remove. It carries data-llm-card so its controls are bound to it alone.
function localAgentHtml(a: DetectedAgent, on: boolean, mark: string): string {
  const name = `<span class="nm">${esc(a.name)} <small>API</small></span>`;
  const cloud = !!a.keyUrl;
  const label = on ? 'Selected' : 'Ready';
  const options = (a.models ?? []).map(m => `<option value="${escAttr(m)}"${m === a.version ? ' selected' : ''}>${esc(m)}</option>`).join('');
  const sub = cloud ? a.sub ?? '' : a.path ?? '';
  const off = cloud ? `Forget your ${a.name} key` : 'Forget this server';
  return `<div class="agent-opt api ${on ? 'on' : ''}" role="button" tabindex="0" data-agent="${escAttr(a.id)}" data-llm-card="${escAttr(a.id)}">${mark}${name}
    <span class="side row gap-6"><span class="pill ${pillClass(on)}">${label}</span><button class="get" data-llm-off title="${escAttr(off)}"><span class="get-label">Remove</span></button></span>
    <span class="sub" title="${escAttr(a.path ?? '')}">${esc(sub)}</span>
    <div class="key-row"><select class="select" data-llm-model aria-label="Model">${options}</select></div></div>`;
}
// A version number reads "v2.1.4"; a one-word model alias ("haiku") reads as a name, "Haiku". Anything else
// ("gpt-5.5-codex") is shown as it is.
// Claude Code's --model aliases, named with the model each one runs today. Update when a new model ships.
const CLAUDE_ALIAS_LABELS: Record<string, string> = { fable: 'Fable 5.2', opus: 'Opus 5.5', sonnet: 'Sonnet 5.5', haiku: 'Haiku 5.5' };
function versionLabel(v: string | null | undefined): string {
  if (!v) return '';
  if (CLAUDE_ALIAS_LABELS[v.toLowerCase()]) return CLAUDE_ALIAS_LABELS[v.toLowerCase()];
  if (/^\d/.test(v)) return `v${v}`;
  // "gpt-6.1-sol" reads "GPT 6.1 Sol".
  if (/^gpt-[\w.-]+$/i.test(v)) return v.split('-').map((p, i) => (i === 0 ? 'GPT' : p[0].toUpperCase() + p.slice(1))).join(' ');
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
  if (a.found && a.models?.length && !['codex', 'antigravity', 'claude', 'opencode'].includes(a.id)) {
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
// Which API agent a pasted key is for, by its prefix. Anything else, or no key, goes to the local server (Ollama, LM Studio).
function keyProvider(key: string): string {
  if (/^sk-or-/i.test(key)) return 'openrouter';
  if (/^AIza/.test(key)) return 'gemini';
  return 'local';
}
// One key field for every API agent not connected yet; keyProvider picks the agent, and the connected one joins the list.
function apiKeyHtml(apis: DetectedAgent[]): string {
  if (!apis.length) return '';
  const cloud = apis.filter(a => a.keyUrl).map(a => a.name);
  const local = apis.some(a => !a.keyUrl);
  const hint = cloud.length ? `Paste a ${cloud.join(' or ')} key${local ? ', or leave it empty to find Ollama or LM Studio' : ''}` : 'Finds Ollama or LM Studio running on this computer';
  const links = apis.map(a => `<button class="get" data-get="${escAttr(a.keyUrl ?? a.url)}"><span class="get-label">${esc(a.keyUrl ? `${a.name} key` : `Get ${a.name}`)}</span></button>`).join('');
  return `<div class="agent-opt api api-key missing" data-llm-key-card>
    <span class="nm">API key</span>
    <span class="sub">${esc(hint)}</span>
    <div class="key-row"><input class="input" type="password" data-llm-key aria-label="API key" placeholder="API key" autocomplete="off" spellcheck="false"><button class="btn btn-sm" data-llm-connect>Connect</button></div>
    <div class="key-err hidden"></div><div class="api-links">${links}</div></div>`;
}
// Selected first, then every agent found, then those not installed, then the one key field for the API agents.
function agentOptionsHtml(d: Detection): string {
  const rank = (a: DetectedAgent) => (!a.found ? 2 : a.id === appState.agent ? 0 : 1);
  const rows = d.agents.filter(a => a.found || !a.api).sort((a, b) => rank(a) - rank(b)).map(a => {
    const st = AGENT_STYLE[a.id] ?? { letter: a.name[0], tint: 'default' };
    const on = a.found && a.id === appState.agent;
    const mark = brandMark('mark', st.tint, st.letter);
    return a.api ? localAgentHtml(a, on, mark) : cliAgentHtml(a, on, mark, !!d.demo);
  }).join('');
  return rows + apiKeyHtml(d.agents.filter(a => a.api && !a.found));
}
// Forgets an API agent's key or server (the picker's Remove, Settings -> Agents -> API keys).
async function removeApiAgent(id: string): Promise<void> {
  const a = appState.detect?.agents.find(x => x.id === id);
  await api.llm.disconnect(id);
  if (a) Object.assign(a, { found: false, path: null, version: null, models: [] });
  fixSelectedAgent();
  renderAgentBar();
  toast(`${a?.name ?? id} removed`);
  pickerRefresh?.();
}
// The key field, and each connected API card's controls bound inside that card only.
function bindLocalLlm(root: HTMLElement, onChange: () => void): void {
  const keyCard = root.querySelector<HTMLElement>('[data-llm-key-card]');
  const connect = keyCard?.querySelector<HTMLButtonElement>('[data-llm-connect]');
  const key = keyCard?.querySelector<HTMLInputElement>('[data-llm-key]');
  if (keyCard && connect && key) {
    const err = $('.key-err', keyCard);
    const save = async () => {
      const value = key.value.trim();
      const target = appState.detect?.agents.find(a => a.api && a.id === keyProvider(value));
      if (!target) { err.textContent = "Breeze doesn't recognise that key."; err.classList.remove('hidden'); return; }
      connect.disabled = true; swapText(connect, 'Connecting');
      try {
        const r = await api.llm.connect(target.id, '', value);
        Object.assign(target, { found: true, path: r.url ?? null, version: r.model, models: r.models });
        if (!selectedAgent()) appState.agent = target.id;
        saveApp();
        toast(`${target.name} added · ${r.model}`);
        key.value = ''; // else the redraw would carry it into the next field
        onChange();
      } catch (e) {
        connect.disabled = false; swapText(connect, 'Connect');
        err.textContent = errMsg(e); err.classList.remove('hidden');
      }
    };
    connect.onclick = () => void save();
    key.onkeydown = e => { if (e.key === 'Enter') void save(); };
  }
  $$('[data-llm-card]', root).forEach(card => {
    const id = card.dataset.llmCard ?? '';
    const agent = () => appState.detect?.agents.find(a => a.id === id);
    const nameOf = () => agent()?.name ?? id;
    const model = card.querySelector<HTMLSelectElement>('[data-llm-model]');
    if (model) model.onchange = () => background(api.llm.setModel(id, model.value).then(() => {
      Object.assign(agent() ?? {}, { version: model.value });
      saveApp();
      renderAgentBar();
      toast(`${nameOf()} model · ${model.value}`);
    }));
    card.querySelector<HTMLElement>('[data-llm-off]')?.addEventListener('click', e => {
      e.stopPropagation();
      background(removeApiAgent(id).then(onChange));
    });
  });
}
function bindAgentOptions(root: HTMLElement, onChange: () => void): void {
  $$('[data-agent]', root).forEach(el => {
    const pick = () => {
      appState.agent = el.dataset.agent ?? null;
      const curTab = surfaceTabs['ide']?.find(t => t.id === activeTabId['ide']);
      if (curTab && appState.agent) curTab.agentId = appState.agent;
      saveApp();
      onChange();
      updateScmGenBtn();
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
      } else if (agId === 'antigravity' || agId === 'claude' || agId === 'opencode') {
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
// Setup's Tools step: what Breeze compiles and runs code with, grouped, each missing one with its one-click install.
// Rust links with the C/C++ compiler (rustc calls gcc/clang), and Maven needs a JDK, so those sit beside what they need.
const OB_TOOL_GROUPS: { title: string; note?: string; ids: string[] }[] = [
  { title: 'Essentials', ids: ['git', 'node'] },
  { title: 'Rust', note: 'cargo builds projects; Rust links with the C/C++ compiler below', ids: ['rust', 'cargo', 'lsp-rust', 'cc'] },
  { title: 'Java', note: 'Maven builds with a JDK', ids: ['java', 'maven'] },
  { title: 'Also', ids: ['python', 'dotnet'] },
];
const OB_TOOL_NAMES: Record<string, string> = { rust: 'Rust compiler (rustc)', cargo: 'Cargo', 'lsp-rust': 'rust-analyzer', cc: 'C/C++ compiler', java: 'Java JDK', maven: 'Maven', dotnet: 'C# (.NET SDK)' };
function obToolRowHtml(t: DetectedTool): string {
  const name = esc(OB_TOOL_NAMES[t.id] ?? t.name);
  if (t.found) return `<div class="ob-tool" data-tool="${escAttr(t.id)}"><span class="ob-tool-dot" aria-hidden="true"></span><span><span class="ob-tool-name">${name}</span><span class="ob-tool-sub">${esc(versionLabel(t.version) || 'Installed')}</span></span><span class="pill ok">Ready</span></div>`;
  const { attrs, does } = toolInstall(t);
  const label = attrs.startsWith('data-get') ? 'Download' : 'Install';
  const btn = attrs ? `<button class="btn btn-sm" ${attrs} title="${escAttr(does)}" aria-label="${escAttr(`${label} ${t.name}. ${does}`)}">${label}</button>` : '';
  return `<div class="ob-tool missing" data-tool="${escAttr(t.id)}"><span class="ob-tool-dot" aria-hidden="true"></span><span><span class="ob-tool-name">${name}</span><span class="ob-tool-sub">Not installed</span></span>${btn}</div>`;
}
// A tool installed while Breeze was away comes back from the rescan found: before the list is redrawn, its install
// button is shot where it shows, so the redraw can grow it into the Ready pill (morphPieces, the steps' own morph)
// instead of swapping one for the other. Only on the tools step, and only for buttons in the list's visible part: a
// ghost from a row scrolled out of sight would float over the card.
function obInstalledShots(list: HTMLElement, byId: Map<string, DetectedTool>): Map<string, ButtonShot> {
  const shots = new Map<string, ButtonShot>();
  if (step !== STEP.tools || motionOff() || reducedMotion()) return shots;
  const box = list.getBoundingClientRect();
  $$<HTMLElement>('.ob-tool.missing', list).forEach(row => {
    const b = row.querySelector<HTMLElement>('.btn'), id = row.dataset.tool;
    if (!b || !id || !byId.get(id)?.found) return;
    const r = b.getBoundingClientRect();
    if (r.height && r.top >= box.top && r.bottom <= box.bottom) shots.set(id, shootButton(b));
  });
  return shots;
}
// After the redraw: each shot button grows into its row's pill while the dot turns green and the new version line
// fades in.
function morphInstalled(list: HTMLElement, shots: Map<string, ButtonShot>): void {
  shots.forEach((shot, id) => {
    const row = list.querySelector<HTMLElement>(`.ob-tool[data-tool="${CSS.escape(id)}"]`);
    const pill = row?.querySelector<HTMLElement>('.pill');
    if (!row || !pill) return;
    morphPieces([shot], [pill]);
    obRun($('.ob-tool-dot', row), [{ backgroundColor: '#b45309' }, { backgroundColor: '#1a8f4c' }], { duration: OB_D * .6, easing: OB_FADE });
    fadeAt($('.ob-tool-sub', row), 0, OB_D * .35);
  });
}
function renderObTools(d: Detection): void {
  const byId = new Map<string, DetectedTool>([...d.tools, ...(d.servers ?? [])].map(t => [t.id, t]));
  let missing = 0;
  const html = OB_TOOL_GROUPS.map(g => {
    const rows = g.ids.map(id => byId.get(id)).filter((t): t is DetectedTool => !!t);
    missing += rows.filter(t => !t.found).length;
    return rows.length ? `<div class="ob-tool-group" role="group" aria-label="${escAttr(g.title)}">${esc(g.title)}${g.note ? ` <small>${esc(g.note)}</small>` : ''}</div>${rows.map(obToolRowHtml).join('')}` : '';
  }).join('');
  const list = $('#obToolList'), shots = obInstalledShots(list, byId);
  list.innerHTML = html;
  bindToolButtons(list);
  morphInstalled(list, shots);
  $('#obToolPill').className = missing ? 'pill warn' : 'pill ok';
  swapText($('#obToolPill'), missing ? `${missing} to install` : 'All set');
}
function renderDetection(): void {
  const d = appState.detect;
  if (!d) return;
  renderObTools(d);

  renderToolStatus();
  renderAgentBar();
  // Home's Agent tab, if it's showing, picks up agents the scan just found.
  if (dashOnScreen()) renderAgentDash();
}
// The status bar names only the open file's tools and anything missing (toolStatus, statuscore.ts); hovering it lists
// every tool found. Runs again on each file switch (setActive).
function renderToolStatus(): void {
  const d = appState.detect;
  if (!d) return;
  const path = typeof active === 'string' ? active : '';
  const { text, warn } = toolStatus(d.tools, path ? extOf(path) : '');
  const el = $('#sbTools');
  el.innerHTML = `<span class="${warn ? 'dot-warn' : 'dot-ok'}"></span> ${esc(text)}`;
  el.title = d.tools.filter(t => t.found || !t.optional).map(t => `${toolLabel(t.name)} ${t.found ? 'ready' : 'missing'}`).join('\n');
}
$('#rescan').onclick = () => { detectTools(true).catch(() => { /* the agent card shows the error */ }); };

function selectedAgent(): DetectedAgent | null {
  return appState.detect?.agents.find(a => a.id === appState.agent && a.found) ?? null;
}
function modelLabel(a: DetectedAgent | null): string {
  if (!a) return 'no agent';
  return a.api && a.version ? a.version : a.name;
}

const EFFORTS = ['Low', 'Medium', 'High', 'Extra', 'Max'] as const;
type EffortLevel = typeof EFFORTS[number];
const EFFORT_HINTS: Record<EffortLevel, string> = {
  Low: 'Quick answers, light thinking',
  Medium: 'Balanced speed and depth',
  High: 'Thinks harder, a little slower',
  Extra: 'Thinks much harder, slower',
  Max: 'Deepest thinking, slowest', // Codex has nothing above Extra: its Max runs as Extra (main.ts codexEffort)
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
  } else if (a.id === 'antigravity' || a.id === 'claude' || a.id === 'opencode') {
    await api.agent.setModel(a.id, model, effort.toLowerCase());
    a.version = model;
    saveApp();
    renderAgentBar();
    toast(`${a.name} model set to ${versionLabel(model)} (${effort} effort)`);
  } else if (a.api) {
    await api.llm.setModel(a.id, model);
    a.version = model;
    saveApp();
    renderAgentBar();
    toast(`${a.name} model set to ${model}`); // an API model has no effort setting
  }
}

// "Switch Model": the agent's models in a flat list, then a slider for its effort (a local server has none).
// Every surface that picks a model uses this, so Breeze Space and the agents panel behave the same.
// makeDefault (an agent's own chip): setting its model or effort also makes it the default agent.
// `target`: where the pick goes instead of the agent's own settings (an Agent board box keeps its own model and effort).
interface ModelTarget { model(): string; effort(): EffortLevel; set(model: string, effort: EffortLevel): void }
const MODEL_MENU_FLAT = 20;
// Models by their path segment at `depth` (OpenRouter's "~" alias marker dropped), in the order the agent listed them.
// A model with no deeper segment goes under "": it is listed as is, not as a group.
function modelGroups(models: string[], depth: number): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const m of models) {
    const parts = m.split('/');
    const key = parts.length > depth + 1 ? parts[depth].replace(/^~/, '') : '';
    groups.set(key, [...groups.get(key) ?? [], m]);
  }
  return groups;
}
// The text typed found in the name ranks above a scattered fuzzy match: every OpenRouter name starts "openrouter/",
// so on fuzzy score alone "opus" ranked remm-slerp above claude-opus.
function modelMatch(m: string, q: string): { score: number; hits: number[] } | null {
  const at = m.toLowerCase().indexOf(q.toLowerCase());
  if (at >= 0) return { score: 1e6 - at, hits: Array.from({ length: q.length }, (_, i) => at + i) };
  return fuzzyScore(m, q);
}
// Type to filter a long model list, the same way the Command Palette filters commands; Enter or a click picks one.
function searchModels(models: string[], current: string, pick: (m: string) => void): void {
  let sel = 0;
  let shown: { m: string; hits: number[] }[] = [];
  openModal(`<input class="input w-full" id="qoIn" aria-label="Search models" placeholder="Search models" spellcheck="false"><div class="qo-list" id="qoList"></div>`, el => {
    const input = $<HTMLInputElement>('#qoIn', el);
    input.focus();
    const choose = (i: number) => { const s = shown[i]; if (!s) return; closeModal(); pick(s.m); };
    const render = () => {
      const q = input.value.trim();
      shown = q
        ? models.flatMap(m => { const f = modelMatch(m, q); return f ? [{ m, ...f }] : []; }).sort((x, y) => y.score - x.score).slice(0, 80)
        : models.slice(0, 80).map(m => ({ m, hits: [] }));
      sel = clamp(sel, 0, Math.max(0, shown.length - 1));
      $('#qoList', el).innerHTML = shown.map((s, i) => `<div class="qo-item ${i === sel ? 'on' : ''}" data-i="${i}"><span>${s.m === current ? '✓&nbsp; ' : ''}${paletteLabelHtml(s.m, s.hits)}</span></div>`).join('')
        || '<div class="side-note">No matching models.</div>';
      $$('[data-i]', el).forEach(r => r.onclick = () => choose(Number(r.dataset.i)));
    };
    input.oninput = () => { sel = 0; render(); };
    input.onkeydown = e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel += e.key === 'ArrowDown' ? 1 : -1; render(); $('.qo-item.on', el)?.scrollIntoView({ block: 'nearest' }); }
      if (e.key === 'Enter') choose(sel);
    };
    render();
  }, undefined, 'top');
}
// The maker's mark in front of a model: Claude's starburst, OpenAI's knot, else the agent's own logo.
function modelMark(a: DetectedAgent, m: string): string {
  const full = m.toLowerCase();
  const last = (full.split('/').pop() ?? '').replace(/^~/, '');
  if (a.id === 'claude' || /(^|\/)~?anthropic\//.test(full) || last.startsWith('claude')) return '<span class="model-mark mm-claude" aria-hidden="true"></span>';
  if (a.id === 'codex' || /(^|\/)~?openai\//.test(full) || /^(gpt|chatgpt|o\d|codex)/.test(last)) return '<span class="model-mark mm-openai" aria-hidden="true"></span>';
  if (a.id === 'gemini' || /(^|\/)~?google\//.test(full) || last.startsWith('gemini')) return '<span class="model-mark mm-gemini" aria-hidden="true"></span>';
  return brandMark('menu-ico', a.id, a.name[0] ?? '?');
}
// Claude Code's aliases carry the maker's name in the picker: "Claude Opus 5.5".
function modelRowLabel(a: DetectedAgent, m: string, text: string): string {
  return a.id === 'claude' && CLAUDE_ALIAS_LABELS[m.toLowerCase()] ? `Claude ${text}` : text;
}
// One agent's models as menu rows, each with its maker's mark. "default" (Claude Code's own pick) is never offered.
function agentModelRows(a: DetectedAgent, isChecked: (m: string) => boolean, pick: (m: string) => void): MenuItem[] {
  const all = (a.models ?? []).filter(m => m !== 'default');
  const row = (m: string, text = versionLabel(m)): MenuItem => ({ label: modelRowLabel(a, m, text), icon: modelMark(a, m), checked: () => isChecked(m), run: () => pick(m) });
  // A long list (OpenRouter and OpenCode list hundreds of models) gets nested submenus: provider, then vendor
  // (openrouter/~anthropic/…), each split only while it is still too long to scan, each with a search field on top.
  const rest = (m: string, depth: number) => m.split('/').slice(depth).join('/');
  const grouped = (list: string[], depth: number): MenuItem[] => {
    if (list.length <= MODEL_MENU_FLAT) return list.map(m => row(m, rest(m, depth)));
    return [...modelGroups(list, depth)].flatMap(([key, ms]): MenuItem[] => key
      ? [{ label: key, icon: modelMark(a, `${key}/`), checked: () => ms.some(isChecked), sub: () => [{ label: 'Search models', search: q => found(ms, q, depth + 1) }, ...grouped(ms, depth + 1)] }]
      : ms.map(m => row(m, rest(m, depth))));
  };
  const found = (ms: string[], q: string, depth: number): MenuItem[] => {
    if (!q) return grouped(ms, depth);
    const hits = ms.flatMap(m => { const f = modelMatch(rest(m, depth), q); return f ? [{ m, score: f.score }] : []; }).sort((x, y) => y.score - x.score);
    return hits.length ? hits.slice(0, 80).map(h => row(h.m, rest(h.m, depth))) : [{ label: 'No matching models', enabled: () => false }];
  };
  if (all.length <= MODEL_MENU_FLAT) return all.map(m => row(m));
  const top = grouped(all, 0);
  // A long list with no providers to split it by keeps the search box at the top level.
  return top.some(it => it.sub) ? top : [{ label: 'Search models…', run: () => searchModels(all, all.find(isChecked) ?? '', pick) }, ...top];
}
// The other agents' models, listed under the current one's: a short list inline, a long one (OpenRouter, OpenCode) as a submenu.
function otherAgentRows(a: DetectedAgent, switchTo: (b: DetectedAgent, m: string) => void): MenuItem[] {
  const others = (appState.detect?.agents ?? []).filter(b => b.id !== a.id && b.found && (b.models ?? []).some(m => m !== 'default'));
  return others.flatMap((b): MenuItem[] => {
    const rows = agentModelRows(b, () => false, m => switchTo(b, m));
    const inline = (b.models ?? []).length <= MODEL_MENU_FLAT;
    return [{ sep: true }, ...(inline ? rows : [{ label: agentShortName(b), icon: brandMark('menu-ico', b.id, b.name[0] ?? '?'), sub: () => rows }])];
  });
}
// Picking another agent's model: it gets that model and becomes the default agent.
function switchToAgentModel(b: DetectedAgent, m: string): void {
  background(applyModelAndEffort(b, m, agentEffort(b)).then(() => { if (b.id !== appState.agent) makeDefaultAgent(b); }));
}
// `others`: also list every other agent's models under this one's; picking one calls it.
function modelPickerItems(a: DetectedAgent, makeDefault = false, target?: ModelTarget, others?: (b: DetectedAgent, m: string) => void): MenuItem[] {
  const current = () => target?.model() || a.version || a.models?.find(m => m !== 'default') || '';
  const effortNow = () => (target ? target.effort() : agentEffort(a));
  const apply = (m: string, eff: EffortLevel) => {
    if (target) { target.set(m, eff); return; }
    background(applyModelAndEffort(a, m, eff).then(() => {
      if (makeDefault && a.id !== appState.agent) makeDefaultAgent(a);
    }));
  };
  const models = [...agentModelRows(a, m => current() === m, m => apply(m, effortNow())), ...(others ? otherAgentRows(a, others) : [])];
  const effort: MenuItem[] = a.api ? [] : [...(others ? [{ sep: true }] : []), { slider: {
    label: `${agentShortName(a)} effort`,
    steps: EFFORTS,
    value: () => EFFORTS.indexOf(effortNow()),
    set: i => apply(current(), EFFORTS[i]),
    hint: i => EFFORT_HINTS[EFFORTS[i]],
  } }];
  const list: MenuItem[] = [{ label: 'Switch Model', enabled: () => false }, ...models, ...effort];
  // The search field on top finds a model by name across this agent and, with `others`, every other one found.
  const pool = [a, ...(others ? (appState.detect?.agents ?? []).filter(b => b.id !== a.id && b.found) : [])];
  const hits = (q: string): MenuItem[] => {
    const found = pool.flatMap(b => (b.models ?? []).filter(m => m !== 'default').flatMap(m => {
      const label = modelRowLabel(b, m, versionLabel(m));
      const f = modelMatch(label, q) ?? modelMatch(m, q);
      return f ? [{ b, m, label, score: f.score }] : [];
    })).sort((x, y) => y.score - x.score).slice(0, 80);
    return found.length ? found.map(({ b, m, label }): MenuItem => ({
      label, icon: modelMark(b, m), key: b.id === a.id ? undefined : agentShortName(b),
      checked: () => b.id === a.id && current() === m,
      run: () => (b.id === a.id ? apply(m, effortNow()) : others!(b, m)),
    })) : [{ label: 'No matching models', enabled: () => false }];
  };
  return [{ label: 'Search models', searchFirst: true, search: q => (q ? hits(q) : list) }, ...list];
}

/* ----- Agents: names, mentions and the default agent ----- */
// Mention names must match src/main/mentions.js: the short name, the full name and the id, lowercased.
const AGENT_SHORT_NAMES = new Map([['claude', 'Claude'], ['codex', 'Codex'], ['antigravity', 'Antigravity'], ['opencode', 'OpenCode'], ['local', 'Local'], ['gemini', 'Gemini'], ['openrouter', 'OpenRouter']]);
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
// Opens (or, if it is already open, closes) a popup under a chip.
function openChipMenu(chip: HTMLElement, items: MenuItem[]): void {
  if (menuWasOpen(chip)) {
    closeMenu();
    return;
  }
  closeMenu();
  chip.classList.add('open');
  const r = chip.getBoundingClientRect();
  popupMenu(r.left, r.bottom + 4, items, () => chip.classList.remove('open'), chip);
}

function renderAgentBar(): void {
  const a = selectedAgent();
  const model = a?.api && a.version ? ' · ' + a.version : '';
  const label = a ? a.name + model : 'Choose an agent';
  // The agent's logo first, as in the menu it opens.
  $('#boxModel').innerHTML = `${a ? brandMark('menu-ico', a.id, a.name[0]) : ''}${esc(label)}${svgIcon('chevronDown', 12)}`;
  for (const k of Object.values(agentsDef)) k.model = modelLabel(a);
  renderAgents();
  renderPromptModels();
  updateScmGenBtn();
  if (typeof renderHomeAsk === 'function') renderHomeAsk(); // Home's prompt box shows the same model and effort
  if (typeof renderBoardModels === 'function') renderBoardModels(); // and so do the Agent board's boxes
  if (typeof renderModeSwitch === 'function') renderModeSwitch(); // the switcher's Agent Board half wears the default agent's logo
}


// Redraws the agent picker while it is open (a scan found a change, an API agent was added or removed).
let pickerRefresh: (() => void) | null = null;
// No Scan button: the picker scans as it opens, and any scan that finds an agent added or gone redraws it and says so
// (announceAgentChanges). Rows that change place slide there; a key half typed survives the redraw.
function openAgentPicker(): void {
  openModal(`<h3>Choose your AI agent</h3><p class="sub">Installed coding agents are found automatically. Paste an API key to add Gemini, OpenRouter or a local LLM.</p>
    <div class="agent-list" id="pickList"></div>
    <div class="row end spaced"><button class="btn btn-primary" data-close>Done</button></div>`, m => {
    const list = $('#pickList', m);
    const render = () => {
      if (!m.isConnected) { pickerRefresh = null; return; }
      if (!appState.detect) { list.innerHTML = '<div class="text-3">Scanning</div>'; return; }
      const key = list.querySelector<HTMLInputElement>('[data-llm-key]');
      const typed = key?.value ?? '', focused = !!key && document.activeElement === key;
      const tops = new Map($$('[data-agent]', list).map(el => [el.dataset.agent, el.getBoundingClientRect().top]));
      list.innerHTML = agentOptionsHtml(appState.detect);
      bindAgentOptions(list, () => { render(); renderDetection(); });
      const nextKey = list.querySelector<HTMLInputElement>('[data-llm-key]');
      if (nextKey && typed) nextKey.value = typed;
      if (nextKey && focused) nextKey.focus();
      if (!tops.size || motionOff() || reducedMotion()) return;
      $$('[data-agent]', list).forEach(el => {
        const top = tops.get(el.dataset.agent);
        if (top === undefined) { riseIn(el); return; }
        const dy = top - el.getBoundingClientRect().top;
        if (Math.abs(dy) > 1) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 360, easing: 'cubic-bezier(.3, 0, .2, 1)' });
      });
    };
    pickerRefresh = render;
    render();
    lastAutoScan = Date.now();
    // The first scan of the session fills the list; later ones redraw it only on a change (announceAgentChanges).
    const first = !appState.detect;
    detectTools(!first).then(() => { if (first) render(); }, () => { /* shown in the agent card */ });
  }, () => { pickerRefresh = null; });
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
    // Hidden, nothing can be measured: the indicator goes back to its CSS place, the first view's.
    if (on) $('.home-rail .act-indicator').style.transform = b.offsetParent ? `translateY(${b.offsetTop + (b.offsetHeight - 20) / 2}px)` : '';
  });
  $$('.home-view').forEach(v => v.classList.toggle('hidden', v.dataset.view !== view));
  $('.home-main').scrollTop = 0;
  // Coming to the page, the bars rise in afresh rather than morph from the last visit's.
  if (view === 'agent') { dashDrawn = dashSized = ''; $('#adBars').textContent = ''; loadAgentDash(); }
  if (view === 'friends') openFriends(); else closeFriends();
}

/* ----- Home → Agent: one agent's token use, and the other agents ----- */
// The tabs pick the agent shown (the default first); the table lists the agents that aren't the default, and a row
// shows that agent above. Numbers: this month's tokens (agent:usage) and the last 14 days by kind (agent:history).
let dashAgent: string | null = null;
let dashUsage: AgentUsage | null = null;
let dashHistory: AgentHistory | null = null;
let dashSeq = 0;
// What the chart last drew; the bars rise again only when that changes.
let dashDrawn = '';
let dashSized = ''; // what the cards' row was last measured for (renderAgentDash)
// How many of the history's days the chart shows; kept between visits.
const DASH_RANGES = [7, 14, 30];
let dashRange = DASH_RANGES.includes(store.get('breeze.dashRange', 14)) ? store.get('breeze.dashRange', 14) : 14;
// Dollars: cents under $100, whole dollars above; a tiny amount says so instead of showing $0.00.
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const money = (n: number) => (n > 0 && n < 0.01 ? '< $0.01' : n >= 100 ? usd0.format(n) : usd2.format(n));
const COST_NOTE = 'Estimated at API list prices. On a Claude or ChatGPT plan you pay for the plan, not per token.';
// The same elements as on screen keep their nodes and only take the new texts and attributes, so a refresh updates
// the numbers without rebuilding what is shown; anything else (an element came or went) is redrawn.
function swapHtml(el: HTMLElement, html: string): void {
  const fresh = document.createElement('div');
  fresh.innerHTML = html;
  const shape = (r: Element) => Array.from(r.querySelectorAll('*'), n => `${n.tagName}${n.childNodes.length}`).join();
  if (shape(fresh) !== shape(el)) { el.innerHTML = html; return; }
  const was = [el, ...el.querySelectorAll('*')];
  [fresh, ...fresh.querySelectorAll('*')].forEach((n, i) => {
    const o = was[i];
    if (i) {
      for (const at of Array.from(o.attributes)) if (!n.hasAttribute(at.name)) o.removeAttribute(at.name);
      for (const at of Array.from(n.attributes)) if (o.getAttribute(at.name) !== at.value) o.setAttribute(at.name, at.value);
    }
    n.childNodes.forEach((c, j) => {
      const oc = o.childNodes[j];
      if (c.nodeType === Node.TEXT_NODE && oc.nodeType === Node.TEXT_NODE && oc.textContent !== c.textContent) oc.textContent = c.textContent;
    });
  });
}
// Restarts a CSS animation on these elements (class removed, a reflow, class back).
function replayAnim(els: Element[]): void {
  els.forEach(el => el.classList.remove('anim'));
  void (els[0] as HTMLElement | undefined)?.offsetWidth;
  els.forEach(el => el.classList.add('anim'));
}
const DASH_KINDS: [keyof TokenDay, string][] = [['input', 'Input'], ['cacheWrite', 'Cache write'], ['cacheRead', 'Cache read'], ['output', 'Output'], ['other', 'Tokens']];
const compact = (n: number) => tokenCount.format(Math.round(n));
const dayTotal = (d?: TokenDay) => (d ? d.input + d.output + d.cacheWrite + d.cacheRead + d.other : 0);
// Every installed agent, the default first; an agent that isn't installed but has history still shows.
function dashAgents(): DetectedAgent[] {
  const all = appState.detect?.agents ?? [];
  const used = new Set(Object.keys(dashHistory?.agents ?? {}));
  // Antigravity and OpenCode are left off this page, even as the default agent (as on Settings → Usage).
  const list = all.filter(a => a.id !== 'antigravity' && a.id !== 'opencode' && (a.found || used.has(a.id))).sort((a, b) => agentRank(a) - agentRank(b));
  const def = list.findIndex(a => a.id === appState.agent);
  if (def > 0) list.unshift(...list.splice(def, 1));
  return list;
}
function loadAgentDash(): void {
  renderAgentDash();
  refreshAgentDash();
}
// The page is on screen, on Home or in Settings → Agents.
function dashOnScreen(): boolean {
  return !!$('.agent-dash').offsetParent;
}
// Settings → Agents shows this same page: its one copy moves into Settings' slot (null: back to Home), drawn afresh.
function mountAgentDash(slot: HTMLElement | null): void {
  const dash = $('.agent-dash'), to = slot ?? $('.home-view[data-view="agent"]');
  if (dash.parentElement === to) return;
  to.append(dash);
  if (dashOnScreen()) { dashDrawn = dashSized = ''; $('#adBars').textContent = ''; loadAgentDash(); }
}
// Main reads the agents' logs afresh on each ask (only changed logs are re-read, ~60–100ms with a session running), so
// a page left open asks again every 5 seconds while it is on screen and the window is shown, and as soon as the window
// comes back. Claude's plan limits are fetched at most once a minute however often it asks (claudeLiveLimits).
// Under the power saver every 15 seconds; not at all behind another window (power.ts): it asks again on focus.
const DASH_REFRESH_MS = 5_000;
decorInterval(() => {
  if (document.visibilityState === 'visible' && dashOnScreen()) refreshAgentDash();
}, DASH_REFRESH_MS, 15_000);
window.addEventListener('focus', () => { if (dashOnScreen()) refreshAgentDash(); });
function refreshAgentDash(): void {
  const seq = ++dashSeq;
  background(Promise.all([api.agent.usage(), api.agent.history()]).then(([u, h]) => {
    if (seq !== dashSeq) return;
    dashUsage = u;
    dashHistory = h;
    renderAgentDash();
  }));
}
/* ----- Agent page: whatever changes between two draws animates ----- */
// Everything is redrawn from HTML, so the page is noted just before a draw (shootDash) and compared just after, in the
// same task, before any paint (playDash). Blocks (tabs, facts, limits, legend entries) are matched by what
// they are: one new grows in, one that moved slides from where it was, one whose colours changed (picked) blends.
// Texts are matched by their place in their block (or in the nearest element with an id): one new there grows in,
// a number that changed scrambles, any other changed text fades in.
// A token count not read yet: the app's loading bar (.skel-row) in its place.
const DASH_SKEL = '<span class="skel-row ad-skel" role="img" aria-label="Loading"></span>';
const DASH_BLOCKS = '.ad-tab, .ad-facts > div, .ad-limit, .ad-legend > span, .ad-empty';
const DASH_EASE = SPRING;
const DASH_GROW: Keyframe[] = [{ opacity: 0, transform: 'scale(.96)', filter: 'blur(2px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }];
type DashShot = { blocks: Map<string, { r: DOMRect; bg: string; bd: string; fg: string }>; texts: Map<string, string> };
function dashBlockKey(el: HTMLElement): string {
  if (el.matches('.ad-tab')) return `${el.classList[0]}:${el.dataset.dashAgent ?? 'head'}`;
  if (el.matches('.ad-facts > div')) return `fact:${el.querySelector('dt')?.textContent}`;
  if (el.matches('.ad-limit')) return `limit:${el.querySelector('.ad-limit-top span')?.textContent}`;
  if (el.matches('.ad-legend > span')) return `leg:${el.querySelector('i')?.dataset.k ?? el.className}`;
  return `empty:${el.parentElement?.id}`;
}
const dashShown = (el: HTMLElement) => el.getClientRects().length > 0;
function dashBlocks(): Map<string, HTMLElement> {
  return new Map($$<HTMLElement>(DASH_BLOCKS, $('.agent-dash')).filter(dashShown).map(el => [dashBlockKey(el), el]));
}
// The elements holding text of their own; the bars, their dates and the tip have their own animations.
function dashTexts(): Map<string, HTMLElement> {
  const out = new Map<string, HTMLElement>(), count = new Map<string, number>();
  for (const el of $$<HTMLElement>('*', $('.agent-dash'))) {
    if (el.closest('.ad-roll') || (!el.dataset.to && !Array.from(el.childNodes).some(n => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()))) continue;
    if (el.closest('#adBars, #adX, #adTip') || !dashShown(el)) continue;
    const block = el.closest<HTMLElement>(DASH_BLOCKS);
    const scope = block ? dashBlockKey(block) : `#${el.closest('[id]')?.id}`;
    const n = count.get(scope) ?? 0;
    count.set(scope, n + 1);
    out.set(`${scope}|${n}`, el);
  }
  return out;
}
// A scramble still running counts as the value it is heading for.
const dashText = (el: HTMLElement) => el.dataset.to ?? el.textContent ?? '';
function shootDash(): DashShot | null {
  if (!dashOnScreen()) return null;
  const blocks: DashShot['blocks'] = new Map();
  for (const [k, el] of dashBlocks()) {
    const cs = getComputedStyle(el);
    blocks.set(k, { r: el.getBoundingClientRect(), bg: cs.backgroundColor, bd: cs.borderColor, fg: cs.color });
  }
  return { blocks, texts: new Map(Array.from(dashTexts(), ([k, el]) => [k, dashText(el)])) };
}
function playDash(shot: DashShot | null): void {
  if (!shot) return;
  const grown = new Set<HTMLElement>();
  for (const [k, el] of dashBlocks()) {
    const was = shot.blocks.get(k);
    if (!was) { grown.add(el); el.animate(DASH_GROW, { duration: 450, easing: SPRING }); continue; }
    const r = el.getBoundingClientRect(), dx = was.r.left - r.left, dy = was.r.top - r.top;
    if (Math.abs(dx) > .5 || Math.abs(dy) > .5) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 675, easing: DASH_EASE });
    const cs = getComputedStyle(el);
    if (was.bg !== cs.backgroundColor || was.bd !== cs.borderColor || was.fg !== cs.color) {
      el.animate([{ backgroundColor: was.bg, borderColor: was.bd, color: was.fg }, { backgroundColor: cs.backgroundColor, borderColor: cs.borderColor, color: cs.color }], { duration: 220, easing: 'ease' });
    }
  }
  // "216.1M" and "13.4M" read the same but for their numbers; "1m ago" and "6d ago" don't.
  const shape = (t: string) => t.replace(/\d[\d.,]*[KMBT]?/g, '#');
  for (const [k, el] of dashTexts()) {
    const block = el.closest<HTMLElement>(DASH_BLOCKS);
    if (block && grown.has(block)) continue;
    const was = shot.texts.get(k), now = el.textContent ?? '';
    if (was === undefined) el.animate(DASH_GROW, { duration: 450, easing: SPRING });
    else if (was === now) continue;
    // The usage card's numbers roll like a clock's; the chart's scramble.
    else if (!el.children.length && /\d/.test(now) && el.closest('.ad-usage')) rollText(el, was);
    else if (!el.children.length && /\d/.test(now) && shape(was) === shape(now)) scrambleText(el);
    else el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease' });
  }
}
const scrambling = new WeakMap<HTMLElement, number>();
// Its digits flicker at random and settle left to right; everything else in the text stays put.
function scrambleText(el: HTMLElement): void {
  const to = el.textContent ?? '';
  cancelAnimationFrame(scrambling.get(el) ?? 0);
  el.dataset.to = to;
  const start = performance.now(), dur = 450;
  const tick = (now: number) => {
    const p = Math.min((now - start) / dur, 1), settled = Math.floor(p * to.length);
    el.textContent = p < 1 ? [...to].map((ch, i) => i < settled || !/\d/.test(ch) ? ch : String(Math.floor(Math.random() * 10))).join('') : to;
    if (p < 1) scrambling.set(el, requestAnimationFrame(tick));
    else delete el.dataset.to;
  };
  scrambling.set(el, requestAnimationFrame(tick));
}
// Each character that changed rolls up like a clock's digit: the old one slides up and out as the new one comes up from
// below, right to left a beat apart. Matched from the right, so "959.5M" → "1B" rolls the "M" into the "B".
function rollText(el: HTMLElement, from: string): void {
  const to = el.textContent ?? '';
  if (motionOff()) return;
  el.dataset.to = to;
  const off = from.length - to.length;
  el.innerHTML = [...to].map((ch, i) => {
    const old = from[i + off] ?? '';
    return old === ch ? esc(ch) : `<span class="ad-roll"><span><span>${esc(old) || '&nbsp;'}</span><span>${esc(ch)}</span></span></span>`;
  }).join('');
  const cols = $$<HTMLElement>('.ad-roll > span', el);
  let left = cols.length;
  cols.forEach((c, k) => {
    const a = c.animate([{ transform: 'none' }, { transform: 'translateY(-50%)' }], { duration: 520, delay: (cols.length - 1 - k) * 45, easing: SPRING, fill: 'both' });
    // Redrawn meanwhile (the rolls are gone): the new text stands.
    a.onfinish = a.oncancel = () => { if (--left === 0 && el.dataset.to === to) { if (el.querySelector('.ad-roll')) el.textContent = to; delete el.dataset.to; } };
  });
}
function renderAgentDash(): void {
  const agents = dashAgents();
  if (!dashAgent || !agents.some(a => a.id === dashAgent)) dashAgent = agents[0]?.id ?? null;
  const cur = agents.find(a => a.id === dashAgent) ?? null;
  const shot = shootDash();
  // Every agent's usage card drawn once, unseen (no paint between), so the row stays the tallest one's height whichever
  // is picked. In em: it grows with the page's font size.
  // shortcut: measures the usage card only; a chart legend that wraps for one agent can still move the row.
  const row = $('.ad-cards');
  // Measured again only when something that sets the card's height changed, so a refresh doesn't redraw every
  // agent's card behind the shown one.
  // shortcut: a trend line that wraps for one agent's numbers but not another's isn't in the key; add it if rows jump.
  const sized = `${row.offsetWidth}|${getComputedStyle(row).fontSize}|${!!dashUsage}|${!!dashHistory}|${agents.map(x => {
    const h = dashHistory?.agents[x.id];
    return `${x.id}:${dashUsage?.limits[x.id]?.length ?? 0}:${!!h}:${!!h?.tools}:${!!h?.last}`;
  }).join()}`;
  if (row.offsetParent && sized !== dashSized) {
    dashSized = sized;
    row.style.minHeight = '';
    // Measured with a stand-in for the limits: the bars on screen stay untouched (moved or redrawn, they play their
    // fill from empty again), out of the flow meanwhile, and the shown agent's are updated below.
    const limits = $('#adLimits'), stand = document.createElement('div');
    stand.className = 'ad-limits';
    limits.after(stand);
    limits.style.position = 'absolute';
    limits.style.visibility = 'hidden';
    let tall = 0;
    for (const x of agents) { renderDashUsage(x, stand); tall = Math.max(tall, row.offsetHeight); }
    stand.replaceWith();
    limits.style.position = limits.style.visibility = '';
    row.style.minHeight = `${tall / parseFloat(getComputedStyle(row).fontSize)}em`;
  }
  // Tabs: one per agent.
  swapHtml($('#adTabs'), agents.length
    ? agents.map(a => `<button class="ad-tab${a.id === dashAgent ? ' on' : ''}" role="tab" aria-selected="${a.id === dashAgent}" data-dash-agent="${escAttr(a.id)}">${brandMark('ad-mark', a.id, a.name[0])}<span>${esc(a.name)}</span>${a.id === appState.agent ? '<small>Default</small>' : ''}</button>`).join('')
    : '<p class="ad-empty">No agents on this computer yet. Install one in Settings → Agents.</p>');
  renderDashUsage(cur);
  renderDashChart(cur);
  playDash(shot);
}
// The usage card: this month's tokens, how the last week compares with the week before, and a few facts.
function renderDashUsage(a: DetectedAgent | null, limitsEl = $('#adLimits')): void {
  const h = a && dashHistory?.agents[a.id];
  const month = a ? dashUsage?.usage[a.id] ?? 0 : 0;
  if (a && !dashUsage) $('#adBig').innerHTML = DASH_SKEL;
  else $('#adBig').textContent = a ? compact(month) : '—';
  const days = dashAllDays();
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
  swapHtml($('#adFacts'), facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join(''));
  renderDashLimits(a ? dashUsage?.limits[a.id] ?? [] : [], limitsEl);
}
// When a limit lifts, from its reset time (epoch seconds): "in 42m" today, "in 5h 12m" within a day, else the day and time.
function dashResetText(at: number | null): string {
  if (!at) return '';
  const ms = at * 1000 - Date.now();
  if (ms <= 0) return 'Resets now';
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `Resets in ${min}m`;
  if (min < 24 * 60) return `Resets in ${Math.floor(min / 60)}h ${min % 60}m`;
  return `Resets ${new Date(at * 1000).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
}
// Every usage limit the agent reports (5-hour, weekly…): what is left, a bar of what is used, and when it resets.
function renderDashLimits(limits: LimitWindow[], el = $('#adLimits')): void {
  const html = limits.map(l => {
    const used = Math.round(l.used), left = 100 - used;
    const level = used >= 90 ? 'hot' : used >= 75 ? 'warm' : '';
    const reset = dashResetText(l.resetsAt);
    return `<div class="ad-limit ${level}">
      <div class="ad-limit-top"><span>${esc(l.label)} limit</span><b>${left}% left</b></div>
      <div class="ad-meter" role="meter" aria-label="${escAttr(l.label)} limit used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${used}"><i data-used="${used}"></i></div>
      ${reset ? `<div class="ad-limit-reset">${esc(reset)}</div>` : ''}
    </div>`;
  }).join('');
  el.classList.toggle('hidden', !limits.length);
  const width = (i: HTMLElement) => { i.style.width = `${Math.max(Number(i.dataset.used), 1)}%`; };
  // The same limits as on screen keep their bars, which only take the new width: redrawn on every refresh, each one
  // played its fill from empty again. Their texts are swapped (playDash animates what changed).
  const fresh = document.createElement('div');
  fresh.innerHTML = html;
  const names = (r: ParentNode) => $$('.ad-limit-top span', r).map(s => s.textContent).join('|');
  const was = $$<HTMLElement>('.ad-limit', el);
  if (!was.length || names(el) !== names(fresh)) {
    el.innerHTML = html;
    $$<HTMLElement>('.ad-meter i', el).forEach(width);
    return;
  }
  $$<HTMLElement>('.ad-limit', fresh).forEach((n, k) => {
    const o = was[k];
    o.className = n.className;
    $('.ad-limit-top', o).replaceWith($('.ad-limit-top', n));
    const meter = $('.ad-meter', o), bar = $<HTMLElement>('i', meter);
    meter.setAttribute('aria-valuenow', $('.ad-meter', n).getAttribute('aria-valuenow') ?? '');
    bar.dataset.used = $<HTMLElement>('.ad-meter i', n).dataset.used;
    width(bar);
    const oldReset = o.querySelector('.ad-limit-reset'), newReset = n.querySelector('.ad-limit-reset');
    if (oldReset && newReset) oldReset.replaceWith(newReset);
    else if (newReset) o.append(newReset);
    else oldReset?.replaceWith();
  });
}
// The history's days, oldest first.
function dashAllDays(): string[] {
  const n = dashHistory?.days ?? 30, from = dashHistory ? Date.parse(`${dashHistory.from}T00:00:00Z`) : Date.now() - (n - 1) * 86_400_000;
  return Array.from({ length: n }, (_, i) => new Date(from + i * 86_400_000).toISOString().slice(0, 10));
}
// The days the chart shows: the last of the range.
const dashDays = (): string[] => dashAllDays().slice(-dashRange);
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
  const priced = !!h?.priced;
  const cost = priced ? days.reduce((n, d) => n + (h?.days[d]?.cost ?? 0), 0) : 0;
  const costNote = COST_NOTE + (h?.unpriced ? ` ${compact(h.unpriced)} tokens from models without a known price aren't counted.` : '');
  const total = $('#adChartTotal');
  if (a && !dashHistory) total.innerHTML = DASH_SKEL;
  else total.textContent = h ? `${compact(all)}${priced && all ? ` · ≈ ${money(cost)}` : ''} over ${days.length} days` : '';
  total.title = priced ? costNote : '';
  $$<HTMLElement>('#adRange [data-range]').forEach(b => { const on = Number(b.dataset.range) === dashRange; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
  swapHtml($('#adY'), [top, top / 2, 0].map(v => `<span>${max ? compact(v) : ''}</span>`).join(''));
  const bars = $('#adBars');
  bars.dataset.n = String(days.length);
  $('#adX').dataset.n = String(days.length);
  bars.setAttribute('aria-label', a ? `${a.name}: ${compact(all)} tokens over the last ${days.length} days` : 'No agent');
  // The same number of days as drawn: the bars stay and ease to their new heights (a CSS transition); another number
  // draws them afresh, rising in. A bar has a segment for every kind, an unused one at no height, so each can morph.
  const morph = bars.children.length === days.length;
  // Another range (7d, 14d, 30d): the bars are made afresh, and each day still shown glides from its old place and size,
  // its date with it; days new to the chart grow up from the axis. The first draw rises in instead.
  const flip = !morph && bars.children.length > 0 && dashOnScreen() && !motionOff();
  const wasBars = new Map(flip ? Array.from(bars.children as HTMLCollectionOf<HTMLElement>, c => [c.dataset.day, c.getBoundingClientRect()]) : []);
  const wasX = new Map(flip ? $$<HTMLElement>('#adX span').filter(s => s.textContent).map(s => [s.textContent, s.getBoundingClientRect()]) : []);
  if (!morph) {
    if (flip) bars.classList.remove('anim'); // or every new bar plays its rise
    bars.textContent = '';
    for (let i = 0; i < days.length; i++) {
      const col = document.createElement('div');
      col.className = 'ad-bar';
      for (const [k] of DASH_KINDS) { const seg = document.createElement('i'); seg.dataset.k = k; col.append(seg); }
      bars.append(col);
    }
  }
  days.forEach((d, i) => {
    const col = bars.children[i] as HTMLElement;
    col.dataset.day = d;
    const day = h?.days[d];
    // Set from script: the page's CSP blocks inline style attributes.
    DASH_KINDS.forEach(([k], j) => { (col.children[j] as HTMLElement).style.height = totals[i] ? `${(day?.[k] ?? 0) / totals[i] * 100}%` : '0%'; });
    col.style.height = totals[i] ? `${totals[i] / top * 100}%` : '';
    col.style.setProperty('--lvl', String(max ? totals[i] / max : 1)); // the busiest day is full blue, quieter ones darker
    col.classList.toggle('zero', !totals[i]); // not .empty: that is the app-wide empty-state class (padding, centring)
    col.style.setProperty('--i', String(i));
  });
  // Days named under the bars counting back from the last, which is always named: each one for a week, every other
  // one for two weeks, every fifth for a month.
  const every = days.length <= 7 ? 1 : days.length <= 14 ? 2 : 5;
  swapHtml($('#adX'), days.map((d, i) => `<span>${(days.length - 1 - i) % every === 0 ? esc(dashDayLabel(d)) : ''}</span>`).join(''));
  if (flip) {
    const glide = { duration: 675, easing: DASH_EASE };
    for (const col of Array.from(bars.children as HTMLCollectionOf<HTMLElement>)) {
      const o = wasBars.get(col.dataset.day), r = col.getBoundingClientRect();
      if (!o) { col.animate([{ opacity: 0, transform: 'scaleY(0)' }, { opacity: 1, transform: 'none' }], glide); continue; }
      col.animate([{ transform: `translateX(${o.left - r.left}px) scale(${o.width / (r.width || 1)}, ${o.height / (r.height || 1)})` }, { transform: 'none' }], glide);
    }
    for (const s of $$<HTMLElement>('#adX span')) {
      const o = s.textContent && wasX.get(s.textContent);
      if (o) s.animate([{ transform: `translateX(${o.left - s.getBoundingClientRect().left}px)` }, { transform: 'none' }], glide);
      else if (s.textContent) s.animate(DASH_GROW, glide);
    }
  }
  // The legend shows only kinds this agent has, with their totals; an agent whose tokens aren't split by kind has
  // just the total (a "Tokens" entry would only repeat it).
  let sums = DASH_KINDS.map(([k, label]) => [k, label, days.reduce((n, d) => n + (h?.days[d]?.[k] ?? 0), 0)] as const).filter(([, , n]) => n > 0);
  if (sums.length === 1 && sums[0][0] === 'other') sums = [];
  swapHtml($('#adLegend'), a && !dashHistory ? DASH_SKEL : h && all
    ? `<span class="ad-leg-total">Total <b>${compact(all)}</b></span>${priced ? `<span class="ad-leg-cost" title="${escAttr(costNote)}">Est. cost <b>≈ ${money(cost)}</b></span>` : ''}${sums.map(([k, label, n]) => `<span><i data-k="${k}"></i>${esc(label)} <b>${compact(n)}</b></span>`).join('')}`
    : `<span class="ad-leg-none">${a ? `${esc(a.name)} hasn't used any tokens in the last ${days.length} days.` : ''}</span>`);
  const drawn = `${a?.id ?? ''}|${dashRange}|${totals.join(',')}`;
  if (drawn !== dashDrawn && dashOnScreen()) {
    dashDrawn = drawn;
    // Morphing bars keep their axes and legend; what changes on them animates on its own (playDash).
    if (!morph && !flip) replayAnim([bars, $('#adY'), $('#adX'), $('#adLegend')]);
  }
}
function showDashTip(bar: HTMLElement): void {
  const h = dashAgent ? dashHistory?.agents[dashAgent] : null;
  const d = bar.dataset.day ?? '';
  const day = h?.days[d];
  const tip = $('#adTip');
  // Already showing another bar's: it slides and resizes from there and its text blurs in, like the app tooltip
  // (morphTooltip). Measured before the last morph is dropped, so a quick sweep across bars carries on from mid-way.
  const from = tip.classList.contains('hidden') ? null : tip.getBoundingClientRect();
  // The rows shown now, by label (the day by its place), so a number that carries over scrambles to its new value.
  const tipKey = (row: Element) => (row.matches('.ad-tip-day') ? 'day' : Array.from(row.childNodes).find(n => n.nodeType === Node.TEXT_NODE)?.textContent ?? row.className);
  const tipNum = (row: Element) => (row.matches('.ad-tip-day') ? row as HTMLElement : row.querySelector<HTMLElement>('b'));
  const wasRows = new Map(from ? Array.from(tip.children, r => [tipKey(r), tipNum(r) ? dashText(tipNum(r)!) : '']) : []);
  tip.getAnimations().forEach(a => { if (a.id === 'tip') a.cancel(); });
  const rows = DASH_KINDS.filter(([k]) => (day?.[k] ?? 0) > 0).map(([k, label]) => `<div><i data-k="${k}"></i>${esc(label)}<b>${compact(day![k] ?? 0)}</b></div>`).join('');
  const cost = h?.priced && day ? `<div class="ad-tip-cost">Est. cost<b>≈ ${money(day.cost ?? 0)}</b></div>` : '';
  tip.innerHTML = `<div class="ad-tip-day">${esc(dashDayLabel(d))}</div>${rows || '<div class="ad-tip-none">No tokens</div>'}${rows ? cost : ''}`;
  tip.classList.remove('hidden');
  const card = $('.ad-chart'), cr = card.getBoundingClientRect(), br = bar.getBoundingClientRect();
  const left = Math.min(br.right - cr.left + 8, cr.width - tip.offsetWidth - 8);
  tip.style.left = `${left < br.left - cr.left ? br.left - cr.left - tip.offsetWidth - 8 : left}px`;
  tip.style.top = `${Math.max(8, Math.min(br.top - cr.top, cr.height - tip.offsetHeight - 8))}px`;
  if (!from) return;
  const to = tip.getBoundingClientRect();
  const ease = SPRING;
  tip.animate([{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)`, width: `${from.width}px`, height: `${from.height}px` },
    { transform: 'none', width: `${to.width}px`, height: `${to.height}px` }], { duration: 390, easing: ease }).id = 'tip';
  for (const row of Array.from(tip.children)) {
    const num = tipNum(row), was = wasRows.get(tipKey(row));
    if (was !== undefined && num) { if (was !== num.textContent) scrambleText(num); }
    else row.animate([{ opacity: 0, filter: 'blur(2px)' }, { opacity: 1, filter: 'blur(0)' }], { duration: 220, easing: 'cubic-bezier(.2, .8, .2, 1)' });
  }
}
function pickDashAgent(id: string): void {
  if (!id || id === dashAgent) return;
  dashAgent = id;
  renderAgentDash();
}
$('#adTabs').addEventListener('click', e => pickDashAgent((e.target as HTMLElement).closest<HTMLElement>('[data-dash-agent]')?.dataset.dashAgent ?? ''));
$('#adRange').addEventListener('click', e => {
  const n = Number((e.target as HTMLElement).closest<HTMLElement>('[data-range]')?.dataset.range);
  if (!DASH_RANGES.includes(n) || n === dashRange) return;
  dashRange = n;
  store.set('breeze.dashRange', n);
  const shot = shootDash();
  renderDashChart(dashAgents().find(a => a.id === dashAgent) ?? null);
  playDash(shot);
});
// Off a bar the tip goes after a beat, so crossing the gap to the next bar moves it instead of popping it in again.
// Leaving, it sinks and fades the way it came in, then hides; pointing at a bar meanwhile keeps it.
let dashTipHide = 0;
let dashTipOut: Animation | null = null;
const hideDashTip = () => {
  clearTimeout(dashTipHide);
  dashTipHide = window.setTimeout(() => {
    const tip = $('#adTip');
    if (tip.classList.contains('hidden') || dashTipOut) return;
    dashTipOut = tip.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(6px) scale(.94)' }],
      { duration: 150, easing: SPRING });
    dashTipOut.onfinish = () => { tip.classList.add('hidden'); dashTipOut = null; };
  }, 70);
};
$('#adBars').addEventListener('pointerover', e => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.ad-bar');
  if (b) { clearTimeout(dashTipHide); dashTipOut?.cancel(); dashTipOut = null; showDashTip(b); } else hideDashTip();
});
$('#adBars').addEventListener('pointerleave', hideDashTip);
$$<HTMLElement>('.home-rail [data-home-view]').forEach(b => b.onclick = () => showHomeView(b.dataset.homeView ?? 'session'));
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
    <button class="recent-forget" data-forget="${escAttr(r.path)}" title="Remove from Recent" aria-label="Remove ${escAttr(r.name)} from Recent">${TAB_CLOSE_SVG}</button>
  </div>`;
}
// Ten at first; More shows the rest.
const RECENT_SHOWN = 10;
let recentAll = false;
function renderRecentList(): void {
  const list = homeRecent;
  const el = $('#homeRecent');
  const shown = list && !recentAll ? list.slice(0, RECENT_SHOWN) : list;
  const more = list && shown && list.length > shown.length ? '<button class="home-link recent-more" data-more><span class="get-label">More</span></button>' : '';
  const html = !list || !shown ? skeletonRows(4)
    : list.length ? shown.map(recentRowHtml).join('') + more
    : '<div class="recent-empty">Folders you open show up here.</div>';
  // Start-up draws Home more than once; redrawing the same rows would make them flicker.
  // Home's prompt box names a recent folder until one is picked (homedock.ts, which loads after this file).
  if (typeof renderHomeAsk === 'function') renderHomeAsk();
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
  // A folder that's gone can't be opened, so picking it takes it off the list.
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
// The × beside a project: off the list only; the folder itself is left alone.
function forgetFromHome(dir: string): void {
  const r = homeRecent?.find(x => x.path === dir);
  if (!r) return;
  const rows = $$('.recent-open', $('#homeRecent'));
  const at = rows.findIndex(b => b.dataset.open === dir);
  homeRecent = (homeRecent ?? []).filter(x => x.path !== dir);
  renderRecentList();
  // Keyboard focus moves to the next project (or the one before), not back to the top of the page.
  const left = $$('.recent-open', $('#homeRecent'));
  left[Math.min(at, left.length - 1)]?.focus();
  background(api.fs.forgetRecent(dir).then(() => toast(`Removed ${r.name} from Recent`)));
}
$('#homeRecent').addEventListener('click', e => {
  const t = e.target as HTMLElement;
  if (t.closest('[data-more]')) { recentAll = true; renderRecentList(); return; }
  const forget = t.closest<HTMLElement>('[data-forget]');
  if (forget) { forgetFromHome(forget.dataset.forget ?? ''); return; }
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
  const screens = ['#onboard', '#ide', '#box', '#debug', '#board'].map(id => $(id));
  $('#debugBtn').classList.toggle('on', to === '#debug'); // the activity bar's Debug stays lit while its page shows
  $('#boardBtn').classList.toggle('on', to === '#board');
  // At launch the remembered screen just appears; the animation is for switching.
  if (!booted) {
    for (const el of screens) {
      el.classList.toggle('hidden', el !== next);
    }
    return;
  }

  const prev = screens.find(el => el !== next && !el.classList.contains('hidden') && !el.classList.contains('screen-out') && !el.classList.contains('screen-prep'));
  const debugSwap = !!prev && ['debug', 'board'].some(id => prev.id === id || next.id === id); // full pages cross-fade in place
  if (typeof resetModeSwitches === 'function') resetModeSwitches(prev); // the one fading out keeps the slide it just played
  // Clicked away while a debugger swap is still playing: the next one plays faster.
  const quick = debugSwap && next.classList.contains('screen-out');
  clearTimeout(swapTimer);
  const seq = ++swapSeq; // a swap still waiting to play is cancelled, even if `to` is already showing

  for (const el of screens) {
    if (el !== next && el !== prev) {
      el.classList.remove('screen-out', 'screen-prep', 'screen-soft');
      el.classList.add('hidden');
    }
  }

  if (!next.classList.contains('hidden') && !next.classList.contains('screen-out') && !next.classList.contains('screen-prep')) return; // already showing
  next.classList.remove('hidden', 'screen-out', 'screen-in', 'screen-soft-in', 'screen-soft');
  queueDiscord();
  // Into or out of the debugger or the board: one window changing page, not a page reloading. A view transition
  // (.page-morph, breeze.css) holds the title and activity bars still and morphs them, and only the work area fades.
  // The new page is laid out unseen first (screen-prep) for the caller to fill in, and swapped in once the old look is
  // captured. Each page names its bars only while it is the one showing, or the names would clash.
  const root = document.documentElement;
  if (debugSwap && prev && document.startViewTransition && !motionOff() && !matchMedia('(prefers-reduced-motion: reduce)').matches
    && ![...root.classList].some(c => c.endsWith('-morph') || c === 'scm-fade')) {
    next.classList.add('screen-prep');
    prev.classList.add('page-vt');
    root.classList.add('page-morph');
    const done = () => { root.classList.remove('page-morph'); for (const el of screens) el.classList.remove('page-vt'); };
    document.startViewTransition(() => {
      if (seq !== swapSeq) return; // switched again before it played
      prev.classList.remove('page-vt', 'screen-out', 'screen-soft');
      prev.classList.add('hidden');
      next.classList.remove('screen-prep');
      next.classList.add('page-vt');
      if (next.id === 'ide') terminalBack();
    }).finished.then(done, done);
    return;
  }
  // The new screen is laid out and painted unseen first (the caller fills it in right after this), and the swap only
  // plays once frames come steadily, so a slow machine doesn't stutter through it.
  next.classList.add('screen-prep');
  void settleFrames(quick ? 0 : 700).then(() => {
    if (seq !== swapSeq) return; // switched again meanwhile
    // Into or out of the debugger the two pages, whose title and activity bars match, cross-fade in place, so it
    // reads as one window changing page.
    const soft = debugSwap;
    document.documentElement.classList.toggle('swap-quick', quick);
    next.classList.remove('screen-prep');
    if (next.id === 'ide') terminalBack();
    else {
      const cls = soft ? 'screen-soft-in' : 'screen-in';
      next.classList.add(cls);
      // Its own end only: the soft page's content has an animation of its own, whose end bubbles up here.
      const ended = (e: AnimationEvent) => { if (e.target !== next) return; next.classList.remove(cls); next.removeEventListener('animationend', ended); };
      next.addEventListener('animationend', ended);
    }
    if (!prev) return;
    prev.classList.add('screen-out');
    if (soft) prev.classList.add('screen-soft');
    // Hidden once its fade has actually finished, not after a fixed 260 ms: opening a project keeps the page busy
    // just then, the fade starts late, and the timer cut it off still 40% visible (Home's bright profile picture
    // vanished in a flash). The timer stays as a fallback for a fade that never gets to run.
    const done = () => {
      prev.removeEventListener('animationend', onEnd);
      if (!prev.classList.contains('screen-out')) return; // switched back to it meanwhile
      prev.classList.remove('screen-out', 'screen-soft');
      prev.classList.add('hidden');
    };
    const onEnd = (e: AnimationEvent) => { if (e.target === prev && !e.pseudoElement && ['screenOut', 'fadeOut'].includes(e.animationName)) done(); };
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

