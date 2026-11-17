/* ================= Agentic tasks in Breeze Space ================= */
// Space reads every message (main's agentintent.ts): a question stays a chat reply; a job of several steps, a
// schedule ("every morning…") or a trigger ("when tests fail…") becomes a task for the agentic brain (main's
// agentcore.ts). The task reports in the chat it came from, with Space's own pieces: the plan card to approve,
// each step streaming like any reply, notes between steps, the question card when it is stuck. The agent pill's
// menu holds the Control level, when the next task runs, and the task list. `/task` and `/chat` at the start of a
// message override the reading.
const AGENTIC_AGENTS = ['claude', 'codex']; // they reach Breeze's MCP server; main refuses any other
const CONTROL_LEVELS: AgentControl[] = ['ask', 'plan', 'auto', 'full'];
const CONTROL_LABELS: Record<AgentControl, string> = { ask: 'Ask each step', plan: 'Approve plan', auto: 'Auto', full: 'Full auto' };
const STATUS_LABELS: Record<AgentTaskStatus, string> = {
  planning: 'Planning', awaiting: 'Needs you', queued: 'Queued', running: 'Running', paused: 'Paused',
  waiting: 'Waiting', done: 'Done', failed: 'Failed', cancelled: 'Cancelled',
};
const ACTIVE_STATUSES: AgentTaskStatus[] = ['planning', 'awaiting', 'queued', 'running'];
const agTasks = new Map<string, AgentTask>();
const agTaskTab = new Map<string, AgentTabState>();
// Which chat a task reports in, kept by the chat's history id so a restart finds it again.
const agTabLinks: Record<string, string> = store.get<Record<string, string>>('breeze.agentic.tabs', {});
// What the chat has already been told about each task, so an update only adds what changed.
const agSaid = new Map<string, { status: AgentTaskStatus; steps: Map<number, AgentStep['status']>; planned: boolean }>();
let agControl: AgentControl = CONTROL_LEVELS.includes(store.get<AgentControl>('breeze.agentic.control', 'plan')) ? store.get<AgentControl>('breeze.agentic.control', 'plan') : 'plan';
type AgentWhen = { label: string; schedule?: AgentSchedule; trigger?: { kind: AgentTriggerKind; match?: string } };
let agNextWhen: AgentWhen | null = null; // the agent menu's pick for the next task, over what the message says

/* ----- Tray and memory (Settings) ----- */
// The tray shows only while a task needs it (main decides); this is the user's on/off for it.
function applyAgentTray(): void {
  background(api.agentTask.setTray(appState.agentTray, appState.agentTray && appState.agentStartup));
}
async function renderAgentMemory(el: HTMLElement): Promise<void> {
  const items = await api.agentTask.memory().catch(() => [] as AgentMemoryItem[]);
  if (!el.isConnected) return;
  if (!items.length) { el.innerHTML = '<p class="set-sub">Nothing remembered yet. Agentic tasks add facts as they work.</p>'; return; }
  const rows = [...items].sort((a, b) => b.at - a.at).map(m => `<div class="agent-mem-row" data-mem="${escAttr(m.id)}">
      <span class="agent-mem-text">${esc(m.text)}</span>
      <span class="agent-mem-scope" title="${escAttr(m.project ?? 'Every project')}">${esc(m.project ? baseName(m.project.replaceAll('\\', '/')) : 'Everywhere')}</span>
      <button class="icon-btn" type="button" data-mem-forget title="Forget" aria-label="Forget">${svgIcon('x', 13)}</button></div>`).join('');
  el.innerHTML = `${rows}<div class="agent-mem-foot"><button class="btn btn-sm" type="button" data-mem-clear>Forget everything</button></div>`;
  el.querySelectorAll<HTMLElement>('[data-mem-forget]').forEach(b => b.onclick = () => {
    const row = b.closest<HTMLElement>('[data-mem]');
    if (row) void api.agentTask.forget(row.dataset.mem ?? '').then(() => renderAgentMemory(el));
  });
  const clear = el.querySelector<HTMLElement>('[data-mem-clear]');
  if (clear) clear.onclick = () => void api.agentTask.clearMemory().then(() => { toast('Agentic tasks forgot everything'); return renderAgentMemory(el); });
}

/* ----- Which chat a task belongs to ----- */
function bindTask(id: string, tab: AgentTabState): void {
  agTaskTab.set(id, tab);
  if (tab.historyId && agTabLinks[id] !== tab.historyId) { agTabLinks[id] = tab.historyId; store.set('breeze.agentic.tabs', agTabLinks); }
}
// The chat a task reports in: the one it came from, else the one linked to it, else a new chat named after it
// (a schedule firing after a restart, say), which shows in the side bar like any chat.
function taskTab(t: AgentTask): AgentTabState {
  const tabs = surfaceTabs.box;
  const bound = agTaskTab.get(t.id);
  if (bound && tabs.includes(bound)) { bindTask(t.id, bound); return bound; }
  const linked = agTabLinks[t.id] ? tabs.find(x => x.historyId === agTabLinks[t.id]) : undefined;
  const tab = linked ?? createAgentTab(SURFACES.box, t.goal.replaceAll(/\s+/g, ' ').slice(0, 64), undefined, null, true);
  if (!linked && tab.panel.querySelector('.empty')) tab.panel.innerHTML = '';
  bindTask(t.id, tab);
  return tab;
}
const tasksIn = (tab: AgentTabState) => [...agTaskTab].filter(([, x]) => x === tab).map(([id]) => agTasks.get(id)).filter((t): t is AgentTask => !!t);
function agenticTabBusy(tab: AgentTabState): boolean {
  return tasksIn(tab).some(t => ACTIVE_STATUSES.includes(t.status));
}
// Stop in a chat with a task in it cancels the task (main stops its current step too).
function stopAgenticTask(tab: AgentTabState): boolean {
  const live = tasksIn(tab).filter(t => ACTIVE_STATUSES.includes(t.status));
  if (!live.length) return false;
  for (const t of live) background(api.agentTask.action(t.id, 'cancel'));
  return true;
}

/* ----- The agent ----- */
// Only Claude Code and Codex can run a task. On another agent, Space switches to the first of them that is set up,
// and says so in the chat.
function agenticAgent(tab: AgentTabState): DetectedAgent | null {
  const cur = selectedAgent();
  if (cur?.found && AGENTIC_AGENTS.includes(cur.id)) return cur;
  const alt = AGENTIC_AGENTS.map(id => appState.detect?.agents.find(a => a.id === id && a.found)).find((a): a is DetectedAgent => !!a);
  if (!alt) return null;
  appState.agent = alt.id;
  saveApp();
  renderAgentBar();
  updateBoxEmptyWho();
  toolLine('note', `${cur?.name ?? 'Your agent'} can’t run agentic tasks, so Breeze switched to ${alt.name}.`, tab);
  return alt;
}

/* ----- A message from Space's composer ----- */
// handled: the task took it. Otherwise `text` goes to the agent as a normal chat (without a leading /chat).
async function routeAgentic(tab: AgentTabState, text: string): Promise<{ handled: boolean; text: string }> {
  tab.parsing = true;
  let intent: AgentIntent | null = null;
  try { intent = await api.agentTask.classify(text); } catch { intent = null; } finally { tab.parsing = false; }
  if (!intent) return { handled: false, text };
  if (!intent.agentic) return { handled: false, text: intent.goal || text };
  const ag = agenticAgent(tab);
  if (!ag) {
    toolLine('note', 'Agentic tasks need Claude Code or Codex. Install one from Settings → Agents. This message goes to your agent as a normal chat.', tab);
    return { handled: false, text: intent.goal || text };
  }
  const when = agNextWhen ?? (intent.schedule ? { label: '', schedule: intent.schedule } : intent.trigger ? { label: '', trigger: intent.trigger } : null);
  try {
    const t = await api.agentTask.create({ goal: intent.goal, project: rootInfo?.root ?? 'box', agent: ag.id, control: agControl, schedule: when?.schedule ?? null, trigger: when?.trigger ?? null });
    agNextWhen = null;
    bindTask(t.id, tab);
    agTasks.set(t.id, t);
    sayTask(t, tab);
  } catch (e) { errorCard(errMsg(e), undefined, tab); }
  refreshTabBusy(tab);
  saveChat(tab);
  return { handled: true, text };
}

/* ----- What the chat says as a task moves along ----- */
function whenText(t: AgentTask): string {
  if (t.schedule?.kind === 'daily') return `every day at ${t.schedule.at}`;
  if (t.schedule?.kind === 'every') return t.schedule.hours === 1 ? 'every hour' : `every ${t.schedule.hours} hours`;
  if (t.trigger?.kind === 'save') return t.trigger.match ? `when ${t.trigger.match} is saved` : 'when a file is saved';
  if (t.trigger?.kind === 'testFail') return 'when tests fail';
  return '';
}
const handoff = (text: string, tab: AgentTabState) => addMsg(`<div class="handoff">${esc(text)}</div>`, tab);
function sayTask(t: AgentTask, tab: AgentTabState): void {
  const was = agSaid.get(t.id);
  const said = was ?? { status: t.status, steps: new Map<number, AgentStep['status']>(), planned: false };
  const first = !was;
  const changed = first || was.status !== t.status;
  // Started, or fired by its schedule or trigger.
  if (first && t.status === 'waiting') handoff(`Scheduled to run ${whenText(t)}, in this chat`, tab);
  if (!first && was.status === 'waiting' && (t.status === 'queued' || t.status === 'planning')) {
    const why = t.log[t.log.length - 1]?.text;
    if (why) toolLine('note', why, tab);
  }
  if (changed && t.status === 'queued') showThinking('Waiting for the task before it in this folder', 'planner', tab, t.agent);
  if (changed && t.status === 'planning') showThinking(`${speaker('planner', t.agent).name} is planning the steps`, 'planner', tab, t.agent);
  // The plan: the plan card shows it when it needs approving; at Auto and Full auto it is a message.
  if (t.steps.length && !said.planned) {
    said.planned = true;
    if (t.control === 'auto' || t.control === 'full') {
      hideThinking(tab);
      agentMsg('planner', md(`**Plan**\n\n${t.steps.map(s => `${s.id}. ${s.title}`).join('\n')}`), tab, t.agent);
    }
  }
  // Steps.
  const n = t.steps.length;
  for (const s of t.steps) {
    const before = said.steps.get(s.id);
    if (before === s.status) continue;
    if (s.status === 'running' && before !== 'running') toolLine('note', `Step ${s.id} of ${n} · ${s.title}`, tab);
    else if (s.status === 'todo' && before === 'running' && s.tries) toolLine('note', `Step ${s.id} didn’t finish${s.note ? `: ${s.note}` : ''}. Trying again.`, tab);
    else if (s.status === 'failed') toolLine('note', `Step ${s.id} failed${s.note ? `: ${s.note}` : ''}`, tab);
    else if (s.status === 'skipped' && t.status !== 'cancelled') toolLine('note', `Skipped step ${s.id}`, tab);
    said.steps.set(s.id, s.status);
  }
  // Where it ended up.
  if (changed && !first) {
    if (t.status === 'done') { hideThinking(tab); handoff(`Task done · ${plural(n, 'step')}`, tab); }
    else if (t.status === 'failed') { hideThinking(tab); errorCard(t.error ?? 'The task stopped.', 'Send it again, or change the Control level from the agent menu.', tab); }
    else if (t.status === 'cancelled') { hideThinking(tab); handoff('Task cancelled', tab); }
    else if (t.status === 'paused') { hideThinking(tab); handoff('Task paused · resume it from the agent menu', tab); }
    else if (t.status === 'waiting') {
      hideThinking(tab);
      const next = t.nextRunAt ? ` · next run ${new Date(t.nextRunAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : '';
      if (t.error) errorCard(t.error, `It runs again ${whenText(t)}.`, tab);
      else handoff(`Done${next}`, tab);
    }
  }
  said.status = t.status;
  agSaid.set(t.id, said);
}

/* ----- Messages from main ----- */
api.agentTask.onEvent(msg => {
  if (msg.type === 'update') {
    const t = msg.task;
    agTasks.set(t.id, t);
    const tab = taskTab(t);
    sayTask(t, tab);
    refreshTabBusy(tab);
    saveChat(tab);
  } else if (msg.type === 'removed') {
    agTasks.delete(msg.id);
    const tab = agTaskTab.get(msg.id);
    agTaskTab.delete(msg.id);
    agSaid.delete(msg.id);
    if (agTabLinks[msg.id]) { delete agTabLinks[msg.id]; store.set('breeze.agentic.tabs', agTabLinks); }
    if (tab) refreshTabBusy(tab);
  } else if (msg.type === 'question') {
    const t = agTasks.get(msg.taskId);
    if (!t) return;
    const tab = taskTab(t);
    hideThinking(tab);
    // The chat's own question and plan cards; their answer goes back through agent:reply.
    const r = tab.run ?? taskRunFor(tab, 0, t.agent, 'planner');
    AGENT_EVENTS[msg.ev.t]?.(r, msg.ev, tab);
    saveChat(tab);
    if (msg.ev.t === 'question' && (appState.mode !== 'box' || activeTabId.box !== tab.id)) toast('An agentic task needs your answer in Breeze Space');
  } else if (msg.type === 'run-start') {
    const t = agTasks.get(msg.taskId);
    if (!t || msg.mode !== 'build') return; // the planning run stays out of the chat
    attachTaskRun(taskTab(t), msg.runId, msg.agent, msg.step);
  } else if (msg.type === 'notify') {
    const t = agTasks.get(msg.id);
    const tab = t && agTaskTab.get(t.id);
    if (t && tab && (appState.mode !== 'box' || activeTabId.box !== tab.id)) toast(`${t.goal.slice(0, 50)}: ${msg.text}`);
  } else if (msg.type === 'memory') {
    const el = document.querySelector<HTMLElement>('#sAgentMemory');
    if (el) void renderAgentMemory(el);
  }
});
// A Run for the chat to file a task's events under: the same shape a sent message gets (teams.ts startAgentRun).
function taskRunFor(tab: AgentTabState, id: number, agent: string, phase: AgentKey): Run {
  return { id, tabId: tab.id, surfaceName: tab.surfaceName, agent, mode: 'build', uiMode: 'build', phase, tools: 0, files: new Set(), plan: null, lastText: '', replied: false, announce: true };
}
// A step's run streams into the chat like any reply: text, tools, edited files, the "Changed 3 files" card.
function attachTaskRun(tab: AgentTabState, runId: number, agent: string, step: number | null): void {
  const run = taskRunFor(tab, runId, agent, 'builder');
  tab.runId = runId;
  tab.run = run;
  tab.agentId = agent;
  agentRun = run;
  agentsDef.builder.used = 0;
  agentsDef.builder.agentId = agent;
  showThinking(`${speaker('builder', agent).name} is working${step ? ` on step ${step}` : ''}`, 'builder', tab, agent);
  updateTabBusyState(SURFACES[tab.surfaceName], tab);
  renderAgentTabs(SURFACES[tab.surfaceName]);
  // Events that came before this message, kept by teams.ts until a tab claimed their run.
  const early = earlyEvents.splice(0);
  for (const [id, ev] of early) { if (id === runId) handleAgentEvent(run, ev, tab); else earlyEvents.push([id, ev]); }
  if (tab.runId === runId) setAgent('builder', 'working', step ? `Working on step ${step}` : 'Working on the task', 0);
}

/* ----- The agent pill's menu: Control level, when the next task runs, the tasks ----- */
function agenticMenuItems(): MenuItem[] {
  const tasks = [...agTasks.values()].filter(t => t.status !== 'done' && t.status !== 'cancelled').sort((a, b) => a.order - b.order);
  const setWhen = (w: AgentWhen | null) => () => { agNextWhen = w; toast(w ? `The next task runs ${w.label.toLowerCase()}` : 'The next task runs as your message says'); };
  const daily = (at: string): MenuItem => ({ label: `Every day at ${at}`, checked: () => agNextWhen?.schedule?.kind === 'daily' && agNextWhen.schedule.at === at, run: setWhen({ label: `Every day at ${at}`, schedule: { kind: 'daily', at } }) });
  const every = (hours: number): MenuItem => {
    const label = hours === 1 ? 'Every hour' : `Every ${hours} hours`;
    return { label, checked: () => agNextWhen?.schedule?.kind === 'every' && agNextWhen.schedule.hours === hours, run: setWhen({ label, schedule: { kind: 'every', hours } }) };
  };
  const taskItem = (t: AgentTask): MenuItem => ({
    label: t.goal.length > 44 ? `${t.goal.slice(0, 43)}…` : t.goal,
    key: STATUS_LABELS[t.status],
    sub: () => [
      { label: 'Open chat', run: () => { const tab = taskTab(t); if (appState.mode !== 'box') enterMode('box'); switchAgentTab(SURFACES.box, tab.id); } },
      ...(['waiting', 'paused', 'failed'].includes(t.status) ? [{ label: t.status === 'paused' ? 'Resume' : 'Run now', run: () => background(api.agentTask.action(t.id, 'run')) }] : []),
      ...(ACTIVE_STATUSES.includes(t.status) ? [{ label: 'Pause', run: () => background(api.agentTask.action(t.id, 'pause')) }] : []),
      { label: 'Cancel', run: () => background(api.agentTask.action(t.id, 'cancel')) },
      { label: 'Remove', run: () => background(api.agentTask.action(t.id, 'remove')) },
    ],
  });
  const running = tasks.some(t => ACTIVE_STATUSES.includes(t.status));
  return [
    { sep: true },
    { label: 'Agentic tasks:', enabled: () => false },
    { label: 'Control level', key: CONTROL_LABELS[agControl], sub: () => CONTROL_LEVELS.map(c => ({ label: CONTROL_LABELS[c], checked: () => agControl === c, run: () => setControl(c) })) },
    {
      label: 'Next task runs', key: agNextWhen?.label ?? 'As written',
      sub: () => [
        { label: 'As written in the message', checked: () => !agNextWhen, run: setWhen(null) },
        { sep: true },
        { label: 'Every day', sub: () => ['07:00', '09:00', '12:00', '18:00', '21:00'].map(daily) },
        { label: 'Every few hours', sub: () => [1, 3, 6, 12].map(every) },
        { sep: true },
        { label: 'When a file is saved', checked: () => agNextWhen?.trigger?.kind === 'save', run: setWhen({ label: 'When a file is saved', trigger: { kind: 'save' } }) },
        { label: 'When tests fail', checked: () => agNextWhen?.trigger?.kind === 'testFail', run: setWhen({ label: 'When tests fail', trigger: { kind: 'testFail' } }) },
      ],
    },
    { label: 'Tasks', key: tasks.length ? String(tasks.length) : undefined, sub: () => (tasks.length ? [...tasks.map(taskItem), { sep: true }, { label: 'Stop all tasks', enabled: () => running, run: agenticStopAll }] : [{ label: 'No tasks yet', enabled: () => false }]) },
  ];
}
function setControl(c: AgentControl): void {
  agControl = c;
  store.set('breeze.agentic.control', c);
  if (c === 'full') toast('Full auto: tasks run every step without asking you');
}
// The kill switch: every running task pauses. Ctrl+Alt+Esc does the same while Breeze has focus.
function agenticStopAll(): void {
  background(api.agentTask.stopAll().then(n => toast(n ? `Paused ${plural(n, 'task')}` : 'No task was running')));
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && e.ctrlKey && e.altKey) { e.preventDefault(); agenticStopAll(); }
});

// The tasks main kept: their chats find them again, and what they already said isn't said twice.
void api.agentTask.list().then(({ tasks }) => {
  for (const t of tasks) {
    agTasks.set(t.id, t);
    agSaid.set(t.id, { status: t.status, steps: new Map(t.steps.map(s => [s.id, s.status])), planned: t.steps.length > 0 });
  }
}).catch(() => { /* no tasks */ });
