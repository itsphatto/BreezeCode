/* ================= Conflict compare page ================= */
// Resolving a pull request's conflicts without leaving Breeze. Main merges the base branch into the pull request in a
// separate worktree (main/prconflict.js), so the open folder is never touched; this page lists the conflicted files and,
// for the one picked, shows our side (the pull request) and their side (the base branch) next to the result, which is the
// file's text with its conflict markers and can be edited by hand. Committing sends the result back and pushes it.
// Text and logic live in conflictcore.ts (parseConflicts, applyChoice, hasMarkers).

type CfFile = {
  path: string; ours: string | null; theirs: string | null;
  text: string;                       // the result, for a file both sides have
  pick: 'keep' | 'delete' | null;     // for a file one side deleted; null until chosen
  cur: number;                        // the conflict being looked at
  crlf: boolean;                      // the file has CRLF line breaks, which the textarea hides
};
const CF_ENDED = 'This conflict session has ended';

// A file one side deleted has no markers to resolve: keep it or delete it.
const cfOneSided = (f: CfFile): boolean => f.ours === null || f.theirs === null;
const cfSurvivor = (f: CfFile): string => f.ours ?? f.theirs ?? '';
const cfResolved = (f: CfFile): boolean => (cfOneSided(f) ? f.pick !== null : !hasMarkers(f.text));
const cfResult = (f: CfFile): { path: string; text: string | null } =>
  ({ path: f.path, text: cfOneSided(f) ? (f.pick === 'keep' ? cfSurvivor(f) : null) : f.text });
// What is still to resolve in a file: its conflict blocks, or 1 for a deleted file not yet decided.
const cfLeft = (f: CfFile): number => (cfOneSided(f) ? (f.pick === null ? 1 : 0) : parseConflicts(f.text).length);

async function openConflictPage(pr: GhPull): Promise<void> {
  const n = pr.number;
  const mine = (): boolean => !!document.querySelector(`#scmDetail .cf-view[data-n="${n}"]`);
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
    session = await api.git.prConflictStart(n, pr.base, pr.head.ref, pr.head.repo);
  } catch (e) {
    if (mine()) fail(errMsg(e) || 'Couldn\'t prepare the merge');
    return;
  }
  if (!mine()) { api.git.prConflictAbort(session.id).catch(() => {}); return; } // the right side moved on while it was preparing

  const files: CfFile[] = session.files.map(f => ({ path: f.path, ours: f.ours, theirs: f.theirs, text: f.merged, pick: null, cur: 0, crlf: f.merged.includes('\r\n') }));
  let sel = 0;
  let busy = false;       // committing or cancelling
  let pushFailed = false; // the resolution is committed in the worktree, only the push is left
  let ended = false;      // main no longer knows this session
  const view = $('#scmDetail .cf-view');
  const ours = session.headRef, theirs = session.base;

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
    if (cfOneSided(f)) return;
    const blocks = parseConflicts(f.text);
    f.cur = blocks.length ? clamp(f.cur, 0, blocks.length - 1) : 0;
    const b = blocks[f.cur];
    $('#cfOurs', view).textContent = b ? b.ours : '';
    $('#cfTheirs', view).textContent = b ? b.theirs : '';
    for (const id of ['cfOurs', 'cfTheirs']) $('#' + id, view).classList.toggle('empty', !b);
    $('#cfCount', view).textContent = b ? `${f.cur + 1} of ${blocks.length} left` : hasMarkers(f.text) ? 'Conflict markers left in the result' : 'No conflicts left';
    view.querySelectorAll<HTMLButtonElement>('[data-cf-use], [data-cf-step]').forEach(btn => { btn.disabled = !b || pushFailed || busy; });
    view.querySelectorAll<HTMLButtonElement>('[data-cf-step]').forEach(btn => { btn.disabled = blocks.length < 2; });
    $('#cfText', view).classList.toggle('bad', hasMarkers(f.text));
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
    const copy = pushFailed && !(cfOneSided(f) && f.pick !== 'keep') ? '<button class="btn btn-sm" data-cf="copy">Copy resolved file</button>' : '';
    const pane = (title: string, sub: string, body: string): string =>
      `<section class="cf-pane"><header><b>${title}</b><small>${esc(sub)}</small></header>${body}</section>`;
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
        <button class="btn btn-sm" data-cf-use="ours">Use ours</button><button class="btn btn-sm" data-cf-use="theirs">Use theirs</button><button class="btn btn-sm" data-cf-use="both">Use both</button><button class="btn btn-sm" data-cf-use="duel" disabled title="Coming soon">Duel</button>${copy}</span></div>
      <div class="cf-panes">${pane('Ours', ours, '<pre class="cf-code" id="cfOurs"></pre>')}${pane('Theirs', theirs, '<pre class="cf-code" id="cfTheirs"></pre>')}${pane('Result', 'edit freely', `<textarea class="cf-text" id="cfText" spellcheck="false" wrap="off" aria-label="Result for ${escAttr(f.path)}"${pushFailed ? ' readonly' : ''}></textarea>`)}</div>`;
  };

  const paintMain = (): void => {
    $('#cfMain', view).innerHTML = mainHtml();
    const f = file();
    if (!cfOneSided(f)) { $<HTMLTextAreaElement>('#cfText', view).value = f.text; paintBlock(); scrollToBlock(); }
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
    busy = true; note(''); paintAll();
    try {
      await api.git.prConflictFinish(session.id, files.map(cfResult));
    } catch (e) {
      busy = false;
      const msg = errMsg(e);
      if (msg.includes(CF_ENDED)) ended = true; else pushFailed = true;
      note(ended ? msg : `${msg || 'Couldn\'t push'}. ${session.clean ? 'The merge is committed locally; retry the push' : 'Your resolution is committed locally; retry the push or copy the files'}`);
      if (mine()) paintAll();
      return;
    }
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

  const use = (choice: 'ours' | 'theirs' | 'both'): void => {
    const f = file();
    const b = parseConflicts(f.text)[f.cur];
    if (!b) return;
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
    if (useBtn) { if (useBtn.dataset.cfUse !== 'duel') use(useBtn.dataset.cfUse as 'ours' | 'theirs' | 'both'); return; }
    const step = t.closest<HTMLElement>('[data-cf-step]');
    if (step) {
      const f = file(), count = parseConflicts(f.text).length;
      if (count > 1) { f.cur = (f.cur + Number(step.dataset.cfStep) + count) % count; paintBlock(); scrollToBlock(); }
      return;
    }
    const pick = t.closest<HTMLElement>('[data-cf-pick]');
    if (pick) { file().pick = pick.dataset.cfPick as 'keep' | 'delete'; paintHeader(); paintFiles(); paintMain(); return; }
    const act = t.closest<HTMLElement>('[data-cf]')?.dataset.cf;
    if (act === 'commit' || act === 'push') void finish();
    else if (act === 'cancel') void cancel();
    else if (act === 'copy') {
      const text = cfResult(file()).text;
      if (text !== null) background(navigator.clipboard.writeText(text).then(() => toast('File copied')));
    }
  };
  // Editing the result: the file's counter, its tick and the Commit button follow.
  view.oninput = e => {
    if ((e.target as HTMLElement).id !== 'cfText') return;
    file().text = withEol((e.target as HTMLTextAreaElement).value, file().crlf); // the textarea reads LF
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
