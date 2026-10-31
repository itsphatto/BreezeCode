/* ----- "@" mentions in the agents panel's prompt: a menu of installed agents, and a warning for one that is not installed ----- */
const MENTION_AT_CARET = /(^|\s)@([\w-]*)$/;
let mentionList: { items: MenuItem[]; ids: string } | null = null;

const mentionOpen = (): boolean => !!mentionList && openMenuIdx !== -1 && menuItems === mentionList.items;
function closeMention(): void {
  const open = mentionOpen();
  mentionList = null;
  if (open) closeMenu();
}
// Replaces the "@word" before the caret with "@<Short> ".
function pickMention(a: DetectedAgent): void {
  const ta = SURFACES.ide.prompt;
  const caret = ta.selectionStart ?? ta.value.length;
  const m = MENTION_AT_CARET.exec(ta.value.slice(0, caret));
  const start = m ? caret - m[2].length - 1 : caret;
  ta.setRangeText(`@${agentShortName(a)} `, start, caret, 'end');
  ta.focus();
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}
function updateMentionMenu(): void {
  const ta = SURFACES.ide.prompt;
  const m = MENTION_AT_CARET.exec(ta.value.slice(0, ta.selectionStart ?? 0));
  const word = m ? m[2].toLowerCase() : '';
  const matches = m ? (appState.detect?.agents ?? []).filter(a => a.found && agentMentionNames(a).some(n => n.startsWith(word))) : [];
  if (!matches.length) { closeMention(); return; }
  const ids = matches.map(a => a.id).join(',');
  if (mentionOpen() && mentionList?.ids === ids) return; // the same agents are already listed
  const items: MenuItem[] = matches.map(a => ({ label: agentShortName(a), icon: brandMark('menu-ico', a.id, a.name[0]), run: () => pickMention(a) }));
  mentionList = { items, ids };
  const r = ta.getBoundingClientRect();
  popupMenu(r.left, r.top, items, () => { if (mentionList?.items === items) mentionList = null; }, ta);
  const menu = document.querySelector<HTMLElement>('#menuRoot .menu');
  if (menu) { // above the prompt, where the text being typed stays visible
    menu.classList.add('up');
    menu.style.top = `${Math.max(8, r.top - menu.offsetHeight - 6)}px`;
  }
  kbIdx = -1;
  moveKbSelection(true);
}
// The menu is open: Up, Down, Enter, Tab and Escape belong to it. Registered before the send handler below, so Enter picks instead of sending.
SURFACES.ide.prompt.addEventListener('keydown', e => {
  if (!mentionOpen() || e.isComposing) return;
  const own = () => { e.preventDefault(); e.stopImmediatePropagation(); };
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { own(); moveKbSelection(e.key === 'ArrowDown'); }
  else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { own(); if (kbIdx >= 0) activateMenuItem(menuItems[kbIdx]); }
  else if (e.key === 'Escape') { own(); closeMention(); }
});
SURFACES.ide.prompt.addEventListener('input', () => { mentionWarning(SURFACES.ide); updateMentionMenu(); });
SURFACES.ide.prompt.addEventListener('keyup', e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) updateMentionMenu(); });
SURFACES.ide.prompt.addEventListener('click', updateMentionMenu);
SURFACES.ide.prompt.addEventListener('blur', closeMention);

// "@Codex" for an agent Breeze knows but that is not installed. Any other "@word" is plain text.
function uninstalledMention(text: string): string | null {
  const names = (appState.detect?.agents ?? []).flatMap(a => agentMentionNames(a).map(name => ({ name, a }))).sort((x, y) => y.name.length - x.name.length);
  const re = /(^|\s)@/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const rest = text.slice(m.index + m[1].length + 1).toLowerCase();
    const hit = names.find(n => rest.startsWith(n.name) && !/[\w-]/.test(rest[n.name.length] ?? ''));
    if (hit && !hit.a.found) return `@${agentShortName(hit.a)} isn't installed`;
  }
  return null;
}
// Where each "@Agent" for an installed agent sits in `text`, as [start, end) pairs.
function mentionRanges(text: string): [number, number][] {
  const names = (appState.detect?.agents ?? []).filter(a => a.found).flatMap(agentMentionNames).sort((x, y) => y.length - x.length);
  const out: [number, number][] = [];
  if (!names.length) return out;
  const re = /(^|\s)@/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const at = m.index + m[1].length;
    const rest = text.slice(at + 1).toLowerCase();
    const hit = names.find(n => rest.startsWith(n) && !/[\w-]/.test(rest[n.length] ?? ''));
    if (hit) out.push([at, at + 1 + hit.length]);
  }
  return out;
}
// `text` escaped, with its mentions of installed agents wrapped in <span class="mention">.
function mentionHtml(text: string): string {
  let html = '';
  let from = 0;
  for (const [a, b] of mentionRanges(text)) {
    html += `${esc(text.slice(from, a))}<span class="mention">${esc(text.slice(a, b))}</span>`;
    from = b;
  }
  return html + esc(text.slice(from));
}
// The prompt's text is drawn by a layer behind it (the textarea's own text is transparent), so mentions can be blue.
const promptHl = $('#promptHl');
// The installed agents @mentioned in `text`, once each, in the order they appear.
function mentionedAgents(text: string): DetectedAgent[] {
  const agents = (appState.detect?.agents ?? []).filter(a => a.found);
  const out: DetectedAgent[] = [];
  for (const [a, b] of mentionRanges(text)) {
    const word = text.slice(a + 1, b).toLowerCase();
    const ag = agents.find(x => agentMentionNames(x).includes(word));
    if (ag && !out.includes(ag)) out.push(ag);
  }
  return out;
}
// Under the prompt: one chip per agent tagged in it, showing its model and effort; a click changes either.
// Chips are kept between keystrokes so only a newly tagged agent slides in.
function promptModelHtml(a: DetectedAgent): string {
  const model = a.version || a.models?.[0] || '';
  const eff = a.api ? '' : `<small class="dd-eff"> · ${esc(agentEffort(a))}</small>`;
  return `<b>${esc(agentShortName(a))}</b><span class="pm-model">${esc(model)}</span>${eff}${svgIcon('chevronDown', 10)}`;
}
function renderPromptModels(): void {
  const box = $('#promptModels');
  const tagged = mentionedAgents(SURFACES.ide.prompt.value).filter(a => a.models?.length || a.version);
  const ids = tagged.map(a => a.id);
  // An untagged agent's chip fades out where it is; the box keeps its row until then (see fitPrompt), so the chip
  // never ends up beside the one-line prompt, and only folds to one line once it's gone.
  for (const el of $$<HTMLElement>('.prompt-model', box)) {
    if (ids.includes(el.dataset.agent as string) || el.classList.contains('leaving')) continue;
    el.classList.add('leaving');
    let gone = false;
    const done = () => {
      if (gone) return;
      gone = true;
      // The box then eases down to one line instead of snapping.
      const composer = el.closest<HTMLElement>('.composer-box');
      const fromH = composer?.getBoundingClientRect().height ?? 0;
      el.remove();
      syncPromptHl();
      if (!composer || reduceMotion.matches) return;
      const toH = composer.getBoundingClientRect().height;
      if (Math.abs(toH - fromH) < 1) return;
      const frame = { boxSizing: 'border-box', overflow: 'hidden' };
      composer.animate([{ ...frame, height: `${fromH}px` }, { ...frame, height: `${toH}px` }], { duration: 200, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    };
    el.addEventListener('animationend', done, { once: true });
    setTimeout(done, 400);
  }
  let prev: HTMLElement | null = null;
  for (const a of tagged) {
    let el = box.querySelector<HTMLElement>(`.prompt-model[data-agent="${CSS.escape(a.id)}"]:not(.leaving)`);
    if (!el) {
      const btn = document.createElement('button');
      btn.type = 'button';
      el = btn;
      el.className = 'prompt-model';
      el.dataset.agent = a.id;
      el.setAttribute('aria-haspopup', 'menu');
    }
    const html = promptModelHtml(a);
    if (el.innerHTML !== html) el.innerHTML = html;
    el.setAttribute('aria-label', `${agentShortName(a)}: change model${a.api ? '' : ' or effort'}`); // no tooltip, just for screen readers
    if (prev ? prev.nextElementSibling !== el : box.firstElementChild !== el) {
      if (prev) prev.after(el); else box.prepend(el);
    }
    prev = el;
  }
}
$('#promptModels').addEventListener('click', e => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('.prompt-model:not(.leaving)');
  const ag = chip && appState.detect?.agents.find(x => x.id === chip.dataset.agent);
  if (!chip || !ag) return;
  openChipMenu(chip, modelPickerItems(ag));
  // The composer sits at the bottom of the window, so the menu opens upwards.
  const m = chip.classList.contains('open') ? $('#menuRoot .menu') : null;
  if (m) {
    const r = chip.getBoundingClientRect();
    m.style.left = `${Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8))}px`;
    m.style.top = `${Math.max(8, r.top - m.offsetHeight - 4)}px`;
    m.classList.add('up');
  }
});
// The prompt grows with its text, up to a cap, then scrolls.
const PROMPT_MAX_H = 200;
// While no agent is tagged, the send button sits beside the prompt rather than on a row of its own.
function fitPrompt(): void {
  const ta = SURFACES.ide.prompt;
  const box = ta.closest('.composer-box') as HTMLElement;
  box.classList.toggle('compact', !$('#promptModels').querySelector('.prompt-model'));
  ta.style.height = 'auto';
  const need = ta.scrollHeight;
  ta.style.height = `${Math.min(PROMPT_MAX_H, need)}px`;
  ta.style.overflowY = need > PROMPT_MAX_H ? 'auto' : 'hidden';
  // One line: the send button sits centred beside it. More lines: it stays level with the last one.
  const cs = getComputedStyle(ta);
  const lineH = Number.parseFloat(cs.lineHeight) || Number.parseFloat(cs.fontSize) * 1.5;
  box.classList.toggle('one-line', need <= lineH * 1.5 + Number.parseFloat(cs.paddingTop) + Number.parseFloat(cs.paddingBottom));
}
// A new line eases the prompt to its new height. Only the text box animates: the box grows around it and the
// send button, pinned to the bottom, never moves.
let promptAnim: Animation | null = null;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
function animatePromptHeight(ta: HTMLTextAreaElement, fromH: number): void {
  promptAnim?.cancel(); // read the end height without it (the start was read with it)
  const toH = ta.offsetHeight;
  if (Math.abs(toH - fromH) < 1 || reduceMotion.matches) return;
  promptAnim = ta.animate([{ height: `${fromH}px` }, { height: `${toH}px` }], { duration: 200, easing: 'cubic-bezier(.22, 1, .36, 1)' });
}
/* ----- Grow: when a panel is squeezed or widened and text rewraps, blocks ease to their new height instead of
   jumping (the commit box going from one line to two, a note gaining a line). Only height animates: widths keep
   up with the sash as it is dragged. Boxes that size themselves as you type (textareas) ease too. ----- */
const GROW_SEL = 'textarea, button, .btn, p, h1, h2, h3, h4, label, .side-note, .scm-row, .commit, .card, .agent-card, .quick-card, .pill, .chip, .empty';
// Things with their own size animation, or that must never lag: the agent prompt, the code editors, terminals, menus,
// and the one-line rows of the file tree and search results (redrawn often, never rewrapped).
const GROW_SKIP = '#prompt, .ta, .editor, .term-body, .menu, .tabs, .term-tabs, .agent-tabs-bar, .agent-bar, #tree, #searchResults, [data-no-grow]';
interface GrowState { w: number; h: number; anim?: Animation }
const growState = new WeakMap<Element, GrowState>();
// Dragging a sash resizes hundreds of watched blocks every frame, so this stays cheap: it reads all the new heights
// in one layout (cancelling first, then reading, never one after the other per element), skips blocks that are off
// screen, and starts at most GROW_PER_FRAME animations a frame. The rest just take their new size.
const GROW_PER_FRAME = 24;
const growRO = new ResizeObserver(entries => {
  const pending: { el: HTMLElement; w: number; from: number; st: GrowState; running: boolean }[] = [];
  for (const e of entries) {
    const el = e.target as HTMLElement;
    const size = e.borderBoxSize?.[0];
    const w = size ? size.inlineSize : el.offsetWidth;
    const h = size ? size.blockSize : el.offsetHeight;
    const st = growState.get(el);
    const running = st?.anim?.playState === 'running';
    // Our own animation stepping the height along: not a new size.
    if (running && st && Math.abs(w - st.w) < 0.5) continue;
    if (!st || !st.w || !st.h || !w || !h || !el.isConnected) { growState.set(el, { w, h }); continue; }
    const widthChanged = Math.abs(w - st.w) >= 0.5;
    if ((!widthChanged && el.tagName !== 'TEXTAREA') || (!running && Math.abs(h - st.h) < 1)) { growState.set(el, { w, h }); continue; }
    pending.push({ el, w, from: running ? h : st.h, st, running }); // mid-animation, it starts again from where it is
  }
  if (!pending.length) return;
  for (const p of pending) if (p.running) p.st.anim?.cancel();
  const vw = innerWidth, vh = innerHeight;
  const sized = pending.map(p => {
    const r = p.el.getBoundingClientRect();
    return { ...p, to: r.height, onScreen: r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw };
  });
  // While the window itself resizes (layout.ts), everything takes its new height at once.
  let budget = reduceMotion.matches || document.documentElement.classList.contains('win-resizing') ? 0 : GROW_PER_FRAME;
  // Border-box and clipped for the moment it runs, so padding counts and rewrapped text doesn't spill out.
  const frame = { boxSizing: 'border-box', overflow: 'hidden' };
  for (const p of sized) {
    if (Math.abs(p.to - p.from) < 1 || !p.onScreen || budget <= 0) { growState.set(p.el, { w: p.w, h: p.to }); continue; }
    budget--;
    const anim = p.el.animate([{ ...frame, height: `${p.from}px` }, { ...frame, height: `${p.to}px` }], { duration: 220, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    growState.set(p.el, { w: p.w, h: p.to, anim });
  }
});
// Watched: the elements above, plus every element that holds text of its own (a panel title, a label, a status
// line), so all text that rewraps eases. Inline text has no box of its own (it always measures 0 × 0), so the
// nearest block around it is watched instead.
const growResolved = new WeakSet<Element>();
function growWatch(el: Element): void {
  if (growResolved.has(el)) return;
  growResolved.add(el);
  if (el.closest(GROW_SKIP)) return;
  let box: Element | null = el;
  while (box && box !== document.body && ['inline', 'contents'].includes(getComputedStyle(box).display)) box = box.parentElement;
  if (box instanceof HTMLElement && box !== document.body && !box.closest(GROW_SKIP)) growRO.observe(box);
}
function watchGrow(root: Node): void {
  if (root instanceof Text) { if (root.parentElement && root.data.trim()) growWatch(root.parentElement); return; }
  if (!(root instanceof Element || root instanceof Document)) return;
  // Nothing inside a skipped area is watched, so a redraw there (each keystroke in the editor) isn't walked at all.
  if (root instanceof Element && root.closest(GROW_SKIP)) return;
  if (root instanceof Element && root.matches(GROW_SEL)) growWatch(root);
  for (const el of root.querySelectorAll(GROW_SEL)) growWatch(el);
  const texts = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: t => (t as Text).data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
  for (let t = texts.nextNode(); t; t = texts.nextNode()) if (t.parentElement) growWatch(t.parentElement);
}
watchGrow(document);
new MutationObserver(records => {
  for (const r of records) for (const n of r.addedNodes) watchGrow(n);
}).observe(document.body, { childList: true, subtree: true });
function syncPromptHl(): void {
  const ta = SURFACES.ide.prompt;
  const fromH = ta.getBoundingClientRect().height;
  renderPromptModels();
  fitPrompt();
  animatePromptHeight(ta, fromH);
  // A trailing newline needs a character after it, or the layer is a line short.
  promptHl.innerHTML = mentionHtml(ta.value) + (ta.value.endsWith('\n') ? ' ' : '');
  promptHl.style.right = `${ta.offsetWidth - ta.clientWidth}px`; // clear of its scroll bar, if it shows one
  promptHl.scrollTop = ta.scrollTop;
}
SURFACES.ide.prompt.addEventListener('scroll', () => { promptHl.scrollTop = SURFACES.ide.prompt.scrollTop; });
new ResizeObserver(syncPromptHl).observe(SURFACES.ide.prompt);

function mentionWarning(s: Surface): void {
  if (s.name === 'ide') syncPromptHl();
  const warn = s.name === 'ide' ? uninstalledMention(s.prompt.value) : null;
  const anchor = s.prompt.closest<HTMLElement>('.prompt-field') ?? s.prompt;
  let el = anchor.parentElement?.querySelector<HTMLElement>(':scope > .mention-warn') ?? null;
  if (!el) {
    if (!warn) return;
    el = document.createElement('div');
    el.className = 'mention-warn';
    el.setAttribute('role', 'status');
    anchor.insertAdjacentElement('afterend', el);
  }
  el.textContent = warn ?? '';
  el.classList.toggle('hidden', !warn);
}

for (const s of Object.values(SURFACES)) {
  s.send.onclick = () => {
    const tab = getActiveTab(s);
    if (tabBusy(tab)) stopAgent(tab);
    else void sendPrompt();
  };
  s.prompt.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendPrompt(); } });

  const box = s.prompt.closest<HTMLElement>('.composer-box');
  if (box) {
    box.addEventListener('dragover', e => {
      if (hasFiles(e) || draggedTreePath) {
        e.preventDefault();
        box.classList.add('drag-over');
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      }
    });
    box.addEventListener('dragleave', () => box.classList.remove('drag-over'));
    box.addEventListener('drop', async e => {
      clearAgentDropMarks();
      box.classList.remove('drag-over');
      e.preventDefault();
      e.stopPropagation();
      await handleAgentDrop(e, { el: box, surface: s, tab: getActiveTab(s) });
    });
  }
}

// Copy-paste image into agent tab (IDE aside/composer) or Breeze Box
document.addEventListener('paste', async (e: ClipboardEvent) => {
  const items = e.clipboardData?.items;
  const filesList = e.clipboardData?.files;
  const imgItem = items ? [...items].find(it => it.type.startsWith('image/')) : null;
  const imgFile = !imgItem && filesList?.length ? [...filesList].find(x => x.type.startsWith('image/') || IMAGE_FILE.test(x.name)) : null;

  if (!imgItem && !imgFile) return;

  const target = e.target as HTMLElement | null;
  const activeEl = document.activeElement;
  const inBox = !!(target?.closest('#box, .box-composer') || activeEl === SURFACES.box.prompt || appState.mode === 'box');
  const inIde = !!(target?.closest('#agents, .composer') || activeEl === SURFACES.ide.prompt || (!inBox && appState.mode === 'ide'));

  if (!inBox && !inIde) return;
  if (activeEl?.classList.contains('ta') && !target?.closest('#agents, #box, .composer, .box-composer')) return;

  const targetSurface = inBox ? SURFACES.box : SURFACES.ide;
  const file = imgItem ? imgItem.getAsFile() : (imgFile || null);
  if (!file) return;

  e.preventDefault();
  await addPastedImage(file, targetSurface);
});

// Click thumbnail or chat image to view full size modal, or click chat chip to open file / reveal folder
document.addEventListener('click', e => {
  const target = e.target as HTMLElement;
  const chip = target.closest<HTMLElement>('.chat-file-chip');
  if (chip?.dataset.path) {
    const p = chip.dataset.path;
    const isDir = chip.classList.contains('folder');
    if (isDir) {
      expanded.add(p);
      renderTree();
      toast(`Revealed folder · ${p}`);
    } else {
      openFile(p);
    }
    return;
  }
  const img = target.closest<HTMLImageElement>('.chat-img, .attachment-thumb');
  if (img?.src && !img.closest('.attachment-icon')) {
    const full = img.dataset.full || img.src;
    openModal(`<div class="img-modal-view"><img src="${escAttr(full)}" class="img-modal-img"><div class="row end w-full"><button class="btn btn-primary btn-sm" data-close>Close</button></div></div>`);
  }
});

// Hook up new chat buttons to create new tabs
const newChatBtn = document.getElementById('newChat');
if (newChatBtn) newChatBtn.onclick = () => newAgentTabAction(SURFACES.ide);
$('#agentNewTab')?.addEventListener('click', () => newAgentTabAction(SURFACES.ide));
$('#boxNewTab')?.addEventListener('click', () => newAgentTabAction(SURFACES.box));
$('[data-act="chat.new"]')?.addEventListener('click', () => newAgentTabAction(SURFACES.box));
commands['chat.new'] = () => newAgentTabAction(surface);
commands['agent.stop'] = () => stopAgent();

function stopAgent(targetTab?: AgentTabState): void {
  const tab = targetTab || getActiveTab(surface);
  const team = tab.agentTeam;
  if (team && team.pending > 0) {
    team.stopped = true;
    background(api.team.stop(team.id));
    return;
  }
  const claim = tab.teamClaim;
  if (claim) {
    if (claim.cancel) { claim.cancel(); return; } // the split card is open: same as its Cancel
    if (claim.cancelled) return;
    claim.cancelled = true;
    if (claim.teamId) background(api.team.stop(claim.teamId)); // the team is starting
    else setClaimLabel(claim.line, 'Stopping…'); // the claim pass has no team id yet: it is stopped when it returns
    return;
  }
  if (tab.runId != null) background(api.agent.stop(tab.runId));
}

const MODES: Record<string, AgentMode> = { build: 'build', ask: 'ask', plan: 'plan' };
const phaseFor = (mode: AgentMode): AgentKey => ({ build: 'builder', plan: 'planner', ask: 'assistant' } as const)[mode];

async function sendPrompt(): Promise<void> {
  const s = surface;
  const text = s.prompt.value.trim();
  const attachments = [...(attachmentsMap[s.name] || [])];
  const tab = getActiveTab(s);
  if ((!text && !attachments.length) || tabBusy(tab) || tab.parsing) return;
  const agent = selectedAgent();
  if (!agent) { openAgentPicker(); return; }
  if (s.name === 'ide' && !rootInfo) { toast('Open a folder first, so the agent knows what to work on'); return; }

  // @mentions split an IDE prompt between agents. Breeze Box sends "@Codex" as plain text to its agent.
  let parsed: TeamParse | null = null;
  if (s.name === 'ide' && text.includes('@')) {
    tab.parsing = true;
    try { parsed = await api.team.parse(text); } catch { parsed = null; } finally { tab.parsing = false; }
    if (tabBusy(tab)) return;
    // Only an agent Breeze knows but that isn't installed stops the send; "@types/node" and the like are plain text.
    const missing = parsed && uninstalledAgent(parsed.unknown);
    if (missing) { toast(`${agentShortName(missing)} isn't installed. Install it from Settings → Agents`); return; }
  }
  const onScreen = getActiveTab(s) === tab; // the parse is async: the person may have switched tabs meanwhile

  msgSurface = s;
  sfx.play('send');
  const uiMode = 'build'; // no mode picker any more: the agent works with full tools and decides how to answer
  if (onScreen) {
    s.prompt.value = '';
    mentionWarning(s);
    attachmentsMap[s.name] = [];
    renderAttachments(s);
  }
  tab.promptDraft = '';
  tab.attachments = [];
  dropAgentTeam(tab);

  if (tab.panel.querySelector('.empty')) tab.panel.innerHTML = '';

  if (/^Chat \d+$/i.test(tab.title) || tab.title === 'New chat') {
    if (text) {
      tab.title = text.length > 20 ? text.slice(0, 18) + '…' : text;
    } else {
      tab.title = 'Task';
    }
    renderAgentTabs(s);
  }

  team = [];
  teamNeed = 0;
  renderAgents();
  userMsg(text, attachments, tab);

  const headers = attachmentHeaders(attachments);
  const tasks = parsed?.tasks ?? [];
  if (parsed && tasks.length >= 2) {
    await startAgentTeam(tab, { ...parsed, shared: [headers, parsed.shared].filter(Boolean).join('\n\n') });
    return;
  }
  if (parsed && tasks.length === 1) {
    const body = [parsed.shared, tasks[0].text].filter(Boolean).join('\n\n') || text;
    await startAgentRun(tasks[0].agentId, MODES[uiMode] ?? 'plan', withAttachments(headers, body), uiMode, tab, true);
    return;
  }
  await startAgentRun(agent.id, MODES[uiMode] ?? 'plan', withAttachments(headers, text), uiMode, tab, true);
}

function attachmentHeaders(attachments: AgentAttachment[]): string {
  return attachments.map(a => {
    const kind = a.kind || (a.dataUrl || (a.fileUrl && IMAGE_FILE.test(a.name)) ? 'image' : 'file');
    if (kind === 'folder') return `[Attached folder: ${a.path || a.fileRel || a.name}]`;
    if (kind === 'file') return `[Attached file: ${a.path || a.fileRel || a.name}]`;
    return `[Attached image: ${a.fileRel || a.name}]`;
  }).join('\n');
}
function withAttachments(headers: string, text: string): string {
  if (!headers) return text;
  return headers + (text ? `\n\n${text}` : '\nPlease inspect the attached files/folders.');
}

// The first word of a parse's `unknown` that names an agent Breeze knows but this computer doesn't have.
function uninstalledAgent(words: string[]): DetectedAgent | null {
  const agents = appState.detect?.agents ?? [];
  for (const w of words) {
    const a = agents.find(x => !x.found && agentMentionNames(x).includes(w.toLowerCase()));
    if (a) return a;
  }
  return null;
}

// A new prompt ends the tab's last team: main drops it (and its snapshots), so the old summary's Undo says so.
function dropAgentTeam(tab: AgentTabState): void {
  const old = tab.agentTeam; // still here only when every member is done and its team-done has not come
  const id = old?.id ?? tab.lastTeamId;
  tab.agentTeam = undefined;
  tab.lastTeamId = undefined;
  tab.panel.querySelector(':scope > .team-strip')?.remove();
  if (id) background(api.team.stop(id));
}

