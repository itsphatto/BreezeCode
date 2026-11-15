/* ================= Agent board: the full page ================= */
// A screen of its own (swapScreen), like the debugger. The installed agents sit on a roster in the title bar; each is
// dragged into a box. A box is a chat surface of its own (`board:box1`…), so messages, tool lines and cards render
// as in the IDE chat, and every box runs at the same time. Main's BoardCoordinator (src/main/board.ts) keeps each
// file to the box that touched it first; what one box wanted from another comes back as a `relay` (boardrelay.ts).

type BoxStatus = 'idle' | 'working' | 'waiting' | 'done' | 'failed';
interface BoardBox {
  key: string;            // box1…box8
  agent: string;
  surface: Surface;
  tab: AgentTabState;
  el: HTMLElement;
  status: BoxStatus;
  runIds: Set<number>;    // every run this box started (the chat's own, and relay follow-ups)
  lastText: string;       // the latest text of its current run, for a relay reply
  starting?: boolean;      // between Send (or a relay) and main handing back the run id: busy already
  scrollPending?: boolean; // a restored chat: scroll to its latest message once it has a size
  kit?: PromptKit;         // its prompt, run by the Agents tab's own code (mentions.ts)
  model?: string;          // its own model and effort; unset: the agent's (Settings, or the Agents tab's chip)
  effort?: EffortLevel;
}
const boxBusy = (b: BoardBox) => tabBusy(b.tab) || !!b.starting;
const stoppedRuns = new Set<number>(); // runs the person stopped: their late relays and replies are dropped
interface BoardSaved { boxes: Record<string, { agent: string; historyId?: string; sessions?: Record<string, string>; model?: string; effort?: string }> }

const BOARD_MAX = 8;
const boardBoxes = new Map<string, BoardBox>();
const boardGrid = $('#boardGrid');
// swapScreen lights the board button the moment the page is chosen; #board's own classes lag behind the cross-fade.
const boardPageShowing = () => $('#boardBtn').classList.contains('on');
const boardStoreKey = () => `breeze.board.${rootInfo?.root ?? ''}`;
const boxNumber = (key: string) => Number(key.slice(3));
const boxName = (b: { key: string; agent: string }) => `${agentNameOf(b.agent)} · ${boxNumber(b.key)}`;
const foundAgents = () => (appState.detect?.agents ?? []).filter(a => a.found);
let boardFolder: string | null = null; // the folder the boxes on screen belong to

function openBoard(): void {
  closeMenu();
  if (!rootInfo) { toast('Open a folder first, so the agents know what to work on'); return; }
  swapScreen('#board');
  if (boardFolder !== rootInfo.root) loadBoard();
  renderRoster();
  renderBoard();
  placeBoardRailIndicator();
  requestAnimationFrame(scrollRestoredChats);
  background(api.board.open().then(refreshOwners));
}
function leaveBoard(): void {
  showIde();
  renderBoardStatus();
}
$('#boardBack').onclick = leaveBoard;
$('#boardBtn').onclick = openBoard;
commands['view.board'] = () => openBoard();

/* ----- The activity bar, copied from the IDE (as on the debugger page) ----- */
const boardRail = $('#boardRail');
for (const n of Array.from($('#ide .activity').children)) {
  const c = n.cloneNode(true) as HTMLElement;
  if (n.id) c.dataset.rail = n.id;
  for (const el of [c, ...Array.from(c.querySelectorAll<HTMLElement>('[id]'))]) el.removeAttribute('id');
  if (c.dataset.view) { c.dataset.railView = c.dataset.view; delete c.dataset.view; }
  c.classList.toggle('on', c.hasAttribute('data-board-btn'));
  boardRail.append(c);
}
boardRail.addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.act-btn');
  if (!b) return;
  if (b.dataset.railView) { leaveBoard(); showView(b.dataset.railView, true); }
  else if (b.dataset.rail === 'debugBtn') openDebugView();
  else if (b.dataset.rail === 'settingsBtn') openSettings(b);
});
function placeBoardRailIndicator(): void {
  const ind = boardRail.querySelector<HTMLElement>('.act-indicator');
  const btn = boardRail.querySelector<HTMLElement>('[data-board-btn]');
  if (!ind || !btn) return;
  ind.style.transform = `translateY(${btn.offsetTop + (btn.offsetHeight - 20) / 2}px)`;
  ind.style.opacity = '1';
}

/* ----- Roster: one draggable chip per installed agent ----- */
function renderRoster(): void {
  const roster = $('#boardRoster');
  const agents = foundAgents();
  if (!agents.length) {
    roster.innerHTML = `<button class="btn btn-sm" type="button" data-board-pick>Choose an agent</button>`;
    roster.querySelector<HTMLElement>('[data-board-pick]')!.onclick = openAgentPicker;
    return;
  }
  roster.innerHTML = agents.map(a => `<span class="board-chip" role="listitem" draggable="true" tabindex="0" data-agent="${escAttr(a.id)}" title="Click to add ${escAttr(agentShortName(a))}, or drag it into a box">${brandMark('board-chip-logo', a.id, agentShortName(a)[0] ?? '?')}<b>${esc(agentShortName(a))}</b></span>`).join('');
}
$('#boardRoster').addEventListener('dragstart', e => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('.board-chip');
  if (!chip || !e.dataTransfer) return;
  e.dataTransfer.setData('text/breeze-agent', chip.dataset.agent!);
  e.dataTransfer.effectAllowed = 'copy';
  boardGrid.classList.add('dragging');
  // The board opens a spot for it: the layout one more box makes (after the drag has started, or it is cancelled).
  setTimeout(() => { if (!boardDragging && boardBoxes.size < BOARD_MAX) { boardDragging = true; morphBoard(renderBoard); } }, 0);
});
$('#boardRoster').addEventListener('dragend', () => endBoardDrag());
// A click on a chip adds that agent in a box of its own; Enter does the same from the keyboard.
$('#boardRoster').addEventListener('click', e => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('.board-chip');
  if (chip) addAgent(chip.dataset.agent!);
});
$('#boardRoster').addEventListener('keydown', e => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('.board-chip');
  if (!chip || e.key !== 'Enter') return;
  e.preventDefault(); // or Enter types a newline into the new box's prompt, which takes the focus
  addAgent(chip.dataset.agent!);
});

/* ----- The grid: only the filled boxes, laid out for how many there are (boardlayout.ts) ----- */
// No agent yet: one empty box fills the page. While a chip is dragged, an empty spot opens where it would land.
const allBoxKeys = () => Array.from({ length: BOARD_MAX }, (_, i) => `box${i + 1}`);
const firstFreeKey = () => allBoxKeys().find(k => !boardBoxes.has(k));
let boardDragging = false;
function endBoardDrag(): void {
  boardGrid.classList.remove('dragging');
  if (!boardDragging) return;
  boardDragging = false;
  morphBoard(renderBoard);
}
// The boxes on the page, in box order: the filled ones, and the one empty spot (none filled, or a chip being dragged).
function shownBoxKeys(): string[] {
  const free = firstFreeKey();
  const open = free && (!boardBoxes.size || boardDragging) ? [free] : [];
  return [...boardBoxes.keys(), ...open].sort((a, b) => boxNumber(a) - boxNumber(b));
}
function renderBoard(): void {
  const keys = shownBoxKeys();
  for (const el of Array.from(boardGrid.children) as HTMLElement[]) {
    if (!keys.includes(el.dataset.box!)) el.remove();
  }
  keys.forEach((key, i) => {
    const box = boardBoxes.get(key);
    let el = boardGrid.querySelector<HTMLElement>(`:scope > [data-box="${key}"]`);
    if (box) {
      if (el !== box.el) { el?.remove(); el = box.el; }
    } else if (!el || el.classList.contains('filled')) {
      el?.remove();
      el = emptyBoxEl(key);
    }
    paintEmptyBox(el, key);
    if (boardGrid.children[i] !== el) boardGrid.insertBefore(el, boardGrid.children[i] ?? null);
  });
  layoutBoard();
}
// Grid lines for each box; on a page too narrow for them side by side, two to a row with rows to scroll to.
function layoutBoard(): void {
  const els = Array.from(boardGrid.children) as HTMLElement[];
  const lay = boardLayout(els.length, boardGrid.clientWidth);
  boardGrid.style.gridTemplateColumns = `repeat(${lay.cols}, minmax(0, 1fr))`;
  boardGrid.style.gridTemplateRows = lay.scroll ? '' : `repeat(${lay.rows}, minmax(0, 1fr))`;
  boardGrid.classList.toggle('scroll', lay.scroll);
  boardGrid.dataset.count = String(els.length);
  els.forEach((el, i) => {
    const c = lay.cells[i];
    el.style.gridArea = c ? `${c.row} / ${c.col} / span ${c.rowSpan} / span ${c.colSpan}` : '';
  });
  for (const b of boardBoxes.values()) $('.board-box-split', b.el).classList.toggle('hidden', boardBoxes.size >= BOARD_MAX);
}
new ResizeObserver(() => { if (boardGrid.children.length) layoutBoard(); }).observe(boardGrid);

// Adding, emptying or moving boxes eases each one from where it was to where it lands (a view transition,
// .board-morph in breeze.css): what's in a box keeps its size and is uncovered as the box grows, never stretched.
function morphBoard(change: () => void): void {
  const root = document.documentElement;
  if (!document.startViewTransition || !boardPageShowing() || motionOff() || matchMedia('(prefers-reduced-motion: reduce)').matches
    || root.classList.contains('term-morph') || root.classList.contains('scm-fade')) { change(); return; }
  const name = () => { for (const el of Array.from(boardGrid.children) as HTMLElement[]) el.style.viewTransitionName = `board-${el.dataset.box}`; };
  name();
  root.classList.add('board-morph');
  const done = () => {
    root.classList.remove('board-morph');
    for (const el of Array.from(boardGrid.children) as HTMLElement[]) el.style.viewTransitionName = '';
  };
  document.startViewTransition(() => { change(); name(); }).finished.then(done, done);
}

// Puts the agent in a box of its own (the first free one), splitting the page with the boxes already there.
function addAgent(agent: string): void {
  const key = firstFreeKey();
  if (!key) { toast(`The board is full: empty a box first (${BOARD_MAX} at most)`); return; }
  dropAgent(key, agent);
}
function emptyBoxEl(key: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'board-box empty-box';
  el.dataset.box = key;
  el.tabIndex = 0;
  el.innerHTML = `<div class="board-drop"><svg data-i="plus" data-size="18"></svg><span class="board-drop-title"></span><small class="board-drop-hint"></small></div>`;
  paintIcons(el);
  return el;
}
// The only box on an empty board asks for an agent; the spot a dragged chip opens says it lands there.
function paintEmptyBox(el: HTMLElement, key: string): void {
  if (!el.classList.contains('empty-box')) return;
  const spot = boardBoxes.size > 0;
  el.classList.toggle('spot-box', spot);
  $('.board-drop-title', el).textContent = spot ? 'Drop here to add it' : 'Drop an agent here';
  $('.board-drop-hint', el).textContent = spot ? 'The boxes make room for it' : 'or click to pick one';
  el.setAttribute('aria-label', spot ? `Box ${boxNumber(key)}, a spot for the agent you are dragging.` : 'No agent yet. Click or press Enter to pick one.');
}
boardGrid.addEventListener('dragover', e => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.board-box');
  if (!el || !e.dataTransfer?.types.includes('text/breeze-agent')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  for (const o of boardGrid.querySelectorAll('.drop-on')) if (o !== el) o.classList.remove('drop-on');
  el.classList.add('drop-on');
});
boardGrid.addEventListener('dragleave', e => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.board-box');
  if (el && !el.contains(e.relatedTarget as Node)) el.classList.remove('drop-on');
});
boardGrid.addEventListener('drop', e => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.board-box');
  const agent = e.dataTransfer?.getData('text/breeze-agent');
  boardGrid.classList.remove('dragging');
  boardDragging = false; // the open spot becomes the new box (or closes, dropped on a filled one) in the same morph
  el?.classList.remove('drop-on');
  if (!el || !agent) { morphBoard(renderBoard); return; }
  e.preventDefault();
  dropAgent(el.dataset.box!, agent);
});
// Clicking an empty box (or Enter on it) lists the agents to put in it.
function pickAgentFor(el: HTMLElement, x: number, y: number): void {
  const agents = foundAgents();
  if (!agents.length) { toast('No agents found. Install one from Settings.'); return; }
  popupMenu(x, y, agents.map(a => ({ label: agentShortName(a), run: () => dropAgent(el.dataset.box!, a.id) })));
}
boardGrid.addEventListener('click', e => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.empty-box');
  if (el) pickAgentFor(el, e.clientX, e.clientY);
});
boardGrid.addEventListener('keydown', e => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.empty-box');
  if (!el || e.key !== 'Enter' || e.target !== el) return;
  const r = el.getBoundingClientRect();
  pickAgentFor(el, r.left + 16, r.top + 16);
});

// A box that is working refuses a drop (it shakes); an idle one takes the new agent and starts a new chat.
function dropAgent(key: string, agent: string): void {
  const box = boardBoxes.get(key);
  if (box && boxBusy(box)) {
    box.el.classList.remove('shake');
    void box.el.offsetWidth;
    box.el.classList.add('shake');
    setTimeout(() => box.el.classList.remove('shake'), 400);
    toast(`${boxName(box)} is still working`);
    return;
  }
  morphBoard(() => {
    if (box) {
      dropRelaysFor(key);
      removeBox(box);
      background(api.board.clearBox(key));
    }
    fillBox(key, agent);
    saveBoard();
    boardBoxes.get(key)?.surface.prompt.focus();
  }); // runs once the old look is captured, a frame later when it morphs
  sfx.play('send');
}

/* ----- A filled box: header, chat, prompt ----- */
function fillBox(key: string, agent: string, saved?: { historyId?: string; sessions?: Record<string, string>; model?: string; effort?: string }): BoardBox {
  const el = document.createElement('section');
  el.className = 'board-box filled';
  el.dataset.box = key;
  el.innerHTML = `
    <header class="board-box-head">
      ${brandMark('board-box-logo', agent, agentNameOf(agent)[0] ?? '?')}
      <b class="board-box-name"></b>
      <button class="board-box-model" type="button" title="Model and effort" aria-haspopup="menu"><span class="bbm-label"></span><svg data-i="chevronDown" data-size="11"></svg></button>
      <span class="board-dot" role="status"></span>
      <span class="flex-1"></span>
      <button class="board-owns" type="button" title="Files this box owns"></button>
      <button class="icon-btn board-box-split" type="button" title="Split: add an agent beside this one" aria-label="Split: add an agent beside this one" aria-haspopup="menu"><svg data-i="columns" data-size="14"></svg></button>
      <button class="icon-btn board-box-close" type="button" title="Empty this box" aria-label="Empty this box"><svg data-i="x" data-size="14"></svg></button>
    </header>
    <div class="board-chat chat"></div>
    <div class="composer board-composer"><div class="composer-box">
      <div class="composer-attachments hidden"></div>
      <div class="prompt-field"><div class="prompt-hl" aria-hidden="true"></div><textarea rows="1" data-no-grow aria-label="Message to ${escAttr(agentNameOf(agent))} in box ${boxNumber(key)}" placeholder=" "></textarea></div>
      <div class="row"><select class="select hidden" aria-hidden="true" tabindex="-1"><option value="build">Auto</option></select><span class="prompt-models"></span><span class="flex-1"></span>
        <span class="composer-access" title="Full access lets agents run any command and reach any file. Off keeps them in the project."><span class="ca-label">Full access</span><button class="switch switch-sm" data-full-access type="button" role="switch" aria-checked="false" aria-label="Full access"><span class="sw-knob"></span></button></span>
        <button class="btn btn-primary btn-sm board-send" title="Send (Enter)" aria-label="Send"><svg data-i="send" data-size="14"></svg></button></div>
    </div></div>`;
  paintIcons(el);
  const s: Surface = {
    name: `board:${key}`,
    chat: $('.board-chat', el),
    prompt: $<HTMLTextAreaElement>('textarea', el),
    send: $('.board-send', el),
    mode: $<HTMLSelectElement>('select', el),
    attachmentsEl: $('.composer-attachments', el),
  };
  registerSurface(s);
  const entry = saved?.historyId ? chatHistory(s).find(x => x.id === saved.historyId) : undefined;
  const tab = createAgentTab(s, `Box ${boxNumber(key)}`, entry?.html);
  tab.agentId = agent;
  tab.historyId = entry?.id;
  tab.sessions = { ...(saved?.sessions ?? {}) };
  activeTabId[s.name] = tab.id;
  tab.panel.classList.add('active');
  if (!entry) tab.panel.innerHTML = `<div class="empty"><div>${brandMark('board-empty-logo', agent, agentNameOf(agent)[0] ?? '?')}<h4>${esc(agentNameOf(agent))} is ready</h4><div class="empty-line">Its files stay its own. It asks the other boxes for changes in theirs.</div></div></div>`;
  const box: BoardBox = { key, agent, surface: s, tab, el, status: 'idle', runIds: new Set(), lastText: '', scrollPending: !!entry };
  if (typeof saved?.model === 'string') box.model = saved.model;
  const eff = EFFORTS.find(e => e === saved?.effort);
  if (eff) box.effort = eff;
  boardBoxes.set(key, box);
  wireBox(box);
  paintBox(box);
  renderBoard();
  return box;
}

const boxAgent = (box: { agent: string }) => appState.detect?.agents.find(a => a.id === box.agent);
function wireBox(box: BoardBox): void {
  const { el, surface: s } = box;
  // The prompt works as the Agents tab's: its text drawn by a layer, the agent's model chip and Full access once
  // something is typed, "/skill" suggestions, examples in the placeholder, and a height that eases as it grows.
  const kit: PromptKit = { ta: s.prompt, hl: $('.prompt-hl', el), models: $('.prompt-models', el), picked: () => { const a = boxAgent(box); return a ? [a] : []; }, mentions: false, anim: null, target: () => boxModelTarget(box) };
  box.kit = kit;
  wirePromptKit(kit);
  wireSlash(s); // before the send handler below, so Enter picks a skill instead of sending
  rotatePlaceholder(s.prompt, ' ', IDE_PLACEHOLDERS);
  $<HTMLButtonElement>('[data-full-access]', el).onclick = () => setFullAccess(!agentFullAccess);
  renderAccessSwitches();
  s.send.onclick = () => (tabBusy(box.tab) ? stopBox(box) : void sendBox(box));
  s.prompt.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!boxBusy(box)) void sendBox(box); }
  });
  s.prompt.addEventListener('input', () => syncPromptHl(kit));
  syncPromptHl(kit);
  $('.board-box-close', el).onclick = () => void emptyBox(box.key);
  $('.board-owns', el).onclick = e => ownsMenu(box, e.currentTarget as HTMLElement);
  $('.board-box-split', el).onclick = e => {
    const agents = foundAgents();
    if (!agents.length) { toast('No agents found. Install one from Settings.'); return; }
    openChipMenu(e.currentTarget as HTMLElement, agents.map(a => ({ label: agentShortName(a), run: () => addAgent(a.id) })));
  };
  $('.board-box-model', el).onclick = e => {
    const ag = boxAgent(box);
    if (ag) openChipMenu(e.currentTarget as HTMLElement, modelPickerItems(ag, false, boxModelTarget(box)));
  };
  $('.board-box-head', el).addEventListener('dblclick', e => {
    if ((e.target as HTMLElement).closest('button')) return;
    toggleMaxBox(box);
  });
}
function scrollRestoredChats(): void {
  for (const b of boardBoxes.values()) {
    if (!b.scrollPending || !b.surface.chat.clientHeight) continue;
    b.scrollPending = false;
    b.surface.chat.scrollTop = b.surface.chat.scrollHeight;
  }
}
function toggleMaxBox(box: BoardBox | null): void {
  morphBoard(() => {
    for (const b of boardBoxes.values()) if (b !== box) b.el.classList.remove('box-max');
    boardGrid.classList.toggle('has-max', !!box && box.el.classList.toggle('box-max'));
  });
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && boardPageShowing() && boardGrid.classList.contains('has-max') && !modalOpen()) toggleMaxBox(null);
});

function paintBox(box: BoardBox): void {
  if (tabBusy(box.tab)) box.status = boardWaiting(box.key) ? 'waiting' : 'working';
  else if (boardWaiting(box.key)) box.status = 'waiting';
  else if (box.status === 'working' || box.status === 'waiting') box.status = 'idle';
  $('.board-box-name', box.el).textContent = boxName(box);
  paintBoxModel(box);
  const dot = $('.board-dot', box.el);
  dot.dataset.status = box.status;
  dot.title = { idle: 'Idle', working: 'Working', waiting: 'Waiting on a teammate', done: 'Done', failed: 'Failed' }[box.status];
  dot.setAttribute('aria-label', dot.title);
  const owns = Object.values(boardOwners).filter(o => o === box.key).length;
  const ownsBtn = $('.board-owns', box.el);
  ownsBtn.textContent = owns ? plural(owns, 'file') : '';
  ownsBtn.classList.toggle('hidden', !owns);
  renderBoardStatus();
}

// Each box keeps its own model and effort (Claude · 1 on Opus, Claude · 2 on Sonnet). Until it picks, it shows and
// uses the agent's own. A pick goes with the box's runs (board:run) and is saved with the board.
function boxModelOf(box: BoardBox): string {
  const ag = boxAgent(box);
  const own = box.model && (!ag?.models?.length || ag.models.includes(box.model)) ? box.model : ''; // a model the agent dropped falls back
  return own || ag?.version || ag?.models?.[0] || '';
}
function boxEffortOf(box: BoardBox): EffortLevel {
  if (box.effort) return box.effort;
  const ag = boxAgent(box);
  return ag ? agentEffort(ag) : currentEffort();
}
function boxModelTarget(box: BoardBox): ModelTarget {
  return {
    model: () => boxModelOf(box),
    effort: () => boxEffortOf(box),
    set: (model, effort) => {
      box.model = model || undefined;
      box.effort = effort;
      paintBoxModel(box);
      if (box.kit) renderPromptModels(box.kit);
      saveBoard();
      toast(`${boxName(box)} will use ${versionLabel(model) || 'its default model'}${boxAgent(box)?.api ? '' : ` (${effort} effort)`}`);
    },
  };
}
// What board:run sends for a box: only what it picked itself, so an untouched box follows the agent's settings.
function boardPickOf(key: string): { model?: string; effort?: string } {
  const b = boardBoxes.get(key);
  if (!b) return {};
  const model = b.model ? boxModelOf(b) : '';
  return { ...(model ? { model } : {}), ...(b.effort ? { effort: b.effort } : {}) };
}
// The header's model, as the Agents tab's chip shows it: "Opus 4.6 · High" (a local model has no effort).
function paintBoxModel(box: BoardBox): void {
  const ag = boxAgent(box);
  const model = ag ? versionLabel(boxModelOf(box)) : '';
  const btn = $('.board-box-model', box.el);
  $('.bbm-label', btn).innerHTML = model ? `${esc(model)}${ag && !ag.api ? `<small> · ${esc(boxEffortOf(box))}</small>` : ''}` : '';
  btn.classList.toggle('no-model', !model);
  btn.setAttribute('aria-label', model ? `${agentShortName(ag!)} model: ${model}. Change model or effort` : 'Model and effort');
}
// A model or effort changed somewhere (renderAgentBar): every box's header and prompt chip show it.
function renderBoardModels(): void {
  for (const b of boardBoxes.values()) {
    paintBoxModel(b);
    if (b.kit) renderPromptModels(b.kit);
  }
}

async function sendBox(box: BoardBox): Promise<void> {
  const text = box.surface.prompt.value.trim();
  if (!text || boxBusy(box)) return;
  if (!rootInfo) { toast('Open a folder first, so the agents know what to work on'); return; }
  box.surface.prompt.value = '';
  if (box.kit) syncPromptHl(box.kit);
  personSpokeIn(box.key);
  if (box.tab.panel.querySelector('.empty')) box.tab.panel.innerHTML = '';
  sfx.play('send');
  userMsg(text, [], box.tab);
  await runBox(box, text);
}
// Starts a build run on this box (a person's message or a relay) and remembers its run id.
async function runBox(box: BoardBox, prompt: string): Promise<void> {
  const prev = msgSurface;
  msgSurface = box.surface;
  box.lastText = '';
  box.status = 'working';
  box.starting = true;
  try {
    await startAgentRun(box.agent, 'build', prompt, 'build', box.tab, false);
  } finally {
    box.starting = false;
    msgSurface = prev; // the IDE's own chat helpers go back to the IDE
  }
  if (box.tab.runId != null && box.tab.runId > 0) box.runIds.add(box.tab.runId);
  else box.status = 'failed';
  paintBox(box);
}
function stopBox(box: BoardBox): void {
  if (box.tab.runId != null && box.tab.runId > 0) stoppedRuns.add(box.tab.runId);
  stopAgent(box.tab);
  background(api.board.stop(box.key));
}
// `archive`: file its chat in this folder's history first (not when the folder already changed under it).
function removeBox(box: BoardBox, archive = true): void {
  if (archive) archiveChatTab(box.surface, box.tab);
  box.el.remove();
  boardBoxes.delete(box.key);
  surfaceTabs[box.surface.name] = [];
}
async function emptyBox(key: string): Promise<void> {
  const box = boardBoxes.get(key);
  if (!box) return;
  if (boxBusy(box)) stopBox(box);
  dropRelaysFor(key);
  if (box.el.classList.contains('box-max')) toggleMaxBox(null);
  background(api.board.clearBox(key));
  morphBoard(() => { removeBox(box); renderBoard(); saveBoard(); renderBoardStatus(); });
}

/* ----- Ownership: "owns N files", from main ----- */
let boardOwners: Record<string, string> = {};
function refreshOwners(o?: { owners: Record<string, string> } | Record<string, string>): void {
  const owners = o && 'owners' in o && typeof o.owners === 'object' ? o.owners as Record<string, string> : o as Record<string, string> | undefined;
  if (owners) boardOwners = owners;
  for (const b of boardBoxes.values()) paintBox(b);
}
const refreshOwnersSoon = (() => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => { clearTimeout(timer); timer = setTimeout(() => background(api.board.owners().then(refreshOwners)), 250); };
})();
function ownsMenu(box: BoardBox, btn: HTMLElement): void {
  const paths = Object.entries(boardOwners).filter(([, o]) => o === box.key).map(([p]) => p).sort();
  openChipMenu(btn, paths.map((p): MenuItem => ({
    label: p,
    sub: () => [
      { label: 'Open', run: () => { leaveBoard(); openFile(joinPath(rootInfo!.root, p)); } },
      { label: 'Release', run: () => background(api.board.release(p).then(() => api.board.owners()).then(refreshOwners)) },
    ],
  })));
}

/* ----- Run events: status, the last text (for relay replies), and the relays themselves ----- */
const boxForRun = (runId: number) => [...boardBoxes.values()].find(b => b.runIds.has(runId));
api.agent.onEvent((runId, ev) => {
  const box = boxForRun(runId);
  if (!box || boardFolder !== (rootInfo?.root ?? null)) return; // the folder changed: main stopped these runs
  const stopped = stoppedRuns.has(runId);
  if (ev.t === 'text') box.lastText = ev.text ?? '';
  else if (ev.t === 'file' || ev.t === 'written') refreshOwnersSoon();
  else if (ev.t === 'relay') { if (!stopped && !echoesAnswer(relayRuns.get(runId), ev.to ?? '')) onRelay(box, ev); }
  else if (ev.t === 'done') {
    box.status = ev.ok ? 'done' : ev.stopped || stopped ? 'idle' : 'failed';
    refreshOwnersSoon();
    // After the chat's own done handler has run (tab.runId is free again).
    setTimeout(() => { paintBox(box); onBoxIdle(box, runId, stopped || !!ev.stopped); saveBoard(); }, 0);
    return;
  }
  paintBox(box);
});

/* ----- Saved per folder: which agent is in which box, and each box's chat ----- */
function saveBoard(): void {
  if (!rootInfo || boardFolder !== rootInfo.root) return; // never file one folder's boxes under another
  const boxes: BoardSaved['boxes'] = {};
  for (const b of boardBoxes.values()) {
    archiveChatTab(b.surface, b.tab);
    boxes[b.key] = { agent: b.agent, historyId: b.tab.historyId, sessions: b.tab.sessions, model: b.model, effort: b.effort };
  }
  store.set(boardStoreKey(), { boxes } satisfies BoardSaved);
}
function loadBoard(): void {
  // The boxes on screen belong to `boardFolder`; their chats were filed there as they finished.
  const sameFolder = boardFolder === (rootInfo?.root ?? null);
  for (const b of [...boardBoxes.values()]) { if (boxBusy(b)) stopBox(b); removeBox(b, sameFolder); }
  resetRelays();
  boardGrid.innerHTML = '';
  boardOwners = {};
  boardFolder = rootInfo?.root ?? null;
  const saved = store.get<BoardSaved>(boardStoreKey(), { boxes: {} });
  for (const [key, s] of Object.entries(saved.boxes ?? {})) {
    if (allBoxKeys().includes(key) && typeof s?.agent === 'string') fillBox(key, s.agent, s);
  }
}

$('#boardStopAll').onclick = () => {
  for (const b of boardBoxes.values()) if (boxBusy(b)) stopBox(b);
  background(api.board.stopAll());
  stopAllRelays();
  toast('Stopped every box');
};

/* ----- Status bar: "Agent board — 2 working · Open" while the page is hidden ----- */
function renderBoardStatus(): void {
  let pill = document.getElementById('boardStatus');
  const working = [...boardBoxes.values()].filter(b => tabBusy(b.tab)).length;
  if (!working || boardPageShowing()) { pill?.remove(); return; }
  if (!pill) {
    pill = document.createElement('button');
    pill.id = 'boardStatus';
    pill.className = 'sb board-status';
    pill.title = 'Open the Agent board';
    pill.onclick = openBoard;
    $('#sbDebug').before(pill);
  }
  pill.innerHTML = `${svgIcon('layoutGrid', 12)}<span>Agent board — ${working} working · Open</span>`;
}

/* ----- Relays: a box asks another for a change in its files, and the answer comes back ----- */
const relayQueue = new RelayQueue(3);
const openAsks = new Map<string, Set<string>>();     // asking box -> its relays not yet answered
const relayRuns = new Map<number, Relay>();          // run id -> the relay that run is answering
const relayCards = new Map<string, HTMLElement>();   // relay id -> its card in the receiving box
const AUTO_KEY = 'breeze.board.auto';
const boxLabel = (key: string) => { const b = boardBoxes.get(key); return b ? boxName(b) : `Box ${boxNumber(key)}`; };
const boxBadge = (key: string) => {
  const b = boardBoxes.get(key);
  return `<span class="agent-tag">${b ? brandMark('agent-tag-logo', b.agent, agentNameOf(b.agent)[0] ?? '?') : ''}<b>${esc(boxLabel(key))}</b></span>`;
};
const boxIdle = (key: string) => { const b = boardBoxes.get(key); return !!b && !boxBusy(b); };
const relayId = () => `rl_${crypto.randomUUID().slice(0, 8)}`;

function boardWaiting(key: string): boolean { return (openAsks.get(key)?.size ?? 0) > 0; }
function personSpokeIn(key: string): void { relayQueue.personSpoke(key); }

// Main's crossing on a board run: "Claude · 1 tried to edit api.ts (Codex · 2's). Breeze put it back and asked Codex."
function boardCrossingCard(ev: AgentEvent, tab: AgentTabState): void {
  const who = boxLabel(ev.agent ?? boxKeyOf(tab.surfaceName));
  const ownerBox = ev.owner ? boardBoxes.get(ev.owner) : undefined;
  const owner = ev.owner ? boxLabel(ev.owner) : 'a teammate';
  const ownerShort = ownerBox ? agentNameOf(ownerBox.agent) : owner;
  const at = `<code>${esc(ev.path ?? '')}</code> (${esc(owner)}'s)`;
  let head: string;
  if (ev.blocked) head = `${esc(who)} tried to edit ${at} and was stopped. Breeze asked ${esc(ownerShort)}.`;
  else if (ev.error) head = `${esc(who)} tried to edit ${at}. Breeze couldn't put it back: ${esc(ev.error)}`;
  else head = `${esc(who)} tried to edit ${at}. Breeze put it back and asked ${esc(ownerShort)}.`;
  sfx.play('tool');
  addMsg(`<div class="card crossing"><h5>${svgIcon('alert', 14)} Crossing</h5><p>${head}</p></div>`, tab);
}

// A `relay` event from main, on the asking box's run.
function onRelay(from: BoardBox, ev: AgentEvent): void {
  const to = ev.to ?? '';
  const r: Relay = { id: relayId(), from: from.key, to, kind: 'ask', path: ev.path, diff: ev.diff, note: ev.note };
  if (!boardBoxes.has(to)) {
    const el = addMsg(`<div class="card relay"><h5>${svgIcon('arrowRight', 14)} ${esc(boxLabel(to))} is empty</h5><p>Nobody can make this change for ${esc(boxName(from))}.</p><div class="row" data-live><button class="btn btn-sm" data-relay-drop>Drop</button></div></div>`, from.tab);
    el.querySelector<HTMLElement>('[data-relay-drop]')!.onclick = () => el.remove();
    return;
  }
  const what = r.path ? ` in <code>${esc(r.path)}</code>` : '';
  addMsg(`<div class="card relay"><h5>${svgIcon('arrowRight', 14)} Asked ${boxBadge(to)}</h5><p>For a change${what}. Its answer comes back here.</p></div>`, from.tab);
  if (!openAsks.has(from.key)) openAsks.set(from.key, new Set());
  openAsks.get(from.key)!.add(r.id);
  paintBox(from);
  deliver(r);
}

// `sent`: the person pressed Send on it (it goes even with Auto-relay off).
function deliver(r: Relay, sent = false): void {
  const target = boardBoxes.get(r.to);
  if (!target) { closeAsk(r); return; }
  const outcome = relayQueue.push(r, boxIdle, sent);
  if (outcome === 'start') { void startRelay(r); return; }
  const card = incomingCard(r, target);
  const wait = card.querySelector<HTMLElement>('.relay-wait')!;
  if (outcome === 'queued') {
    wait.textContent = `Waiting for ${boxName(target)} to finish.`;
    return;
  }
  const why = relayQueue.auto ? `${boxLabel(r.from)} and ${boxName(target)} went back and forth ${relayQueue.limit} times, so this one waits.` : 'Auto-relay is off.';
  wait.innerHTML = `${esc(why)} Send it?<span class="row" data-live><button class="btn btn-sm btn-primary" data-relay-send>Send</button><button class="btn btn-sm" data-relay-drop>Drop</button></span>`;
  wait.querySelector<HTMLElement>('[data-relay-send]')!.onclick = () => {
    const sent = relayQueue.send(r.id);
    if (sent) deliver(sent, true);
  };
  wait.querySelector<HTMLElement>('[data-relay-drop]')!.onclick = () => {
    relayQueue.drop(r.id);
    wait.textContent = 'Dropped.';
    closeAsk(r);
  };
}

// The card in the receiving box: who asks (or answers), and the change or note. Drawn once per relay.
function incomingCard(r: Relay, target: BoardBox): HTMLElement {
  const had = relayCards.get(r.id);
  if (had?.isConnected) return had;
  if (target.tab.panel.querySelector('.empty')) target.tab.panel.innerHTML = '';
  const title = r.kind === 'reply' ? `Reply from ${boxBadge(r.from)}` : `From ${boxBadge(r.from)}`;
  const file = r.path ? `<p>Wants a change in <code>${esc(r.path)}</code>, which this box owns.</p>` : '';
  const diff = r.diff ? `<pre>${esc(r.diff)}</pre>` : '';
  const note = r.note ? `<div class="relay-note">${md(r.note)}</div>` : '';
  const el = addMsg(`<div class="card relay"><h5>${svgIcon(r.kind === 'reply' ? 'check' : 'arrowRight', 14)} ${title}</h5>${file}${diff}${note}<p class="relay-wait"></p></div>`, target.tab);
  relayCards.set(r.id, el);
  return el;
}

async function startRelay(r: Relay): Promise<void> {
  const target = boardBoxes.get(r.to);
  if (!target || boardFolder !== (rootInfo?.root ?? null)) { closeAsk(r); return; }
  if (boxBusy(target)) { deliver(r); return; } // it got busy meanwhile: wait for it
  const card = incomingCard(r, target);
  const wait = card.querySelector('.relay-wait');
  if (wait) wait.textContent = r.kind === 'reply' ? 'Continuing.' : 'Working on it.';
  sfx.play('send');
  await runBox(target, relayPrompt(r, boxLabel(r.from)));
  const runId = target.tab.runId;
  if (runId != null && runId > 0) relayRuns.set(runId, r);
  else closeAsk(r);
}

function closeAsk(r: Relay): void {
  if (r.kind !== 'ask') return;
  openAsks.get(r.from)?.delete(r.id);
  const b = boardBoxes.get(r.from);
  if (b) paintBox(b);
}

// A box's run ended: an answered ask goes back to the asker, then the next relay waiting for this box starts.
// A stopped run answers nobody: the asker hears it was stopped, and nothing waiting for this box starts on its own.
function onBoxIdle(box: BoardBox, runId: number, stopped = false): void {
  const answered = relayRuns.get(runId);
  if (answered) {
    relayRuns.delete(runId);
    const wait = relayCards.get(answered.id)?.querySelector('.relay-wait');
    if (wait) wait.textContent = stopped ? 'Stopped.' : box.status === 'failed' ? 'Couldn’t finish.' : answered.kind === 'ask' ? 'Answered.' : '';
    if (answered.kind === 'ask') {
      closeAsk(answered);
      const asker = boardBoxes.get(answered.from);
      if (stopped && asker) {
        addMsg(`<div class="card relay"><h5>${svgIcon('stop', 14)} ${esc(boxName(box))} was stopped</h5><p>It didn't finish the change you asked for.</p></div>`, asker.tab);
      } else if (boardBoxes.has(answered.from)) {
        const text = box.lastText.trim().slice(-2000) || (box.status === 'failed' ? `${boxName(box)} couldn't finish.` : 'Done.');
        deliver({ id: relayId(), from: box.key, to: answered.from, kind: 'reply', note: text });
      }
    }
  }
  if (stopped || boxBusy(box)) return;
  const next = relayQueue.next(box.key);
  if (next) void startRelay(next);
}

// A box is emptied or replaced: what waited for it is dropped, and each box that asked it is told.
function dropRelaysFor(key: string): void {
  const told = new Set<string>();
  const tell = (r: Relay) => {
    closeAsk(r);
    const asker = r.kind === 'ask' && r.to === key ? boardBoxes.get(r.from) : undefined;
    if (!asker || told.has(asker.key)) return;
    told.add(asker.key);
    addMsg(`<div class="card relay"><h5>${svgIcon('x', 14)} ${esc(boxLabel(key))} was emptied</h5><p>Nobody will make the change you asked it for.</p></div>`, asker.tab);
  };
  for (const r of relayQueue.dropFor(key)) tell(r);
  for (const [id, r] of [...relayRuns]) {
    if (r.from !== key && r.to !== key) continue;
    relayRuns.delete(id);
    tell(r);
  }
  openAsks.delete(key);
}
function stopAllRelays(): void {
  // Cards still waiting or asking for Send say so instead of keeping buttons that do nothing.
  for (const card of relayCards.values()) {
    const wait = card.querySelector('.relay-wait');
    if (wait && (wait.querySelector('button') || wait.textContent?.startsWith('Waiting'))) wait.textContent = 'Stopped.';
  }
  for (const r of relayQueue.stopAll()) closeAsk(r);
  // Relays being answered right now stay in relayRuns: each stopped run's done (onBoxIdle) marks its card
  // "Stopped." and tells the box that asked.
  for (const b of boardBoxes.values()) paintBox(b);
}
function resetRelays(): void {
  relayQueue.stopAll();
  openAsks.clear();
  relayRuns.clear();
  relayCards.clear();
}

// Auto-relay: on by default, remembered.
{
  const sw = $('#boardAuto');
  const set = (on: boolean) => { relayQueue.auto = on; sw.setAttribute('aria-checked', String(on)); sw.classList.toggle('on', on); };
  set(store.get<boolean>(AUTO_KEY, true));
  sw.onclick = () => { set(!relayQueue.auto); store.set(AUTO_KEY, relayQueue.auto); };
}
