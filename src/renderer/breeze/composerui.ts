/* ================= Composer: the one prompt-box layout every agent prompt shares ================= */
// Home, the Agents panel, Breeze Space and each Agent board box draw the same box (breeze.html, board.ts):
//   [+] [paperclip] [access ▾] ……… [model ▾] [mic] (↑)
//   folder · Local · branch ……………………… usage limit ▭ 28%
// This file wires the buttons and fills the line under the box. Each composer registers once with wireComposer;
// refreshComposers redraws every line when what they show changes (branch, folder, access, the plan's usage).

interface Composer {
  box: HTMLElement;                          // the .composer-box
  meta: HTMLElement;                         // the .cmp-meta line under it
  surface?: Surface;                         // its chat surface; Home has none (it sends through the Agents panel)
  agent?: () => string | null | undefined;   // the agent it sends to, whose plan usage the meter shows; the chosen agent by default
  folder?: () => string | null;              // the folder it sends to; the open project by default
  attach: (files: File[]) => void;
  skills?: boolean;                          // "/skill" works here (not on Home, which hands the text to the panel)
  send?: () => Promise<void>;                // sends what is in the prompt (a queued message goes out through it)
  tab?: () => AgentTabState | undefined;     // the chat it sends to; the surface's active tab by default
}
const composers: Composer[] = [];

const composerTab = (c: Composer) => (c.tab ? c.tab() : c.surface ? getActiveTab(c.surface) : undefined);
const composerOf = (s: Surface) => composers.find(c => c.surface === s);
const composerAgent = (c: Composer) => (c.agent ? c.agent() : selectedAgent()?.id ?? appState.agent);
const composerFolder = (c: Composer) => (c.folder ? c.folder() : rootInfo?.root ?? null);

// A composer sits at the bottom of its page, so its menus open upwards from the button.
function composerMenu(btn: HTMLElement, items: MenuItem[]): void {
  if (menuWasOpen(btn)) { closeMenu(); return; }
  closeMenu();
  btn.classList.add('open');
  const r = btn.getBoundingClientRect();
  popupMenu(r.left, r.top - 8, items, () => btn.classList.remove('open'), btn);
  const m = $('#menuRoot .menu');
  if (!m) return;
  m.classList.add('up');
  m.style.left = `${Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8))}px`;
  m.style.top = `${Math.max(8, r.top - m.offsetHeight - 6)}px`;
}

// Types `text` where the caret is, with a space before it when it would run into a word, as typing would.
function insertAtCaret(ta: HTMLTextAreaElement, text: string): void {
  ta.focus();
  const before = ta.value.slice(0, ta.selectionStart);
  const add = (before && !/\s$/.test(before) ? ' ' : '') + text;
  if (!document.execCommand('insertText', false, add)) {
    ta.setRangeText(add, ta.selectionStart, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

const ACCESS_TIP = {
  on: 'Full access: agents can run any command and edit files anywhere on this computer. Click to change.',
  off: 'Project only: agents stay in this folder, keep out of .env and .git, and Codex runs sandboxed. Click to change.',
};

function wireComposer(c: Composer): void {
  composers.push(c);
  paintIcons(c.box);
  paintIcons(c.meta);
  const ta = $<HTMLTextAreaElement>('textarea', c.box);
  const plus = $<HTMLButtonElement>('.cmp-plus', c.box);
  const pick = $<HTMLInputElement>('.cmp-attach-pick', c.box);
  $('.cmp-attach', c.box).onclick = () => pick.click();
  pick.onchange = () => {
    const files = [...(pick.files ?? [])];
    pick.value = ''; // picking the same file again still fires
    if (files.length) c.attach(files);
  };
  plus.onclick = () => {
    const items: MenuItem[] = [
      { label: 'Attach photos or files', icon: svgIcon('paperclip', 14), run: () => pick.click() },
      { label: 'Mention a file or agent', icon: svgIcon('atSign', 14), key: '@', run: () => insertAtCaret(ta, '@') },
    ];
    if (c.skills !== false) items.push({ label: 'Use a skill', icon: svgIcon('sparkles', 14), key: '/', run: () => insertAtCaret(ta, '/') });
    const s = c.surface;
    if (s) {
      items.push({ sep: true }, {
        label: 'Improve prompt', icon: svgIcon('pencil', 14),
        enabled: () => !!ta.value.trim() && !plus.classList.contains('busy'),
        run: () => void improvePrompt(s, plus),
      });
    }
    composerMenu(plus, items);
  };
  const perm = $<HTMLButtonElement>('.cmp-perm', c.box);
  perm.onclick = () => composerMenu(perm, [
    { label: 'Full access', icon: svgIcon('shield', 14), key: 'run anything', checked: () => agentFullAccess, run: () => { setFullAccess(true); refreshComposers(); } },
    { label: 'Project only', icon: svgIcon('shieldCheck', 14), key: 'this folder', checked: () => !agentFullAccess, run: () => { setFullAccess(false); refreshComposers(); } },
  ]);
  // The usage meter's arrow opens a bar for every plan window (the 5-hour one, the week's), not just the tightest.
  // The bar, the % and the arrow are one button, so the whole meter is the hitbox.
  const meterEl = $('.cmp-ctx', c.meta);
  meterEl.insertAdjacentHTML('beforebegin', `<button type="button" class="cmp-ctx-more hidden" aria-label="Show all usage limits" aria-haspopup="menu"></button>`);
  const more = $<HTMLButtonElement>('.cmp-ctx-more', c.meta);
  more.append(meterEl);
  more.insertAdjacentHTML('beforeend', svgIcon('chevronDown', 12));
  more.onclick = () => {
    const id = composerAgent(c);
    const wins = (id && agentUsage?.limits[id]) || [];
    if (!wins.length) return;
    composerMenu(more, [{ label: 'Usage limits', enabled: () => false }]);
    const m = $('#menuRoot .menu');
    if (!m || !more.classList.contains('open')) return; // the click closed it
    const name = appState.detect?.agents.find(a => a.id === id)?.name ?? 'Agent';
    m.classList.add('cmp-usage-menu');
    m.innerHTML = `<div class="cmp-usage-head">${esc(name)} usage</div>` + wins.map(w => {
      const pct = Math.max(0, Math.min(100, Math.round(w.used)));
      return `<div class="cmp-usage-row${pct >= 80 ? ' high' : ''}"><span class="lbl">${esc(w.label)}</span><span class="cmp-ctx-bar"><i data-w="${pct}"></i></span><span class="pct">${pct}%</span>${w.resetsAt ? `<small>resets ${esc(resetText(w.resetsAt))}</small>` : ''}</div>`;
    }).join('');
    // The CSP blocks inline style attributes; the fill's colour follows what's left (breeze.css).
    $$<HTMLElement>('.cmp-ctx-bar i', m).forEach(i => { i.style.width = `${i.dataset.w}%`; i.style.setProperty('--usage-left', String(100 - Number(i.dataset.w))); });
    const r = more.getBoundingClientRect();
    m.style.left = `${Math.max(8, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 8))}px`;
    m.style.top = `${Math.max(8, r.top - m.offsetHeight - 6)}px`;
  };
  const mic = $<HTMLButtonElement>('.cmp-mic', c.box);
  // Voice typing is Windows' own; elsewhere the system's dictation already types into the box.
  mic.hidden = !/Windows/.test(navigator.userAgent);
  mic.onclick = () => {
    ta.focus();
    background(api.win.dictate().then(ok => { if (!ok) toast('Voice typing isn’t available here. Use your system’s dictation instead.'); }));
  };
  // One made after start-up (a board box) paints at once; the first ones wait for git.js and settings.js to run.
  if (composersReady) paintComposer(c);
}
let composersReady = false;

/* ----- A second message while the agent works -----
   Enter adds it to the task the agent is on (Claude Code takes it mid-task; agent:steer in main). Ctrl+Enter, or an
   agent that can't take one mid-task, queues it instead: it waits above the prompt and goes out as the next message
   when the agent finishes. Stop keeps the queue; the next finish sends it. */
interface QueuedMsg { text: string; attachments: AgentAttachment[] }

// The prompt's Enter: true when it was handled here (the agent is working); false sends it the usual way.
function submitWhileBusy(s: Surface, tab: AgentTabState, queueIt: boolean, busy = tabBusy(tab)): boolean {
  if (!busy) return false;
  const text = s.prompt.value.trim();
  const attachments = [...(attachmentsMap[s.name] || [])];
  if (!text && !attachments.length) return true;
  s.prompt.value = '';
  s.prompt.dispatchEvent(new Event('input', { bubbles: true }));
  attachmentsMap[s.name] = [];
  renderAttachments(s);
  tab.promptDraft = '';
  tab.attachments = [];
  const msg: QueuedMsg = { text, attachments };
  if (queueIt || !(tab.runId && tab.runId > 0)) { enqueueMsg(tab, msg); return true; }
  const body = withAttachments(attachmentHeaders(attachments), text);
  background(api.agent.steer(tab.runId, body).then(ok => {
    if (!ok) {
      enqueueMsg(tab, msg);
      // Claude refuses one only once its turn is over; the others never take one mid-task.
      const id = tab.run?.agent ?? tab.agentId;
      const who = appState.detect?.agents.find(a => a.id === id)?.name ?? 'This agent';
      toast(id === 'claude' ? `${who} is wrapping up, so your message is queued as the next one` : `${who} can’t take a message mid-task, so it’s queued for when it finishes`);
      return;
    }
    sfx.play('send');
    userMsg(text, attachments, tab);
    const last = tab.panel.querySelectorAll('.msg.user');
    last[last.length - 1]?.classList.add('steered');
  }));
  return true;
}

function enqueueMsg(tab: AgentTabState, m: QueuedMsg): void {
  (tab.queue ??= []).push(m);
  renderQueue(tab);
}

// The queued messages, above the prompt of the chat they belong to: each can come back to the prompt or go.
function renderQueue(tab: AgentTabState): void {
  const s = SURFACES[tab.surfaceName];
  const c = s && composerOf(s);
  if (!c || composerTab(c) !== tab) return;
  let strip = c.box.querySelector<HTMLElement>('.cmp-queue');
  const list = tab.queue ?? [];
  if (!list.length) { strip?.remove(); return; }
  if (!strip) {
    strip = document.createElement('div');
    strip.className = 'cmp-queue';
    strip.setAttribute('aria-label', 'Queued messages');
    c.box.prepend(strip);
    strip.addEventListener('click', e => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-q]');
      const t = composerTab(c);
      if (!btn || !t?.queue) return;
      const i = Number(btn.dataset.i);
      const [m] = t.queue.splice(i, 1);
      if (m && btn.dataset.q === 'edit') {
        // Back in the prompt, after anything typed there already.
        s.prompt.value = [s.prompt.value.trim(), m.text].filter(Boolean).join('\n');
        s.prompt.dispatchEvent(new Event('input', { bubbles: true }));
        attachmentsMap[s.name] = [...(attachmentsMap[s.name] || []), ...m.attachments];
        renderAttachments(s);
        s.prompt.focus();
      }
      renderQueue(t);
    });
  }
  strip.innerHTML = `<div class="cmp-queue-head">${svgIcon('clock', 12)}<span>Queued · sends when the agent finishes</span></div>`
    + list.map((m, i) => `<div class="cmp-queue-item"><span class="cmp-queue-text">${esc(m.text || m.attachments.map(a => a.name).join(', '))}</span>`
      + (m.attachments.length ? `<span class="cmp-queue-att">${svgIcon('paperclip', 11)}${m.attachments.length}</span>` : '')
      + `<button type="button" class="icon-btn" data-q="edit" data-i="${i}" title="Edit: move it back to the prompt" aria-label="Edit queued message">${svgIcon('pencil', 12)}</button>`
      + `<button type="button" class="icon-btn" data-q="drop" data-i="${i}" title="Remove from the queue" aria-label="Remove queued message">${svgIcon('x', 12)}</button></div>`).join('');
}

// The next queued message goes out once the chat is free and on screen where it can be sent. Whatever is being typed
// in the prompt meanwhile stays there.
let flushing = false;
async function flushQueue(tab: AgentTabState): Promise<void> {
  const s = SURFACES[tab.surfaceName];
  const c = s && composerOf(s);
  if (flushing || !c?.send || !tab.queue?.length || tabBusy(tab) || composerTab(c) !== tab) return;
  if (!s.name.startsWith('board:') && s !== surface) return; // sendPrompt sends from the surface on screen
  flushing = true;
  const m = tab.queue.shift()!;
  renderQueue(tab);
  const draft = s.prompt.value, draftAtt = attachmentsMap[s.name] || [];
  s.prompt.value = m.text;
  attachmentsMap[s.name] = m.attachments;
  try { await c.send(); } finally { flushing = false; }
  // A send empties the prompt. Still there (no agent picked, say): it goes back to the front of the queue.
  if (s.prompt.value === m.text && (m.text || m.attachments.length)) { tab.queue.unshift(m); renderQueue(tab); }
  s.prompt.value = draft;
  attachmentsMap[s.name] = draftAtt;
  renderAttachments(s);
  s.prompt.dispatchEvent(new Event('input', { bubbles: true }));
}

function paintComposer(c: Composer): void {
  // Access: one setting for every agent (Settings → Agents → Full access), shown on every composer.
  const perm = $<HTMLButtonElement>('.cmp-perm', c.box);
  const label = agentFullAccess ? 'Full access' : 'Project only';
  const lab = $('.cmp-perm-label', perm);
  if (lab.textContent !== label) lab.textContent = label;
  perm.title = agentFullAccess ? ACCESS_TIP.on : ACCESS_TIP.off;
  perm.classList.toggle('limited', !agentFullAccess);

  // Folder: a composer that owns its folder chip (Home, Breeze Space) names it itself.
  const dir = composerFolder(c);
  const name = c.meta.querySelector<HTMLElement>('.cmp-folder-name');
  if (name) {
    const text = rootInfo ? rootInfo.name : 'No folder';
    if (name.textContent !== text) name.textContent = text;
    name.parentElement!.title = rootInfo ? `Agents work in ${rootInfo.root}` : 'No folder open';
  }

  // Branch: the open project's, so only where this composer sends to that project.
  const br = $('.cmp-branch', c.meta);
  const showBranch = !!rootInfo && !!gitState.repo && dir === rootInfo.root;
  br.classList.toggle('hidden', !showBranch);
  if (showBranch) {
    const b = gitState.branch || 'main';
    const bn = $('.cmp-branch-name', br);
    if (bn.textContent !== b) bn.textContent = b;
    br.title = `On branch ${b}`;
  }

  // Usage: how much of its plan's limit the agent has used, by its tightest window (the 5-hour one, the week's),
  // as Settings → Agents shows it. Hidden for an agent with no plan limit (a local model, an API key).
  const meter = $('.cmp-ctx', c.meta);
  const id = composerAgent(c);
  const wins = (id && agentUsage?.limits[id]) || [];
  meter.classList.toggle('hidden', !wins.length);
  $('.cmp-ctx-more', c.meta).classList.toggle('hidden', !wins.length);
  if (wins.length) {
    const tight = wins.reduce((a, w) => (w.used > a.used ? w : a));
    const pct = Math.max(0, Math.min(100, Math.round(tight.used)));
    const fill = $<HTMLElement>('.cmp-ctx-bar i', meter);
    fill.style.width = `${pct}%`;
    fill.style.setProperty('--usage-left', String(100 - pct));
    $('.cmp-ctx-pct', meter).textContent = `${pct}%`;
    meter.setAttribute('aria-valuenow', String(pct));
    const name = appState.detect?.agents.find(a => a.id === id)?.name ?? 'This agent';
    meter.title = `${name} usage limit used\n` + wins.map(w => `${w.label}: ${Math.round(w.used)}% used${w.resetsAt ? ` · resets ${resetText(w.resetsAt)}` : ''}`).join('\n');
    meter.classList.toggle('high', pct >= 80);
  }
}

function refreshComposers(): void {
  for (let i = composers.length - 1; i >= 0; i--) {
    const c = composers[i];
    // A hidden page's composer is still in the page and repaints; only an emptied board box's has left it.
    if (!c.box.isConnected) { composers.splice(i, 1); continue; }
    paintComposer(c);
  }
}

// The Agents panel and Breeze Space; Home registers in homedock.ts and each board box in board.ts.
for (const s of [SURFACES.ide, SURFACES.box]) {
  const box = s.prompt.closest<HTMLElement>('.composer-box')!;
  wireComposer({ box, meta: box.parentElement!.querySelector<HTMLElement>('.cmp-meta')!, surface: s, send: () => sendPrompt(), attach: files => background(attachFilesToAgent(files, s)) });
}
// After every script has run (git.js and settings.js own what the line shows).
// Plan usage, fetched when the app starts, after each run, and when the window comes back (at most every 30 s).
let composerUsageAt = 0;
function refreshComposerUsage(force = false): void {
  if (!force && Date.now() - composerUsageAt < 30_000) return;
  composerUsageAt = Date.now();
  background(api.agent.usage().then(u => { agentUsage = u; refreshComposers(); }));
}
window.addEventListener('focus', () => refreshComposerUsage());
document.addEventListener('DOMContentLoaded', () => { composersReady = true; refreshComposers(); refreshComposerUsage(true); });
