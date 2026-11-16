/* ----- Agent teams: two or more @mentioned agents split one prompt and build side by side ----- */
function setClaimLabel(line: HTMLElement, text: string): void {
  const lbl = line.querySelector<HTMLElement>('.lbl');
  if (lbl) lbl.textContent = text;
}
function settleClaimLine(line: HTMLElement, text: string): void {
  line.classList.add('settled');
  setClaimLabel(line, text);
}
// The claim step is over (cancelled, failed, or handed to the build): the tab is free again unless a run took it.
function endTeamClaim(tab: AgentTabState, claim: TeamClaimState): void {
  if (tab.teamClaim !== claim) return;
  tab.teamClaim = undefined;
  if (tab.runId === -1) { tab.runId = null; tab.run = null; }
  refreshTabBusy(tab);
}

async function startAgentTeam(tab: AgentTabState, parsed: TeamParse): Promise<void> {
  const members = parsed.tasks.map(t => ({ agentId: t.agentId, task: t.text }));
  const line = addMsg(`<div class="team-claiming" role="status">${members.map(m => `<span class="team-claim-member">${agentBadge(m.agentId)}</span>`).join('')}<span class="lbl">Planning who does what</span></div>`, tab);
  const claimState: TeamClaimState = { members, line, cancelled: false };
  tab.teamClaim = claimState;
  tab.runId = -1; // busy: Send turns into Stop
  tab.run = null;
  refreshTabBusy(tab);
  try {
    await runAgentTeam(tab, parsed, claimState);
  } catch (e) {
    // Something unexpected broke the team flow: never leave the tab busy with nothing running.
    if (tab.teamClaim === claimState) {
      endTeamClaim(tab, claimState);
      if (claimState.teamId) background(api.team.stop(claimState.teamId));
    }
    if (!line.classList.contains('settled')) settleClaimLine(line, 'Couldn’t plan who does what');
    errorCard(errMsg(e), undefined, tab);
  }
}

async function runAgentTeam(tab: AgentTabState, parsed: TeamParse, claimState: TeamClaimState): Promise<void> {
  const { members, line } = claimState;
  let claim: TeamClaimResult;
  try {
    claim = await api.team.claim({ shared: parsed.shared, members: members.map(m => ({ ...m, session: tab.sessions[m.agentId] ?? null })) });
  } catch (e) {
    endTeamClaim(tab, claimState);
    if (claimState.cancelled) { settleClaimLine(line, 'Cancelled'); return; }
    settleClaimLine(line, 'Couldn’t plan who does what');
    errorCard(errMsg(e), undefined, tab);
    return;
  }
  claimState.teamId = claim.teamId; // from here on, a stop or an unexpected error can stop the team
  const s = SURFACES[tab.surfaceName];
  for (const [agentId, id] of Object.entries(claim.sessions ?? {})) {
    tab.sessions[agentId] = id;
    store.set(agentSessionKey(s, agentId), id);
  }
  if (claimState.cancelled) {
    background(api.team.stop(claim.teamId));
    settleClaimLine(line, 'Cancelled');
    endTeamClaim(tab, claimState);
    return;
  }
  settleClaimLine(line, 'Planned who does what');
  saveChat(tab);

  const owners = await splitCard(tab, claim);
  if (!owners) return; // Cancel: the card stopped the team and freed the tab

  const removed = claimState.removed ?? new Set<string>();
  const keep = members.filter(m => !removed.has(m.agentId));
  if (keep.length < 2) {
    // One agent left: it runs on its own, as if it had been the only one mentioned.
    background(api.team.stop(claim.teamId));
    endTeamClaim(tab, claimState);
    const m = keep[0];
    if (m) await startAgentRun(m.agentId, 'build', [parsed.shared, m.task].filter(Boolean).join('\n\n'), 'build', tab, true);
    return;
  }

  let ids: Record<string, number>;
  try {
    ids = await api.team.start({ teamId: claim.teamId, owners, exclude: [...removed] }); // removed members never start
  } catch (e) {
    const cancelled = claimState.cancelled;
    endTeamClaim(tab, claimState);
    background(api.team.stop(claim.teamId));
    if (cancelled) addMsg('<div class="handoff">Stopped by you</div>', tab);
    else errorCard(errMsg(e), undefined, tab);
    return;
  }

  const runs = new Map<number, Run>();
  const names: Record<string, string> = {};
  for (const m of keep) {
    const id = ids[m.agentId];
    if (typeof id !== 'number') continue;
    runs.set(id, { id, tabId: tab.id, surfaceName: tab.surfaceName, agent: m.agentId, mode: 'build', uiMode: 'build', phase: 'builder', tools: 0, files: new Set(), plan: null, lastText: '', replied: false, announce: false });
    names[m.agentId] = agentNameOf(m.agentId);
  }
  const shown = [...runs.values()];
  tab.panel.querySelector(':scope > .team-strip')?.remove();
  const stripEl = document.createElement('div');
  stripEl.className = 'team-strip';
  stripEl.setAttribute('role', 'status');
  stripEl.innerHTML = shown.map(r => `<span class="team-chip working" data-team-chip="${escAttr(r.agent)}">${agentBadge(r.agent)}<span class="team-chip-state">working</span></span>`).join('');
  tab.panel.prepend(stripEl);

  const agentTeam: AgentTeamState = {
    id: claim.teamId, runs, pending: runs.size, names, stripEl,
    finished: new Set(), failed: new Set(), crossings: new Set(), stopped: claimState.cancelled,
  };
  tab.agentTeam = agentTeam;
  tab.teamClaim = undefined;
  const first = shown[0] ?? null;
  tab.runId = first?.id ?? null;
  tab.run = first;
  agentRun = first;
  refreshTabBusy(tab);
  if (!runs.size) { errorCard('The team did not start.', undefined, tab); return; }

  agentsDef.builder.used = 0;
  setAgent('builder', 'working', 'Working as a team', 0);
  const who = shown.map(r => names[r.agent]);
  showThinking(`${who.slice(0, -1).join(', ')} and ${who[who.length - 1]} are working`, 'builder', tab);
  // Events that came in before the run ids did; other runs' early events stay queued for their own runs.
  for (let i = 0; i < earlyEvents.length;) {
    const [runId, ev] = earlyEvents[i];
    const run = runs.get(runId);
    if (run && tab.agentTeam === agentTeam) { earlyEvents.splice(i, 1); handleAgentEvent(run, ev, tab); }
    else i++;
  }
}

// One column per member and a row per clash. Resolves with the owners on Start, null on Cancel.
function splitCard(tab: AgentTabState, claim: TeamClaimResult): Promise<Record<string, string> | null> {
  const c = tab.teamClaim;
  const members = c?.members ?? Object.keys(claim.claims).map(agentId => ({ agentId, task: '' }));
  const removed = new Set<string>();
  if (c) c.removed = removed;
  const oneLine = (t: string) => t.replaceAll(/\s+/g, ' ').trim();
  const order = members.map(m => m.agentId);
  const cols = members.map(m => {
    const paths = claim.claims[m.agentId] ?? [];
    let body: string;
    if (claim.failed.includes(m.agentId)) {
      body = `<p class="split-failed">Couldn't list its files. It will own files it touches first.</p><button type="button" class="link-btn" data-remove="${escAttr(m.agentId)}">Remove</button>`;
    } else if (paths.length) {
      body = `<ul class="split-paths">${paths.map(p => `<li><code>${esc(p)}</code></li>`).join('')}</ul>`;
    } else {
      body = '<p class="split-none">No files listed</p>';
    }
    const task = oneLine(m.task);
    return `<div class="split-col" data-col="${escAttr(m.agentId)}">${agentBadge(m.agentId)}<div class="split-task" title="${escAttr(task)}">${esc(task || 'No task')}</div>${body}</div>`;
  }).join('');
  // The first-mentioned agent is picked by default.
  const clashes = claim.clashes.map(k => ({ path: k.path, agents: order.filter(a => k.agents.includes(a)) })).filter(k => k.agents.length);
  const rows = clashes.map((k, i) => `<div class="split-clash" data-clash="${i}"><code>${esc(k.path)}</code><div class="seg" role="radiogroup" aria-label="${escAttr(`Who owns ${k.path}`)}">${k.agents.map((a, j) => `<button type="button" role="radio" class="${j ? '' : 'on'}" aria-checked="${j ? 'false' : 'true'}" data-pick="${escAttr(a)}">${esc(agentNameOf(a))}</button>`).join('')}</div></div>`).join('');
  const clashHtml = rows ? `<div class="split-clashes"><p>More than one agent wants these. Pick who owns each:</p>${rows}</div>` : '';
  const el = addMsg(`<div class="card team-split"><h5>${svgIcon('columns', 14)} Who does what</h5><div class="split-cols">${cols}</div>${clashHtml}<div class="row" data-live><button class="btn btn-primary btn-sm" data-split="start">Start</button><button class="btn btn-sm" data-split="cancel">Cancel</button></div></div>`, tab);

  $$<HTMLButtonElement>('.seg button', el).forEach(b => b.onclick = () => {
    for (const o of $$<HTMLButtonElement>('button', b.parentElement!)) {
      o.classList.toggle('on', o === b);
      o.setAttribute('aria-checked', String(o === b));
    }
  });
  const removeLinks = () => $$<HTMLButtonElement>('[data-remove]', el);
  removeLinks().forEach(b => b.onclick = () => {
    const id = b.dataset.remove ?? '';
    removed.add(id);
    el.querySelector(`[data-col="${CSS.escape(id)}"]`)?.classList.add('removed');
    b.outerHTML = '<span class="split-removed">Removed</span>';
    // Someone has to do the work: the last member left can't be removed.
    if (members.length - removed.size <= 1) removeLinks().forEach(x => x.remove());
    saveChat(tab);
  });

  return new Promise(resolve => {
    let settled = false;
    const finish = (owners: Record<string, string> | null, label: string) => {
      if (settled) return;
      settled = true;
      if (c) c.cancel = undefined;
      el.querySelector('[data-live]')?.replaceWith(Object.assign(document.createElement('div'), { className: 'resolved', textContent: label }));
      $$<HTMLButtonElement>('button', el).forEach(b => { b.disabled = true; });
      removeLinks().forEach(x => x.remove());
      saveChat(tab);
      resolve(owners);
    };
    const cancel = () => {
      background(api.team.stop(claim.teamId));
      if (c) endTeamClaim(tab, c);
      else refreshTabBusy(tab);
      finish(null, '✕ Cancelled');
    };
    if (c) c.cancel = cancel;
    $<HTMLButtonElement>('[data-split="cancel"]', el).onclick = cancel;
    $<HTMLButtonElement>('[data-split="start"]', el).onclick = () => {
      // Every claimed path goes to its claimer (first claim wins), then each clash to the agent picked for it.
      const owners = new Map<string, string>();
      for (const m of members) {
        if (removed.has(m.agentId)) continue;
        for (const p of claim.claims[m.agentId] ?? []) if (!owners.has(p)) owners.set(p, m.agentId);
      }
      clashes.forEach((k, i) => {
        const pick = el.querySelector<HTMLElement>(`[data-clash="${i}"] button.on`)?.dataset.pick;
        if (pick && !removed.has(pick)) owners.set(k.path, pick);
      });
      sfx.play('approve');
      finish(Object.fromEntries(owners), '✓ Started');
    };
  });
}

// The key for a crossing in AgentTeamState.crossings.
function crossingKey(agent: string, path: string): string {
  return `${agent}|${path}`;
}

function crossingCard(r: Run, ev: AgentEvent, tab: AgentTabState): void {
  if (isBoardSurface(tab.surfaceName)) { boardCrossingCard(ev, tab); return; }
  const team = tab.agentTeam;
  if (!team) return;
  const who = ev.agent ?? r.agent;
  const name = team.names[who] ?? agentNameOf(who);
  const owner = ev.owner ? team.names[ev.owner] ?? agentNameOf(ev.owner) : 'a teammate';
  const path = ev.path ?? '';
  team.crossings?.add(crossingKey(who, path));
  const at = `<code>${esc(path)}</code> (${esc(owner)}'s)`;
  let head: string;
  if (ev.blocked) head = `${esc(name)} tried to edit ${at} and was stopped.`;
  else if (ev.error) head = `${esc(name)} tried to edit ${at}.`; // it was not put back: the line below says why
  else head = `${esc(name)} tried to edit ${at}. Breeze put it back.`;
  const failed = ev.error ? `<p class="crossing-error">${esc(`Breeze couldn't put it back: ${ev.error}`)}</p><div class="row" data-live><button class="btn btn-sm" data-crossing-undo>Undo</button></div>` : '';
  sfx.play('tool');
  const el = addMsg(`<div class="card crossing"><h5>${svgIcon('alert', 14)} Crossing</h5><p>${head}</p>${failed}</div>`, tab);
  const undo = el.querySelector<HTMLButtonElement>('[data-crossing-undo]');
  if (undo) undo.onclick = () => undoTeamFile(team.id, path, undo, tab);
}

// Puts one file back from the team's snapshot. A finished (dropped) team rejects, and the toast says so.
function undoTeamFile(teamId: string, path: string, btn: HTMLButtonElement, tab: AgentTabState): void {
  const live = btn.closest<HTMLElement>('[data-live]');
  btn.disabled = true;
  api.team.undo({ teamId, path }).then(() => {
    live?.replaceWith(Object.assign(document.createElement('div'), { className: 'resolved', textContent: '✓ Undone' }));
    const b = buffers.get(path);
    if (b?.kind === 'text' && !holdsUserEdits(b)) void reloadText(b);
    renderTree(); queueGitRefresh();
    saveChat(tab);
  }, e => {
    btn.disabled = false;
    toast(errMsg(e));
  });
}

function teamSummary(tab: AgentTabState, team: AgentTeamState, ev: AgentEvent): void {
  const shown = [...team.runs.values()];
  const crossed = team.crossings ?? new Set<string>();
  const memberRows = shown.map(r => {
    const files = [...r.files].filter(p => !crossed.has(crossingKey(r.agent, p))); // a crossing was put back
    let what: string;
    if (team.failed?.has(r.agent)) what = '<span class="ts-unfinished">not finished</span>';
    else if (files.length) what = files.map(p => `<code>${esc(p)}</code>`).join('');
    else what = '<span class="ts-none">No files changed</span>';
    return `<div class="ts-member">${agentBadge(r.agent)}<div class="ts-files">${what}</div></div>`;
  }).join('');
  const crossings = `<p class="ts-crossings">${crossed.size ? plural(crossed.size, 'crossing') : 'No crossings'}</p>`;
  const notes = Object.entries(ev.notes ?? {}).flatMap(([from, to]) => Object.entries(to ?? {}).map(([toName, text]) =>
    `<li>${esc(`${team.names[from] ?? agentNameOf(from)} → ${toName}: ${text}`).replaceAll('\n', '<br>')}</li>`));
  const notesHtml = notes.length ? `<ul class="ts-notes">${notes.join('')}</ul>` : '';
  const changed = (ev.changed ?? []).map(p => `<div class="ts-changed" data-path="${escAttr(p)}"><code>${esc(p)}</code><div class="row" data-live><button class="btn btn-sm" data-ts="undo">Undo</button><button class="btn btn-sm" data-ts="keep">Keep</button></div></div>`).join('');
  const changedHtml = changed ? `<div class="ts-changes"><p>These files changed, but no agent said it edited them:</p>${changed}</div>` : '';
  const skipped = ev.skipped?.length ? `<p class="ts-skipped">Not protected (too large): ${ev.skipped.map(p => `<code>${esc(p)}</code>`).join(', ')}</p>` : '';
  const error = ev.error ? `<p class="ts-error">${esc(`Breeze couldn't check for other changes: ${ev.error}`)}</p>` : '';
  const trouble = !!team.failed?.size || !!team.stopped;
  let title = 'Team finished';
  if (team.stopped) title = 'Team stopped';
  else if (trouble) title = 'Team finished, with problems';
  const el = addMsg(`<div class="card team-summary${trouble ? ' trouble' : ''}"><h5>${svgIcon(trouble ? 'alert' : 'check', 14)} ${title}</h5><div class="ts-members">${memberRows}</div>${crossings}${notesHtml}${changedHtml}${skipped}${error}</div>`, tab);
  $$<HTMLElement>('.ts-changed', el).forEach(row => {
    const path = row.dataset.path ?? '';
    const undo = row.querySelector<HTMLButtonElement>('[data-ts="undo"]');
    const keep = row.querySelector<HTMLButtonElement>('[data-ts="keep"]');
    if (undo) undo.onclick = () => undoTeamFile(team.id, path, undo, tab);
    if (keep) keep.onclick = () => {
      row.querySelector('[data-live]')?.replaceWith(Object.assign(document.createElement('div'), { className: 'resolved', textContent: '✓ Kept' }));
      saveChat(tab);
    };
  });
}

// One member's done. The tab stays busy (and its locks and thinking line stay) until every member is done.
function finishTeamMember(r: Run, ev: AgentEvent, tab: AgentTabState, team: AgentTeamState): void {
  const finished = team.finished ??= new Set();
  if (finished.has(r.id)) return;
  finished.add(r.id);
  if (agentRun?.id === r.id) agentRun = null;
  const ok = !!ev.ok && !ev.stopped;
  if (!ok) (team.failed ??= new Set()).add(r.agent);
  const chip = team.stripEl.querySelector<HTMLElement>(`[data-team-chip="${CSS.escape(r.agent)}"]`);
  if (chip) {
    chip.classList.remove('working');
    chip.classList.add(ok ? 'done' : 'failed');
    const state = chip.querySelector('.team-chip-state');
    if (state) state.textContent = ok ? 'done' : ev.stopped ? 'stopped' : 'failed';
  }
  for (const [p, l] of Object.entries(locks)) if (l.agent === r.agent) delete locks[p];
  renderTree(); renderTabs();
  queueGitRefresh();
  team.pending = Math.max(0, team.pending - 1);
  if (team.pending > 0) return;

  // Every member is done. The summary comes with team-done; the tab is free now either way.
  if (tab.agentTeam === team) { tab.runId = null; tab.run = null; }
  hideThinking(tab);
  for (const k of Object.keys(locks)) delete locks[k];
  renderTree(); renderTabs();
  refreshTabBusy(tab);
  const all = [...team.runs.values()];
  lastRunFiles = [...new Set(all.flatMap(x => [...x.files]))];
  const tools = all.reduce((n, x) => n + x.tools, 0);
  const allOk = !team.failed?.size && !team.stopped;
  const label = labelAgent;
  labelAgent = null; // these lines are the team's, not the last member's
  if (team.stopped) {
    addMsg('<div class="handoff">Stopped by you</div>', tab);
    setAgent('builder', 'idle', 'Stopped', tools);
  } else if (!allOk) {
    setAgent('builder', 'idle', 'Stopped with an error', tools);
  } else {
    setAgent('builder', 'done', lastRunFiles.length ? `Changed ${plural(lastRunFiles.length, 'file')}` : 'Answered', tools);
    sfx.play('success');
  }
  labelAgent = label;
  if (!hasAnyActiveRun()) vibeDone(allOk);
  const s = SURFACES[tab.surfaceName];
  if (!isBoardSurface(s.name)) s.prompt.placeholder = s.name === 'box' ? 'Ask Breeze anything' : ' '; // a board box keeps its own
  if (lastRunFiles.length && running) autoReloadPreview();
}

// team-done comes once on every member's run: the first one shows the summary and ends the team.
function onTeamDone(r: Run, ev: AgentEvent, tab: AgentTabState): void {
  const team = tab.agentTeam;
  if (!team || !team.runs.has(r.id) || (ev.teamId && ev.teamId !== team.id)) return;
  // Main sends it after every member's done; should one be missing, that member did not finish.
  for (const run of team.runs.values()) if (!team.finished?.has(run.id)) finishTeamMember(run, { t: 'done', ok: false }, tab, team);
  teamSummary(tab, team, ev);
  tab.lastTeamId = team.id;
  tab.agentTeam = undefined;
  if (tab.runId != null && team.runs.has(tab.runId)) { tab.runId = null; tab.run = null; }
  refreshTabBusy(tab);
}

async function startAgentRun(agentId: string, mode: AgentMode, prompt: string, uiMode: string, tab: AgentTabState, announce = false): Promise<void> {
  const phase = phaseFor(mode);
  showThinking(`${speaker(phase, agentId).name} is reading your message`, phase, tab, agentId);
  tab.agentId = agentId;
  tab.uiMode = uiMode;
  agentsDef[phase].used = 0;
  agentsDef[phase].agentId = agentId;

  try {
    const box = tab.surfaceName === 'box';
    // Each agent resumes only its own session (a Codex thread id means nothing to Claude Code).
    const session = tab.sessions[agentId] ?? null;
    // An Agent board box runs through the board, which keeps its files apart from the other boxes'.
    const id = isBoardSurface(tab.surfaceName)
      ? await api.board.run({ boxKey: boxKeyOf(tab.surfaceName), agent: agentId, prompt, session, ...boardPickOf(boxKeyOf(tab.surfaceName)) })
      : await api.agent.run({ agent: agentId, mode, prompt, session, box });
    const run: Run = {
      id,
      tabId: tab.id,
      surfaceName: tab.surfaceName,
      agent: agentId,
      mode,
      uiMode,
      phase,
      tools: 0,
      files: new Set(),
      plan: null,
      lastText: '',
      replied: false,
      announce,
    };
    tab.runId = id;
    tab.run = run;
    agentRun = run;

    updateTabBusyState(SURFACES[tab.surfaceName], tab);
    renderAgentTabs(SURFACES[tab.surfaceName]);

    for (const [runId, ev] of earlyEvents.splice(0)) {
      if (runId === id) handleAgentEvent(run, ev, tab);
    }
    if (tab.runId === id) setAgent(phase, 'working', mode === 'build' ? 'Working on your request' : 'Reading the project', 0);
  } catch (e) {
    tab.runId = null;
    tab.run = null;
    updateTabBusyState(SURFACES[tab.surfaceName], tab);
    renderAgentTabs(SURFACES[tab.surfaceName]);
    hideThinking(tab);
    joinTeam(phase);
    setAgent(phase, 'idle', 'Could not start', 0);
    errorCard(errMsg(e), undefined, tab);
  }
}

function errorCard(text: string, hint?: string, tab?: AgentTabState): void {
  const hintHtml = hint ? `<p>${esc(hint)}</p>` : '';
  addMsg(`<div class="card error"><h5>${svgIcon('alert', 14)} The agent hit a problem</h5><pre>${esc(text)}</pre>${hintHtml}</div>`, tab);
}

function onAgentFile(r: Run, path: string, created = false, written = false): void {
  r.files.add(path);
  locks[path] = { phase: r.phase, agent: r.agent };
  renderTree(); renderTabs();
  queueGitRefresh();
  if (r.surfaceName === 'ide') background(openAgentFile(path, created, written));
  else if (r.surfaceName === 'box') liveFile(path);
  else if (isBoardSurface(r.surfaceName)) boardLiveFile(boxKeyOf(r.surfaceName), path); // a board box leaves the editor alone: several agents would fight over it
}
// The agent is about to change `path` (`before`: the file as it is now). Its tab opens with that text and is shown
// first; the write then types out in it (fs.onChange → reloadText → typeAgentEdit).
function onAgentOpening(r: Run, path: string, before: string | undefined): void {
  if (r.surfaceName !== 'ide' || !rootInfo || baseName(path).startsWith('.env')) return;
  locks[path] = { phase: r.phase, agent: r.agent };
  if (!buffers.has(path)) {
    if (before == null) { background(openAgentFile(path)); return; }
    if (!blankBuffer(path, before)) return;
    renderTabs();
  }
  void inAgentTurn(() => followAgentTo(path));
}
// Opens the file an agent is editing and shows it, so its changes type out in front of the person.
// `written`: the agent reported the change after making it (Codex), so the file opens as committed and the change
// types out from there, instead of the tab opening with the change already in it.
async function openAgentFile(path: string, created = false, written = false): Promise<void> {
  if (baseName(path).startsWith('.env') || !rootInfo) return;
  if (!buffers.has(path)) {
    // A new file opens empty, so its text types in instead of appearing all at once.
    if (created) {
      if (!typeAgentDraft(path, '')) return;
    } else {
      const r = await api.fs.readFile(path).catch(() => null);
      if (r?.text == null || kindOf(r) !== 'text') return; // deleted, binary or too large
      const head = written && !buffers.has(path) ? await api.git.headText(path).catch(() => null) : null;
      if (head != null && !buffers.has(path)) {
        // blankBuffer keeps a byte order mark out of the text, as readBuffer does; so does the text typed out here.
        const b = blankBuffer(path, head);
        const disk = stripBom(r.text);
        if (b) b.bom = disk.length !== r.text.length; // the file's mark, not the committed one
        if (b && b.text !== disk.replaceAll('\r\n', '\n')) void typeAgentEdit(b, disk.replaceAll('\r\n', '\n'));
      }
      if (!buffers.has(path) && !await loadBuffer(path)) return;
    }
  }
  // Shown in its turn, after any change still typing out in another file.
  void inAgentTurn(() => followAgentTo(path));
  // Some agents report the file before writing it: catch a write that landed while it was opening.
  const b = buffers.get(path);
  if (b?.kind === 'text') for (const ms of created ? [0, 400, 1500] : [400, 1500]) setTimeout(() => { if (!holdsUserEdits(b)) void reloadText(b); }, ms);
}
// The agent's text for a file it is creating, as it writes it.
function onAgentDraft(r: Run, path: string, text: string): void {
  if (r.surfaceName === 'box') { liveDraft(path, text, r.phase); return; }
  if (isBoardSurface(r.surfaceName)) boardLiveDraft(boxKeyOf(r.surfaceName), path, text, r.phase);
  if (!typeAgentDraft(path, text)) return;
  (r.drafts ??= new Set()).add(path);
}
// Draft tabs whose file never got written (the run stopped, or the write was refused) close again.
function dropUnwrittenDrafts(r: Run): void {
  let dropped = false;
  for (const path of r.drafts ?? []) {
    const b = buffers.get(path);
    if (r.files.has(path) || !b || isDirty(b)) continue;
    if (openTabs.includes(path)) dropTab(path);
    else { b.ta?.remove(); if (b.doc != null) docClose(b); buffers.delete(path); } // as dropTab does
    dropped = true;
  }
  if (dropped) { renderTabs(); renderEditor(); }
}

function onAgentError(r: Run, ev: AgentEvent, tab: AgentTabState): void {
  if (r.lastMsg && ev.text?.trim() === r.lastText.trim()) r.lastMsg.remove();
  errorCard(ev.text ?? 'Unknown error', ev.hint, tab);
}

// The local agent asks before a command Breeze can't tell is harmless; the run waits for the answer.
function approveCard(r: Run, ev: AgentEvent, tab: AgentTabState): void {
  const id = ev.id;
  if (!id || !ev.command) return;
  r.lastMsg = undefined;
  setAgent(r.phase, 'waiting', 'Waiting for your OK to run a command', r.tools);
  sfx.play('plan');
  const el = addMsg(`<div class="card warn"><h5>${svgIcon('alert', 14)} Run this command?</h5><pre>${esc(ev.command)}</pre><div class="row" data-live><button class="btn btn-primary btn-sm" data-ask="once">Run it</button><button class="btn btn-sm" data-ask="all">Allow all this run</button><button class="btn btn-sm" data-ask="deny">Don’t run</button></div></div>`, tab);
  $$<HTMLElement>('[data-ask]', el).forEach(b => b.onclick = () => {
    const answer = b.dataset.ask === 'once' || b.dataset.ask === 'all' ? b.dataset.ask : 'deny';
    $('[data-live]', el).outerHTML = `<div class="resolved">${answer === 'deny' ? '✕ Not run' : '✓ Allowed'}</div>`;
    setAgent(r.phase, 'working', 'Working on your request', r.tools);
    background(api.agent.answer(id, answer));
  });
}

// An agent's question: a button for each option and a box for another answer. With one choice allowed a click
// answers; with several, options switch on and off and Send answers. The run waits meanwhile.
function questionCard(r: Run, ev: AgentEvent, tab: AgentTabState): void {
  const id = ev.id;
  if (!id || !ev.question) return;
  if (ev.plan) { planApprovalCard(r, id, ev.plan, tab); return; }
  const options = ev.options ?? [];
  const multi = !!ev.multiSelect && options.length > 1;
  r.lastMsg = undefined;
  setAgent(r.phase, 'waiting', 'Waiting for your answer', r.tools);
  sfx.play('plan');
  const who = speaker(r.phase, r.agent);
  // Options 1–9 get a number key; the rest are still clickable.
  const opts = options.map((o, i) => `<button class="q-opt" type="button" role="${multi ? 'checkbox' : 'radio'}" aria-checked="false" tabindex="${i ? -1 : 0}" data-q-opt="${escAttr(o.label)}"><span class="q-key" aria-hidden="true">${i < 9 ? i + 1 : ''}</span><span class="q-label"><b>${esc(o.label)}</b>${o.description ? `<small>${esc(o.description)}</small>` : ''}</span><span class="q-radio" aria-hidden="true"></span></button>`).join('');
  const keys = Math.min(options.length, 9);
  const hint = keys > 1 ? `<span class="q-hint"><kbd>1</kbd>–<kbd>${keys}</kbd> to pick${multi ? ', any that apply' : ''}</span>` : '<span class="q-hint"></span>';
  const own = options.length
    ? `<label class="q-own"><span>Or answer in your own words</span><input class="input" type="text" maxlength="2000" placeholder="Type your answer" spellcheck="false"></label>`
    : `<input class="input q-own-only" type="text" maxlength="2000" placeholder="Type your answer" aria-label="Your answer" spellcheck="false">`;
  const el = addMsg(`<div class="card ask question" data-question="${escAttr(id)}"><div class="q-head">${brandMark('avatar mini', who.tint, who.letter)}<b>${esc(who.name)} has a question</b><span class="q-wait">Waiting for you</span></div><p class="q-text">${inlineMd(ev.question)}</p><div class="q-live" data-live>${opts ? `<div class="q-opts" role="${multi ? 'group' : 'radiogroup'}" aria-label="Answers"><i class="q-slide" aria-hidden="true"></i>${opts}</div>` : ''}${own}<div class="q-foot">${hint}<button class="btn btn-ghost btn-sm" type="button" data-q-skip title="Let the agent decide">Skip</button><button class="btn btn-primary btn-sm" type="button" data-q-send disabled>Send answer</button></div></div></div>`, tab);
  const input = $<HTMLInputElement>('.q-live input', el);
  const sendBtn = $<HTMLButtonElement>('[data-q-send]', el);
  const rows = $$<HTMLButtonElement>('.q-opt', el);
  const slide = el.querySelector<HTMLElement>('.q-slide');
  const picked = () => rows.filter(b => b.getAttribute('aria-checked') === 'true');
  const refresh = () => {
    sendBtn.disabled = !picked().length && !input.value.trim();
    if (multi || !slide) return;
    // One highlight glides to the picked row instead of each row lighting up on its own.
    const on = picked()[0];
    if (on) {
      const first = !slide.classList.contains('on');
      if (first) slide.style.transition = 'opacity .15s ease'; // the first pick fades in place rather than sliding from the top
      slide.style.transform = `translateY(${on.offsetTop}px)`;
      slide.style.height = `${on.offsetHeight}px`;
      if (first) { void slide.offsetWidth; slide.style.transition = ''; }
    }
    slide.classList.toggle('on', !!on);
    // Roving focus: Tab lands on the picked row (or the first), as in any radio list.
    rows.forEach(b => b.tabIndex = (on ? b === on : b === rows[0]) ? 0 : -1);
  };
  const pick = (b: HTMLButtonElement, focus: boolean) => {
    if (multi) b.setAttribute('aria-checked', String(b.getAttribute('aria-checked') !== 'true'));
    else {
      rows.forEach(x => x.setAttribute('aria-checked', String(x === b)));
      input.value = '';
    }
    if (focus) b.focus();
    refresh();
  };
  const answer = (reply: AskReply | null) => {
    const said = reply ? [...reply.picked, reply.other].filter(Boolean).join(', ') : '';
    sendReply(r, el, id, reply, !reply ? `– You skipped this. ${who.name} will decide.` : reply.other && !reply.picked.length ? `✎ ${said}` : `✓ ${said}`, tab);
  };
  rows.forEach(b => b.onclick = () => pick(b, false));
  const send = () => {
    const chosen = picked().map(b => b.dataset.qOpt as string);
    const other = input.value.trim();
    if (chosen.length || other) answer({ picked: chosen, other });
    else input.focus();
  };
  sendBtn.onclick = send;
  $('[data-q-skip]', el).onclick = () => answer(null);
  input.addEventListener('input', () => {
    // Writing your own answer replaces a single pick; with several allowed it is sent alongside them.
    if (!multi && input.value) rows.forEach(x => x.setAttribute('aria-checked', 'false'));
    refresh();
  });
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); send(); }
  });
  // Number keys pick from anywhere in the card (number row or numpad), except while typing.
  el.addEventListener('keydown', e => {
    if (e.target === input || e.ctrlKey || e.altKey || e.metaKey || !el.querySelector('[data-live]')) return;
    const n = /^(?:Digit|Numpad)([1-9])$/.exec(e.code)?.[1];
    const b = n ? rows[+n - 1] : undefined;
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    pick(b, true);
  });
}
// A picture the agent showed, in the lightbox the user's attachments use. Pictures in a row share one line, and
// the reply that follows starts a new message. A picture in the project opens in the editor from its name.
function agentImage(r: Run, ev: AgentEvent, tab: AgentTabState): void {
  if (!ev.url) return;
  r.lastMsg = undefined;
  const name = ev.name || 'Picture';
  const label = ev.caption || ev.path || name;
  const cap = ev.path
    ? `<button class="chat-img-cap" type="button" data-edit-file="${escAttr(ev.path)}" title="Open ${escAttr(ev.path)}">${esc(label)}</button>`
    : `<span class="chat-img-cap">${esc(label)}</span>`;
  const item = `<figure class="agent-img"><div class="chat-img-wrap" title="Click to view full size"><img src="${escAttr(ev.url)}" class="chat-img" alt="${escAttr(ev.caption || name)}" data-full="${escAttr(ev.url)}"></div>${cap}</figure>`;
  const thinking = tab.panel.querySelector(':scope > .thinking');
  const last = (thinking ? thinking.previousElementSibling : tab.panel.lastElementChild) as HTMLElement | null;
  const row = last?.classList.contains('agent-imgs') && (last.dataset.agent ?? null) === labelAgent ? last.querySelector('.msg-attachments') : null;
  if (!row) { addMsg(`<div class="msg agent-imgs"><div class="body"><div class="msg-attachments">${item}</div></div></div>`, tab); return; }
  row.insertAdjacentHTML('beforeend', item);
  if (tab.id === activeTabId[tab.surfaceName]) scrollChat(SURFACES[tab.surfaceName]);
  saveChat(tab);
}

// Test results from a command the agent ran: the counts, and each failure with the first line of its error. A failure
// in a project file opens that file at the line it failed on.
function testsCard(r: Run, ev: AgentEvent, tab: AgentTabState): void {
  const passed = ev.passed ?? 0, failed = ev.failed ?? 0, skipped = ev.skippedCount ?? 0;
  const failures = ev.failures ?? [];
  r.lastMsg = undefined;
  const counts = [`<span class="t-pass">${passed} passed</span>`, failed ? `<span class="t-fail">${failed} failed</span>` : '', skipped ? `<span>${skipped} skipped</span>` : '']
    .filter(Boolean).join('<span class="t-dot">·</span>');
  const rows = failures.map(f => {
    const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '';
    const body = `<span class="t-name">${esc(f.name)}</span>${f.error ? `<span class="t-err">${esc(f.error)}</span>` : ''}${where ? `<span class="t-loc">${esc(where)}</span>` : ''}`;
    return f.file
      ? `<li><button class="t-row" type="button" data-test-file="${escAttr(f.file)}" data-test-line="${f.line ?? 0}" title="Open ${escAttr(where)}">${body}</button></li>`
      : `<li><div class="t-row">${body}</div></li>`;
  }).join('');
  const more = failed > failures.length && failures.length ? `<p class="t-more">and ${failed - failures.length} more</p>` : '';
  addMsg(`<div class="card tests ${failed ? 'fail' : 'ok'}"><h5>${svgIcon(failed ? 'circleX' : 'check', 14)} Tests <span class="t-runner">${esc(ev.runner ?? '')}</span></h5><p class="t-counts">${counts}</p>${rows ? `<ul class="t-fails">${rows}</ul>` : ''}${more}</div>`, tab);
}

// The card stops taking answers and says how it ended.
// The card's answer goes back to the waiting agent, and the card stops taking clicks.
function sendReply(r: Run, el: HTMLElement, id: string, reply: AskReply | null, how: string, tab: AgentTabState): void {
  endQuestion(el, how);
  setAgent(r.phase, 'working', 'Working on your request', r.tools);
  saveChat(tab);
  const box = isBoardSurface(tab.surfaceName) ? boardBoxes.get(boxKeyOf(tab.surfaceName)) : undefined;
  if (box) paintBox(box); // its box stops showing "waiting"
  background(api.agent.reply(id, reply));
}

// An agent's plan (propose_plan), shown in the chat while the run waits: Approve lets it go ahead in the same run;
// a note sends the plan back to be changed.
function planApprovalCard(r: Run, id: string, plan: string, tab: AgentTabState): void {
  r.lastMsg = undefined;
  r.plan = plan;
  setAgent(r.phase, 'waiting', 'Waiting for plan approval', r.tools);
  sfx.play('plan');
  const el = addMsg(`<div class="card plan question" data-question="${escAttr(id)}"><h5>${svgIcon('todo', 14)} ${esc(speaker(r.phase, r.agent).name)}’s plan</h5><div class="plan-body">${md(plan)}</div><div class="q-live" data-live><div class="row"><button class="btn btn-primary btn-sm" type="button" data-plan-ok>Approve &amp; build</button><button class="btn btn-sm" type="button" data-plan-no title="The agent stops without changing files">Not now</button></div><div class="row q-other"><input class="input" type="text" maxlength="2000" placeholder="Or say what should change…" aria-label="What should change in the plan" spellcheck="false"><button class="btn btn-sm" type="button" data-plan-edit>Send</button></div></div></div>`, tab);
  const input = $<HTMLInputElement>('.q-other input', el);
  $('[data-plan-ok]', el).onclick = () => { sfx.play('approve'); sendReply(r, el, id, { picked: ['Approve'], other: '' }, '✓ Approved', tab); };
  $('[data-plan-no]', el).onclick = () => sendReply(r, el, id, null, '✕ Not approved', tab);
  const edit = () => {
    const other = input.value.trim();
    if (other) sendReply(r, el, id, { picked: [], other }, `✎ ${other}`, tab);
    else input.focus();
  };
  $('[data-plan-edit]', el).onclick = edit;
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); edit(); }
  });
}

function endQuestion(card: Element | null | undefined, how: string): void {
  const live = card?.querySelector('[data-live]');
  if (!card || !live) return;
  const done = document.createElement('div');
  done.className = 'resolved';
  const m = /^([✓✕✎–]) ([\s\S]*)$/.exec(how);
  if (m) done.append(Object.assign(document.createElement('span'), { className: m[1] === '✓' || m[1] === '✎' ? 'q-mark ok' : 'q-mark', textContent: m[1] }), m[2]);
  else done.textContent = how;
  // Morph: the card glides from its open height to the answered one while the answer fades in.
  const box = card as HTMLElement;
  const from = box.offsetHeight;
  live.replaceWith(done);
  card.classList.add('answered');
  const to = box.offsetHeight;
  if (!from || from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  box.style.overflow = 'hidden';
  box.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 350, easing: 'cubic-bezier(.32, .72, 0, 1)' }).onfinish = () => box.style.overflow = '';
  done.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 250, easing: 'cubic-bezier(.2, .8, .2, 1)' });
}

function onFirstReply(r: Run, tab: AgentTabState): void {
  r.replied = true;
  if (r.announce) teamNeed = TEAM_SIZE[r.uiMode] ?? 1;
  joinTeam(r.phase);
  if (r.announce && tab.surfaceName === 'ide') addMsg(`<div class="team-line">${teamLineHtml(r.uiMode || r.mode, r.agent)}</div>`, tab);
}

const AGENT_EVENTS: Partial<Record<AgentEvent['t'], (r: Run, ev: AgentEvent, tab: AgentTabState) => void>> = {
  session: (r, ev, tab) => {
    if (ev.id) {
      tab.sessions[r.agent] = ev.id;
      store.set(agentSessionKey(SURFACES[tab.surfaceName], r.agent), ev.id);
    }
  },
  text: (r, ev, tab) => {
    if (!ev.text) return;
    if (r.lastMsg && r.lastText && (ev.text.startsWith(r.lastText) || ev.text === r.lastText)) {
      const bodyEl = r.lastMsg.querySelector('.body');
      if (bodyEl) {
        bodyEl.innerHTML = md(ev.text);
        r.lastText = ev.text;
        sfx.play('stream'); // a light patter while the answer streams in
        if (tab.id === activeTabId[tab.surfaceName]) scrollChat(SURFACES[tab.surfaceName]);
        saveChat(tab);
        return;
      }
    }
    r.lastText = ev.text;
    r.lastMsg = agentMsg(r.phase, md(ev.text), tab, r.agent);
  },
  tool: (r, ev, tab) => {
    r.lastMsg = undefined;
    r.tools++;
    if (ev.kind === 'run') r.commands = (r.commands ?? 0) + 1;
    toolLine(ev.kind ?? 'tool', ev.label ?? '', tab);
    setAgent(r.phase, 'working', ev.label ?? 'Working', r.tools);
  },
  opening: (r, ev) => { if (ev.path) onAgentOpening(r, ev.path, ev.text); },
  file: (r, ev) => { if (ev.path) onAgentFile(r, ev.path, !!ev.created, !!ev.written); },
  draft: (r, ev) => { if (ev.path) onAgentDraft(r, ev.path, ev.text ?? ''); },
  plan: (r, ev) => { r.plan = ev.text ?? ''; },
  approve: (r, ev, tab) => approveCard(r, ev, tab),
  question: (r, ev, tab) => questionCard(r, ev, tab),
  image: (r, ev, tab) => agentImage(r, ev, tab),
  tests: (r, ev, tab) => testsCard(r, ev, tab),
  // The run stopped (or the agent gave up waiting) before anyone answered.
  'question-end': (_r, ev, tab) => { if (ev.id) endQuestion(tab.panel.querySelector(`[data-question="${CSS.escape(ev.id)}"]`), '✕ Not answered'); saveChat(tab); },
  note: (_r, ev, tab) => { if (ev.text) toolLine('note', ev.text, tab); },
  auth: (_r, ev, tab) => {
    const url = ev.url;
    const cmd = ev.command;
    let actionHtml = '';
    if (url) {
      actionHtml = '<div class="row mt-8"><button class="btn btn-primary btnAgentAuth">Sign in with Google</button></div>';
    } else if (cmd) {
      actionHtml = `<p class="sub">Run <code>${esc(cmd)}</code> to sign in</p>`;
    }
    const cardHtml = `<div class="card warn"><h5>${svgIcon('alert', 14)} Sign-in Required</h5><p>${esc(ev.text || 'Antigravity session expired or unauthenticated.')}</p>${actionHtml}</div>`;
    const el = addMsg(cardHtml, tab);
    if (url) {
      el.querySelector<HTMLElement>('.btnAgentAuth')?.addEventListener('click', () => {
        background(api.sys.openExternal(url));
      });
    }
  },
  'auth-required': (r, ev, tab) => {
    AGENT_EVENTS.auth?.(r, ev, tab);
  },
  error: (r, ev, tab) => onAgentError(r, ev, tab),
  done: (r, ev, tab) => { dropUnwrittenDrafts(r); finishRun(r, ev, tab); },
  crossing: (r, ev, tab) => crossingCard(r, ev, tab),
  'team-done': (r, ev, tab) => onTeamDone(r, ev, tab),
};

function handleAgentEvent(r: Run, ev: AgentEvent, tab: AgentTabState): void {
  const team = tab.agentTeam?.runs.has(r.id) ? tab.agentTeam : undefined;
  if (!r.replied && ev.t !== 'session' && ev.t !== 'done' && ev.t !== 'team-done') onFirstReply(r, tab);
  const prev = labelAgent;
  labelAgent = team && ev.t !== 'team-done' ? r.agent : null;
  try {
    AGENT_EVENTS[ev.t]?.(r, ev, tab);
  } finally {
    labelAgent = prev;
  }
}

const earlyEvents: [number, AgentEvent][] = [];
api.agent.onEvent((runId, ev) => {
  const found = findTabForRun(runId);
  if (found) {
    handleAgentEvent(found.run, ev, found.tab);
  } else if (ev.t !== 'team-done' && earlyEvents.length < 200) { // a team-done nobody is waiting for: already handled, or the tab moved on
    earlyEvents.push([runId, ev]);
  }
});

// The files changed show on their own line (editsHtml), so the Done line only has the time and usage.
function runSummary(r: Run, ev: AgentEvent): string[] {
  const time = ev.ms ? `${Math.max(1, Math.round(ev.ms / 1000))}s` : '';
  let usage = '';
  if (ev.cost) usage = `$${ev.cost.toFixed(2)}`;
  else if (ev.tokens) usage = `${ev.tokens.toLocaleString()} tokens`;
  return [time, usage].filter(Boolean);
}

/* ----- "Edited app.ts, ran a command +12 −3 · View changes ▸" under a reply that changed files ----- */
function editsText(files: string[], commands: number): string {
  const names = files.map(f => baseName(f.replaceAll('\\', '/')));
  const what = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : plural(names.length, 'file');
  const ran = commands ? `, ran ${commands === 1 ? 'a command' : plural(commands, 'command')}` : '';
  return `Edited ${what}${ran}`;
}
function editsHtml(files: string[], commands: number): string {
  const rows = files.map(f => `<button class="re-file" type="button" data-edit-file="${escAttr(f)}" title="${escAttr(f)}">
      <span class="nm">${esc(f)}</span><span class="re-n" data-n></span></button>`).join('');
  return `<div class="run-edits"><div class="re-head"><span class="re-what">${esc(editsText(files, commands))}</span>
    <span class="re-n" data-total></span><span class="re-dot">·</span>
    <button class="re-view" type="button" aria-expanded="false">View changes${svgIcon('chevronRight', 12)}</button></div>
    <div class="re-files">${rows}</div></div>`;
}
const countHtml = (c: { added: number; removed: number }) => `<span class="re-add">+${c.added}</span><span class="re-del">−${c.removed}</span>`;
// Lines added and removed, from git: the file's changes not yet staged, or all of a new (untracked) file. These
// include any earlier unstaged edits to the same file. Null outside a repository, where there is nothing to count.
async function lineCounts(path: string, untracked: boolean): Promise<{ added: number; removed: number } | null> {
  if (untracked) {
    const f = await api.fs.readFile(path).catch(() => null);
    if (f?.text == null) return null;
    return { added: f.text ? f.text.split('\n').length - (f.text.endsWith('\n') ? 1 : 0) : 0, removed: 0 };
  }
  const diff = await api.git.diff(path, false).catch(() => null);
  if (diff == null) return null;
  let added = 0, removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line[0] === '+') added++;
    else if (line[0] === '-') removed++;
  }
  return { added, removed };
}
async function fillEditCounts(el: HTMLElement, files: string[], tab: AgentTabState): Promise<void> {
  const st = await api.git.status().catch(() => null);
  if (!st?.repo) return;
  const untracked = new Set((st.files ?? []).filter(f => f.x === '?' || f.y === '?').map(f => f.path));
  const counts = await Promise.all(files.map(f => lineCounts(f, untracked.has(f))));
  const total = { added: 0, removed: 0 };
  counts.forEach((c, i) => {
    if (!c) return;
    total.added += c.added;
    total.removed += c.removed;
    const n = el.querySelector<HTMLElement>(`[data-edit-file="${CSS.escape(files[i])}"] [data-n]`);
    if (n) n.innerHTML = countHtml(c);
  });
  const t = el.querySelector<HTMLElement>('[data-total]');
  if (t && counts.some(Boolean)) t.innerHTML = countHtml(total);
  saveChat(tab);
}
// Delegated, so the line still opens and closes in a chat brought back from history.
document.addEventListener('click', e => {
  const t = e.target as HTMLElement;
  const view = t.closest<HTMLElement>('.run-edits .re-view');
  if (view) {
    const open = view.closest('.run-edits')!.classList.toggle('open');
    view.setAttribute('aria-expanded', String(open));
    return;
  }
  const failed = t.closest<HTMLElement>('[data-test-file]');
  if (failed && rootInfo) {
    if (surface.name === 'box') enterMode('ide');
    const line = Math.max(0, Number(failed.dataset.testLine) - 1); // the card counts from 1, the editor from 0
    openFile(failed.dataset.testFile as string, { line, col: 0 });
    return;
  }
  const file = t.closest<HTMLElement>('[data-edit-file]');
  if (file && rootInfo) {
    if (surface.name === 'box') enterMode('ide');
    openFile(file.dataset.editFile as string);
  }
});

function showPlan(r: Run, tab: AgentTabState): void {
  const plan = (r.plan || r.lastText).trim();
  if (!plan) { setAgent('planner', 'done', 'Answered', r.tools); return; }
  setAgent('planner', 'waiting', 'Waiting for plan approval', r.tools);
  sfx.play('plan');
  const el = addMsg(`<div class="card plan"><h5>${svgIcon('todo', 14)} Plan</h5><div class="plan-body">${md(plan)}</div><div class="row" data-live><button class="btn btn-primary btn-sm" data-plan="ok">Approve &amp; build</button><button class="btn btn-sm" data-plan="edit">Change something</button></div></div>`, tab);
  $$('[data-plan]', el).forEach(b => b.onclick = () => {
    const ok = b.dataset.plan === 'ok';
    $('[data-live]', el).outerHTML = `<div class="resolved">${ok ? '✓ Approved' : '✎ Asked for changes'}</div>`;
    saveChat(tab);
    if (ok) {
      sfx.play('approve');
      setAgent('planner', 'done', 'Plan handed off', r.tools);
      addMsg('<div class="handoff">Planner → Builder</div>', tab);
      void startAgentRun(r.agent, 'build', 'The plan is approved. Implement it now, then summarize what you changed.', 'build', tab);
    } else {
      setAgent('planner', 'idle', 'Waiting for your changes', r.tools);
      const s = SURFACES[tab.surfaceName];
      s.prompt.focus();
      s.prompt.placeholder = 'What should change in the plan?';
    }
  });
}

function finishRun(r: Run, ev: AgentEvent, tab: AgentTabState): void {
  if (tab.agentTeam?.runs.has(r.id)) { finishTeamMember(r, ev, tab, tab.agentTeam); return; }
  tab.runId = null;
  tab.run = null;
  if (agentRun?.id === r.id) agentRun = null;
  hideThinking(tab);

  const s = SURFACES[tab.surfaceName];
  if (tab.id === activeTabId[tab.surfaceName]) {
    updateTabBusyState(s, tab);
  }
  renderAgentTabs(s);

  for (const k of Object.keys(locks)) delete locks[k];
  renderTree(); renderTabs();
  lastRunFiles = [...r.files];
  queueGitRefresh();

  const allDone = !hasAnyActiveRun();
  if (ev.stopped) {
    addMsg('<div class="handoff">Stopped by you</div>', tab);
    setAgent(r.phase, 'idle', 'Stopped', r.tools);
    if (allDone) vibeDone(false);
    return;
  }
  if (!ev.ok) {
    setAgent(r.phase, 'idle', 'Stopped with an error', r.tools);
    if (allDone) vibeDone(false);
    return;
  }
  if (r.uiMode === 'plan' && r.mode === 'plan') {
    showPlan(r, tab);
    if (allDone) vibeDone(true, true);
    return;
  }
  const changed = r.files.size ? `Changed ${plural(r.files.size, 'file')}` : 'Answered';
  setAgent(r.phase, 'done', changed, r.tools);
  sfx.play('success');
  if (allDone) vibeDone(true);

  const bits = runSummary(r, ev);
  const summary = bits.length ? ' · ' + bits.join(' · ') : '';
  if (r.files.size) {
    const files = [...r.files];
    const edits = addMsg(editsHtml(files, r.commands ?? 0), tab);
    background(fillEditCounts(edits, files, tab));
  }
  addMsg(`<div class="run-done"><span>✓ Done${summary}</span></div>`, tab);
  if (!isBoardSurface(s.name)) s.prompt.placeholder = s.name === 'box' ? 'Ask Breeze anything' : ' '; // a board box keeps its own
  if (r.files.size && running) autoReloadPreview();
}

