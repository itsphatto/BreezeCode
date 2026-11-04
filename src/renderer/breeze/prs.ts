/* ================= Source Control page (and pull requests) ================= */
// Source Control is a full page: the changes, commit box and graph in a column on the left (git.ts), and on the right
// whatever was picked there, a file's diff for now and pull requests later. It takes the place of the editor and
// preview, and of the side bar, while it is open. Nothing in `layout` changes, so closing it brings back exactly what
// was on screen before.
let scmPageOpen = false;
// The side-bar view to go back to when the page closes (never 'git': that is the page itself).
let scmPrevView = 'files';

// Swapping the page in or out snaps the columns instead of sliding them: applyLayout sizes the preview from the width
// the work area has right then, which mid-slide is not the width it ends at, and the editor would come back squeezed.
function snapMain(): void {
  const main = $('#main');
  main.classList.add('scm-snap');
  setTimeout(() => main.classList.remove('scm-snap'), 80);
}

function openScmPage(): void {
  if (scmPageOpen) return;
  snapMain();
  scmPrevView = layout.view === 'git' ? 'files' : layout.view;
  scmPageOpen = true;
  $('#main').classList.add('scm-page');
  scmEmptyDetail();
  setTimeout(placeSashes); // the page's own sash and the side bar's now change places
  void refreshPrs();
}

// `restore` false: showView is already switching to another view, so there is nothing to go back to.
function closeScmPage(restore = true): void {
  if (!scmPageOpen) return;
  snapMain();
  scmPageOpen = false;
  $('#main').classList.remove('scm-page');
  setTimeout(placeSashes);
  if (restore) showView(scmPrevView);
}

function showScmDetail(html: string, bind?: (el: HTMLElement) => void): void {
  const el = $('#scmDetail');
  el.innerHTML = html;
  el.scrollTop = 0;
  bind?.(el);
  markPrSel();
}

function scmEmptyDetail(): void {
  showScmDetail(`<div class="empty scm-empty"><div>${svgIcon('gitBranch', 36)}<h4>Select a change or a pull request</h4></div></div>`);
}

$('#scmClose').onclick = () => closeScmPage();

/* ----- Pull requests: the list in the left column ----- */
type PrList = GhResult<{ owner: string; repo: string; pulls: GhPull[] }>;
// The last answer, for the folder and branch it was asked about (a different one is never shown in its place).
let prData: { root: string; branch: string; res: PrList } | null = null;
// Bumped by every refreshPrs: an answer that comes back after another refresh began is dropped, so a slow answer for the
// branch you left cannot replace the one you are on. Opening a pull request has its own counter (prOpenGen), so that
// opening one cannot cancel the list's answer, nor a list refresh (window focus, any git change) the one being opened.
let prGen = 0;
let prOpenGen = 0;

const githubSignedIn = (): boolean => accounts.accounts.some(a => a.provider === 'GitHub');
const PR_STATUS_LABEL = { ready: 'Ready to merge', conflict: 'Has conflicts', checking: 'Checking for conflicts', draft: 'Draft' };
const prAgo = (iso: string | null): string => (iso && !Number.isNaN(Date.parse(iso)) ? timeAgo(Date.parse(iso)) : '');
const prAvatar = (login: string, url: string | null): string =>
  url ? `<img class="pr-av" alt="" src="${escAttr(url)}">` : `<span class="pr-av">${esc((login[0] ?? '?').toUpperCase())}</span>`;

async function refreshPrs(force = false): Promise<void> {
  const gen = ++prGen;
  if (!rootInfo || !gitState.repo) { prData = null; paintPrs(); return; }
  const root = rootInfo.root, branch = gitState.branch || null;
  if (branch === null || !githubSignedIn()) { paintPrs(); return; }
  // The same folder and branch keeps its list on screen while the new answer comes; an error or another branch shows "loading".
  if (!prData || prData.root !== root || prData.branch !== branch || !prData.res.ok) { prData = null; paintPrs(); }
  const res: PrList = await api.gh.prs(branch, force).catch((e: unknown) => ({ ok: false, error: 'http', message: errMsg(e) }) as PrList);
  if (gen !== prGen) return;
  prData = { root, branch, res };
  paintPrs();
}

// What the list shows now, and the answer it shows (null while there is none for this folder and branch yet).
function prViewState(): { state: string; res: PrList | null } {
  const branch = gitState.branch || null;
  const res = prData && prData.root === rootInfo?.root && prData.branch === branch ? prData.res : null;
  return { state: prListState({ signedIn: githubSignedIn(), branch, result: res }), res };
}

function prRowHtml(p: GhPull): string {
  const st = prStatus(p);
  const commits = p.commits === undefined ? '' : `<span>${plural(p.commits, 'commit')}</span>`;
  return `<div class="pr-row" data-pr="${p.number}" role="button" tabindex="0" title="${escAttr(p.title)}">
    <div class="pr-l1"><span class="pr-dot ${st}" title="${PR_STATUS_LABEL[st]}" role="img" aria-label="${PR_STATUS_LABEL[st]}"></span><span class="pr-t">${esc(p.title)}</span><span class="pr-n">#${p.number}</span></div>
    <div class="pr-l2"><span class="pr-br">${esc(p.head.label)} → ${esc(p.base)}</span></div>
    <div class="pr-l3">${prAvatar(p.author, p.avatar)}<span class="pr-au">${esc(p.author)}</span>${commits}${p.draft ? '<span class="pill">Draft</span>' : ''}</div></div>`;
}

function prBodyHtml(state: string, res: PrList | null, branch: string): string {
  const note = (text: string, btn = '') => `<p class="side-note pr-note">${text}${btn}</p>`;
  const act = (label: string, a: string) => `<button class="btn btn-sm" data-pr-act="${a}">${label}</button>`;
  if (state === 'no-branch') return note('Not on a branch');
  if (state === 'signed-out') return note('Sign in with GitHub to see pull requests', act('Sign in', 'signin'));
  if (state === 'loading') return skeletonRows(2);
  if (state === 'reauth') return note('Your GitHub sign-in expired', act('Sign in again', 'signin'));
  if (state === 'not-github') return note('This repository isn\'t on GitHub');
  if (state === 'no-remote') return note('No origin remote');
  if (state !== 'ok' || !res?.ok) return note('Couldn\'t load pull requests', act('Retry', 'retry'));
  if (!res.data.pulls.length) return note(`No open pull requests into ${esc(branch)}`);
  return res.data.pulls.map(prRowHtml).join('');
}

// The section Source Control's left column shows between the commit box and the checkpoints. Not drawn without a repository.
function prSectionHtml(): string {
  if (!rootInfo || !gitState.repo) return '';
  const { state, res } = prViewState();
  const count = state === 'ok' && res?.ok ? `<span class="count">${res.data.pulls.length}</span>` : '';
  return `<div class="scm-sec prs ${scmCollapsed.has('prs') ? 'closed' : ''}" data-sec="prs">
    <div class="scm-head"><span class="chev"><svg width="10" height="10"><use href="#i-chev"/></svg></span><span class="title">Pull requests</span><span class="acts"><button class="icon-btn" data-pr-act="refresh" title="Refresh pull requests" aria-label="Refresh pull requests">${svgIcon('rotateCw', 14)}</button></span>${count}</div>
    <div class="scm-list">${prBodyHtml(state, res, gitState.branch || '')}</div></div>`;
}

// Redraws only this section, so the commit message being typed above it is left alone.
function paintPrs(): void {
  const sec = document.querySelector('#scm .scm-sec.prs');
  if (!sec) return;
  const t = document.createElement('div');
  t.innerHTML = prSectionHtml();
  if (t.firstElementChild) sec.replaceWith(t.firstElementChild); else sec.remove();
  markPrSel();
}

// Marks the row of the pull request whose detail is on the right.
function markPrSel(): void {
  const n = document.querySelector<HTMLElement>('#scmDetail .pr-view')?.dataset.n;
  document.querySelectorAll<HTMLElement>('#scm .pr-row').forEach(r => r.classList.toggle('on', r.dataset.pr === n));
}

$('#scm').addEventListener('click', e => {
  const t = e.target as HTMLElement;
  const act = t.closest<HTMLElement>('[data-pr-act]')?.dataset.prAct;
  if (act === 'refresh' || act === 'retry') void refreshPrs(true);
  else if (act === 'signin') addAccount();
  else {
    const row = t.closest<HTMLElement>('.pr-row');
    if (row) void openPr(Number(row.dataset.pr));
  }
});
$('#scm').addEventListener('keydown', e => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.pr-row');
  if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); void openPr(Number(row.dataset.pr)); }
});

/* ----- Pull requests: the detail on the right ----- */
type PrTab = 'commits' | 'files' | 'conflict';
const GH_ERROR_COPY: Record<string, string> = { reauth: 'Your GitHub sign-in expired', 'signed-out': 'Sign in with GitHub to see pull requests', 'not-github': 'This repository isn\'t on GitHub', 'no-remote': 'No origin remote' };
const prFileSets = new WeakMap<Element, { files: GhFile[]; url: string }>();

// One file's diff: a gutter of old and new line numbers, then the line. A file GitHub sent no patch for (too big, binary)
// says so and links to it there.
function patchHtml(patch: string | null, url: string): string {
  if (patch === null) return `<div class="pr-nopatch">This file's diff isn't available here<button class="btn btn-sm" data-ext="${escAttr(url)}">Open on GitHub</button></div>`;
  const rows = parsePatch(patch);
  if (!rows.length) return '<div class="pr-nopatch">No textual changes</div>';
  const sign = { add: '+', del: '-', ctx: ' ', hunk: '', note: '' };
  const body = rows.map(r => `<div class="dl ${r.kind === 'ctx' ? '' : r.kind}"><span class="ln ln-old">${r.old ?? ''}</span><span class="ln ln-new">${r.new ?? ''}</span><span class="tx">${esc(sign[r.kind] + r.text) || ' '}</span></div>`).join('');
  return `<div class="diff pr-diff">${body}</div>`;
}

function prFilesHtml(files: GhFile[]): string {
  if (!files.length) return '<p class="side-note pr-note">No files changed</p>';
  return files.map((f, i) => {
    const big = f.patch !== null && f.patch.split('\n').length > 400; // collapsed until asked for: a long diff is slow to draw
    const name = f.previous && f.previous !== f.path ? `${f.previous} → ${f.path}` : f.path;
    return `<div class="pr-file ${big ? 'closed' : ''}" data-i="${i}">
      <div class="pr-file-head" role="button" tabindex="0" aria-expanded="${big ? 'false' : 'true'}"><span class="chev"><svg width="10" height="10"><use href="#i-chev"/></svg></span><span class="ico">${fileIcon(f.path)}</span><span class="pr-fname">${esc(name)}</span><span class="pr-fst">${esc(f.status)}</span><span class="pr-stat"><b class="add">+${f.additions}</b> <b class="del">−${f.deletions}</b></span></div>
      <div class="pr-file-body"></div></div>`;
  }).join('');
}
// Fills a container with file blocks; a collapsed block's diff is drawn when it is first opened.
function mountPrFiles(box: HTMLElement, files: GhFile[], url: string): void {
  box.innerHTML = prFilesHtml(files);
  prFileSets.set(box, { files, url });
  box.querySelectorAll<HTMLElement>('.pr-file:not(.closed)').forEach(b => fillPrFile(box, b));
}
function fillPrFile(box: Element, blk: HTMLElement): void {
  const set = prFileSets.get(box);
  const body = blk.querySelector<HTMLElement>('.pr-file-body');
  if (set && body && !body.firstChild) body.innerHTML = patchHtml(set.files[Number(blk.dataset.i)].patch, set.url);
}

function prDetailShell(pr: GhPull, tab: PrTab, commits: GhResult<GhCommit[]>, files: GhResult<GhFile[]>): string {
  const st = prStatus(pr);
  const tabs: [PrTab, string, number | null][] = [['commits', 'Commits', commits.ok ? commits.data.length : null], ['files', 'Files', files.ok ? files.data.length : null]];
  if (st === 'conflict') tabs.push(['conflict', 'Conflict', null]);
  const when = prAgo(pr.createdAt);
  return `<div class="pr-head">
      <div class="pr-title"><h3>${esc(pr.title)}</h3><span class="pr-n">#${pr.number}</span>${pr.draft ? '<span class="pill">Draft</span>' : ''}</div>
      <div class="pr-meta"><span class="pr-st"><span class="pr-dot ${st}"></span>${PR_STATUS_LABEL[st]}</span><span class="pr-br">${esc(pr.head.label)} → ${esc(pr.base)}</span>${prAvatar(pr.author, pr.avatar)}<span>${esc(pr.author)}</span>${when ? `<span>${esc(when)}</span>` : ''}</div>
      <div class="pr-actions"><button class="btn btn-sm" data-ext="${escAttr(pr.url)}">Open on GitHub ${svgIcon('external', 12)}</button><button class="btn btn-primary btn-sm" id="prMerge" disabled>Merge</button></div>
    </div>
    <div class="pr-tabs" role="tablist">${tabs.map(([k, label, n]) => `<button class="pr-tab ${k === tab ? 'on' : ''}" role="tab" aria-selected="${k === tab}" data-tab="${k}">${label}${n === null ? '' : ` <span class="count">${n}</span>`}</button>`).join('')}</div>
    <div class="pr-body" id="prBody"></div>`;
}

async function openPr(n: number): Promise<void> {
  const gen = ++prOpenGen;
  const shown = () => gen === prOpenGen && !!document.querySelector(`#scmDetail .pr-view[data-n="${n}"]`);
  showScmDetail(`<div class="pr-view" data-n="${n}"><div class="pr-loading"><div class="spinner sm"></div>Loading pull request #${n}</div></div>`);
  const [prRes, commits, files] = await Promise.all([api.gh.pr(n), api.gh.prCommits(n), api.gh.prFiles(n)]);
  if (!shown()) return; // another pull request, a file or the empty page took the right side meanwhile
  const view = document.querySelector<HTMLElement>('#scmDetail .pr-view') as HTMLElement;
  if (!prRes.ok) {
    const signIn = prRes.error === 'reauth' || prRes.error === 'signed-out';
    const known = GH_ERROR_COPY[prRes.error];
    view.innerHTML = `<div class="pr-loading pr-fail"><p>${esc(known ?? 'Couldn\'t load this pull request')}</p>${prRes.message && !known ? `<p class="pr-hint">${esc(prRes.message)}</p>` : ''}<button class="btn btn-sm" data-pr-view="${signIn ? 'signin' : 'retry'}">${signIn ? (prRes.error === 'reauth' ? 'Sign in again' : 'Sign in') : 'Retry'}</button></div>`;
    view.onclick = e => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('[data-pr-view]')?.dataset.prView;
      if (a === 'signin') addAccount(); else if (a === 'retry') void openPr(n);
    };
    return;
  }
  let pr = prRes.data;
  let tab: PrTab = 'commits';
  const commitFiles = new Map<string, GhFile[]>();
  const fail = (what: string) => `<p class="side-note pr-note">Couldn't load ${what}<button class="btn btn-sm" data-pr-view="retry">Retry</button></p>`;

  const paintBody = (): void => {
    const body = $('#prBody', view);
    if (tab === 'files') {
      if (!files.ok) { body.innerHTML = fail('files'); return; }
      body.innerHTML = '<div class="pr-files"></div>';
      mountPrFiles($('.pr-files', body), files.data, `${pr.url}/files`);
    } else if (tab === 'conflict') {
      const gone = pr.head.repo === null;
      body.innerHTML = `<div class="pr-conflict"><h4>This pull request has conflicts with ${esc(pr.base)}</h4><p>GitHub can't merge it until they are resolved.</p>
        <button class="btn btn-primary btn-sm" id="prResolve" disabled${gone ? ' title="The source repository no longer exists"' : ''}>Resolve conflicts</button>
        ${gone ? '<p class="pr-hint">The source repository no longer exists</p>' : ''}</div>`;
    } else {
      if (!commits.ok) { body.innerHTML = fail('commits'); return; }
      body.innerHTML = commits.data.length ? commits.data.map(c => `<div class="pr-commit" data-sha="${escAttr(c.sha)}">
        <div class="pr-commit-head" role="button" tabindex="0" aria-expanded="false"><span class="chev"><svg width="10" height="10"><use href="#i-chev"/></svg></span><span class="pr-cmsg">${esc(c.message.split('\n')[0])}</span><span class="pr-csub">${esc(c.author)}${c.date ? ` · ${esc(prAgo(c.date))}` : ''}</span><code>${esc(c.sha.slice(0, 7))}</code></div>
        <div class="pr-commit-body"></div></div>`).join('') : '<p class="side-note pr-note">No commits</p>';
    }
  };
  const paint = (): void => {
    view.innerHTML = prDetailShell(pr, tab, commits, files);
    paintBody();
  };

  const toggleCommit = async (box: HTMLElement): Promise<void> => {
    const head = $('.pr-commit-head', box), body = $('.pr-commit-body', box);
    const open = !box.classList.contains('open');
    box.classList.toggle('open', open);
    head.setAttribute('aria-expanded', String(open));
    const sha = box.dataset.sha as string;
    if (!open || body.firstChild) return;
    const cached = commitFiles.get(sha);
    if (cached) { mountPrFiles(body, cached, `${pr.url}/commits/${sha}`); return; }
    body.innerHTML = '<div class="pr-loading"><div class="spinner sm"></div>Loading files</div>';
    const r = await api.gh.commit(sha);
    if (!shown() || !body.isConnected) return;
    if (!r.ok) { body.innerHTML = ''; box.classList.remove('open'); toast('Couldn\'t load this commit'); return; }
    commitFiles.set(sha, r.data);
    mountPrFiles(body, r.data, `${pr.url}/commits/${sha}`);
  };

  view.onclick = e => {
    const t = e.target as HTMLElement;
    const tabBtn = t.closest<HTMLElement>('[data-tab]');
    if (tabBtn) { tab = tabBtn.dataset.tab as PrTab; paint(); return; }
    if (t.closest('[data-pr-view="retry"]')) { void openPr(n); return; }
    const fileHead = t.closest<HTMLElement>('.pr-file-head');
    if (fileHead) {
      const blk = fileHead.parentElement as HTMLElement, box = blk.parentElement as HTMLElement;
      const open = !blk.classList.toggle('closed');
      fileHead.setAttribute('aria-expanded', String(open));
      if (open) fillPrFile(box, blk);
      return;
    }
    const commitHead = t.closest<HTMLElement>('.pr-commit-head');
    if (commitHead) void toggleCommit(commitHead.parentElement as HTMLElement);
  };
  view.onkeydown = e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const head = (e.target as HTMLElement).closest<HTMLElement>('.pr-file-head, .pr-commit-head');
    if (head) { e.preventDefault(); head.click(); }
  };

  paint();

  // GitHub works out mergeability in the background, so a fresh pull request can still be unknown: ask once more shortly.
  if (prStatus(pr) === 'checking') {
    setTimeout(async () => {
      if (!shown()) return;
      const again = await api.gh.pr(n);
      if (!again.ok || !shown() || prStatus(again.data) === 'checking') return;
      pr = again.data;
      if (prData?.res.ok) {
        const i = prData.res.data.pulls.findIndex(p => p.number === n);
        if (i >= 0) { prData.res.data.pulls[i] = pr; paintPrs(); }
      }
      if (tab === 'conflict' && prStatus(pr) !== 'conflict') tab = 'commits';
      paint();
    }, 2000);
  }
}

// "Open on GitHub" buttons anywhere in the detail.
$('#scmDetail').addEventListener('click', e => {
  const url = (e.target as HTMLElement).closest<HTMLElement>('[data-ext]')?.dataset.ext;
  if (url && /^https:\/\//.test(url)) background(api.sys.openExternal(url));
});
