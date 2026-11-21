/* ================= Home: the prompt box ================= */
/* ----- The prompt box: ask an agent from Home, in the folder the chip names ----- */
// The chip shows the folder the agent will work in: the one picked last, else the open project, else the most
// recent one. A folder picked with "Choose folder…" is held as it was opened, so sending loads it straight away.
let homeAskPicked: RootInfo | null = null;
function homeAskDir(): string | null {
  const saved = store.get<string | null>('breeze.homeAskDir', null);
  const known = (p: string | null | undefined) => !!p && (homeAskPicked?.root === p || rootInfo?.root === p || !!homeRecent?.some(r => r.path === p && !r.missing));
  if (known(saved)) return saved;
  if (rootInfo) return rootInfo.root;
  return homeRecent?.find(r => !r.missing)?.path ?? null;
}
const dirLabel = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
function renderHomeAsk(): void {
  const dir = homeAskDir();
  $('#homeAskDirName').textContent = dir ? dirLabel(dir) : 'Choose a folder';
  $('#homeAskDir').title = dir ? `The agent works in ${dir}` : 'Pick the folder the agent works in';
  // The agent that will answer, with its model and effort, as in the agents panel's composer; a click changes either.
  const box = $('#homeAskModels');
  const a = selectedAgent();
  const html = a && (a.models?.length || a.version)
    ? `<button type="button" class="prompt-model" data-agent="${escAttr(a.id)}" aria-haspopup="menu" aria-label="${escAttr(`${agentShortName(a)}: change model${a.api ? '' : ' or effort'}`)}">${promptModelHtml(a)}</button>`
    : '';
  if (box.innerHTML !== html) box.innerHTML = html;
  if (typeof refreshComposers === 'function') refreshComposers();
}
$('#homeAskModels').addEventListener('click', e => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('.prompt-model');
  const ag = chip && appState.detect?.agents.find(x => x.id === chip.dataset.agent);
  if (!chip || !ag) return;
  openChipMenu(chip, modelPickerItems(ag));
  // The box sits at the bottom of the page, so the menu opens upwards.
  const m = chip.classList.contains('open') ? $('#menuRoot .menu') : null;
  if (m) {
    const r = chip.getBoundingClientRect();
    m.style.left = `${Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8))}px`;
    m.style.top = `${Math.max(8, r.top - m.offsetHeight - 4)}px`;
    m.classList.add('up');
  }
});
function pickHomeAskDir(dir: string): void {
  store.set('breeze.homeAskDir', dir);
  renderHomeAsk();
}
async function chooseHomeAskFolder(): Promise<void> {
  const r = await api.fs.openFolder();
  if (!r) return;
  homeAskPicked = r;
  pickHomeAskDir(r.root);
}
$('#homeAskDir').addEventListener('click', e => {
  const btn = e.currentTarget as HTMLElement;
  const r = btn.getBoundingClientRect();
  const cur = homeAskDir();
  const recents = (homeRecent ?? []).filter(x => !x.missing).slice(0, 8);
  const items: MenuItem[] = recents.map(x => ({ label: x.name, checked: () => cur === x.path, run: () => pickHomeAskDir(x.path) }));
  if (rootInfo && !recents.some(x => x.path === rootInfo?.root)) items.unshift({ label: rootInfo.name, checked: () => cur === rootInfo?.root, run: () => pickHomeAskDir((rootInfo as RootInfo).root) });
  if (items.length) items.push({ sep: true });
  items.push({ label: 'Choose folder…', icon: 'folder', run: () => background(chooseHomeAskFolder()) });
  popupMenu(r.left, r.top - 4, items, undefined, btn);
});

async function sendFromHome(): Promise<void> {
  const input = $<HTMLTextAreaElement>('#homeAskInput');
  const text = input.value.trim();
  if (!text) return;
  const dir = homeAskDir();
  if (!dir) { await chooseHomeAskFolder(); return; }
  if (rootInfo?.root !== dir) {
    if (!(await confirmDiscard())) return;
    try {
      await loadWorkspace(homeAskPicked?.root === dir ? homeAskPicked : await api.fs.openRecent(dir));
    } catch (e) { toast(errMsg(e)); return; }
  }
  input.value = '';
  saveDraft(input);
  enterMode('ide');
  if (!layout.agentsOpen) commands['view.toggleAgents']();
  const files = homeAskFiles.splice(0);
  renderHomeAskFiles();
  if (files.length) await attachFilesToAgent(files, SURFACES.ide);
  // The IDE's own Send does the rest: the chosen agent, @mentions, the chat's title.
  SURFACES.ide.prompt.value = text;
  SURFACES.ide.prompt.dispatchEvent(new Event('input', { bubbles: true }));
  await sendPrompt();
}
let homeAskFiles: File[] = [];
function renderHomeAskFiles(): void {
  const el = $('#homeAskFiles');
  el.classList.toggle('hidden', !homeAskFiles.length);
  el.innerHTML = homeAskFiles.map((f, i) => `<span class="attachment-chip"><span class="attachment-thumb attachment-icon file-icon">${svgIcon(f.type.startsWith('image/') ? 'eye' : 'file', 13)}</span><span class="attachment-name">${esc(f.name)}</span><button type="button" class="attachment-del" data-i="${i}" aria-label="Remove ${escAttr(f.name)}">×</button></span>`).join('');
}
$('#homeAskFiles').addEventListener('click', e => {
  const del = (e.target as HTMLElement).closest<HTMLElement>('.attachment-del');
  if (!del) return;
  homeAskFiles.splice(Number(del.dataset.i), 1);
  renderHomeAskFiles();
});
wireComposer({
  box: $('#homeAskBox'), meta: $('#homeAsk .cmp-meta'), skills: false,
  folder: homeAskDir,
  attach: files => { homeAskFiles.push(...files); renderHomeAskFiles(); },
});
keepDraft($<HTMLTextAreaElement>('#homeAskInput'), () => 'breeze.draft:home');
$('#homeAsk').addEventListener('submit', e => { e.preventDefault(); background(sendFromHome()); });
$('#homeAskInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); background(sendFromHome()); }
});
renderHomeAsk();
