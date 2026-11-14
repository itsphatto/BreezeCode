/* ================= Home: the movable contribution graph, and the prompt box ================= */
// The graph is the one thing on Home you can move. Grab it by its title and drop it on the left, the bottom or the
// right of the page; at a side it stands upright (newest week at the top). Its place is remembered.
type HomeDock = 'left' | 'bottom' | 'right';
const HOME_DOCKS: readonly HomeDock[] = ['left', 'bottom', 'right'];
function homeGraphDock(): HomeDock {
  const d = store.get<string>('breeze.homeGraphDock', 'bottom');
  return (HOME_DOCKS as readonly string[]).includes(d) ? d as HomeDock : 'bottom';
}

// Upright: a row per week (newest first), a column per weekday; month names down the left.
function drawContribUpright(c: GhContributions): void {
  const box = $('#homeContrib');
  box.classList.add('upright');
  $('#homeContribTitle').textContent = `${c.total.toLocaleString()} contribution${c.total === 1 ? '' : 's'}`;
  const graph = $('#homeContribGraph');
  graph.setAttribute('aria-label', `${c.total} GitHub contributions in the last year`);
  graph.textContent = '';
  const put = (el: HTMLElement, col: number, row: number) => { el.style.gridColumn = String(col); el.style.gridRow = String(row); graph.append(el); };
  graph.style.setProperty('--weeks', String(c.weeks.length));
  ['M', 'W', 'F'].forEach((d, i) => {
    const s = document.createElement('span');
    s.className = 'cg-wd';
    s.textContent = d;
    put(s, 3 + i * 2, 1);
  });
  const n = c.weeks.length;
  let lastMonth = -1;
  // Oldest to newest, so a month is named on the first week that starts in it; rows count from the newest.
  c.weeks.forEach((week, w) => {
    const row = n - w + 1;
    const first = contribDay(week[0].date);
    const m = first.getMonth();
    if (m !== lastMonth && (w > 0 || first.getDate() <= 7)) {
      const s = document.createElement('span');
      s.className = 'cg-month';
      s.textContent = CONTRIB_MONTHS[m];
      put(s, 1, row);
    }
    lastMonth = m;
    for (const d of week) {
      const day = contribDay(d.date);
      const cell = document.createElement('i');
      cell.className = 'cg-day';
      cell.dataset.l = String(d.level);
      if (d.count) cell.dataset.tooltip = `${d.count} contribution${d.count === 1 ? '' : 's'} on ${day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}`;
      put(cell, day.getDay() + 2, row);
    }
  });
  $('#homeContribOpen').onclick = () => background(api.sys.openExternal(`https://github.com/${encodeURIComponent(c.login)}`));
}

// Puts the graph in its slot. animate: it glides from where it was (or from where it was dropped) to its new place.
function placeHomeGraph(dock: HomeDock, from?: DOMRect): void {
  const graph = $('#homeContrib');
  const layout = $('#homeLayout');
  layout.dataset.dock = dock;
  const slot = dock === 'bottom' ? null : $(dock === 'left' ? '#homeDockLeft' : '#homeDockRight');
  if (slot) { if (graph.parentElement !== slot) slot.append(graph); }
  else if (graph.parentElement !== $('.home-welcome', layout)) $('#homeAsk').before(graph);
  if (lastContrib) drawContrib(lastContrib);
  if (!from || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const to = graph.getBoundingClientRect();
  if (!to.width) return;
  graph.animate([
    { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)`, opacity: .6 },
    { transform: 'none', opacity: 1 },
  ], { duration: 320, easing: 'cubic-bezier(.2, .8, .2, 1)' });
}
function setHomeGraphDock(dock: HomeDock, from?: DOMRect): void {
  store.set('breeze.homeGraphDock', dock);
  placeHomeGraph(dock, from ?? $('#homeContrib').getBoundingClientRect());
  sfx.play('drop');
}
placeHomeGraph(homeGraphDock());

// Dragging: the title is the handle. Past a few pixels the graph lifts and follows the pointer, the three zones show,
// and the one under the pointer lights up; letting go snaps the graph into it. Esc puts it back.
{
  const graph = $('#homeContrib');
  const handle = $('#homeContribTitle');
  const layout = $('#homeLayout');
  handle.classList.add('home-drag-handle');
  handle.title = 'Drag to move the graph';
  let drag: { id: number; x: number; y: number; on: boolean; zone: HomeDock } | null = null;
  const zoneAt = (x: number): HomeDock => {
    const r = layout.getBoundingClientRect();
    const f = (x - r.left) / Math.max(1, r.width);
    return f < .25 ? 'left' : f > .75 ? 'right' : 'bottom';
  };
  const light = (zone: HomeDock | null) => $$('.home-zone', layout).forEach(z => z.classList.toggle('on', z.dataset.zone === zone));
  const end = (drop: boolean, e?: PointerEvent) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (handle.hasPointerCapture(d.id)) handle.releasePointerCapture(d.id);
    if (!d.on) return;
    const held = graph.getBoundingClientRect();
    graph.classList.remove('lifted');
    graph.style.transform = '';
    layout.classList.remove('graph-dragging');
    light(null);
    if (drop && e) setHomeGraphDock(d.zone, held);
    else placeHomeGraph(homeGraphDock(), held);
  };
  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, on: false, zone: homeGraphDock() };
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.on) {
      if (Math.hypot(dx, dy) < 5) return;
      drag.on = true;
      graph.classList.add('lifted');
      layout.classList.add('graph-dragging');
      sfx.play('tick');
    }
    graph.style.transform = `translate(${dx}px, ${dy}px)`;
    const zone = zoneAt(e.clientX);
    if (zone !== drag.zone) sfx.play('rowHover');
    drag.zone = zone;
    light(zone);
  });
  handle.addEventListener('pointerup', e => end(true, e));
  handle.addEventListener('pointercancel', () => end(false));
  addEventListener('keydown', e => { if (e.key === 'Escape' && drag?.on) { e.preventDefault(); end(false); } }, true);
  // The same moves from the keyboard or a right-click.
  graph.addEventListener('contextmenu', e => {
    e.preventDefault();
    popupMenu(e.clientX, e.clientY, HOME_DOCKS.map(d => ({
      label: `Move to ${d[0].toUpperCase()}${d.slice(1)}`,
      checked: () => homeGraphDock() === d,
      run: () => { if (homeGraphDock() !== d) setHomeGraphDock(d); },
    })));
  });
}

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
  enterMode('ide');
  if (!layout.agentsOpen) commands['view.toggleAgents']();
  // The IDE's own Send does the rest: the chosen agent, @mentions, the chat's title.
  SURFACES.ide.prompt.value = text;
  SURFACES.ide.prompt.dispatchEvent(new Event('input', { bubbles: true }));
  await sendPrompt();
}
$('#homeAsk').addEventListener('submit', e => { e.preventDefault(); background(sendFromHome()); });
$('#homeAskInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); background(sendFromHome()); }
});
renderHomeAsk();
