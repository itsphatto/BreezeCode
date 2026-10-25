/* ================= App state (survives reloads) ================= */
type WorkMode = 'ide' | 'box';
interface AppState {
  onboarded: boolean; step: number; user: User | null; agent: string | null; detect: Detection | null;
  vibeArmed: boolean; vibeSites: string[]; vibeSite: string | null; mode: WorkMode;
  discord: boolean; discordDetails: boolean; devMode: boolean;
}
const appState: AppState = {
  onboarded: false, step: 0, user: null, agent: null, detect: null, vibeArmed: false, vibeSites: [], vibeSite: null, mode: 'ide',
  discord: false, discordDetails: true, devMode: false,
  ...store.get<Partial<AppState>>('breeze.app', {}),
};
const saveApp = () => store.set('breeze.app', appState);

/* ================= Onboarding: welcome → login → agent → mode ================= */
const STEP = { welcome: 0, signIn: 1, agent: 2, mode: 3 };
let step = Math.min(appState.step, STEP.mode);
let user: User | null = appState.user;
function goStep(n: number): void {
  step = n; appState.step = n; saveApp();
  $$('.ob-step').forEach(s => s.classList.toggle('hidden', Number(s.dataset.step) !== n));
  $$('.ob-dots span').forEach((d, i) => { d.classList.toggle('on', i === n); d.classList.toggle('back', i < n); });
  if (n === STEP.agent) detectTools().catch(() => { /* the agent card shows the error */ });
  if (n === STEP.mode) renderModeChoice();
  // Past the welcome the photo stays up for the rest of setup (also after a restart mid-setup).
  if (n > STEP.welcome) revealBackdrop();
}
$$('[data-next]').forEach(b => b.onclick = () => goStep(step + 1));

/* Welcome: Start breezing ripples the photo out from the button while sign-in comes in, then leaves it fully open. */
const RIPPLE_MS = 1400;
const obBg = $('#obBg'), obWave = $('#obWave');
let rippleFrame = 0;
// Opens the photo at once, unless a ripple is still spreading (that opens it when it finishes).
function revealBackdrop(): void {
  if (!rippleFrame) obBg.classList.add('revealed');
}
function rippleBackdrop(from: HTMLElement): void {
  if (obBg.classList.contains('revealed') || rippleFrame) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { obBg.classList.add('revealed'); return; }
  const box = $('#onboard').getBoundingClientRect(), btn = from.getBoundingClientRect();
  const cx = btn.left + btn.width / 2 - box.left, cy = btn.top + btn.height / 2 - box.top;
  const far = Math.hypot(Math.max(cx, box.width - cx), Math.max(cy, box.height - cy)) + 90;
  for (const el of [obBg, obWave]) { el.style.setProperty('--rx', `${cx}px`); el.style.setProperty('--ry', `${cy}px`); }
  const t0 = performance.now();
  const tick = (now: number) => {
    const p = Math.min(1, (now - t0) / RIPPLE_MS);
    // Eases out like a ripple on water: a quick push from the button that slows as it reaches the edges.
    const r = far * (1 - (1 - p) ** 3);
    for (const el of [obBg, obWave]) el.style.setProperty('--r', `${r}px`);
    obWave.style.setProperty('--wave', String(1 - p));
    if (p < 1) { rippleFrame = requestAnimationFrame(tick); return; }
    rippleFrame = 0;
    obBg.classList.add('revealed');
  };
  rippleFrame = requestAnimationFrame(tick);
}
$('#obStart').onclick = e => { rippleBackdrop(e.currentTarget as HTMLElement); goStep(STEP.signIn); };
// The dots before the current one take you back to that step.
$$('.ob-dots span').forEach((d, i) => {
  d.onclick = () => { if (i < step) goStep(i); };
  d.setAttribute('aria-label', `Step ${i + 1}`);
});

/* ----- Accounts ----- */
function setUser(u: User | null): void {
  user = u; appState.user = u; saveApp();
  renderUser();
}
const initialsOf = (name: string) => name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
function avatarHtml(u: User | null, title: string): string {
  const name = u?.name ?? 'You';
  if (u?.avatar) return `<img class="avatar" src="${escAttr(u.avatar)}" alt="" title="${escAttr(title)}">`;
  return `<span class="avatar tint-host" title="${escAttr(title)}">${esc(initialsOf(name))}</span>`;
}
function renderUser(): void {
  const title = user ? `${user.name} · ${user.provider}` : 'Not signed in';
  $('#avatars').innerHTML = avatarHtml(user, title);
  $('#boxAvatar').innerHTML = avatarHtml(user, title);
  $('#userChip').textContent = user ? `● ${user.name} · ${user.provider}` : 'Not signed in';
}
let accounts: Accounts = { accounts: [], active: null };
const accountKey = (u: User) => `${u.provider}:${u.login ?? ''}`;
async function refreshAccounts(): Promise<void> {
  accounts = await api.auth.accounts().catch(() => accounts);
}
async function switchAccount(a: User): Promise<void> {
  if (accountKey(a) === accounts.active) return;
  setUser(await api.auth.switchTo(accountKey(a)));
  await refreshAccounts();
  toast(`Switched to ${a.name}`);
}
async function signOut(): Promise<void> {
  const next = await api.auth.signOut();
  setUser(next);
  await refreshAccounts();
  toast(next ? `Signed out — now using ${next.name}` : 'Signed out');
}
// Forgets a remembered account; forgetting the active one moves to the next.
async function removeAccount(a: User): Promise<void> {
  const wasActive = accountKey(a) === accounts.active;
  const next = await api.auth.remove(accountKey(a));
  if (wasActive) setUser(next);
  await refreshAccounts();
  toast(`Removed ${a.email ?? a.name}`);
}
// The hold-to-delete trash button (same as the branch picker's), used for anything that's hard to undo.
const holdDelHtml = (label: string, attrs = '', tag: 'button' | 'span' = 'button') =>
  `<${tag} class="br-del" ${tag === 'span' ? 'role="button" tabindex="0" ' : ''}${attrs} title="Hold for 5 seconds to remove" aria-label="Hold for 5 seconds to remove ${escAttr(label)}">${svgIcon('trash', 14)}</${tag}>`;
function accountItems(): MenuItem[] {
  const list: MenuItem[] = accounts.accounts.map(a => ({
    label: a.name, key: a.provider, checked: () => accountKey(a) === accounts.active, run: () => background(switchAccount(a)),
    remove: () => background(removeAccount(a)),
  }));
  return [...list, ...(list.length ? [{ sep: true }] : []), { label: 'Add account', run: addAccount }];
}
// Clicking your picture: who you are, your other accounts (in a submenu) and signing out.
function openAccountMenu(anchor: HTMLElement): void {
  if (anchor.classList.contains('open') || (justClosedTrigger === anchor && Date.now() - justClosedAt < 350)) {
    closeMenu();
    return;
  }
  closeMenu();
  anchor.classList.add('open');
  const r = anchor.getBoundingClientRect();
  const items: MenuItem[] = user
    ? [{ header: user }, { label: 'Accounts', sub: accountItems }, { sep: true }, ...syncMenuItems(), { sep: true }, { label: 'Sign Out', run: () => background(signOut()) }]
    : [{ label: 'Sign in', run: addAccount }, ...(accounts.accounts.length ? [{ label: 'Accounts', sub: accountItems }] : [])];
  popupMenu(r.right, r.bottom + 6, items, () => anchor.classList.remove('open'), anchor);
  const m = $('#menuRoot .menu');
  if (m) {
    m.classList.add('account-menu');
    m.style.left = `${Math.max(8, r.right - m.offsetWidth)}px`;
  }
}
for (const id of ['#avatars', '#boxAvatar']) {
  $(id).onclick = e => {
    const anchor = e.currentTarget as HTMLElement;
    if (anchor.classList.contains('open') || (justClosedTrigger === anchor && Date.now() - justClosedAt < 350)) {
      closeMenu();
      return;
    }
    background(refreshAccounts().then(() => openAccountMenu(anchor)));
  };
}

/* ----- Sign in (GitHub device flow / Google loopback, handled in main.js) ----- */
// The onboarding step and the "Add account" dialog share this panel; signinRoot is the one in use.
const SIGNIN_PANEL = `<div class="signin-btns" data-si="choices">
    <button class="btn" data-signin="GitHub"><svg width="18" height="18"><use href="#i-gh"/></svg>Continue with GitHub</button>
    <button class="btn" data-signin="Google"><img src="../../assets/icons/google.png" width="18" height="18" alt="Google">Continue with Google</button>
    <p class="signin-error hidden" data-si="error" role="alert"></p>
  </div>
  <div class="waiting hidden" data-si="wait">
    <div class="spinner"></div><div data-si="msg">Waiting for your browser</div>
    <div class="device-code hidden" data-si="code"><span data-si="codeText"></span><button class="btn btn-sm" data-si="copy">Copy</button><button class="btn btn-sm" data-si="openPage">Open page ${svgIcon('external', 12)}</button></div>
    <button class="btn btn-sm" data-si="cancel">Cancel</button>
  </div>`;
const onboardSignin = $('#obSignin');
let signinRoot = onboardSignin;
const si = (part: string) => $(`[data-si="${part}"]`, signinRoot);
function signinView(waiting: boolean): void {
  si('choices').classList.toggle('hidden', waiting);
  si('wait').classList.toggle('hidden', !waiting);
  if (waiting) { si('error').classList.add('hidden'); si('code').classList.add('hidden'); }
}
function signinError(text: string): void {
  signinView(false);
  si('error').textContent = text;
  si('error').classList.remove('hidden');
}
async function startSignIn(provider: string): Promise<void> {
  signinView(true);
  si('msg').textContent = `Opening ${provider} in your browser`;
  const r = await api.auth.start(provider).catch((e: unknown) => ({ error: errMsg(e) }) as { error?: string });
  if (r.error === 'not-configured') {
    signinError(`Looks like ${provider} login isn't hooked up yet! Grab a Client ID, add it to .env (or breeze.config.json — there's an example config to help), and give Breeze a restart. Or, skip it for now and jump right in.`);
  } else if (r.error) signinError(r.error);
}
function bindSignin(root: HTMLElement): void {
  $$('[data-signin]', root).forEach(b => b.onclick = () => void startSignIn(b.dataset.signin ?? 'GitHub'));
  $('[data-si="cancel"]', root).onclick = () => { background(api.auth.cancel()); signinView(false); };
  $('[data-si="copy"]', root).onclick = () => background(navigator.clipboard.writeText(si('codeText').textContent ?? '').then(() => toast('Code copied')));
}
bindSignin(onboardSignin);
$('#signinSkip').onclick = () => goStep(STEP.agent);
function addAccount(): void {
  openModal(`<h3>Add an account</h3><p class="sub">Sign in with another GitHub or Google account. Switch between accounts from your picture in the title bar.</p><div class="signin-modal">${SIGNIN_PANEL}</div>`, m => {
    signinRoot = $('.signin-modal', m);
    bindSignin(signinRoot);
  }, () => {
    if (!si('wait').classList.contains('hidden')) background(api.auth.cancel());
    signinRoot = onboardSignin;
  });
}
api.auth.onEvent(ev => {
  if (ev.t === 'code') {
    si('msg').textContent = 'Enter this code on the GitHub page that just opened:';
    si('codeText').textContent = ev.code ?? '';
    si('code').classList.remove('hidden');
    si('openPage').onclick = () => background(api.sys.openExternal(ev.uri ?? 'https://github.com/login/device'));
  } else if (ev.t === 'waiting') {
    si('msg').textContent = `Finish signing in with ${ev.provider} in your browser`;
  } else if (ev.t === 'done' && ev.user) {
    setUser(ev.user);
    signinView(false);
    background(refreshAccounts());
    toast(`Signed in as ${ev.user.name}`);
    background(afterSignIn());
    if (signinRoot === onboardSignin) { if (!appState.onboarded && step === STEP.signIn) goStep(STEP.agent); }
    else closeModal();
  } else if (ev.t === 'error') signinError(ev.text ?? 'Sign-in failed');
});

