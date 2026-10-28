/* ================= Source control (git) ================= */
let gitState: GitStatus = { repo: false };
// False from opening a folder until its first git status arrives; the panel shows placeholders meanwhile.
let gitLoaded = false;
let gitLog: { head: string | null; commits: GitCommit[]; details?: GitCommitDetail[] } = { head: null, commits: [] };
let gitBusy = false;
let openCommit: string | null = null;
const commitDetails = new Map<string, GitCommitDetail>();
const scmCollapsed = new Set<string>(store.get<string[]>('breeze.scmCollapsed', []));
let gitTimer: TimeoutId | undefined;
function queueGitRefresh(): void { clearTimeout(gitTimer); gitTimer = setTimeout(() => void refreshGit(), 400); }
window.addEventListener('focus', () => { if (rootInfo) queueGitRefresh(); });

async function refreshGit(): Promise<void> {
  if (!rootInfo) { gitState = { repo: false }; gitLoaded = true; renderScm(); renderBranch(); return; }
  try {
    gitState = await api.git.status();
    gitLog = gitState.repo && gitState.hasCommits ? await api.git.log() : { head: null, commits: [], details: [] };
  } catch {
    gitState = { repo: false }; // git missing or not a repository: show the "initialize" panel
  }
  gitLoaded = true;
  if (gitLog.details?.length) {
    for (const d of gitLog.details) {
      commitDetails.set(d.hash, d);
    }
  }
  renderScm(); renderBranch(); renderTree(); renderTabs();
  if (gitLog.commits.length) {
    for (const c of gitLog.commits) {
      if (!commitDetails.has(c.hash)) {
        api.git.show(c.hash).then(d => {
          commitDetails.set(c.hash, d);
          if (openCommit === c.hash) placeCommitDetail(c.hash);
        }).catch(() => {});
      }
    }
  }
}
function renderBranch(): void {
  const s = gitState;
  const ahead = s.ahead ? ` ↑${s.ahead}` : '';
  const behind = s.behind ? ` ↓${s.behind}` : '';
  const branchLabel = s.repo ? esc((s.branch || 'main') + ahead + behind) : 'no repository';
  $('#sbBranch').innerHTML = `${svgIcon('gitBranch', 14)}<span>${branchLabel}</span>`;
  const n = s.files?.length ?? 0;
  const badge = $('.act-btn[data-view=git] .badge');
  badge.textContent = n > 99 ? '99+' : String(n || '');
  badge.classList.toggle('hidden', !n);
  renderPs();
}
// Explorer decorations: path -> status class, plus every folder that contains a change.
function gitDecor(): { files: Map<string, string>; dirs: Set<string>; ignored: Set<string>; incoming: Set<string>; incomingDirs: Set<string> } {
  const files = new Map<string, string>(), dirs = new Set<string>();
  const ignored = new Set<string>(gitState.ignored ?? []);
  for (const f of gitState.files ?? []) {
    files.set(f.path, statusOf(f).cls);
    for (let d = dirName(f.path); d; d = dirName(d)) dirs.add(d);
  }
  const incoming = new Set<string>(gitState.incoming ?? []), incomingDirs = new Set<string>();
  for (const p of incoming) for (let d = dirName(p); d; d = dirName(d)) incomingDirs.add(d);
  return { files, dirs, ignored, incoming, incomingDirs };
}
// Fetches quietly now and then, so files changed on the remote show M↓ before anyone pulls.
let lastFetch = 0;
function backgroundFetch(): void {
  if (!rootInfo || !gitState.repo || !gitState.upstream || Date.now() - lastFetch < 5 * 60_000) return;
  lastFetch = Date.now();
  api.git.sync('fetch').then(() => queueGitRefresh(), () => { /* offline or no access: try again later */ });
}
setInterval(backgroundFetch, 60_000);
const GIT_STATUS: Record<string, { letter: string; cls: string; title: string }> = {
  A: { letter: 'A', cls: 'git-a', title: 'Added' },
  D: { letter: 'D', cls: 'git-d', title: 'Deleted' },
  R: { letter: 'R', cls: 'git-m', title: 'Renamed' },
  U: { letter: '!', cls: 'git-d', title: 'Conflict' },
};
function statusOf(f: GitFile, staged = false): { letter: string; cls: string; title: string } {
  if (f.x === '?' || f.y === '?') return { letter: 'U', cls: 'git-u', title: 'Untracked' };
  let c = f.y;
  if (staged || f.y === ' ') c = f.x;
  return GIT_STATUS[c] ?? { letter: 'M', cls: 'git-m', title: 'Modified' };
}

function syncLabel(s: GitStatus): string {
  if (!s.hasRemote) return '';
  if (!s.upstream) return 'Publish Branch';
  const ahead = s.ahead ? ` ↑${s.ahead}` : '';
  if (s.behind) return `Sync ↓${s.behind}${ahead}`;
  return s.ahead ? `Push${ahead}` : '';
}
function scmRowHtml(f: GitFile, inStaged: boolean): string {
  const st = statusOf(f, inStaged);
  const enter = seenScm.has(f.path + inStaged) ? '' : ' enter';
  const discard = inStaged ? '' : `<button class="icon-btn" data-scm="discard" title="Discard Changes">${svgIcon('undo')}</button>`;
  const toggle = inStaged
    ? `<button class="icon-btn" data-scm="unstage" title="Unstage Changes">${svgIcon('minus')}</button>`
    : `<button class="icon-btn" data-scm="stage" title="Stage Changes">${svgIcon('plus')}</button>`;
  return `<div class="scm-row ${st.cls}${enter}" data-file="${escAttr(f.path)}" data-staged="${inStaged ? 1 : ''}" title="${escAttr(f.path)} · ${st.title}">
    <span class="ico">${fileIcon(baseName(f.path))}</span><span class="nm">${fileNameHtml(baseName(f.path))}</span><span class="dir">${esc(dirName(f.path))}</span>
    <span class="acts"><button class="icon-btn" data-scm="open" title="Open File">${svgIcon('external')}</button>${discard}${toggle}</span><span class="st">${st.letter}</span></div>`;
}
function scmSectionHtml(key: string, title: string, list: GitFile[], inStaged: boolean, acts: string): string {
  if (!list.length) return '';
  const rows = list.map(f => scmRowHtml(f, inStaged)).join('');
  return `<div class="scm-sec ${scmCollapsed.has(key) ? 'closed' : ''}" data-sec="${key}">
    <div class="scm-head"><span class="chev"><svg width="10" height="10"><use href="#i-chev"/></svg></span><span class="title">${title}</span><span class="acts">${acts}</span><span class="count">${list.length}</span></div>
    <div class="scm-list">${rows}</div></div>`;
}
function lowestModelFor(a: DetectedAgent): { model?: string } {
  if (a.id === 'antigravity') {
    const models = a.models ?? [];
    const low = models.find(m => /flash-low/i.test(m))
      || models.find(m => /flash-medium/i.test(m))
      || models.find(m => /flash/i.test(m))
      || models.at(-1);
    return { model: low || 'gemini-3.8-flash-low' };
  }
  if (a.id === 'codex') {
    const models = a.models ?? [];
    const low = models.find(m => /mini/i.test(m)) || models.at(-1);
    return { model: low || 'gpt-4o-mini' };
  }
  if (a.id === 'claude') return { model: 'haiku' };
  if (a.api) {
    const models = a.models ?? [];
    const low = models.find(m => /(1\.5b|3b|mini|small)/i.test(m)) || models[0];
    return { model: low || a.version || undefined };
  }
  return { model: a.models?.at(-1) };
}

function heuristicCommitMsg(files: GitFile[]): string {
  if (!files.length) return 'chore: update project';
  const names = files.map(f => baseName(f.path));
  const dirs = [...new Set(files.map(f => dirName(f.path)).filter(Boolean))];
  const scope = dirs.length === 1 ? `(${dirs[0].split(/[/\\]/).pop()})` : '';

  const isTestOnly = files.every(f => /test|\.spec\./i.test(f.path));
  if (isTestOnly) return `test${scope}: update tests for ${names.slice(0, 3).join(', ')}`;

  const isDocOnly = files.every(f => /\.(md|txt|doc)$/i.test(f.path));
  if (isDocOnly) return `docs${scope}: update documentation`;

  const isStyleOnly = files.every(f => /\.(css|scss|less)$/i.test(f.path));
  if (isStyleOnly) return `style${scope}: update styling in ${names.slice(0, 3).join(', ')}`;

  const isBuildOnly = files.every(f => /(package\.json|tsconfig|webpack|vite|rollup|build)/i.test(f.path));
  if (isBuildOnly) return `chore${scope}: update build and dependencies`;

  const hasNew = files.some(f => f.x === '?' || f.x === 'A');
  const type = hasNew ? 'feat' : 'fix';
  return `${type}${scope}: update ${names.slice(0, 2).join(', ')}${names.length > 2 ? ` and ${names.length - 2} other file${names.length > 3 ? 's' : ''}` : ''}`;
}

function autoResizeScmMsg(el?: HTMLTextAreaElement | null): void {
  const msg = el || ($('#scmMsg') as HTMLTextAreaElement | null);
  if (!msg) return;
  msg.style.height = 'auto';
  // An empty box sizes to its placeholder, which wraps onto two lines in a narrow side bar (scrollHeight ignores it).
  const empty = !msg.value;
  if (empty) msg.value = msg.placeholder;
  const need = msg.scrollHeight;
  if (empty) msg.value = '';
  const target = Math.min(160, Math.max(28, need));
  msg.style.height = `${target}px`;
  msg.style.overflowY = need > 160 ? 'auto' : 'hidden';
}
// The side bar can be resized (and starts hidden), which rewraps the text, so the box re-fits whenever its width changes.
const scmMsgWidth = new ResizeObserver(entries => {
  for (const e of entries) if (e.contentRect.width) autoResizeScmMsg(e.target as HTMLTextAreaElement);
});

function currentActiveAgent(): DetectedAgent | null {
  try {
    const list = surfaceTabs !== undefined ? surfaceTabs['ide'] : null;
    const curId = activeTabId !== undefined ? activeTabId['ide'] : null;
    const ideTab = list?.find(t => t.id === curId);
    const agentId = ideTab?.agentId || appState.agent;
    const found = appState.detect?.agents.find(a => a.id === agentId && a.found);
    if (found) return found;
  } catch {}
  return selectedAgent();
}

function updateScmGenBtn(): void {
  const btn = $('#scmGenMsg') as HTMLButtonElement | null;
  if (!btn) return;
  const a = currentActiveAgent() || appState.detect?.agents.find(x => x.found);
  btn.classList.remove('hidden');
  const tip = a?.found ? `Generate commit message (${a.name})` : 'Generate commit message';
  btn.title = tip;
  btn.dataset.tooltip = tip;
}

// The generated message types itself into the box, like an agent's edit to a file. Typing in the box yourself
// (or a newer message) stops it where it is.
let scmTypeRun = 0;
function typeScmMsg(text: string): void {
  const run = ++scmTypeRun;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const step = reduce ? text.length : Math.max(1, Math.ceil(text.length / 90)); // about 1.5 s at most
  let i = 0, frames = 0, shown = '';
  const tick = () => {
    const msg = $<HTMLTextAreaElement>('#scmMsg'); // the panel may have redrawn the box meanwhile
    if (run !== scmTypeRun || !msg) return;
    if (msg.value !== shown && i > 0) return; // typed over
    i = Math.min(text.length, i + step);
    shown = text.slice(0, i);
    msg.value = shown;
    scmDraft = shown;
    autoResizeScmMsg(msg);
    if (document.activeElement !== msg) msg.focus();
    msg.setSelectionRange(i, i);
    if (++frames % 3 === 0 || i === text.length) sfx.play('key');
    if (i < text.length) requestAnimationFrame(tick);
  };
  tick();
}
async function generateCommitMsg(): Promise<void> {
  const currentFiles = gitState.files ?? [];
  if (!currentFiles.length) {
    toast('No changes to generate commit message for');
    return;
  }
  let activeAg = currentActiveAgent();
  if (!activeAg?.found) {
    activeAg = appState.detect?.agents?.find(a => a.found) || null;
  }
  const isStaged = currentFiles.some(f => f.x !== ' ' && f.x !== '?');
  const genBtnEl = $('#scmGenMsg') as HTMLButtonElement | null;
  if (genBtnEl) {
    genBtnEl.disabled = true;
    genBtnEl.classList.add('busy');
    genBtnEl.innerHTML = `<div class="spinner sm"></div>`;
  }
  try {
    if (!activeAg?.found) {
      const fallbackMsg = heuristicCommitMsg(currentFiles);
      typeScmMsg(fallbackMsg);
      toast('Commit message generated');
      return;
    }

    const stagedDiff = isStaged ? await api.git.diff([], true).catch(() => '') : '';
    const unstagedDiff = await api.git.diff([], false).catch(() => '');
    let diffText = '';
    if (stagedDiff && unstagedDiff) {
      diffText = `Staged changes:\n${stagedDiff}\n\nUnstaged changes:\n${unstagedDiff}`;
    } else {
      diffText = stagedDiff || unstagedDiff || '';
    }
    const summary = currentFiles.map(f => `${statusOf(f, isStaged).title}: ${f.path}`).join('\n');
    const fullDiff = (diffText || '').trim() || summary;
    const truncated = fullDiff.length > 5000 ? fullDiff.slice(0, 5000) + '\n...(truncated)' : fullDiff;

    // Use currently selected model if available, otherwise lowest/available model for agent
    const userChosenModel = activeAg.version?.trim() || undefined;
    const { model: fallbackModel } = lowestModelFor(activeAg);
    const chosenModel = userChosenModel || fallbackModel || activeAg.models?.[0];

    const prevCommit = gitLog.commits?.[0];
    const prevCommitContext = prevCommit
      ? `Previous commit (${prevCommit.hash.slice(0, 7)}): ${prevCommit.subject}\n`
      : 'Repository has no previous commits (Initial commit).\n';

    const prompt = `You are an expert developer generating a concise Git commit message.
Analyze all current changes compared to the previous commit. Wrap up everything that was changed accurately and comprehensively.

Context:
${prevCommitContext}
Changed files:
${summary}

Diff:
${truncated}

Instructions:
- Follow Conventional Commits format (e.g. feat: ..., fix: ..., chore: ..., refactor: ..., docs: ..., style: ..., test: ...).
- If there are multiple distinct changes, provide a concise summary title, followed by an empty line and short bullet points (- ...) detailing the key changes.
- Output ONLY the commit message itself. Do NOT output code blocks, quotes, or conversational preamble.`;

    commitMsgPending = true;
    sfx.play('think');
    humWhileThinking();
    const res = await api.git.genCommitMsg({
      agent: activeAg.id,
      prompt,
      model: chosenModel,
      effort: undefined, // No forced effort requirement: every model works smoothly
    });
    if (res) {
      typeScmMsg(res.trim());
      toast(`Commit message generated with ${activeAg.name}`);
    }
  } catch (err: unknown) {
    const fallbackMsg = heuristicCommitMsg(currentFiles);
    typeScmMsg(fallbackMsg);
    toast(`Commit message generated (${errMsg(err)})`);
  } finally {
    commitMsgPending = false;
    if (genBtnEl) {
      genBtnEl.disabled = false;
      genBtnEl.classList.remove('busy');
      genBtnEl.innerHTML = svgIcon('sparkles', 14);
    }
  }
}

function renderScm(): void {
  const el = $('#scm');
  if (!rootInfo) { el.innerHTML = restoringWorkspace ? skeletonRows(6) : '<p class="side-note">Open a folder to use source control.</p>'; return; }
  if (!gitLoaded) { el.innerHTML = skeletonRows(6); return; }
  if (!gitState.repo) {
    el.innerHTML = `<div class="side-note">This folder isn't a git repository yet. Turn it on to save checkpoints you can always go back to.<button class="btn btn-primary btn-sm" data-act="git.init">Initialize Repository</button></div>`;
    return;
  }
  const files = gitState.files ?? [];
  const staged = files.filter(f => f.x !== ' ' && f.x !== '?');
  const changes = files.filter(f => f.y !== ' ' || f.x === '?');
  const commitLabel = (!staged.length && changes.length ? 'Commit All' : 'Commit') + (gitState.hasRemote ? ' & Push' : '');
  const sync = syncLabel(gitState);
  const syncBtn = sync ? `<button class="btn btn-sm commit-btn" data-act="git.sync">${sync}</button>` : '';
  const empty = files.length ? '' : '<p class="side-note">No changes. Everything is saved in a checkpoint.</p>';
  el.innerHTML = `
    <div class="commit-box">
      <textarea class="input" id="scmMsg" rows="1" aria-label="Commit message" placeholder="Message (Ctrl+Enter to commit on ‘${escAttr(gitState.branch || 'main')}’)"></textarea>
      <div class="row gap-6">
        <button class="btn btn-primary btn-sm commit-btn" data-act="git.commit" ${files.length ? '' : 'disabled'}>${commitLabel}</button>
        ${syncBtn}
      </div>
    </div>
    ${scmSectionHtml('staged', 'Staged Changes', staged, true, `<button class="icon-btn" data-scm-all="unstage" title="Unstage All">${svgIcon('minus')}</button>`)}
    ${scmSectionHtml('changes', 'Changes', changes, false, `<button class="icon-btn" data-scm-all="discard" title="Discard All Changes">${svgIcon('undo')}</button><button class="icon-btn" data-scm-all="stage" title="Stage All Changes">${svgIcon('plus')}</button>`)}
    ${incomingSectionHtml()}
    ${empty}
    <div class="scm-sec graph ${scmCollapsed.has('graph') ? 'closed' : ''}" data-sec="graph">
      <div class="scm-head"><span class="chev"><svg width="10" height="10"><use href="#i-chev"/></svg></span><span class="title">Checkpoints</span><span class="count">${gitLog.commits.length}</span></div>
      <div class="scm-list">${renderGraphRows()}</div>
    </div>`;
  seenScm.clear();
  for (const f of staged) seenScm.add(f.path + true);
  for (const f of changes) seenScm.add(f.path + false);
  const msg = $<HTMLTextAreaElement>('#scmMsg', el);
  msg.value = scmDraft;
  autoResizeScmMsg(msg);
  scmMsgWidth.disconnect();
  scmMsgWidth.observe(msg);
  msg.oninput = () => {
    scmDraft = msg.value;
    autoResizeScmMsg(msg);
  };
  msg.onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run('git.commit'); } };

  updateScmGenBtn();
}
// Files the remote changed since this branch last pulled; Sync brings them in.
function incomingSectionHtml(): string {
  const list = gitState.incoming ?? [];
  if (!list.length) return '';
  const rows = list.map(p => `<div class="scm-row git-in" title="${escAttr(p)} · Changed on the remote, not pulled yet">
    <span class="ico">${fileIcon(baseName(p))}</span><span class="nm">${fileNameHtml(baseName(p))}</span><span class="dir">${esc(dirName(p))}</span><span class="st">M↓</span></div>`).join('');
  return `<div class="scm-sec ${scmCollapsed.has('incoming') ? 'closed' : ''}" data-sec="incoming">
    <div class="scm-head"><span class="chev"><svg width="10" height="10"><use href="#i-chev"/></svg></span><span class="title">Incoming (not pulled)</span><span class="acts"><button class="icon-btn" data-act="git.sync" title="Pull">${svgIcon('down')}</button></span><span class="count">${list.length}</span></div>
    <div class="scm-list">${rows}</div></div>`;
}
let scmDraft = '';
const seenScm = new Set<string>();

function toggleScmSection(head: HTMLElement): void {
  const sec = head.parentElement as HTMLElement;
  const key = sec.dataset.sec as string;
  const list = sec.querySelector<HTMLElement>('.scm-list');
  if (sec.classList.contains('closing') || sec.classList.contains('opening') || !list) return;
  const isClosing = !sec.classList.contains('closed');
  if (isClosing) {
    scmCollapsed.add(key);
    sec.classList.add('closing');
    const startH = list.scrollHeight;
    list.style.overflow = 'hidden';
    list.style.maxHeight = startH + 'px';
    list.style.opacity = '1';
    list.style.transform = 'translateY(0)';
    const _reflow = list.offsetHeight;
    list.style.transition = 'max-height .22s cubic-bezier(.16, 1, .3, 1), opacity .18s ease, transform .22s cubic-bezier(.16, 1, .3, 1)';
    list.style.maxHeight = '0px';
    list.style.opacity = '0';
    list.style.transform = 'translateY(-4px)';
    const cleanup = () => {
      sec.classList.remove('closing');
      sec.classList.add('closed');
      list.style.overflow = '';
      list.style.maxHeight = '';
      list.style.opacity = '';
      list.style.transform = '';
      list.style.transition = '';
    };
    setTimeout(cleanup, 230);
  } else {
    scmCollapsed.delete(key);
    sec.classList.remove('closed');
    sec.classList.add('opening');
    list.style.overflow = 'hidden';
    list.style.maxHeight = '0px';
    list.style.opacity = '0';
    list.style.transform = 'translateY(-4px)';
    const _reflow = list.offsetHeight;
    const targetH = list.scrollHeight;
    list.style.transition = 'max-height .22s cubic-bezier(.16, 1, .3, 1), opacity .22s ease, transform .22s cubic-bezier(.16, 1, .3, 1)';
    list.style.maxHeight = targetH + 'px';
    list.style.opacity = '1';
    list.style.transform = 'translateY(0)';
    const cleanup = () => {
      sec.classList.remove('opening');
      list.style.overflow = '';
      list.style.maxHeight = '';
      list.style.opacity = '';
      list.style.transform = '';
      list.style.transition = '';
    };
    setTimeout(cleanup, 230);
  }
  store.set('breeze.scmCollapsed', [...scmCollapsed]);
}
function scmAll(kind: string | undefined): void {
  const files = gitState.files ?? [];
  if (kind === 'stage') void gitOp(() => api.git.stage(files.filter(f => f.y !== ' ' || f.x === '?').map(f => f.path)));
  if (kind === 'unstage') void gitOp(() => api.git.unstage(files.filter(f => f.x !== ' ' && f.x !== '?').map(f => f.path), !!gitState.hasCommits));
  if (kind === 'discard') confirmDiscardChanges(files.filter(f => f.y !== ' ' || f.x === '?'));
}
function scmRowAction(t: HTMLElement, rowEl: HTMLElement): void {
  const path = rowEl.dataset.file as string;
  const f = (gitState.files ?? []).find(x => x.path === path);
  const act = t.closest<HTMLElement>('[data-scm]')?.dataset.scm;
  if (act === 'open') openFile(path);
  else if (act === 'stage') void gitOp(() => api.git.stage([path]));
  else if (act === 'unstage') void gitOp(() => api.git.unstage([path], !!gitState.hasCommits));
  else if (act === 'discard' && f) confirmDiscardChanges([f]);
  else if (f) void showDiff(f, !!rowEl.dataset.staged);
}
$('#scm').addEventListener('click', e => {
  const t = e.target as HTMLElement;
  const head = t.closest<HTMLElement>('.scm-head');
  if (head && !t.closest('button')) { toggleScmSection(head); return; }
  const all = t.closest<HTMLElement>('[data-scm-all]');
  if (all) { scmAll(all.dataset.scmAll); return; }
  const commitRow = t.closest<HTMLElement>('[data-commit]');
  if (commitRow) { void toggleCommit(commitRow.dataset.commit as string); return; }
  const rowEl = t.closest<HTMLElement>('.scm-row');
  if (rowEl) scmRowAction(t, rowEl);
});
$('#scm').addEventListener('pointerover', e => {
  const commitRow = (e.target as HTMLElement).closest<HTMLElement>('[data-commit]');
  if (!commitRow) return;
  const hash = commitRow.dataset.commit;
  if (hash && !commitDetails.has(hash)) {
    api.git.show(hash).then(d => {
      commitDetails.set(hash, d);
      if (openCommit === hash) placeCommitDetail(hash);
    }).catch(() => {});
  }
});

async function gitOp(fn: () => Promise<unknown>, done?: string): Promise<boolean> {
  if (gitBusy) return false;
  gitBusy = true;
  $('#scm').classList.add('busy');
  try {
    await fn();
    if (done) toast(done);
    return true;
  } catch (e) {
    const m = errMsg(e);
    if (m.length > 90 || m.includes('\n')) openModal(`<h3>Git said no</h3><pre class="git-err">${esc(m)}</pre><div class="row end"><button class="btn btn-primary" data-close>OK</button></div>`);
    else toast(m);
    return false;
  } finally {
    gitBusy = false;
    $('#scm').classList.remove('busy');
    await refreshGit();
  }
}
function confirmDiscardChanges(files: GitFile[]): void {
  if (!files.length) return;
  const untracked = files.filter(f => f.x === '?').length;
  const what = files.length === 1 ? 'changes in ' + esc(baseName(files[0].path)) : plural(files.length, 'change');
  const goes = untracked > 1 ? 's go' : ' goes';
  const bin = untracked ? `${untracked} new file${goes} to the Recycle Bin. ` : '';
  openModal(`<h3>Discard ${what}?</h3>
    <p class="sub">${bin}Edits to tracked files go back to the last checkpoint. This can't be undone with Ctrl+Z.</p>
    <div class="row end"><button class="btn" data-close>Cancel</button><button class="btn btn-danger" id="discardOk">Discard</button></div>`, m => {
    $('#discardOk', m).onclick = () => {
      closeModal();
      void gitOp(() => api.git.discard(files.map(f => ({ path: f.path, untracked: f.x === '?' }))));
    };
  });
}
function diffLineClass(l: string): string {
  if (l.startsWith('@@')) return 'hunk';
  if (l.startsWith('+')) return 'add';
  return l.startsWith('-') ? 'del' : '';
}
async function showDiff(f: GitFile, staged: boolean): Promise<void> {
  let text = '';
  try {
    if (f.x === '?') {
      const r = await api.fs.readFile(f.path);
      text = (r.text ?? '(binary file)').split('\n').map(l => '+' + l).join('\n');
    } else text = await api.git.diff(f.path, staged);
  } catch (e) { toast(errMsg(e)); return; }
  const lines = text.split('\n').filter(l => !/^(?:diff --git|index |--- |\+\+\+ )/.test(l));
  const body = lines.map(l => `<div class="dl ${diffLineClass(l)}">${esc(l) || ' '}</div>`).join('') || '<div class="dl">No textual changes.</div>';
  openModal(`<div class="diff-head"><span class="ico">${fileIcon(baseName(f.path))}</span><b>${esc(f.path)}</b><span class="pill">${staged ? 'Staged' : statusOf(f).title}</span></div>
    <div class="diff">${body}</div>
    <div class="row end mt-12"><button class="btn" id="diffOpen">Open File</button><button class="btn btn-primary" id="diffStage">${staged ? 'Unstage' : 'Stage'}</button></div>`, m => {
    $('#diffOpen', m).onclick = () => { closeModal(); openFile(f.path); };
    $('#diffStage', m).onclick = () => { closeModal(); void gitOp(() => (staged ? api.git.unstage([f.path], !!gitState.hasCommits) : api.git.stage([f.path]))); };
  }, undefined, 'top');
}

/* ----- Commit graph ----- */
const LANE_COLORS = ['#7aa9ff', '#c4b5fd', '#86efac', '#fdba74', '#f9a8d4', '#7dd3fc'];
interface GraphRow { c: GitCommit; lane: number; before: (string | null)[]; after: (string | null)[]; merges: number[]; forks: number[]; }
// The first free lane (or a new one) for a commit.
function claimLane(lanes: (string | null)[], hash: string): number {
  let i = lanes.indexOf(hash);
  if (i !== -1) return i;
  i = lanes.indexOf(null);
  if (i === -1) i = lanes.length;
  lanes[i] = hash;
  return i;
}
function layoutGraph(commits: GitCommit[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  return commits.map(c => {
    const lane = claimLane(lanes, c.hash);
    const before = lanes.slice();
    const merges = before.map((h, i) => (h === c.hash && i !== lane ? i : -1)).filter(i => i >= 0);
    merges.forEach(i => { lanes[i] = null; });
    lanes[lane] = c.parents[0] ?? null;
    const forks = c.parents.slice(1).map(p => claimLane(lanes, p));
    while (lanes.length && lanes.at(-1) == null) lanes.pop();
    return { c, lane, before, after: lanes.slice(), merges, forks };
  });
}
const laneColor = (i: number) => LANE_COLORS[i % LANE_COLORS.length];
// The top row's lines start a pixel down so their round caps aren't clipped flat by the svg edge.
function graphSvg(r: GraphRow, H: number, X: (i: number) => number, top = false): string {
  const mid = H / 2, y0 = top ? 1 : 0;
  const paths = r.before.map((h, i) => {
    if (!h) return '';
    if (i === r.lane) return `<path d="M${X(i)} ${y0}V${mid}" stroke="${laneColor(i)}"/>`;
    if (r.merges.includes(i)) return `<path d="M${X(i)} ${y0}C${X(i)} ${mid} ${X(r.lane)} ${mid / 2} ${X(r.lane)} ${mid}" stroke="${laneColor(i)}"/>`;
    return `<path d="M${X(i)} ${y0}V${H}" stroke="${laneColor(i)}"/>`;
  });
  if (r.after[r.lane]) paths.push(`<path d="M${X(r.lane)} ${mid}V${H}" stroke="${laneColor(r.lane)}"/>`);
  for (const f of r.forks) paths.push(`<path d="M${X(r.lane)} ${mid}C${X(r.lane)} ${H} ${X(f)} ${mid} ${X(f)} ${H}" stroke="${laneColor(f)}"/>`);
  const isHead = r.c.hash === gitLog.head;
  const fill = isHead ? laneColor(r.lane) : 'var(--bg-1)';
  paths.push(`<circle cx="${X(r.lane)}" cy="${mid}" r="${isHead ? 5 : 4}" fill="${fill}" stroke="${laneColor(r.lane)}" stroke-width="2"/>`);
  return paths.join('');
}
function refClass(ref: string): string {
  if (ref.startsWith('HEAD')) return 'head';
  if (ref.startsWith('tag: ')) return 'tag';
  return ref.includes('/') ? 'remote' : 'branch';
}
function detailGraphSvg(r: GraphRow, X: (i: number) => number): string {
  const lines: string[] = [];
  r.after.forEach((h, i) => {
    if (h) {
      lines.push(`<path d="M${X(i)} -1V101" stroke="${laneColor(i)}" stroke-width="2" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`);
    }
  });
  return lines.join('');
}
function commitDetailWrapHtml(r: GraphRow, width: number, X: (i: number) => number, d?: GitCommitDetail): string {
  return `<div class="commit-detail-row" data-detail-hash="${r.c.hash}">
    <div class="detail-graph-col">
      <svg class="detail-graph" width="${width}" viewBox="0 0 ${width} 100" preserveAspectRatio="none">${detailGraphSvg(r, X)}</svg>
    </div>
    ${commitDetailHtml(r.c, d)}
  </div>`;
}
function renderGraphRows(): string {
  if (!gitLog.commits.length) return '<p class="side-note">No checkpoints yet. Commit your changes to save the first one.</p>';
  const rows = layoutGraph(gitLog.commits);
  const H = 36, X = (i: number) => 10 + i * 12;
  const width = Math.min(6, Math.max(...rows.map(r => Math.max(r.before.length, r.after.length, r.lane + 1)))) * 12 + 8;
  return rows.map((r, idx) => {
    const refs = r.c.refs.map(ref => `<span class="ref ${refClass(ref)}">${esc(ref.replace(/^HEAD -> /, '').replace(/^tag: /, ''))}</span>`).join('');
    const open = openCommit === r.c.hash;
    const detail = open ? commitDetailWrapHtml(r, width, X, commitDetails.get(r.c.hash)) : '';
    const tipText = `${r.c.subject} (${r.c.hash.slice(0, 7)} · ${r.c.author} · ${r.c.when})`;
    return `<div class="commit ${open ? 'on' : ''}" data-commit="${r.c.hash}" data-tooltip="${escAttr(tipText)}">
      <svg width="${width}" height="${H}" fill="none" stroke-width="2" stroke-linecap="round">${graphSvg(r, H, X, idx === 0)}</svg>
      <div class="msgline"><div>${refs}<span class="subj">${esc(r.c.subject)}</span></div><small>${esc(r.c.author)} · ${esc(r.c.when)}</small></div>
    </div>${detail}`;
  }).join('');
}
function splitFilePath(p: string): { name: string; ext: string } {
  const slash = p.lastIndexOf('/');
  const dot = p.lastIndexOf('.');
  if (dot > slash + 1) {
    return { name: p.slice(0, dot), ext: p.slice(dot) };
  }
  return { name: p, ext: '' };
}
function commitDetailHtml(c: GitCommit, d?: GitCommitDetail): string {
  const files = d
    ? d.files.map(f => {
        const { name, ext } = splitFilePath(f.path);
        return `<div class="file" data-open-file="${escAttr(f.path)}" title="${escAttr(f.path)}"><span class="ico">${fileIcon(baseName(f.path))}</span><span class="fp"><span class="fp-name">${esc(name)}</span><span class="fp-ext">${esc(ext)}</span></span><span class="file-stats"><span class="add">+${f.added}</span> <span class="del">−${f.removed}</span></span></div>`;
      }).join('')
    : '<div class="side-note shimmer-text">Loading changed files</div>';
  // The whole checkpoint at a glance: how many files, and the lines added and removed across all of them.
  const added = d ? d.files.reduce((n, f) => n + f.added, 0) : 0;
  const removed = d ? d.files.reduce((n, f) => n + f.removed, 0) : 0;
  const total = d?.files.length ? `<div class="cd-total"><span>${plural(d.files.length, 'file')} changed</span><span class="file-stats"><span class="add">+${added}</span> <span class="del">−${removed}</span></span></div>` : '';
  return `<div class="commit-detail">
    <div class="cd-msg selectable">${esc(d ? d.message : c.subject)}</div>
    <div class="cd-meta">${esc(d ? d.author : c.author)} · ${esc(d ? d.when : c.when)} · <code>${c.hash.slice(0, 8)}</code></div>
    ${total}
    ${files}
    <div class="row mt-8 commit-actions"><button class="btn btn-sm" data-branch-from="${c.hash}">Branch from here</button><button class="btn btn-sm" data-copy-hash="${c.hash}">Copy id</button></div>
  </div>`;
}
// Opens or closes one checkpoint's details in place; the rest of the panel is left alone.
const commitRow = (hash: string) => $(`#scm .commit[data-commit="${hash}"]`);
// Details open and close by sliding their height (one compositor-friendly Web Animation, not a max-height guess),
// with the card inside fading a beat behind, so the rows below glide instead of jumping.
const DETAIL_EASE = 'cubic-bezier(.32, .72, 0, 1)';
const isDetailEl = (el: Element | null): el is HTMLElement => !!el && (el.classList.contains('commit-detail-row') || el.classList.contains('commit-detail'));
function slideDetailHeight(el: HTMLElement, from: number, to: number, done?: () => void): void {
  el.getAnimations().forEach(a => a.cancel());
  el.style.overflow = 'hidden';
  const a = el.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 300, easing: DETAIL_EASE, fill: done ? 'forwards' : 'none' });
  a.onfinish = () => { if (done) done(); else el.style.overflow = ''; };
}
function closeCommitDetail(hash: string, instant = false): void {
  const row = commitRow(hash);
  row?.classList.remove('on');
  const d = row?.nextElementSibling ?? null;
  if (!isDetailEl(d) || d.dataset.closing) return;
  if (instant) { d.remove(); return; }
  d.dataset.closing = '1';
  const card = d.querySelector('.commit-detail') ?? d;
  card.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-6px) scale(.985)' }], { duration: 180, easing: 'ease-out', fill: 'forwards' });
  slideDetailHeight(d, d.getBoundingClientRect().height, 0, () => d.remove());
}
function placeCommitDetail(hash: string): void {
  const row = commitRow(hash);
  if (!row) return;
  const rows = layoutGraph(gitLog.commits);
  const r = rows.find(x => x.c.hash === hash);
  if (!r) return;
  const X = (i: number) => 10 + i * 12;
  const width = Math.min(6, Math.max(...rows.map(row => Math.max(row.before.length, row.after.length, row.lane + 1)))) * 12 + 8;
  const holder = document.createElement('div');
  holder.innerHTML = commitDetailWrapHtml(r, width, X, commitDetails.get(hash));
  const fresh = holder.firstElementChild as HTMLElement;
  const old = row.nextElementSibling;
  // Loading → loaded swaps the contents only and slides from the old height to the new one.
  if (isDetailEl(old) && !old.dataset.closing) {
    const from = old.getBoundingClientRect().height;
    const card = old.querySelector('.commit-detail') || old;
    const freshCard = fresh.querySelector('.commit-detail') || fresh;
    card.innerHTML = freshCard.innerHTML;
    const graphCol = old.querySelector('.detail-graph-col');
    const freshGraphCol = fresh.querySelector('.detail-graph-col');
    if (graphCol && freshGraphCol) graphCol.innerHTML = freshGraphCol.innerHTML;
    old.getAnimations().forEach(a => a.cancel());
    const to = old.getBoundingClientRect().height;
    if (Math.abs(to - from) > 1) slideDetailHeight(old, from, to);
    card.querySelectorAll<HTMLElement>('.file, .commit-actions').forEach((el, i) =>
      el.animate([{ opacity: 0, transform: 'translateY(-3px)' }, { opacity: 1, transform: 'none' }], { duration: 220, delay: i * 25, easing: DETAIL_EASE, fill: 'backwards' }));
  } else {
    if (isDetailEl(old)) old.remove();
    row.after(fresh);
    slideDetailHeight(fresh, 0, fresh.getBoundingClientRect().height);
    (fresh.querySelector('.commit-detail') ?? fresh).animate(
      [{ opacity: 0, transform: 'translateY(-6px) scale(.985)' }, { opacity: 1, transform: 'none' }],
      { duration: 280, delay: 40, easing: DETAIL_EASE, fill: 'backwards' });
  }
  row.classList.add('on');
}
async function toggleCommit(hash: string): Promise<void> {
  const was = openCommit;
  openCommit = openCommit === hash ? null : hash;
  if (was) closeCommitDetail(was);
  if (!openCommit) return;
  placeCommitDetail(hash);
  if (commitDetails.has(hash)) return;
  try { commitDetails.set(hash, await api.git.show(hash)); } catch (e) {
    toast(errMsg(e));
    if (openCommit === hash) { openCommit = null; closeCommitDetail(hash, true); }
    return;
  }
  if (openCommit === hash) placeCommitDetail(hash);
}
$('#scm').addEventListener('click', e => {
  const t = e.target as HTMLElement;
  const f = t.closest<HTMLElement>('[data-open-file]');
  if (f) { e.stopPropagation(); openFile(f.dataset.openFile as string); }
  const b = t.closest<HTMLElement>('[data-branch-from]');
  if (b) { e.stopPropagation(); void newBranch(b.dataset.branchFrom); }
  const c = t.closest<HTMLElement>('[data-copy-hash]');
  if (c) { e.stopPropagation(); background(navigator.clipboard.writeText(c.dataset.copyHash ?? '').then(() => toast('Commit id copied'))); }
}, true);

async function commitNow(): Promise<void> {
  const msg = scmDraft.trim();
  if (!msg) { toast('Write a short message describing this checkpoint'); $('#scmMsg')?.focus(); return; }
  const files = gitState.files ?? [];
  if (!files.length) { toast('Nothing to commit'); return; }
  await saveAll();
  const all = !files.some(f => f.x !== ' ' && f.x !== '?');
  let hash = '';
  if (!(await gitOp(async () => { hash = await api.git.commit(msg, all); }))) return;
  sfx.play('save');
  scmDraft = '';
  renderScm();
  // A checkpoint is committed and pushed in one go (pulling first if the branch is behind).
  if (!gitState.hasRemote) { toast(`Checkpoint saved · ${hash} (no remote to push to yet)`); return; }
  toast(`Checkpoint saved · ${hash} — pushing`);
  const behind = !!gitState.behind;
  await gitOp(async () => {
    if (behind) await api.git.sync('pull');
    await api.git.sync('push');
  }, `Checkpoint ${hash} saved and pushed`);
}
async function newBranch(from?: string): Promise<void> {
  const name = await askName(from ? 'New branch from this checkpoint' : 'New branch', '', 'Create');
  if (!name) return;
  await gitOp(() => api.git.switchTo(name, true, from), `Switched to new branch ${name}`);
}
function branchListHtml(branches: string[], q: string): string {
  const create = q && !branches.includes(q)
    ? `<div class="qo-item" data-new="1"><span class="qo-title">${svgIcon('plus', 14)} <span>Create branch “${esc(q)}”</span></span></div>`
    : '';

  const rows = branches.filter(b => b.toLowerCase().includes(q.toLowerCase())).map(b => {
    const current = b === gitState.branch;
    const del = current
      ? ''
      : `<button class="br-del" data-del="${escAttr(b)}" title="Hold for 5 seconds to delete" aria-label="Hold for 5 seconds to delete ${escAttr(b)}">${svgIcon('trash', 14)}</button>`;
    return `<div class="qo-item ${current ? 'on' : ''}" data-br="${escAttr(b)}"><span class="qo-title">${svgIcon('gitBranch', 14)} <span>${esc(b)}</span></span>${current ? '<small class="qo-badge">current</small>' : ''}${del}</div>`;
  });

  return create + rows.join('');
}


const HOLD_MS = 5000;//hold time duration
// Fires onDone only if the button is held for the full 5 seconds; releasing, leaving the button or losing focus cancels.
function holdToDelete(btn: HTMLElement, onDone: () => void): void {
  btn.dataset.hold = '';
  let timer: TimeoutId | undefined
  const stop = (early: boolean) => {
    if (timer == null) return;
    clearTimeout(timer); timer = undefined;
    btn.classList.remove('holding');
    if (early) toast(`Keep holding for 5 seconds to ${(btn.getAttribute('aria-label') ?? '').includes('to remove') ? 'remove' : 'delete'}`);
  };
  const start = () => {
    if (timer != null) return;
    btn.classList.add('holding');
    timer = setTimeout(() => {
      timer = undefined;
      btn.classList.remove('holding');
      if (btn.isConnected) {
        sfx.play('trash');
        onDone();
      }
    }, HOLD_MS);
  };
  btn.onpointerdown = e => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    btn.setPointerCapture(e.pointerId);
    start();
  };
  btn.onpointermove = e => { const r = btn.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) stop(false); };
  btn.onpointerup = () => stop(true);
  btn.onpointercancel = () => stop(false);
  btn.onblur = () => stop(false);
  btn.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); if (!e.repeat) start(); } };
  btn.onkeyup = () => stop(true);
  btn.onclick = e => e.stopPropagation(); // never let it count as picking the row
}


async function pickBranch(): Promise<void> {
  if (!gitState.repo) { showView('git', true); return; }
  const branches = await api.git.branches().catch(() => [] as string[]);
  openModal(`<input class="input w-full" id="brIn" aria-label="Branch name" placeholder="Switch to a branch, or type a new name" spellcheck="false"><div class="qo-list" id="brList"></div>`, m => {
    const input = $<HTMLInputElement>('#brIn', m);
    input.focus();
    const switchTo = (name: string, create: boolean) => {
      closeModal();
      const msg = create ? `Switched to new branch ${name}` : `Switched to ${name}`;
      if (create || name !== gitState.branch) void gitOp(() => api.git.switchTo(name, create), msg);
    };
    const remove = async (name: string) => {
      if (!(await gitOp(() => api.git.deleteBranch(name), `Deleted branch ${name}`))) return;
      const i = branches.indexOf(name);
      if (i >= 0) branches.splice(i, 1);
      render();
    };

    const render = () => {
      const q = input.value.trim();
      $('#brList', m).innerHTML = branchListHtml(branches, q);
      $$('[data-br]', m).forEach(el => el.onclick = () => switchTo(el.dataset.br as string, false));
      $$('[data-del]', m).forEach(btn => holdToDelete(btn, () => void remove(btn.dataset.del as string)));
      $('[data-new]', m)?.addEventListener('click', () => switchTo(q, true));
    };
    input.oninput = render;
    input.onkeydown = e => { if (e.key === 'Enter') ($('[data-new], [data-br]', m) as HTMLElement | null)?.click(); };
    render();
  }, undefined, 'top');
}
$('#sbBranch').onclick = () => void pickBranch();
async function syncBranch(): Promise<boolean> {
  const s = gitState;
  if (!s.upstream) return gitOp(() => api.git.sync('push'), 'Branch published');
  if (!s.behind) return gitOp(() => api.git.sync('push'), 'Pushed');
  return gitOp(async () => {
    await api.git.sync('pull');
    if (s.ahead) await api.git.sync('push');
  }, 'In sync');
}
Object.assign(commands, {
  'git.refresh': refreshGit,
  'git.init': () => gitOp(() => api.git.init(), 'Repository created'),
  'git.commit': commitNow,
  'git.sync': syncBranch,
  'git.genCommitMsg': () => void generateCommitMsg(),
  'git.more': () => {
    const btn = $('[data-act="git.more"]');
    if (btn && (btn.classList.contains('open') || (justClosedTrigger === btn && Date.now() - justClosedAt < 350))) {
      closeMenu();
      return;
    }
    closeMenu();
    btn?.classList.add('open');
    const r = btn.getBoundingClientRect();
    popupMenu(r.left, r.bottom + 4, [
      { label: 'Pull', run: () => void gitOp(() => api.git.sync('pull'), 'Pulled') },
      { label: 'Push', run: () => void gitOp(() => api.git.sync('push'), 'Pushed') },
      { label: 'Fetch', run: () => void gitOp(() => api.git.sync('fetch'), 'Fetched') },
      { sep: true },
      { label: 'Switch Branch', run: () => void pickBranch() },
      { label: 'Create Branch', run: () => void newBranch() },
    ], () => btn?.classList.remove('open'), btn);
  },
});
$('#scmGenMsg')?.addEventListener('click', () => { void generateCommitMsg(); });

