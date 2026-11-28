/* ----- Subagents: the step card lists the ones an agent started, and each opens its own chat in place of the main one ----- */
// What a subagent was asked, did and said. Kept while the window is open; a chat reopened later loses the list (dropLostSubs).
interface SubLine { kind: string; text: string; at: number }
interface SubChat {
  id: string;                 // its tool call's id
  title: string;
  prompt: string;
  who: { name: string; letter: string; tint: string }; // the agent that started it
  state: 'working' | 'done' | 'failed';
  latest: string;             // what it is doing now
  startedAt: number;
  lines: SubLine[];
}
const SUB_LINES_MAX = 400;
const SUB_CHATS_MAX = 200;
const subChats = new Map<string, SubChat>();
// The subagent chat open over each tab's own: its tab panel -> what is shown.
const subViews = new WeakMap<HTMLElement, { sub: SubChat; el: HTMLElement }>();

function addSubChat(ev: AgentEvent, who: SubChat['who']): SubChat {
  const sub: SubChat = { id: ev.id!, title: ev.text || 'Working on part of the task', prompt: ev.note ?? '', who, state: 'working', latest: 'Thinking', startedAt: Date.now(), lines: [] };
  subChats.set(sub.id, sub);
  if (subChats.size > SUB_CHATS_MAX) subChats.delete(subChats.keys().next().value!);
  return sub;
}
// Something it said or did: kept, shown on its row, and added to its chat when that is open.
function subSaid(sub: SubChat, ev: AgentEvent): void {
  const said = ev.kind === 'text';
  const text = (said ? ev.text : ev.label) ?? '';
  if (!text) return;
  sub.latest = said ? 'Writing a reply' : doing(text).split('\n')[0];
  addSubLine(sub, { kind: ev.kind ?? 'tool', text, at: Date.now() });
  document.querySelectorAll<HTMLElement>(`[data-sub-open="${CSS.escape(sub.id)}"] .sub-latest`).forEach(x => x.textContent = sub.latest);
}
function endSubChat(sub: SubChat, ok: boolean, report: string): void {
  sub.state = ok ? 'done' : 'failed';
  if (report) addSubLine(sub, { kind: 'text', text: report, at: Date.now() });
  eachSubView(sub, paintSubState);
}
function addSubLine(sub: SubChat, line: SubLine): void {
  sub.lines.push(line);
  if (sub.lines.length > SUB_LINES_MAX) sub.lines.shift();
  eachSubView(sub, (el, s) => {
    const scroller = subScroller(el);
    const atEnd = !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    $('.sub-live', el).insertAdjacentHTML('beforebegin', subLineHtml(s, line));
    paintSubState(el, s);
    if (scroller && atEnd) scroller.scrollTop = scroller.scrollHeight;
  });
}
function eachSubView(sub: SubChat, run: (el: HTMLElement, sub: SubChat) => void): void {
  document.querySelectorAll<HTMLElement>(`.sub-view[data-sub="${CSS.escape(sub.id)}"]`).forEach(el => run(el, sub));
}

/* The list in the step card */
function subsText(subs: SubChat[]): string {
  const working = subs.filter(s => s.state === 'working').length;
  if (!working) return `${plural(subs.length, 'subagent')} finished`;
  return `${plural(working, 'subagent')} working${subs.length > working ? ` · ${subs.length - working} finished` : ''}`;
}
const SUB_STATE = { working: 'Working', done: 'Done', failed: 'Stopped' } as const;
function subMark(s: SubChat['state']): string {
  const cls = s === 'working' ? 'in_progress' : s === 'done' ? 'completed' : 'failed';
  return `<span class="td-mark sub-mark ${cls}" aria-hidden="true">${s === 'working' ? '' : svgIcon(s === 'done' ? 'check' : 'x', 10)}</span>`;
}
function subListHtml(subs: SubChat[], open: boolean): string {
  const rows = subs.map(s => `<li><button class="sub-row" type="button" data-sub-open="${escAttr(s.id)}" title="Open this subagent’s chat">${subMark(s.state)}<span class="sub-name">${esc(s.title)}</span><span class="sub-latest">${esc(s.state === 'working' ? s.latest : SUB_STATE[s.state])}</span>${svgIcon('chevronRight', 12)}</button></li>`).join('');
  return `<div class="sub-drop"><button class="sub-toggle" type="button" aria-expanded="${open}"><span class="${subs.some(s => s.state === 'working') ? 'sub-busy' : ''}">${subsText(subs)}</span>${svgIcon('chevronDown', 12)}</button><ul class="sub-list">${rows}</ul></div>`;
}
// A chat brought back from history after a restart: its subagents' chats are gone, so their rows go too.
function dropLostSubs(root: Element): void {
  root.querySelectorAll<HTMLElement>('[data-sub-open]').forEach(b => { if (!subChats.has(b.dataset.subOpen ?? '')) b.closest('li')?.remove(); });
  root.querySelectorAll<HTMLElement>('.sub-drop').forEach(d => {
    if (d.querySelector('.sub-row')) return;
    const card = d.closest('.todo-card');
    if (card?.classList.contains('subagents-only')) card.remove();
    else d.remove();
  });
}

/* The subagent's own chat */
function subLineHtml(sub: SubChat, l: SubLine): string {
  if (l.kind !== 'text') return `<div class="tool-line ${l.kind}"><span class="ti">${svgIcon(TOOL_ICON[l.kind] ?? 'dot', 14)}</span><span class="tl">${esc(l.text)}</span></div>`;
  return `<div class="msg"><div class="meta">${brandMark('avatar mini', sub.who.tint, sub.who.letter)}<b>${esc(sub.who.name)} subagent</b> ${subClock(l.at)}</div><div class="body">${md(l.text)}</div></div>`;
}
const subClock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function subScroller(el: HTMLElement): HTMLElement | null {
  return el.parentElement;
}
function paintSubState(el: HTMLElement, sub: SubChat): void {
  $('.sub-view-state', el).textContent = SUB_STATE[sub.state];
  $('.sub-live', el).hidden = sub.state !== 'working';
  $('.sub-live .lbl', el).textContent = sub.latest;
}
function openSubChat(panel: HTMLElement, sub: SubChat): void {
  removeSubView(panel);
  const el = document.createElement('div');
  el.className = 'sub-view';
  el.dataset.sub = sub.id;
  const prompt = sub.prompt ? `<div class="msg user"><div class="meta"><b>${esc(sub.who.name)}</b> ${subClock(sub.startedAt)}</div><div class="body">${md(sub.prompt)}</div></div>` : '';
  el.innerHTML = `<div class="sub-view-head"><button class="btn btn-ghost btn-sm sub-back" type="button" title="Back to the main chat (Esc)">${svgIcon('chevronLeft', 14)}<span>Back</span></button><b class="sub-view-title">${esc(sub.title)}</b><span class="sub-view-state"></span></div>${prompt}${sub.lines.map(l => subLineHtml(sub, l)).join('')}<div class="sub-live" role="status">${brandMark('avatar mini', sub.who.tint, sub.who.letter)}<span class="lbl"></span></div>`;
  paintSubState(el, sub);
  panel.classList.add('viewing-sub');
  panel.after(el);
  subViews.set(panel, { sub, el });
  const back = $<HTMLButtonElement>('.sub-back', el);
  const close = () => {
    removeSubView(panel);
    const s = Object.values(SURFACES).find(x => x.chat === panel.parentElement);
    if (s) scrollChat(s);
    panel.querySelector<HTMLElement>(`[data-sub-open="${CSS.escape(sub.id)}"]`)?.focus({ preventScroll: true });
  };
  back.onclick = close;
  el.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  });
  const scroller = subScroller(el);
  if (scroller) scroller.scrollTop = sub.state === 'working' ? scroller.scrollHeight : 0;
  back.focus({ preventScroll: true });
}
function removeSubView(panel: HTMLElement): void {
  subViews.get(panel)?.el.remove();
  subViews.delete(panel);
  panel.classList.remove('viewing-sub');
}
// Back to the main chat: it needs the person, a message was sent, or its tab is closing.
function closeSubChat(tab: AgentTabState): void {
  if (!subViews.has(tab.panel)) return;
  removeSubView(tab.panel);
  const s = SURFACES[tab.surfaceName];
  if (s && tab.id === activeTabId[tab.surfaceName]) scrollChat(s);
}

document.addEventListener('click', e => {
  const t = e.target as HTMLElement;
  const toggle = t.closest<HTMLElement>('.sub-toggle');
  if (toggle) {
    const scroller = subScroller(toggle.closest<HTMLElement>('.agent-tab-panel') ?? toggle);
    const atEnd = !!scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    toggle.setAttribute('aria-expanded', String(toggle.getAttribute('aria-expanded') !== 'true'));
    if (scroller && atEnd) scroller.scrollTop = scroller.scrollHeight; // the line saying what the agent is doing stays in view
    return;
  }
  const row = t.closest<HTMLElement>('[data-sub-open]');
  const panel = row?.closest<HTMLElement>('.agent-tab-panel');
  const sub = row && subChats.get(row.dataset.subOpen ?? '');
  if (panel && sub) openSubChat(panel, sub);
});
