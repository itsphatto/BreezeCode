/* ================= Agents (UI) ================= */
// No agent cards show until a task is under way. Once the agent answers, the panel says how many
// agents the task needs, and each card appears when that agent starts working.
let team: AgentKey[] = [];
let teamNeed = 0;          // how many agents the current task needs
const TEAM_SIZE: Record<string, number> = { ask: 1, build: 1, plan: 2 };
const TEAM_LINE: Record<string, string> = {
  ask: '1 agent on this: <b>Assistant</b> answers without changing files',
  build: '1 agent on this: <b>Builder</b> makes the changes',
  plan: '2 agents on this: <b>Planner</b> writes a plan, then <b>Builder</b> builds it once you approve',
};
// The agent doing the work: the one a run was given to (@Claude in a chat whose default is Codex), else the default.
function responder(agentId?: string | null): DetectedAgent | null {
  if (!agentId) return selectedAgent();
  return appState.detect?.agents.find(a => a.id === agentId && a.found) ?? selectedAgent();
}
// Planner, Builder and Assistant wear the logo and name of the agent doing the work (Codex, Claude Code…).
function roleMark(k: AgentKey, agentId?: string | null): { letter: string; tint: string } {
  const chosen = responder(agentId);
  if (!chosen) return { letter: agentsDef[k].letter, tint: agentsDef[k].tint };
  return AGENT_STYLE[chosen.id] ?? { letter: chosen.name[0], tint: chosen.id };
}
function teamLineHtml(mode: string, agentId?: string | null): string {
  const chosen = responder(agentId);
  const agentName = chosen?.name ?? 'Assistant';
  if (mode === 'ask') {
    return `1 agent on this: <b>${esc(agentName)}</b> answers without changing files`;
  }
  if (mode === 'build' && chosen) {
    return `1 agent on this: <b>${esc(agentName)}</b> makes the changes`;
  }
  return TEAM_LINE[mode] ?? '';
}
// The per-agent status cards ("Claude · claude · Answered") are gone: the chat already shows who is working
// and the send button stops a run. Only the agent count stays.
function renderAgents(): void {
  const count = $('#agentCount');
  const n = Math.max(teamNeed, team.length);
  count.textContent = String(n);
  count.title = `${plural(n, 'agent')} on this task`;
  count.classList.toggle('hidden', !n);
}
function joinTeam(k: AgentKey): void {
  if (team.includes(k)) return;
  team.push(k);
  renderAgents();
}
function resetTeam(): void {
  team = [];
  teamNeed = 0;
  setAgent('assistant', 'idle', 'Waiting for a question', 0);
  setAgent('planner', 'idle', 'Waiting for a prompt', 0);
  setAgent('builder', 'idle', 'Waiting for a plan', 0);
  for (const a of Object.values(agentsDef)) a.agentId = undefined;
}
function setAgent(k: AgentKey, status: AgentStatus, task: string, used?: number): void {
  Object.assign(agentsDef[k], { status, task });
  if (used != null) agentsDef[k].used = used;
  renderAgents(); vibeTick(); queueDiscord();
  // During a run's event, the chat it belongs to, which need not be the one on screen.
  const curTab = eventTab ?? surfaceTabs[surface.name]?.find(t => t.id === activeTabId[surface.name]);
  if (status === 'working' && curTab?.run?.phase === k) showThinking(thinkingLabel(k, curTab.run.agent), k, curTab, curTab.run.agent);
}

type AttachmentKind = 'image' | 'file' | 'folder';
interface AgentAttachment {
  id: string;
  name: string;
  kind?: AttachmentKind;
  path?: string;
  dataUrl?: string;
  fileUrl?: string;
  fileRel?: string;
}
type ImageAttachment = AgentAttachment;
// A chat surface: the IDE panel, or one box of the Agent board (`board:box1`…`board:box8`).
type SurfaceName = 'ide' | `board:${string}`;
const isBoardSurface = (name: SurfaceName): name is `board:${string}` => name.startsWith('board:');
const boxKeyOf = (name: SurfaceName): string => name.slice('board:'.length);
// A board box whose project isn't the one open: its paths belong there, so the editor, the tree and git leave them alone.
const surfaceAway = (name: SurfaceName): boolean => { const f = SURFACES[name]?.folder; return !!f && (!rootInfo || folderKey(f) !== folderKey(rootInfo.root)); };
const attachmentsMap: Record<string, AgentAttachment[]> = { ide: [] };

// `folder`: an Agent board box's own project, which stays its own when another one is opened.
interface Surface { name: SurfaceName; folder?: string | null; chat: HTMLElement; prompt: HTMLTextAreaElement; send: HTMLElement; mode: HTMLSelectElement; attachmentsEl: HTMLElement; }
const SURFACES: Record<string, Surface> & Record<'ide', Surface> = {
  ide: { name: 'ide', chat: $('#chat'), prompt: $<HTMLTextAreaElement>('#prompt'), send: $('#send'), mode: $<HTMLSelectElement>('#agentMode'), attachmentsEl: $('#promptAttachments') },
};
keepDraft(SURFACES.ide.prompt, () => `breeze.draft:ide:${rootInfo?.root ?? ''}`); // restoreChat puts a folder's back
let surface = SURFACES.ide;     // the one on screen
let msgSurface = surface;       // fallback surface

interface Run {
  id: number;
  tabId: string;
  surfaceName: SurfaceName;
  agent: string;
  mode: AgentMode;
  uiMode: string;
  phase: AgentKey;
  tools: number;
  commands?: number; // tool calls that ran a command, for "ran 2 commands" under the reply
  files: Set<string>;
  drafts?: Set<string>; // files it began creating, shown before they were written
  plan: string | null;
  lastText: string;
  lastMsg?: HTMLElement;
  replied: boolean;
  announce: boolean;
  todos?: AgentEvent['todos'];        // its to-do list, last as sent (todoCard)
  subagents?: SubChat[];              // subagents it started, in order (subchat.ts)
}
let agentRun: Run | null = null;
// The team member whose event is being handled; addMsg gives its lines its logo and name. Null outside team tabs.
let labelAgent: string | null = null;
// The chat whose run's event is being handled, or null.
let eventTab: AgentTabState | null = null;
let lastRunFiles: string[] = [];

interface AgentTabState {
  id: string;
  surfaceName: SurfaceName;
  title: string;
  titleAuto?: boolean;        // the name came from the first request (or the agent): the agent may still rename it
  panel: HTMLElement;
  runId: number | null;
  run: Run | null;
  // One resumable session per agent: a session belongs to the agent that started it (a Codex thread id means nothing to Claude Code).
  sessions: Record<string, string>;
  agentId: string;
  uiMode: string;
  promptDraft: string;
  attachments: ImageAttachment[];
  historyId?: string;
  unreadDone?: boolean;
  lastTeamId?: string;
  agentTeam?: AgentTeamState;
  // While a team is planning who does what (claim pass, then the split card); `runId` is -1 meanwhile.
  teamClaim?: TeamClaimState;
  // Send is waiting for the mention parse, so a second Enter does not send the prompt twice.
  parsing?: boolean;
  // Messages sent with Ctrl+Enter (or to an agent that can't take one mid-task), sent in turn as it finishes (composerui.ts).
  queue?: QueuedMsg[];
}

interface TeamClaimState {
  members: { agentId: string; task: string }[];
  line: HTMLElement;          // the "Planning who does what" line
  cancelled: boolean;         // Stop was pressed: the team is stopped as soon as its id is known
  teamId?: string;
  removed?: Set<string>;      // members taken off on the split card
  cancel?: () => void;        // set while the split card is open: Stop does what its Cancel does
}

// A team of agents building in parallel inside one chat tab (the UI is built on this in the next tasks).
interface AgentTeamState {
  id: string;
  runs: Map<number, Run>;
  pending: number;
  names: Record<string, string>;
  stripEl: HTMLElement;
  finished?: Set<number>;     // runs whose done has arrived
  failed?: Set<string>;       // members that did not finish (error or stopped)
  crossings?: Set<string>;    // one key per agent and path that crossed (see crossingKey)
  stopped?: boolean;          // the person stopped the team
}

// The tab (and run) a run id belongs to: a tab's own single run, or one member of its agent team.
function findTabForRun(runId: number): { tab: AgentTabState; run: Run } | null {
  for (const list of Object.values(surfaceTabs)) {
    for (const tab of list) {
      const run = tab.runId === runId ? tab.run : tab.agentTeam?.runs.get(runId);
      if (run) return { tab, run };
    }
  }
  return null;
}

const surfaceTabs: Record<string, AgentTabState[]> & Record<'ide', AgentTabState[]> = { ide: [] };
const activeTabId: Record<string, string> = { ide: '' };
// An Agent board box: a surface of its own with one chat and no tab strip.
function registerSurface(s: Surface): void {
  SURFACES[s.name] = s;
  surfaceTabs[s.name] ??= [];
  activeTabId[s.name] ??= '';
  attachmentsMap[s.name] ??= [];
  agentInkAt[s.name] ??= null;
}
const createdTabIds = new Set<string>();

// A tab is busy while a run, a team's claim pass (runId -1) or any member of its team is still going.
function tabBusy(t: AgentTabState): boolean {
  return t.runId != null || (t.agentTeam?.pending ?? 0) > 0 || agenticTabBusy(t); // an agentic task in it: agentmode.ts
}
// The chat is waiting on the person: a question, a command to OK or a plan to approve that nobody has answered yet.
// A run that ended leaves its command and question cards behind, so only a plan card counts once nothing is running.
function tabNeedsYou(t: AgentTabState): boolean {
  if (t.panel.querySelector('.card.plan:not(.question) [data-live]')) return true;
  return tabBusy(t) && !!t.panel.querySelector('.card [data-live]');
}
// Repaints the tab strip so a chat's "needs you" dot comes and goes.
function refreshNeedsYou(tab: AgentTabState): void {
  if (isBoardSurface(tab.surfaceName)) { if (typeof paintBoardTabRow === 'function') paintBoardTabRow(tab); return; }
  if (surfaceTabs[tab.surfaceName]?.includes(tab)) renderAgentTabs(SURFACES[tab.surfaceName]);
}
function hasAnyActiveRun(): boolean {
  for (const list of Object.values(surfaceTabs)) {
    if (list.some(tabBusy)) return true;
  }
  return false;
}
function refreshTabBusy(tab: AgentTabState): void {
  const s = SURFACES[tab.surfaceName];
  if (tab.id === activeTabId[tab.surfaceName]) updateTabBusyState(s, tab);
  renderAgentTabs(s);
}

function getActiveTab(s: Surface = surface): AgentTabState {
  const list = surfaceTabs[s.name];
  if (!list.length) {
    const initial = createAgentTab(s);
    activeTabId[s.name] = initial.id;
    initial.panel.classList.add('active');
    renderAgentTabs(s);
    return initial;
  }
  let tab = list.find(t => t.id === activeTabId[s.name]);
  if (!tab) {
    tab = list[0];
    activeTabId[s.name] = tab.id;
    tab.panel.classList.add('active');
    renderAgentTabs(s);
  }
  return tab;
}

function createAgentTab(s: Surface, title?: string, initialHtml?: string, session?: string | null, markNew = false): AgentTabState {
  const count = surfaceTabs[s.name].length + 1;
  const tab: AgentTabState = {
    id: 'atab_' + crypto.randomUUID().slice(0, 8),
    surfaceName: s.name,
    title: title || `Chat ${count}`,
    panel: document.createElement('div'),
    runId: null,
    run: null,
    sessions: session && appState.agent ? { [appState.agent]: session } : {},
    agentId: appState.agent || 'antigravity',
    uiMode: 'build',
    promptDraft: '',
    attachments: [],
  };
  tab.panel.className = 'agent-tab-panel';
  if (initialHtml) {
    setSavedHtml(tab.panel, initialHtml);
  } else {
    tab.panel.innerHTML = `<div class="empty"><div>${idleLogo(40)}<h4>Your agents are ready</h4><div class="empty-line">Tell them what to build. They'll ask if anything's unclear.</div></div></div>`;
  }
  s.chat.appendChild(tab.panel);
  surfaceTabs[s.name].push(tab);
  if (markNew) createdTabIds.add(tab.id);
  renderAgentTabs(s);
  return tab;
}

// The line chases the active tab's live box each frame, so it glides while tabs open, fold away or lose their X
// (a CSS transition aimed once at the tab's box would land where the tab was, then jump).
type InkState = { x: number; y: number; w: number; until: number; raf: number };
const agentInkAt: Record<string, InkState | null> = { ide: null };
function placeAgentTabInk(s: Surface): void {
  if (isBoardSurface(s.name)) return;
  const tabsList = $('#agentTabsList');
  if (!tabsList) return;
  const activeTab = () => tabsList.querySelector<HTMLElement>('.agent-tab.active:not(.leaving)');
  const old = tabsList.querySelector<HTMLElement>('.agent-tab-ink');
  if (!activeTab()) {
    if (old) {
      old.style.opacity = '0';
      setTimeout(() => old.remove(), 120);
    }
    if (agentInkAt[s.name]) cancelAnimationFrame(agentInkAt[s.name]!.raf);
    agentInkAt[s.name] = null;
    return;
  }
  const ink = old ?? tabsList.appendChild(Object.assign(document.createElement('span'), { className: 'agent-tab-ink' }));
  ink.style.opacity = '1';
  const st = agentInkAt[s.name] ??= { x: NaN, y: 0, w: 0, until: 0, raf: 0 };
  st.until = performance.now() + 600; // outlasts the tab enter (.3s), leave (.27s) and X fold (.33s)
  if (st.raf) return;
  let last = performance.now();
  const step = (now: number) => {
    const on = activeTab();
    if (!on || !ink.isConnected) { st.raf = 0; return; }
    const tx = on.offsetLeft + 8, ty = on.offsetTop + on.offsetHeight - 2, tw = Math.max(0, on.offsetWidth - 16);
    const snap = Number.isNaN(st.x) || matchMedia('(prefers-reduced-motion: reduce)').matches;
    const k = snap ? 1 : 1 - Math.exp(-(now - last) / 70);
    last = now;
    st.x = snap ? tx : st.x + (tx - st.x) * k;
    st.y = snap ? ty : st.y + (ty - st.y) * k;
    st.w = snap ? tw : st.w + (tw - st.w) * k;
    const settled = Math.abs(tx - st.x) < .3 && Math.abs(ty - st.y) < .3 && Math.abs(tw - st.w) < .3;
    if (settled) { st.x = tx; st.y = ty; st.w = tw; }
    ink.style.transform = `translate(${st.x}px, ${st.y}px)`;
    ink.style.width = `${st.w}px`;
    st.raf = !settled || now < st.until ? requestAnimationFrame(step) : 0;
  };
  step(last);
}

const closingAgentTabs = new Set<string>();
function renderAgentTabs(s: Surface): void {
  if (isBoardSurface(s.name)) return; // a box has one chat and no tab strip
  const tabsList = $('#agentTabsList');
  if (!tabsList) return;
  const list = surfaceTabs[s.name];
  const curId = activeTabId[s.name];
  // A tab that is folding away doesn't count, so the one that stays loses its X right as the other starts to go.
  const isMulti = list.filter(t => !closingAgentTabs.has(t.id)).length > 1;

  const currentTabIds = new Set(list.map(t => t.id));
  tabsList.querySelectorAll<HTMLElement>('.agent-tab').forEach(el => {
    const tid = el.dataset.agentTab;
    if (tid && !currentTabIds.has(tid) && !el.classList.contains('leaving')) {
      el.remove();
    }
  });

  let prev: HTMLElement | null = null;
  list.forEach(t => {
    const isActive = t.id === curId;
    const isRunning = tabBusy(t);
    const needsYou = tabNeedsYou(t);
    let el = tabsList.querySelector<HTMLElement>(`[data-agent-tab="${t.id}"]`);

    if (!el) {
      const newEl = document.createElement('div');
      newEl.dataset.agentTab = t.id;
      newEl.className = `agent-tab ${isActive ? 'active' : ''} ${isRunning ? 'running' : 'idle'} ${isMulti ? 'closable' : 'single'}${needsYou ? ' needs-you' : ''}`;
      newEl.innerHTML = `
        <span class="tab-status" aria-hidden="true"></span>
        <span class="tab-title">${esc(t.title)}</span>
        <button class="tab-close" type="button" data-close-tab="${escAttr(t.id)}" title="Close tab" aria-label="Close tab">
          <svg class="tab-close-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      `;

      if (createdTabIds.has(t.id)) {
        newEl.classList.add('enter');
        newEl.addEventListener('animationend', () => {
          newEl.classList.remove('enter');
          placeAgentTabInk(s);
        }, { once: true });
        createdTabIds.delete(t.id);
      }

      newEl.onclick = (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('[data-close-tab]') || newEl.classList.contains('leaving')) return;
        switchAgentTab(s, t.id);
      };
      newEl.ondblclick = (e) => {
        if (!(e.target as HTMLElement).closest('[data-close-tab]')) renameAgentTab(s, t);
      };
      newEl.oncontextmenu = (e) => {
        e.preventDefault();
        popupMenu(e.clientX, e.clientY, [
          { label: 'Rename chat', run: () => renameAgentTab(s, t) },
          { label: 'Close chat', run: () => closeAgentTab(s, t.id) },
        ]);
      };

      const closeBtn = newEl.querySelector<HTMLButtonElement>('[data-close-tab]');
      if (closeBtn) {
        closeBtn.onclick = (e) => {
          e.stopPropagation();
          closeAgentTab(s, t.id);
        };
      }

      tabsList.appendChild(newEl);
      prev = newEl;
    } else {
      el.classList.toggle('active', isActive);
      el.classList.toggle('running', isRunning);
      el.classList.toggle('idle', !isRunning);
      el.classList.toggle('needs-you', needsYou);
      el.classList.remove('unread');
      el.classList.toggle('closable', isMulti);
      el.classList.toggle('single', !isMulti);
      el.removeAttribute('title');

      const titleSpan = el.querySelector('.tab-title');
      if (titleSpan && titleSpan.textContent !== t.title) {
        titleSpan.textContent = t.title;
      }
      const statusSpan = el.querySelector<HTMLElement>('.tab-status');
      if (statusSpan) {
        statusSpan.title = needsYou ? 'Needs you' : isRunning ? 'Working' : '';
      }
      // Moved only when out of place: moving it would take focus from a name being typed in it.
      const want = prev ? prev.nextElementSibling : tabsList.firstElementChild;
      if (want !== el) tabsList.insertBefore(el, prev ? prev.nextSibling : tabsList.firstChild);
      prev = el;
    }
  });

  placeAgentTabInk(s);
}

// Swaps a name for a text box: Enter or clicking away keeps what was typed, Escape the old name (done gets null).
function renameInline(el: HTMLElement, value: string, done: (name: string | null) => void): void {
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = value;
  input.maxLength = 64;
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Chat name');
  el.style.display = 'none';
  el.after(input);
  settleIn(input);
  let ended = false;
  const end = (keep: boolean) => {
    if (ended) return;
    ended = true;
    const name = input.value.trim().replaceAll(/\s+/g, ' ');
    input.remove();
    el.style.display = '';
    settleIn(el);
    done(keep && name && name !== value ? name : null);
  };
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); end(true); }
    else if (e.key === 'Escape') { e.preventDefault(); end(false); }
  });
  input.addEventListener('blur', () => end(true));
  for (const ev of ['click', 'dblclick', 'mousedown', 'contextmenu']) input.addEventListener(ev, e => e.stopPropagation());
  input.focus();
  input.select();
}
function renameAgentTab(s: Surface, t: AgentTabState): void {
  const tabsList = $('#agentTabsList');
  const span = tabsList?.querySelector<HTMLElement>(`[data-agent-tab="${t.id}"] .tab-title`);
  if (span && !span.nextElementSibling?.matches('.rename-input')) renameInline(span, t.title, name => { if (name) setChatTitle(t, name); });
}
// A chat's name, on its tab and in its history entry.
function setChatTitle(t: AgentTabState, name: string, auto = false): void {
  t.title = name;
  t.titleAuto = auto;
  if (t.historyId) renameChatEntry(SURFACES[t.surfaceName], t.historyId, name);
  renderAgentTabs(SURFACES[t.surfaceName]);
}
// The agent names the chat from its first request in a few words; a name the person gave meanwhile wins.
async function nameChat(t: AgentTabState, text: string, agentId: string): Promise<void> {
  const prompt = `Write a short title (2 to 5 words) for a chat that starts with the request below. Reply with the title only: no quotes, no trailing punctuation. Do not use any tools.\n\nRequest:\n${text.slice(0, 2000)}`;
  const reply = await api.agent.ask({ agent: agentId, prompt }).catch(() => '');
  const line = String(reply || '').split('\n').map(l => l.trim()).find(Boolean) ?? '';
  const name = line.replace(/^(title:)?[\s"'`*#]*/i, '').replace(/[\s"'`*.]+$/, '').slice(0, 64);
  if (name && t.titleAuto && surfaceTabs[t.surfaceName].includes(t)) setChatTitle(t, name, true);
}

function switchAgentTab(s: Surface, tid: string): void {
  const current = getActiveTab(s);
  if (current && current.id !== tid) {
    current.promptDraft = s.prompt.value;
    current.uiMode = s.mode.value;
    current.attachments = [...(attachmentsMap[s.name] || [])];
    current.panel.classList.remove('active');
  }
  const next = surfaceTabs[s.name].find(t => t.id === tid);
  if (!next) return;
  activeTabId[s.name] = next.id;
  next.unreadDone = false;
  if (typeof renderQueue === 'function') { renderQueue(next); setTimeout(() => background(flushQueue(next)), 0); }
  if (typeof refreshComposers === 'function') refreshComposers();
  next.panel.classList.add('active');

  if (s.name === 'ide' && next.agentId && appState.agent !== next.agentId) {
    appState.agent = next.agentId;
    saveApp();
    renderAgentBar();
  }

  s.prompt.value = next.promptDraft || '';
  mentionWarning(s);
  s.mode.value = 'build';
  attachmentsMap[s.name] = next.attachments || [];
  renderAttachments(s);

  updateTabBusyState(s, next);
  renderAgentTabs(s);
  scrollChat(s);
  s.prompt.focus();
  updateScmGenBtn();
}

function closeAgentTab(s: Surface, tid: string): void {
  const idx = surfaceTabs[s.name].findIndex(t => t.id === tid);
  if (idx === -1) return;
  const tab = surfaceTabs[s.name][idx];
  archiveChatTab(s, tab);
  if (tabBusy(tab)) stopAgent(tab);
  else if (tab.agentTeam || tab.lastTeamId) dropAgentTeam(tab); // its snapshots go with it

  const tabsList = $('#agentTabsList');
  const tabEl = tabsList?.querySelector<HTMLElement>(`[data-agent-tab="${tid}"]`);

  const finalize = () => {
    closingAgentTabs.delete(tid);
    closeSubChat(tab);
    tab.panel.remove();
    const curIdx = surfaceTabs[s.name].findIndex(t => t.id === tid);
    if (curIdx !== -1) surfaceTabs[s.name].splice(curIdx, 1);
    tabEl?.remove();
    if (surfaceTabs[s.name].length === 0) {
      const newTab = createAgentTab(s);
      activeTabId[s.name] = newTab.id;
      newTab.panel.classList.add('active');
      updateTabBusyState(s, newTab);
    } else if (activeTabId[s.name] === tid) {
      const nextIdx = Math.min(idx, surfaceTabs[s.name].length - 1);
      const nextTab = surfaceTabs[s.name][nextIdx];
      activeTabId[s.name] = nextTab.id;
      nextTab.panel.classList.add('active');
      updateTabBusyState(s, nextTab);
    }
    renderAgentTabs(s);
  };

  if (tabEl && !tabEl.classList.contains('leaving')) {
    if (activeTabId[s.name] === tid && surfaceTabs[s.name].length > 1) {
      const nextIdx = idx === surfaceTabs[s.name].length - 1 ? idx - 1 : idx + 1;
      const nextTab = surfaceTabs[s.name][nextIdx];
      if (nextTab) {
        activeTabId[s.name] = nextTab.id;
        nextTab.unreadDone = false;
        tab.panel.classList.remove('active');
        nextTab.panel.classList.add('active');
        s.prompt.value = nextTab.promptDraft || '';
        mentionWarning(s);
        s.mode.value = 'build';
        attachmentsMap[s.name] = nextTab.attachments || [];
        renderAttachments(s);
        updateTabBusyState(s, nextTab);
      }
    }

    const w = tabEl.getBoundingClientRect().width;
    tabEl.style.width = `${w}px`;
    tabEl.style.maxWidth = `${w}px`;
    const _reflow = tabEl.offsetWidth;
    tabEl.classList.add('leaving');
    closingAgentTabs.add(tid);

    if (surfaceTabs[s.name].length === 2) {
      const remainingTab = surfaceTabs[s.name].find(t => t.id !== tid);
      if (remainingTab) {
        const remainingEl = tabsList?.querySelector<HTMLElement>(`[data-agent-tab="${remainingTab.id}"]`);
        if (remainingEl) {
          remainingEl.classList.remove('closable');
          remainingEl.classList.add('single');
        }
      }
    }

    renderAgentTabs(s);

    let finished = false;
    const onEnd = () => {
      if (finished) return;
      finished = true;
      finalize();
    };
    tabEl.addEventListener('transitionend', onEnd, { once: true });
    setTimeout(onEnd, 330);
  } else {
    finalize();
  }
}

function updateTabBusyState(s: Surface, tab?: AgentTabState): void {
  const t = tab || getActiveTab(s);
  const on = tabBusy(t);
  s.send.classList.toggle('stop', on);
  void setIcon(s.send, on ? 'stop' : 'arrowUp');
  const span = $('span', s.send);
  if (span) swapText(span, on ? 'Stop' : 'Send');
  s.send.title = on ? 'Stop the agent' : 'Send (Enter)';
}

function setBusy(on: boolean): void {
  updateTabBusyState(surface);
}

function newAgentTabAction(s: Surface = surface): void {
  const cur = getActiveTab(s);
  if (cur) archiveChatTab(s, cur);
  const newTab = createAgentTab(s, undefined, undefined, null, true);
  switchAgentTab(s, newTab.id);
  const bar = $('#agentTabsBar');
  bar?.scrollTo({ left: bar.scrollWidth, behavior: 'smooth' });
}

function useSurface(name: SurfaceName): void {
  surface = SURFACES[name];
  msgSurface = surface;
}

function scrollChat(s: Surface): void {
  if (s.chat.querySelector(':scope > .agent-tab-panel.active.viewing-sub')) return; // a subagent's chat is open: it scrolls itself
  s.chat.scrollTop = s.chat.scrollHeight;
}

function addMsg(html: string, tab?: AgentTabState): HTMLElement {
  const t = tab || getActiveTab(msgSurface);
  const d = document.createElement('div');
  d.innerHTML = html;
  const el = d.firstElementChild as HTMLElement;
  if (labelAgent) {
    el.dataset.agent = labelAgent;
    // A tool line's first child is its icon, so the badge goes in front of it instead.
    const head = el.classList.contains('tool-line') ? el : el.firstElementChild ?? el;
    head.insertAdjacentHTML('afterbegin', agentBadge(labelAgent));
  }
  const thinking = t.panel.querySelector('.thinking');
  if (thinking) {
    t.panel.insertBefore(el, thinking);
  } else {
    t.panel.appendChild(el);
  }
  if (t.id === activeTabId[t.surfaceName]) {
    scrollChat(SURFACES[t.surfaceName]);
  }
  saveChat(t);
  return el;
}

const clockTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// Whoever answers signs the message with their own name and logo, whichever role (Assistant, Planner, Builder) they hold.
function speaker(k: AgentKey, agentId?: string | null): { name: string; letter: string; tint: string } {
  const chosen = responder(agentId);
  if (chosen) {
    const st = AGENT_STYLE[chosen.id] ?? { letter: chosen.name[0], tint: chosen.id };
    return { name: chosen.name, ...st };
  }
  return { name: agentsDef[k].name, ...roleMark(k) };
}

function agentMsg(k: AgentKey, html: string, tab?: AgentTabState, agentId?: string | null): HTMLElement {
  const t = tab || getActiveTab(msgSurface);
  const { name, letter, tint } = speaker(k, agentId);
  sfx.play('answer');
  // In a team the agent's badge (added by addMsg) names the speaker instead.
  const who = labelAgent ? '' : `${brandMark('avatar mini', tint, letter)}<b>${esc(name)}</b> `;
  return addMsg(`<div class="msg"><div class="meta">${who}${clockTime()}</div><div class="body">${html}</div></div>`, t);
}

function userMsg(text: string, attachments?: AgentAttachment[], tab?: AgentTabState): void {
  const t = tab || getActiveTab(msgSurface);
  let imgHtml = '';
  if (attachments?.length) {
    const items = attachments.map(a => {
      const kind = a.kind || (a.dataUrl || (a.fileUrl && IMAGE_FILE.test(a.name)) ? 'image' : 'file');
      const p = a.path || a.fileRel || a.name;
      if (kind === 'folder') {
        return `<div class="chat-file-chip folder" data-path="${escAttr(p)}" title="Folder: ${escAttr(p)} (click to reveal)"><span class="ico">${folderIcon(a.name, false)}</span><span class="nm">${esc(p)}</span></div>`;
      }
      if (kind === 'file') {
        return `<div class="chat-file-chip file" data-path="${escAttr(p)}" title="File: ${escAttr(p)} (click to open)"><span class="ico">${fileIcon(a.name)}</span><span class="nm">${esc(p)}</span></div>`;
      }
      const src = a.fileUrl || a.dataUrl || '';
      return `<div class="chat-img-wrap" title="Click to view full size"><img src="${escAttr(src)}" class="chat-img" alt="${escAttr(a.name)}" data-full="${escAttr(src)}"></div>`;
    }).join('');
    imgHtml = `<div class="msg-attachments">${items}</div>`;
  }
  const bodyText = text ? `<div>${mentionHtml(text, t.surfaceName === 'ide' || isBoardSurface(t.surfaceName)).replaceAll('\n', '<br>')}</div>` : '';
  closeSubChat(t);
  addMsg(`<div class="msg user"><div class="meta"><b>${esc(displayName() ?? 'You')}</b> ${clockTime()}</div><div class="body">${bodyText}${imgHtml}</div></div>`, t);
}

function thinkingLabel(k: AgentKey, agentId?: string | null): string {
  const who = speaker(k, agentId).name;
  const task = agentsDef[k].task;
  return !task ? `${who} is thinking` : `${who} · ${task}`;
}

/* While an agent works, a header with its logo says what it is doing right now ("Running ls 11.0s"). It opens into the
   steps it has gone through, each with how long it took. The open/closed choice is remembered; it starts closed. */
const THINK_OPEN_KEY = 'breeze.thinkOpen';
const thinkOpen = (): boolean => { try { return localStorage.getItem(THINK_OPEN_KEY) === '1'; } catch { return false; } };
const thinkStarts = new WeakMap<HTMLElement, { start: number; step: number }>();
const secs = (ms: number) => `${Math.floor(ms / 1000)}s`;

// "Claude is planning the steps" → "Planning the steps"; "Claude · Writing code" → "Writing code".
function stepText(label: string, who: string): string {
  let s = label;
  for (const pre of [`${who} is `, `${who} · `]) if (s.startsWith(pre)) s = s.slice(pre.length);
  if (s === 'thinking') return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// A tool line as what is happening now: "$ ls" → "Running ls", "Read a.ts" → "Reading a.ts".
const DOING: Record<string, string> = { $: 'Running', 'PS>': 'Running', Read: 'Reading', Edited: 'Editing', Wrote: 'Writing', Created: 'Creating',
  Deleted: 'Deleting', Moved: 'Moving', Searched: 'Searching', Listed: 'Listing', Took: 'Taking', Updated: 'Updating' };
const doing = (label: string) => label.replace(/^\S+(?= )/, w => DOING[w] ?? w);
// What the working line's header says. Nothing to say is "Thinking".
function thinkLabel(panel: Element, text: string): void {
  const lbl = panel.querySelector<HTMLElement>('.think-head .lbl');
  const line = doing(text).split('\n')[0].trim() || 'Thinking';
  if (lbl && lbl.textContent !== line) lbl.textContent = line;
}

function tickThinking(el: HTMLElement): void {
  const st = thinkStarts.get(el);
  if (!st) return;
  const now = Date.now();
  const time = $('.think-time', el);
  if (time) time.textContent = secs(now - st.start);
  const live = el.querySelector<HTMLElement>('.think-step.live .ts-time');
  if (live) live.textContent = secs(now - st.step);
}

function thinkStep(el: HTMLElement, icon: string, text: string): void {
  if (text) thinkLabel(el, text);
  const list = $('.think-steps', el);
  const st = thinkStarts.get(el);
  if (!list || !st || !text) return;
  const prev = list.lastElementChild as HTMLElement | null;
  if (prev?.classList.contains('live') && $('.ts-lbl', prev)?.textContent === text) return;
  const now = Date.now();
  if (prev?.classList.contains('live')) {
    prev.classList.remove('live');
    const t = $('.ts-time', prev);
    if (t) t.textContent = secs(now - st.step);
  }
  st.step = now;
  list.insertAdjacentHTML('beforeend', `<li class="think-step live"><span class="ti">${svgIcon(icon, 13)}</span><span class="ts-lbl">${esc(text)}</span><span class="ts-time">0s</span></li>`);
}

/* Status words: the thinking label shows a word like "Contemplating" (STATUS_WORDS, greetings.ts) and a new one every
   3s, and each new word brings another dot style (data-dots on .thinking, ten in breeze.css). Both change at the same
   moment: the old word blurs up and out as the new one blurs in, and the three dots travel from where the old style
   had them to where the new one has them. Tuned in the Effect Tuner. */
const STATUS_EVERY = 3000;
const MORPH_MS = 510;
const MORPH_EASE = 'cubic-bezier(.23, 1, .32, 1)'; // strong ease-out: a word arriving
const MORPH_MOVE = 'cubic-bezier(.65, 0, .35, 1)'; // ease-in-out: dots moving from one place on screen to another
const DOT_STYLES = ['jump', 'pulse', 'fade', 'bars', 'orbit', 'glide', 'atom', 'helix', 'flip', 'pop'];
const stillMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;

/* Text morph, for text that cycles (status words, headings, greetings, placeholders): letters the old and new text
   share (in order, a longest common subsequence) slide from where they stood to where they land; the others blur out
   where they stood or blur in where they land, and the box eases to its new width. While it runs the text sits in
   per-letter spans (grouped by word, so lines wrap as before); it ends as plain text. `layout` runs once the new text
   is in, before it is measured (fitting a box to it). Reduced motion: a fade. */
interface CharBox { ch: string; x: number; y: number }
const textMorphs = new WeakMap<HTMLElement, () => void>();
function stopTextMorph(el: HTMLElement): void { textMorphs.get(el)?.(); }
// Each letter's place inside `el`, from its text nodes (code points, so an emoji stays one letter).
function charBoxes(el: HTMLElement): CharBox[] {
  const o = el.getBoundingClientRect(), r = document.createRange(), out: CharBox[] = [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    let i = 0;
    for (const ch of n.textContent ?? '') {
      r.setStart(n, i); r.setEnd(n, i += ch.length);
      const b = r.getBoundingClientRect();
      out.push({ ch, x: b.left - o.left, y: b.top - o.top });
    }
  }
  return out;
}
// For each new letter, the index of the old letter it came from (-1: new). Spaces never pair.
function pairLetters(a: string[], b: string[]): number[] {
  const n = a.length, m = b.length, L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] && a[i].trim() ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const to = new Array<number>(m).fill(-1);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j] && a[i].trim() && L[i][j] === L[i + 1][j + 1] + 1) to[j++] = i++;
    else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
  }
  return to;
}
// `width: false` keeps the box at its new width from the start (a heading in a centred row: easing its width slides
// the row and rewraps the new words mid-morph); the old letters then start from where they stood on screen.
function morphText(el: HTMLElement, text: string, layout?: () => void, { width = true } = {}): void {
  stopTextMorph(el);
  if (el.textContent === text) return;
  // Out of sight it is a plain swap. Under the power saver a fade (one layer on the compositor) stands in for the
  // letter-by-letter blur, which lays out and filters every letter for half a second.
  const shown = decorVisible(el);
  const still = stillMotion() || powerSaver();
  const was = shown && !still ? charBoxes(el) : [], r0 = el.getBoundingClientRect();
  el.textContent = text;
  layout?.();
  if (!shown) return;
  if (still) { el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: MORPH_MS, easing: MORPH_EASE }); return; }
  const r1 = el.getBoundingClientRect(), w0 = r0.width, w1 = r1.width;
  const dx = width ? 0 : r0.left - r1.left, dy = width ? 0 : r0.top - r1.top;
  const before = was.map(c => ({ ch: c.ch, x: c.x + dx, y: c.y + dy }));
  // Where each letter lands as plain text: letter spans lose kerning (up to ~3px over a line), so each aims here instead.
  const land = charBoxes(el).filter(c => c.ch.trim());
  // Those wider letters can wrap a line that only just fits: the box keeps the plain text's height meanwhile, so
  // nothing around it (a centred column, the prompt under it) moves. Each letter still aims at `land`.
  const heightWas = el.style.height;
  el.style.height = getComputedStyle(el).height;
  // The new text as letters, a word to a nowrap span, so they can move on their own and lines still break at spaces.
  const letters: HTMLElement[] = [];
  el.textContent = '';
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s/.test(part)) { el.append(part); continue; }
    const word = el.appendChild(document.createElement('span'));
    word.className = 'tm-w';
    for (const ch of part) { const c = word.appendChild(document.createElement('span')); c.className = 'tm-c'; c.textContent = ch; letters.push(c); }
  }
  el.classList.add('tm-run');
  const after = charBoxes(el).filter(c => c.ch.trim()), old = before.map(c => c.ch);
  const from = pairLetters(old, after.map(c => c.ch)), kept = new Set(from);
  const anims: Animation[] = [], ghosts: HTMLElement[] = [], soft = 'blur(4px)';
  const move = { duration: MORPH_MS, easing: MORPH_MOVE };
  // Letters that leave roll up and out, new ones roll up in from below, left to right a beat apart (capped for long text).
  const roll = (i: number) => Math.min(i, 24) * 12;
  // Each letter holds its landing spot (fill) until the plain text takes over at the end.
  letters.forEach((c, j) => {
    const k = from[j], to = `translate(${land[j].x - after[j].x}px, ${land[j].y - after[j].y}px)`;
    if (k >= 0) anims.push(c.animate([{ transform: `translate(${before[k].x - after[j].x}px, ${before[k].y - after[j].y}px)` }, { transform: to }], { ...move, fill: 'forwards' }));
    else anims.push(c.animate([{ opacity: 0, filter: soft, transform: `${to} translateY(.8em)` }, { opacity: 1, filter: 'blur(0)', transform: to }], { duration: MORPH_MS, delay: MORPH_MS * .15 + roll(j), easing: MORPH_EASE, fill: 'both' }));
  });
  // Letters that leave: a copy where each stood, blurring away.
  before.forEach((b, i) => {
    if (kept.has(i) || !b.ch.trim()) return;
    const g = el.appendChild(document.createElement('span'));
    g.className = 'tm-ghost';
    g.textContent = b.ch;
    g.style.left = `${b.x}px`; g.style.top = `${b.y}px`;
    // Where its letter landed may be off by the border and line box: move it by the difference.
    const o = el.getBoundingClientRect(), r = document.createRange();
    r.selectNodeContents(g);
    const p = r.getBoundingClientRect();
    g.style.left = `${2 * b.x - (p.left - o.left)}px`; g.style.top = `${2 * b.y - (p.top - o.top)}px`;
    ghosts.push(g);
    anims.push(g.animate([{ opacity: 1, filter: 'blur(0)', transform: 'none' }, { opacity: 0, filter: soft, transform: 'translateY(-.8em)' }], { duration: MORPH_MS * .6, delay: roll(i), easing: MORPH_EASE, fill: 'both' }));
  });
  if (width && Math.abs(w1 - w0) > .5) anims.push(el.animate([{ width: `${w0}px` }, { width: `${w1}px` }], move));
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    anims.forEach(a => a.cancel());
    ghosts.forEach(g => g.remove());
    el.classList.remove('tm-run');
    el.style.height = heightWas;
    el.textContent = text;
    if (textMorphs.get(el) === end) textMorphs.delete(el);
  };
  textMorphs.set(el, end);
  Promise.all(anims.map(a => a.finished)).then(end, () => {});
}

// Where each visible dot is: its box on screen and brightness. Glide draws one dot (::before) for all three.
interface DotShape { x: number; y: number; w: number; h: number; o: number }
function dotShapes(row: HTMLElement): DotShape[] {
  const box = row.querySelector<HTMLElement>('.think-head .dots');
  if (!box) return [];
  if (row.dataset.dots === 'glide') {
    const b = box.getBoundingClientRect(), cs = getComputedStyle(box, '::before'), sx = parseFloat(cs.scale) || 1;
    const one = { x: b.left + 2.5 + (parseFloat(cs.translate) || 0), y: b.top + b.height / 2, w: 5 * sx, h: 5, o: 1 };
    return [one, one, one];
  }
  return [...box.querySelectorAll('i')].map(i => { const r = i.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, o: +getComputedStyle(i).opacity }; });
}

// The dots' morph: stand-ins travel from the old style's dots to the new style's while the real dots run on hidden
// underneath (so a style's own transforms never fight the morph); each frame they head for the new dots' live places
// and hand back exactly there. Glide's one dot splits into three, or three gather into one. A change mid-morph starts
// from where the stand-ins are. Reduced motion: a fade.
const dotMorphs = new WeakMap<HTMLElement, { at: DotShape[]; stop(): void }>();
function morphDots(row: HTMLElement, style: string): void {
  const old = row.dataset.dots, box = row.querySelector<HTMLElement>('.think-head .dots');
  if (!box || old === style) return;
  const live = dotMorphs.get(row);
  const from = live?.at ?? (old && box.getClientRects().length ? dotShapes(row) : null);
  live?.stop();
  row.dataset.dots = style;
  if (!from?.length) return;
  if (stillMotion()) { box.animate([{ opacity: 0 }, { opacity: 1 }], { duration: MORPH_MS, easing: MORPH_EASE }); return; }
  const layer = document.createElement('span');
  layer.className = 'dots-morph';
  layer.setAttribute('aria-hidden', 'true');
  const stands = from.map(() => layer.appendChild(document.createElement('i')));
  box.after(layer);
  box.style.visibility = 'hidden';
  const clock = layer.animate(null, { duration: MORPH_MS, easing: MORPH_MOVE }); // its eased progress drives the morph
  let raf = 0;
  const m = { at: from, stop() { cancelAnimationFrame(raf); clock.cancel(); layer.remove(); box.style.visibility = ''; if (dotMorphs.get(row) === m) dotMorphs.delete(row); } };
  dotMorphs.set(row, m);
  const frame = () => {
    if (clock.playState === 'finished' || !row.isConnected) { m.stop(); return; }
    const p = clock.effect?.getComputedTiming().progress ?? 0, to = dotShapes(row), L = layer.getBoundingClientRect();
    m.at = from.map((a, k) => { const b = to[k] ?? a; return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p, w: a.w + (b.w - a.w) * p, h: a.h + (b.h - a.h) * p, o: a.o + (b.o - a.o) * p }; });
    m.at.forEach((s, k) => Object.assign(stands[k].style, { left: `${s.x - s.w / 2 - L.left}px`, top: `${s.y - s.h / 2 - L.top}px`, width: `${s.w}px`, height: `${s.h}px`, opacity: String(s.o) }));
    raf = requestAnimationFrame(frame);
  };
  frame();
}

function nextStatus(el: HTMLElement): void {
  const lbl = el.querySelector<HTMLElement>('.think-head .morph > .lbl');
  if (lbl) morphText(lbl, pickOther(STATUS_WORDS, lbl.textContent ?? ''));
  morphDots(el, pickOther(DOT_STYLES, el.dataset.dots ?? ''));
}

function showThinking(label: string, k: AgentKey = 'assistant', tab?: AgentTabState, agentId?: string | null): void {
  const t = tab || getActiveTab(msgSurface);
  let el = t.panel.querySelector<HTMLElement>('.thinking');
  const { name, letter, tint } = speaker(k, agentId);
  if (!el) {
    el = document.createElement('div');
    el.className = 'thinking';
    el.dataset.dots = DOT_STYLES[0];
    if (!thinkOpen()) el.classList.add('collapsed');
    el.setAttribute('role', 'status');
    el.innerHTML = `<button type="button" class="think-head" aria-expanded="${thinkOpen()}"><span class="avatar mini"></span><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="morph" aria-hidden="true"><span class="lbl">${esc(pickOther(STATUS_WORDS, ''))}</span></span><span class="think-time">0s</span><span class="think-chev" aria-hidden="true">${svgIcon('chevronDown', 12)}</span></button><ol class="think-steps"></ol>`;
    t.panel.appendChild(el);
    const now = Date.now();
    thinkStarts.set(el, { start: now, step: now });
    const box = el;
    const timer = setInterval(() => { if (!box.isConnected) { clearInterval(timer); return; } tickThinking(box); }, 100);
    const words = setInterval(() => { if (!box.isConnected) { clearInterval(words); return; } nextStatus(box); }, STATUS_EVERY);
    sfx.play('think');
    humWhileThinking();
  }
  const avatar = $('.avatar', el);
  if (avatar) avatar.outerHTML = brandMark('avatar mini', tint, letter);
  const head = $('.think-head', el);
  if (head) { head.title = `${name} is thinking`; head.setAttribute('aria-label', `${name} is thinking`); }
  thinkStep(el, 'dot', stepText(label, name));
  if (t.id === activeTabId[t.surfaceName]) scrollChat(SURFACES[t.surfaceName]);
}

document.addEventListener('click', e => {
  const head = (e.target as HTMLElement).closest<HTMLElement>('.thinking .think-head');
  const el = head?.parentElement;
  if (!head || !el) return;
  const open = el.classList.toggle('collapsed') === false;
  head.setAttribute('aria-expanded', String(open));
  try { localStorage.setItem(THINK_OPEN_KEY, open ? '1' : '0'); } catch { /* private window: just this time */ }
});

// A quiet murmur every couple of seconds for as long as any agent is still thinking (or writing a commit message).
let thinkingHum: TimeoutId | undefined;
let commitMsgPending = false;
function humWhileThinking(): void {
  if (thinkingHum != null) return;
  thinkingHum = setInterval(() => {
    if (!commitMsgPending && !document.querySelector('.agent-tab-panel .thinking')) { clearInterval(thinkingHum); thinkingHum = undefined; return; }
    sfx.play('hum');
  }, 1800);
}

function hideThinking(tab?: AgentTabState): void {
  if (tab) {
    tab.panel.querySelector('.thinking')?.remove();
  } else {
    for (const list of Object.values(surfaceTabs)) {
      for (const t of list) t.panel.querySelector('.thinking')?.remove();
    }
  }
}

/* ----- Rotating prompts: a composer's placeholder changes every 2 s ----- */
// Built from parts, so each list holds about a thousand lines without writing them out one by one. Each verb only meets
// the things it makes sense for ("Add types to" meets code, "Restyle" meets screens), so no line reads as nonsense.
const combine = (templates: string[], parts: string[]) => templates.flatMap(t => parts.map(p => t.replace('{x}', p)));
const CODE_PARTS = ['the login flow', 'the API client', 'the database queries', 'the build script', 'the router', 'the auth middleware',
  'the image loader', 'the date helpers', 'the cart logic', 'the config loader', 'the state store', 'the form validation',
  'the caching layer', 'the websocket code', 'the logging', 'the cron jobs', 'the upload handler', 'the routes file', 'the data fetching'];
const UI_PARTS = ['the navbar', 'the checkout page', 'the settings screen', 'the search results', 'the signup form', 'the footer',
  'the dashboard charts', 'the error page', 'the mobile layout', 'the sidebar', 'the modal', 'the dark theme', 'the header',
  'the pagination', 'the notifications', 'the profile page', 'the main menu', 'the onboarding steps', 'the pricing page',
  'the email templates', 'the landing hero', 'the color tokens'];
// The IDE composer's own placeholder is a single space: nothing shows under the examples (not even when Ctrl+A
// highlights it), and :placeholder-shown still tells the CSS when the box is empty.
const IDE_PLACEHOLDERS = [
  ...combine(['Build {x}', 'Make {x}', 'Create {x}', 'Design {x}', 'Prototype {x}', 'Scaffold {x}', 'Sketch out {x}', 'Put together {x}', 'Spin up {x}', 'Draft {x}', 'Code up {x}', 'Set up {x}'], [
    'a landing page for a coffee shop', 'a todo app with drag and drop', 'a dark mode toggle', 'a pricing table', 'a contact form with validation',
    'a weather widget', 'a Markdown previewer', 'a login screen', 'a REST API for notes', 'a CLI that renames photos',
    'a Pomodoro timer', 'a chat UI', 'a settings page', 'an image gallery with a lightbox', 'a kanban board',
    'a budget tracker', 'a quiz game', 'a snake game', 'a portfolio site', 'a blog with tags',
    'a search bar with suggestions', 'a file uploader', 'a calendar view', 'a charts dashboard', 'a recipe finder',
    'a URL shortener', 'a habit tracker', 'a music player UI', 'a modal dialog', 'a toast notification system',
    'an onboarding flow', 'a 404 page', 'a signup form', 'a countdown timer', 'a color palette generator',
    'a password generator', 'a unit converter', 'a tip calculator', 'a drawing canvas', 'a typing speed test',
    'a product card grid', 'a sidebar navigation', 'a responsive navbar', 'a FAQ accordion', 'a star rating widget',
    'a QR code generator', 'a weather app', 'an expense splitter', 'a mini spreadsheet', 'a memory card game',
  ]),
  ...combine(['Fix {x}', 'Refactor {x}', 'Clean up {x}', 'Simplify {x}', 'Review {x}'],
    [...CODE_PARTS, ...UI_PARTS, 'the file upload', 'the test suite', 'the drag and drop', 'the keyboard shortcuts']),
  ...combine(['Speed up {x}', 'Write tests for {x}', 'Document {x}', 'Add types to {x}', 'Explain {x}', 'Add error handling to {x}'], CODE_PARTS),
  ...combine(['Restyle {x}', 'Polish {x}'], UI_PARTS),
];
function pickOther(list: string[], current: string): string {
  const r = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(r);
    const next = list[r[0] % list.length];
    if (next !== current || list.length < 2) return next;
  }
}
// Blurs the old text away, then the new text in.
function blurSwap(el: HTMLElement, text: string): void {
  if (el.textContent === text) return;
  if (!el.isConnected) { el.textContent = text; return; }
  el.getAnimations().forEach(a => { if (a.id === 'blurSwap') a.cancel(); });
  const soft = 'blur(6px)';
  const out = el.animate([{ opacity: 1, filter: 'blur(0)', transform: 'none' }, { opacity: 0, filter: soft, transform: 'translateY(-3px)' }], { duration: 220, easing: SPRING, fill: 'forwards' });
  out.id = 'blurSwap';
  out.onfinish = () => {
    el.textContent = text;
    out.cancel();
    const into = el.animate([{ opacity: 0, filter: soft, transform: 'translateY(3px)' }, { opacity: 1, filter: 'blur(0)', transform: 'none' }], { duration: 420, easing: SPRING });
    into.id = 'blurSwap';
  };
}
// A native placeholder can't blur, so while a box shows its usual one (`home`), a layer on top draws an example from
// the list instead. Any other placeholder (a question about a plan, say) shows as usual.
interface PlaceholderRotator { ta: HTMLTextAreaElement; list: string[]; layer: HTMLElement }
function rotatePlaceholder(ta: HTMLTextAreaElement, home: string, list: string[]): void {
  const layer = document.createElement('span');
  layer.className = 'ph-rot';
  layer.setAttribute('aria-hidden', 'true');
  layer.textContent = list.includes(home) ? home : pickOther(list, '');
  ta.after(layer);
  const place = () => {
    const cs = getComputedStyle(ta);
    const px = (v: string) => Number.parseFloat(v) || 0;
    layer.style.top = `${ta.offsetTop + px(cs.borderTopWidth) + px(cs.paddingTop)}px`;
    layer.style.left = `${ta.offsetLeft + px(cs.borderLeftWidth) + px(cs.paddingLeft)}px`;
    layer.style.width = `${Math.max(0, ta.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight))}px`;
    layer.style.font = cs.font;
    layer.style.lineHeight = cs.lineHeight;
  };
  const sync = () => ta.classList.toggle('ph-rotating', ta.placeholder === home);
  new ResizeObserver(place).observe(ta);
  new MutationObserver(sync).observe(ta, { attributes: true, attributeFilter: ['placeholder'] });
  place(); sync();
  phRotators.set(layer, { ta, list, layer });
  // Typing mid-swap: drop the swap so the placeholder can blur away at once.
  ta.addEventListener('input', () => stopTextMorph(layer));
}
// Keyed by layer, so a closed box's composer drops out on its own.
const phRotators = new WeakMap<HTMLElement, PlaceholderRotator>();
function nextPlaceholder(r: PlaceholderRotator): void {
  if (r.ta.value || !r.ta.classList.contains('ph-rotating')) return;
  morphText(r.layer, pickOther(r.list, r.layer.textContent ?? ''));
}
// Every 2 s each visible composer shows another example, power saver included (one small swap); it rests only while
// the window is unseen (power.ts).
decorInterval(() => {
  for (const layer of $$<HTMLElement>('.ph-rot')) {
    const r = phRotators.get(layer);
    if (r && decorVisible(layer)) nextPlaceholder(r);
  }
}, 2000, 2000);
// Each example reads as a hint, not as a prompt already sent: "Describe a change… e.g. fix the router".
const IDE_HINTS = IDE_PLACEHOLDERS.map(p => `Describe a change… e.g. ${p[0].toLowerCase()}${p.slice(1)}`);
rotatePlaceholder(SURFACES.ide.prompt, ' ', IDE_HINTS);
// The empty state's logo: Agent.png with its strokes rippling in a breeze, as a lossless animated WebP rendered from
// that image. An image, not a video: a looping video shows a seam each time it restarts. Reduced motion and the power
// saver get the still: the animated one decodes and paints a frame for as long as it is on screen.
const idleLogoFile = (): string => powerSaver() || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'Agent.png' : 'AgentIdle.webp';
document.addEventListener('powerchange', () => {
  const src = `../../assets/brand/${idleLogoFile()}`;
  for (const img of $$<HTMLImageElement>('img.idle-logo')) if (img.getAttribute('src') !== src) img.src = src;
});
function idleLogo(size: number): string {
  const file = idleLogoFile();
  return `<img class="idle-logo" src="../../assets/brand/${file}" alt="" width="${size}" height="${size}" draggable="false">`;
}

function emptyChat(s: Surface = SURFACES.ide, tab?: AgentTabState): void {
  const t = tab || getActiveTab(s);
  t.panel.innerHTML = `<div class="empty"><div>${idleLogo(40)}<h4>Your agents are ready</h4><div class="empty-line">Tell them what to build. They'll ask if anything's unclear.</div></div></div>`;
}
// A small, safe subset of Markdown for agent replies: inline code, bold, italic, strikethrough and line breaks. Fenced code blocks
// become artifacts: a card with the file name, Copy and Download. A fence may name its file: ```html index.html
// A line starting "# " to "###### " is a heading. It is a block span (it may sit inside a <p>), so the blank lines
// next to it are dropped: its margins already space it.
const MD_HEADING = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
function inlineMd(s: string): string {
  const lines = emphasis(codeSpans(esc(s))).split('\n');
  const isHead = (l: string | undefined) => l !== undefined && MD_HEADING.test(l);
  let out = '';
  let prevBlock = false;
  lines.forEach((line, i) => {
    const m = MD_HEADING.exec(line);
    if (m) { out += `<span class="md-h md-h${Math.min(m[1].length, 4)}">${m[2]}</span>`; prevBlock = true; return; }
    if (!line.trim() && (prevBlock || isHead(lines[i + 1]))) return;
    if (i > 0 && !prevBlock) out += '<br>';
    out += line;
    prevBlock = false;
  });
  return out;
}
// Only a ``` at the start of a line opens a block (splitFences, mdcore.ts): one mid-sentence is text.
// `streaming`: the reply is redrawn every few ms, so a page or drawing shows as code until it is drawn settled;
// a live frame would load again at every redraw.
function md(text: string, streaming = false): string {
  return splitFences(text).map(p => ('code' in p ? artifactHtml(p.info, p.code, streaming) : inlineMd(p.text))).join('');
}
const LANG_EXT: Record<string, string> = {
  javascript: 'js', js: 'js', jsx: 'jsx', typescript: 'ts', ts: 'ts', tsx: 'tsx', python: 'py', py: 'py', html: 'html', css: 'css',
  json: 'json', markdown: 'md', md: 'md', bash: 'sh', sh: 'sh', shell: 'sh', powershell: 'ps1', ps1: 'ps1', c: 'c', cpp: 'cpp', 'c++': 'cpp',
  java: 'java', go: 'go', rust: 'rs', rs: 'rs', sql: 'sql', yaml: 'yml', yml: 'yml', xml: 'xml', svg: 'svg', csharp: 'cs', cs: 'cs', php: 'php', ruby: 'rb',
  golang: 'go', rb: 'rb', kotlin: 'kt', kt: 'kt', swift: 'swift', dart: 'dart', zig: 'zig', scala: 'scala', elixir: 'ex', ex: 'ex', haskell: 'hs', hs: 'hs', r: 'r', perl: 'pl', groovy: 'groovy', mermaid: 'mmd',
};
// "html index.html", "index.html" or "python": the file name to show and to save as.
function artifactName(info: string): string {
  const [first = '', second = ''] = info.split(/\s+/);
  const named = [second, first].find(t => /^[\w.-]+\.\w+$/.test(t) && !/^\.+$/.test(t));
  if (named) return named;
  return `snippet.${LANG_EXT[first.toLowerCase()] ?? 'txt'}`;
}
// A whole page or an SVG (artifactKind) also runs live in a sandboxed frame (breeze-preview://artifact/, previewServer.ts),
// with buttons to see its code and to open it large.
function artifactHtml(info: string, code: string, streaming = false): string {
  const name = artifactName(info);
  const lines = code ? code.split('\n').length : 0;
  const kind = streaming ? '' : artifactKind(info.split(/\s+/)[0], name, code);
  const live = kind ? `<button class="icon-btn" data-artifact="code" title="Show the code" aria-pressed="false">${svgIcon('code')}</button><button class="icon-btn" data-artifact="open" title="Open large">${svgIcon('maximize')}</button>` : '';
  // allow-same-origin gives it the origin breeze-preview://artifact, so localStorage works (games, to-do demos); that is
  // still cross-origin to Breeze's page and to the project's preview.
  const frame = kind ? `<iframe class="artifact-frame" src="breeze-preview://artifact/" sandbox="allow-scripts allow-same-origin allow-modals allow-forms allow-pointer-lock" loading="lazy" title="${escAttr(name)}"></iframe>` : '';
  return `<div class="artifact${kind ? ' live' : ''}"${kind ? ` data-kind="${kind}"` : ''}><div class="artifact-head"><span class="ico">${fileIcon(name)}</span><span class="artifact-name">${esc(name)}</span><span class="artifact-meta">${plural(lines, 'line')}</span>`
    + `${live}<button class="icon-btn" data-artifact="copy" title="Copy">${svgIcon('copy')}</button><button class="icon-btn" data-artifact="download" title="Download ${escAttr(name)}">${svgIcon('download')}</button></div>`
    + `${frame}<pre>${esc(code)}</pre></div>`;
}
// A frame asks for its page once it has loaded, and builds it from the code and kind (previewServer.ts, the loader).
// The code is read from the card itself, so artifacts in a chat restored from disk run again, and only frames Breeze
// drew get one.
window.addEventListener('message', e => {
  if (!e.data?.artifactReady) return;
  const frame = $$<HTMLIFrameElement>('iframe.artifact-frame').find(f => f.contentWindow === e.source);
  const card = frame?.closest<HTMLElement>('.artifact');
  if (!frame?.contentWindow || !card) return;
  const code = $('pre', card).textContent ?? '';
  frame.contentWindow.postMessage({ artifact: code, kind: card.dataset.kind }, '*');
});
// Works for replies restored from a saved chat too: the code is read back from the card itself.
document.addEventListener('click', e => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-artifact]');
  const card = btn?.closest<HTMLElement>('.artifact');
  if (!btn || !card) return;
  const code = $('pre', card).textContent ?? '';
  const name = $('.artifact-name', card).textContent ?? 'snippet.txt';
  if (btn.dataset.artifact === 'code') {
    btn.setAttribute('aria-pressed', String(card.classList.toggle('show-code')));
    return;
  }
  // The same card, large, in a dialog: a fresh frame runs the page from the start. Its corner button closes it.
  if (btn.dataset.artifact === 'open') {
    openModal(`<div class="artifact-modal">${card.outerHTML}</div>`, m => {
      $('.artifact', m).classList.remove('show-code');
      $('[data-artifact="code"]', m).setAttribute('aria-pressed', 'false');
      const close = $<HTMLButtonElement>('[data-artifact="open"]', m);
      close.removeAttribute('data-artifact');
      close.title = 'Close';
      close.innerHTML = svgIcon('minimize');
      close.onclick = closeModal;
    });
    return;
  }
  if (btn.dataset.artifact === 'copy') {
    navigator.clipboard.writeText(code).then(() => {
      void setIcon(btn, 'check');
      setTimeout(() => void setIcon(btn, 'copy'), 1400);
    }, () => toast('Couldn’t copy to the clipboard'));
    return;
  }
  const url = URL.createObjectURL(new Blob([code], { type: 'text/plain' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});
const TOOL_ICON: Record<string, string> = { read: 'eye', edit: 'pencil', run: 'terminal', search: 'search', web: 'globe', todo: 'todo', agent: 'diamond', tool: 'dot', note: 'info' };
function toolLine(kind: string, label: string, tab?: AgentTabState): void {
  sfx.play('tool');
  const thinking = (tab || getActiveTab(msgSurface)).panel.querySelector<HTMLElement>('.thinking');
  if (thinking) thinkStep(thinking, TOOL_ICON[kind] ?? 'dot', label);
  addMsg(`<div class="tool-line ${kind}"><span class="ti">${svgIcon(TOOL_ICON[kind] ?? 'dot', 14)}</span><span class="tl">${esc(label)}</span></div>`, tab);
}

// The open chat is kept per project folder so a reload brings it back. `SPACE_CHATS` (history.ts): the chats Breeze
// Space kept, under its own scope, which the Agent board's side bar still lists.
type ChatStore = Pick<Surface, 'folder'> & { name: string };
const chatScope = (s: ChatStore) => (s.name === 'space' ? 'box' : s.folder ?? rootInfo?.root ?? '');
const chatKey = (s: Surface = msgSurface) => `breeze.chat:${chatScope(s)}`;
const agentSessionKey = (s: Surface = msgSurface, agent: string | null = appState.agent) => `breeze.agentSession:${chatScope(s)}:${agent ?? ''}`;

