/* ----- Chat history: "New chat" files the current conversation away; the clock button brings one back ----- */
// `sessions` is the current shape; an older entry has `session` (+ `agent`) instead, and openChat turns that into `sessions`.
// `folder`: the project open when the chat began, so the Agent board's side bar can group chats by folder.
// `log`: a chat from Claude Code's or Codex's own logs (the Agent Board lists them); its messages are read when it is opened.
interface ChatEntry { id: string; title: string; at: number; html: string; agent: string | null; session: string | null; sessions?: Record<string, string>; folder?: string | null; log?: { agent: string; session: string }; }
const historyKey = (s: ChatStore) => `breeze.history:${chatScope(s)}`;
const chatIdKey = (s: ChatStore) => `breeze.chatId:${chatScope(s)}`;
const HISTORY_MAX = 30, HISTORY_BYTES = 1_500_000;
const newChatId = () => crypto.randomUUID();
const chatHistory = (s: ChatStore) => store.get<ChatEntry[]>(historyKey(s), []);
// The chats Breeze Space kept before it was removed: no screen of their own, but the board's side bar lists them.
const SPACE_CHATS: ChatStore = { name: 'space' };
// What each tab last filed. Filing parses and rewrites the whole history (up to HISTORY_BYTES), and the board files
// every box's chat whenever one box finishes, so a chat that hasn't changed since isn't filed again.
const archivedAs = new WeakMap<AgentTabState, string>();

function archiveChatTab(s: Surface, tab: AgentTabState): void {
  if (s.name === 'ide' && !rootInfo) return;
  if (tab.panel.querySelector('.empty') && !tab.panel.querySelector('.msg')) return;
  const html = [...tab.panel.children].filter(c => !c.classList.contains('thinking') && !c.classList.contains('team-strip') && !c.classList.contains('followup-card')).map(c => c.outerHTML).join('');
  if (!html?.includes('class="msg')) return;
  const first = tab.panel.querySelector('.msg.user .body')?.textContent ?? '';
  // The tab's own name (typed, or the agent's), else the first request. A board box's "Box 3" is no name either.
  const title = (/^(Chat|Box) \d+$/i.test(tab.title) ? '' : tab.title) || first.trim().replaceAll(/\s+/g, ' ').slice(0, 64) || 'Chat';
  const agent = tab.agentId || appState.agent;
  // Without the id: a chat deleted from history while still open is filed again (as a new one) only once it changes.
  const filed = `${historyKey(s)}\n${title}\n${agent}\n${JSON.stringify(tab.sessions)}\n${html}`;
  if (archivedAs.get(tab) === filed) return;
  if (!tab.historyId) tab.historyId = newChatId();
  const id = tab.historyId;
  const old = chatHistory(s);
  // A chat stays under the folder it began in, even if another folder is open by now.
  const folder = old.find(e => e.id === id)?.folder ?? s.folder ?? rootInfo?.root ?? null;
  const entry: ChatEntry = { id, title, at: Date.now(), html, agent, session: tab.sessions[tab.agentId] ?? null, sessions: { ...tab.sessions }, folder };
  let bytes = 0;
  const list = [entry, ...old.filter(e => e.id !== id)].filter(e => (bytes += e.html.length) < HISTORY_BYTES).slice(0, HISTORY_MAX);
  store.set(historyKey(s), list);
  archivedAs.set(tab, filed);
  // Done replying: the new part goes to the folder's second brain (main summarizes it in the background).
  if (folder && !tabBusy(tab)) background(api.brain.syncChat(folder, { key: id, title, text: chatPlainText(html) }));
  // The Agent Board's side bar lists this folder's chats (and Space's old ones).
  if (typeof renderBoardSide === 'function' && boardPageShowing()) renderBoardSide();
}

/* ----- A project folder renamed or moved (main's projectmove.ts noticed): its chats and settings follow it ----- */
// Everything saved under the old path (chat history, the open chat, agent sessions, tabs, drafts, the board) moves to
// the new one (movecore.ts says how). The moves are kept too, so Claude Code's and Codex's own logs, which still name
// the old folder, are listed under the new one.
const FOLDER_MOVES_KEY = 'breeze.folderMoves';
function moveFolderStorage(from: string, to: string): void {
  const items: [string, unknown][] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k == null || !k.startsWith('breeze.')) continue;
      const raw = localStorage.getItem(k) ?? '';
      let v: unknown = raw;
      try { v = JSON.parse(raw); } catch { /* kept as text */ }
      items.push([k, v]);
    }
  } catch { return; }
  const plan = planFolderMove(items, from, to);
  for (const [k, v] of plan.set) store.set(k, v);
  for (const k of plan.del) store.del(k);
  const moves = store.get<[string, string][]>(FOLDER_MOVES_KEY, []).filter(m => Array.isArray(m) && m[0] !== from);
  store.set(FOLDER_MOVES_KEY, [...moves, [from, to]].slice(-50));
}
// Where a folder named in an agent's log is now, after any renames since.
function currentFolder(p: string): string {
  let out = p;
  for (const [from, to] of store.get<[string, string][]>(FOLDER_MOVES_KEY, [])) out = movedFolderPath(out, from, to) ?? out;
  return out;
}

// A saved chat's text, for the second brain: parsed, never run.
function chatPlainText(html: string): string {
  const spaced = html.replace(/<\/(?:p|div|li|h\d|pre|tr|blockquote)>|<br\s*\/?>/gi, '$&\n');
  return (new DOMParser().parseFromString(spaced, 'text/html').body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

function archiveChat(s: Surface): void {
  const t = getActiveTab(s);
  if (t) archiveChatTab(s, t);
}

// The chat's saveable HTML; empty when there is nothing to keep.
function chatHtml(s: Surface): string {
  const t = getActiveTab(s);
  if (t.panel.querySelector('.empty')) return '';
  return [...t.panel.children].filter(c => !c.classList.contains('thinking') && !c.classList.contains('team-strip') && !c.classList.contains('followup-card')).map(c => c.outerHTML).join('');
}
let chatTimer: TimeoutId | undefined;
function saveChat(tab?: AgentTabState): void {
  clearTimeout(chatTimer);
  const t = tab || getActiveTab(msgSurface);
  chatTimer = setTimeout(() => {
    if (t.surfaceName === 'ide' && !rootInfo) return;
    const s = SURFACES[t.surfaceName];
    archiveChatTab(s, t);
  }, 400);
}
function restoreChat(s: Surface = SURFACES.ide): void {
  const html = store.get<string>(chatKey(s), '');
  // If an earlier session was stored in chatKey, archive it into chat history so it is never lost
  if (html?.includes('msg')) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    const first = tempDiv.querySelector('.msg.user .body')?.textContent ?? 'Chat';
    const title = first.trim().replaceAll(/\s+/g, ' ').slice(0, 64) || 'Chat';
    const entry: ChatEntry = {
      id: newChatId(),
      title,
      at: Date.now(),
      html,
      agent: appState.agent,
      session: store.get<string | null>(agentSessionKey(s), null),
    };
    let bytes = 0;
    const existing = chatHistory(s);
    if (!existing.some(e => e.title === title && Math.abs(e.at - entry.at) < 60000)) {
      const list = [entry, ...existing.filter(e => e.id !== entry.id)].filter(e => (bytes += e.html.length) < HISTORY_BYTES).slice(0, HISTORY_MAX);
      store.set(historyKey(s), list);
    }
  }
  // Clear lingering chatKey so startup is always clean and never resurrects ghost chats
  store.del(chatKey(s));

  surfaceTabs[s.name] = [];
  s.chat.innerHTML = '';
  // Fresh, clean initial chat tab
  const initial = createAgentTab(s, 'Chat 1');
  activeTabId[s.name] = initial.id;
  initial.panel.classList.add('active');
  renderAgentTabs(s);
  scrollChat(s);
  restoreDraft(s.prompt); // the message this folder's box held when it was last open
  void reattachRuns(s);
}
// Chats whose agent kept working in main while the page reloaded or crashed: each comes back in its own tab, saved up to
// the message that started the run, and the run's events so far play again on top (then it carries on live).
async function reattachRuns(s: Surface): Promise<void> {
  let live: Awaited<ReturnType<typeof api.agent.live>>;
  try { live = await api.agent.live(); } catch { return; }
  for (const r of live) {
    if (findTabForRun(r.runId)) continue; // already on screen
    const e = chatHistory(s).find(x => x.id === r.chat);
    if (!e) continue;
    const tab = createAgentTab(s, e.title, e.html);
    tab.historyId = e.id;
    tab.sessions = e.sessions ? { ...e.sessions } : {};
    const users = tab.panel.querySelectorAll('.msg.user');
    const last = users[users.length - 1];
    while (last?.nextSibling) last.nextSibling.remove();
    attachLiveRun(tab, r);
    if (!r.done) switchAgentTab(s, tab.id);
  }
}

// A chat with nothing said yet: no messages and no run.
const chatUnstarted = (t: AgentTabState): boolean => !t.runId && !t.historyId && (!!t.panel.querySelector('.empty') || !t.panel.children.length);
// Something typed or attached and not sent yet. The chat on screen keeps its draft in the prompt itself.
function tabHasDraft(s: Surface, t: AgentTabState): boolean {
  const onScreen = t.id === activeTabId[s.name];
  const text = onScreen ? s.prompt.value : t.promptDraft;
  const atts = onScreen ? attachmentsMap[s.name] : t.attachments;
  return !!text?.trim() || !!atts?.length;
}

function openChat(s: Surface, e: ChatEntry): void {
  const cur = getActiveTab(s);
  // An unstarted chat is reused for the one opened, unless it holds a draft: that stays with it (images included).
  const isCurEmpty = !cur.runId && (cur.panel.querySelector('.empty') || !cur.panel.children.length) && !tabHasDraft(s, cur);
  const tab = isCurEmpty ? cur : createAgentTab(s, e.title);
  tab.title = e.title;
  tab.historyId = e.id;
  // An old entry kept one `session` with the `agent` that started it.
  tab.sessions = e.sessions ? { ...e.sessions } : (e.session && e.agent ? { [e.agent]: e.session } : {});
  setSavedHtml(tab.panel, e.html);
  $$('[data-live]', tab.panel).forEach(el => { el.outerHTML = '<div class="resolved">Earlier session</div>'; });
  $$('.team-claiming', tab.panel).forEach(el => el.classList.add('settled')); // saved mid-claim: stop its spinners
  switchAgentTab(s, tab.id);
  resetTeam();
  s.prompt.focus();
}
function timeAgo(at: number): string {
  const m = Math.round((Date.now() - at) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d ago` : new Date(at).toLocaleDateString();
}
function showHistory(s: Surface, anchor: HTMLElement): void {
  if (menuWasOpen(anchor)) { closeMenu(); return; }
  closeMenu();
  const list = chatHistory(s);
  const items: MenuItem[] = list.length
    ? list.map(e => ({ label: e.title, key: timeAgo(e.at), run: () => openChat(s, e) }))
    : [{ label: 'No earlier chats yet', enabled: () => false }];
  if (list.length) items.push({ sep: true }, { label: 'Clear chat history', run: () => { store.del(historyKey(s)); background(api.brain.forgetChats(list.map(e => e.id))); toast('Chat history cleared'); } });
  const r = anchor.getBoundingClientRect();
  anchor.classList.add('open');
  popupMenu(r.right - 300, r.bottom + 4, items, () => anchor.classList.remove('open'), anchor);
  const m = $('#menuRoot .menu');
  if (!m) return;
  m.classList.add('history-menu');
  // Re-place once the class sets its width: it was clamped while long titles still made it wide.
  m.style.left = `${Math.max(8, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 8))}px`;
}
$('#chatHistory').onclick = e => showHistory(SURFACES.ide, e.currentTarget as HTMLElement);
commands['chat.history'] = () => {
  showHistory(surface, $('#chatHistory'));
};

// Just the folder's own name ("BreezeCode"), whichever slashes its path uses.
const folderName = (p: string | null | undefined) => (p ? baseName(p.replaceAll('\\', '/').replace(/\/+$/, '')) : '');
/* A chat belongs to the project it began in. Opened from another project's group, that project is opened first, so the
   chat stays filed under it and its agent carries on in its own folder, never in whichever one happens to be open. */
// A folder path written one way, whichever slashes and case it came with, so two spellings of one folder match.
const folderKey = (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
const chatInOpenFolder = (e: ChatEntry) => !e.folder || (!!rootInfo && folderKey(e.folder) === folderKey(rootInfo.root));
// True once the chat's project is the open one; false when the switch was cancelled or failed. Agent Board boxes
// working in the last one carry on (board.ts parkedBoxes).
async function openChatFolder(e: ChatEntry): Promise<boolean> {
  await openRecentFolder(e.folder as string);
  return chatInOpenFolder(e);
}
function renameChatEntry(s: ChatStore, id: string, title: string): void {
  store.set(historyKey(s), chatHistory(s).map(e => (e.id === id ? { ...e, title } : e)));
}

function renderAttachments(s: Surface): void {
  const list = attachmentsMap[s.name] || [];
  if (!list.length) {
    s.attachmentsEl.classList.remove('collapsing');
    s.attachmentsEl.classList.add('hidden');
    s.attachmentsEl.innerHTML = '';
    return;
  }
  s.attachmentsEl.classList.remove('hidden', 'collapsing');
  s.attachmentsEl.innerHTML = list.map(a => {
    const kind = a.kind || (a.dataUrl || (a.fileUrl && IMAGE_FILE.test(a.name)) ? 'image' : 'file');
    let thumbHtml = '';
    if (kind === 'image') {
      const src = a.dataUrl || a.fileUrl || '';
      thumbHtml = `<img src="${escAttr(src)}" class="attachment-thumb" alt="${escAttr(a.name)}" title="Click to preview">`;
    } else if (kind === 'folder') {
      thumbHtml = `<span class="attachment-thumb attachment-icon folder-icon" title="Folder: ${escAttr(a.path || a.name)}">${folderIcon(a.name, false)}</span>`;
    } else {
      thumbHtml = `<span class="attachment-thumb attachment-icon file-icon" title="File: ${escAttr(a.path || a.name)}">${fileIcon(a.name)}</span>`;
    }
    const displayName = a.path || a.name;
    return `
      <div class="attachment-chip ${kind}-chip" data-att-id="${escAttr(a.id)}" data-path="${escAttr(a.path || '')}" title="${escAttr(displayName)}">
        ${thumbHtml}
        <span class="attachment-name" title="${escAttr(displayName)}">${esc(displayName)}</span>
        <button class="attachment-del" type="button" title="Remove" data-del-id="${escAttr(a.id)}">✕</button>
      </div>
    `;
  }).join('');
  $$('[data-del-id]', s.attachmentsEl).forEach(btn => {
    btn.onclick = async e => {
      e.stopPropagation();
      const id = btn.dataset.delId;
      const chip = btn.closest<HTMLElement>('.attachment-chip');
      const list = attachmentsMap[s.name] || [];
      const idx = list.findIndex(x => x.id === id);
      const att = list[idx];
      if (!att) return;

      const tab = getActiveTab(s);
      pushAppAction({
        type: 'remove-attachment',
        surface: s.name as 'ide',
        tabId: tab.id,
        attachment: att,
        index: idx,
      });

      sfx.play('close');
      const isLast = list.length <= 1;
      if (chip) {
        chip.classList.add('leaving');
        if (isLast) s.attachmentsEl.classList.add('collapsing');
        await new Promise(r => setTimeout(r, isLast ? 420 : 270)); // the last one waits for the row to fold up
      }

      attachmentsMap[s.name] = (attachmentsMap[s.name] || []).filter(x => x.id !== id);
      tab.attachments = [...(attachmentsMap[s.name] || [])];
      s.attachmentsEl.classList.remove('collapsing');
      renderAttachments(s);
      toast(`Removed · ${att.name}`);
    };
  });
  $$('.attachment-chip', s.attachmentsEl).forEach(chip => {
    chip.onclick = e => {
      const target = e.target as HTMLElement;
      if (target.closest('.attachment-del')) return;
      const id = chip.dataset.attId;
      const att = (attachmentsMap[s.name] || []).find(x => x.id === id);
      if (!att?.path) return;
      if (att.kind === 'folder') {
        expanded.add(att.path);
        renderTree();
        toast(`Revealed folder · ${att.path}`);
      } else if (att.kind === 'file') {
        openFile(att.path);
      }
    };
  });
}

// Attaches an image without copying it into the project: a dropped file is used where it is on disk, and a pasted one
// (no file of its own) is kept in the temp folder.
async function addPastedImage(file: File, s: Surface, tab?: AgentTabState, diskPath = ''): Promise<void> {
  const targetTab = tab || getActiveTab(s);
  const dataUrl = await new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result as string);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
  const extMap: Record<string, string> = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
  const ext = extMap[file.type] ?? 'png';
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const name = file.name && file.name !== 'image.png' ? file.name : `image_${ts}.${ext}`;
  let fileRel: string | undefined;
  let fileUrl: string | undefined;
  if (diskPath) {
    fileRel = diskPath;
  } else {
    try {
      const stash = await api.fs.stashAttachment(name, new Uint8Array(await file.arrayBuffer()));
      fileRel = stash.path;
      fileUrl = stash.url;
    } catch {
      // In the browser demo, or if the temp folder can't be written: the data URL is still shown
    }
  }
  const att: AgentAttachment = { id: crypto.randomUUID().slice(0, 8), name, kind: 'image', dataUrl, fileUrl, fileRel, path: fileRel };
  attachmentsMap[s.name].push(att);
  targetTab.attachments = [...attachmentsMap[s.name]];
  renderAttachments(s);
  s.prompt.focus();
  toast(`Image attached · ${name}`);
}

async function attachPathToAgent(rawPath: string, isDir: boolean, s: Surface, tab?: AgentTabState): Promise<boolean> {
  const targetTab = tab || getActiveTab(s);
  const cleanPath = rawPath.replaceAll('\\', '/').replace(/\/$/, '');
  const name = baseName(cleanPath) || cleanPath;
  const list = attachmentsMap[s.name] || [];

  if (list.some(a => (a.path?.toLowerCase() === cleanPath.toLowerCase()) || (a.fileRel?.toLowerCase() === cleanPath.toLowerCase()))) {
    toast(`Already attached · ${name}`);
    return false;
  }

  let kind: AttachmentKind = 'file';
  if (isDir) {
    kind = 'folder';
  } else if (IMAGE_FILE.test(name)) {
    kind = 'image';
  }
  let fileUrl: string | undefined;
  if (kind === 'image') {
    try {
      fileUrl = await api.fs.fileUrl(cleanPath);
    } catch {}
  }

  const att: AgentAttachment = {
    id: crypto.randomUUID().slice(0, 8),
    name,
    kind,
    path: cleanPath,
    fileRel: cleanPath,
    fileUrl,
    dataUrl: fileUrl,
  };

  list.push(att);
  attachmentsMap[s.name] = list;
  targetTab.attachments = [...list];
  renderAttachments(s);
  s.prompt.focus();
  const labelMap: Record<AttachmentKind, string> = { folder: 'Folder', image: 'Image', file: 'File' };
  const label = labelMap[kind] ?? 'File';
  toast(`${label} attached · ${name}`);
  return true;
}

async function handleAgentDrop(e: DragEvent, ag: AgentDropTargetInfo): Promise<void> {
  clearAgentDropMarks();

  let targetTab: AgentTabState;
  if (ag.isNewTab) {
    targetTab = createAgentTab(ag.surface, undefined, undefined, null, true);
    activeTabId[ag.surface.name] = targetTab.id;
    switchAgentTab(ag.surface, targetTab.id);
  } else if (ag.tab) {
    if (ag.tab.id !== activeTabId[ag.surface.name]) {
      switchAgentTab(ag.surface, ag.tab.id);
    }
    targetTab = ag.tab;
  } else {
    targetTab = getActiveTab(ag.surface);
  }

  if (draggedTreePath) {
    const p = draggedTreePath;
    const isDir = draggedTreeIsDir;
    draggedTreePath = null;
    draggedTreeIsDir = false;
    await attachPathToAgent(p, isDir, ag.surface, targetTab);
    return;
  }

  if (e.dataTransfer) {
    await handleAgentDroppedFiles(e.dataTransfer, ag.surface, targetTab);
  }
}

async function handleAgentDroppedFiles(dt: DataTransfer, s: Surface, tab?: AgentTabState): Promise<void> {
  const targetTab = tab || getActiveTab(s);
  const items = Array.from(dt.items || []);
  const files = Array.from(dt.files || []);

  const entries = items.map(i => {
    try { return i.webkitGetAsEntry(); } catch { return null; }
  }).filter((x): x is FileSystemEntry => !!x);

  if (entries.length > 0) {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const file = files[i];
      const diskPath = file ? getDroppedFilePath(file) : '';
      const rel = diskPath && rootInfo ? toRelProject(diskPath) : null;

      if (entry.isDirectory) {
        const folderPath = rel || diskPath || entry.name;
        await attachPathToAgent(folderPath, true, s, targetTab);
      } else if (entry.isFile) {
        if (file && (file.type.startsWith('image/') || IMAGE_FILE.test(file.name))) {
          await addPastedImage(file, s, targetTab, rel || diskPath);
        } else {
          const filePath = rel || diskPath || entry.name;
          await attachPathToAgent(filePath, false, s, targetTab);
        }
      }
    }
    return;
  }

  await attachFilesToAgent(files, s, targetTab);
}
// Dropped or picked files: an image shows as a picture, anything else as a file chip. Both stay where they are on disk.
async function attachFilesToAgent(files: File[], s: Surface, tab?: AgentTabState): Promise<void> {
  const targetTab = tab || getActiveTab(s);
  for (const file of files) {
    const diskPath = getDroppedFilePath(file);
    const rel = diskPath && rootInfo ? toRelProject(diskPath) : null;
    if (file.type.startsWith('image/') || IMAGE_FILE.test(file.name)) {
      await addPastedImage(file, s, targetTab, rel || diskPath);
    } else {
      const filePath = rel || diskPath || file.name;
      await attachPathToAgent(filePath, false, s, targetTab);
    }
  }
}

