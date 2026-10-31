/* ----- Workspace sync (one account, many computers) ----- */
// GitHub accounts sync through a private breeze-sync repo, Google accounts through Drive's hidden app folder.
const isSyncFail = (r: unknown): r is SyncFail => !!r && typeof r === 'object' && 'error' in r;
// Unwraps a sync result. A failure becomes a toast, or a sign-in prompt when the account needs more access.
function syncOk<T>(r: T | SyncFail, quiet = false): T | null {
  if (!isSyncFail(r)) return r;
  if (quiet) return null;
  if (r.code === 'reauth') {
    openModal(`<h3>Sign in again to sync</h3><p class="sub">${esc(r.error)} Breeze needs one more permission: a private breeze-sync repo on GitHub, or Breeze's own hidden folder in Google Drive.</p>
      <div class="row end"><button class="btn" data-close>Not now</button><button class="btn btn-primary" id="syncReauth">Sign in</button></div>`, m => {
      $('#syncReauth', m).onclick = () => { closeModal(); addAccount(); };
    });
  } else toast(r.code === 'signed-out' ? 'Sign in to sync your workspaces' : r.error);
  return null;
}
function syncSummaryText(s: SyncSummary): string {
  const parts = [
    s.downloaded && `${s.downloaded} down`, s.uploaded && `${s.uploaded} up`, s.removed && `${s.removed} removed`,
    s.conflicts.length && `${s.conflicts.length} conflict${s.conflicts.length > 1 ? 's' : ''} kept side by side`,
  ].filter(Boolean);
  return parts.length ? `Synced: ${parts.join(', ')}` : 'Already in sync';
}

// App settings that follow the account. A change is stamped when first seen, so the newer side wins.
const SYNCED_KEYS = new Set(['breeze.sound', 'breeze.volume', 'breeze.effort', 'breeze.layout']);
const SYNCED_APP = new Set<keyof AppState>(['agent', 'mode', 'discord', 'discordDetails']);
function settingValues(): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const k of SYNCED_KEYS) { const v = store.get<unknown>(k, undefined); if (v !== undefined) values[k] = v; }
  for (const k of SYNCED_APP) values[`app.${k}`] = appState[k];
  return values;
}
function sharedSettings(): SharedSettings {
  const values = settingValues();
  const print = JSON.stringify(values);
  const last = store.get<{ print: string; updatedAt: string }>('breeze.settingsSync', { print: '', updatedAt: '' });
  const updatedAt = last.print === print && last.updatedAt ? last.updatedAt : new Date().toISOString();
  store.set('breeze.settingsSync', { print, updatedAt });
  return { updatedAt, values };
}
// Settings from another computer are applied and the window reloads so every part picks them up.
async function syncSettings(): Promise<void> {
  const mine = sharedSettings();
  const r = syncOk(await api.sync.settings(mine), true);
  if (!r?.pulled || !r.settings || JSON.stringify(r.settings.values) === JSON.stringify(mine.values)) return;
  for (const [k, v] of Object.entries(r.settings.values)) {
    const key = k.slice(4) as keyof AppState;
    if (k.startsWith('app.') && SYNCED_APP.has(key)) (appState as unknown as Record<string, unknown>)[key] = v;
    else if (SYNCED_KEYS.has(k)) store.set(k, v);
  }
  saveApp();
  store.set('breeze.settingsSync', { print: JSON.stringify(settingValues()), updatedAt: r.settings.updatedAt });
  await api.win.reload();
}

let syncing = false;
async function runSync(mode: 'sync' | 'pull'): Promise<void> {
  if (!rootInfo) { toast('Open a folder to sync it'); return; }
  if (syncing) return;
  syncing = true;
  toast(mode === 'pull' ? 'Getting the latest from the cloud' : 'Syncing');
  try {
    const s = syncOk(await api.sync.run(mode));
    if (!s) return;
    syncSeenRev = s.rev;
    const backed = s.backedUp.length ? ` · ${plural(s.backedUp.length, 'local edit')} backed up` : '';
    toast(syncSummaryText(s) + backed);
    if (s.downloaded || s.removed || s.conflicts.length) await refreshTree();
    void refreshGit();
  } finally { syncing = false; }
  await syncSettings();
}
function confirmPull(): void {
  openModal(`<h3>Replace with the cloud version?</h3><p class="sub">${esc(rootInfo?.name ?? 'This folder')} will match the newest version synced from your other computer. Edits made here and not synced yet are backed up first, and files the cloud has never seen stay.</p>
    <div class="row end"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="pullOk">Get latest</button></div>`, m => {
    $('#pullOk', m).onclick = () => { closeModal(); background(runSync('pull')); };
  });
}
// The account's cloud workspaces; picking one downloads it to this computer and opens it.
async function openCloudWorkspaces(auto = false): Promise<void> {
  const st = syncOk(await api.sync.status(), auto);
  if (!st || (auto && !st.workspaces.length)) return;
  // Your picture on every row, badged with the number of the computer that synced it.
  const face = user?.avatar ? `<img src="${escAttr(user.avatar)}" alt="">` : esc(initialsOf(user?.name ?? '?'));
  const rows = st.workspaces.map(w => {
    const here = w.device === st.device;
    const pc = w.deviceNo ? `PC ${w.deviceNo}` : 'PC';
    return `<button class="cloud-ws" data-ws="${escAttr(w.id)}" title="Download ${escAttr(w.name)} to this computer">
      <span class="cloud-ws-face">${face}<span class="cloud-ws-pc" title="${escAttr(`${pc} · ${w.device}`)}">${w.deviceNo ?? '?'}</span></span>
      <span class="cloud-ws-text"><span class="cloud-ws-name"><span class="cloud-ws-title">${esc(w.name)}</span>${here ? '<span class="cloud-ws-here">This PC</span>' : ''}</span>
        <span class="cloud-ws-meta">${esc(pc)} · ${esc(w.device)} · ${esc(timeAgo(Date.parse(w.updatedAt)))}</span></span>
      <span class="cloud-ws-go">${svgIcon('download', 15)}</span></button>`;
  }).join('');
  const empty = '<div class="cloud-ws-empty">Nothing synced yet. Open a folder and choose Sync Workspace from your picture to put it in the cloud.</div>';
  openModal(`<h3>${auto ? 'Pick up where you left off' : 'Your cloud workspaces'}</h3>
    ${st.workspaces.length ? '<p class="sub">Synced from your computers. Pick one to download it here.</p>' : ''}
    <div class="cloud-ws-list">${rows || empty}</div>
    <div class="row end spaced"><button class="btn" data-close>${auto ? 'Later' : 'Close'}</button></div>`, m => {
    $$<HTMLElement>('[data-ws]', m).forEach(b => b.onclick = () => background((async () => {
      closeModal();
      toast('Downloading workspace');
      const r = syncOk(await api.sync.clone(b.dataset.ws ?? ''));
      if (!r) return;
      await loadWorkspace(r.info);
      syncSeenRev = r.summary.rev;
      toast(`${r.info.name}: ${r.summary.downloaded} files downloaded`);
    })()));
  });
}
// A fresh install that signs in gets the account's settings, then its workspaces if no folder is open.
async function afterSignIn(): Promise<void> {
  if (!isDesktop) return;
  await syncSettings();
  if (!rootInfo) await openCloudWorkspaces(true);
  else { syncCheckedAt = 0; await checkCloudNewer(); }
}
// When another computer has synced a newer version of the open folder, offer to catch up, once per version.
let syncSeenRev = 0, syncCheckedAt = 0;
async function checkCloudNewer(): Promise<void> {
  if (!user || !rootInfo || !isDesktop || syncing || Date.now() - syncCheckedAt < 60_000) return;
  syncCheckedAt = Date.now();
  const st = syncOk(await api.sync.status(), true);
  if (!st?.newer || !st.remote || st.remote.rev <= syncSeenRev || $('#modalRoot .scrim:not(.closing)')) return;
  syncSeenRev = st.remote.rev;
  const w = st.remote;
  openModal(`<h3>Newer version from ${esc(w.device)}</h3><p class="sub">${esc(w.name)} was synced from ${esc(w.device)} ${esc(timeAgo(Date.parse(w.updatedAt)))}. Sync to bring this computer up to date; edits made here are kept.</p>
    <div class="row end"><button class="btn" data-close>Later</button><button class="btn" id="cloudPull">Replace with theirs</button><button class="btn btn-primary" id="cloudSync">Sync now</button></div>`, m => {
    $('#cloudSync', m).onclick = () => { closeModal(); background(runSync('sync')); };
    $('#cloudPull', m).onclick = () => { closeModal(); confirmPull(); };
  });
}
function syncMenuItems(): MenuItem[] {
  return [
    { label: 'Sync Workspace', act: 'sync.run', enabled: () => !!rootInfo },
    { label: 'Get Latest from Cloud', act: 'sync.pull', enabled: () => !!rootInfo },
    { label: 'Open Cloud Workspace', act: 'sync.open' },
  ];
}
window.addEventListener('focus', () => background(checkCloudNewer()));

