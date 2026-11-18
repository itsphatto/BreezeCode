/* ================= Agentic tasks in Breeze Space ================= */
// Space reads every message (main's agentintent.ts): a question stays a chat reply; a job of several steps, a
// schedule ("every morning…") or a trigger ("when tests fail…") becomes a task for the agentic brain (main's
// agentcore.ts). The task reports in the chat it came from, with Space's own pieces: the plan card to approve,
// each step streaming like any reply, notes between steps, the question card when it is stuck. It has no controls
// of its own: `/task` and `/chat` at the start of a message override the reading, and `/stop` ends the chat's tasks.
const AGENTIC_AGENTS = ['claude', 'codex']; // they reach Breeze's MCP server; main refuses any other
const ACTIVE_STATUSES: AgentTaskStatus[] = ['planning', 'awaiting', 'queued', 'running'];
const agTasks = new Map<string, AgentTask>();
const agTaskTab = new Map<string, AgentTabState>();
// Which chat a task reports in, kept by the chat's history id so a restart finds it again.
const agTabLinks: Record<string, string> = store.get<Record<string, string>>('breeze.agentic.tabs', {});
// What the chat has already been told about each task, so an update only adds what changed.
const agSaid = new Map<string, { status: AgentTaskStatus; steps: Map<number, AgentStep['status']>; planned: boolean }>();

/* ----- Tray ----- */
// Main shows the tray only while a task needs it (one running, or a schedule or trigger waiting).
function applyAgentTray(): void {
  background(api.agentTask.setTray(true, false));
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
  if (/^\/stop$/i.test(text.trim())) {
    const mine = tasksIn(tab);
    for (const t of mine) background(api.agentTask.action(t.id, 'remove'));
    handoff(mine.length ? `Stopped ${plural(mine.length, 'task')} in this chat` : 'No task in this chat', tab);
    saveChat(tab);
    return { handled: true, text };
  }
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
  try {
    // 'plan': Space's plan card asks once before the steps run.
    const t = await api.agentTask.create({ goal: intent.goal, project: rootInfo?.root ?? 'box', agent: ag.id, control: 'plan', schedule: intent.schedule ?? null, trigger: intent.trigger ?? null });
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
  if (first && t.status === 'waiting') handoff(`Scheduled to run ${whenText(t)}, in this chat · send /stop to end it`, tab);
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
    else if (t.status === 'failed') { hideThinking(tab); errorCard(t.error ?? 'The task stopped.', 'Send it again.', tab); }
    else if (t.status === 'cancelled') { hideThinking(tab); handoff('Task cancelled', tab); }
    else if (t.status === 'paused') { hideThinking(tab); handoff('Task paused · send it again to restart, or /stop to end it', tab); }
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
    refreshNeedsYou(tab);
    if (msg.ev.t === 'question' && (appState.mode !== 'box' || activeTabId.box !== tab.id)) toast('An agentic task needs your answer in Breeze Space');
  } else if (msg.type === 'run-start') {
    const t = agTasks.get(msg.taskId);
    if (!t || msg.mode !== 'build') return; // the planning run stays out of the chat
    attachTaskRun(taskTab(t), msg.runId, msg.agent, msg.step);
  } else if (msg.type === 'notify') {
    const t = agTasks.get(msg.id);
    const tab = t && agTaskTab.get(t.id);
    if (t && tab && (appState.mode !== 'box' || activeTabId.box !== tab.id)) toast(`${t.goal.slice(0, 50)}: ${msg.text}`);
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
