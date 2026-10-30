/* ================= Opening, tabs & saving ================= */
type Spot = { line: number; col: number; len?: number };
function openFile(path: string, at?: Spot): void {
  if (baseName(path).startsWith('.env') && !buffers.has(path)) {
    openModal(`<h3>This is a protected file</h3><p class="sub">${esc(baseName(path))} holds secrets. You can view it, but Breeze's local LLM agent can't read or change it. Codex and other installed agents use their own file access, so Breeze can't keep them out.</p><div class="row end"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="openEnv">Open for me only</button></div>`,
      m => { $('#openEnv', m).onclick = () => { closeModal(); void actuallyOpen(path, at); }; });
    return;
  }
  void actuallyOpen(path, at);
}
async function actuallyOpen(path: string, at?: Spot): Promise<void> {
  const b = await loadBuffer(path);
  if (!b) return;
  if (!openTabs.includes(path)) openTabs.push(path);
  setActive(path);
  if (at && b.ta) {
    const off = offsetOf(b.text, at.line, at.col);
    b.ta.focus();
    b.ta.setSelectionRange(off, off + (at.len ?? 0));
    revealOffset(b, off);
  }
}
// Opens a file on the right side of the split; the left keeps its file (or shows this one too if it had none).
async function openFileInSplit(path: string): Promise<void> {
  if (baseName(path).startsWith('.env') && !buffers.has(path)) { toast('Open this protected file in a tab first'); return; }
  const b = await loadBuffer(path);
  if (!b) return;
  if (b.kind !== 'text') { toast('Only text files open in the split view'); return; }
  if (!openTabs.includes(path)) openTabs.push(path);
  if (!active) setActive(path); else renderEditor();
  openSplit(path, true);
  renderTabs();
}
function setActive(path: string | null): void {
  const changed = active !== path;
  active = path;
  if (changed && path) sfx.play('tab');
  renderTabs(); renderEditor(); renderTree(); saveSession();
  if (changed) queueDiscord();
  if (changed) fadeInEditor();
  if (running && path && /\.(html?|css|js)$/i.test(path)) $('#urlText').title = path;
}
// Another file's code fades in rather than snapping in place of the last one.
function fadeInEditor(): void {
  if (!activeBuf() || activeBuf()?.kind !== 'text') return;
  for (const el of [$('#hl'), $('#gutter')]) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
}
const seenTabs = new Set<string>();
function tabHtml(n: string): string {
  const lock = locks[n];
  const b = buffers.get(n);
  const cls = ['tab', n === active ? 'on' : '', isDirty(b) ? 'dirty' : '', b?.diags?.length ? 'has-err' : '', seenTabs.has(n) ? '' : 'enter'].filter(Boolean).join(' ');
  seenTabs.add(n);
  const dot = lock ? `<span class="dot tint-${lock.phase}" title="${escAttr(`${agentNameOf(lock.agent)} is editing this`)}"></span>` : '';
  const f = gitState.files?.find(x => x.path === n);
  const st = f && statusOf(f);
  const gitTag = st ? `<span class="gst ${st.cls}" title="${st.title}">${st.letter}</span>` : '';
  const nameHtml = fileNameHtml(baseName(n));
  return `<div class="${cls}" data-tab="${escAttr(n)}" title="${escAttr(n)}">${dot}<span class="ico">${fileIcon(baseName(n))}</span><span class="nm">${nameHtml}</span>${gitTag}<span class="x" data-close-tab="1" title="Close (Ctrl+W)">${svgIcon('x', 12)}</span></div>`;
}
function renderTabs(): void {
  // Re-rendering mid-drag would drop the tab being dragged; catch up when it lands.
  if (tabDrag?.moved) { tabDrag.stale = true; return; }
  const tabsEl = $('#tabs');
  const hasTabs = openTabs.length > 0;
  let growNew: HTMLElement | null = null;
  tabsEl.classList.toggle('hidden', !hasTabs);
  if (!hasTabs) {
    tabsEl.innerHTML = '';
  } else {
    let runBtn = '';
    let runKind = '';
    if (runnable(active)) {
      runKind = 'run';
      runBtn = `<button class="tab-run${tabRunCompact ? ' compact' : ''}" data-run-file="1" data-kind="run" title="Run File (F5)">${svgIcon('play', 12)}<span>Run</span></button>`;
    } else if (isHtml(active)) {
      runKind = 'preview';
      runBtn = `<button class="tab-run tab-preview${tabRunCompact ? ' compact' : ''}" data-preview-file="1" data-kind="preview" title="Preview this page (F5)">${svgIcon('play', 12)}<span>Preview</span></button>`;
    }
    const splitTitle = `${splitPath ? 'Close Split' : 'Split Editor Right'} (Ctrl\\)`;
    const splitBtn = `<button class="icon-btn tab-split" data-split="1">${svgIcon('columns', 14)}</button>`;
    const oldRun = tabsEl.querySelector<HTMLElement>('.tab-run:not(.ghost)');
    // Kind, not title: the tooltip code takes a hovered button's title away, and the button then read as a new one.
    const oldKind = oldRun?.dataset.kind ?? '';
    // The same Run / Preview, and any old one still narrowing shut, stay put rather than being rebuilt: the strip
    // re-renders often (git status, saves), and a fresh button would cut its grow, fold or shrink short.
    const keep = oldRun && oldKind === runKind ? oldRun : null;
    // The split button stays too: rebuilt under the pointer that just clicked it, it replayed its hover bounce.
    const oldSplit = tabsEl.querySelector<HTMLElement>('.tab-split');
    for (const c of [...tabsEl.children]) if (c !== keep && c !== oldSplit && !c.classList.contains('ghost')) c.remove();
    tabsEl.insertAdjacentHTML('afterbegin', openTabs.map(tabHtml).join(''));
    if (!oldSplit) tabsEl.insertAdjacentHTML('beforeend', splitBtn);
    const split = $('.tab-split', tabsEl);
    split.classList.toggle('on', !!splitPath);
    split.title = splitTitle;
    split.setAttribute('aria-label', splitTitle);
    if (!keep) split.insertAdjacentHTML('beforebegin', runBtn);
    // Run / Preview grows open when a file that has one opens, and narrows shut in place when it no longer does.
    const newRun = tabsEl.querySelector<HTMLElement>('.tab-run:not(.ghost)');
    if (oldRun && oldKind !== runKind) narrowAway(tabsEl, oldRun);
    if (newRun && oldKind !== runKind) growNew = newRun;
  }
  // Run / Preview first: hiding it widens the tabs, so the line under the open tab is placed after.
  fitTabRunBtn();
  if (growNew) growTabRun(growNew); // after the fit, so it grows to its folded or unfolded size
  placeTabInk();
  markCutTabNames();
  if (!running) renderPreviewEmpty();
  renderSplit();
}
// Run / Preview is sticky at the right edge, so on a narrow editor it would cover the file name. Tabs shrink to make
// room for it; once they can't shrink any more, it folds to just its play icon (its tooltip still names it), its
// label sliding away. The state outlives re-renders, so switching tabs doesn't replay the fold.
let tabRunCompact = false;
function fitTabRunBtn(): void {
  const tabs = $('#tabs');
  const btn = tabs.querySelector<HTMLElement>('.tab-run:not(.ghost)');
  if (!btn) return;
  // Measured with an unfolded stand-in in the button's place. Unfolding the live button to measure would cancel its
  // fold every frame of a window or panel resize (this runs on each one), and the fold would snap instead of animate.
  const probe = btn.cloneNode(true) as HTMLElement;
  probe.classList.remove('compact');
  probe.classList.add('probe');
  btn.style.position = 'absolute'; btn.style.visibility = 'hidden'; // out of the flow; its transitions keep running
  btn.after(probe);
  tabs.classList.add('measuring');
  const compact = tabs.scrollWidth > tabs.clientWidth + 1;
  tabs.classList.remove('measuring');
  probe.remove();
  btn.style.position = ''; btn.style.visibility = '';
  if (compact === tabRunCompact) return;
  tabRunCompact = compact;
  btn.classList.toggle('compact', compact);
  followTabRunFold();
}
// Read live (not the shared reduceMotion constant): tabs can render before that line of the script has run.
const tabMotionOff = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// Grow, not pop: the button's width opens from nothing (or closes to nothing) and the tabs beside it make room as it
// does, with no scaling or overshoot.
// An even ease-in-out: a strong ease-out opened most of the width in the first frame, so the grow read as a pop.
const TAB_RUN_GROW = { duration: 320, easing: 'cubic-bezier(.65, 0, .35, 1)' };
function tabRunBox(btn: HTMLElement): Keyframe {
  const cs = getComputedStyle(btn);
  return { width: `${btn.getBoundingClientRect().width}px`, paddingLeft: cs.paddingLeft, paddingRight: cs.paddingRight, borderLeftWidth: cs.borderLeftWidth, borderRightWidth: cs.borderRightWidth };
}
// No margin here: the auto margin that pushes the button right must stay live, or a strip that changes mid-animation
// leaves the button where it was measured and it snaps when the animation ends.
const TAB_RUN_SHUT: Keyframe = { width: '0px', paddingLeft: '0px', paddingRight: '0px', borderLeftWidth: '0px', borderRightWidth: '0px' };
function growTabRun(btn: HTMLElement): void {
  if (tabMotionOff()) return;
  const open = tabRunBox(btn);
  btn.animate([{ ...TAB_RUN_SHUT, overflow: 'hidden', boxSizing: 'border-box' }, { ...open, overflow: 'hidden', boxSizing: 'border-box' }], TAB_RUN_GROW);
  followTabRunFold();
}
// The old button stays in the strip, in its place before the split button, and narrows shut.
function narrowAway(strip: HTMLElement, btn: HTMLElement): void {
  if (tabMotionOff()) return;
  btn.setAttribute('aria-hidden', 'true');
  btn.removeAttribute('data-run-file'); btn.removeAttribute('data-preview-file');
  btn.classList.add('ghost'); // still styled as the button, but skipped wherever the live one is looked up
  btn.style.pointerEvents = 'none';
  strip.insertBefore(btn, strip.querySelector('.tab-split'));
  const out = btn.animate([{ ...tabRunBox(btn), overflow: 'hidden', boxSizing: 'border-box' }, { ...TAB_RUN_SHUT, overflow: 'hidden', boxSizing: 'border-box' }], { ...TAB_RUN_GROW, fill: 'forwards' });
  out.onfinish = () => { btn.remove(); placeTabInk(true); };
  setTimeout(() => { btn.remove(); placeTabInk(true); }, 400); // a hidden window runs no animations
  followTabRunFold();
}
// While the button folds or unfolds the tabs beside it resize, so the line under the open tab follows each frame.
function followTabRunFold(): void {
  const until = performance.now() + 400;
  const step = () => { placeTabInk(true); markCutTabNames(); if (performance.now() < until) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
// Resizing the window or a panel squeezes the tabs, so the line under the open one follows at once (no glide).
new ResizeObserver(() => { fitTabRunBtn(); placeTabInk(true); markCutTabNames(); }).observe($('#tabs'));
// A squeezed tab name is clipped with a fade rather than an ellipsis: an ellipsis drops whole letters, leaving a gap
// before the extension that jumps about as the strip is resized. Only names that don't fit get the fade.
function markCutTabNames(): void {
  for (const b of $$<HTMLElement>('#tabs .tab .nm-base')) b.classList.toggle('cut', b.scrollWidth > b.clientWidth + 0.5);
}
// The blue line under the open tab is one element that glides from the last tab to the new one.
// Tabs are re-rendered, so the line restarts from where it was drawn last and then moves.
let inkAt: { x: number; y: number; w: number } | null = null;
function placeTabInk(instant = false): void {
  const tabs = $('#tabs');
  const on = tabs.querySelector<HTMLElement>('.tab.on');
  const old = tabs.querySelector<HTMLElement>('.tab-ink');
  if (!on) { old?.remove(); inkAt = null; return; }
  const ink = old ?? tabs.appendChild(Object.assign(document.createElement('span'), { className: 'tab-ink' }));
  const next = { x: on.offsetLeft + 10, y: on.offsetTop + on.offsetHeight - 1, w: Math.max(0, on.offsetWidth - 20) };
  const draw = (p: { x: number; y: number; w: number }) => { ink.style.transform = `translate(${p.x}px, ${p.y}px)`; ink.style.width = `${p.w}px`; };
  if (instant) {
    ink.style.transition = 'none';
    draw(next);
    const _reflow = ink.offsetWidth;
    ink.style.transition = '';
    inkAt = next;
    return;
  }
  if (inkAt) {
    ink.style.transition = 'none';
    draw(inkAt);
    const _reflow = ink.offsetWidth; // commit the old spot so the move animates
    ink.style.transition = '';
  }
  draw(next);
  inkAt = next;
}
// A new tab grows in; the line follows its final width once it has.
$('#tabs').addEventListener('animationend', e => { if ((e.target as HTMLElement).classList.contains('tab')) { placeTabInk(); markCutTabNames(); } });
$('#tabs').addEventListener('click', e => {
  if ((e.target as HTMLElement).closest('[data-run-file]')) { run('run.file'); return; }
  if ((e.target as HTMLElement).closest('[data-preview-file]')) { if (active) { void startPreview(active); } return; }
  if ((e.target as HTMLElement).closest('[data-split]')) { run('view.splitEditor'); return; }
  const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
  if (!tab || justDragged) return;
  const p = tab.dataset.tab as string;
  if ((e.target as HTMLElement).closest('[data-close-tab]')) closeTab(p); else setActive(p);
});
$('#tabs').addEventListener('wheel', e => {
  const t = e.currentTarget as HTMLElement;
  if (!e.deltaX && e.deltaY) { t.scrollLeft += e.deltaY; e.preventDefault(); }
}, { passive: false });
$('#tabs').addEventListener('auxclick', e => {
  const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
  if (tab && e.button === 1) closeTab(tab.dataset.tab as string);
});

// Closing tabs: the blue line glides straight to the tab that will be open once they have folded away, the same
// slide as picking a tab, instead of vanishing and reappearing. Call before the closing tabs start to shrink.
function slideInkOnClose(closing: string[]): void {
  const tabs = $('#tabs');
  const ink = tabs.querySelector<HTMLElement>('.tab-ink');
  const tabEl = (p: string | null) => (p ? tabs.querySelector<HTMLElement>(`[data-tab="${CSS.escape(p)}"]`) : null);
  // The tab that ends up open, picked the way dropTab picks it.
  const left = [...openTabs];
  let next = active;
  for (const p of closing) {
    const i = left.indexOf(p);
    if (i === -1) continue;
    left.splice(i, 1);
    if (next === p) next = left[Math.min(i, left.length - 1)] ?? null;
  }
  const target = tabEl(next);
  if (!ink || !target || closing.includes(next as string)) return;
  // Tabs to its left that close slide it over by their width plus the gap after them.
  let shift = 0;
  for (const p of closing) {
    const c = tabEl(p);
    if (!c || c.offsetLeft >= target.offsetLeft) continue;
    const after = c.nextElementSibling as HTMLElement | null;
    shift += after?.classList.contains('tab') ? after.offsetLeft - c.offsetLeft : c.offsetWidth;
  }
  const to = { x: target.offsetLeft - shift + 10, y: target.offsetTop + target.offsetHeight - 1, w: Math.max(0, target.offsetWidth - 20) };
  ink.style.transform = `translate(${to.x}px, ${to.y}px)`;
  ink.style.width = `${to.w}px`;
  inkAt = to; // the redraw after the close starts from here, so the line doesn't jump back
  for (const p of closing) tabEl(p)?.classList.remove('on');
  target.classList.add('on');
}
// Closes several tabs at once, asking once about any unsaved ones.
function closeTabs(paths: string[]): void {
  const dirty = paths.map(p => buffers.get(p)).filter((b): b is EditorBuffer => isDirty(b));
  const finish = () => {
    const tabEls = paths.map(p => $(`#tabs [data-tab="${CSS.escape(p)}"]`)).filter((el): el is HTMLElement => !!el);
    const isClosingAll = paths.length >= openTabs.length;
    if (tabEls.length) {
      if (!isClosingAll) slideInkOnClose(paths);
      tabEls.forEach(el => {
        if (el.classList.contains('closing')) return;
        const w = el.getBoundingClientRect().width;
        el.style.width = `${w}px`;
        el.style.maxWidth = `${w}px`;
        const _reflow = el.offsetWidth;
        el.classList.add('closing');
      });
      if (isClosingAll) {
        const ink = $('#tabs .tab-ink');
        if (ink) {
          ink.style.opacity = '0';
          ink.style.transition = 'opacity .12s ease-out';
        }
        $$('#editor .gutter, #editor .code').forEach(el => el.classList.add('editor-blur-out'));
        const empty = $('#editorEmpty');
        if (empty && !empty.classList.contains('hidden')) empty.classList.add('editor-blur-out');
      }
      setTimeout(() => {
        $$('#editor .gutter, #editor .code, #editorEmpty').forEach(el => el.classList.remove('editor-blur-out'));
        for (const p of paths) dropTab(p);
        renderTabs(); renderEditor(); renderTree(); saveSession();
      }, 190);
    } else {
      for (const p of paths) dropTab(p);
      renderTabs(); renderEditor(); renderTree(); saveSession();
    }
  };
  if (!dirty.length) { finish(); return; }
  openModal(`<h3>Save changes to ${plural(dirty.length, 'file')}?</h3><p class="sub">${dirty.map(b => esc(b.path)).join('<br>')}</p>
    <div class="row end"><button class="btn" data-close>Cancel</button><button class="btn" id="tabsDontSave">Don't Save</button><button class="btn btn-primary" id="tabsSave">Save</button></div>`, m => {
    $('#tabsDontSave', m).onclick = () => { closeModal(); finish(); };
    $('#tabsSave', m).onclick = () => {
      closeModal();
      background(saveBuffers(dirty).then(ok => { if (ok) finish(); }));
    };
  });
}
// Shows a file in the explorer, opening the folders above it.
function revealInTree(p: string): void {
  for (let d = dirName(p); d; d = dirName(d)) expanded.add(d);
  showView('files', true);
  background(refreshTree().then(() => $$('#tree [data-path]').find(el => el.dataset.path === p)?.scrollIntoView({ block: 'nearest' })));
}
// Right-clicking a tab: close it, the others, the ones to its right, the saved ones or all of them.
$('#tabs').addEventListener('contextmenu', e => {
  const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
  if (!tab) return;
  e.preventDefault();
  const p = tab.dataset.tab as string;
  const others = openTabs.filter(x => x !== p);
  const right = openTabs.slice(openTabs.indexOf(p) + 1);
  const saved = openTabs.filter(x => !isDirty(buffers.get(x)));
  popupMenu(e.clientX, e.clientY, [
    { label: 'Close', key: 'Ctrl+W', run: () => closeTab(p) },
    { label: 'Close Other Tabs', enabled: () => others.length > 0, run: () => closeTabs(others) },
    { label: 'Close Tabs to the Right', enabled: () => right.length > 0, run: () => closeTabs(right) },
    { label: 'Close Saved Tabs', enabled: () => saved.length > 0, run: () => closeTabs(saved) },
    { label: 'Close All Tabs', run: () => closeTabs([...openTabs]) },
    { sep: true },
    { label: 'Open in Split Right', enabled: () => buffers.get(p)?.kind === 'text', run: () => { openSplit(p, true); renderTabs(); } },
    { sep: true },
    { label: 'Copy Relative Path', run: () => background(navigator.clipboard.writeText(p).then(() => toast('Path copied'))) },
    { label: 'Reveal in Explorer', run: () => revealInTree(p) },
  ]);
});

/* ----- Dragging tabs to reorder them ----- */
// The dragged tab follows the pointer; once its middle passes a neighbour's middle the two swap,
// and the neighbour slides into its new place.
interface TabDrag { el: HTMLElement; path: string; startX: number; moved: boolean; stale: boolean; }
let tabDrag: TabDrag | null = null;
let justDragged = false;
const middle = (el: Element) => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; };
function slideFrom(el: Element, fromLeft: number): void {
  const dx = fromLeft - el.getBoundingClientRect().left;
  if (dx) el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)' });
}
// Moves `other` to the far side of the dragged tab, keeping the dragged tab under the pointer.
function swapTab(d: TabDrag, other: Element, clientX: number): void {
  const before = d.el.offsetLeft, otherLeft = other.getBoundingClientRect().left;
  if (other === d.el.nextElementSibling) d.el.before(other); else d.el.after(other);
  d.startX += d.el.offsetLeft - before;
  d.el.style.transform = `translateX(${clientX - d.startX}px)`;
  slideFrom(other, otherLeft);
}
function dragTabMove(e: PointerEvent): void {
  const d = tabDrag;
  if (!d) return;
  const dx = e.clientX - d.startX;
  if (!d.moved && Math.abs(dx) < 5) return;
  if (!d.moved) { d.moved = true; d.el.classList.add('dragging'); $('#tabs').classList.add('drag-active'); }
  d.el.style.transform = `translateX(${dx}px)`;
  const mid = middle(d.el);
  const next = d.el.nextElementSibling, prev = d.el.previousElementSibling;
  if (next && mid > middle(next)) swapTab(d, next, e.clientX);
  else if (prev && mid < middle(prev)) swapTab(d, prev, e.clientX);
}
function dragTabEnd(e: PointerEvent): void {
  removeEventListener('pointermove', dragTabMove);
  removeEventListener('pointerup', dragTabEnd);
  const d = tabDrag;
  tabDrag = null;
  if (!d?.moved) return;
  // The click that follows a drag must not activate or close anything.
  justDragged = true;
  setTimeout(() => { justDragged = false; }, 0);
  $('#tabs').classList.remove('drag-active');
  openTabs = $$('#tabs [data-tab]').map(t => t.dataset.tab as string);
  const rest = e.clientX - d.startX;
  setActive(d.path);
  const landed = $$('#tabs [data-tab]').find(t => t.dataset.tab === d.path);
  if (landed && rest) landed.animate([{ transform: `translateX(${rest}px)` }, { transform: 'none' }], { duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)' });

  const dropEl = document.elementFromPoint(e.clientX, e.clientY);
  if (dropEl?.closest('#agents, #box')) {
    const s = dropEl.closest('#box') ? SURFACES.box : SURFACES.ide;
    void attachPathToAgent(d.path, false, s);
  }
}
$('#tabs').addEventListener('pointerdown', e => {
  const t = e.target as HTMLElement;
  const el = t.closest<HTMLElement>('[data-tab]');
  if (!el || e.button !== 0 || t.closest('[data-close-tab]')) return;
  tabDrag = { el, path: el.dataset.tab as string, startX: e.clientX, moved: false, stale: false };
  addEventListener('pointermove', dragTabMove);
  addEventListener('pointerup', dragTabEnd);
});

function dropTab(path: string): void {
  const i = openTabs.indexOf(path);
  if (i === -1) return;
  openTabs.splice(i, 1);
  buffers.get(path)?.ta?.remove();
  buffers.delete(path);
  lspClosed(path);
  if (active === path) active = openTabs[Math.min(i, openTabs.length - 1)] ?? null;
}
function closeTab(path: string): void {
  const b = buffers.get(path);
  const finish = () => {
    const tabEl = $(`#tabs [data-tab="${CSS.escape(path)}"]`);
    const isLastTab = openTabs.length <= 1;
    if (!tabEl?.classList.contains('closing')) sfx.play('remove');
    if (tabEl) {
      if (tabEl.classList.contains('closing')) return;
      if (!isLastTab) slideInkOnClose([path]);
      const w = tabEl.getBoundingClientRect().width;
      tabEl.style.width = `${w}px`;
      tabEl.style.maxWidth = `${w}px`;
      const _reflow = tabEl.offsetWidth;
      tabEl.classList.add('closing');
      // The next file shows (and fades in) right away; the tab itself folds away meanwhile.
      if (!isLastTab && active === path) {
        const i = openTabs.indexOf(path);
        active = openTabs[i + 1] ?? openTabs[i - 1] ?? null;
        renderEditor();
        fadeInEditor();
      }
      if (isLastTab) {
        const ink = $('#tabs .tab-ink');
        if (ink) {
          ink.style.opacity = '0';
          ink.style.transition = 'opacity .12s ease-out';
        }
        $$('#editor .gutter, #editor .code').forEach(el => el.classList.add('editor-blur-out'));
        const empty = $('#editorEmpty');
        if (empty && !empty.classList.contains('hidden')) empty.classList.add('editor-blur-out');
      }
      setTimeout(() => {
        $$('#editor .gutter, #editor .code, #editorEmpty').forEach(el => el.classList.remove('editor-blur-out'));
        dropTab(path);
        renderTabs(); renderEditor(); renderTree(); saveSession();
      }, 190);
    } else {
      const wasActive = active === path;
      dropTab(path);
      renderTabs(); renderEditor(); renderTree(); saveSession();
      if (wasActive) fadeInEditor();
    }
  };
  if (!isDirty(b)) { finish(); return; }
  openModal(`<h3>Save changes to ${esc(baseName(path))}?</h3><p class="sub">Your changes will be lost if you don't save them.</p>
    <div class="row end"><button class="btn" data-close>Cancel</button><button class="btn" id="dontSave">Don't Save</button><button class="btn btn-primary" id="doSave">Save</button></div>`, m => {
    $('#dontSave', m).onclick = () => { closeModal(); finish(); };
    $('#doSave', m).onclick = () => { closeModal(); background(saveFile(path).then(ok => { if (ok) finish(); })); };
  });
}
async function saveFile(path: string | null = active): Promise<boolean> {
  const b = path ? buffers.get(path) : undefined;
  if (b?.kind !== 'text') return false;
  if (b.disk != null) {
    const choice = await askDiskConflict(b);
    if (choice === 'reload') { loadDiskVersion(b); return false; }
    if (choice !== 'overwrite') return false;
  }
  const text = b.text;
  try { await api.fs.writeFile(b.path, b.eol === '\r\n' ? text.replaceAll('\n', '\r\n') : text); }
  catch (e) { toast(`Couldn't save ${baseName(b.path)}: ${errMsg(e)}`); return false; }
  b.saved = text;
  b.disk = undefined;
  renderTabs(); renderTree(); flushSession();
  if (running) void reloadPreview();
  return true;
}
// The file changed on disk while it had unsaved edits: keep this version, or take the one on disk.
function askDiskConflict(b: EditorBuffer): Promise<'overwrite' | 'reload' | null> {
  return new Promise(resolve => {
    let picked: 'overwrite' | 'reload' | null = null;
    openModal(`<h3>${esc(baseName(b.path))} changed on disk</h3><p class="sub">Something else changed this file after you started editing it. Saving now replaces that change with yours.</p><div class="row end"><button class="btn" data-close>Cancel</button><button class="btn" id="diskReload">Use disk version</button><button class="btn btn-primary" id="diskOverwrite">Overwrite</button></div>`,
      m => {
        $('#diskReload', m).onclick = () => { picked = 'reload'; closeModal(); };
        $('#diskOverwrite', m).onclick = () => { picked = 'overwrite'; closeModal(); };
      },
      () => resolve(picked));
  });
}
// Drops the unsaved edits for the text on disk (undo brings them back).
function loadDiskVersion(b: EditorBuffer): void {
  if (b.disk == null) return;
  remember(b, 'reload');
  b.text = b.saved = b.disk;
  b.disk = undefined;
  if (b.ta) { const s = Math.min(b.ta.selectionStart, b.text.length); b.ta.value = b.text; b.ta.setSelectionRange(s, s); }
  if (b.path === active) renderCode();
  renderTabs(); renderTree(); flushSession();
  scheduleLint(b, 0);
}
// Saves several buffers; true when every one was saved. Files changed on disk ask in turn, so their questions
// don't replace one another.
async function saveBuffers(list: EditorBuffer[]): Promise<boolean> {
  const saved = await Promise.all(list.filter(b => b.disk == null).map(b => saveFile(b.path)));
  for (const b of list.filter(b => b.disk != null)) saved.push(await saveFile(b.path));
  return saved.every(Boolean);
}
async function saveAll(): Promise<boolean> {
  const dirty = [...buffers.values()].filter(isDirty);
  const ok = await saveBuffers(dirty);
  const n = dirty.filter(b => !isDirty(b)).length;
  if (n) toast(`Saved ${plural(n, 'file')}`);
  return ok;
}

