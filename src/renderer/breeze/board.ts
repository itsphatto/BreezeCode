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
  live: LivePane;          // the file its agent is editing, at its left while the bar's Code switch is on (paintBoardLive)
  liveHidden?: boolean;    // the person closed that panel; the header's code button opens it again
  liveFrac?: number;       // its width as a share of the box, once dragged (paintLiveWidth)
  side?: BoxSide;          // the side panel shows its terminal or a page preview instead of the code (paintBoardLive)
  term?: BoxTerminal;      // made the first time its terminal opens
  preview?: PreviewView;   // made the first time its preview opens
  ctx?: BoxContext;        // how full its chat's context window was after the last request (paintBoxContext)
}
type BoxSide = 'term' | 'preview';
interface BoxContext { used: number; window: number }
const boxBusy = (b: BoardBox) => tabBusy(b.tab) || !!b.starting;
const stoppedRuns = new Set<number>(); // runs the person stopped: their late relays and replies are dropped
// `order`: the boxes' order on the page, when a chat dropped on a box's side put one out of number order.
interface BoardSaved { boxes: Record<string, { agent: string; historyId?: string; sessions?: Record<string, string>; model?: string; effort?: string; liveFrac?: number; side?: BoxSide; ctx?: BoxContext }>; order?: string[] }

const BOARD_MAX = 8;
const boardBoxes = new Map<string, BoardBox>();
// Boxes taken off the board while their agent was still working (New chat, or another chat opened alone): they keep
// running out of sight, keep their key (so main's ownership and relays stay theirs), and close once their run ends.
// Clicking the chat in the side bar puts the box back on the board.
const parkedBoxes = new Map<string, BoardBox>();
const allBoardBoxes = () => [...boardBoxes.values(), ...parkedBoxes.values()];
const anyBox = (key: string) => boardBoxes.get(key) ?? parkedBoxes.get(key);
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
  renderBoardSide();
  loadBoardLogs();
  placeBoardRailIndicator();
  refreshBoardLimits();
  // A hidden page loses its scroll, so coming back each chat opens on its latest message.
  for (const b of boardBoxes.values()) b.scrollPending = true;
  requestAnimationFrame(scrollRestoredChats);
  background(api.board.open().then(refreshOwners));
}
function leaveBoard(): void {
  showIde();
  renderBoardStatus();
}
// The switcher replaced Back to editor (breeze.html): $('#boardBack').onclick = leaveBoard;
// Its Code half leaves the same way (mode.ide), then the status bar says what the boxes are still doing.
$('#board .mode-switch [data-mode="ide"]').addEventListener('click', () => setTimeout(renderBoardStatus, 0));
$('#boardLogoHome').onclick = () => { goHome(); renderBoardStatus(); };
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
// Redrawn each time the board opens: only a change is put in, chips that stay sliding over and new ones growing in.
let rosterShown = '';
function renderRoster(): void {
  const roster = $('#boardRoster');
  const agents = foundAgents();
  const html = agents.length
    ? agents.map(a => `<span class="board-chip" role="listitem" draggable="true" tabindex="0" data-agent="${escAttr(a.id)}" title="Click to add ${escAttr(agentShortName(a))}, or drag it into a box">${brandMark('board-chip-logo', a.id, agentShortName(a)[0] ?? '?')}<b>${esc(agentShortName(a))}</b></span>`).join('')
    : `<button class="btn btn-sm" type="button" data-board-pick>Choose an agent</button>`;
  if (rosterShown === html) return;
  rosterShown = html;
  flip(() => [...roster.children] as HTMLElement[], () => { roster.innerHTML = html; }, el => el.dataset.agent ?? 'pick');
  roster.querySelector<HTMLElement>('[data-board-pick]')?.addEventListener('click', openAgentPicker);
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
// A click on a chip starts a fresh chat with that agent, alone on the board; Enter does the same from the keyboard.
// Dragging a chip onto the board is how it goes beside the boxes already there.
$('#boardRoster').addEventListener('click', e => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('.board-chip');
  if (chip) freshBoard(chip.dataset.agent!);
});
$('#boardRoster').addEventListener('keydown', e => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('.board-chip');
  if (!chip || e.key !== 'Enter') return;
  e.preventDefault(); // or Enter types a newline into the new box's prompt, which takes the focus
  freshBoard(chip.dataset.agent!);
});

/* ----- The grid: only the filled boxes, laid out for how many there are (boardlayout.ts) ----- */
// No agent yet: one empty box fills the page. While a chip is dragged, an empty spot opens where it would land.
const allBoxKeys = () => Array.from({ length: BOARD_MAX }, (_, i) => `box${i + 1}`);
const firstFreeKey = () => allBoxKeys().find(k => !boardBoxes.has(k) && !parkedBoxes.has(k));
let boardDragging = false;
function endBoardDrag(): void {
  boardGrid.classList.remove('dragging');
  for (const o of boardGrid.querySelectorAll<HTMLElement>('.drop-on')) o.classList.remove('drop-on'); // a cancelled drag
  if (!boardDragging) return;
  boardDragging = false;
  morphBoard(renderBoard);
}
// The boxes' order on the page (the tiles fill left to right, then down): those a side drop placed, then the rest by number.
let boardOrder: string[] = [];
const orderOf = (k: string) => { const i = boardOrder.indexOf(k); return i < 0 ? BOARD_MAX + boxNumber(k) : i; };
const byOrder = (a: string, b: string) => orderOf(a) - orderOf(b);
// `key` goes just before (left) or after (right) `by`; every box gets a place, so the order holds as boxes come and go.
function placeBox(key: string, by: string, side: DropSide): void {
  const order = [...boardBoxes.keys()].filter(k => k !== key).sort(byOrder);
  const i = order.indexOf(by);
  order.splice(i < 0 ? order.length : side === 'left' ? i : i + 1, 0, key);
  boardOrder = order;
}
// The boxes on the page, in that order: the filled ones, and the one empty spot (none filled, or a chip being dragged).
function shownBoxKeys(): string[] {
  const free = firstFreeKey();
  const open = free && (!boardBoxes.size || boardDragging) ? [free] : [];
  return [...boardBoxes.keys(), ...open].sort(byOrder);
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
  paintBoardLive();
}
/* ----- The file a box's agent is editing: at the left of its chat, in every box ----- */
// It takes up to half the box (breeze.css sizes it by the box's width). Settings → Agents → Agent Board → Code turns the panel on or off for every box (remembered); each box's code button hides its own.
const CODE_KEY = 'breeze.board.code';
let boardCodeOn = store.get<boolean>(CODE_KEY, true);
// The same panel shows the box's own terminal or a preview of the project's page instead, while one of the header's
// buttons for them is on (box.side); turning it off brings the code back (or closes the panel, with no code to show).
function paintBoardLive(): void {
  for (const b of boardBoxes.values()) {
    const has = !!b.live.path;
    const was = b.el.classList.contains('live-on');
    const code = !b.side && boardCodeOn && has && !b.liveHidden;
    const on = code || !!b.side;
    b.el.classList.toggle('live-on', on);
    const pane = $('.board-live', b.el), view = b.side ?? 'code';
    if (pane.dataset.view !== view) {
      pane.dataset.view = view;
      // Switched while open: the other view settles in where the last one was, rather than replacing it in a blink.
      if (was && on) for (const part of pane.children) if (part.checkVisibility()) settleIn(part);
    }
    const btn = $('.board-box-code', b.el);
    morphShow(btn, boardCodeOn && has);
    btn.setAttribute('aria-pressed', String(code));
    const label = code ? 'Hide the file the agent is editing' : 'Show the file the agent is editing';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    for (const [cls, view, name] of [['.board-box-term', 'term', 'a terminal'], ['.board-box-preview', 'preview', 'a preview of the page']] as const) {
      const v = $(cls, b.el), lit = b.side === view;
      v.setAttribute('aria-pressed', String(lit));
      v.title = lit ? `Hide ${name}` : `Show ${name} beside the chat`;
      v.setAttribute('aria-label', v.title);
    }
    if (code && !was) requestAnimationFrame(() => b.live.reveal());
  }
}
// The header's code, terminal and preview buttons pick what the side panel shows; the one already showing closes it.
function showBoxSide(box: BoardBox, view: BoxSide | 'code'): void {
  const showing = box.el.classList.contains('live-on') ? (box.side ?? 'code') : null;
  if (showing === view) {
    // Off: a terminal or preview hands the panel back to the code, unless that was hidden.
    if (view === 'code') box.liveHidden = true;
    box.side = undefined;
  } else if (view === 'code') {
    box.side = undefined;
    box.liveHidden = false;
  } else {
    box.side = view;
    openBoxSide(box, view);
  }
  paintBoardLive();
  saveBoard();
  if (box.side === 'term') requestAnimationFrame(() => box.term?.focus());
}
// Makes the box's terminal or preview the first time it is shown; a preview starts on the project's page.
function openBoxSide(box: BoardBox, view: BoxSide): void {
  const pane = $('.board-live', box.el);
  if (view === 'term' && !box.term) {
    box.term = new BoxTerminal(rootInfo?.root ?? '');
    pane.append(box.term.root);
  }
  if (view === 'preview' && !box.preview) {
    const root = $('.board-preview', pane);
    const preview = box.preview = new PreviewView({
      root,
      frame: $<HTMLIFrameElement>('.preview-frame', root),
      url: $('.url', root),
      urlText: $('.bp-url-text', root),
      inspect: $<HTMLButtonElement>('.bp-inspect', root),
      full: $<HTMLButtonElement>('.bp-full', root),
      empty: $('.bp-empty', root),
      hint: $('.bp-hint', root),
    }, {
      target: () => boxPreviewTarget(box),
      ask: text => {
        if (document.fullscreenElement) void document.exitFullscreen();
        insertAtPrompt(box.surface.prompt, text);
      },
      openSource: (path, at) => {
        if (document.fullscreenElement) void document.exitFullscreen();
        leaveBoard();
        openFile(path, at);
      },
      detachFull: true,
    });
    $('.bp-reload', root).onclick = () => void (preview.running ? preview.reload() : preview.start());
    preview.render();
    void preview.start();
  }
}
// The page a box previews: the page its agent last touched, else the project's index.html, else the first page found
// (an index.html in a folder before any other).
async function boxPreviewTarget(box: BoardBox): Promise<string | null> {
  const touched = box.live.path?.replaceAll('\\', '/') ?? null;
  if (touched && /\.html?$/i.test(touched)) return touched;
  const top = (dirCache.get('') ?? []).find(e => !e.dir && /^index\.html?$/i.test(e.name))?.name;
  if (top) return top;
  const pages = (await api.fs.listFiles().catch(() => [] as string[])).filter(p => /\.html?$/i.test(p));
  const rank = (p: string) => (/(^|\/)index\.html?$/i.test(p) ? 0 : 1000) + p.split('/').length;
  return pages.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0] ?? null;
}
// Pages update as they change on disk: the agent's writes, a save in the editor, a command in the terminal.
api.fs.onChange(paths => { for (const b of boardBoxes.values()) b.preview?.changed(paths); });
function setBoardCode(on: boolean): void {
  boardCodeOn = on;
  store.set(CODE_KEY, on);
  if (on) for (const b of boardBoxes.values()) b.liveHidden = false; // on again: every box shows its file
  paintBoardLive();
}
paintBoardLive();
function boardLiveFile(key: string, path: string): void { anyBox(key)?.live.file(path); }
function boardLiveDraft(key: string, path: string, text: string, phase?: string): void { anyBox(key)?.live.draft(path, text, phase); }
// Grid lines for each box; on a page too narrow for them side by side, two to a row with rows to scroll to.
// With room for them, the boxes are tiles placed by boardTiles, with a handle in each gap to drag them wider or taller
// (any number of boxes). Too narrow, the scrolling grid of boardLayout, without handles.
function layoutBoard(): void {
  const els = Array.from(boardGrid.children) as HTMLElement[];
  const lay = boardLayout(els.length, boardGrid.clientWidth);
  const tiles = !lay.scroll && boardGrid.clientWidth > 0;
  boardGrid.classList.toggle('tiles', tiles);
  boardGrid.style.gridTemplateColumns = tiles ? '' : `repeat(${lay.cols}, minmax(0, 1fr))`;
  boardGrid.style.gridTemplateRows = tiles || lay.scroll ? '' : `repeat(${lay.rows}, minmax(0, 1fr))`;
  boardGrid.classList.toggle('scroll', lay.scroll);
  boardGrid.dataset.count = String(els.length);
  if (tiles) {
    const w = boardGrid.clientWidth, h = boardGrid.clientHeight;
    const gap = parseFloat(getComputedStyle(boardGrid).columnGap) || 0;
    const t = boardTiles(els.length, w, h, gap, boardSplits);
    const maxed = boardGrid.classList.contains('has-max');
    els.forEach((el, i) => {
      const r = maxed && el.classList.contains('box-max') ? { x: 0, y: 0, w, h } : t.boxes[i];
      el.style.gridArea = '';
      if (r) Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    });
    paintBoardSashes(maxed ? [] : t.sashes);
  } else {
    els.forEach((el, i) => {
      const c = lay.cells[i];
      el.style.gridArea = c ? `${c.row} / ${c.col} / span ${c.rowSpan} / span ${c.colSpan}` : '';
      Object.assign(el.style, { left: '', top: '', width: '', height: '' });
    });
    paintBoardSashes([]);
  }
}
new ResizeObserver(() => { if (boardGrid.children.length) layoutBoard(); }).observe(boardGrid);

/* ----- Handles between the boxes: drag to share the room differently, double-click for an even split ----- */
// Sizes are kept per box count and split (boardTiles), so going back to two boxes brings back the two-box sizes.
const SPLITS_KEY = 'breeze.board.splits';
const boardSplits: Record<string, number[]> = store.get<Record<string, number[]>>(SPLITS_KEY, {});
const BOX_MIN_W = 260, BOX_MIN_H = 160; // a chat and its prompt still fit
const boardSashLayer = document.createElement('div');
boardSashLayer.className = 'board-sashes';
boardGrid.after(boardSashLayer);
let boardSashes: TileSash[] = [];
function paintBoardSashes(list: TileSash[]): void {
  boardSashes = list;
  Object.assign(boardSashLayer.style, {
    left: `${boardGrid.offsetLeft}px`, top: `${boardGrid.offsetTop}px`, width: `${boardGrid.clientWidth}px`, height: `${boardGrid.clientHeight}px`,
  });
  // The same elements stay while dragging, so the one under the pointer keeps its capture.
  while (boardSashLayer.children.length > list.length) boardSashLayer.lastElementChild!.remove();
  while (boardSashLayer.children.length < list.length) {
    const el = document.createElement('div');
    el.setAttribute('role', 'separator');
    el.title = 'Drag to resize · double-click to reset';
    boardSashLayer.append(el);
  }
  list.forEach((s, i) => {
    const el = boardSashLayer.children[i] as HTMLElement;
    const active = el.classList.contains('active');
    el.className = `board-sash ${s.dir === 'row' ? 'sash-across' : 'sash-down'}`;
    el.classList.toggle('active', active);
    el.dataset.i = String(i);
    el.setAttribute('aria-orientation', s.dir === 'row' ? 'vertical' : 'horizontal');
    el.setAttribute('aria-label', s.dir === 'row' ? 'Resize the boxes on either side' : 'Resize the boxes above and below');
    Object.assign(el.style, { left: `${s.rect.x}px`, top: `${s.rect.y}px`, width: `${s.rect.w}px`, height: `${s.rect.h}px` });
  });
}
// Drags `handle` until the pointer is let go; `move` gets each pointer position.
function dragHandle(handle: HTMLElement, e: PointerEvent, cursor: 'x' | 'y', move: (ev: PointerEvent) => void, done: () => void): void {
  e.preventDefault();
  handle.setPointerCapture(e.pointerId);
  handle.classList.add('active');
  const root = document.documentElement, cls = `board-resizing-${cursor}`;
  root.classList.add(cls);
  const up = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', up);
    handle.classList.remove('active');
    root.classList.remove(cls);
    done();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
}
const sashAt = (e: Event) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.board-sash');
  const s = el ? boardSashes[Number(el.dataset.i)] : undefined;
  return el && s ? { el, s } : null;
};
boardSashLayer.addEventListener('pointerdown', e => {
  const hit = sashAt(e);
  if (!hit || e.button !== 0) return;
  const { el, s } = hit, across = s.dir === 'row';
  const start = across ? e.clientX : e.clientY, from = boardSplits[s.key];
  dragHandle(el, e, across ? 'x' : 'y', ev => {
    boardSplits[s.key] = dragShares(from, s.count, s.index, (across ? ev.clientX : ev.clientY) - start, s.span, across ? BOX_MIN_W : BOX_MIN_H);
    layoutBoard();
  }, () => store.set(SPLITS_KEY, boardSplits));
});
boardSashLayer.addEventListener('dblclick', e => {
  const hit = sashAt(e);
  if (!hit) return;
  delete boardSplits[hit.s.key];
  store.set(SPLITS_KEY, boardSplits);
  layoutBoard();
});

/* ----- The code view's own handle, at its left: drag to widen it, double-click for the default ----- */
// Kept as a share of the box, so it follows when the box is resized; the last one dragged is where new boxes start.
const LIVE_FRAC_KEY = 'breeze.board.liveFrac';
const LIVE_MIN_W = 200, CHAT_MIN_W = 240;
function paintLiveWidth(box: BoardBox): void {
  const el = $('.board-live', box.el);
  if (box.liveFrac) el.style.setProperty('--live-w', `clamp(${LIVE_MIN_W}px, ${(box.liveFrac * 100).toFixed(2)}cqw, max(${LIVE_MIN_W}px, calc(100cqw - ${CHAT_MIN_W}px)))`);
  else el.style.removeProperty('--live-w');
}
function wireLiveSash(box: BoardBox): void {
  const sash = $('.board-live-sash', box.el), body = $('.board-box-body', box.el);
  sash.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    box.el.classList.add('live-resizing'); // no width easing while it follows the pointer
    dragHandle(sash, e, 'x', ev => {
      const r = body.getBoundingClientRect();
      if (r.width <= 0) return;
      const px = Math.min(Math.max(r.right - ev.clientX, LIVE_MIN_W), Math.max(LIVE_MIN_W, r.width - CHAT_MIN_W));
      box.liveFrac = px / r.width;
      paintLiveWidth(box);
    }, () => {
      box.el.classList.remove('live-resizing');
      if (box.liveFrac) store.set(LIVE_FRAC_KEY, box.liveFrac);
      saveBoard();
    });
  });
  sash.addEventListener('dblclick', () => { box.liveFrac = undefined; store.set(LIVE_FRAC_KEY, 0); paintLiveWidth(box); saveBoard(); });
}

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

// New chat, an agent clicked in the roster and a chat picked in the side bar each take the whole board: the boxes there
// have their chats filed away and close first (a working one is asked about). Dragging is how boxes go side by side.
// A working box is not stopped: it is parked (parkedBoxes) and carries on out of sight.
function closeBoxes(boxes: BoardBox[]): void {
  for (const b of boxes) {
    if (b.el.classList.contains('box-max')) toggleMaxBox(null);
    if (boxBusy(b)) { parkBox(b); continue; }
    dropRelaysFor(b.key);
    background(api.board.clearBox(b.key));
    removeBox(b);
  }
}
function parkBox(b: BoardBox): void {
  archiveChatTab(b.surface, b.tab);
  b.el.remove();
  boardBoxes.delete(b.key);
  boardOrder = boardOrder.filter(k => k !== b.key);
  parkedBoxes.set(b.key, b);
}
function unparkBox(b: BoardBox): void {
  parkedBoxes.delete(b.key);
  boardBoxes.set(b.key, b);
  b.scrollPending = true;
  paintBox(b);
}
// A parked box whose run has ended closes, its chat filed in the side bar (unless a relay started it again).
function finishParked(b: BoardBox): void {
  if (parkedBoxes.get(b.key) !== b || boxBusy(b)) return;
  parkedBoxes.delete(b.key);
  dropRelaysFor(b.key);
  background(api.board.clearBox(b.key));
  removeBox(b);
  renderBoardStatus();
}
const workingBoxes = (except?: BoardBox) => allBoardBoxes().filter(b => b !== except && boxBusy(b)).length;
// The keys left once the board is cleared: working boxes keep theirs while they run in the background.
const freeKeysAfterClear = () => allBoxKeys().filter(k => !parkedBoxes.has(k) && !(boardBoxes.has(k) && boxBusy(boardBoxes.get(k)!)));
const BOARD_ALL_BUSY = `${BOARD_MAX} chats are still working. Wait for one to finish, or stop one first.`;
function freshBoard(agent: string): void {
  const blank = blankBoxFor(agent);
  if (blank) { blank.surface.prompt.focus(); return; }
  const key = freeKeysAfterClear()[0];
  if (!key) { toast(BOARD_ALL_BUSY); return; }
  morphBoard(() => {
    closeBoxes([...boardBoxes.values()]);
    fillBox(key, agent);
    renderBoard();
    saveBoard();
    renderBoardStatus();
    renderBoardSide();
    boardBoxes.get(key)?.surface.prompt.focus();
  });
  sfx.play('send');
}
// The board is already one fresh chat with this agent, nothing asked yet: New chat (or its chip) stays on it, as
// Breeze Space's New chat does, instead of playing the swap to an identical box.
function blankBoxFor(agent: string): BoardBox | undefined {
  const only = boardBoxes.size === 1 ? [...boardBoxes.values()][0] : undefined;
  return only?.agent === agent && !only.tab.historyId && only.tab.panel.querySelector('.empty') ? only : undefined;
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
  swapText($('.board-drop-title', el), spot ? 'Drop here to add it' : 'Drop an agent or a chat here');
  swapText($('.board-drop-hint', el), spot ? 'The boxes make room for it' : 'or click to pick one');
  el.setAttribute('aria-label', spot ? `Box ${boxNumber(key)}, a spot for the agent you are dragging.` : 'No agent yet. Click or press Enter to pick one.');
}
const BOARD_DRAG_TYPES = ['text/breeze-agent', 'text/breeze-chat']; // an agent from the roster, a chat from the side bar
const boardDrag = (e: DragEvent) => !!e.dataTransfer && BOARD_DRAG_TYPES.some(t => e.dataTransfer!.types.includes(t));
// A chat dragged over another chat's box lights the half it would open on (left or right); let go, it opens there.
type DropSide = 'left' | 'right';
function dropSideOf(e: DragEvent, el: HTMLElement): DropSide | null {
  const box = boardBoxes.get(el.dataset.box!);
  if (!box || boxBlank(box) || !e.dataTransfer?.types.includes('text/breeze-chat')) return null;
  const r = el.getBoundingClientRect();
  return e.clientX < r.left + r.width / 2 ? 'left' : 'right';
}
boardGrid.addEventListener('dragover', e => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.board-box');
  if (!el || !boardDrag(e) || !e.dataTransfer) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  // The panel (breeze.css .board-box::after) fades out where it was, so the side is left on a box it leaves. A box it
  // comes into takes its side first, then lights: it fades in on that half, and only slides while it is on screen.
  for (const o of boardGrid.querySelectorAll<HTMLElement>('.drop-on')) if (o !== el) o.classList.remove('drop-on');
  const side = dropSideOf(e, el);
  const entering = !el.classList.contains('drop-on');
  if (side) el.dataset.dropSide = side; else delete el.dataset.dropSide;
  if (entering) { void el.offsetWidth; el.classList.add('drop-on'); }
});
boardGrid.addEventListener('dragleave', e => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.board-box');
  if (el && !el.contains(e.relatedTarget as Node)) el.classList.remove('drop-on');
});
boardGrid.addEventListener('drop', e => {
  if (!boardDragging && !boardDrag(e)) return; // files: drop.ts attaches them to the box
  const el = (e.target as HTMLElement).closest<HTMLElement>('.board-box');
  const agent = e.dataTransfer?.getData('text/breeze-agent');
  const chat = e.dataTransfer?.getData('text/breeze-chat');
  boardGrid.classList.remove('dragging');
  boardDragging = false; // the open spot becomes the new box (or closes, dropped on a filled one) in the same morph
  el?.classList.remove('drop-on');
  const side = el && e.dataTransfer ? dropSideOf(e, el) : null;
  const entry = chat ? boardSideEntries().find(x => x.id === chat) : undefined;
  if (!el || (!agent && !entry)) { morphBoard(renderBoard); return; }
  e.preventDefault();
  // A chat dropped on the open spot or on a box with nothing said yet goes there; dropped on another chat, it opens
  // in a box of its own on the side it was dropped on (the board splits), so neither chat is put away.
  if (entry) reopenInBox(entry, side ? undefined : el.dataset.box!, side ? { by: el.dataset.box!, side } : undefined);
  else if (agent) dropAgent(el.dataset.box!, agent);
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

// A box whose chat has not begun: a dropped chat takes its place instead of opening beside it.
const boxBlank = (box: BoardBox) => !box.tab.historyId && !box.tab.panel.querySelector('.msg');
// A box that is working refuses a drop (it shakes); an idle one takes the new agent and starts a new chat.
function refuseDrop(box: BoardBox): void {
  box.el.classList.remove('shake');
  void box.el.offsetWidth;
  box.el.classList.add('shake');
  setTimeout(() => box.el.classList.remove('shake'), 400);
  toast(`${boxName(box)} is still working`);
}
function dropAgent(key: string, agent: string): void {
  const box = boardBoxes.get(key);
  if (box && boxBusy(box)) { refuseDrop(box); return; }
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
// A new chat greets you as Home does (the same line, greetings.ts) beside the agent's own logo, with the prompt
// right under it in the middle of the box. The first message sends the prompt back down (watchBoxFresh).
// The logo is the maker's bare mark, as in the model picker (no tile): Claude's starburst, OpenAI's knot for Codex.
const HELLO_MARKS: Record<string, string> = { claude: 'mm-claude', codex: 'mm-openai', gemini: 'mm-gemini' };
function boxHelloHtml(agent: string): string {
  const mark = HELLO_MARKS[agent];
  const logo = mark ? `<span class="model-mark board-hello-mark ${mark}" aria-hidden="true"></span>` : brandMark('board-hello-logo', agent, agentNameOf(agent)[0] ?? '?');
  return `<div class="empty board-hello"><div class="board-hello-row">${logo}<h4>${esc(timeGreeting())}</h4></div></div>`;
}
// `fresh` while the chat is only its greeting. The prompt glides between the middle and the bottom (FLIP).
function watchBoxFresh(el: HTMLElement, panel: HTMLElement): void {
  const comp = $('.board-composer', el);
  const sync = () => {
    const fresh = !!panel.querySelector(':scope > .board-hello');
    if (fresh === el.classList.contains('fresh')) return;
    const before = el.isConnected ? comp.getBoundingClientRect() : null;
    el.classList.toggle('fresh', fresh);
    if (!before || motionReduced()) return;
    const dy = before.top - comp.getBoundingClientRect().top;
    if (dy) comp.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 450, easing: 'cubic-bezier(.32, .72, 0, 1)' });
  };
  new MutationObserver(sync).observe(panel, { childList: true });
  sync();
}

// `entry`: a chat from another list (an old Breeze Space chat), shown as it was; it is filed in this folder from then on.
function fillBox(key: string, agent: string, saved?: { historyId?: string; sessions?: Record<string, string>; model?: string; effort?: string; liveFrac?: number; side?: BoxSide; ctx?: BoxContext; entry?: ChatEntry }): BoardBox {
  const el = document.createElement('section');
  el.className = 'board-box filled';
  el.dataset.box = key;
  el.innerHTML = `
    <header class="board-box-head">
      ${brandMark('board-box-logo', agent, agentNameOf(agent)[0] ?? '?')}
      <b class="board-box-name"></b>
      <button class="board-box-model" type="button" title="Context" aria-haspopup="menu"><span class="bbm-label">Context</span><svg data-i="chevronRight" data-size="11"></svg></button>
      <span class="board-dot" role="status"></span>
      <span class="flex-1"></span>
      <button class="board-owns" type="button" title="Files this box owns"></button>
      <button class="icon-btn toggle board-box-code hidden" type="button" title="Hide the file the agent is editing" aria-label="Hide the file the agent is editing" aria-pressed="true"><svg data-i="code" data-size="14"></svg></button>
      <button class="icon-btn toggle board-box-term" type="button" aria-pressed="false"><svg data-i="terminal" data-size="14"></svg></button>
      <button class="icon-btn toggle board-box-preview" type="button" aria-pressed="false"><svg data-i="globe" data-size="14"></svg></button>
      <button class="icon-btn board-box-close" type="button" title="Empty this box" aria-label="Empty this box"><svg data-i="x" data-size="14"></svg></button>
    </header>
    <div class="board-box-body">
    <div class="board-box-main">
    <div class="board-chat chat"></div>
    <div class="composer board-composer"><div class="composer-box cmp">
      <div class="composer-attachments hidden"></div>
      <div class="prompt-field"><div class="prompt-hl" aria-hidden="true"></div><textarea rows="1" data-no-grow aria-label="Message to ${escAttr(agentNameOf(agent))} in box ${boxNumber(key)}" placeholder=" "></textarea></div>
      <div class="row cmp-row"><select class="select hidden" aria-hidden="true" tabindex="-1"><option value="build">Auto</option></select><button class="icon-btn cmp-plus" type="button" title="Add files, mentions and more" aria-label="Add files, mentions and more" aria-haspopup="menu"><svg data-i="plus" data-size="16"></svg><span class="spinner sm" aria-hidden="true"></span></button><input class="cmp-attach-pick" type="file" multiple hidden><button class="cmp-perm" type="button" aria-haspopup="menu"><svg data-i="shield" data-size="14"></svg><span class="cmp-perm-label">Full access</span><svg data-i="chevronDown" data-size="12"></svg></button><span class="flex-1"></span><span class="prompt-models"></span><button class="icon-btn cmp-mic" type="button" title="Dictate (Win+H)" aria-label="Dictate"><svg data-i="mic" data-size="15"></svg></button>
        <button class="cmp-send board-send" title="Send (Enter)" aria-label="Send"><svg data-i="arrowUp" data-size="15"></svg></button></div>
    </div><div class="cmp-meta"><span class="cmp-folder"><svg data-i="folder" data-size="13"></svg><span class="cmp-folder-name">No folder</span></span><span class="cmp-env" title="Agents run on this computer"><svg data-i="monitor" data-size="13"></svg><span>Local</span></span><span class="cmp-branch hidden"><svg data-i="gitBranch" data-size="13"></svg><span class="cmp-branch-name"></span></span><span class="flex-1"></span><span class="cmp-ctx hidden" role="meter" aria-label="Context used" aria-valuemin="0" aria-valuemax="100"><span class="cmp-ctx-bar"><i></i></span><span class="cmp-ctx-pct"></span></span></div></div>
    </div>
    <div class="board-live-sash" role="separator" aria-orientation="vertical" aria-label="Resize the code view" title="Drag to resize · double-click to reset"></div>
    <aside class="box-live board-live closed" aria-label="Side panel"><div class="box-live-head"></div><div class="box-live-body"></div>
      <div class="board-preview">
        <div class="board-side-bar preview-bar">
          <span class="preview-label">Preview</span>
          <span class="url" role="button" tabindex="0" aria-haspopup="menu" title="Switch page"><span class="bp-url-text">Not running</span></span>
          <button class="icon-btn toggle bp-inspect" type="button" title="Inspect on Hover" aria-pressed="false"><svg data-i="mouse" data-size="14"></svg></button>
          <button class="icon-btn toggle bp-full" type="button" title="Fullscreen" aria-pressed="false"><svg data-i="maximize" data-size="13"></svg></button>
          <button class="icon-btn bp-reload" type="button" title="Reload Preview"><svg data-i="refresh" data-size="13"></svg></button>
        </div>
        <div class="empty bp-empty"><div><svg data-i="play" data-size="36"></svg><h4>Nothing to preview yet</h4><div class="bp-hint">Add an <b>index.html</b> to preview it here.</div></div></div>
        <iframe class="preview-frame hidden" title="Preview"></iframe>
      </div>
    </aside>
    </div>`;
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
  const entry = saved?.entry ?? (saved?.historyId ? chatHistory(s).find(x => x.id === saved.historyId) : undefined);
  const tab = createAgentTab(s, `Box ${boxNumber(key)}`, entry?.html);
  tab.agentId = agent;
  tab.historyId = entry?.id;
  tab.sessions = { ...(saved?.sessions ?? {}) };
  activeTabId[s.name] = tab.id;
  tab.panel.classList.add('active');
  if (!entry) tab.panel.innerHTML = boxHelloHtml(agent);
  const liveEl = $('.board-live', el);
  const live = new LivePane(liveEl, $('.box-live-head', liveEl), $('.box-live-body', liveEl),
    path => { leaveBoard(); openFile(path); }, () => paintBoardLive());
  const box: BoardBox = { key, agent, surface: s, tab, el, status: 'idle', runIds: new Set(), lastText: '', scrollPending: !!entry, live };
  if (typeof saved?.model === 'string') box.model = saved.model;
  const eff = EFFORTS.find(e => e === saved?.effort);
  if (eff) box.effort = eff;
  const frac = saved?.liveFrac ?? store.get<number>(LIVE_FRAC_KEY, 0);
  if (typeof frac === 'number' && frac > 0 && frac < 1) box.liveFrac = frac;
  if (saved?.side === 'term' || saved?.side === 'preview') box.side = saved.side;
  if (typeof saved?.ctx?.used === 'number' && typeof saved.ctx.window === 'number' && saved.ctx.window > 0) box.ctx = { used: saved.ctx.used, window: saved.ctx.window };
  paintLiveWidth(box);
  boardBoxes.set(key, box);
  wireBox(box);
  watchBoxFresh(el, tab.panel);
  if (box.side) openBoxSide(box, box.side);
  paintBox(box);
  renderBoard();
  return box;
}

const boxAgent = (box: { agent: string }) => appState.detect?.agents.find(a => a.id === box.agent);
function wireBox(box: BoardBox): void {
  const { el, surface: s } = box;
  // The prompt works as the Agents tab's: its text drawn by a layer, the agent's model chip and Full access once
  // something is typed, "/skill" suggestions, examples in the placeholder, and a height that eases as it grows.
  const kit: PromptKit = { ta: s.prompt, hl: $('.prompt-hl', el), models: $('.prompt-models', el), picked: () => { const a = boxAgent(box); return a ? [a] : []; }, mentions: false, anim: null, target: () => boxModelTarget(box), switchAgent: (_from, to, m) => switchBoxAgent(box, to, m) };
  box.kit = kit;
  wirePromptKit(kit);
  wireSlash(s); // before the send handler below, so Enter picks a skill instead of sending
  rotatePlaceholder(s.prompt, ' ', IDE_PLACEHOLDERS);
  s.send.onclick = () => (tabBusy(box.tab) ? stopBox(box) : void sendBox(box));
  // The composer's own buttons (+, paperclip, access, mic) and the line under it; drops go through drop.ts and
  // pasted images through mentions.ts, as before.
  wireComposer({ box: $('.composer-box', el), meta: $('.cmp-meta', el), surface: s, agent: () => box.agent, tab: () => box.tab, send: () => sendBox(box), attach: files => background(attachFilesToAgent(files, s, box.tab)) });
  s.prompt.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    // While it works, Enter adds to its task and Ctrl+Enter queues (composerui.ts).
    if (submitWhileBusy(s, box.tab, e.ctrlKey || e.metaKey, boxBusy(box))) return;
    void sendBox(box);
  });
  s.prompt.addEventListener('input', () => syncPromptHl(kit));
  syncPromptHl(kit);
  keepDraft(s.prompt, () => boxDraftKey(box));
  $('.board-box-close', el).onclick = () => void emptyBox(box.key);
  $('.board-box-code', el).onclick = () => showBoxSide(box, 'code');
  $('.board-box-term', el).onclick = () => showBoxSide(box, 'term');
  $('.board-box-preview', el).onclick = () => showBoxSide(box, 'preview');
  wireLiveSash(box);
  $('.board-owns', el).onclick = e => ownsMenu(box, e.currentTarget as HTMLElement);
  $('.board-box-model', el).onclick = e => openChipMenu(e.currentTarget as HTMLElement, boxContextItems(box));
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
    layoutBoard();
  });
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && boardPageShowing() && boardGrid.classList.contains('has-max') && !modalOpen()) toggleMaxBox(null);
});

function paintBox(box: BoardBox): void {
  if (tabBusy(box.tab)) box.status = boardWaiting(box.key) ? 'waiting' : 'working';
  else if (boardWaiting(box.key)) box.status = 'waiting';
  else if (box.status === 'working' || box.status === 'waiting') box.status = 'idle';
  swapText($('.board-box-name', box.el), boxName(box));
  paintBoardSideRow(box);
  paintBoxContext(box);
  const dot = $('.board-dot', box.el);
  if (dot.dataset.status && dot.dataset.status !== box.status && !motionReduced()) dot.animate([{ transform: 'scale(1.6)' }, {}], { duration: 420, easing: SPRING });
  dot.dataset.status = box.status;
  dot.title = { idle: 'Idle', working: 'Working', waiting: 'Waiting on a teammate', done: 'Done', failed: 'Failed' }[box.status];
  dot.setAttribute('aria-label', dot.title);
  const owns = Object.values(boardOwners).filter(o => o === box.key).length;
  const ownsBtn = $('.board-owns', box.el);
  if (owns) swapText(ownsBtn, plural(owns, 'file')); // kept while it shrinks away
  morphShow(ownsBtn, !!owns);
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
      if (box.kit) renderPromptModels(box.kit);
      saveBoard();
      toast(`${boxName(box)} will use ${versionLabel(model) || 'its default model'}${boxAgent(box)?.api ? '' : ` (${effort} effort)`}`);
    },
  };
}
// What board:run sends for a box: only what it picked itself, so an untouched box follows the agent's settings.
function boardPickOf(key: string): { model?: string; effort?: string } {
  const b = anyBox(key);
  if (!b) return {};
  const model = b.model ? boxModelOf(b) : '';
  return { ...(model ? { model } : {}), ...(b.effort ? { effort: b.effort } : {}) };
}
// The header's Context button: how full the box's chat is, the share of its model's context window the last request
// used (a `ctx` event from main, for Claude and Codex). Amber from 80%, when the agent will soon compact or forget the
// start of the chat. The model is picked in the prompt's chip, or from this button's menu.
const ctxTokens = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
const ctxPct = (c: BoxContext) => Math.max(0, Math.min(100, Math.round((c.used / c.window) * 100)));
function paintBoxContext(box: BoardBox): void {
  const btn = $('.board-box-model', box.el), c = box.ctx;
  const pct = c ? ctxPct(c) : 0;
  btn.classList.toggle('low', pct >= 80);
  btn.title = c ? `Context window: ${ctxTokens(c.used)} of ${ctxTokens(c.window)} tokens used (${pct}%)` : 'Context';
  btn.setAttribute('aria-label', `${btn.title}. Show context`);
}
function boxContextItems(box: BoardBox): MenuItem[] {
  const c = box.ctx, ag = boxAgent(box);
  const items: MenuItem[] = [{
    label: c ? `${ctxPct(c)}% used · ${ctxTokens(c.used)} of ${ctxTokens(c.window)} tokens` : 'No context used yet',
    enabled: () => false,
  }];
  const model = ag ? versionLabel(boxModelOf(box)) : '';
  if (ag && model) items.push({ sep: true }, { label: `Model: ${model}${ag.api ? '' : ` · ${boxEffortOf(box)}`}`, sub: () => modelPickerItems(ag, false, boxModelTarget(box), (to, m) => switchBoxAgent(box, to, m)) });
  return items;
}
// A model of another agent picked in a box's menu: the box swaps to that agent, keeping its place and its chat.
// The new agent starts its own session (sessions are kept per agent), so it doesn't see the old one's context.
function switchBoxAgent(box: BoardBox, to: DetectedAgent, model: string): void {
  if (boxBusy(box)) { refuseDrop(box); return; }
  box.agent = to.id;
  box.tab.agentId = to.id;
  box.model = model;
  const letter = agentNameOf(to.id)[0] ?? '?';
  $('.board-box-logo', box.el).outerHTML = brandMark('board-box-logo', to.id, letter);
  box.surface.prompt.setAttribute('aria-label', `Message to ${agentNameOf(to.id)} in box ${boxNumber(box.key)}`);
  const empty = box.tab.historyId ? null : box.tab.panel.querySelector('.empty');
  if (empty) empty.outerHTML = boxHelloHtml(to.id);
  if (box.kit) renderPromptModels(box.kit);
  paintBox(box);
  renderBoard();
  saveBoard();
  toast(`${boxName(box)} will use ${versionLabel(model)}`);
}
// Fresh numbers when the board opens (at most every 30 s) and after each run, when they have moved.
let boardUsageAt = 0;
// (The prompts' usage line shows them; the header shows the context.)
function refreshBoardLimits(force = false): void {
  if (!force && Date.now() - boardUsageAt < 30_000) return;
  boardUsageAt = Date.now();
  background(api.agent.usage().then(u => { agentUsage = u; if (typeof refreshComposers === 'function') refreshComposers(); }));
}
// A model or effort changed somewhere (renderAgentBar): every box's prompt chip shows it.
function renderBoardModels(): void {
  for (const b of boardBoxes.values()) if (b.kit) renderPromptModels(b.kit);
}

async function sendBox(box: BoardBox): Promise<void> {
  const s = box.surface, text = s.prompt.value.trim();
  const attachments = [...(attachmentsMap[s.name] || [])];
  if ((!text && !attachments.length) || boxBusy(box)) return;
  if (!rootInfo) { toast('Open a folder first, so the agents know what to work on'); return; }
  s.prompt.value = '';
  saveDraft(s.prompt);
  attachmentsMap[s.name] = [];
  box.tab.attachments = [];
  renderAttachments(s);
  if (box.kit) syncPromptHl(box.kit);
  personSpokeIn(box.key);
  if (box.tab.panel.querySelector('.empty')) box.tab.panel.innerHTML = '';
  sfx.play('send');
  userMsg(text, attachments, box.tab);
  await runBox(box, withAttachments(attachmentHeaders(attachments), text)); // the agent reads them from where they are
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
  box.term?.dispose();
  box.preview?.dispose();
  box.el.remove();
  boardBoxes.delete(box.key);
  boardOrder = boardOrder.filter(k => k !== box.key);
  surfaceTabs[box.surface.name] = [];
  if (boardPageShowing()) renderBoardSide();
}
async function emptyBox(key: string): Promise<void> {
  const box = boardBoxes.get(key);
  if (!box) return;
  if (boxBusy(box)) stopBox(box);
  dropRelaysFor(key);
  if (box.el.classList.contains('box-max')) toggleMaxBox(null);
  background(api.board.clearBox(key));
  store.del(boxDraftKey(box)); // a closed box's unsent message doesn't come back in the next agent put there
  morphBoard(() => { removeBox(box); renderBoard(); saveBoard(); renderBoardStatus(); });
}
// A box's unsent message, filed under the folder its boxes belong to.
const boxDraftKey = (box: BoardBox) => `breeze.draft:board:${box.key}:${boardFolder ?? ''}`;

/* ----- History: this folder's earlier chats (the IDE's list, which boxes file into too), each reopened in a box ----- */
function boardHistoryMenu(anchor: HTMLElement): void {
  if (menuWasOpen(anchor)) { closeMenu(); return; }
  closeMenu();
  const list = chatHistory(SURFACES.ide);
  const openIn = (id: string) => [...boardBoxes.values()].find(b => b.tab.historyId === id);
  const items: MenuItem[] = list.length
    ? list.map(e => ({ label: e.title, key: openIn(e.id) ? 'open' : timeAgo(e.at), run: () => reopenInBox(e) }))
    : [{ label: 'No earlier chats yet', enabled: () => false }];
  const r = anchor.getBoundingClientRect();
  anchor.classList.add('open');
  popupMenu(r.right - 300, r.bottom + 4, items, () => anchor.classList.remove('open'), anchor);
  const m = $('#menuRoot .menu');
  if (!m) return;
  m.classList.add('history-menu');
  m.style.left = `${Math.max(8, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 8))}px`;
}
// A chat already in a box is brought forward instead of opened twice. Otherwise it goes in the first free box, with the
// agent that had it (or the first one found, when that agent is gone), and carries on from its saved sessions.
// `into`: the box it was dropped on (from the side bar); an idle box there gives its place up, a working one refuses.
// A Claude Code or Codex chat (e.log) has its messages read from its log first.
// `place`: open it on this side of that box (a chat dropped on another chat's half).
// `alone`: a click in the side bar. The chat takes the whole board and the other boxes close (see freshBoard).
// ('confirmed': the same, once any working box has been asked about; the boxes close in the same morph it opens in.)
function reopenInBox(e: ChatEntry, into?: string, place?: { by: string; side: DropSide }, alone: boolean | 'confirmed' = false): void {
  // Still working in the background: its box comes back to the board as it is.
  const parked = [...parkedBoxes.values()].find(b => b.tab.historyId === e.id);
  if (parked) {
    morphBoard(() => {
      if (alone) closeBoxes([...boardBoxes.values()]);
      unparkBox(parked);
      if (place && place.by !== parked.key) placeBox(parked.key, place.by, place.side);
      renderBoard();
      saveBoard();
      renderBoardStatus();
      renderBoardSide();
    });
    requestAnimationFrame(() => { scrollRestoredChats(); parked.surface.prompt.focus(); });
    return;
  }
  const open = [...boardBoxes.values()].find(b => b.tab.historyId === e.id);
  if (open && (!alone || boardBoxes.size === 1)) { open.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); open.surface.prompt.focus(); return; }
  if (e.log && !e.html && !open) {
    background(logChatHtml(e).then(html => { if (html) reopenInBox({ ...e, html }, into, place, alone); else toast('That chat could not be read'); }));
    return;
  }
  // Another project's chat opens on that project's board (history.ts), not in a box working on this one.
  if (!chatInOpenFolder(e)) {
    background(openChatFolder(e, workingBoxes()).then(ok => {
      if (!ok) return;
      if (boardPageShowing()) openBoard(); // the board now shows that folder's boxes
      reopenInBox(e, undefined, undefined, alone);
    }));
    return;
  }
  // Already in a box: that one stays and takes the page. The others close; working ones carry on in the background.
  if (alone && open) {
    morphBoard(() => { closeBoxes([...boardBoxes.values()].filter(b => b !== open)); renderBoard(); saveBoard(); renderBoardStatus(); renderBoardSide(); });
    open.surface.prompt.focus();
    return;
  }
  const key = alone ? freeKeysAfterClear()[0] : into ?? firstFreeKey();
  if (!key) { toast(alone ? BOARD_ALL_BUSY : `The board is full: empty a box first (${BOARD_MAX} at most)`); return; }
  const was = alone ? undefined : boardBoxes.get(key);
  if (was && boxBusy(was)) { refuseDrop(was); return; }
  const found = foundAgents();
  const agent = found.find(a => a.id === e.agent)?.id ?? found[0]?.id;
  if (!agent) { toast('No agent is installed to carry on this chat'); return; }
  const sessions = e.sessions ? { ...e.sessions } : (e.session && e.agent ? { [e.agent]: e.session } : {});
  morphBoard(() => {
    if (alone) { closeBoxes([...boardBoxes.values()]); renderBoard(); }
    if (was) { dropRelaysFor(key); removeBox(was); background(api.board.clearBox(key)); }
    if (place) placeBox(key, place.by, place.side);
    const box = fillBox(key, agent, { historyId: e.id, sessions, entry: e });
    box.tab.title = e.title; // so it is filed back under its own name, not "Box N"
    $$('[data-live]', box.tab.panel).forEach(el => { el.outerHTML = '<div class="resolved">Earlier session</div>'; });
    $$('.team-claiming', box.tab.panel).forEach(el => el.classList.add('settled'));
    saveBoard();
    renderBoardStatus();
    renderBoardSide();
  });
  requestAnimationFrame(() => { const b = boardBoxes.get(key); if (b) { scrollRestoredChats(); b.surface.prompt.focus(); } });
}
// The side bar replaced the History button (breeze.html): $('#boardHistory').onclick = e => boardHistoryMenu(e.currentTarget as HTMLElement);

/* ----- Side bar: New chat, Search, then chats grouped by folder (as Breeze Space had, without its sky) ----- */
// A click opens a chat alone on the board; dragged onto the board, it opens beside the boxes there (or in a blank one).
// Claude Code's and Codex's own chats are listed too (main/agentlogs.ts), each carried on with its own session.
const boardSideFolded = new Set(store.get<string[]>('breeze.board.sideFolded', []));
// Pinned chats: listed first, in a group of their own above every folder, newest pin first. Kept for every folder.
const PINNED_KEY = 'breeze.board.pinned', PINNED_GROUP = 'pinned:';
const pinnedChats = () => store.get<string[]>(PINNED_KEY, []);
function setChatPinned(id: string, on: boolean): void {
  const rest = pinnedChats().filter(x => x !== id);
  store.set(PINNED_KEY, on ? [id, ...rest] : rest);
  renderBoardSide();
}
let boardSideQuery = '';
// This folder's chats (the Agents panel's and the boxes', one list), then Breeze Space's old chats not carried on
// here yet, so none of them are lost with Space.
function boardSideEntries(): ChatEntry[] {
  const here = rootInfo ? chatHistory(SURFACES.ide).map(e => ({ ...e, folder: e.folder ?? rootInfo?.root ?? null })) : [];
  const ids = new Set(here.map(e => e.id));
  const ours = [...here, ...chatHistory(SURFACES.box).filter(e => !ids.has(e.id))];
  // A log chat Breeze already has (it ran there, or was carried on in a box) is listed once, as Breeze's.
  const known = new Set(ours.flatMap(e => [e.id, ...(e.session ? [e.session] : []), ...Object.values(e.sessions ?? {})]));
  const hidden = new Set(store.get<string[]>(LOG_HIDDEN_KEY, []));
  const names = store.get<Record<string, string>>(LOG_NAMES_KEY, {});
  const logs = boardLogs.filter(e => !known.has(e.id) && !known.has(e.log!.session) && !hidden.has(e.id));
  return [...ours, ...logs.map(e => (names[e.id] ? { ...e, title: names[e.id] } : e))];
}
/* Claude Code's and Codex's own chats, read from their logs each time the board opens. Renaming one keeps the name in
   Breeze; deleting one only hides it here (the agent's own log is never changed). */
const LOG_NAMES_KEY = 'breeze.board.logNames', LOG_HIDDEN_KEY = 'breeze.board.logHidden';
let boardLogs: ChatEntry[] = [];
const LOG_AGENT: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };
function loadBoardLogs(): void {
  if (typeof api.agent.chatLogs !== 'function') return;
  background(api.agent.chatLogs().then(list => {
    boardLogs = list.map(l => ({
      id: `log:${l.agent}:${l.session}`, title: l.title, at: l.at, html: '', agent: l.agent, session: l.session,
      sessions: { [l.agent]: l.session }, folder: l.cwd && rootInfo && folderKey(l.cwd) === folderKey(rootInfo.root) ? rootInfo.root : l.cwd,
      log: { agent: l.agent, session: l.session },
    }));
    if (boardPageShowing()) renderBoardSide();
  }));
}
// A log chat's messages as Breeze's chat shows them: the person's as typed, the agent's as Markdown.
async function logChatHtml(e: ChatEntry): Promise<string> {
  const msgs = e.log ? await api.agent.chatLog(e.log.agent, e.log.session).catch(() => null) : null;
  if (!msgs?.length || !e.log) return '';
  const st = AGENT_STYLE[e.log.agent] ?? { letter: '?', tint: e.log.agent };
  const name = esc(agentNameOf(e.log.agent));
  const time = (at: number) => (at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
  return msgs.map(m => (m.role === 'user'
    ? `<div class="msg user"><div class="meta"><b>${esc(displayName() ?? 'You')}</b> ${time(m.at)}</div><div class="body"><div>${esc(m.text).replaceAll('\n', '<br>')}</div></div></div>`
    : `<div class="msg"><div class="meta">${brandMark('avatar mini', st.tint, st.letter)}<b>${name}</b> ${time(m.at)}</div><div class="body">${md(m.text)}</div></div>`)).join('');
}
// The list an entry is kept in: this folder's, or Space's.
const sideStore = (id: string): Surface => (chatHistory(SURFACES.ide).some(e => e.id === id) ? SURFACES.ide : SURFACES.box);
const boxWithChat = (id: string) => allBoardBoxes().find(b => b.tab.historyId === id);
// morph: false at start-up, before ui.js (morphShow) has loaded.
function setBoardSide(open: boolean, morph = true): void {
  store.set('breeze.board.side', open);
  $('#board').classList.toggle('side-closed', !open);
  if (morph) morphShow($('#boardSideShow'), !open); else $('#boardSideShow').classList.toggle('hidden', open);
  $('#boardSide').inert = !open;
  requestAnimationFrame(layoutBoard);
}
setBoardSide(store.get<boolean>('breeze.board.side', true), false);
function renderBoardSide(): void {
  const list = $('#boardSideList');
  if (list.querySelector('.rename-input')) return; // a chat is being renamed: redrawn once that is done
  const q = boardSideQuery.toLowerCase();
  const entries = boardSideEntries().filter(e => !q || `${e.title}\n${folderName(e.folder)}`.toLowerCase().includes(q));
  // This folder first, then the rest in the order of their newest chat; each newest first.
  const pins = pinnedChats();
  const groups = new Map<string, ChatEntry[]>([[PINNED_GROUP, []]]);
  if (rootInfo) groups.set(rootInfo.root, []);
  for (const e of entries) { const g = pins.includes(e.id) ? PINNED_GROUP : e.folder ?? ''; groups.set(g, [...groups.get(g) ?? [], e]); }
  for (const [k, v] of groups) {
    if (!v.length) groups.delete(k);
    else if (k === PINNED_GROUP) v.sort((a, b) => pins.indexOf(a.id) - pins.indexOf(b.id));
    else v.sort((a, b) => b.at - a.at);
  }
  const html = !groups.size ? `<div class="box-side-empty">${q ? 'No chats match' : 'Your chats show up here'}</div>` : [...groups].map(([folder, chats]) => {
    const folded = !q && boardSideFolded.has(folder);
    const pinGroup = folder === PINNED_GROUP;
    const rows = chats.map(e => {
      const box = boxWithChat(e.id);
      const away = !!box && parkedBoxes.get(box.key) === box;
      return `<button class="box-side-chat${box && !away ? ' on' : ''}${box && boxBusy(box) ? ' busy' : ''}${away && tabNeedsYou(box.tab) ? ' needs-you' : ''}" type="button" role="listitem" draggable="true" data-chat="${escAttr(e.id)}" title="${escAttr(`${e.title}${e.log ? `\nFrom ${LOG_AGENT[e.log.agent] ?? e.log.agent}` : ''}\nClick to open it in a box, or drag it onto the board`)}">
        <span class="needs-you-dot" title="Needs you" aria-label="Needs you"></span>${pins.includes(e.id) ? `<span class="box-side-pin" aria-label="Pinned">${svgIcon('pin', 12)}</span>` : ''}<span class="nm">${esc(e.title)}</span><span class="box-side-busy" aria-label="Working"></span><span class="ago">${esc(timeAgo(e.at))}</span></button>`;
    }).join('');
    return `<div class="box-side-group${folded ? ' folded' : ''}">
      <button class="box-side-folder" type="button" data-folder="${escAttr(folder)}" aria-expanded="${!folded}" title="${escAttr(pinGroup ? 'Chats you pinned' : folder || 'Chats from before folders were kept')}">
        <span class="nm">${pinGroup ? 'Pinned' : esc(folderName(folder) || 'Earlier chats')}</span>${svgIcon('chevronDown', 12)}</button>
      <div class="box-side-chats">${rows}</div>
    </div>`;
  }).join('');
  morphSideList(list, html);
}
// The chats list redrawn as a morph: rows that stay slide to their new place and new ones grow in (flip); the open
// chat's highlight grows on its row and fades off the last one, as hovering does; a folder's chevron turns.
function morphSideList(list: HTMLElement, html: string): void {
  const rows = () => $$<HTMLElement>('[data-chat], [data-folder], .box-side-empty', list);
  const key = (el: HTMLElement) => el.dataset.chat ?? (el.dataset.folder !== undefined ? `folder:${el.dataset.folder}` : 'empty');
  const on = new Set($$<HTMLElement>('.box-side-chat.on', list).map(key));
  const folded = new Set($$<HTMLElement>('.box-side-group.folded > [data-folder]', list).map(key));
  const had = new Set(rows().map(key));
  flip(rows, () => { list.innerHTML = html; }, key);
  if (motionReduced() || !list.checkVisibility()) return;
  for (const el of rows()) {
    const k = key(el);
    if (!had.has(k)) continue; // new: flip grows it in
    const isOn = el.classList.contains('on');
    if (isOn !== on.has(k)) el.animate([isOn ? { opacity: 0, transform: 'scaleX(.55)' } : { opacity: 1, transform: 'none' }, {}], { pseudoElement: '::before', duration: 510, easing: SPRING });
    const isFolded = !!el.closest('.box-side-group.folded');
    const chevron = el.dataset.folder !== undefined ? el.querySelector('svg') : null;
    if (chevron && isFolded !== folded.has(k)) chevron.animate([{ transform: isFolded ? 'none' : 'rotate(-90deg)' }, {}], { duration: 420, easing: SPRING });
  }
}
// A box's working dot, without redrawing the list on every event.
function paintBoardSideRow(box: BoardBox): void {
  const id = box.tab.historyId;
  const row = id ? $('#boardSideList').querySelector<HTMLElement>(`[data-chat="${CSS.escape(id)}"]`) : null;
  if (!row) return;
  morphClass(row, 'busy', boxBusy(box), $('.box-side-busy', row));
  // Out of sight and waiting on an answer: the row's blue dot flashes until the chat is opened and answered.
  morphClass(row, 'needs-you', parkedBoxes.get(box.key) === box && tabNeedsYou(box.tab), $('.needs-you-dot', row));
}
// agents.ts's refreshNeedsYou, for a chat in a box.
function paintBoardTabRow(tab: AgentTabState): void {
  const box = allBoardBoxes().find(b => b.tab === tab);
  if (box) paintBoardSideRow(box);
}
function newBoardChat(): void {
  const agent = selectedAgent()?.id ?? foundAgents()[0]?.id;
  if (!agent) { toast('No agents found. Install one from Settings.'); return; }
  freshBoard(agent);
}
function renameBoardChat(id: string): void {
  const row = $('#boardSideList').querySelector<HTMLElement>(`[data-chat="${CSS.escape(id)}"]`);
  const e = boardSideEntries().find(x => x.id === id);
  if (!row || !e) return;
  const h = getComputedStyle(row).height; // the field takes the row's exact height, so nothing below it moves
  renameInline(row, e.title, name => {
    if (name && e.log) store.set(LOG_NAMES_KEY, { ...store.get<Record<string, string>>(LOG_NAMES_KEY, {}), [id]: name });
    else if (name) {
      renameChatEntry(sideStore(id), id, name);
      const box = boxWithChat(id);
      if (box) box.tab.title = name;
    }
    renderBoardSide();
  });
  const input = row.nextElementSibling as HTMLElement | null;
  if (input?.matches('.rename-input')) input.style.height = h;
}
function deleteBoardChat(id: string): void {
  if (pinnedChats().includes(id)) store.set(PINNED_KEY, pinnedChats().filter(x => x !== id));
  if (boardLogs.some(e => e.id === id)) {
    store.set(LOG_HIDDEN_KEY, [...store.get<string[]>(LOG_HIDDEN_KEY, []), id]);
    renderBoardSide();
    toast('Chat removed from this list');
    return;
  }
  const s = sideStore(id);
  store.set(historyKey(s), chatHistory(s).filter(e => e.id !== id));
  const box = boxWithChat(id);
  if (box) box.tab.historyId = undefined; // still open: filed again as a new chat if it changes
  renderBoardSide();
  toast('Chat deleted');
}
function closeBoardSearch(): void {
  $<HTMLInputElement>('#boardSideSearch').value = '';
  boardSideQuery = '';
  morphSearchRow($('#boardSideSearchBtn'), $('#boardSideSearchBox'), false);
  renderBoardSide();
}
$('#boardSideNew').onclick = newBoardChat;
$('#boardSideHide').onclick = () => setBoardSide(false);
$('#boardSideShow').onclick = () => setBoardSide(true);
$('#boardSideSearchBtn').onclick = () => {
  morphSearchRow($('#boardSideSearchBtn'), $('#boardSideSearchBox'), true);
  $<HTMLInputElement>('#boardSideSearch').focus();
};
$('#boardSideSearch').addEventListener('input', ev => { boardSideQuery = (ev.target as HTMLInputElement).value.trim(); renderBoardSide(); });
$('#boardSideSearch').addEventListener('keydown', ev => { if (ev.key === 'Escape') { ev.stopPropagation(); closeBoardSearch(); } });
$('#boardSideSearch').addEventListener('blur', () => { if (!boardSideQuery) closeBoardSearch(); });
$('#boardSideList').addEventListener('click', ev => {
  const t = ev.target as HTMLElement;
  const folder = t.closest<HTMLElement>('[data-folder]');
  if (folder) {
    const k = folder.dataset.folder ?? '';
    if (boardSideFolded.has(k)) boardSideFolded.delete(k); else boardSideFolded.add(k);
    store.set('breeze.board.sideFolded', [...boardSideFolded]);
    renderBoardSide();
    return;
  }
  const id = t.closest<HTMLElement>('[data-chat]')?.dataset.chat;
  const e = id ? boardSideEntries().find(x => x.id === id) : undefined;
  if (e) reopenInBox(e, undefined, undefined, true);
});
$('#boardSideList').addEventListener('dblclick', ev => {
  const id = (ev.target as HTMLElement).closest<HTMLElement>('[data-chat]')?.dataset.chat;
  if (id) renameBoardChat(id);
});
$('#boardSideList').addEventListener('contextmenu', ev => {
  const id = (ev.target as HTMLElement).closest<HTMLElement>('[data-chat]')?.dataset.chat;
  const e = id ? boardSideEntries().find(x => x.id === id) : undefined;
  if (!id || !e) return;
  ev.preventDefault();
  popupMenu(ev.clientX, ev.clientY, [
    { label: 'Open chat', run: () => reopenInBox(e, undefined, undefined, true) },
    pinnedChats().includes(id)
      ? { label: 'Unpin Chat', run: () => setChatPinned(id, false) }
      : { label: 'Pin Chat', run: () => setChatPinned(id, true) },
    { label: 'Rename chat', run: () => renameBoardChat(id) },
    { label: 'Delete chat', run: () => deleteBoardChat(id) },
  ]);
});
// Dragging a chat opens a spot on the board, as dragging an agent from the roster does; dropped there or on another
// chat, it opens in a box of its own beside the others.
$('#boardSideList').addEventListener('dragstart', e => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-chat]');
  if (!row || !e.dataTransfer) return;
  e.dataTransfer.setData('text/breeze-chat', row.dataset.chat!);
  e.dataTransfer.effectAllowed = 'copy';
  boardGrid.classList.add('dragging');
  setTimeout(() => { if (!boardDragging && boardBoxes.size < BOARD_MAX) { boardDragging = true; morphBoard(renderBoard); } }, 0);
});
$('#boardSideList').addEventListener('dragend', () => endBoardDrag());

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
const boxForRun = (runId: number) => allBoardBoxes().find(b => b.runIds.has(runId));
api.agent.onEvent((runId, ev) => {
  const box = boxForRun(runId);
  if (!box || boardFolder !== (rootInfo?.root ?? null)) return; // the folder changed: main stopped these runs
  const stopped = stoppedRuns.has(runId);
  if (ev.t === 'ctx') {
    if (typeof ev.used === 'number' && typeof ev.window === 'number' && ev.window > 0) { box.ctx = { used: ev.used, window: ev.window }; paintBoxContext(box); }
    return;
  }
  if (ev.t === 'text') box.lastText = ev.text ?? '';
  else if (ev.t === 'file' || ev.t === 'written') refreshOwnersSoon();
  else if (ev.t === 'relay') { if (!stopped && !echoesAnswer(relayRuns.get(runId), ev.to ?? '')) onRelay(box, ev); }
  else if (ev.t === 'done') {
    box.status = ev.ok ? 'done' : ev.stopped || stopped ? 'idle' : 'failed';
    refreshOwnersSoon();
    // After the chat's own done handler has run (tab.runId is free again).
    setTimeout(() => { paintBox(box); onBoxIdle(box, runId, stopped || !!ev.stopped); finishParked(box); saveBoard(); refreshBoardLimits(true); }, 0);
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
    boxes[b.key] = { agent: b.agent, historyId: b.tab.historyId, sessions: b.tab.sessions, model: b.model, effort: b.effort, liveFrac: b.liveFrac, side: b.side, ctx: b.ctx };
  }
  store.set(boardStoreKey(), { boxes, ...(boardOrder.length ? { order: boardOrder } : {}) } satisfies BoardSaved);
}
function loadBoard(): void {
  // The boxes on screen belong to `boardFolder`; their chats were filed there as they finished.
  const sameFolder = boardFolder === (rootInfo?.root ?? null);
  for (const b of allBoardBoxes()) { if (boxBusy(b)) stopBox(b); removeBox(b, sameFolder); }
  parkedBoxes.clear();
  resetRelays();
  boardGrid.innerHTML = '';
  boardOwners = {};
  boardFolder = rootInfo?.root ?? null;
  const saved = store.get<BoardSaved>(boardStoreKey(), { boxes: {} });
  boardOrder = Array.isArray(saved.order) ? saved.order.filter(k => allBoxKeys().includes(k)) : [];
  for (const [key, s] of Object.entries(saved.boxes ?? {})) {
    if (allBoxKeys().includes(key) && typeof s?.agent === 'string') fillBox(key, s.agent, s);
  }
}

/* ----- Status bar: "Agent board — 2 working · Open" while the page is hidden ----- */
function renderBoardStatus(): void {
  let pill = document.getElementById('boardStatus');
  const working = allBoardBoxes().filter(b => tabBusy(b.tab)).length;
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
// A new key, so Auto-relay starts on again for everyone (the old 'breeze.board.auto' could hold an off from the bar's switch).
const AUTO_KEY = 'breeze.board.autoRelay';
const boxLabel = (key: string) => { const b = anyBox(key); return b ? boxName(b) : `Box ${boxNumber(key)}`; };
const boxBadge = (key: string) => {
  const b = anyBox(key);
  return `<span class="agent-tag">${b ? brandMark('agent-tag-logo', b.agent, agentNameOf(b.agent)[0] ?? '?') : ''}<b>${esc(boxLabel(key))}</b></span>`;
};
const boxIdle = (key: string) => { const b = anyBox(key); return !!b && !boxBusy(b); };
const relayId = () => `rl_${crypto.randomUUID().slice(0, 8)}`;

// Waiting on a teammate's answer to a relay, or on the person's answer to a question in this box.
function boardWaiting(key: string): boolean {
  return (openAsks.get(key)?.size ?? 0) > 0 || !!anyBox(key)?.tab.panel.querySelector('.card.question [data-live]');
}
function personSpokeIn(key: string): void { relayQueue.personSpoke(key); }

// Main's crossing on a board run: "Claude · 1 tried to edit api.ts (Codex · 2's). Breeze put it back and asked Codex."
function boardCrossingCard(ev: AgentEvent, tab: AgentTabState): void {
  const who = boxLabel(ev.agent ?? boxKeyOf(tab.surfaceName));
  const ownerBox = ev.owner ? anyBox(ev.owner) : undefined;
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
  if (!anyBox(to)) {
    const el = addMsg(`<div class="card relay"><h5>${svgIcon('arrowRight', 14)} ${esc(boxLabel(to))} is empty</h5><p>Nobody can make this change for ${esc(boxName(from))}.</p><div class="row" data-live><button class="btn btn-sm" data-relay-drop>Drop</button></div></div>`, from.tab);
    el.querySelector<HTMLElement>('[data-relay-drop]')!.onclick = () => { if (motionReduced()) el.remove(); else el.animate([{}, MORPH_GONE], { duration: 160, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' }).onfinish = () => el.remove(); };
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
  const target = anyBox(r.to);
  if (!target) { closeAsk(r); return; }
  const outcome = relayQueue.push(r, boxIdle, sent);
  if (outcome === 'start') { void startRelay(r); return; }
  const card = incomingCard(r, target);
  const wait = card.querySelector<HTMLElement>('.relay-wait')!;
  if (outcome === 'queued') {
    swapText(wait, `Waiting for ${boxName(target)} to finish.`);
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
    swapText(wait, 'Dropped.');
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
  const target = anyBox(r.to);
  if (!target || boardFolder !== (rootInfo?.root ?? null)) { closeAsk(r); return; }
  if (boxBusy(target)) { deliver(r); return; } // it got busy meanwhile: wait for it
  const card = incomingCard(r, target);
  const wait = card.querySelector<HTMLElement>('.relay-wait');
  if (wait) swapText(wait, r.kind === 'reply' ? 'Continuing.' : 'Working on it.');
  sfx.play('send');
  await runBox(target, relayPrompt(r, boxLabel(r.from)));
  const runId = target.tab.runId;
  if (runId != null && runId > 0) relayRuns.set(runId, r);
  else closeAsk(r);
}

function closeAsk(r: Relay): void {
  if (r.kind !== 'ask') return;
  openAsks.get(r.from)?.delete(r.id);
  const b = anyBox(r.from);
  if (b) paintBox(b);
}

// A box's run ended: an answered ask goes back to the asker, then the next relay waiting for this box starts.
// A stopped run answers nobody: the asker hears it was stopped, and nothing waiting for this box starts on its own.
function onBoxIdle(box: BoardBox, runId: number, stopped = false): void {
  const answered = relayRuns.get(runId);
  if (answered) {
    relayRuns.delete(runId);
    const wait = relayCards.get(answered.id)?.querySelector<HTMLElement>('.relay-wait');
    if (wait) swapText(wait, stopped ? 'Stopped.' : box.status === 'failed' ? 'Couldn’t finish.' : answered.kind === 'ask' ? 'Answered.' : '');
    if (answered.kind === 'ask') {
      closeAsk(answered);
      const asker = anyBox(answered.from);
      if (stopped && asker) {
        addMsg(`<div class="card relay"><h5>${svgIcon('stop', 14)} ${esc(boxName(box))} was stopped</h5><p>It didn't finish the change you asked for.</p></div>`, asker.tab);
      } else if (anyBox(answered.from)) {
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
    const asker = r.kind === 'ask' && r.to === key ? anyBox(r.from) : undefined;
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
    const wait = card.querySelector<HTMLElement>('.relay-wait');
    if (wait && (wait.querySelector('button') || wait.textContent?.startsWith('Waiting'))) swapText(wait, 'Stopped.');
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

// Auto-relay: on by default, remembered; switched in Settings → Agents → Agent Board.
relayQueue.auto = store.get<boolean>(AUTO_KEY, true);
function setAutoRelay(on: boolean): void {
  relayQueue.auto = on;
  store.set(AUTO_KEY, on);
}
