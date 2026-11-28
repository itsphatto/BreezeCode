/* ----- "@" mentions in the agents panel's prompt: a menu of installed agents, and a warning for one that is not installed ----- */
const MENTION_AT_CARET = /(^|\s)@([\w-]*)$/;
let mentionList: { items: MenuItem[]; ids: string; s: Surface } | null = null;

const mentionOpen = (): boolean => !!mentionList && openMenuIdx !== -1 && menuItems === mentionList.items;
function closeMention(): void {
  const open = mentionOpen();
  mentionList = null;
  if (open) closeMenu();
}
// Replaces the "@word" before the caret with "@<Short> ".
function pickMention(s: Surface, a: DetectedAgent): void {
  const ta = s.prompt;
  const caret = ta.selectionStart ?? ta.value.length;
  const m = MENTION_AT_CARET.exec(ta.value.slice(0, caret));
  const start = m ? caret - m[2].length - 1 : caret;
  ta.setRangeText(`@${agentShortName(a)} `, start, caret, 'end');
  ta.focus();
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}
// `taggable`: the agents this prompt can tag (the Agents tab: every installed one; a board box leaves out DeepSeek CLI).
function updateMentionMenu(s: Surface, taggable: () => DetectedAgent[]): void {
  const ta = s.prompt;
  const m = MENTION_AT_CARET.exec(ta.value.slice(0, ta.selectionStart ?? 0));
  if (m && document.activeElement !== ta) { if (mentionList?.s === s) closeMention(); return; } // a draft restored on start-up
  const word = m ? m[2].toLowerCase() : '';
  const matches = m ? taggable().filter(a => agentMentionNames(a).some(n => n.startsWith(word))) : [];
  if (!matches.length) { if (!mentionList || mentionList.s === s) closeMention(); return; }
  const ids = matches.map(a => a.id).join(',');
  if (mentionOpen() && mentionList?.ids === ids && mentionList.s === s) return; // the same agents are already listed
  const items: MenuItem[] = matches.map(a => ({ label: agentShortName(a), icon: brandMark('menu-ico', a.id, a.name[0]), run: () => pickMention(s, a) }));
  mentionList = { items, ids, s };
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
// The "@" menu on a prompt. Registered before its send handler, so Enter picks instead of sending: while the menu
// is open, Up, Down, Enter, Tab and Escape belong to it.
function wireMentions(s: Surface, taggable: () => DetectedAgent[]): void {
  const update = () => updateMentionMenu(s, taggable);
  s.prompt.addEventListener('keydown', e => {
    if (!mentionOpen() || mentionList?.s !== s || e.isComposing) return;
    const own = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { own(); moveKbSelection(e.key === 'ArrowDown'); }
    else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { own(); if (kbIdx >= 0) activateMenuItem(menuItems[kbIdx]); }
    else if (e.key === 'Escape') { own(); closeMention(); }
  });
  s.prompt.addEventListener('input', update);
  s.prompt.addEventListener('keyup', e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) update(); });
  s.prompt.addEventListener('click', update);
  s.prompt.addEventListener('blur', () => { if (mentionList?.s === s) closeMention(); });
}
SURFACES.ide.prompt.addEventListener('input', () => mentionWarning(SURFACES.ide));
wireMentions(SURFACES.ide, () => (appState.detect?.agents ?? []).filter(a => a.found));

/* ----- "/" in either prompt: the skills and plugin skills the agents can run, picked from a menu ----- */
// A user skill is "/name"; a plugin's is "/plugin:skill", as Claude Code names them. Loaded on the first "/" and
// again whenever the Skills view refreshes (setSlashSkills).
interface SlashSkill { cmd: string; desc: string; }
const SLASH_AT_CARET = /(^|\s)\/([\w:.-]*)$/;
let slashSkills: SlashSkill[] | null = null;
let slashLoading: Promise<void> | null = null;
let slashList: { items: MenuItem[]; key: string; s: Surface } | null = null;
function setSlashSkills(d: SkillList): void {
  const own = d.skills.map(k => ({ cmd: k.name, desc: k.description }));
  const plug = d.plugins.filter(p => p.enabled).flatMap(p => p.skills.map(k => ({ cmd: `${p.name}:${k.name}`, desc: k.description })));
  // The same skill can sit in several agents' folders; the menu lists it once.
  slashSkills = [...new Map([...own, ...plug].map(k => [k.cmd, k])).values()].sort((a, b) => a.cmd.localeCompare(b.cmd));
}
function loadSlashSkills(): Promise<void> {
  return (slashLoading ??= api.skills.list().then(setSlashSkills).catch(() => { slashSkills = []; }));
}
const slashOpen = (): boolean => !!slashList && openMenuIdx !== -1 && menuItems === slashList.items;
function closeSlash(): void {
  const open = slashOpen();
  slashList = null;
  if (open) closeMenu();
}
// "/cave" finds "/caveman:caveman" (the start of the name, or of the part after the colon).
function slashMatches(word: string): SlashSkill[] {
  const w = word.toLowerCase();
  return (slashSkills ?? []).filter(k => { const c = k.cmd.toLowerCase(); return c.startsWith(w) || (c.split(':')[1] ?? '').startsWith(w); }).slice(0, 8);
}
function pickSlash(s: Surface, k: SlashSkill): void {
  const ta = s.prompt;
  const caret = ta.selectionStart ?? ta.value.length;
  const m = SLASH_AT_CARET.exec(ta.value.slice(0, caret));
  const start = m ? caret - m[2].length - 1 : caret;
  ta.setRangeText(`/${k.cmd} `, start, caret, 'end');
  ta.focus();
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}
function updateSlashMenu(s: Surface): void {
  const ta = s.prompt;
  const m = SLASH_AT_CARET.exec(ta.value.slice(0, ta.selectionStart ?? 0));
  // Only while typing there: a draft brought back on start-up (restoreDraft) fires `input` too, in a prompt nobody is in.
  if (!m || document.activeElement !== ta) { closeSlash(); return; }
  if (!slashSkills) { void loadSlashSkills().then(() => { if (document.activeElement === ta) updateSlashMenu(s); }); return; }
  const matches = slashMatches(m[2]);
  if (!matches.length) { closeSlash(); return; }
  const key = matches.map(k => k.cmd).join(',');
  if (slashOpen() && slashList?.key === key && slashList.s === s) return; // the same skills are already listed
  // Just the names: a skill's description shows whole in a card beside the menu, on hover or the arrow keys.
  const items: MenuItem[] = matches.map(k => ({ label: `/${k.cmd}`, ...(k.desc ? { tip: k.desc } : {}), run: () => pickSlash(s, k) }));
  slashList = { items, key, s };
  const r = ta.getBoundingClientRect();
  popupMenu(r.left, r.top, items, () => { if (slashList?.items === items) slashList = null; }, ta);
  const menu = document.querySelector<HTMLElement>('#menuRoot .menu');
  if (menu) { // above the prompt, where the text being typed stays visible
    menu.classList.add('up', 'slash-menu');
    menu.style.top = `${Math.max(8, r.top - menu.offsetHeight - 6)}px`;
  }
  kbIdx = -1;
  moveKbSelection(true);
}
function wireSlash(s: Surface): void {
  // Registered before the send handler, so Enter picks a skill instead of sending.
  s.prompt.addEventListener('keydown', e => {
    if (!slashOpen() || slashList?.s !== s || e.isComposing) return;
    const own = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { own(); moveKbSelection(e.key === 'ArrowDown'); }
    else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { own(); if (kbIdx >= 0) activateMenuItem(menuItems[kbIdx]); }
    else if (e.key === 'Escape') { own(); closeSlash(); }
  });
  s.prompt.addEventListener('input', () => updateSlashMenu(s));
  s.prompt.addEventListener('keyup', e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) updateSlashMenu(s); });
  s.prompt.addEventListener('blur', closeSlash);
}
for (const s of Object.values(SURFACES)) wireSlash(s);
// Where each "/skill" Breeze knows sits in `text` (at the start or after a space), as [start, end) pairs.
function slashRanges(text: string): [number, number][] {
  const known = new Set((slashSkills ?? []).map(k => k.cmd.toLowerCase()));
  const out: [number, number][] = [];
  if (!known.size) return out;
  for (const m of text.matchAll(/(^|\s)\/([\w:.-]+)/g)) {
    if (!known.has(m[2].toLowerCase())) continue;
    const at = m.index + m[1].length;
    out.push([at, at + 1 + m[2].length]);
  }
  return out;
}

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
// `text` escaped, with its "/skill"s and (with `agents`) its mentions of installed agents wrapped in
// <span class="mention">, so they show blue. Bold, italic and struck text show styled (emphasis, mdcore.ts); `keep`: with
// their marks, for the prompt's layer, which must draw every character the textarea holds.
// shortcut: emphasis that spans a mention isn't styled; tokenize the whole line together if people write that.
function mentionHtml(text: string, agents = true, keep = false): string {
  let html = '';
  let from = 0;
  const plain = (s: string) => emphasis(esc(s), keep);
  const ranges = [...slashRanges(text), ...(agents ? mentionRanges(text) : [])].sort((x, y) => x[0] - y[0]);
  for (const [a, b] of ranges) {
    if (a < from) continue; // overlapping ranges can't happen ("/" and "@" each start one), but never draw text twice
    html += `${plain(text.slice(from, a))}<span class="mention">${esc(text.slice(a, b))}</span>`;
    from = b;
  }
  return html + plain(text.slice(from));
}
// The prompt's text is drawn by a layer behind it (the textarea's own text is transparent), so mentions can be blue.
const promptHl = $('#promptHl');
// One prompt box built like the Agents tab's: its textarea, the layer that draws its text, the row of model chips,
// and the agents those chips show for `text`. `mentions`: @agent words turn blue (the Agents tab only).
// `switchAgent`: a chip's menu picked another agent's model (an Agent board box swaps its own agent).
interface PromptKit { ta: HTMLTextAreaElement; hl: HTMLElement; models: HTMLElement; picked: (text: string) => DetectedAgent[]; mentions: boolean; anim: Animation | null; animH?: string; target?: (a: DetectedAgent) => ModelTarget | undefined; switchAgent?: (from: DetectedAgent, to: DetectedAgent, model: string) => void }
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
function promptModelHtml(a: DetectedAgent, target?: ModelTarget): string {
  const model = target?.model() || a.version || a.models?.[0] || '';
  const eff = !hasEffort(a) ? '' : `<small class="dd-eff"> · ${esc(target ? target.effort() : agentEffort(a))}</small>`;
  return `<b>${esc(agentShortName(a))}</b><span class="pm-model">${esc(versionLabel(model))}</span>${eff}${svgIcon('chevronDown', 10)}`;
}
// A chip whose agent, model or effort changed eases to its new width while its new text fades in (as swapText does),
// so a switch to another agent morphs the chip in place instead of one chip leaving while another slides in.
// Compared with what was written last, not innerHTML, whose serialization can differ and would replay it every keystroke.
const chipHtml = new WeakMap<HTMLElement, string>();
function morphChip(el: HTMLElement, html: string): void {
  const last = chipHtml.get(el) ?? el.innerHTML; // a chip written as markup (Home's) isn't tracked yet
  chipHtml.set(el, html);
  if (last === html) return;
  if (!el.isConnected || reducedMotion()) { el.innerHTML = html; return; }
  const from = el.getBoundingClientRect().width; // mid-morph: where it is now
  el.getAnimations().forEach(a => { if (a.id === 'chip-morph') a.cancel(); });
  el.innerHTML = html;
  const to = el.getBoundingClientRect().width;
  for (const c of el.children) c.animate([{ opacity: 0, filter: 'blur(3px)', transform: 'translateY(2px)' }, { opacity: 1, filter: 'blur(0)', transform: 'none' }], { duration: 360, easing: SPRING });
  if (Math.abs(from - to) >= 1) el.animate([{ boxSizing: 'border-box', width: `${from}px` }, { boxSizing: 'border-box', width: `${to}px` }], { duration: 450, easing: SPRING, id: 'chip-morph' });
}
// The Agents tab's chips: the agents tagged in the prompt, or with none tagged the default agent (the one that answers).
function idePickedAgents(text: string): DetectedAgent[] {
  const picked = mentionedAgents(text);
  if (picked.length) return picked;
  const def = appState.detect?.agents.find(x => x.id === appState.agent);
  return def ? [def] : [];
}
function renderPromptModels(kit: PromptKit = IDE_KIT): void {
  const box = kit.models;
  const text = kit.ta.value;
  const typed = !!text.trim();
  box.closest('.composer-box')?.classList.toggle('has-text', typed);
  const picked = kit.picked(text);
  const tagged = picked.filter(a => a.models?.length || a.version);
  const ids = tagged.map(a => a.id);
  // An untagged agent's chip fades out where it is; the box keeps its row until then (see fitPrompt), so the chip
  // never ends up beside the one-line prompt, and only folds to one line once it's gone.
  const chips = $$<HTMLElement>('.prompt-model:not(.leaving)', box);
  const arriving = tagged.filter(a => !chips.some(el => el.dataset.agent === a.id));
  for (const el of chips) {
    if (ids.includes(el.dataset.agent as string)) continue;
    // Swapped for another agent (a new default, an @mention renamed): this chip becomes the new one's and morphs.
    const next = arriving.shift();
    if (next) { el.dataset.agent = next.id; continue; }
    el.classList.add('leaving');
    let gone = false;
    const done = () => {
      if (gone) return;
      gone = true;
      // The box then eases down to one line instead of snapping.
      const composer = el.closest<HTMLElement>('.composer-box');
      const fromH = composer?.getBoundingClientRect().height ?? 0;
      el.remove();
      syncPromptHl(kit);
      if (!composer) return;
      const toH = composer.getBoundingClientRect().height;
      if (Math.abs(toH - fromH) < 1) return;
      const frame = { boxSizing: 'border-box', overflow: 'hidden' };
      composer.animate([{ ...frame, height: `${fromH}px` }, { ...frame, height: `${toH}px` }], { duration: 300, easing: SPRING });
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
    const html = promptModelHtml(a, kit.target?.(a));
    morphChip(el, html);
    el.setAttribute('aria-label', `${agentShortName(a)}: change model${hasEffort(a) ? ' or effort' : ''}`); // no tooltip, just for screen readers
    if (prev ? prev.nextElementSibling !== el : box.firstElementChild !== el) {
      if (prev) prev.after(el); else box.prepend(el);
    }
    prev = el;
  }
}
function onPromptModelClick(e: MouseEvent, kit: PromptKit = IDE_KIT): void {
  const chip = (e.target as HTMLElement).closest<HTMLElement>('.prompt-model:not(.leaving)');
  const ag = chip && appState.detect?.agents.find(x => x.id === chip.dataset.agent);
  if (!chip || !ag) return;
  const switchAgent = kit.switchAgent ?? ideSwitchAgent;
  openChipMenu(chip, modelPickerItems(ag, false, kit.target?.(ag), (to, m) => switchAgent(ag, to, m)));
  // The composer sits at the bottom of the window, so the menu opens upwards.
  const m = chip.classList.contains('open') ? $('#menuRoot .menu') : null;
  if (m) {
    const r = chip.getBoundingClientRect();
    m.style.left = `${Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8))}px`;
    m.style.top = `${Math.max(8, r.top - m.offsetHeight - 4)}px`;
    m.classList.add('up');
  }
}
// The Agents tab: an agent tagged in the prompt has its @mention swapped for the new one; with none tagged, the new
// agent becomes the default. Either way it gets the model picked.
// `ta`: the prompt the chip is under (an Agent board box's, for an agent tagged there).
function ideSwitchAgent(from: DetectedAgent, to: DetectedAgent, model: string, ta = SURFACES.ide.prompt): void {
  const text = ta.value;
  const names = agentMentionNames(from);
  const hits = mentionRanges(text).filter(([a, b]) => names.includes(text.slice(a + 1, b).toLowerCase()));
  if (!hits.length) { switchToAgentModel(to, model); return; }
  let out = text;
  for (const [a, b] of hits.reverse()) out = `${out.slice(0, a)}@${agentShortName(to)}${out.slice(b)}`;
  ta.value = out;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  background(applyModelAndEffort(to, model, agentEffort(to)));
}
$('#promptModels').addEventListener('click', e => onPromptModelClick(e));
// The prompt grows with its text, up to a cap, then scrolls.
const PROMPT_MAX_H = 200;
// While no agent is tagged, the send button sits beside the prompt rather than on a row of its own.
function fitPrompt(kit: PromptKit = IDE_KIT): void {
  const ta = kit.ta;
  const box = ta.closest('.composer-box') as HTMLElement;
  box.classList.remove('compact'); // every composer keeps its bottom row (composerui.ts)
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
function animatePromptHeight(kit: PromptKit, fromH: number): void {
  const ta = kit.ta;
  // The textarea's ResizeObserver fires on every frame of this animation; restarting it each time made it crawl
  // and never land (the box stuck tall after deleting lines). Same target: let it run.
  if (kit.anim?.playState === 'running' && kit.animH === ta.style.height) return;
  kit.anim?.cancel(); // read the end height without it (the start was read with it)
  const toH = ta.offsetHeight;
  if (Math.abs(toH - fromH) < 1) return;
  kit.animH = ta.style.height;
  kit.anim = ta.animate([{ height: `${fromH}px` }, { height: `${toH}px` }], { duration: 180, easing: SPRING });
}
/* ----- Grow: when a panel is squeezed or widened and text rewraps, blocks ease to their new height instead of
   jumping (the commit box going from one line to two, a note gaining a line). Only height animates: widths keep
   up with the sash as it is dragged. Boxes that size themselves as you type (textareas) ease too. ----- */
const GROW_SEL = 'textarea, button, .btn, p, h1, h2, h3, h4, label, .side-note, .scm-row, .commit, .card, .agent-card, .quick-card, .pill, .chip, .empty';
// Things with their own size animation, or that must never lag: the agent prompt, the code editors, terminals, menus,
// and the one-line rows of the file tree and search results (redrawn often, never rewrapped), and onboarding's
// ghosts (their copies resize every frame of a flight and must land exactly on the real piece).
const GROW_SKIP = '#prompt, .ta, .editor, .term-body, .menu, .suggest, .tabs, .term-tabs, .agent-tabs-bar, .agent-bar, #tree, #searchResults, .ob-ghost, [data-no-grow]';
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
  let budget = document.documentElement.classList.contains('win-resizing') ? 0 : GROW_PER_FRAME;
  // Border-box and clipped for the moment it runs, so padding counts and rewrapped text doesn't spill out.
  const frame = { boxSizing: 'border-box', overflow: 'hidden' };
  for (const p of sized) {
    if (Math.abs(p.to - p.from) < 1 || !p.onScreen || budget <= 0) { growState.set(p.el, { w: p.w, h: p.to }); continue; }
    budget--;
    const anim = p.el.animate([{ ...frame, height: `${p.from}px` }, { ...frame, height: `${p.to}px` }], { duration: 330, easing: SPRING });
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
function syncPromptHl(kit: PromptKit = IDE_KIT): void {
  const ta = kit.ta;
  const fromH = ta.getBoundingClientRect().height;
  renderPromptModels(kit);
  fitPrompt(kit);
  animatePromptHeight(kit, fromH);
  // A trailing newline needs a character after it, or the layer is a line short.
  kit.hl.innerHTML = mentionHtml(ta.value, kit.mentions, true) +(ta.value.endsWith('\n') ? ' ' : '');
  kit.hl.style.right = `${ta.offsetWidth - ta.clientWidth}px`; // clear of its scroll bar, if it shows one
  kit.hl.scrollTop = ta.scrollTop;
}
// Keeps a kit's layer, chips and height in step with its textarea (the Agents tab's below; each board box's in board.ts).
function wirePromptKit(kit: PromptKit): void {
  kit.ta.addEventListener('scroll', () => { kit.hl.scrollTop = kit.ta.scrollTop; });
  new ResizeObserver(() => syncPromptHl(kit)).observe(kit.ta);
  kit.models.addEventListener('click', e => onPromptModelClick(e, kit));
}
const IDE_KIT: PromptKit = { ta: SURFACES.ide.prompt, hl: promptHl, models: $('#promptModels'), picked: idePickedAgents, mentions: true, anim: null };
SURFACES.ide.prompt.addEventListener('scroll', () => { promptHl.scrollTop = SURFACES.ide.prompt.scrollTop; });
new ResizeObserver(() => syncPromptHl()).observe(SURFACES.ide.prompt);

// Once the skills are known, a "/skill" already typed turns blue.
void loadSlashSkills().then(() => { syncPromptHl(); });

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

// Improve prompt: the composer's agent rewrites the draft in place (one-shot agent:ask, as Explain uses). Ctrl+Z brings the original back.
const improvePromptText = (text: string): string =>
  'Rewrite the prompt below so a coding agent can act on it well. Keep the intent, the language it is written in, and every '
  + '@mention, file path, name and code snippet exactly. Make the goal, the constraints and what done looks like clear, and fix '
  + 'spelling. Do not invent requirements or answer it. Keep it concise. Reply with the rewritten prompt only: no preamble, '
  + `no quotes, no code fence around it. Do not use any tools.\n\nPrompt:\n${text.slice(0, 8000)}`;
const tidyImproved = (reply: string): string =>
  reply.trim().replace(/^```[\w-]*\n([\s\S]*?)\n```$/, '$1').replace(/^(rewritten prompt|prompt):\s*/i, '').replace(/^"([\s\S]*)"$/, '$1').trim();

async function improvePrompt(s: Surface, btn: HTMLButtonElement): Promise<void> {
  const ta = s.prompt, text = ta.value.trim();
  if (!text) { ta.focus(); return; }
  const agent = selectedAgent();
  if (!agent) { openAgentPicker(); return; }
  const tab = getActiveTab(s), before = ta.value;
  btn.disabled = true;
  btn.classList.add('busy');
  let reply = '';
  try { reply = tidyImproved(String(await api.agent.ask({ agent: agent.id, prompt: improvePromptText(text), model: chosenModelFor(agent) }) ?? '')); }
  catch (err) { toast(`Couldn’t improve the prompt: ${errMsg(err) || 'the agent didn’t answer'}`); }
  finally { btn.disabled = false; btn.classList.remove('busy'); }
  if (!reply) return;
  if (getActiveTab(s) !== tab || ta.value !== before) { toast('The prompt changed while it was being improved, so your edits were kept'); return; }
  ta.focus();
  ta.select();
  // insertText keeps the browser's undo stack and fires input, so the box grows and the draft saves as with typing.
  // Without focus (window in the background, box hidden) insertText "succeeds" but writes nothing.
  if (document.activeElement !== ta || !document.execCommand('insertText', false, reply)) { ta.value = reply; ta.dispatchEvent(new Event('input', { bubbles: true })); }
}

for (const s of Object.values(SURFACES)) {
  const improveBtn = s.prompt.closest('.composer-box')?.querySelector<HTMLButtonElement>('[data-improve-prompt]');
  if (improveBtn) improveBtn.onclick = () => void improvePrompt(s, improveBtn);
  s.send.onclick = () => {
    const tab = getActiveTab(s);
    if (tabBusy(tab)) stopAgent(tab);
    else void sendPrompt();
  };
  // Enter sends; while the agent works it adds to its task, and Ctrl+Enter queues (composerui.ts).
  s.prompt.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    if (submitWhileBusy(s, getActiveTab(s), e.ctrlKey || e.metaKey)) return;
    void sendPrompt();
  });

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

// Copy-paste image into agent tab (IDE aside/composer)
document.addEventListener('paste', async (e: ClipboardEvent) => {
  const items = e.clipboardData?.items;
  const filesList = e.clipboardData?.files;
  const imgItem = items ? [...items].find(it => it.type.startsWith('image/')) : null;
  const imgFile = !imgItem && filesList?.length ? [...filesList].find(x => x.type.startsWith('image/') || IMAGE_FILE.test(x.name)) : null;

  if (!imgItem && !imgFile) return;

  const target = e.target as HTMLElement | null;
  const activeEl = document.activeElement;
  // An Agent board box's prompt: the image goes to that box.
  const boardEl = (target?.closest?.('.board-composer') ?? activeEl?.closest?.('.board-composer'))?.closest<HTMLElement>('.board-box.filled');
  const boardS = boardEl?.dataset.box ? SURFACES[`board:${boardEl.dataset.box}`] : undefined;
  if (boardS) {
    const f = imgItem ? imgItem.getAsFile() : imgFile;
    if (!f) return;
    e.preventDefault();
    await addPastedImage(f, boardS);
    return;
  }
  if (activeEl?.classList.contains('ta') && !target?.closest('#agents, .composer')) return;

  const targetSurface = SURFACES.ide;
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
    // An SVG often has only a viewBox, no size of its own: in the shrink-to-fit viewer it collapses to nothing. It
    // gets the shape its thumbnail shows, scaled to fill the viewer, on the chat's own backdrop.
    const svg = /^data:image\/svg/i.test(full) || /\.svg(?:[?#]|$)/i.test(full);
    const box = img.getBoundingClientRect();
    const ratio = box.width > 0 && box.height > 0 ? box.width / box.height : 1;
    // Set through the DOM: the page's CSP (style-src 'self') drops a style="" attribute.
    const size = (m: HTMLElement) => {
      const view = m.querySelector<HTMLImageElement>('.img-modal-img');
      if (!svg || !view) return;
      view.style.aspectRatio = String(ratio);
      view.style.width = `min(85vw, calc(75vh * ${ratio}))`;
    };
    // Just the picture: no dialog panel or button. A click on it or beside it, or Esc, closes it.
    openModal(`<div class="img-modal-view"><img src="${escAttr(full)}" class="img-modal-img${svg ? ' svg' : ''}" alt="" title="Click to close" data-close></div>`, size);
  }
});

// Hook up new chat buttons to create new tabs
const newChatBtn = document.getElementById('newChat');
if (newChatBtn) newChatBtn.onclick = () => newAgentTabAction(SURFACES.ide);
$('#agentNewTab')?.addEventListener('click', () => newAgentTabAction(SURFACES.ide));
commands['chat.new'] = () => newAgentTabAction(surface);
commands['agent.stop'] = () => stopAgent();

function stopAgent(targetTab?: AgentTabState): void {
  const tab = targetTab || getActiveTab(surface);
  if (stopAgenticTask(tab)) return; // Stop on an agentic task cancels the whole task, not just its current step
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

  // @mentions split an IDE prompt between agents.
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
    saveDraft(s.prompt);
    mentionWarning(s);
    attachmentsMap[s.name] = [];
    renderAttachments(s);
  }
  tab.promptDraft = '';
  tab.attachments = [];
  dropAgentTeam(tab);

  if (tab.panel.querySelector('.empty')) tab.panel.innerHTML = '';

  if (/^Chat \d+$/i.test(tab.title) || tab.title === 'New chat') {
    setChatTitle(tab, text.replaceAll(/\s+/g, ' ').slice(0, 64) || 'Task', true);
    if (text) void nameChat(tab, text, agent.id);
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

