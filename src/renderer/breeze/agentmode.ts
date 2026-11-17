/* ================= Breeze Agent: automation tasks (unlocked in Settings → Miscellaneous) ================= */
// The brain lives in main (agentcore.ts): it plans each task, runs the steps with the agent picked here, and asks
// through 'ask' messages. This screen gives it a goal, a project, an agent, a Control level and when to run, and
// shows the queue, each task's checklist, its live output and its questions.
const agentTasks = new Map<string, AgentTask>();
let agentRunning = new Set<string>();
const agentAsksByTask = new Map<string, Extract<AgentTaskMsg, { type: 'ask' }>>();
const agentRunTask = new Map<number, string>(); // runId -> task id
const agentLive = new Map<string, string[]>();   // the last lines a task's current run printed
const agentSeenSteps = new Map<string, Set<number>>(); // step rows already shown, so only new ones animate in
let agentSelected: string | null = null;
let agentLoaded = false;
let agentProject: string | null = null;
let agentAgentId: string | null = null;
let agentWhen: { label: string; schedule?: AgentSchedule; trigger?: { kind: AgentTriggerKind; match?: string } } = { label: 'Run now' };
const AGENT_LIVE_LINES = 6;

const CONTROL_LABELS: Record<AgentControl, string> = { ask: 'Ask', plan: 'Approve plan', auto: 'Auto', full: 'Full auto' };
const STATUS_LABELS: Record<AgentTaskStatus, string> = {
  planning: 'Planning', awaiting: 'Needs you', queued: 'Queued', running: 'Running', paused: 'Paused',
  waiting: 'Waiting', done: 'Done', failed: 'Failed', cancelled: 'Cancelled',
};
const agentScreenShowing = () => !$('#agent').classList.contains('hidden');

/* ----- Tray and memory (Settings) ----- */
// The tray is only there while Breeze Agent is unlocked: Breeze Code users who never unlock it see no change.
function applyAgentTray(): void {
  const on = appState.agentUnlocked && appState.agentTray;
  background(api.agentTask.setTray(on, on && appState.agentStartup));
}
async function renderAgentMemory(el: HTMLElement): Promise<void> {
  const items = await api.agentTask.memory().catch(() => [] as AgentMemoryItem[]);
  if (!el.isConnected) return;
  if (!items.length) { el.innerHTML = '<p class="set-sub">Nothing remembered yet. Breeze Agent adds facts as it works.</p>'; return; }
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
  if (clear) clear.onclick = () => void api.agentTask.clearMemory().then(() => { toast('Breeze Agent forgot everything'); return renderAgentMemory(el); });
}

/* ----- Entering the screen ----- */
function enterAgent(): void {
  swapScreen('#agent');
  if (!appState.detect) detectTools().then(renderAgentComposer, () => toast('Could not look for agents on this computer'));
  void loadAgentTasks();
  renderAgentComposer();
  $<HTMLTextAreaElement>('#agentPrompt').focus();
}
async function loadAgentTasks(): Promise<void> {
  const { tasks, running } = await api.agentTask.list().catch(() => ({ tasks: [] as AgentTask[], running: [] as string[] }));
  agentTasks.clear();
  for (const t of tasks) { agentTasks.set(t.id, t); agentSeenSteps.set(t.id, new Set(t.steps.map(s => s.id))); }
  agentRunning = new Set(running);
  agentLoaded = true;
  if (agentSelected && !agentTasks.has(agentSelected)) agentSelected = null;
  renderAgentSide();
  renderAgentDetail();
  renderAgentOrb();
}

/* ----- The orb: it breathes slowly while idle, quickly while a task works ----- */
function renderAgentOrb(): void {
  const busy = [...agentTasks.values()].some(t => t.status === 'running' || t.status === 'planning');
  const waiting = [...agentTasks.values()].some(t => t.status === 'awaiting');
  for (const orb of $$('.agent-orb')) {
    orb.classList.toggle('busy', busy);
    orb.classList.toggle('waiting', !busy && waiting);
  }
  $('#agentStopAll').hidden = !busy;
}

/* ----- The queue at the left ----- */
const taskSort = (a: AgentTask, b: AgentTask) => {
  const rank = (t: AgentTask) => (t.status === 'awaiting' ? 0 : t.status === 'running' || t.status === 'planning' ? 1 : t.status === 'queued' ? 2 : t.status === 'paused' ? 3 : t.status === 'waiting' ? 4 : 5);
  return rank(a) - rank(b) || (rank(a) <= 4 ? a.order - b.order : b.updatedAt - a.updatedAt);
};
function whenText(t: AgentTask): string {
  if (t.schedule?.kind === 'daily') return `Every day at ${t.schedule.at}`;
  if (t.schedule?.kind === 'every') return t.schedule.hours === 1 ? 'Every hour' : `Every ${t.schedule.hours} hours`;
  if (t.trigger?.kind === 'save') return t.trigger.match ? `When ${t.trigger.match} is saved` : 'When a file is saved';
  if (t.trigger?.kind === 'testFail') return 'When tests fail';
  return '';
}
function renderAgentSide(): void {
  const list = $('#agentQueue');
  const tasks = [...agentTasks.values()].sort(taskSort);
  if (!tasks.length) { list.innerHTML = '<div class="agent-queue-empty">Tasks you give Breeze Agent line up here.</div>'; return; }
  list.innerHTML = tasks.map(t => {
    const sub = [STATUS_LABELS[t.status], whenText(t), baseName(t.project.replaceAll('\\', '/'))].filter(Boolean).join(' · ');
    return `<button class="box-side-row agent-task-row ${t.id === agentSelected ? 'on' : ''}" type="button" data-task="${escAttr(t.id)}" title="${escAttr(t.goal)}">
      <span class="agent-dot s-${t.status}" aria-hidden="true"></span>
      <span class="agent-task-text"><span class="agent-task-goal">${esc(t.goal)}</span><span class="agent-task-sub">${esc(sub)}</span></span></button>`;
  }).join('');
  list.querySelectorAll<HTMLElement>('[data-task]').forEach(b => b.onclick = () => selectAgentTask(b.dataset.task ?? null));
}
function selectAgentTask(id: string | null): void {
  agentSelected = id;
  renderAgentSide();
  renderAgentDetail();
}

/* ----- One task: what it is, its question, its steps, what it's printing, its log ----- */
function stepIcon(s: AgentStep): string {
  if (s.status === 'done') return svgIcon('check', 13);
  if (s.status === 'failed') return svgIcon('circleX', 13);
  if (s.status === 'skipped') return svgIcon('minus', 13);
  if (s.status === 'running') return '<span class="spinner sm" aria-hidden="true"></span>';
  return svgIcon('circle', 13);
}
function askCardHtml(a: Extract<AgentTaskMsg, { type: 'ask' }>): string {
  const head = a.kind === 'plan' ? 'Approve this plan?' : a.kind === 'step' ? 'Run this step?' : 'Breeze Agent is stuck';
  const ok = a.kind === 'plan' ? 'Approve' : a.kind === 'step' ? 'Run it' : 'Try again';
  const no = a.kind === 'stuck' ? 'Skip step' : a.kind === 'step' ? 'Skip' : null;
  return `<div class="agent-ask" data-ask="${a.id}">
    <div class="agent-ask-head">${svgIcon('alert', 14)}<b>${esc(head)}</b></div>
    <div class="agent-ask-text">${esc(a.text)}</div>
    <textarea class="input agent-ask-input" rows="1" placeholder="${a.kind === 'plan' ? 'Or say what to change' : 'Anything to add (optional)'}" aria-label="Your answer"></textarea>
    <div class="agent-ask-row">
      <button class="btn btn-primary btn-sm" type="button" data-ask-ok>${esc(ok)}</button>
      ${a.kind === 'plan' ? '<button class="btn btn-sm" type="button" data-ask-change>Change plan</button>' : ''}
      ${no ? `<button class="btn btn-sm" type="button" data-ask-no>${esc(no)}</button>` : ''}
      <span class="flex-1"></span>
      <button class="btn btn-sm agent-ask-cancel" type="button" data-ask-cancel>Stop task</button>
    </div></div>`;
}
function agentEmptyHtml(): string {
  const examples = ['Every morning, summarize what changed in git yesterday', 'Update the dependencies, run the tests and fix what breaks', 'When tests fail, find the cause and fix it'];
  return `<div class="empty agent-empty">
    <div class="agent-orb agent-orb-lg" aria-hidden="true"><span></span></div>
    <h4>What should Breeze Agent do?</h4>
    <p>Give it a goal. It plans the steps, runs them with your agent, checks each one, and asks when it needs you.</p>
    <div class="agent-examples">${examples.map(x => `<button class="agent-example" type="button" data-example="${escAttr(x)}">${esc(x)}</button>`).join('')}</div>
  </div>`;
}
function renderAgentDetail(): void {
  const feed = $('#agentFeed');
  const t = agentSelected ? agentTasks.get(agentSelected) : null;
  if (!t) {
    if (!feed.querySelector('.agent-empty')) feed.innerHTML = agentEmptyHtml();
    feed.querySelectorAll<HTMLElement>('[data-example]').forEach(b => b.onclick = () => {
      const p = $<HTMLTextAreaElement>('#agentPrompt');
      p.value = b.dataset.example ?? '';
      p.focus();
      updateAgentSend();
    });
    renderAgentOrb();
    return;
  }
  const seen = agentSeenSteps.get(t.id) ?? new Set<number>();
  const ask = agentAsksByTask.get(t.id);
  const live = agentLive.get(t.id) ?? [];
  const active = t.status === 'running' || t.status === 'planning';
  const can = {
    run: ['waiting', 'paused', 'failed', 'cancelled', 'done'].includes(t.status),
    pause: ['running', 'planning', 'queued', 'awaiting'].includes(t.status),
    cancel: !['done', 'cancelled'].includes(t.status),
  };
  const agentName = appState.detect?.agents.find(a => a.id === t.agent)?.name ?? t.agent;
  const chips = [baseName(t.project.replaceAll('\\', '/')), agentName, CONTROL_LABELS[t.control], whenText(t)].filter(Boolean);
  const next = t.status === 'waiting' && t.nextRunAt ? `<span class="agent-next">Next run ${esc(new Date(t.nextRunAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }))}</span>` : '';
  feed.innerHTML = `<div class="agent-task" data-task-view="${escAttr(t.id)}">
    <div class="agent-task-head">
      <span class="agent-status s-${t.status}"><span class="agent-dot s-${t.status}" aria-hidden="true"></span>${esc(STATUS_LABELS[t.status])}</span>
      ${next}
      <span class="flex-1"></span>
      ${can.run ? `<button class="btn btn-sm" type="button" data-act-task="run">${svgIcon('play', 13)}<span>${t.status === 'paused' ? 'Resume' : 'Run now'}</span></button>` : ''}
      ${can.pause ? `<button class="btn btn-sm" type="button" data-act-task="pause">${svgIcon('pause', 13)}<span>Pause</span></button>` : ''}
      ${can.cancel ? `<button class="btn btn-sm" type="button" data-act-task="cancel">${svgIcon('stop', 13)}<span>Cancel</span></button>` : ''}
      <button class="icon-btn" type="button" data-act-task="up" title="Move up in the queue" aria-label="Move up">${svgIcon('up', 14)}</button>
      <button class="icon-btn" type="button" data-act-task="down" title="Move down in the queue" aria-label="Move down">${svgIcon('down', 14)}</button>
      <button class="icon-btn" type="button" data-act-task="remove" title="Remove task" aria-label="Remove task">${svgIcon('trash', 14)}</button>
    </div>
    <h3 class="agent-goal">${esc(t.goal)}</h3>
    <div class="agent-chips">${chips.map(c => `<span class="pill">${esc(c)}</span>`).join('')}</div>
    ${t.error && (t.status === 'failed' || t.status === 'waiting') ? `<div class="agent-error">${svgIcon('alert', 13)}<span>${esc(t.error)}</span></div>` : ''}
    ${ask ? askCardHtml(ask) : ''}
    ${t.steps.length ? `<ol class="agent-steps">${t.steps.map(s => `<li class="agent-step s-${s.status}${seen.has(s.id) ? '' : ' new'}" data-step="${s.id}">
        <span class="agent-step-ico">${stepIcon(s)}</span>
        <span class="agent-step-text"><span class="agent-step-title">${esc(s.title)}</span>${s.note && s.status !== 'done' ? `<span class="agent-step-note">${esc(s.note)}</span>` : ''}${s.tries && s.status !== 'done' ? `<span class="agent-step-note">Tried ${s.tries} times</span>` : ''}</span></li>`).join('')}</ol>`
      : t.status === 'planning' ? '<div class="agent-planning"><span class="spinner sm" aria-hidden="true"></span>Planning the steps…</div>' : ''}
    ${active && live.length ? `<div class="agent-live"><div class="agent-live-head">Live</div><div class="agent-live-body">${md(live.join('\n\n'))}</div></div>` : ''}
    ${t.log.length ? `<details class="agent-log"><summary>Log · ${t.log.length}</summary><div class="agent-log-body">${t.log.slice(-60).reverse().map(l => `<div class="agent-log-row"><span class="agent-log-at">${esc(timeAgo(l.at))}</span><span>${esc(l.text)}</span></div>`).join('')}</div></details>` : ''}
  </div>`;
  // New steps rise in one after another (the page's policy allows no inline styles, so the delay is set here).
  feed.querySelectorAll<HTMLElement>('.agent-step.new').forEach((li, i) => li.style.setProperty('--i', String(i)));
  for (const s of t.steps) seen.add(s.id);
  agentSeenSteps.set(t.id, seen);
  feed.querySelectorAll<HTMLElement>('[data-act-task]').forEach(b => b.onclick = () => agentTaskAction(t.id, b.dataset.actTask ?? ''));
  if (ask) wireAgentAsk(feed, ask);
  renderAgentOrb();
}
function agentTaskAction(id: string, act: string): void {
  if (act === 'up' || act === 'down') { background(api.agentTask.action(id, 'move', act === 'up' ? -1 : 1).then(loadAgentTasks)); return; }
  if (act === 'remove') {
    background(api.agentTask.action(id, 'remove'));
    agentTasks.delete(id);
    agentAsksByTask.delete(id);
    if (agentSelected === id) agentSelected = null;
    renderAgentSide(); renderAgentDetail();
    return;
  }
  if (act === 'run' || act === 'pause' || act === 'cancel') background(api.agentTask.action(id, act));
}
function wireAgentAsk(root: HTMLElement, a: Extract<AgentTaskMsg, { type: 'ask' }>): void {
  const card = root.querySelector<HTMLElement>(`[data-ask="${a.id}"]`);
  if (!card) return;
  const input = card.querySelector<HTMLTextAreaElement>('.agent-ask-input')!;
  const send = (answer: { approve: boolean; feedback?: string; cancel?: boolean }) => {
    card.classList.add('answered');
    card.querySelectorAll('button').forEach(b => ((b as HTMLButtonElement).disabled = true));
    background(api.agentTask.answer(a.id, answer));
  };
  const feedback = () => input.value.trim() || undefined;
  card.querySelector<HTMLElement>('[data-ask-ok]')!.onclick = () => send({ approve: true, feedback: a.kind === 'plan' ? undefined : feedback() });
  const change = card.querySelector<HTMLElement>('[data-ask-change]');
  if (change) change.onclick = () => {
    const f = feedback();
    if (!f) { input.focus(); toast('Say what to change first'); return; }
    send({ approve: false, feedback: f });
  };
  const no = card.querySelector<HTMLElement>('[data-ask-no]');
  if (no) no.onclick = () => send({ approve: false });
  card.querySelector<HTMLElement>('[data-ask-cancel]')!.onclick = () => send({ approve: false, cancel: true });
  input.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (a.kind === 'plan' && input.value.trim() ? change : card.querySelector<HTMLElement>('[data-ask-ok]'))?.click(); } };
}

/* ----- Messages from main ----- */
api.agentTask.onEvent(msg => {
  if (msg.type === 'update') {
    const had = agentTasks.has(msg.task.id);
    agentTasks.set(msg.task.id, msg.task);
    if (!had) agentSeenSteps.set(msg.task.id, new Set());
    if (msg.task.status !== 'running' && msg.task.status !== 'planning') agentLive.delete(msg.task.id);
    if (msg.task.status === 'running' || msg.task.status === 'planning') agentRunning.add(msg.task.id); else agentRunning.delete(msg.task.id);
    if (!agentLoaded || !agentScreenShowing()) { renderAgentOrb(); return; }
    renderAgentSide();
    if (msg.task.id === agentSelected) renderAgentDetail(); else renderAgentOrb();
  } else if (msg.type === 'removed') {
    agentTasks.delete(msg.id);
    if (agentSelected === msg.id) agentSelected = null;
    if (agentScreenShowing()) { renderAgentSide(); renderAgentDetail(); }
  } else if (msg.type === 'ask') {
    agentAsksByTask.set(msg.taskId, msg);
    sfx.play('answer');
    if (!agentScreenShowing()) toast('Breeze Agent needs you');
    else if (!agentSelected) selectAgentTask(msg.taskId);
    else if (agentSelected === msg.taskId) renderAgentDetail();
    else renderAgentSide();
  } else if (msg.type === 'ask-end') {
    for (const [taskId, a] of agentAsksByTask) if (a.id === msg.id) { agentAsksByTask.delete(taskId); if (taskId === agentSelected && agentScreenShowing()) renderAgentDetail(); }
  } else if (msg.type === 'run-start') {
    agentRunTask.set(msg.runId, msg.taskId);
    agentLive.set(msg.taskId, []);
  } else if (msg.type === 'run') {
    const taskId = agentRunTask.get(msg.runId);
    if (!taskId) return;
    const lines = agentLive.get(taskId) ?? [];
    const ev = msg.ev;
    if (ev.t === 'text' && ev.text) {
      // A run's text events grow one reply: the newest replaces the last line unless a tool ran in between.
      if (lines.length && !lines[lines.length - 1].startsWith('`')) lines[lines.length - 1] = ev.text; else lines.push(ev.text);
    } else if (ev.t === 'tool' && ev.label) lines.push(`\`${ev.label.replaceAll('`', "'").slice(0, 160)}\``);
    else if (ev.t === 'done') agentRunTask.delete(msg.runId);
    else return;
    agentLive.set(taskId, lines.slice(-AGENT_LIVE_LINES));
    if (taskId === agentSelected && agentScreenShowing()) scheduleAgentLive();
  } else if (msg.type === 'notify') {
    if (agentScreenShowing()) {
      const t = agentTasks.get(msg.id);
      if (t && msg.id !== agentSelected) toast(`${t.goal.slice(0, 50)}: ${msg.text}`);
      if (msg.text === 'Done.') sfx.play('answer');
    }
  } else if (msg.type === 'memory') {
    const el = document.querySelector<HTMLElement>('#sAgentMemory');
    if (el) void renderAgentMemory(el);
  }
});
// Live output arrives many times a second; the task view redraws at most every 250 ms.
let agentLiveTimer: TimeoutId | undefined;
function scheduleAgentLive(): void {
  if (agentLiveTimer) return;
  agentLiveTimer = setTimeout(() => { agentLiveTimer = undefined; renderAgentDetail(); }, 250);
}

/* ----- The composer: goal, agent, project, Control level, when ----- */
function agentFoundAgents(): DetectedAgent[] { return (appState.detect?.agents ?? []).filter(a => a.found); }
function renderAgentComposer(): void {
  const agents = agentFoundAgents();
  if (!agentAgentId || !agents.some(a => a.id === agentAgentId)) agentAgentId = agents.find(a => a.id === appState.agent)?.id ?? agents[0]?.id ?? null;
  const ag = agents.find(a => a.id === agentAgentId);
  swapText($('#agentAgent'), ag ? ag.name : 'No agent');
  if (!agentProject) agentProject = rootInfo?.root ?? null;
  swapText($('#agentProjectName'), agentProject ? baseName(agentProject.replaceAll('\\', '/')) : 'Pick a project');
  $('#agentProject').title = agentProject ? `The task works in ${agentProject}` : 'Pick the project this task works in';
  swapText($('#agentWhenName'), agentWhen.label);
  updateAgentSend();
}
function updateAgentSend(): void {
  const ready = !!$<HTMLTextAreaElement>('#agentPrompt').value.trim() && !!agentProject && !!agentAgentId;
  $<HTMLButtonElement>('#agentSend').disabled = !ready;
}
// Opens a menu above a composer button, the way Breeze Space's do.
function agentMenuAbove(btn: HTMLElement, items: MenuItem[]): void {
  if (menuWasOpen(btn)) { closeMenu(); return; }
  btn.classList.add('open');
  const r = btn.getBoundingClientRect();
  popupMenu(r.left, r.top - 8, items, () => btn.classList.remove('open'));
  const m = $('#menuRoot .menu');
  m.classList.add('up');
  m.style.top = `${Math.max(8, r.top - m.offsetHeight - 6)}px`;
}
$('#agentAgent').onclick = e => {
  const agents = appState.detect?.agents ?? [];
  agentMenuAbove(e.currentTarget as HTMLElement, [
    { label: 'Run steps with:', enabled: () => false },
    ...agents.map(ag => ({
      label: ag.name, icon: brandMark('menu-ico', ag.id, ag.name[0]), key: ag.found ? undefined : 'not set up',
      checked: () => ag.id === agentAgentId, enabled: () => ag.found,
      run: () => { agentAgentId = ag.id; renderAgentComposer(); },
    })),
    { sep: true },
    { label: 'Manage agents', run: openAgentPicker },
  ]);
};
$('#agentProject').onclick = async e => {
  const btn = e.currentTarget as HTMLElement;
  const projects = await api.agentTask.projects().catch(() => []);
  agentMenuAbove(btn, projects.length
    ? [{ label: 'Work in:', enabled: () => false }, ...projects.map(p => ({
      label: p.name, key: p.missing ? 'missing' : undefined, enabled: () => !p.missing,
      checked: () => !!agentProject && p.path === agentProject,
      run: () => { agentProject = p.path; renderAgentComposer(); },
    }))]
    : [{ label: 'Open a project in Breeze Code first', enabled: () => false }]);
};
$('#agentWhen').onclick = e => {
  const set = (w: typeof agentWhen) => () => { agentWhen = w; renderAgentComposer(); };
  const daily = (at: string) => ({ label: `Every day at ${at}`, run: set({ label: `Every day at ${at}`, schedule: { kind: 'daily', at } }), checked: () => agentWhen.schedule?.kind === 'daily' && agentWhen.schedule.at === at });
  const every = (hours: number) => {
    const label = hours === 1 ? 'Every hour' : `Every ${hours} hours`;
    return { label, run: set({ label, schedule: { kind: 'every', hours } }), checked: () => agentWhen.schedule?.kind === 'every' && agentWhen.schedule.hours === hours };
  };
  agentMenuAbove(e.currentTarget as HTMLElement, [
    { label: 'Run now', run: set({ label: 'Run now' }), checked: () => !agentWhen.schedule && !agentWhen.trigger },
    { sep: true },
    { label: 'Every day', sub: () => ['07:00', '09:00', '12:00', '18:00', '21:00'].map(daily) },
    { label: 'Every few hours', sub: () => [1, 3, 6, 12].map(every) },
    { sep: true },
    { label: 'When a file is saved', run: set({ label: 'When a file is saved', trigger: { kind: 'save' } }), checked: () => agentWhen.trigger?.kind === 'save' },
    { label: 'When tests fail', run: set({ label: 'When tests fail', trigger: { kind: 'testFail' } }), checked: () => agentWhen.trigger?.kind === 'testFail' },
  ]);
};
$<HTMLTextAreaElement>('#agentPrompt').addEventListener('input', () => {
  const p = $<HTMLTextAreaElement>('#agentPrompt');
  p.style.height = 'auto';
  p.style.height = `${Math.min(p.scrollHeight, 200)}px`;
  updateAgentSend();
});
$<HTMLTextAreaElement>('#agentPrompt').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void sendAgentTask(); }
});
$('#agentSend').onclick = () => void sendAgentTask();
async function sendAgentTask(): Promise<void> {
  const p = $<HTMLTextAreaElement>('#agentPrompt');
  const goal = p.value.trim();
  if (!goal) return;
  if (!agentAgentId) { toast('Set up an agent first'); openAgentPicker(); return; }
  if (!agentProject) { toast('Pick a project for the task'); $('#agentProject').click(); return; }
  const control = ($<HTMLSelectElement>('#agentControl').value || 'plan') as AgentControl;
  try {
    const t = await api.agentTask.create({ goal, project: agentProject, agent: agentAgentId, control, schedule: agentWhen.schedule ?? null, trigger: agentWhen.trigger ?? null });
    sfx.play('send');
    p.value = '';
    p.style.height = '';
    agentWhen = { label: 'Run now' };
    agentTasks.set(t.id, t);
    agentSeenSteps.set(t.id, new Set());
    selectAgentTask(t.id);
    renderAgentComposer();
  } catch (err) { toast((err as Error).message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); }
}
// Full auto warns the way the Full access switch does.
$<HTMLSelectElement>('#agentControl').addEventListener('change', () => {
  const v = $<HTMLSelectElement>('#agentControl').value;
  $('#agent').classList.toggle('control-full', v === 'full');
  if (v === 'full') toast('Full auto: no questions, the agent acts on its own');
});

/* ----- Title bar ----- */
// Breeze Agent's own logo when it's in assets/brand, else the app icon. It may have failed before this script ran.
{
  const img = $<HTMLImageElement>('#agentLogo');
  const fallback = () => { if (!img.src.endsWith('/Icon.png')) img.src = '../../assets/brand/Icon.png'; };
  if (img.complete && !img.naturalWidth) fallback(); else img.addEventListener('error', fallback, { once: true });
}
$('#agentLogoHome').onclick = goHome;
$('#agentSettings').onclick = e => openSettings(e.currentTarget as HTMLElement);
$('#agentNew').onclick = () => { selectAgentTask(null); $<HTMLTextAreaElement>('#agentPrompt').focus(); };
// The kill switch: every running task stops and pauses. Ctrl+Alt+Esc does the same while Breeze has focus.
const agentStopAll = () => background(api.agentTask.stopAll().then(n => toast(n ? `Paused ${plural(n, 'task')}` : 'Nothing was running')));
$('#agentStopAll').onclick = agentStopAll;
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && e.ctrlKey && e.altKey && appState.agentUnlocked) { e.preventDefault(); agentStopAll(); }
});
// Agents found after the screen opened fill in the composer's agent.
window.addEventListener('focus', () => { if (agentScreenShowing()) renderAgentComposer(); });
