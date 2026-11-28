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
  if (!actions) return;
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
      { duration: 220, easing: SPRING, fill: 'forwards' }).onfinish = () => ghost.remove();
  }
  $('.side-head > span:first-child', to).animate([{ opacity: 0, filter: 'blur(2px)' }, { opacity: 1, filter: 'blur(0)' }],
    { duration: 160, easing: 'cubic-bezier(.23, 1, .32, 1)' });
}
// `morph`: only a click on the activity bar animates the header; shortcuts and commands switch at once.
function showView(v: string, reveal = false, morph = false): void {
  // Skills, plugins and MCP moved to a pop-up (skills.ts): a layout saved on that old side-bar view opens Explorer.
  if (v === 'skills') v = 'files';
  // Source Control is a full page (prs.ts) rather than a side-bar panel: it notes the view to go back to, and any other view closes it.
  if (v === 'git') openScmPage(); else closeScmPage(false);
  // The page's header is its column's (#scmLeft); the side bar's shows only while the side bar is open.
  const headOf = (view: string) => (view === 'git' ? $('#scmLeft') : $(`[data-panel="${view}"]`));
  const shown = layout.view === 'git' || layout.sideOpen; // 'git' is the page, which is (or was just) open
  const was = morph && shown && layout.view !== v ? headOf(layout.view) : null;
  layout.view = v;
  // The page doesn't use the side bar, so it leaves it as it was; closing the page then returns to exactly that.
  if (reveal && !layout.sideOpen && v !== 'git') layout.sideOpen = true;
  applyLayout();
  $$('.act-btn[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  $$('[data-panel]').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== v));
  if (was) morphSideHead(was, headOf(v));
  updateActIndicator();
  if (v === 'git') void refreshGit();
}
// Clicking the active view's icon again collapses the side bar, like VS Code. For Source Control, the page, it closes it.
$$('.act-btn[data-view]').forEach(b => b.onclick = () => {
  const v = b.dataset.view as string;
  if (v === 'git' && scmPageOpen) scmFade(() => closeScmPage(true, true));
  else if (v === layout.view && layout.sideOpen && v !== 'git') { layout.sideOpen = false; applyLayout(); }
  else if (v === 'git' || scmPageOpen) scmFade(() => showView(v, true, true)); // into or out of the page
  else showView(v, true, true);
});

// Into the editor: the screen every way out of Home and setup lands on.
function enterIde(): void {
  appState.onboarded = true;
  saveApp();
  closeMenu();
  showIde();
}
