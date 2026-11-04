/* ================= Views ================= */

function updateActIndicator(immediate = false): void {
  const activeBtn = document.querySelector<HTMLElement>('.act-btn[data-view].on');
  const ind = document.getElementById('actIndicator');
  if (!ind) return;
  // The Source Control page replaces the side bar, so its icon stays lit whether or not the side bar is open.
  if (!activeBtn || !(layout.sideOpen || $('#main').classList.contains('scm-page')) || !activeBtn.offsetParent) {
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

// Switching views, the new header takes over from the old one: each icon morphs from the one in the same place
// (counted from the right, where Hide Side Bar always sits) or grows from a dot, and the title fades in.
function morphSideHead(from: HTMLElement, to: HTMLElement): void {
  const icons = (p: HTMLElement) => $$<HTMLElement>('.side-head .head-actions .icon-btn:not(.hidden)', p).reverse();
  const old = icons(from).map(b => b.querySelector<SVGSVGElement>('svg.ico-svg')?.dataset.icon ?? 'dot');
  icons(to).forEach((b, i) => void morphIconFrom(b, old[i] ?? 'dot'));
  // A tab with fewer tools: the old ones it lacks (the leftmost) stay a moment as copies that shrink away and close
  // their gap, instead of vanishing. Tools sit at the right, so the closing gap moves nothing else.
  const actions = $('.side-head .head-actions', to);
  if (!actions || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const b of icons(from).slice(icons(to).length)) {
    const ghost = b.cloneNode(true) as HTMLElement;
    ghost.removeAttribute('id');
    ghost.removeAttribute('data-act');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.tabIndex = -1;
    ghost.style.pointerEvents = 'none';
    actions.prepend(ghost);
    const w = `${ghost.offsetWidth}px`;
    ghost.animate([{ opacity: 1, transform: 'none', width: w, minWidth: w }, { opacity: 0, transform: 'scale(.4)', width: '0px', minWidth: '0px', paddingInline: '0px' }],
      { duration: 220, easing: 'cubic-bezier(.23, 1, .32, 1)', fill: 'forwards' }).onfinish = () => ghost.remove();
  }
  $('.side-head > span:first-child', to).animate([{ opacity: 0, filter: 'blur(2px)' }, { opacity: 1, filter: 'blur(0)' }],
    { duration: 160, easing: 'cubic-bezier(.23, 1, .32, 1)' });
}
// `morph`: only a click on the activity bar animates the header; shortcuts and commands switch at once.
function showView(v: string, reveal = false, morph = false): void {
  // Source Control is a full page (prs.ts) rather than a side-bar panel: it notes the view to go back to, and any other view closes it.
  if (v === 'git') openScmPage(); else closeScmPage(false);
  // Neither side of a switch to or from the page has a header to morph.
  const was = morph && layout.sideOpen && layout.view !== v && layout.view !== 'git' && v !== 'git' ? $(`[data-panel="${layout.view}"]`) : null;
  layout.view = v;
  // The page doesn't use the side bar, so it leaves it as it was; closing the page then returns to exactly that.
  if (reveal && !layout.sideOpen && v !== 'git') layout.sideOpen = true;
  applyLayout();
  $$('.act-btn[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  $$('[data-panel]').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== v));
  if (was) morphSideHead(was, $(`[data-panel="${v}"]`));
  updateActIndicator();
  if (v === 'git') void refreshGit();
  if (v === 'skills') void refreshSkills();
}
// Clicking the active view's icon again collapses the side bar, like VS Code. For Source Control, the page, it closes it.
$$('.act-btn[data-view]').forEach(b => b.onclick = () => {
  const v = b.dataset.view as string;
  if (v === 'git' && scmPageOpen) closeScmPage();
  else if (v === layout.view && layout.sideOpen && v !== 'git') { layout.sideOpen = false; applyLayout(); } else showView(v, true, true);
});

/* ================= Breeze Space (chat only) ================= */
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
  renderBoxSide();
  SURFACES.box.prompt.focus();
}
function renderBoxFolder(): void {
  const chip = $('#boxFolder');
  const name = rootInfo ? rootInfo.name : 'Breeze Space folder';
  chip.innerHTML = `${svgIcon('folder', 13)}<span>${esc(name)}</span>`;
  chip.title = rootInfo ? `Agents work in ${rootInfo.root}` : 'No project open: agents work in Documents/Breeze Space';
}
function boxAgentItems(): MenuItem[] {
  const a = selectedAgent();
  // The agents to switch to first, then Switch Model, with the effort slider last.
  const items: MenuItem[] = [{ label: 'Switch Agent:', enabled: () => false }];
  const agents = appState.detect?.agents ?? [];
  for (const ag of agents) {
    items.push({
      label: ag.api && ag.version ? `${ag.name} · ${ag.version}` : ag.name,
      icon: brandMark('menu-ico', ag.id, ag.name[0]),
      key: ag.found ? undefined : 'not set up',
      checked: () => ag.id === appState.agent,
      enabled: () => ag.found,
      run: () => {
        appState.agent = ag.id;
        saveApp();
        renderAgentBar();
        updateBoxEmptyWho();
        toast(`Breeze Space now uses ${ag.name}`);
      },
    });
  }
  items.push({ label: 'Manage agents', run: openAgentPicker });
  if (a?.found && a.models?.length) items.push({ sep: true }, ...modelPickerItems(a));
  return items;
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

