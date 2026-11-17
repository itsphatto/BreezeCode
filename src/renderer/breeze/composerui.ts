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
}
const composers: Composer[] = [];

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
  if (wins.length) {
    const tight = wins.reduce((a, w) => (w.used > a.used ? w : a));
    const pct = Math.max(0, Math.min(100, Math.round(tight.used)));
    $<HTMLElement>('.cmp-ctx-bar i', meter).style.width = `${pct}%`;
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
  wireComposer({ box, meta: box.parentElement!.querySelector<HTMLElement>('.cmp-meta')!, surface: s, attach: files => background(attachFilesToAgent(files, s)) });
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
