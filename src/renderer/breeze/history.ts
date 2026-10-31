/* ----- Chat history: "New chat" files the current conversation away; the clock button brings one back ----- */
// `sessions` is the current shape; an older entry has `session` (+ `agent`) instead, and openChat turns that into `sessions`.
// `folder`: the project open when a Breeze Box chat began, so its side bar can group chats by folder.
interface ChatEntry { id: string; title: string; at: number; html: string; agent: string | null; session: string | null; sessions?: Record<string, string>; folder?: string | null; }
const historyKey = (s: Surface) => `breeze.history:${chatScope(s)}`;
const chatIdKey = (s: Surface) => `breeze.chatId:${chatScope(s)}`;
const HISTORY_MAX = 30, HISTORY_BYTES = 1_500_000;
const newChatId = () => crypto.randomUUID();
const chatHistory = (s: Surface) => store.get<ChatEntry[]>(historyKey(s), []);

function archiveChatTab(s: Surface, tab: AgentTabState): void {
  if (s.name === 'ide' && !rootInfo) return;
  if (tab.panel.querySelector('.empty') && !tab.panel.querySelector('.msg')) return;
  const html = [...tab.panel.children].filter(c => !c.classList.contains('thinking') && !c.classList.contains('team-strip')).map(c => c.outerHTML).join('');
  if (!html?.includes('class="msg')) return;
  if (!tab.historyId) tab.historyId = newChatId();
  const id = tab.historyId;
  const first = tab.panel.querySelector('.msg.user .body')?.textContent ?? tab.title ?? 'Chat';
  const title = first.trim().replaceAll(/\s+/g, ' ').slice(0, 64) || tab.title || 'Chat';
  const old = chatHistory(s);
  // A chat stays under the folder it began in, even if another folder is open by now.
  const folder = old.find(e => e.id === id)?.folder ?? rootInfo?.root ?? null;
  const entry: ChatEntry = { id, title, at: Date.now(), html, agent: tab.agentId || appState.agent, session: tab.sessions[tab.agentId] ?? null, sessions: { ...tab.sessions }, folder };
  let bytes = 0;
  const list = [entry, ...old.filter(e => e.id !== id)].filter(e => (bytes += e.html.length) < HISTORY_BYTES).slice(0, HISTORY_MAX);
  store.set(historyKey(s), list);
  if (s.name === 'box') renderBoxSide();
}

function archiveChat(s: Surface): void {
  const t = getActiveTab(s);
  if (t) archiveChatTab(s, t);
}

// The chat's saveable HTML; empty when there is nothing to keep.
function chatHtml(s: Surface): string {
  const t = getActiveTab(s);
  if (t.panel.querySelector('.empty')) return '';
  return [...t.panel.children].filter(c => !c.classList.contains('thinking') && !c.classList.contains('team-strip')).map(c => c.outerHTML).join('');
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
}

function openChat(s: Surface, e: ChatEntry): void {
  const cur = getActiveTab(s);
  const isCurEmpty = !cur.runId && (cur.panel.querySelector('.empty') || !cur.panel.children.length);
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
  if (anchor.classList.contains('open') || (justClosedTrigger === anchor && Date.now() - justClosedAt < 350)) { closeMenu(); return; }
  closeMenu();
  const list = chatHistory(s);
  const items: MenuItem[] = list.length
    ? list.map(e => ({ label: e.title, key: timeAgo(e.at), run: () => openChat(s, e) }))
    : [{ label: 'No earlier chats yet', enabled: () => false }];
  if (list.length) items.push({ sep: true }, { label: 'Clear chat history', run: () => { store.del(historyKey(s)); toast('Chat history cleared'); } });
  const r = anchor.getBoundingClientRect();
  anchor.classList.add('open');
  popupMenu(r.right - 300, r.bottom + 4, items, () => anchor.classList.remove('open'), anchor);
  $('#menuRoot .menu')?.classList.add('history-menu');
}
$('#chatHistory').onclick = e => showHistory(SURFACES.ide, e.currentTarget as HTMLElement);
commands['chat.history'] = () => {
  if (surface.name === 'box') { setBoxSide(true); openBoxSearch(); } else showHistory(surface, $('#chatHistory'));
};

/* ----- Breeze Box side bar: New chat, Search, then the chats grouped by folder ----- */
// Box switches chats here instead of with tabs: a chat that is not running and not on screen is filed away,
// so only the open chat and any still working stay loaded.
const boxSideFolded = new Set(store.get<string[]>('breeze.boxSideFolded', []));
let boxSideQuery = '';
// Just the folder's own name ("BreezeCode"), whichever slashes its path uses.
const folderName = (p: string | null | undefined) => (p ? baseName(p.replaceAll('\\', '/').replace(/\/+$/, '')) : '');
function boxSideOpen(): boolean { return store.get<boolean>('breeze.boxSide', true); }
function setBoxSide(open: boolean): void {
  store.set('breeze.boxSide', open);
  // Hidden, the side bar takes its own Hide button with it; the title bar's Show button brings it back.
  $('#box').classList.toggle('side-closed', !open);
}
function pruneBoxTabs(): void {
  const s = SURFACES.box;
  for (const t of [...surfaceTabs.box]) if (t.id !== activeTabId.box && !tabBusy(t)) closeAgentTab(s, t.id);
}
function openBoxChat(e: ChatEntry): void {
  const s = SURFACES.box;
  const open = surfaceTabs.box.find(t => t.historyId === e.id);
  if (open) switchAgentTab(s, open.id);
  else openChat(s, e);
  pruneBoxTabs();
  renderBoxSide();
}
function newBoxChat(): void {
  const cur = getActiveTab(SURFACES.box);
  // Already on an empty chat: just put the cursor in it.
  if (!cur.historyId && cur.panel.querySelector('.empty')) { SURFACES.box.prompt.focus(); return; }
  newAgentTabAction(SURFACES.box);
  pruneBoxTabs();
  renderBoxSide();
}
function openBoxSearch(): void {
  const input = $<HTMLInputElement>('#boxSideSearch');
  $('#boxSideSearchBox').classList.remove('hidden');
  $('#boxSideSearchBtn').classList.add('hidden');
  input.focus();
  input.select();
}
function closeBoxSearch(): void {
  const input = $<HTMLInputElement>('#boxSideSearch');
  input.value = '';
  boxSideQuery = '';
  $('#boxSideSearchBox').classList.add('hidden');
  $('#boxSideSearchBtn').classList.remove('hidden');
  renderBoxSide();
}
function deleteBoxChat(id: string): void {
  store.set(historyKey(SURFACES.box), chatHistory(SURFACES.box).filter(e => e.id !== id));
  const tab = surfaceTabs.box.find(t => t.historyId === id);
  if (tab) tab.historyId = undefined; // still open: it is filed again as a new chat if it changes
  renderBoxSide();
  toast('Chat deleted');
}
function renderBoxSide(): void {
  const list = $('#boxSideList');
  const q = boxSideQuery.toLowerCase();
  const matches = (e: ChatEntry) => `${e.title}\n${folderName(e.folder)}`.toLowerCase().includes(q);
  const entries = chatHistory(SURFACES.box).filter(e => !q || matches(e));
  const activeId = surfaceTabs.box.find(t => t.id === activeTabId.box)?.historyId;
  const busy = new Set(surfaceTabs.box.filter(t => tabBusy(t) && t.historyId).map(t => t.historyId));
  // Groups keep the order of their newest chat; chats from before folders were kept go under "Breeze Box".
  const groups = new Map<string, ChatEntry[]>();
  for (const e of entries) {
    const k = e.folder ?? '';
    groups.set(k, [...groups.get(k) ?? [], e]);
  }
  if (!groups.size) {
    list.innerHTML = `<div class="box-side-empty">${q ? 'No chats match' : 'Your chats show up here'}</div>`;
    return;
  }
  list.innerHTML = [...groups].map(([folder, chats]) => {
    const folded = !q && boxSideFolded.has(folder);
    const name = folderName(folder) || 'Breeze Box';
    const rows = chats.map(e => `<button class="box-side-chat${e.id === activeId ? ' on' : ''}" type="button" data-chat="${escAttr(e.id)}" title="${escAttr(e.title)}">
        <span class="nm">${esc(e.title)}</span>${busy.has(e.id) ? '<span class="box-side-busy" aria-label="Working"></span>' : `<span class="ago">${esc(timeAgo(e.at))}</span>`}</button>`).join('');
    return `<div class="box-side-group${folded ? ' folded' : ''}">
      <button class="box-side-folder" type="button" data-folder="${escAttr(folder)}" aria-expanded="${!folded}" title="${escAttr(folder || 'Chats with no folder open')}">
        <span class="nm">${esc(name)}</span>${svgIcon('chevronDown', 12)}</button>
      <div class="box-side-chats">${rows}</div>
    </div>`;
  }).join('');
}
$('#boxSideList').addEventListener('click', ev => {
  const t = ev.target as HTMLElement;
  const folder = t.closest<HTMLElement>('[data-folder]');
  if (folder) {
    const k = folder.dataset.folder ?? '';
    if (boxSideFolded.has(k)) boxSideFolded.delete(k); else boxSideFolded.add(k);
    store.set('breeze.boxSideFolded', [...boxSideFolded]);
    renderBoxSide();
    return;
  }
  const row = t.closest<HTMLElement>('[data-chat]');
  const e = row && chatHistory(SURFACES.box).find(x => x.id === row.dataset.chat);
  if (e) openBoxChat(e);
});
$('#boxSideList').addEventListener('contextmenu', ev => {
  const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-chat]');
  if (!row) return;
  ev.preventDefault();
  const id = row.dataset.chat as string;
  popupMenu(ev.clientX, ev.clientY, [{ label: 'Delete chat', run: () => deleteBoxChat(id) }]);
});
$('#boxSideNew').onclick = newBoxChat;
$('#boxSideSearchBtn').onclick = openBoxSearch;
$('#boxSideSearch').addEventListener('input', ev => {
  boxSideQuery = (ev.target as HTMLInputElement).value.trim();
  renderBoxSide();
});
$('#boxSideSearch').addEventListener('keydown', ev => {
  if (ev.key === 'Escape') { ev.preventDefault(); closeBoxSearch(); }
});
$('#boxSideSearch').addEventListener('blur', () => { if (!boxSideQuery) closeBoxSearch(); });
$('#boxSideHide').onclick = () => setBoxSide(false);
$('#boxSideShow').onclick = () => setBoxSide(true);
setBoxSide(boxSideOpen());

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
        surface: s.name as 'ide' | 'box',
        tabId: tab.id,
        attachment: att,
        index: idx,
      });

      sfx.play('close');
      const isLast = list.length <= 1;
      if (chip) {
        chip.classList.add('leaving');
        if (isLast) s.attachmentsEl.classList.add('collapsing');
        await new Promise(r => setTimeout(r, 270));
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

async function addPastedImage(file: File, s: Surface, tab?: AgentTabState): Promise<void> {
  const targetTab = tab || getActiveTab(s);
  const dataUrl = await new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result as string);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const extMap: Record<string, string> = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
  const ext = extMap[file.type] ?? 'png';
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const name = file.name && file.name !== 'image.png' ? file.name : `image_${ts}.${ext}`;
  let fileRel: string | undefined;
  let fileUrl: string | undefined;
  try {
    fileRel = await api.fs.importFile('attachments', name, bytes);
    if (fileRel) fileUrl = await api.fs.fileUrl(fileRel);
  } catch {
    // In browser demo or if import fails, keep dataUrl
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
          await addPastedImage(file, s, targetTab);
        } else {
          const filePath = rel || diskPath || entry.name;
          await attachPathToAgent(filePath, false, s, targetTab);
        }
      }
    }
    return;
  }

  for (const file of files) {
    const diskPath = getDroppedFilePath(file);
    const rel = diskPath && rootInfo ? toRelProject(diskPath) : null;
    if (file.type.startsWith('image/') || IMAGE_FILE.test(file.name)) {
      await addPastedImage(file, s, targetTab);
    } else {
      const filePath = rel || diskPath || file.name;
      await attachPathToAgent(filePath, false, s, targetTab);
    }
  }
}

