/* ================= Conflict compare page ================= */
// Resolving a pull request's conflicts without leaving Breeze. Main merges the base branch into the pull request in a
// separate worktree (main/prconflict.js), so the open folder is never touched; this page lists the conflicted files and,
// for the one picked, shows our side (the pull request) and their side (the base branch) next to the result, which is the
// file's text with its conflict markers and can be edited by hand. Committing sends the result back and pushes it.
// Text and logic live in conflictcore.ts (parseConflicts, applyChoice, hasMarkers).

type CfFile = {
  path: string; ours: string | null; theirs: string | null;
  binary: boolean;                    // not UTF-8 text: never shown or edited, only kept from one side or deleted
  hasOurs: boolean; hasTheirs: boolean;
  text: string;                       // the result, for a text file both sides have
  pick: 'keep' | 'delete' | null;     // for a text file one side deleted; null until chosen
  bin: 'ours' | 'theirs' | 'delete' | null; // for a binary file; null until chosen
  cur: number;                        // the conflict being looked at
  crlf: boolean;                      // the file has CRLF line breaks, which the textarea hides
};
const CF_ENDED = 'This conflict session has ended';
// Bumped when the folder changes: a conflict page from before is over, whatever it was doing.
let cfWorkspaceGen = 0;
let cfOpenPage: { end(): void } | null = null;
function endConflictPage(): void {
  cfWorkspaceGen++;
  const page = cfOpenPage;
  cfOpenPage = null;
  page?.end();
}

// The Duel on one conflict: the agent argues for ours, then for theirs, then judges. One card each.
type DuelCard = { state: 'wait' | 'run' | 'done' | 'fail'; text: string };
type Duel = { file: CfFile; agent: string; ours: DuelCard; theirs: DuelCard; judge: DuelCard; note: string; running: boolean };
// The judge's merge, put into the file's text but not yet accepted: where it sits, and the text before it (what Reject restores).
type Proposal = { file: CfFile; start: number; end: number; prev: string };
const NO_ARGUMENT = '(no argument)';

// A text file one side deleted has no markers to resolve: keep it or delete it.
const cfOneSided = (f: CfFile): boolean => !f.binary && (f.ours === null || f.theirs === null);
const cfSurvivor = (f: CfFile): string => f.ours ?? f.theirs ?? '';
const cfResolved = (f: CfFile): boolean => (f.binary ? f.bin !== null : cfOneSided(f) ? f.pick !== null : !hasMarkers(f.text));
const cfResult = (f: CfFile): ConflictResult => (f.binary
  ? { path: f.path, choice: f.bin ?? 'ours' } // only sent once every file is resolved, so bin is set by then
  : { path: f.path, text: cfOneSided(f) ? (f.pick === 'keep' ? cfSurvivor(f) : null) : f.text });
// What is still to resolve in a file: its conflict blocks, or 1 for a file to keep or delete that isn't decided yet.
const cfLeft = (f: CfFile): number => (f.binary ? (f.bin === null ? 1 : 0) : cfOneSided(f) ? (f.pick === null ? 1 : 0) : parseConflicts(f.text).length);

async function openConflictPage(pr: GhPull): Promise<void> {
  const n = pr.number;
  const wsGen = cfWorkspaceGen; // a folder switch ends this page
  const mine = (): boolean => wsGen === cfWorkspaceGen && !!document.querySelector(`#scmDetail .cf-view[data-n="${n}"]`);
  const shell = (inner: string): string => `<div class="pr-view cf-view" data-n="${n}">${inner}</div>`;
  const back = (): void => { void openPr(n); };
  const fail = (text: string): void => {
    showScmDetail(shell(`<div class="pr-loading pr-fail"><p>${esc(text)}</p><button class="btn btn-sm" data-cf="back">Back to pull request</button></div>`));
    ($('#scmDetail .cf-view') as HTMLElement).onclick = e => { if ((e.target as HTMLElement).closest('[data-cf="back"]')) back(); };
  };
  if (pr.head.repo === null) { fail('The source repository no longer exists'); return; }
  showScmDetail(shell(`<div class="pr-loading"><div class="spinner sm"></div>Preparing the merge of ${esc(pr.base)} into #${n}</div>`));
  let session: ConflictSession;
  try {
    session = await api.git.prConflictStart(n); // main asks GitHub for the branches and where to push
  } catch (e) {
    if (mine()) fail(errMsg(e) || 'Couldn\'t prepare the merge');
    return;
  }
  if (!mine()) { api.git.prConflictAbort(session.id).catch(() => {}); return; } // the right side moved on while it was preparing

  const files: CfFile[] = session.files.map(f => {
    const text = f.merged ?? '';
    return { path: f.path, ours: f.ours, theirs: f.theirs, binary: f.kind === 'binary', hasOurs: f.hasOurs, hasTheirs: f.hasTheirs, text, pick: null, bin: null, cur: 0, crlf: text.includes('\r\n') };
  });
  let sel = 0;
  let busy = false;       // committing or cancelling
  let pushFailed = false; // the resolution is committed in the worktree, only the push is left
  let ended = false;      // main no longer knows this session
  let duel: Duel | null = null;         // the latest Duel, running or finished
  let proposal: Proposal | null = null; // the judge's merge waiting for Accept or Reject
  const view = $('#scmDetail .cf-view');
  // Late results are dropped once the page is left (a new page for the same pull request is a different view) or the session is over.
  const alive = (): boolean => mine() && view.isConnected && !ended;
  const ours = session.headRef, theirs = session.base;
  // The folder changed: nothing more is done with this session from here (a commit already in flight finishes on its own).
  cfOpenPage = { end: (): void => {
    if (ended) return;
    ended = true;
    if (!busy) api.git.prConflictAbort(session.id).catch(() => {});
  } };

  const note = (text: string): void => { $('#cfNote', view).textContent = text; };
  const file = (): CfFile => files[sel];
  const unresolved = (): number => files.filter(f => !cfResolved(f)).length;

  const head = (): string => `<div class="pr-head cf-head">
      <div class="pr-title"><h3>Resolve conflicts</h3><span class="pr-n">#${n}</span></div>
      <div class="pr-meta"><span>Merging ${esc(theirs)} into ${esc(ours)}</span></div>
      <div class="pr-actions"><button class="btn btn-sm" data-cf="cancel">Cancel</button>${session.clean ? '' : '<button class="btn btn-primary btn-sm" data-cf="commit" disabled>Commit resolution</button>'}</div>
      <div class="pr-merge-note cf-note" id="cfNote" role="alert"></div>
    </div>`;

  const paintHeader = (): void => {
    const commit = view.querySelector<HTMLButtonElement>('[data-cf="commit"]');
    const left = unresolved();
    if (commit) {
      commit.textContent = busy ? (pushFailed ? 'Pushing…' : 'Committing…') : pushFailed ? 'Retry push' : 'Commit resolution';
      commit.disabled = busy || ended || left > 0;
      commit.title = left > 0 ? `${plural(left, 'file')} still to resolve` : '';
    }
    view.querySelector<HTMLButtonElement>('[data-cf="cancel"]')!.disabled = busy;
  };

  const paintFiles = (): void => {
    $('#cfFiles', view).innerHTML = files.map((f, i) => {
      const done = cfResolved(f), left = cfLeft(f);
      return `<button class="cf-file ${i === sel ? 'on' : ''} ${done ? 'done' : ''}" data-i="${i}" title="${escAttr(f.path)}"><span class="cf-ck" aria-hidden="true">${done ? svgIcon('check', 12) : ''}</span><span class="ico">${fileIcon(f.path)}</span><span class="cf-fname">${esc(f.path)}</span><span class="cf-left"${done ? ' aria-label="Resolved"' : ''}>${done ? '' : left}</span></button>`;
    }).join('');
  };

  // The conflict being looked at: its two sides, the counter, and which buttons work.
  const paintBlock = (): void => {
    const f = file();
    if (f.binary || cfOneSided(f)) return;
    const blocks = parseConflicts(f.text);
    f.cur = blocks.length ? clamp(f.cur, 0, blocks.length - 1) : 0;
    const b = blocks[f.cur];
    $('#cfOurs', view).textContent = b ? b.ours : '';
    $('#cfTheirs', view).textContent = b ? b.theirs : '';
    for (const id of ['cfOurs', 'cfTheirs']) $('#' + id, view).classList.toggle('empty', !b);
    $('#cfCount', view).textContent = b ? `${f.cur + 1} of ${blocks.length} left` : hasMarkers(f.text) ? 'Conflict markers left in the result' : 'No conflicts left';
    view.querySelectorAll<HTMLButtonElement>('[data-cf-use], [data-cf-step]').forEach(btn => { btn.disabled = !b || pushFailed || busy; });
    view.querySelectorAll<HTMLButtonElement>('[data-cf-step]').forEach(btn => { btn.disabled = blocks.length < 2; });
    const duelBtn = view.querySelector<HTMLButtonElement>('[data-cf-use="duel"]');
    if (duelBtn) { // one Duel at a time
      const running = !!duel?.running;
      duelBtn.disabled = !b || pushFailed || busy || running;
      duelBtn.title = running ? 'A duel is running' : 'Have your AI agent argue both sides and propose a merge';
    }
    $('#cfText', view).classList.toggle('bad', hasMarkers(f.text));
    $('#cfText', view).classList.toggle('proposed', proposal?.file === f);
  };

  // Brings the textarea to the conflict being looked at.
  const scrollToBlock = (): void => {
    const f = file(), ta = $<HTMLTextAreaElement>('#cfText', view);
    const b = parseConflicts(f.text)[f.cur];
    if (!b) return;
    const line = f.text.slice(0, b.start).split('\n').length - 1;
    const lh = Number.parseFloat(getComputedStyle(ta).lineHeight) || 18;
    ta.scrollTop = Math.max(0, (line - 2) * lh);
  };

  const mainHtml = (): string => {
    const f = file();
    const copy = pushFailed && !f.binary && !(cfOneSided(f) && f.pick !== 'keep') ? '<button class="btn btn-sm" data-cf="copy">Copy resolved file</button>' : '';
    const pane = (title: string, sub: string, body: string): string =>
      `<section class="cf-pane"><header><b>${title}</b><small>${esc(sub)}</small></header>${body}</section>`;
    if (f.binary) {
      const off = pushFailed || busy;
      const btn = (choice: 'ours' | 'theirs' | 'delete', label: string, has: boolean): string =>
        `<button class="btn btn-sm" data-cf-bin="${choice}" aria-pressed="${f.bin === choice}"${off || !has ? ' disabled' : ''}${has ? '' : ' title="This side deleted the file"'}>${label}</button>`;
      const state = f.bin === 'ours' ? `Keeping the version from ${ours}` : f.bin === 'theirs' ? `Keeping the version from ${theirs}` : f.bin === 'delete' ? 'The file will be deleted' : 'Keep one side or delete the file';
      const side = (has: boolean): string => `<div class="cf-gone">${has ? 'Not a text file, so it isn\'t shown' : 'Deleted in this branch'}</div>`;
      return `<div class="cf-bar"><span class="cf-path">${esc(f.path)}</span><span class="cf-count">${esc(state)}</span>
        <span class="cf-acts">${btn('ours', 'Keep ours', f.hasOurs)}${btn('theirs', 'Keep theirs', f.hasTheirs)}${btn('delete', 'Delete file', true)}</span></div>
        <div class="cf-panes">${pane('Ours', ours, side(f.hasOurs))}${pane('Theirs', theirs, side(f.hasTheirs))}${pane('Result', '', '<div class="cf-gone">This file can\'t be merged here</div>')}</div>`;
    }
    if (cfOneSided(f)) {
      const side = (text: string | null): string => (text === null ? '<div class="cf-gone">Deleted in this branch</div>' : `<pre class="cf-code">${esc(text)}</pre>`);
      const state = f.pick === 'keep' ? 'The file is kept' : f.pick === 'delete' ? 'The file will be deleted' : 'Keep this file or delete it';
      const resBody = f.pick === 'keep' ? `<pre class="cf-code">${esc(cfSurvivor(f))}</pre>` : `<div class="cf-gone">${state}</div>`;
      return `<div class="cf-bar"><span class="cf-path">${esc(f.path)}</span><span class="cf-count">${esc(state)}</span>
        <span class="cf-acts"><button class="btn btn-sm" data-cf-pick="keep" aria-pressed="${f.pick === 'keep'}"${pushFailed || busy ? ' disabled' : ''}>Keep file</button><button class="btn btn-sm" data-cf-pick="delete" aria-pressed="${f.pick === 'delete'}"${pushFailed || busy ? ' disabled' : ''}>Delete file</button>${copy}</span></div>
        <div class="cf-panes">${pane('Ours', ours, side(f.ours))}${pane('Theirs', theirs, side(f.theirs))}${pane('Result', '', resBody)}</div>`;
    }
    return `<div class="cf-bar"><span class="cf-path">${esc(f.path)}</span><span class="cf-count" id="cfCount"></span>
        <span class="cf-acts"><button class="icon-btn" data-cf-step="-1" title="Previous conflict" aria-label="Previous conflict">${svgIcon('chevronLeft', 14)}</button><button class="icon-btn" data-cf-step="1" title="Next conflict" aria-label="Next conflict">${svgIcon('chevronRight', 14)}</button>
        <button class="btn btn-sm" data-cf-use="ours">Use ours</button><button class="btn btn-sm" data-cf-use="theirs">Use theirs</button><button class="btn btn-sm" data-cf-use="both">Use both</button><button class="btn btn-sm" data-cf-use="duel">Duel</button>${copy}</span></div>
      <div class="cf-duel" id="cfDuel" aria-live="polite"></div>
      <div class="cf-panes">${pane('Ours', ours, '<pre class="cf-code" id="cfOurs"></pre>')}${pane('Theirs', theirs, '<pre class="cf-code" id="cfTheirs"></pre>')}${pane('Result', 'edit freely', `<div class="cf-proposal" id="cfProposal"></div><textarea class="cf-text" id="cfText" spellcheck="false" wrap="off" aria-label="Result for ${escAttr(f.path)}"${pushFailed ? ' readonly' : ''}></textarea>`)}</div>`;
  };

  const paintMain = (): void => {
    $('#cfMain', view).innerHTML = mainHtml();
    const f = file();
    if (!f.binary && !cfOneSided(f)) { $<HTMLTextAreaElement>('#cfText', view).value = f.text; paintBlock(); paintDuel(); paintProposal(); scrollToBlock(); }
  };
  const paintAll = (): void => {
    paintHeader();
    if (session.clean) {
      const push = view.querySelector<HTMLButtonElement>('[data-cf="push"]');
      if (push) { push.textContent = busy ? 'Pushing…' : pushFailed ? 'Retry push' : 'Push merge'; push.disabled = busy || ended; }
      return;
    }
    paintFiles(); paintMain();
  };
  // After something changed in the file being edited: not the textarea itself, which would lose the caret.
  const paintState = (): void => { paintHeader(); paintFiles(); paintBlock(); };

  const finish = async (): Promise<void> => {
    if (busy || ended) return;
    proposal = null; // committing keeps what the result says
    busy = true; note(''); paintAll();
    let res: ConflictFinish;
    try {
      res = await api.git.prConflictFinish(session.id, files.map(cfResult));
    } catch (e) {
      // The session is gone, or main refused the resolution: nothing was committed.
      busy = false;
      const msg = errMsg(e);
      if (msg.includes(CF_ENDED)) ended = true;
      if (mine()) { note(msg || 'Couldn\'t commit the resolution'); paintAll(); }
      return;
    }
    busy = false;
    if (!res.ok) {
      // Only a failed push leaves the resolution committed; after a failed commit the page stays as it was, to change and try again.
      if (res.stage === 'push') pushFailed = true;
      if (mine()) {
        note(res.stage === 'push'
          ? `${res.message || 'Couldn\'t push'}. ${session.clean ? 'The merge is committed locally; retry the push' : 'Your resolution is committed locally; retry the push or copy the files'}`
          : `Couldn't commit the resolution: ${res.message || 'git failed'}`);
        paintAll();
      }
      return;
    }
    ended = true; // main has removed the session
    toast('Conflicts resolved and pushed');
    void refreshPrs(true);
    if (mine()) back();
  };

  const cancel = async (): Promise<void> => {
    if (busy) return;
    busy = true; paintHeader();
    await api.git.prConflictAbort(session.id).catch(() => {}); // already gone is as good as aborted
    if (mine()) back();
  };

  // ----- Duel -----
  const cardHtml = (title: string, c: DuelCard, extra = ''): string => {
    const body = c.state === 'wait' ? '<div class="cf-card-dim">Waiting</div>'
      : c.state === 'run' ? '<div class="cf-card-dim">Thinking</div>'
      : c.state === 'fail' ? `<div class="cf-card-text cf-card-err">${esc(c.text)}</div>` // agent output is text, never markup
      : `<div class="cf-card-text">${esc(c.text)}</div>`;
    return `<section class="cf-card ${c.state}"><header><b>${title}</b>${c.state === 'run' ? '<span class="spinner sm" role="status" aria-label="Working"></span>' : ''}</header>${body}${extra}</section>`;
  };
  const paintDuel = (): void => {
    const box = view.querySelector<HTMLElement>('#cfDuel');
    if (!box) return;
    if (!duel || duel.file !== file()) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="cf-duel-head"><b>Duel</b><small>${esc(duel.agent)}</small>${duel.running ? '' : '<button class="btn btn-sm btn-ghost" data-cf-duel="close">Close</button>'}</div>
      <div class="cf-cards">${cardHtml('Ours', duel.ours)}${cardHtml('Theirs', duel.theirs)}${cardHtml('Verdict', duel.judge, duel.note ? `<div class="cf-card-dim">${esc(duel.note)}</div>` : '')}</div>`;
  };

  // The line (0-based) a position in the file's text is on, and the position in the textarea, which reads LF.
  const taPos = (text: string, pos: number): number => text.slice(0, pos).replace(/\r\n?/g, '\n').length;
  const lineOf = (text: string, pos: number): number => text.slice(0, pos).split('\n').length - 1;
  const paintProposal = (): void => {
    const box = view.querySelector<HTMLElement>('#cfProposal');
    if (!box) return;
    const p = proposal;
    if (!p || p.file !== file()) { box.innerHTML = ''; box.classList.remove('on'); return; }
    const from = lineOf(p.file.text, p.start) + 1, to = lineOf(p.file.text, p.end - (p.end > p.start ? 1 : 0)) + 1;
    const where = p.end === p.start ? 'removes this conflict' : from === to ? `line ${from}` : `lines ${from}–${to}`;
    box.classList.add('on');
    box.innerHTML = `<span class="cf-prop-tag">Proposed</span><span class="cf-prop-text">The judge's merge, ${where}</span>
      <span class="cf-prop-acts"><button class="btn btn-sm btn-primary" data-cf-prop="accept">Accept</button><button class="btn btn-sm" data-cf-prop="edit">Edit</button><button class="btn btn-sm" data-cf-prop="reject">Reject</button></span>`;
  };
  // Keeps the proposal as it is in Result; from here it is an ordinary part of the text.
  const acceptProposal = (): void => {
    if (!proposal) return;
    proposal = null;
    paintProposal();
    view.querySelector('#cfText')?.classList.remove('proposed');
  };
  const rejectProposal = (): void => {
    const p = proposal;
    if (!p) return;
    proposal = null;
    p.file.text = p.prev; // the exact text from before the proposal
    if (p.file === file()) { $<HTMLTextAreaElement>('#cfText', view).value = p.file.text; paintProposal(); paintState(); scrollToBlock(); }
  };
  const editProposal = (): void => {
    const p = proposal, ta = view.querySelector<HTMLTextAreaElement>('#cfText');
    if (!p || !ta || p.file !== file()) return;
    const lh = Number.parseFloat(getComputedStyle(ta).lineHeight) || 18;
    ta.focus();
    ta.setSelectionRange(taPos(p.file.text, p.start), taPos(p.file.text, p.start)); // typing doesn't replace the merge; it counts as accepting it
    ta.scrollTop = Math.max(0, (lineOf(p.file.text, p.start) - 2) * lh);
  };

  const runDuel = async (): Promise<void> => {
    if (duel?.running) return;
    const agent = currentActiveAgent();
    if (!agent) { openAgentPicker(); return; }
    const model = chosenModelFor(agent); // the user's own model for this agent, as the commit message writer uses
    const f = file();
    const b = parseConflicts(f.text)[f.cur];
    if (!b) return;
    if (proposal?.file === f) acceptProposal(); // a new Duel moves on from the last proposal
    const lf = (s: string): string => s.replace(/\r\n/g, '\n');
    const around = blockContext(f.text, b);
    const prompts = duelPrompts({ path: f.path, before: lf(around.before), ours: lf(b.ours), theirs: lf(b.theirs), after: lf(around.after) });
    const d: Duel = { file: f, agent: agent.name, ours: { state: 'wait', text: '' }, theirs: { state: 'wait', text: '' }, judge: { state: 'wait', text: '' }, note: '', running: true };
    duel = d;
    const repaint = (): void => { if (duel === d && alive()) { paintDuel(); paintBlock(); } };
    // One call to the agent into its card; the reply, or '' when it failed (the card shows why).
    const ask = async (card: DuelCard, prompt: string): Promise<string | null> => {
      card.state = 'run'; repaint();
      let reply: string, failed = '';
      try { reply = await api.agent.ask({ agent: agent.id, prompt, model }); } catch (e) { reply = ''; failed = errMsg(e) || 'The agent didn\'t answer'; }
      if (!alive()) return null; // the page was left or the session ended
      if (failed) { card.state = 'fail'; card.text = failed; } else { card.state = 'done'; card.text = reply; }
      repaint();
      return failed ? '' : reply;
    };
    repaint();
    const oursReply = await ask(d.ours, prompts.ours);
    if (oursReply === null) return;
    const theirsReply = await ask(d.theirs, prompts.theirs);
    if (theirsReply === null) return;
    const verdict = await ask(d.judge, prompts.judge(oursReply || NO_ARGUMENT, theirsReply || NO_ARGUMENT));
    if (verdict === null) return;
    d.running = false;
    if (d.judge.state === 'done') propose(d, verdict, b);
    repaint();
  };

  // Puts the judge's block where the conflict was, if it is still there as it was when the Duel started.
  const propose = (d: Duel, reply: string, was: ConflictBlock): void => {
    const code = extractCodeBlock(reply);
    if (code === null) { d.note = 'The judge didn\'t propose a merge'; return; }
    d.judge.text = withoutCodeBlock(reply) || 'The judge proposed a merge.';
    // The resolution is being committed or was already: the result must not change under it.
    if (busy || pushFailed) { d.note = 'The resolution was committed meanwhile, so the merge wasn\'t applied'; return; }
    const f = d.file;
    const blocks = parseConflicts(f.text).filter(x => x.ours === was.ours && x.theirs === was.theirs);
    const b = blocks.find(x => x.start === was.start) ?? blocks[0];
    if (!b) { d.note = 'This conflict changed while the judge was working, so the merge wasn\'t applied'; return; }
    // The block is whole lines, so the merge is too (unless the file ends right after the closing marker).
    const custom = code === '' || !/\n$/.test(f.text.slice(b.start, b.end)) ? code : code + '\n';
    const eol = (s: string): string => withEol(s, f.crlf);
    const start = eol(f.text.slice(0, b.start)).length;
    const prev = f.text;
    f.text = eol(applyChoice(f.text, b, { custom }));
    proposal = { file: f, start, end: start + eol(custom).length, prev };
    if (f === file()) { $<HTMLTextAreaElement>('#cfText', view).value = f.text; paintHeader(); paintFiles(); paintProposal(); scrollToProposal(); }
  };
  const scrollToProposal = (): void => {
    const p = proposal, ta = view.querySelector<HTMLTextAreaElement>('#cfText');
    if (!p || !ta) return;
    const lh = Number.parseFloat(getComputedStyle(ta).lineHeight) || 18;
    ta.scrollTop = Math.max(0, (lineOf(p.file.text, p.start) - 2) * lh);
  };

  const use = (choice: 'ours' | 'theirs' | 'both'): void => {
    const f = file();
    const b = parseConflicts(f.text)[f.cur];
    if (!b) return;
    if (proposal?.file === f) acceptProposal(); // choosing for another conflict keeps the proposal
    f.text = applyChoice(f.text, b, choice);
    $<HTMLTextAreaElement>('#cfText', view).value = f.text;
    paintState();
    scrollToBlock();
  };

  view.onclick = e => {
    const t = e.target as HTMLElement;
    const fileBtn = t.closest<HTMLElement>('.cf-file');
    if (fileBtn) { sel = Number(fileBtn.dataset.i); paintFiles(); paintMain(); return; }
    const useBtn = t.closest<HTMLElement>('[data-cf-use]');
    if (useBtn) { if (useBtn.dataset.cfUse === 'duel') void runDuel(); else use(useBtn.dataset.cfUse as 'ours' | 'theirs' | 'both'); return; }
    const prop = t.closest<HTMLElement>('[data-cf-prop]')?.dataset.cfProp;
    if (prop) { if (prop === 'accept') acceptProposal(); else if (prop === 'reject') rejectProposal(); else editProposal(); return; }
    if (t.closest('[data-cf-duel="close"]')) { if (!duel?.running) { duel = null; paintDuel(); paintBlock(); } return; }
    const step = t.closest<HTMLElement>('[data-cf-step]');
    if (step) {
      const f = file(), count = parseConflicts(f.text).length;
      if (count > 1) { f.cur = (f.cur + Number(step.dataset.cfStep) + count) % count; paintBlock(); scrollToBlock(); }
      return;
    }
    const binBtn = t.closest<HTMLButtonElement>('[data-cf-bin]');
    if (binBtn) {
      if (!binBtn.disabled && file().binary) { file().bin = binBtn.dataset.cfBin as 'ours' | 'theirs' | 'delete'; paintHeader(); paintFiles(); paintMain(); }
      return;
    }
    const pick = t.closest<HTMLElement>('[data-cf-pick]');
    if (pick) { file().pick = pick.dataset.cfPick as 'keep' | 'delete'; paintHeader(); paintFiles(); paintMain(); return; }
    const act = t.closest<HTMLElement>('[data-cf]')?.dataset.cf;
    if (act === 'commit' || act === 'push') void finish();
    else if (act === 'cancel') void cancel();
    else if (act === 'copy') {
      const r = cfResult(file());
      const text = 'text' in r ? r.text : null;
      if (text !== null) background(navigator.clipboard.writeText(text).then(() => toast('File copied')));
    }
  };
  // Editing the result: the file's counter, its tick and the Commit button follow.
  view.oninput = e => {
    if ((e.target as HTMLElement).id !== 'cfText') return;
    file().text = withEol((e.target as HTMLTextAreaElement).value, file().crlf); // the textarea reads LF
    if (proposal?.file === file()) acceptProposal(); // editing the result while a merge is proposed keeps it
    paintState();
  };

  if (session.clean) {
    view.innerHTML = `${head()}<div class="pr-conflict cf-clean"><h4>No conflicts after all</h4><p>${esc(theirs)} merges into ${esc(ours)} cleanly. Push the merge to update the pull request.</p>
      <button class="btn btn-primary btn-sm" data-cf="push">Push merge</button></div>`;
    paintHeader();
    return;
  }
  view.innerHTML = `${head()}<div class="cf-files" id="cfFiles" role="tablist"></div><div class="cf-main" id="cfMain"></div>`;
  paintAll();
}
