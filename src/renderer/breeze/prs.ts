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
type PrList = GhResult<GhPullList>;
// The last answer, for the folder and branch it was asked about (a different one is never shown in its place).
let prData: { root: string; branch: string; res: PrList } | null = null;
// Bumped by every refreshPrs: an answer that comes back after another refresh began is dropped, so a slow answer for the
// branch you left cannot replace the one you are on. Opening a pull request has its own counter (prOpenGen), so that
// opening one cannot cancel the list's answer, nor a list refresh (window focus, any git change) the one being opened.
let prGen = 0;
let prOpenGen = 0;

const githubSignedIn = (): boolean => accounts.accounts.some(a => a.provider === 'GitHub');
const PR_STATUS_LABEL = { ready: 'Ready to merge', conflict: 'Has conflicts', checking: 'Checking for conflicts', draft: 'Draft' };
// GitHub's rate limit, with the local time it lifts at when GitHub said.
const prRateLimitText = (resetAt?: number | null): string => {
  const when = typeof resetAt === 'number' && resetAt > 0 ? new Date(resetAt * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  return when ? `GitHub's rate limit was reached. Try again after ${when}` : 'GitHub\'s rate limit was reached. Try again later';
};
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
  if (state === 'rate-limit') return note(esc(prRateLimitText(res && !res.ok ? res.resetAt : null)), act('Retry', 'retry'));
  if (state !== 'ok' || !res?.ok) return note('Couldn\'t load pull requests', act('Retry', 'retry'));
  if (!res.data.pulls.length) return note(`No open pull requests into ${esc(branch)}`);
  // Some rows' details couldn't be asked for: say why under them.
  const partial = res.data.partial === 'rate-limit' ? note('GitHub\'s rate limit was reached, so some statuses are missing')
    : res.data.partial === 'reauth' ? note('Your GitHub sign-in expired, so some statuses are missing', act('Sign in again', 'signin')) : '';
  return res.data.pulls.map(prRowHtml).join('') + partial;
}

// A different folder was opened (or the folder was closed): nothing on the page may still be about the last one.
function resetPrState(): void {
  prGen++; prOpenGen++; // answers still on their way are for the last folder
  prData = null;
  prMergeNote = null;
  endConflictPage();
  if (document.querySelector('#scmDetail')) scmEmptyDetail();
  paintPrs();
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
type PrTab = 'commits' | 'files' | 'comments' | 'conflict';
const GH_ERROR_COPY: Record<string, string> = { reauth: 'Your GitHub sign-in expired', 'signed-out': 'Sign in with GitHub to see pull requests', 'not-github': 'This repository isn\'t on GitHub', 'no-remote': 'No origin remote' };
// api.gh calls resolve to a GhResult, but a rejection (a broken IPC) must not leave a view on "Loading" for good.
const ghSafe = <T>(p: Promise<GhResult<T>>): Promise<GhResult<T>> => p.catch((e: unknown) => ({ ok: false, error: 'http', message: errMsg(e) }) as GhResult<T>);
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

/* ----- Pull requests: merging on GitHub ----- */
type PrMergeMethod = 'merge' | 'squash' | 'rebase';
const PR_MERGE_TIP: Record<string, string> = { conflict: 'Resolve the conflicts first', checking: 'GitHub is still checking this pull request' };
const PR_MERGE_ERROR_COPY: Record<string, string> = {
  'not-mergeable': 'GitHub can\'t merge this pull request right now',
  'head-changed': 'New commits were pushed while you were reviewing',
  forbidden: 'You don\'t have permission to merge here',
};
// The pull request being merged now (0: none; one merge at a time), and what the last failed merge said, shown in that
// pull request's header until it is opened again. Kept here, not in the detail, so that switching tabs doesn't lose either.
let prMerging = 0;
let prMergeNote: { n: number; text: string; reload: boolean } | null = null;

// A draft has no Merge button at all; the others have one that is only enabled when GitHub says the pull request is ready.
function prMergeBtnHtml(pr: GhPull): string {
  const st = prStatus(pr);
  if (st === 'draft') return '';
  const tip = PR_MERGE_TIP[st];
  return `<button class="btn btn-primary btn-sm" id="prMerge" aria-haspopup="menu"${st !== 'ready' || prMerging || prClosing ? ' disabled' : ''}${tip ? ` title="${escAttr(tip)}"` : ''}>${prMerging === pr.number ? 'Merging…' : 'Merge'}</button>`;
}
function prMergeNoteHtml(n: number): string {
  const m = prMergeNote?.n === n ? prMergeNote : null;
  return m ? `${esc(m.text)}${m.reload ? '<button class="btn btn-sm" data-pr-view="retry">Reload</button>' : ''}` : '';
}
// Brings the Merge button and the note under it up to date, if this pull request's detail is on screen.
function syncMergeUi(pr: GhPull): void {
  const view = document.querySelector(`#scmDetail .pr-view[data-n="${pr.number}"]`);
  const btn = view?.querySelector('#prMerge');
  if (btn) btn.outerHTML = prMergeBtnHtml(pr);
  const close = view?.querySelector('#prClose'); // one at a time: closing waits for a merge, and the other way round
  if (close) close.outerHTML = prCloseBtnHtml(pr);
  const note = view?.querySelector('#prMergeNote');
  if (note) note.innerHTML = prMergeNoteHtml(pr.number);
}

// The three ways GitHub can merge, each enabled when the repository allows it. If that can't be found out, all three are
// offered and GitHub refuses the one that isn't allowed.
async function openMergeMenu(pr: GhPull, btn: HTMLElement): Promise<void> {
  if (btn.dataset.asking) return;
  btn.dataset.asking = '1';
  const repo = await ghSafe(api.gh.repo());
  delete btn.dataset.asking;
  if (!btn.isConnected || prMerging) return;
  const allow = repo.ok ? repo.data : { allowMerge: true, allowSquash: true, allowRebase: true };
  const item = (label: string, method: PrMergeMethod, ok: boolean): MenuItem => ({ label, run: () => void mergePr(pr, method), enabled: () => ok });
  const r = btn.getBoundingClientRect();
  popupMenu(r.left, r.bottom + 4, [
    item('Create a merge commit', 'merge', allow.allowMerge),
    item('Squash and merge', 'squash', allow.allowSquash),
    item('Rebase and merge', 'rebase', allow.allowRebase),
  ], undefined, btn);
}

// Merges with the head the detail was rendered with: if commits were pushed since, GitHub refuses (head-changed) rather
// than merging something that was never reviewed.
async function mergePr(pr: GhPull, method: PrMergeMethod): Promise<void> {
  if (prMerging) return;
  const n = pr.number;
  const root = rootInfo?.root, gen = prOpenGen;
  // Still the same folder and the same opened detail (a folder switch bumps prOpenGen too).
  const shown = () => gen === prOpenGen && !!document.querySelector(`#scmDetail .pr-view[data-n="${n}"]`);
  prMerging = n;
  prMergeNote = null;
  syncMergeUi(pr);
  const res = await ghSafe(api.gh.merge(n, method, pr.head.sha));
  prMerging = 0;
  if (!res.ok || !res.data.merged) {
    const error = res.ok ? '' : res.error;
    const text = !res.ok && error === 'rate-limit' ? prRateLimitText(res.resetAt)
      : PR_MERGE_ERROR_COPY[error] ?? ((res.ok ? res.data.message : res.message) || 'Couldn\'t merge this pull request');
    if (shown()) { prMergeNote = { n, text, reload: error === 'head-changed' }; syncMergeUi(pr); } else toast(text);
    return;
  }
  toast(`Merged #${n}`);
  if (shown()) scmEmptyDetail(); // it is no longer open
  void refreshPrs(true);
  // The branch the pull request went into now has new commits on GitHub: bring them in when that's the branch checked out.
  if (rootInfo?.root === root && gitState.branch === pr.base) {
    try { await api.git.sync('pull'); } catch (e) { toast(`Merged #${n}, but pulling ${pr.base} failed: ${errMsg(e)}`); }
    await refreshGit();
  }
}

/* ----- Pull requests: closing without merging ----- */
let prClosing = 0; // the pull request being closed now (0: none)
function prCloseBtnHtml(pr: GhPull): string {
  return `<button class="btn btn-danger btn-sm" id="prClose"${prClosing || prMerging ? ' disabled' : ''}>${prClosing === pr.number ? 'Closing…' : 'Close'}</button>`;
}
function confirmClosePr(pr: GhPull): void {
  openModal(`<h3>Close pull request #${pr.number}?</h3>
    <p class="sub">${esc(pr.title)} won't be merged. It can be reopened on GitHub.</p>
    <div class="row end"><button class="btn" data-close>Cancel</button><button class="btn btn-danger" id="prCloseOk">Close pull request</button></div>`, m => {
    $('#prCloseOk', m).onclick = () => { closeModal(); void closePr(pr); };
  });
}
async function closePr(pr: GhPull): Promise<void> {
  if (prClosing || prMerging) return;
  const n = pr.number, gen = prOpenGen;
  const shown = () => gen === prOpenGen && !!document.querySelector(`#scmDetail .pr-view[data-n="${n}"]`);
  prClosing = n;
  prMergeNote = null;
  syncMergeUi(pr);
  const res = await ghSafe(api.gh.close(n));
  prClosing = 0;
  if (!res.ok || !res.data.closed) {
    const text = !res.ok && res.error === 'rate-limit' ? prRateLimitText(res.resetAt)
      : !res.ok && res.error === 'forbidden' ? 'You don\'t have permission to close this pull request'
      : (!res.ok && res.message) || 'Couldn\'t close this pull request';
    if (shown()) prMergeNote = { n, text, reload: false }; else toast(text);
    syncMergeUi(pr);
    return;
  }
  toast(`Closed #${n}`);
  if (shown()) scmEmptyDetail(); // it is no longer open
  void refreshPrs(true);
}

/* ----- Pull requests: the conversation ----- */
const PR_COMMENT_MAX = 65536; // GitHub's limit on a comment
function prCommentHtml(c: GhComment): string {
  const when = prAgo(c.createdAt);
  return `<div class="pr-cm"><div class="pr-cm-head">${prAvatar(c.author, c.avatar)}<b>${esc(c.author)}</b>${when ? `<span>${esc(when)}</span>` : ''}</div><div class="pr-cm-body">${esc(c.body)}</div></div>`;
}
function prCommentsHtml(comments: GhComment[]): string {
  const list = comments.length ? comments.map(prCommentHtml).join('') : '<p class="side-note pr-note">No comments yet</p>';
  return `<div class="pr-cms">${list}</div>
    <div class="pr-cm-dock"><div class="pr-cm-new" id="prCommentBox">
      <textarea id="prCommentText" rows="1" maxlength="${PR_COMMENT_MAX}" placeholder="Leave a comment (Ctrl+Enter to send)" aria-label="Leave a comment"></textarea>
      <div class="pr-cm-files" id="prCommentFiles"></div>
      <div class="pr-cm-row"><button class="icon-btn" id="prCommentAttach" title="Attach a Markdown or text file" aria-label="Attach a Markdown or text file">${svgIcon('paperclip', 15)}</button><span class="pr-hint pr-cm-note" id="prCommentNote" role="alert"></span><button class="btn btn-primary btn-sm" id="prCommentSend" disabled>Comment</button></div>
      <input type="file" id="prCommentPick" multiple hidden accept="text/*,.md,.markdown,.txt,.log,.json,.yaml,.yml,.csv,.toml,.ini,.xml">
      <div class="pr-cm-drop" aria-hidden="true">Drop Markdown or text files to attach</div>
    </div></div>`;
}

/* ----- Pull requests: attaching files to a comment ----- */
// GitHub's API can't upload files to a comment, so only text goes: a Markdown file's contents are added to the comment as
// they are, any other text file's in a code block. Images and binary files are refused.
interface PrAttach { name: string; text: string; }
const PR_ATTACH_MAX = 10;
const PR_IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|ico|svg|avif|heic|tiff?)$/i;
const PR_MD_FILE = /\.(md|markdown|mdx)$/i;
async function readPrAttachment(f: File): Promise<PrAttach | string> {
  if (f.type.startsWith('image/') || PR_IMAGE_FILE.test(f.name)) return `${f.name}: images can't be attached, only Markdown and text files`;
  if (f.size > PR_COMMENT_MAX * 4) return `${f.name} is too big for a GitHub comment`;
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(await f.arrayBuffer()); } catch { return `${f.name} isn't a text file`; }
  if (text.includes('\0')) return `${f.name} isn't a text file`;
  return { name: f.name, text: text.replace(/^﻿/, '').replace(/\r\n/g, '\n') };
}
function prAttachMarkdown(a: PrAttach): string {
  const title = `**${a.name.replace(/[\\`*_[\]<>#|]/g, '\\$&')}**`;
  if (PR_MD_FILE.test(a.name)) return `${title}\n\n${a.text.trim()}`;
  // A fence longer than any run of backticks inside, so the file can't end the block early.
  const longest = Math.max(0, ...(a.text.match(/`+/g) ?? []).map(s => s.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const lang = /\.([a-z0-9]+)$/i.exec(a.name)?.[1]?.toLowerCase() ?? '';
  return `${title}\n\n${fence}${lang === 'txt' || lang === 'log' ? '' : lang}\n${a.text.replace(/\n+$/, '')}\n${fence}`;
}
const prCommentBody = (draft: string, atts: PrAttach[]): string => [draft.trim(), ...atts.map(prAttachMarkdown)].filter(Boolean).join('\n\n');
function prAttachChipsHtml(atts: PrAttach[]): string {
  return atts.map((a, i) => `<span class="pr-cm-chip" title="${escAttr(a.name)}"><span class="ico">${fileIcon(a.name)}</span><span class="nm">${esc(a.name)}</span><button class="icon-btn" data-unattach="${i}" title="Remove ${escAttr(a.name)}" aria-label="Remove ${escAttr(a.name)}">${svgIcon('x', 12)}</button></span>`).join('');
}
// The box grows with what is typed, up to a limit, then scrolls.
function fitCommentBox(ta: HTMLTextAreaElement): void {
  ta.style.height = 'auto';
  const h = Math.min(ta.scrollHeight, 320);
  ta.style.height = `${h}px`;
  ta.style.overflowY = ta.scrollHeight > 320 ? 'auto' : 'hidden';
}

function prDetailShell(pr: GhPull, tab: PrTab, commits: GhResult<GhCommit[]>, files: GhResult<GhFile[]>, comments: GhResult<GhComment[]>): string {
  const st = prStatus(pr);
  const tabs: [PrTab, string, number | null][] = [['commits', 'Commits', commits.ok ? commits.data.length : null], ['files', 'Files', files.ok ? files.data.length : null], ['comments', 'Comments', comments.ok ? comments.data.length : null]];
  if (prHasConflict(pr)) tabs.push(['conflict', 'Conflict', null]); // a draft in conflict too; only Merge is hidden for drafts
  const when = prAgo(pr.createdAt);
  return `<div class="pr-head">
      <div class="pr-title"><h3>${esc(pr.title)}</h3><span class="pr-n">#${pr.number}</span>${pr.draft ? '<span class="pill">Draft</span>' : ''}</div>
      <div class="pr-meta"><span class="pr-st"><span class="pr-dot ${st}"></span>${PR_STATUS_LABEL[st]}</span><span class="pr-br">${esc(pr.head.label)} → ${esc(pr.base)}</span>${prAvatar(pr.author, pr.avatar)}<span>${esc(pr.author)}</span>${when ? `<span>${esc(when)}</span>` : ''}</div>
      <div class="pr-actions"><button class="btn btn-sm" data-ext="${escAttr(pr.url)}">Open on GitHub ${svgIcon('external', 12)}</button>${prMergeBtnHtml(pr)}${prCloseBtnHtml(pr)}</div>
      <div class="pr-merge-note" id="prMergeNote" role="alert">${prMergeNoteHtml(pr.number)}</div>
    </div>
    <div class="pr-tabs" role="tablist">${tabs.map(([k, label, n]) => `<button class="pr-tab ${k === tab ? 'on' : ''}" role="tab" aria-selected="${k === tab}" data-tab="${k}">${label}${n === null ? '' : ` <span class="count">${n}</span>`}</button>`).join('')}</div>
    <div class="pr-body" id="prBody"></div>`;
}

async function openPr(n: number): Promise<void> {
  const gen = ++prOpenGen;
  prMergeNote = null; // opening it again (or Reload) starts clean
  const shown =() => gen === prOpenGen && !!document.querySelector(`#scmDetail .pr-view[data-n="${n}"]`);
  showScmDetail(`<div class="pr-view" data-n="${n}"><div class="pr-loading"><div class="spinner sm"></div>Loading pull request #${n}</div></div>`);
  const [prRes, commits, files, comments] = await Promise.all([ghSafe(api.gh.pr(n)), ghSafe(api.gh.prCommits(n)), ghSafe(api.gh.prFiles(n)), ghSafe(api.gh.comments(n))]);
  if (!shown()) return; // another pull request, a file or the empty page took the right side meanwhile
  const view = document.querySelector<HTMLElement>('#scmDetail .pr-view') as HTMLElement;
  if (!prRes.ok) {
    const signIn = prRes.error === 'reauth' || prRes.error === 'signed-out';
    const known = prRes.error === 'rate-limit' ? prRateLimitText(prRes.resetAt) : GH_ERROR_COPY[prRes.error];
    view.innerHTML = `<div class="pr-loading pr-fail"><p>${esc(known ?? 'Couldn\'t load pull request')}</p>${prRes.message && !known ? `<p class="pr-hint">${esc(prRes.message)}</p>` : ''}<button class="btn btn-sm" data-pr-view="${signIn ? 'signin' : 'retry'}">${signIn ? (prRes.error === 'reauth' ? 'Sign in again' : 'Sign in') : 'Retry'}</button></div>`;
    view.onclick = e => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('[data-pr-view]')?.dataset.prView;
      if (a === 'signin') addAccount(); else if (a === 'retry') void openPr(n);
    };
    return;
  }
  let pr = prRes.data;
  let tab: PrTab = 'commits';
  const commitFiles = new Map<string, GhFile[]>();
  let draft = ''; // the comment being written and its attachments, kept across tab switches
  let atts: PrAttach[] = [];
  let sending = false;
  const commentBody = () => prCommentBody(draft, atts);
  // Brings the attachment chips, the Comment button and the note up to date. `note` replaces the note when given.
  const syncComposer = (note?: string): void => {
    const files = view.querySelector('#prCommentFiles'), btn = view.querySelector<HTMLButtonElement>('#prCommentSend'), nt = view.querySelector('#prCommentNote');
    if (files) files.innerHTML = prAttachChipsHtml(atts);
    const body = commentBody(), over = body.length > PR_COMMENT_MAX;
    if (btn) btn.disabled = sending || !body || over;
    if (nt && note !== undefined) nt.textContent = note;
    else if (nt && over) nt.textContent = 'This comment is too long for GitHub. Remove an attachment or shorten it';
    else if (nt && nt.textContent?.startsWith('This comment is too long')) nt.textContent = '';
  };
  const addAttachments = async (list: FileList | File[]): Promise<void> => {
    const problems: string[] = [];
    for (const f of [...list]) {
      if (atts.length >= PR_ATTACH_MAX) { problems.push(`At most ${PR_ATTACH_MAX} files can be attached`); break; }
      const r = await readPrAttachment(f);
      if (typeof r === 'string') problems.push(r); else atts.push(r);
    }
    if (shown()) syncComposer(problems.join('. '));
  };
  const fail = (what: string) => `<p class="side-note pr-note">Couldn't load ${what}<button class="btn btn-sm" data-pr-view="retry">Retry</button></p>`;

  const paintBody = (): void => {
    const body = $('#prBody', view);
    if (tab === 'files') {
      if (!files.ok) { body.innerHTML = fail('files'); return; }
      body.innerHTML = '<div class="pr-files"></div>';
      mountPrFiles($('.pr-files', body), files.data, `${pr.url}/files`);
    } else if (tab === 'comments') {
      if (!comments.ok) { body.innerHTML = fail('comments'); return; }
      body.classList.add('cm');
      body.innerHTML = prCommentsHtml(comments.data);
      const ta = $('#prCommentText', body) as HTMLTextAreaElement;
      ta.value = draft;
      fitCommentBox(ta);
      syncComposer();
      if (sending) { const b = $('#prCommentSend', body); b.textContent = 'Commenting…'; }
    } else if (tab === 'conflict') {
      const gone = pr.head.repo === null;
      body.innerHTML = `<div class="pr-conflict"><h4>This pull request has conflicts with ${esc(pr.base)}</h4><p>GitHub can't merge it until they are resolved.</p>
        <button class="btn btn-primary btn-sm" id="prResolve"${gone ? ' disabled title="The source repository no longer exists"' : ''}>Resolve conflicts</button>
        ${gone ? '<p class="pr-hint">The source repository no longer exists</p>' : ''}</div>`;
    } else {
      if (!commits.ok) { body.innerHTML = fail('commits'); return; }
      body.innerHTML = commits.data.length ? commits.data.map(c => `<div class="pr-commit" data-sha="${escAttr(c.sha)}">
        <div class="pr-commit-head" role="button" tabindex="0" aria-expanded="false"><span class="chev"><svg width="10" height="10"><use href="#i-chev"/></svg></span><span class="pr-cmsg">${esc(c.message.split('\n')[0])}</span><span class="pr-csub">${esc(c.author)}${c.date ? ` · ${esc(prAgo(c.date))}` : ''}</span><code>${esc(c.sha.slice(0, 7))}</code></div>
        <div class="pr-commit-body"></div></div>`).join('') : '<p class="side-note pr-note">No commits</p>';
    }
  };
  const paint = (): void => {
    view.innerHTML = prDetailShell(pr, tab, commits, files, comments);
    paintBody();
  };

  const toggleCommit = async (box: HTMLElement): Promise<void> => {
    const head = $('.pr-commit-head', box), body = $('.pr-commit-body', box);
    const open = !box.classList.contains('open');
    box.classList.toggle('open', open);
    head.setAttribute('aria-expanded', String(open));
    const sha = box.dataset.sha as string;
    if (!open || box.dataset.loaded) return;
    const cached = commitFiles.get(sha);
    if (cached) { mountPrFiles(body, cached, `${pr.url}/commits/${sha}`); box.dataset.loaded = '1'; return; }
    body.innerHTML = '<div class="pr-loading"><div class="spinner sm"></div>Loading files</div>';
    const r = await ghSafe(api.gh.commit(sha));
    if (!shown() || !body.isConnected) return;
    // Closing and opening the commit again asks again.
    if (!r.ok) { body.innerHTML = '<p class="pr-hint pr-inline">Couldn\'t load this commit\'s files. Close it and open it again to retry</p>'; return; }
    commitFiles.set(sha, r.data);
    mountPrFiles(body, r.data, `${pr.url}/commits/${sha}`);
    box.dataset.loaded = '1';
  };

  const sendComment = async (): Promise<void> => {
    const text = commentBody();
    if (sending || !text || text.length > PR_COMMENT_MAX || !comments.ok) return;
    sending = true;
    const btn0 = view.querySelector<HTMLButtonElement>('#prCommentSend');
    if (btn0) { btn0.disabled = true; btn0.textContent = 'Commenting…'; }
    syncComposer('');
    const r = await ghSafe(api.gh.comment(n, text));
    sending = false;
    if (!shown()) { if (!r.ok) toast('Couldn\'t post your comment'); return; }
    if (!r.ok) {
      const btn = view.querySelector<HTMLButtonElement>('#prCommentSend'); // the tab may have been redrawn meanwhile
      if (btn) btn.textContent = 'Comment';
      const msg = r.error === 'rate-limit' ? prRateLimitText(r.resetAt) : GH_ERROR_COPY[r.error] ?? (r.message || 'Couldn\'t post your comment');
      if (view.querySelector('#prCommentNote')) syncComposer(msg); else toast(msg);
      return;
    }
    comments.data.push(r.data);
    draft = '';
    atts = [];
    paint();
    if (tab === 'comments') view.querySelector('.pr-cms > .pr-cm:last-child')?.scrollIntoView({ block: 'nearest' });
  };
  view.oninput = e => {
    const ta = e.target as HTMLTextAreaElement;
    if (ta.id !== 'prCommentText') return;
    draft = ta.value;
    fitCommentBox(ta);
    syncComposer();
  };
  view.onchange = e => {
    const input = e.target as HTMLInputElement;
    if (input.id !== 'prCommentPick' || !input.files?.length) return;
    const picked = [...input.files];
    input.value = ''; // picking the same file again still fires
    void addAttachments(picked);
  };
  // Files dropped anywhere on the pull request are attached to the comment (the Comments tab opens for them). They are
  // only read: nothing is copied into the folder, and the page-wide drop handling never sees them.
  const fileDrag = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes('Files');
  const markDropBox = (on: boolean) => view.querySelector('#prCommentBox')?.classList.toggle('drag-over', on);
  view.ondragover = e => {
    if (!fileDrag(e)) return;
    e.preventDefault(); e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = comments.ok ? 'copy' : 'none';
    markDropBox(true);
  };
  view.ondragleave = e => { if (!view.contains(e.relatedTarget as Node | null)) markDropBox(false); };
  view.ondrop = e => {
    if (!fileDrag(e)) return;
    e.preventDefault(); e.stopPropagation();
    markDropBox(false);
    if (!comments.ok || !e.dataTransfer?.files.length) return;
    const dropped = [...e.dataTransfer.files];
    if (tab !== 'comments') { tab = 'comments'; paint(); }
    void addAttachments(dropped);
  };

  view.onclick = e => {
    const t = e.target as HTMLElement;
    if (t.closest('#prCommentSend')) { void sendComment(); return; }
    if (t.closest('#prCommentAttach')) { view.querySelector<HTMLInputElement>('#prCommentPick')?.click(); return; }
    const un = t.closest<HTMLElement>('[data-unattach]');
    if (un) { atts.splice(Number(un.dataset.unattach), 1); syncComposer(''); return; }
    const closeBtn = t.closest<HTMLElement>('#prClose');
    if (closeBtn) { if (!closeBtn.hasAttribute('disabled')) confirmClosePr(pr); return; }
    const tabBtn = t.closest<HTMLElement>('[data-tab]');
    if (tabBtn) { tab = tabBtn.dataset.tab as PrTab; paint(); return; }
    if (t.closest('[data-pr-view="retry"]')) { void openPr(n); return; }
    if (t.closest('#prResolve')) { if (!t.closest('#prResolve')?.hasAttribute('disabled')) void openConflictPage(pr); return; }
    const mergeBtn = t.closest<HTMLElement>('#prMerge');
    if (mergeBtn) { if (!mergeBtn.hasAttribute('disabled')) void openMergeMenu(pr, mergeBtn); return; }
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
    if ((e.target as HTMLElement).id === 'prCommentText') {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void sendComment(); }
      return;
    }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const head = (e.target as HTMLElement).closest<HTMLElement>('.pr-file-head, .pr-commit-head');
    if (head) { e.preventDefault(); head.click(); }
  };

  paint();

  // GitHub works out mergeability in the background, so a fresh pull request can still be unknown: ask once more shortly.
  if (prStatus(pr) === 'checking') {
    setTimeout(async () => {
      if (!shown()) return;
      const again = await ghSafe(api.gh.pr(n));
      if (!again.ok || !shown() || prStatus(again.data) === 'checking') return;
      pr = { ...again.data, head: pr.head }; // the commits and files on screen are for the head first loaded, and so is a merge
      if (prData?.res.ok) {
        const i = prData.res.data.pulls.findIndex(p => p.number === n);
        if (i >= 0) { prData.res.data.pulls[i] = pr; paintPrs(); }
      }
      if (tab === 'conflict' && !prHasConflict(pr)) tab = 'commits';
      paint();
    }, 2000);
  }
}

// "Open on GitHub" buttons anywhere in the detail.
$('#scmDetail').addEventListener('click', e => {
  const url = (e.target as HTMLElement).closest<HTMLElement>('[data-ext]')?.dataset.ext;
  if (url && /^https:\/\//.test(url)) background(api.sys.openExternal(url));
});
