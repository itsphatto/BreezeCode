/* ================= Composer: the one prompt-box layout every agent prompt shares ================= */
// Home, the Agents panel and each Agent board box draw the same box (breeze.html, board.ts):
//   [+] [access ▾] ……… [model ▾] [mic] (↑)
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

function wireComposer(c: Composer): void {
  composers.push(c);
  paintIcons(c.box);
  paintIcons(c.meta);
  const ta = $<HTMLTextAreaElement>('textarea', c.box);
  const plus = $<HTMLButtonElement>('.cmp-plus', c.box);
  const pick = $<HTMLInputElement>('.cmp-attach-pick', c.box);
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
  // Voice typing is local Whisper; where it can't run (the browser build, non-Windows) the system's dictation still works.
  mic.hidden = true;
  api.dictate.status().then(s => { mic.hidden = !s.supported; }).catch(() => { /* stays hidden */ });
  mic.onclick = () => void toggleVoice(mic, ta);
  // One made after start-up (a board box) paints at once; the first ones wait for git.js and settings.js to run.
  if (composersReady) paintComposer(c);
}
let composersReady = false;

/* ----- Voice typing -----
   Click the mic to talk, click again (or Enter / Escape) to stop. The page records 16 kHz mono and main runs Whisper on
   it locally; the words land at the caret. The first click downloads Whisper once (about 200 MB). */
interface VoiceTake { mic: HTMLButtonElement; ta: HTMLTextAreaElement; stop: () => Promise<Float32Array>; cancel: () => void }
let voice: VoiceTake | null = null;
let voiceInstalling: Promise<void> | null = null;
const VOICE_RATE = 16000;

async function toggleVoice(mic: HTMLButtonElement, ta: HTMLTextAreaElement): Promise<void> {
  if (mic.classList.contains('busy')) return;
  if (voice) { const same = voice.mic === mic; await finishVoice(); if (same) return; }
  try {
    const s = await api.dictate.status();
    if (!s.ready) { await installVoice(mic); return; }
    voice = await startVoice(mic, ta);
  } catch (e) { setMic(mic, 'idle'); toast(voiceError(e)); }
}

function setMic(mic: HTMLButtonElement, state: 'idle' | 'recording' | 'busy', title?: string): void {
  mic.classList.toggle('recording', state === 'recording');
  mic.classList.toggle('busy', state === 'busy');
  mic.setAttribute('aria-pressed', String(state === 'recording'));
  mic.title = title ?? (state === 'recording' ? 'Stop and type it (Enter)' : state === 'busy' ? 'Writing it out…' : 'Voice typing');
}

function installVoice(mic: HTMLButtonElement): Promise<void> {
  if (voiceInstalling) return voiceInstalling;
  toast('Setting up voice typing: a one-time 200 MB download. It runs on your PC after that.');
  setMic(mic, 'busy', 'Downloading voice typing…');
  const off = api.dictate.onProgress(p => {
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    mic.title = `Downloading voice typing… ${pct}%`;
  });
  voiceInstalling = api.dictate.install()
    .then(() => toast('Voice typing is ready. Click the mic and talk.'))
    .finally(() => { off(); setMic(mic, 'idle'); voiceInstalling = null; });
  return voiceInstalling;
}

async function startVoice(mic: HTMLButtonElement, ta: HTMLTextAreaElement): Promise<VoiceTake> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  // The context resamples the mic to 16 kHz, the rate Whisper wants.
  const ctx = new AudioContext({ sampleRate: VOICE_RATE });
  const src = ctx.createMediaStreamSource(stream);
  // ScriptProcessor needs no worklet module, which the page's CSP would have to allow.
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  node.onaudioprocess = e => { chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
  src.connect(node);
  node.connect(ctx.destination);
  const close = () => {
    node.disconnect(); src.disconnect();
    stream.getTracks().forEach(t => t.stop());
    void ctx.close();
    document.removeEventListener('keydown', keys, true);
  };
  // Enter stops and types it; Escape throws it away. Both are kept from the prompt, so Enter doesn't send.
  const keys = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { voice?.cancel(); voice = null; } else void finishVoice();
  };
  document.addEventListener('keydown', keys, true);
  setMic(mic, 'recording');
  ta.focus();
  return {
    mic, ta,
    stop: async () => {
      close();
      const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of chunks) { out.set(c, at); at += c.length; }
      return out;
    },
    cancel: () => { close(); setMic(mic, 'idle'); },
  };
}

async function finishVoice(): Promise<void> {
  const take = voice;
  if (!take) return;
  voice = null;
  const samples = await take.stop();
  // Under about a third of a second is a stray click, not speech.
  if (samples.length < VOICE_RATE / 3) { setMic(take.mic, 'idle'); return; }
  setMic(take.mic, 'busy');
  try {
    const text = await api.dictate.transcribe(encodeWav(samples, VOICE_RATE));
    if (text) insertAtCaret(take.ta, text);
    else toast('Didn’t catch that. Try again a little closer to the mic.');
  } catch (e) { toast(voiceError(e)); } finally { setMic(take.mic, 'idle'); take.ta.focus(); }
}

function voiceError(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError') return 'Breeze can’t use the microphone. Allow it in Windows Settings › Privacy › Microphone.';
  if (name === 'NotFoundError') return 'No microphone found.';
  return errMsg(e);
}

// 16-bit PCM mono WAV.
function encodeWav(samples: Float32Array, rate: number): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (at: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

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

// Its line's parts come and go and change their words as a morph (ui.ts), once ui.js has loaded: an early repaint
// (an answer arriving while the page still loads) just sets them.
const cmpShow = (el: HTMLElement, on: boolean) => composersReady ? morphShow(el, on) : el.classList.toggle('hidden', !on);
const cmpText = (el: HTMLElement, text: string) => { if (composersReady) swapText(el, text); else el.textContent = text; };
function paintComposer(c: Composer): void {
  // Folder: a composer that owns its folder chip (Home) names it itself.
  const dir = composerFolder(c);
  const name = c.meta.querySelector<HTMLElement>('.cmp-folder-name');
  if (name) {
    const text = rootInfo ? rootInfo.name : 'No folder';
    cmpText(name, text);
    name.parentElement!.title = rootInfo ? `Agents work in ${rootInfo.root}` : 'No folder open';
  }

  // Branch: the open project's, so only where this composer sends to that project.
  const br = $('.cmp-branch', c.meta);
  const showBranch = !!rootInfo && !!gitState.repo && dir === rootInfo.root;
  if (showBranch) {
    const b = gitState.branch || 'main';
    cmpText($('.cmp-branch-name', br), b);
    br.title = `On branch ${b}`;
  }
  cmpShow(br, showBranch);

  // Usage: how much of its plan's limit the agent has used. Claude shows its 5-hour window; other agents show their
  // tightest window (the arrow lists every one). Hidden for an agent with no plan limit (a local model, an API key).
  const meter = $('.cmp-ctx', c.meta);
  const id = composerAgent(c);
  const wins = (id && agentUsage?.limits[id]) || [];
  cmpShow(meter, !!wins.length);
  cmpShow($('.cmp-ctx-more', c.meta), !!wins.length);
  if (wins.length) {
    const tight = (id === 'claude' && wins.find(w => w.label === '5-hour')) || wins.reduce((a, w) => (w.used > a.used ? w : a));
    const pct = Math.max(0, Math.min(100, Math.round(tight.used)));
    const fill = $<HTMLElement>('.cmp-ctx-bar i', meter);
    fill.style.width = `${pct}%`;
    fill.style.setProperty('--usage-left', String(100 - pct));
    cmpText($('.cmp-ctx-pct', meter), `${pct}%`);
    meter.setAttribute('aria-valuenow', String(pct));
    const name = appState.detect?.agents.find(a => a.id === id)?.name ?? 'This agent';
    meter.title = `${name} usage limit used\n` + wins.map(w => `${w.label}: ${Math.round(w.used)}% used${w.resetsAt ? ` · resets ${resetText(w.resetsAt)}` : ''}`).join('\n');
    meter.classList.toggle('high', pct >= 80);
  }
}

function refreshComposers(): void {
  for (let i = composers.length - 1; i >= 0; i--) {
    const c = composers[i];
    // A hidden page's composer is still in the page and repaints. A closed board box's has left it: gone for good,
    // unless its agent is still working out of sight (board.ts parkedBoxes), whose queue goes out through it.
    if (!c.box.isConnected && !parkedTab(composerTab(c))) { composers.splice(i, 1); continue; }
    paintComposer(c);
  }
}

// The Agents panel; Home registers in homedock.ts and each board box in board.ts.
{
  const s = SURFACES.ide;
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
