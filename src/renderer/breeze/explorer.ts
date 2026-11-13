/* ================= Explorer ================= */
const GIT_LETTER: Record<string, string> = { 'git-m': 'M', 'git-u': 'U', 'git-a': 'A', 'git-d': 'D' };
const INCOMING_TAG = '<span class="gst gst-in" title="Changed on the remote · not pulled yet">M↓</span>';
function chevClass(e: DirEntry, open: boolean): string {
  if (!e.dir) return 'none';
  return open ? 'open' : '';
}
function isIgnoredPath(p: string, ignored: Set<string>): boolean {
  if (ignored.has(p) || p === '.git' || p.startsWith('.git/')) return true;
  let cur = p;
  while (cur.includes('/')) {
    cur = cur.slice(0, cur.lastIndexOf('/'));
    if (ignored.has(cur)) return true;
  }
  return false;
}
function splitFileName(filename: string): { base: string; ext: string } {
  const dot = filename.lastIndexOf('.');
  if (dot > 0 && dot < filename.length - 1) {
    return { base: filename.slice(0, dot), ext: filename.slice(dot) };
  }
  return { base: filename, ext: '' };
}

function fileNameHtml(filename: string): string {
  const { base, ext } = splitFileName(filename);
  if (!ext) return `<span class="nm-base">${esc(base)}</span>`;
  return `<span class="nm-base">${esc(base)}</span><span class="nm-ext">${esc(ext)}</span>`;
}

function treeRow(e: DirEntry, p: string, depth: number, decor: ReturnType<typeof gitDecor>, enter: boolean): string {
  const open = e.dir && expanded.has(p);
  const lock = locks[p];
  const lockTag = lock ? `<span class="lock tint-${lock.phase}" title="${escAttr(`${agentNameOf(lock.agent)} is editing this`)}">${agentsDef[lock.phase].name}</span>` : '';
  const g = e.dir ? (decor.dirs.has(p) && 'has-changes') || '' : decor.files.get(p) ?? '';
  const isIgnored = isIgnoredPath(p, decor.ignored);
  const gitTag = !e.dir && g && !lock ? `<span class="gst">${GIT_LETTER[g] ?? ''}</span>` : '';
  // Changed on the remote and not pulled yet; shows beside the local letter when both apply.
  const inTag = !e.dir && decor.incoming.has(p) && !lock ? INCOMING_TAG : '';
  const cls = ['tree-item', p === active || (e.dir && p === treeSel) ? 'on' : '', isDirty(buffers.get(p)) ? 'dirty' : '', p === ctxPath ? 'ctx' : '', g, e.dir && decor.incomingDirs.has(p) ? 'has-incoming' : '', isIgnored ? 'git-ignored' : '', enter ? 'enter' : ''].filter(Boolean).join(' ');
  const icon = e.dir ? folderIcon(e.name, open) : fileIcon(p);
  const nameHtml = e.dir ? `<span class="nm-base">${esc(e.name)}</span>` : fileNameHtml(e.name);
  const renaming = treeEdit?.rename === p;
  return `<div class="${cls}" data-depth="${depth}" data-path="${escAttr(p)}" ${e.dir ? 'data-dir="1" ' : ''}draggable="${!renaming}" title="${escAttr(p)}">
    <span class="chev ${chevClass(e, open)}">${CHEV}</span><span class="ico">${icon}</span>${renaming ? treeInputHtml(`Rename ${e.name}`) : `<span class="nm">${nameHtml}</span>`}${lockTag}${gitTag}${inTag}</div>`;
}
// Off: a .js compiled from a .ts beside it (generatedFiles, treecore.ts) is left out of the tree. The tree's right-click
// menu turns it on.
let showGenerated = store.get<boolean>('breeze.showGenerated', false);
function toggleGenerated(): void {
  showGenerated = !showGenerated;
  store.set('breeze.showGenerated', showGenerated);
  renderTreeAnimated();
}
function renderTree(): void {
  const el = $('#tree');
  if (!rootInfo) {
    if (restoringWorkspace) { el.innerHTML = skeletonRows(9); return; }
    el.innerHTML = `<div class="side-note">You have not opened a folder yet.<button class="btn btn-primary btn-sm" data-act="file.openFolder">Open Folder</button></div><div id="recentList"></div>`;
    void renderRecent();
    return;
  }
  const rows: string[] = [];
  const decor = gitDecor();
  const walk = (rel: string, depth: number) => {
    if (treeEdit && treeEdit.rename == null && treeEdit.dir === rel) rows.push(treeEditRow(depth)); // a new entry's name box tops its folder
    const list = dirCache.get(rel) ?? [];
    const generated = showGenerated ? null : generatedFiles(list);
    for (const e of list) {
      const p = joinPath(rel, e.name);
      if (generated?.has(e.name) && p !== active) continue; // compiled output beside its .ts; the open file always shows
      const isEntering = !!justExpanded && (rel === justExpanded || rel.startsWith(justExpanded + '/'));
      rows.push(treeRow(e, p, depth, decor, isEntering));
      if (e.dir && expanded.has(p)) walk(p, depth + 1);
    }
  };
  walk('', 0);
  // A name box survives redraws (the watcher, git) with its text and caret.
  const typing = $<HTMLInputElement>('#treeEditIn', el);
  if (typing && treeEdit) { treeEdit.value = typing.value; treeEdit.sel = [typing.selectionStart ?? 0, typing.selectionEnd ?? 0]; }
  treeRendering = true;
  // Git and the watcher redraw often and usually change nothing, so unchanged rows are kept as they are.
  if (rows.length) patchRows(el, rows);
  else el.innerHTML = '<p class="side-note">This folder is empty.</p>';
  treeRendering = false;
  // Indentation is set through the DOM: the CSP allows no inline style attributes. Kept rows have theirs.
  for (const row of $$('[data-depth]', el)) if (!row.style.paddingLeft) row.style.paddingLeft = `${4 + Number(row.dataset.depth) * 12}px`;
  justExpanded = null;
  bindTreeEdit(el);
}

/* ----- Naming in place: new files and folders and renames get a name box right in the tree, like VS Code ----- */
interface TreeEdit { dir: string; folder: boolean; rename?: string; value: string; sel: [number, number]; shown?: boolean; done: (name: string | null) => void }
let treeEdit: TreeEdit | null = null;
let treeRendering = false; // the box leaving in a redraw isn't the user clicking away
const treeInputHtml = (label: string) => `<input class="tree-input" id="treeEditIn" aria-label="${escAttr(label)}" spellcheck="false" autocomplete="off">`;
function treeEditRow(depth: number): string {
  const ed = treeEdit as TreeEdit;
  return `<div class="tree-item tree-edit" data-depth="${depth}"><span class="chev none">${CHEV}</span><span class="ico">${ed.folder ? folderIcon('', false) : fileIcon('untitled')}</span>${treeInputHtml(ed.folder ? 'New folder name' : 'New file name')}</div>`;
}
function bindTreeEdit(el: HTMLElement): void {
  const ed = treeEdit;
  if (!ed) return;
  const input = $<HTMLInputElement>('#treeEditIn', el);
  if (!input) { treeEdit = null; ed.done(null); return; } // its row is gone (the folder closed, the file was deleted)
  input.value = ed.value;
  if (!ed.shown) { ed.shown = true; growTreeEdit(input, ed, false); } // not again on redraws
  input.focus();
  input.setSelectionRange(...ed.sel);
  input.scrollIntoView({ block: 'nearest' });
  input.onkeydown = e => {
    e.stopPropagation(); // the tree's own keys (Delete removes the selected row) stay out of it
    if (e.key === 'Enter') { e.preventDefault(); endTreeEdit(input.value.trim() || null); }
    else if (e.key === 'Escape') { e.preventDefault(); endTreeEdit(null); }
  };
  // Clicking away keeps what was typed, as in VS Code; an empty box just goes.
  input.onblur = () => { if (!treeRendering) endTreeEdit(input.value.trim() || null); };
}
function endTreeEdit(name: string | null): void {
  const ed = treeEdit;
  if (!ed) return;
  treeEdit = null;
  const finish = () => { renderTree(); ed.done(name); };
  const input = $<HTMLInputElement>('#treeEditIn');
  const ms = input ? growTreeEdit(input, ed, true) : 0;
  if (ms) setTimeout(finish, ms); else finish(); // a timer, since a redraw meanwhile drops the animation
}
// A new entry's row opens up from nothing (and closes back); a rename's box widens out of the name (and back in).
// Returns how long it runs.
function growTreeEdit(input: HTMLInputElement, ed: TreeEdit, out: boolean): number {
  const row = input.closest<HTMLElement>('.tree-item');
  const timing: KeyframeAnimationOptions = { duration: out ? 150 : 200, easing: 'cubic-bezier(.2, .8, .2, 1)', direction: out ? 'reverse' : 'normal', fill: out ? 'forwards' : 'none' };
  input.animate([{ borderColor: 'transparent' }], timing); // its blue edge fades with it, never a lone blue line
  if (ed.rename == null && row) {
    const cs = getComputedStyle(row);
    row.style.overflow = 'hidden';
    row.animate([
      { height: '0px', paddingBlock: '0px', borderBlockWidth: '0px', opacity: 0, transform: 'scale(.96)' },
      { height: cs.height, paddingBlock: cs.paddingTop, borderBlockWidth: cs.borderTopWidth, opacity: 1, transform: 'none' },
    ], timing).onfinish = () => { if (!out) row.style.overflow = ''; };
  } else {
    input.animate([{ opacity: 0, transform: 'scaleX(.4)' }, { opacity: 1, transform: 'none' }], timing);
  }
  return timing.duration as number;
}
// The name box in the tree when the explorer is showing (opening the folders it sits in), else the dialog.
async function nameInTree(edit: { dir: string; folder: boolean; rename?: string }, title: string, initial: string, okLabel: string): Promise<string | null> {
  if (!rootInfo || !$('#tree').offsetParent) return askName(title, initial, okLabel);
  endTreeEdit(null); // a box already open gives way
  const dirs: string[] = [];
  for (let d = edit.rename != null ? dirName(edit.rename) : edit.dir; d; d = dirName(d)) dirs.push(d);
  dirs.forEach(d => expanded.add(d));
  await Promise.all(dirs.filter(d => !dirCache.has(d)).map(loadDir));
  const dot = initial.lastIndexOf('.');
  return new Promise(done => {
    treeEdit = { ...edit, value: initial, sel: [0, dot > 0 ? dot : initial.length], done };
    renderTree();
  });
}

function captureTreePositions(): Map<string, number> {
  const map = new Map<string, number>();
  const rows = $$<HTMLElement>('#tree .tree-item[data-path]');
  for (const r of rows) {
    const p = r.dataset.path;
    if (p) map.set(p, r.getBoundingClientRect().top);
  }
  return map;
}

function playTreeAnimation(oldPositions: Map<string, number>): void {
  const rows = $$<HTMLElement>('#tree .tree-item[data-path]');
  for (const r of rows) {
    const p = r.dataset.path;
    if (!p) continue;
    if (oldPositions.has(p)) {
      const oldTop = oldPositions.get(p)!;
      const newTop = r.getBoundingClientRect().top;
      const dy = oldTop - newTop;
      if (Math.abs(dy) > 1) {
        r.animate([
          { transform: `translateY(${dy}px)` },
          { transform: 'translateY(0)' },
        ], {
          duration: 220,
          easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
        });
      }
    } else if (!r.classList.contains('enter')) {
      r.animate([
        { opacity: 0, transform: 'scale(0.96) translateY(-4px)' },
        { opacity: 1, transform: 'scale(1) translateY(0)' },
      ], {
        duration: 180,
        easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      });
    }
  }
}

function renderTreeAnimated(): void {
  const oldPositions = captureTreePositions();
  renderTree();
  playTreeAnimation(oldPositions);
}

// The folder whose children should animate in on the next render.
let justExpanded: string | null = null;
async function renderRecent(): Promise<void> {
  const recent = await api.fs.recent().catch(() => []);
  const el = document.getElementById('recentList');
  if (!el || !recent.length) return;
  const rows = recent.map(r => `<div class="tree-item" data-recent="${escAttr(r.path)}" title="${escAttr(r.path)}"><span class="ico">${svgIcon('chevronRight', 14)}</span><span class="nm">${esc(r.name)}</span></div>`);
  el.innerHTML = '<div class="side-head pl-8">Recent</div>' + rows.join('');
}
$('#tree').addEventListener('click', e => {
  if ((e.target as HTMLElement).closest('.tree-input')) return; // clicking into a name box
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-path],[data-recent],[data-act]');
  if (!t || t.dataset.act) return; // data-act buttons are handled by the global listener
  if (t.dataset.recent) { void openRecentFolder(t.dataset.recent); return; }
  const p = t.dataset.path as string;
  treeSel = p;
  if (t.dataset.dir) void toggleDir(p); else openFile(p);
});
// The row last clicked in the explorer (a file or a folder); Delete removes it while the explorer has focus.
let treeSel: string | null = null;
$('#tree').addEventListener('keydown', e => {
  if (e.key !== 'Delete' || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !rootInfo) return;
  const p = treeSel ?? active;
  const row = p ? $(`#tree .tree-item[data-path="${escAttr(p)}"]`) : null;
  if (!p || !row) return;
  e.preventDefault();
  deleteEntry(p, !!row.dataset.dir);
});
$('#tree').addEventListener('dragstart', e => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-path][draggable="true"]');
  if (!row) return;
  draggedTreePath = row.dataset.path as string;
  draggedTreeIsDir = !!row.dataset.dir;
  forgetRow(row);
  row.classList.add('dragging');
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'all';
    e.dataTransfer.setData('text/plain', draggedTreePath);
    e.dataTransfer.setData('application/x-breeze-tree-path', draggedTreePath);
    e.dataTransfer.setData('application/x-breeze-is-dir', draggedTreeIsDir ? '1' : '0');

    // The browser's own drag image is a flat bitmap, so it can't blur what's behind it. It is swapped for an
    // empty image and a real element follows the pointer instead, with a backdrop blur.
    let ghost = document.getElementById('breezeDragGhost');
    if (!ghost) {
      ghost = document.createElement('div');
      ghost.id = 'breezeDragGhost';
      ghost.className = 'drag-file-ghost';
      document.body.appendChild(ghost);
    }
    const name = draggedTreePath.split('/').pop() || draggedTreePath;
    const iconHtml = draggedTreeIsDir ? folderIcon(name, false) : fileIcon(name);
    ghost.innerHTML = `<span class="ico">${iconHtml}</span><span class="nm">${esc(name)}</span>`;
    e.dataTransfer.setDragImage(emptyDragImage, 0, 0);
    moveDragGhost(e.clientX, e.clientY);
    ghost.classList.add('on');
  }
});
const emptyDragImage = new Image();
emptyDragImage.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
function moveDragGhost(x: number, y: number): void {
  const ghost = document.getElementById('breezeDragGhost');
  if (!ghost) return;
  const r = ghost.getBoundingClientRect();
  ghost.style.transform = `translate(${x - Math.min(28, r.width / 2)}px, ${y - r.height / 2}px)`;
}
function hideDragGhost(): void {
  document.getElementById('breezeDragGhost')?.classList.remove('on');
}
document.addEventListener('dragover', e => {
  if (draggedTreePath) moveDragGhost(e.clientX, e.clientY);
  // The wheel doesn't scroll during a drag, so the explorer scrolls itself while the pointer is near its top or
  // bottom edge, faster the closer it gets (dragover keeps firing while the pointer rests).
  const tree = $('#tree');
  const r = tree.getBoundingClientRect();
  const EDGE = 48;
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top - EDGE || e.clientY > r.bottom + EDGE) return;
  const d = e.clientY < r.top + EDGE ? e.clientY - (r.top + EDGE) : Math.max(0, e.clientY - (r.bottom - EDGE));
  if (d) tree.scrollTop += clamp(d, -EDGE, EDGE) / 3;
}, true);
document.addEventListener('drop', hideDragGhost, true);
$('#tree').addEventListener('dragend', e => {
  hideDragGhost();
  (e.target as HTMLElement).closest<HTMLElement>('[data-path]')?.classList.remove('dragging');
  draggedTreePath = null;
  draggedTreeIsDir = false;
  markDrop(null);
  clearTreeDropMarks();
  clearAgentDropMarks();
});
document.addEventListener('dragend', () => {
  for (const el of $$<HTMLElement>('#tree .tree-item.dragging')) el.classList.remove('dragging');
  draggedTreePath = null;
  draggedTreeIsDir = false;
  markDrop(null);
  clearTreeDropMarks();
  clearAgentDropMarks();
});
$('#tree').addEventListener('contextmenu', e => {
  e.preventDefault();
  if ((e.target as HTMLElement).closest('.tree-input')) return; // right-clicking a name box keeps it open
  if (!rootInfo) return;
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-path]');
  const p = t?.dataset.path ?? '';
  const isDir = !t || !!t.dataset.dir;
  ctxPath = p || null; renderTree();
  const dir = isDir ? p : dirName(p);
  // The project root keeps the OS's own separators (backslashes on Windows), so the full path uses them too.
  const sep = rootInfo.root.includes('\\') ? '\\' : '/';
  const absPath = rootInfo.root.replace(/[\\/]+$/, '') + sep + p.replaceAll('/', sep);
  const fileItems: MenuItem[] = p ? [
    ...(isDir ? [] : [{ label: 'Open in Split View', run: () => background(openFileInSplit(p)) }]),
    { label: 'Reveal in File Explorer', run: () => background(api.fs.reveal(p)) },
    { sep: true },
    { label: 'Cut', run: () => { treeClip = { path: p, cut: true }; toast(`Cut ${baseName(p)}`); } },
    { label: 'Copy', run: () => { treeClip = { path: p, cut: false }; toast(`Copied ${baseName(p)}`); } },
  ] : [];
  const pasteItem: MenuItem[] = [{ label: treeClip ? `Paste ${baseName(treeClip.path)}` : 'Paste', enabled: () => !!treeClip, run: () => background(pasteEntry(dir)) }];
  const restItems: MenuItem[] = p ? [
    { sep: true },
    { label: 'Rename', key: 'F2', run: () => background(renameEntry(p)) },
    { label: 'Delete', key: 'Delete', run: () => deleteEntry(p, isDir) },
    { sep: true },
    { label: 'Copy Absolute Path', run: () => background(navigator.clipboard.writeText(absPath).then(() => toast('Path copied'))) },
    { label: 'Copy Relative Path', run: () => background(navigator.clipboard.writeText(p).then(() => toast('Path copied'))) },
    { sep: true },
    { label: 'Add to .gitignore', run: () => background(addToGitignore(p, isDir)) },
    ...(isDir ? [] : [{ label: 'Git History', run: () => background(showFileHistory(p)) }]),
    { sep: true },
    { label: 'Attach to Agent Chat', run: () => background(attachToAgentChat(p, isDir)) },
  ] : [];
  popupMenu(e.clientX, e.clientY, [
    { label: 'New File', run: () => background(newEntry(dir, false)) },
    { label: 'New Folder', run: () => background(newEntry(dir, true)) },
    ...fileItems,
    ...(p ? [] : [{ sep: true }]),
    ...pasteItem,
    ...restItems,
    { sep: true },
    { label: 'Show Generated Files', checked: () => showGenerated, run: toggleGenerated },
  ], () => { ctxPath = null; renderTree(); });
});
async function toggleDir(p: string): Promise<void> {
  const rowEl = $(`#tree .tree-item[data-path="${escAttr(p)}"]`);
  const isClosing = expanded.has(p);
  if (rowEl) {
    forgetRow(rowEl);
    const chevEl = rowEl.querySelector('.chev');
    const icoEl = rowEl.querySelector('.ico');
    if (chevEl) chevEl.classList.toggle('open', !isClosing);
    if (icoEl) {
      const name = p.split('/').pop() || p;
      icoEl.innerHTML = folderIcon(name, !isClosing);
    }
  }

  if (isClosing) {
    const prefix = p + '/';
    const childRows = $$<HTMLElement>('#tree .tree-item', $('#tree')).filter(r => (r.dataset.path ?? '').startsWith(prefix));
    if (childRows.length > 0) {
      childRows.forEach(r => { forgetRow(r); r.classList.add('leaving'); });
      await new Promise(r => setTimeout(r, 130));
    }
    expanded.delete(p);
  } else {
    expanded.add(p);
    if (!dirCache.has(p)) await loadDir(p);
    justExpanded = p;
  }
  renderTreeAnimated(); saveSession();
}
async function refreshTree(): Promise<void> {
  if (!rootInfo) return;
  await Promise.all(['', ...expanded].map(loadDir));
  renderTreeAnimated();
}
// The folder new files go into: right-clicked folder, else the active file's folder, else the root.
const targetDir = () => (active ? dirName(active) : '');

// Wraps a promise's resolve so only the first answer counts (a dialog can be confirmed and then closed).
function settleOnce<T>(resolve: (v: T) => void): (v: T) => void {
  let done = false;
  return v => {
    if (done) return;
    done = true;
    resolve(v);
  };
}
function askName(title: string, initial: string, okLabel: string): Promise<string | null> {
  return new Promise(res => {
    const finish = settleOnce(res);
    openModal(`<h3>${esc(title)}</h3><input class="input name-input" id="nameIn" aria-label="${escAttr(title)}" spellcheck="false" value="${escAttr(initial)}">
      <div class="row end"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="nameOk">${okLabel}</button></div>`, m => {
      const input = $<HTMLInputElement>('#nameIn', m);
      input.focus();
      const dot = initial.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : initial.length);
      const ok = () => { const v = input.value.trim(); if (v) { finish(v); closeModal(); } };
      $('#nameOk', m).onclick = ok;
      // Kept from the default action: focus may have moved to an editor by then, which would take the Enter as a line.
      input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); ok(); } };
    }, () => finish(null));
  });
}
async function newEntry(dir: string, folder: boolean): Promise<void> {
  if (!rootInfo) { toast('Open a folder first'); return; }
  const name = await nameInTree({ dir, folder }, folder ? 'New folder' : 'New file', '', 'Create');
  if (!name) return;
  const rel = joinPath(dir, name.replaceAll('\\', '/').replace(/^\/+/, ''));
  try {
    if (folder) await api.fs.createDir(rel); else await api.fs.createFile(rel);
  } catch (e) { toast(errMsg(e)); return; }
  for (let d = dirName(rel); d; d = dirName(d)) expanded.add(d);
  if (folder) expanded.add(rel);
  await refreshTree(); saveSession();
  if (!folder) openFile(rel);
}
async function renameEntry(p: string): Promise<void> {
  const name = await nameInTree({ dir: dirName(p), folder: false, rename: p }, 'Rename', baseName(p), 'Rename');
  if (!name || name === baseName(p)) return;
  if (/[\\/]/.test(name)) { toast('Names cannot contain slashes'); return; }
  if (bigMoveRefused(p)) return;
  const to = joinPath(dirName(p), name);
  const dir = dirName(p);
  if (treeOrder[dir]) {
    treeOrder[dir] = treeOrder[dir].map(n => n === baseName(p) ? name : n);
    saveTreeOrder(dir, treeOrder[dir]);
  }
  await moveEntry(p, to);
}
async function moveEntry(p: string, to: string): Promise<void> {
  if (p === to || bigMoveRefused(p)) return;
  try { await api.fs.rename(p, to); } catch (e) { toast(errMsg(e)); return; }
  const move = (x: string) => {
    if (x === p) return to;
    return x.startsWith(p + '/') ? to + x.slice(p.length) : x;
  };
  renameMarks(move);
  renameBreakpoints(move);
  const moved = [...buffers.values()].filter(b => move(b.path) !== b.path);
  // A document is closed as its path changes, so no save in the awaits below writes the old path (and makes that
  // file again); a save meanwhile opens one at the new path. Each reopens at the end.
  const reopen = moved.filter(b => b.doc != null);
  for (const b of moved) {
    const from = b.path;
    if (b.doc != null) docClose(b);
    buffers.delete(b.path); b.path = move(b.path); buffers.set(b.path, b);
    scheduleLint(b, 0); lspRenamed(from, b);
  }
  await Promise.all(moved.filter(b => b.kind === 'image' || b.kind === 'video').map(async b => { b.url = await api.fs.fileUrl(b.path).catch(() => ''); }));
  await Promise.all(moved.filter(b => b.kind === 'pdf').map(async b => { b.url = await api.fs.previewUrl(b.path).catch(() => ''); }));
  await Promise.all(moved.filter(b => b.big).map(bigMoved)); // clean ones only: dirty ones were refused above
  // The engine's text at the new path is read (it may have changed on disk), and the page's, unsaved edits and all,
  // synced onto it. One a save already opened is left alone.
  await Promise.all(reopen.filter(b => b.doc == null && !b.docSkip && buffers.get(b.path) === b).map(b => docOpen(b, null)));
  openTabs = openTabs.map(move);
  if (active) active = move(active);
  const dirs = [...expanded];
  expanded.clear();
  for (const d of dirs) expanded.add(move(d));
  dirCache.clear();
  await refreshTree(); renderTabs(); renderEditor(); saveSession();
}
const binName = () => (isDesktop && navigator.userAgent.includes('Windows') ? 'Recycle Bin' : 'Trash');
// No confirm: it goes to the Recycle Bin, and Ctrl+Z puts it straight back (undoAppAction, 'tree-delete').
function deleteEntry(p: string, isDir: boolean): void {
  background((async () => {
    const prev = treeOrder[dirName(p)];
    let stash: string | null;
    try { stash = await trashEntry(p); } catch (e) { toast(errMsg(e)); return; }
    pushAppAction({ type: 'tree-delete', path: p, isDir, stash, prevOrder: prev && [...prev], name: baseName(p) });
    toast(`Moved ${baseName(p)} to the ${binName()} · Ctrl+Z to undo`);
  })());
}
// Moves `p` to the bin and keeps an undo copy; returns that copy's id.
async function trashEntry(p: string): Promise<string | null> {
  const stash = await api.fs.trash(p, true);
  const dir = dirName(p);
  if (treeOrder[dir]) {
    treeOrder[dir] = treeOrder[dir].filter(n => n !== baseName(p));
    saveTreeOrder(dir, treeOrder[dir]);
  }
  for (const path of openTabs.filter(x => x === p || x.startsWith(p + '/'))) dropTab(path);
  expanded.delete(p);
  if (treeSel === p || treeSel?.startsWith(p + '/')) treeSel = null;
  await refreshTree(); renderTabs(); renderEditor(); saveSession();
  return stash;
}

/* ----- Explorer menu: clipboard, git, agent ----- */
// What Cut or Copy picked, waiting for Paste. Only inside this project, so it lives here rather than on the OS clipboard.
let treeClip: { path: string; cut: boolean } | null = null;

// "a.js" → "a copy.js", then "a copy 2.js", … until it's a name `taken` (lowercased) doesn't have.
function freeName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 1; ; n++) {
    const candidate = `${stem} copy${n > 1 ? ' ' + n : ''}${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
async function pasteEntry(dir: string): Promise<void> {
  const clip = treeClip;
  if (!clip) return;
  const src = clip.path;
  if (dir === src || dir.startsWith(src + '/')) { toast("A folder can't be pasted inside itself"); return; }
  if (clip.cut && dirName(src) === dir) { treeClip = null; return; } // cut and pasted back where it was
  let taken: Set<string>;
  try { taken = new Set((await api.fs.readDir(dir)).map(x => x.name.toLowerCase())); } catch (e) { toast(errMsg(e)); return; }
  const to = joinPath(dir, freeName(baseName(src), taken));
  if (clip.cut) {
    if (bigMoveRefused(src)) return;
    treeClip = null;
    await moveEntry(src, to);
  } else {
    try { await api.fs.copy(src, to); } catch (e) { toast(errMsg(e)); return; }
    for (let d = dir; d; d = dirName(d)) expanded.add(d);
    await refreshTree(); saveSession();
  }
  toast(`${clip.cut ? 'Moved' : 'Pasted'} ${baseName(to)}`);
}

const diffBody = (lines: string[]): string =>
  lines.map(l => `<div class="dl ${diffLineClass(l)}">${esc(l) || ' '}</div>`).join('') || '<div class="dl">No textual changes.</div>';

async function addToGitignore(p: string, isDir: boolean): Promise<void> {
  const entry = `/${p}${isDir ? '/' : ''}`;
  let text = '';
  try { text = (await api.fs.readFile('.gitignore')).text ?? ''; } catch { /* no .gitignore yet: this makes one */ }
  const lines = text.split(/\r?\n/).map(l => l.trim());
  if (lines.includes(entry) || lines.includes(entry.slice(1))) { toast(`${entry} is already in .gitignore`); return; }
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const next = text + (text && !text.endsWith('\n') ? nl : '') + entry + nl;
  try { await api.fs.writeFile('.gitignore', next); } catch (e) { toast(errMsg(e)); return; }
  const open = buffers.get('.gitignore');
  if (open?.kind === 'text' && !isDirty(open)) await reloadText(open);
  if (!dirCache.has('') || !(dirCache.get('') ?? []).some(x => x.name === '.gitignore')) await refreshTree();
  queueGitRefresh();
  toast(`Added ${entry} to .gitignore`);
}

async function showFileHistory(p: string): Promise<void> {
  let commits: { hash: string; author: string; when: string; subject: string }[];
  try { commits = await api.git.fileLog(p); } catch (e) { toast(/not a git repository/i.test(errMsg(e)) ? 'This folder is not a git repository' : errMsg(e)); return; }
  if (!commits.length) { toast(`${baseName(p)} has no commits yet`); return; }
  const list = commits.map(c => `<button class="fh-row" type="button" data-hash="${escAttr(c.hash)}"><span class="fh-hash">${esc(c.hash.slice(0, 7))}</span><span class="fh-subj">${esc(c.subject)}</span><span class="fh-meta">${esc(c.author)} · ${esc(c.when)}</span></button>`).join('');
  openModal(`<div class="diff-head"><span class="ico">${fileIcon(p)}</span><b>${esc(p)}</b><span class="pill" id="fhPill">${plural(commits.length, 'commit')}</span></div>
    <div class="file-history" id="fhList">${list}</div>
    <div class="diff" id="fhDiff" hidden></div>
    <div class="row end mt-12"><button class="btn" id="fhBack" hidden>Back</button><button class="btn" id="fhOpen">Open File</button><button class="btn btn-primary" data-close>Close</button></div>`, m => {
    const listEl = $('#fhList', m), diffEl = $('#fhDiff', m), back = $('#fhBack', m), pill = $('#fhPill', m);
    const showList = () => { listEl.hidden = false; diffEl.hidden = true; back.hidden = true; pill.textContent = plural(commits.length, 'commit'); };
    back.onclick = showList;
    $('#fhOpen', m).onclick = () => { closeModal(); openFile(p); };
    listEl.onclick = ev => {
      const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-hash]');
      if (!row) return;
      const hash = row.dataset.hash as string;
      background((async () => {
        let text: string;
        try { text = await api.git.fileShow(hash, p); } catch (e) { toast(errMsg(e)); return; }
        const lines = text.split('\n').filter(l => !/^(?:diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (?:from|to) )/.test(l));
        diffEl.innerHTML = diffBody(lines);
        listEl.hidden = true; diffEl.hidden = false; back.hidden = false;
        pill.textContent = hash.slice(0, 7);
      })());
    };
  }, undefined, 'top');
}

// Opens the agent panel if it's closed, then attaches like dragging the item onto the chat does.
async function attachToAgentChat(p: string, isDir: boolean): Promise<void> {
  if (surface.name === 'ide' && !layout.agentsOpen) { layout.agentsOpen = true; applyLayoutAnimated(); }
  await attachPathToAgent(p, isDir, surface);
}

// Files changed on disk (by an agent, git or another editor): reload what isn't being edited.
async function reloadImage(b: EditorBuffer): Promise<void> {
  // Same file URL, new query: the viewer reloads the picture.
  const url = b.url ?? '';
  const q = url.indexOf('?');
  b.url = `${q === -1 ? url : url.slice(0, q)}?v=${Date.now()}`;
  b.size = (await api.fs.readFile(b.path).catch(() => null))?.size ?? b.size;
  if (b.path === active) renderEditor();
}
async function reloadText(b: EditorBuffer): Promise<void> {
  const r = await api.fs.readFile(b.path).catch(() => null); // deleted or unreadable: keep the buffer
  if (r?.text == null) return;
  // As readBuffer reads it: a leading byte order mark stays out of the text (the engine keeps it out too).
  const plain = stripBom(r.text);
  const bom = plain.length !== r.text.length;
  // The engine keeps the byte order mark it opened with, and the page's text doesn't show it, so a mark added or
  // removed on disk reaches the engine only by opening the file again (the page's text is then synced onto it).
  if (bom !== !!b.bom && b.doc != null) { docClose(b); void docOpen(b, null); }
  b.bom = bom;
  const text = plain.replaceAll('\r\n', '\n');
  if (typingTo.has(b.path)) { typingTo.set(b.path, text); return; } // the running animation heads for the newest text
  if (text === b.saved) { b.disk = undefined; return; }
  if (holdsUserEdits(b)) {
    // Keep the unsaved edits, but remember the disk changed so saving asks before overwriting it.
    if (text === b.text) { b.saved = text; b.disk = undefined; renderTabs(); renderTree(); return; }
    if (b.disk !== text) toast(`${baseName(b.path)} changed on disk. Your unsaved edits are kept.`);
    b.disk = text;
    return;
  }
  b.disk = undefined;
  // While an agent works, its edits are typed out instead of swapped in.
  if (hasAnyActiveRun()) { void typeAgentEdit(b, text); return; }
  remember(b, 'reload');
  const before = b.text;
  b.text = b.saved = text;
  docSync(b, before, b.text); // as edits, not doc:reload: a second read of the file could see another version
  if (b.ta) { const s = b.ta.selectionStart; b.ta.value = text; b.ta.setSelectionRange(s, s); }
  if (b.path === active) renderCode();
  scheduleLint(b, 0);
}
/* ----- Agent edits, typed out: the old text goes, the new text arrives a few characters at a time ----- */
const typingTo = new Map<string, string>();   // path -> the text the animation is heading for
const typingCaret = new Map<string, number>(); // path -> where the agent's caret is while it types
const sleepMs = (ms: number) => new Promise<void>(res => setTimeout(res, ms));
// Unsaved edits that agent changes must not overwrite. A blank "edit" (an emptied or restored-empty tab)
// holds nothing worth keeping, so while an agent works its edits still type out there.
const holdsUserEdits = (b: EditorBuffer) => isDirty(b) && !(hasAnyActiveRun() && !b.text.trim());
// Follow the agent to the file it edits, unless the person is busy typing somewhere.
function mayFollowAgent(): boolean {
  if ($('#ide').classList.contains('hidden') || modalOpen()) return false;
  if (scmPageOpen) return false; // the editor is hidden behind the Source Control page; don't switch files under it, or kick the person out of it
  return Date.now() - lastUserTypeAt > 3000;
}
function followAgentTo(path: string): void {
  if (active === path || !mayFollowAgent()) return;
  if (!openTabs.includes(path)) openTabs.push(path);
  setActive(path);
}
// The agent's file changes are shown one at a time, in the order they came: each switches the editor to its file and
// only then types the change, so no file is changed off screen while another one is still typing out.
let agentTurn: Promise<unknown> = Promise.resolve();
function inAgentTurn<T>(job: () => Promise<T> | T): Promise<T> {
  const run = agentTurn.then(job, job);
  agentTurn = run.catch(() => { /* the next one still runs */ });
  return run;
}
async function typeAgentEdit(b: EditorBuffer, text: string): Promise<void> {
  typingTo.set(b.path, text); // a newer write while it waits for its turn only moves the target
  await inAgentTurn(() => typeAgentEditNow(b));
}
async function typeAgentEditNow(b: EditorBuffer): Promise<void> {
  const text = typingTo.get(b.path);
  if (text == null) return;
  followAgentTo(b.path);
  remember(b, 'reload');
  try {
    // Keep going while newer text arrives (the agent edited the file again meanwhile).
    for (let target = text; b.text !== target; target = typingTo.get(b.path) ?? target) {
      if (!await typeOut(b, target)) break;
    }
  } finally {
    typingTo.delete(b.path);
    typingCaret.delete(b.path);
    if (b.path === active) renderCode();
    if (b.path === splitPath) renderSplit();
    scheduleLint(b, 0);
    // The new lines stay lit for a moment, then fade back to normal.
    setTimeout(() => { if (!typingTo.has(b.path)) { delete added[b.path]; if (b.path === active) renderCode(); } }, 2500);
  }
}
// A file the agent is still creating: its tab opens while it is empty and its text types in as it arrives.
// False when there is nothing to type into (a path Breeze won't show, or a tab the person is editing).
function typeAgentDraft(path: string, text: string): boolean {
  const b = buffers.get(path) ?? blankBuffer(path);
  if (b?.kind !== 'text' || holdsUserEdits(b)) return false;
  // Its tab is opened and shown when its turn comes (typeAgentEditNow), then the text types in.
  if (typingTo.has(path)) typingTo.set(path, text);
  else void typeAgentEdit(b, text);
  return true;
}
// Types `after` into the buffer; false when the person started editing it (the rest then lands at once).
async function typeOut(b: EditorBuffer, after: string): Promise<boolean> {
  const before = b.text;
  let s = 0;
  while (s < before.length && s < after.length && before[s] === after[s]) s++;
  let e = 0;
  while (e < before.length - s && e < after.length - s && before[before.length - 1 - e] === after[after.length - 1 - e]) e++;
  const head = after.slice(0, s), mid = after.slice(s, after.length - e), tail = after.slice(after.length - e);
  // An insertion that starts with a line break begins on the next line; the line above stays unlit.
  const firstLine = lineAt(after, s) + (mid.startsWith('\n') ? 1 : 0);
  // Short edits type at a natural pace; long ones speed up so none takes more than ~2.5 s.
  // Very large files would re-highlight every frame, so they change at once.
  const step = after.length > 150000 ? mid.length : Math.max(3, Math.ceil(mid.length / 150));
  followAgentTo(b.path);
  let shown = before, frames = 0;
  for (let i = 0; ; i = Math.min(mid.length, i + step)) {
    // Typed over by the person: stop animating; their edit now differs from the disk.
    // Any other change (no keystroke just now) is taken over by the animation.
    if (b.text !== shown && Date.now() - lastUserTypeAt < 1500) {
      b.saved = after;
      return false;
    }
    const text = head + mid.slice(0, i) + tail;
    const caret = s + i;
    shown = text;
    setBuffer(b, text);
    const last = lineAt(text, caret);
    added[b.path] = new Set(Array.from({ length: last - firstLine + 1 }, (_, n) => firstLine + n));
    typingCaret.set(b.path, caret);
    if (b.path === active) { renderCode(); revealOffset(b, caret); }
    if (b.path === splitPath) renderSplit();
    if (i >= mid.length) break;
    if (++frames % 3 === 0) sfx.play('key');
    await sleepMs(16);
  }
  if (running && previewPath && /\.(html?|css|js|md|markdown)$/i.test(b.path)) void reloadPreview();
  return true;
}
// Replaces the buffer's text as saved on disk, keeping the person's caret where it was.
function setBuffer(b: EditorBuffer, text: string): void {
  const before = b.text;
  b.text = b.saved = text;
  docSync(b, before, b.text);
  if (b.ta && b.ta.value !== text) {
    const { selectionStart: st, selectionEnd: en } = b.ta;
    b.ta.value = text;
    b.ta.setSelectionRange(Math.min(st, text.length), Math.min(en, text.length));
  }
}
function typingCaretBox(b: EditorBuffer, cw: number): HTMLElement[] {
  const off = typingCaret.get(b.path);
  if (off == null) return [];
  const ls = lineStart(b.text, off);
  return [box('type-caret', lineAt(b.text, off) * LINE_H, codeX(b.text.slice(ls, lineEnd(b.text, ls)), off - ls, cw))];
}
// The agent's mouse cursor, drawn like the crew that rebuilds the window for the debugger, riding just behind its caret.
// One element kept outside the boxes that are redrawn every frame, so its arrow is only painted when the agent changes.
let typeHand: CrewHand | null = null;
function placeTypeHand(b: EditorBuffer, cw: number): void {
  const off = typingCaret.get(b.path);
  if (off == null) { if (typeHand) typeHand.el.hidden = true; return; }
  if (!typeHand) {
    typeHand = crewHand();
    hlBoxes.after(typeHand.el);
  }
  const hand = typeHand;
  dressCrewHand(hand, locks[b.path]?.phase ?? 'assistant');
  const ls = lineStart(b.text, off);
  const x = visualCol(b.text.slice(ls, lineEnd(b.text, ls)), off - ls) * cw, y = lineAt(b.text, off) * LINE_H;
  hand.el.hidden = false;
  // Its tip rests just after the caret, near the bottom of the line, so the letters being typed stay in view.
  hand.el.style.transform = `translate(${x + 3}px, ${y + 13}px)`;
}

api.fs.onChange(paths => background((async () => {
  queueGitRefresh();
  // Reload changed folders, and changed paths that are themselves cached folders (e.g. created then filled).
  const dirs = new Set([...paths.map(dirName), ...paths].filter(d => dirCache.has(d)));
  await Promise.all([...dirs].map(loadDir));
  renderTreeAnimated();
  const changed = paths.map(p => buffers.get(p)).filter((b): b is EditorBuffer => !!b);
  await Promise.all(changed.map(b => {
    if ((b.kind === 'image' || b.kind === 'video') && b.url?.startsWith('file:') || b.kind === 'pdf' && b.url) return reloadImage(b);
    if (b.kind === 'text' && !holdsUserEdits(b)) return reloadText(b);
    return Promise.resolve();
  }));
  if (paths.some(path => path === 'index.html' || path.endsWith('/index.html'))) await refreshLiveShare();
})()));

// The main process stopped watching the folder: changes made outside Breeze won't show until a refresh.
api.fs.onWatchLost(() => toast('Breeze stopped noticing outside file changes. Reopen the folder to watch it again.'));

