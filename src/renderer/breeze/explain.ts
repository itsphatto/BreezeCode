/* ================= Explain with Agents ================= */
// Right-click selected code → Explain with Agents: a card at the click shows the active agent's explanation.
// It is a one-shot, read-only question (agent:ask, as the conflict Duel uses): nothing goes to the Agents tab.

const explainEl = document.createElement('div');
explainEl.className = 'explain-card hidden';
explainEl.setAttribute('role', 'dialog');
explainEl.setAttribute('aria-label', 'Explanation');
document.body.append(explainEl);
let explainSeq = 0;      // the newest request; an older reply is dropped
let explainText = '';    // the reply, for Copy
let explainRetry: (() => void) | null = null;
let explainAt = { x: 0, y: 0 };
let explainDraft = '';   // what Ask puts in the new agent chat's message box

// Ask: a follow-up goes to a new chat in the Agents panel, with the code already in its message box.
function askAboutExplained(): void {
  const draft = explainDraft;
  closeExplain();
  if (!layout.agentsOpen) run('view.toggleAgents');
  newAgentTabAction(SURFACES.ide);
  const p = SURFACES.ide.prompt;
  p.value = draft;
  p.dispatchEvent(new Event('input', { bubbles: true })); // grows the box and saves the draft, as typing does
  // An Agents panel that was closed is still sliding open, and can't take focus yet: try each frame, for up to a second.
  const until = performance.now() + 1000;
  const focusBox = (): void => {
    if (!p.isConnected || p.value !== draft) return; // the user moved on
    p.focus();
    p.setSelectionRange(draft.length, draft.length);
    p.scrollTop = p.scrollHeight;
    if (document.activeElement !== p && performance.now() < until) requestAnimationFrame(focusBox);
  };
  focusBox();
}

function closeExplain(): void {
  explainSeq++;
  explainRetry = null;
  explainEl.classList.add('hidden');
}

function placeExplain(): void {
  const { left, top } = placeCard(explainAt.x, explainAt.y, explainEl.offsetWidth, explainEl.offsetHeight, innerWidth, innerHeight);
  explainEl.style.left = `${left}px`;
  explainEl.style.top = `${top}px`;
}

function paintExplain(head: { agent: string; where: string }, body: string, done: boolean): void {
  explainEl.innerHTML = `<div class="explain-head"><span class="explain-ico">${svgIcon('sparkles', 14)}</span>`
    + `<b>${esc(head.agent)}</b><span class="explain-where">Explain · ${esc(head.where)}</span>`
    + `<button class="explain-ask" data-explain="ask" title="Ask a follow-up in a new agent chat">${svgIcon('send', 12)}<span>Ask</span></button>`
    + `<button class="icon-btn" data-explain="copy" title="Copy explanation"${done ? '' : ' disabled'}>${svgIcon('copy', 14)}</button>`
    + `<button class="icon-btn" data-explain="close" title="Close (Esc)">${svgIcon('x', 14)}</button></div>`
    + `<div class="explain-body">${body}</div>`;
  explainEl.classList.remove('hidden');
  placeExplain();
}

function explainSelection(x: number, y: number): void {
  const b = activeText();
  if (!b) return;
  const { selectionStart: s, selectionEnd: e } = b.ta;
  if (s === e) return;
  const agent = currentActiveAgent();
  if (!agent) { openAgentPicker(); return; }
  const text = b.ta.value;
  const ctx = explainContext(text, s, e);
  const where = ctx.first === ctx.last ? `line ${ctx.first}` : `lines ${ctx.first}–${ctx.last}`;
  const prompt = explainPrompt({ path: b.path, lang: langOf(b.path)[1], first: ctx.first, last: ctx.last, code: text.slice(s, e), before: ctx.before, after: ctx.after });
  const model = chosenModelFor(agent);
  const head = { agent: agent.name, where };
  explainDraft = askDraft({ path: b.path, first: ctx.first, last: ctx.last, code: text.slice(s, e) });
  explainAt = { x, y };
  const run = async (): Promise<void> => {
    const seq = ++explainSeq;
    explainText = '';
    explainRetry = null;
    paintExplain(head, '<div class="explain-wait"><span></span><span></span><span></span> Explaining…</div>', false);
    let reply = '', failed = '';
    try { reply = String(await api.agent.ask({ agent: agent.id, prompt, model }) ?? '').trim(); } catch (err) { failed = errMsg(err) || 'The agent didn’t answer'; }
    if (seq !== explainSeq) return; // closed, or a newer explain started
    if (!failed && !reply) failed = 'The agent wrote no reply';
    if (failed) {
      explainRetry = () => void run();
      paintExplain(head, `<div class="explain-fail">${esc(failed)}</div><button class="btn btn-sm" data-explain="retry">${svgIcon('rotateCcw', 13)} Retry</button>`, false);
      return;
    }
    explainText = reply;
    paintExplain(head, md(tidyExplain(reply)), true);
  };
  void run();
}

explainEl.addEventListener('click', e => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-explain]');
  if (!btn) return;
  const act = btn.dataset.explain;
  if (act === 'close') closeExplain();
  else if (act === 'ask') askAboutExplained();
  else if (act === 'retry') explainRetry?.();
  else if (act === 'copy' && explainText) {
    navigator.clipboard.writeText(explainText).then(() => {
      void setIcon(btn, 'check');
      setTimeout(() => void setIcon(btn, 'copy'), 1400);
    }, () => toast('Couldn’t copy to the clipboard'));
  }
});
// A click anywhere else, or Esc, closes it. Capture: the editor stops some events before they bubble.
document.addEventListener('mousedown', e => {
  if (!explainEl.classList.contains('hidden') && !explainEl.contains(e.target as Node) && !(e.target as HTMLElement).closest('.menu')) closeExplain();
}, true);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !explainEl.classList.contains('hidden')) { e.stopPropagation(); closeExplain(); }
}, true);
addEventListener('resize', () => { if (!explainEl.classList.contains('hidden')) placeExplain(); });

// Right-click in the code editor.
$('#editor .code').addEventListener('contextmenu', e => {
  const b = activeText();
  if (!b) return;
  e.preventDefault();
  const { clientX: x, clientY: y } = e;
  popupMenu(x, y, [
    { label: 'Explain with Agents', icon: svgIcon('sparkles', 14), enabled: () => b.ta.selectionStart !== b.ta.selectionEnd, run: () => explainSelection(x, y) },
  ]);
});
