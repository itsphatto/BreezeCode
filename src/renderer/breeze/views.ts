/* ================= Views ================= */

function updateActIndicator(immediate = false): void {
  const activeBtn = document.querySelector<HTMLElement>('.act-btn[data-view].on');
  const ind = document.getElementById('actIndicator');
  if (!ind) return;
  if (!activeBtn || !layout.sideOpen || !activeBtn.offsetParent) {
    ind.style.opacity = '0';
    return;
  }
  const top = activeBtn.offsetTop + (activeBtn.offsetHeight - 20) / 2;
  if (immediate || !ind.classList.contains('ready')) {
    ind.style.transition = 'none';
    ind.style.transform = `translateY(${top}px)`;
    ind.style.opacity = '1';
    const _reflow = ind.offsetHeight;
    ind.style.transition = '';
    ind.classList.add('ready');
  } else {
    ind.style.transform = `translateY(${top}px)`;
    ind.style.opacity = '1';
  }
}
window.addEventListener('resize', () => updateActIndicator(true));

function showView(v: string, reveal = false): void {
  layout.view = v;
  if (reveal && !layout.sideOpen) layout.sideOpen = true;
  applyLayout();
  $$('.act-btn[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  $$('[data-panel]').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== v));
  updateActIndicator();
  if (v === 'git') void refreshGit();
}
// Clicking the active view's icon again collapses the side bar, like VS Code.
$$('.act-btn[data-view]').forEach(b => b.onclick = () => {
  const v = b.dataset.view as string;
  if (v === layout.view && layout.sideOpen) { layout.sideOpen = false; applyLayout(); } else showView(v, true);
});

/* ================= Breeze Box (chat only) ================= */
// The same agents and conversation as the IDE's agent panel, with nothing else on screen.
function enterMode(mode: WorkMode): void {
  appState.mode = mode;
  appState.onboarded = true;
  saveApp();
  closeMenu();
  if (mode === 'ide') { showIde(); return; }
  swapScreen('#box');
  useSurface('box');
  renderUser(); renderAgentBar(); renderBoxFolder();
  // Box lists every agent Breeze found, so look for them if that hasn't happened yet.
  if (!appState.detect) detectTools().catch(() => toast('Could not look for agents on this computer'));
  if (!SURFACES.box.chat.children.length) restoreChat(SURFACES.box);
  SURFACES.box.prompt.focus();
}
function renderBoxFolder(): void {
  const chip = $('#boxFolder');
  const name = rootInfo ? rootInfo.name : 'Breeze Box folder';
  chip.innerHTML = `${svgIcon('folder', 13)}<span>${esc(name)}</span>`;
  chip.title = rootInfo ? `Agents work in ${rootInfo.root}` : 'No project open: agents work in Documents/Breeze Box';
}
function boxAgentItems(): MenuItem[] {
  const a = selectedAgent();
  const items: MenuItem[] = [];
  if (a?.found && a.models?.length) {
    items.push(
      { label: `${a.name} Models:`, enabled: () => false },
      ...modelMenuItems(a),
      { sep: true },
    );
  }
  items.push({ label: 'Switch Agent:', enabled: () => false });
  const agents = appState.detect?.agents ?? [];
  for (const ag of agents) {
    items.push({
      label: ag.api && ag.version ? `${ag.name} · ${ag.version}` : ag.name,
      key: ag.found ? undefined : 'not set up',
      checked: () => ag.id === appState.agent,
      enabled: () => ag.found,
      run: () => {
        appState.agent = ag.id;
        saveApp();
        renderAgentBar();
        updateBoxEmptyWho();
        toast(`Breeze Box now uses ${ag.name}`);
      },
    });
  }
  return [...items, { sep: true }, { label: 'Manage agents', run: openAgentPicker }];
}
$('#boxModel').onclick = e => {
  const btn = e.currentTarget as HTMLElement;
  if (btn.classList.contains('open')) { closeMenu(); return; }
  btn.classList.add('open');
  const r = btn.getBoundingClientRect();
  popupMenu(r.left, r.top - 8, boxAgentItems(), () => btn.classList.remove('open'));
  const m = $('#menuRoot .menu');
  m.classList.add('up');
  m.style.top = `${Math.max(8, r.top - m.offsetHeight - 6)}px`; // open upwards, above the composer
};
$('#boxFolder').onclick = e => {
  const btn = e.currentTarget as HTMLElement;
  if (btn.classList.contains('open')) { closeMenu(); return; }
  btn.classList.add('open');
  const r = btn.getBoundingClientRect();
  const choose = (create: boolean) => background(chooseProject(create).then(renderBoxFolder));
  popupMenu(r.left, r.top - 8, [
    { label: 'Open Folder', run: () => choose(false) },
    { label: 'Create New Project', run: () => choose(true) },
    ...(rootInfo ? [{ sep: true }, { label: 'Close Folder', run: () => background(closeFolderCmd().then(renderBoxFolder)) }] : []),
  ], () => btn.classList.remove('open'));
  const m = $('#menuRoot .menu');
  m.classList.add('up');
  m.style.top = `${Math.max(8, r.top - m.offsetHeight - 6)}px`;
};

