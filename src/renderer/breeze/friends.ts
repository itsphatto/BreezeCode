/* ================= Friends ================= */
// Home → Friends: add people by email, answer requests, and see what accepted friends are building. Main (friends.js)
// talks to Firebase; every call answers plain data, or { error, code } for a failure.
const FRIENDS_POLL_OPEN = 30_000;    // while the Friends view is on screen
const FRIENDS_POLL_HIDDEN = 120_000; // otherwise, only to keep the request badge current
const FRIENDS_COPY: Record<string, string> = {
  'invalid-email': "That doesn't look like an email address.",
  self: "That's you.",
  exists: "You're already friends.",
  'too-many': 'You have 50 requests waiting. Cancel some first.',
  'not-configured': "Friends isn't set up in this build.",
  'signed-out': 'Sign in with GitHub or Google to add friends.',
  network: "Couldn't reach Friends. Retrying…",
};
const isFriendsFail = (r: unknown): r is FriendsFail => !!r && typeof r === 'object' && 'error' in r;
const friendsFailOf = (e: unknown): FriendsFail => ({ error: errMsg(e), code: 'network' });

let friendsOpen = false;
let friendsData: FriendsList | null = null;
// Why the list can't show (not set up, signed out, sign in again, …), or a network failure over the last list; null: fine.
let friendsGate: FriendsFail | null = null;
let friendsVerifySent: string | null = null; // the address Firebase emailed a verification link to
let friendsVerifyNote = '';                   // a line under the verify message: a failure, or "still not verified"
let friendsConfigured: boolean | null = null; // null until main has said
let friendsTimer: TimeoutId | undefined;
let friendsSeq = 0;
let friendsShown = '';

/* ----- Pure parts: the status line and the order ----- */
function friendAgo(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
// What a friend is doing, as HTML (the project name, escaped, is in bold). `now` is the server's readTime.
function friendStatusLine(f: Friend, now: number): string {
  if (f.state === 'offline') return f.updatedAt === null ? 'Offline' : `Last seen ${friendAgo(now - f.updatedAt)}`;
  if (f.activity === 'space') return 'Chatting in Breeze Space';
  if (f.project !== null) {
    const p = `<b>${esc(f.project)}</b>`;
    if (f.activity === 'agent') return `Building with an agent in ${p}`;
    if (f.activity === 'editing') return `Coding in ${p}`;
    if (f.activity === 'debug') return `Debugging ${p}`;
  }
  return f.state === 'away' ? 'Away' : 'Online';
}
const FRIEND_RANK: Record<FriendState, number> = { online: 0, away: 1, offline: 2 };
// Online first, then away, then offline; alphabetical by name within each.
const sortFriends = (list: Friend[]): Friend[] =>
  [...list].sort((a, b) => FRIEND_RANK[a.state] - FRIEND_RANK[b.state] || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

/* ----- Drawing ----- */
const FRIEND_STATE_LABEL: Record<FriendState, string> = { online: 'Online', away: 'Away', offline: 'Offline' };
// Only a web picture goes in <img src>; anything else (javascript:, data:, file:, …) gets the initial instead.
const friendPicOk = (url: string | null): url is string => !!url && /^https?:\/\/\S+$/i.test(url);
const friendInitialHtml = (initial: string) => `<span class="friends-pic tint-host">${esc(initial)}</span>`;
// A picture, or the first letter of the name (or email) on the host tint; a friend's carries their status dot, which
// also says its state in words for screen readers.
function friendAvatarHtml(name: string | null, email: string, avatar: string | null, state?: FriendState): string {
  const initial = ([...(name || email).trim()][0] ?? '?').toUpperCase();
  const pic = friendPicOk(avatar)
    ? `<img class="friends-pic" src="${escAttr(avatar)}" alt="" draggable="false" data-initial="${escAttr(initial)}">`
    : friendInitialHtml(initial);
  const dot = state ? `<span class="friends-dot" data-state="${state}" role="img" aria-label="${FRIEND_STATE_LABEL[state]}" title="${FRIEND_STATE_LABEL[state]}"></span>` : '';
  return `<span class="friends-av">${pic}${dot}</span>`;
}
function friendsStateHtml(g: FriendsFail): string {
  if (g.code === 'network') return `<p class="friends-retry">${esc(FRIENDS_COPY.network)}</p>`;
  if (g.code === 'not-configured') {
    return `${svgIcon('users', 28)}<h3>${esc(FRIENDS_COPY['not-configured'])}</h3>
      <p>Add <code>firebase.apiKey</code> and <code>firebase.projectId</code> to <code>breeze.config.json</code> to turn it on.</p>`;
  }
  if (g.code === 'unverified') {
    // Firebase doesn't take GitHub's word for an email: it emails a link, and one click turns Friends on for good.
    const sent = friendsVerifySent;
    return `${svgIcon('users', 28)}<h3>Verify your email to use Friends</h3>
      <p>${sent ? `We sent a link to <b>${esc(sent)}</b>. Click it, then come back and press Try again.`
        : 'Friends matches people by email, so it needs to know this one is yours. We\'ll email you a link; click it once and you\'re in.'}</p>
      ${friendsVerifyNote ? `<p class="friends-note">${esc(friendsVerifyNote)}</p>` : ''}
      <div class="friends-acts">${sent
        ? '<button class="btn btn-primary" data-friend-act="recheck">Try again</button><button class="btn" data-friend-act="verify">Send again</button>'
        : '<button class="btn btn-primary" data-friend-act="verify">Send verification email</button>'}</div>`;
  }
  const text = g.code === 'signed-out' ? FRIENDS_COPY['signed-out'] : g.error;
  const signIn = g.code === 'signed-out' || g.code === 'reauth';
  return `${svgIcon('users', 28)}<h3>${esc(text)}</h3>${signIn ? '<button class="btn btn-primary" data-friend-act="signin">Sign in</button>' : ''}`;
}
function friendsRequestsHtml(d: FriendsList): string {
  const incoming = d.incoming.map(r => `<div class="friends-row">${friendAvatarHtml(r.name, r.email, r.avatar)}
      <div class="friends-txt"><b>${esc(r.name || r.email)}</b>${r.name ? `<span>${esc(r.email)}</span>` : ''}</div>
      <div class="friends-acts"><button class="btn btn-sm btn-primary" data-friend-act="accept" data-id="${escAttr(r.id)}">Accept</button><button class="btn btn-sm" data-friend-act="decline" data-id="${escAttr(r.id)}">Decline</button></div></div>`).join('');
  const sent = d.outgoing.map(r => `<div class="friends-row">${friendAvatarHtml(null, r.email, null)}
      <div class="friends-txt"><b>${esc(r.email)}</b><span>Waiting</span></div>
      <div class="friends-acts"><button class="btn btn-sm" data-friend-act="cancel" data-id="${escAttr(r.id)}">Cancel</button></div></div>`).join('');
  return `${incoming ? `<h3 class="friends-sub">Requests</h3>${incoming}` : ''}${sent ? `<h3 class="friends-sub">Sent</h3>${sent}` : ''}`;
}
function friendsListHtml(d: FriendsList): string {
  if (!d.friends.length) return `<div class="friends-empty">${svgIcon('users', 28)}<p>Add a friend by email to see what they're building.</p></div>`;
  const rows = sortFriends(d.friends).map(f => `<div class="friends-row" data-state="${f.state}">${friendAvatarHtml(f.name, f.email, f.avatar, f.state)}
      <div class="friends-txt"><b>${esc(f.name)}</b><span>${friendStatusLine(f, d.readTime)}</span></div>
      <button class="icon-btn friends-more" data-friend-act="more" data-id="${escAttr(f.uid)}" title="More" aria-label="${escAttr(`More for ${f.name}`)}" aria-haspopup="menu">${svgIcon('more', 16)}</button></div>`).join('');
  return `<h3 class="friends-sub">Friends</h3>${rows}`;
}
// The dot on the Home rail button: incoming requests waiting.
function friendsBadge(n: number): void {
  const badge = $('#friendsBadge');
  badge.classList.toggle('hidden', !n);
  badge.closest('button')?.setAttribute('aria-label', n ? `Friends, ${plural(n, 'request')} waiting` : 'Friends');
}
function renderFriends(): void {
  const g = friendsGate;
  const hard = !!g && g.code !== 'network'; // nothing to show but the reason
  const d = hard ? null : friendsData;
  const parts = [g ? friendsStateHtml(g) : '', d ? friendsRequestsHtml(d) : '', d ? friendsListHtml(d) : ''];
  friendsBadge(d?.incoming.length ?? 0);
  const key = `${hard}|${parts.join('|')}`;
  if (key === friendsShown) return; // a poll that changed nothing leaves the rows (and a hovered one) be
  friendsShown = key;
  $('#friendsAdd').classList.toggle('hidden', hard);
  if (hard) friendsSay('');
  const st = $('#friendsState');
  st.innerHTML = parts[0];
  st.classList.toggle('hidden', !g);
  st.classList.toggle('friends-gate', hard);
  $('#friendsRequests').innerHTML = parts[1];
  $('#friendsRequests').classList.toggle('hidden', !parts[1]);
  $('#friendsList').innerHTML = parts[2];
  $('#friendsList').classList.toggle('hidden', !d);
}

/* ----- Loading and polling ----- */
const friendsVisible = () => friendsOpen && $('.home-view[data-view="friends"]').getClientRects().length > 0;
function scheduleFriends(): void {
  clearTimeout(friendsTimer);
  if (friendsConfigured === false) return; // this build has no Firebase config; that doesn't change while it runs
  // On screen, the whole list; hidden, only the request count for the badge (one query, not the list and presence).
  const open = friendsVisible();
  friendsTimer = setTimeout(() => void (open ? refreshFriends() : refreshFriendsBadge()), open ? FRIENDS_POLL_OPEN : FRIENDS_POLL_HIDDEN);
}
// Main asks for the status first (and fails it the same way list() would), so a gate still shows up here.
const friendsGateOf = (st: FriendsStatus): FriendsFail | null => (!st.configured ? { error: FRIENDS_COPY['not-configured'], code: 'not-configured' }
  : !st.signedIn ? { error: FRIENDS_COPY['signed-out'], code: 'signed-out' }
    : st.error ? { error: st.error, code: st.code ?? null } : null);
const friendsStatusOf = (fresh = false) => api.friends.status(fresh).catch((e: unknown) => ({ configured: true, signedIn: true, email: null, provider: null, ...friendsFailOf(e) }) as FriendsStatus);
// The hidden poll: only the badge. A failure other than the network is shown like the full refresh would show it.
async function refreshFriendsBadge(): Promise<void> {
  const seq = ++friendsSeq;
  clearTimeout(friendsTimer);
  try {
    const st = await friendsStatusOf();
    if (seq !== friendsSeq) return;
    friendsConfigured = st.configured;
    const gate = friendsGateOf(st);
    const r = gate ?? await api.friends.incoming().catch(friendsFailOf);
    if (seq !== friendsSeq) return;
    if (!isFriendsFail(r)) { friendsBadge(r.count); return; }
    if (r.code === 'network') return; // the badge stays as it was; the next poll tries again
    friendsData = null;
    friendsGate = r;
    renderFriends();
  } finally {
    if (seq === friendsSeq) scheduleFriends();
  }
}
// `fresh` asks main to forget a held failure and sign in again (Try again, after clicking the verification link).
async function refreshFriends(fresh = false): Promise<void> {
  const seq = ++friendsSeq;
  clearTimeout(friendsTimer);
  try {
    const st = await friendsStatusOf(fresh);
    if (seq !== friendsSeq) return;
    friendsConfigured = st.configured;
    let gate = friendsGateOf(st);
    if (!gate) {
      const r = await api.friends.list().catch(friendsFailOf);
      if (seq !== friendsSeq) return;
      if (isFriendsFail(r)) gate = r;
      else friendsData = r;
    }
    if (gate && gate.code !== 'network') friendsData = null; // another account's (or no account's) list never lingers
    if (gate?.code !== 'unverified') { friendsVerifySent = null; friendsVerifyNote = ''; }
    else if (fresh && friendsVerifySent) friendsVerifyNote = "Still not verified. Check your inbox (and spam) for the link from Firebase.";
    if (!gate && friendsGate?.code === 'unverified') queueFriendsPresence(); // just verified: start sharing now
    friendsGate = gate;
    renderFriends();
  } finally {
    if (seq === friendsSeq) scheduleFriends();
  }
}
function openFriends(): void {
  friendsOpen = true;
  renderFriends();
  void refreshFriends();
}
function closeFriends(): void {
  if (!friendsOpen) return;
  friendsOpen = false;
  scheduleFriends(); // back to the slow, badge-only pace
}
// Signed in, out, or to another account: forget the old list and look again as the new one. Main stops sharing on any
// account change (and refuses presence mid-switch), so this account's presence is sent afresh.
function friendsAccountChanged(): void {
  friendsData = null; friendsGate = null;
  renderFriends();
  void refreshFriends();
  queueFriendsPresence();
}

/* ----- Sharing my presence ----- */
let friendsAway = false; // the window lost focus and nothing was typed or clicked for 5 minutes
let friendsPresenceTimer: TimeoutId | undefined;
// What friends see: a working agent wins, then debugging, Breeze Space, an open file, else idle. The project is only
// the open folder's name, and only when Show my project name is on.
function friendsActivity(): FriendsPresence {
  let activity: FriendActivity = 'idle';
  if (Object.values(agentsDef).some(a => a.status === 'working')) activity = 'agent';
  else if (debugLive) activity = 'debug';
  else if (appState.mode === 'box') activity = 'space';
  else if (active) activity = 'editing';
  const project = appState.friendsProject ? rootInfo?.name.slice(0, 80) ?? null : null;
  return { state: friendsAway ? 'away' : 'online', project, activity };
}
// Coalesced over 1.2 s; main throttles the writes and heartbeats. Sharing off sends null, which writes "offline" once.
function queueFriendsPresence(): void {
  clearTimeout(friendsPresenceTimer);
  friendsPresenceTimer = setTimeout(() => {
    if (!user || friendsConfigured === false) return;
    void api.friends.setPresence(appState.friendsShare ? friendsActivity() : null).catch(() => undefined);
  }, 1200);
}
function setFriendsAway(away: boolean): void {
  if (away === friendsAway) return;
  friendsAway = away;
  queueFriendsPresence();
}

/* ----- Adding, answering and removing ----- */
function friendsSay(text: string, bad = false): void {
  const msg = $('#friendsMsg');
  msg.textContent = text;
  msg.classList.toggle('bad', bad);
}
$('#friendsEmail').oninput = () => friendsSay('');
$('#friendsAdd').onsubmit = e => {
  e.preventDefault();
  const input = $<HTMLInputElement>('#friendsEmail');
  const email = input.value.trim();
  if (!email) { input.focus(); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { friendsSay(FRIENDS_COPY['invalid-email'], true); return; }
  const btn = $<HTMLButtonElement>('button[type="submit"]', $('#friendsAdd'));
  btn.disabled = true;
  void api.friends.add(email).catch(friendsFailOf).then(r => {
    btn.disabled = false;
    if (isFriendsFail(r)) {
      // An add that is never retried by itself doesn't say "Retrying…".
      friendsSay(r.code === 'network' ? "Couldn't reach Friends. Check your connection and try again." : FRIENDS_COPY[r.code ?? ''] ?? r.error, true);
      if (r.code === 'signed-out' || r.code === 'reauth' || r.code === 'not-configured') void refreshFriends();
      return;
    }
    input.value = '';
    friendsSay("Request sent. They'll see it next time they open Breeze.");
    void refreshFriends();
  });
};
const friendsView = () => $('.home-view[data-view="friends"]');
const friendsButtons = (act: string) => $$<HTMLButtonElement>(`[data-friend-act="${act}"]`, friendsView());
// The rows are redrawn, so the button that had focus is gone: focus goes to the same kind of button in the row that
// took its place (or the one above), else the email field. Only when focus was lost (the page has it) or is still on
// the button that started the action; focus the person moved anywhere else, the email field above all, stays put, so
// an Enter meant for Add can never land on Accept.
function friendsRefocus(act: string, index: number, start: Element | null): void {
  const at = document.activeElement;
  if (at && at !== document.body && at !== start) return;
  if (at && at === $('#friendsEmail')) return;
  if (!friendsView().getClientRects().length) return;
  const same = friendsButtons(act).filter(b => !b.disabled);
  const target = same[Math.min(index, same.length - 1)] ?? $<HTMLInputElement>('#friendsEmail');
  if (target.getClientRects().length) target.focus();
}
async function friendsAct(kind: 'accept' | 'decline' | 'cancel' | 'remove', id: string, btn?: HTMLButtonElement): Promise<void> {
  // Remove starts from the row's "…" button (through its menu and the confirm); the others from their own button.
  const act = kind === 'remove' ? 'more' : kind;
  const index = Math.max(0, friendsButtons(act).findIndex(b => b.dataset.id === id));
  // What has focus as the action starts: its own button, or for Remove, wherever the closed dialog left it.
  const start = btn ?? document.activeElement;
  if (btn) btn.disabled = true;
  const r = await api.friends[kind](id).catch(friendsFailOf);
  if (isFriendsFail(r)) toast(r.error);
  await refreshFriends();
  if (btn?.isConnected) btn.disabled = false;
  friendsRefocus(act, index, start);
}
// Removing is the app's usual confirm dialog: Cancel, and the red button that does it.
function confirmRemoveFriend(f: Friend): void {
  openModal(`<h3>Remove ${esc(f.name)}?</h3><p class="sub">You'll stop seeing each other in Friends. You can send a new request any time.</p>
    <div class="row end"><button class="btn" data-close>Cancel</button><button class="btn btn-danger" id="friendRemoveOk">Remove</button></div>`, m => {
    $('#friendRemoveOk', m).onclick = () => { closeModal(); void friendsAct('remove', f.uid); };
  });
}
function openFriendMenu(anchor: HTMLElement, f: Friend): void {
  if (anchor.classList.contains('open') || (justClosedTrigger === anchor && Date.now() - justClosedAt < 350)) { closeMenu(); return; }
  closeMenu();
  const r = anchor.getBoundingClientRect();
  popupMenu(r.left, r.bottom + 4, [{ label: 'Remove', run: () => confirmRemoveFriend(f) }], undefined, anchor);
}
// Has Firebase email this account a verification link (or find it verified already).
async function friendsSendVerify(b: HTMLButtonElement): Promise<void> {
  b.disabled = true;
  const r = await api.friends.verify().catch(friendsFailOf);
  if (isFriendsFail(r)) { friendsVerifyNote = r.error; renderFriends(); b.disabled = false; return; }
  if ('verified' in r) { void refreshFriends(true); return; }
  friendsVerifySent = r.email ?? 'your email';
  friendsVerifyNote = '';
  renderFriends();
  $<HTMLButtonElement>('[data-friend-act="recheck"]')?.focus();
}
// A picture that fails to load (expired, offline) becomes the initial rather than a broken-image glyph.
friendsView().addEventListener('error', e => {
  const img = e.target;
  if (img instanceof HTMLImageElement && img.classList.contains('friends-pic')) img.outerHTML = friendInitialHtml(img.dataset.initial ?? '?');
}, true);
friendsView().addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-friend-act]');
  if (!b) return;
  const act = b.dataset.friendAct, id = b.dataset.id ?? '';
  if (act === 'signin') addAccount();
  else if (act === 'verify') void friendsSendVerify(b);
  else if (act === 'recheck') void refreshFriends(true);
  else if (act === 'more') { const f = friendsData?.friends.find(x => x.uid === id); if (f) openFriendMenu(b, f); }
  else if (act === 'accept' || act === 'decline' || act === 'cancel') void friendsAct(act, id, b);
});
