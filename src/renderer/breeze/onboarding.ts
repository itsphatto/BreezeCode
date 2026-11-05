/* ================= App state (survives reloads) ================= */
type WorkMode = 'ide' | 'box';
interface AppState {
  onboarded: boolean; step: number; name: string | null; termsAcceptedAt: number | null;
  user: User | null; agent: string | null; detect: Detection | null;
  vibeArmed: boolean; vibeSites: string[]; vibeSite: string | null; mode: WorkMode;
  discord: boolean; discordDetails: boolean; devMode: boolean;
}
const savedApp = store.get<Partial<AppState>>('breeze.app', {});
const appState: AppState = {
  onboarded: false, step: 0, name: null, termsAcceptedAt: null, user: null, agent: null, detect: null, vibeArmed: false, vibeSites: [], vibeSite: null, mode: 'ide',
  discord: false, discordDetails: true, devMode: false,
  ...savedApp,
};
// A save from before the name screen has no `name` (every save since does) and counts the later steps one lower.
if (savedApp.name === undefined && savedApp.step) appState.step++;
const saveApp = () => store.set('breeze.app', appState);
// The blue app icon, or in developer mode the flipped one (white tile, blue wind).
const appIcon = () => `../../assets/brand/${appState.devMode ? 'IconDev' : 'Icon'}.png`;

/* ================= Onboarding: welcome → name → account → preferences (and agent) → home ================= */
// Home is also where every later launch lands (see init.ts).
const STEP = { welcome: 0, name: 1, signIn: 2, agent: 3, home: 4 };
let step = Math.min(appState.step, STEP.home);
let user: User | null = appState.user;
// Who to greet: the name they gave us wins over the one their account came with.
const displayName = () => appState.name || user?.name || null;
const nameInput = $<HTMLInputElement>('#obName'), nameNext = $<HTMLButtonElement>('#obNameNext');
const termsBox = $<HTMLInputElement>('#obTerms'), accountNext = $<HTMLButtonElement>('#obAccountNext');
$$<HTMLImageElement>('.ob-icon').forEach(i => { i.src = appIcon(); });
function goStep(n: number): void {
  // Hidden sections can't be measured, so the logo's old spot is read before they swap (mid-flight: where it is on screen).
  const prev = step, oldLogo = stepLogo(prev);
  const from = oldLogo?.getClientRects().length ? oldLogo.getBoundingClientRect() : null;
  stopObMotion();
  step = n; appState.step = n; saveApp();
  $$('.ob-step').forEach(s => s.classList.toggle('hidden', Number(s.dataset.step) !== n));
  $$('.ob-dots span').forEach((d, i) => {
    d.classList.toggle('on', i === n); d.classList.toggle('back', i < n); d.tabIndex = i < n ? 0 : -1;
    d.setAttribute('aria-disabled', String(i >= n));
    if (i === n) d.setAttribute('aria-current', 'step'); else d.removeAttribute('aria-current');
  });
  if (n === STEP.name || n === STEP.signIn) $$<HTMLImageElement>('.ob-icon').forEach(i => { i.src = appIcon(); }); // developer mode may have flipped it
  if (n === STEP.name) { nameInput.value = (displayName() ?? '').slice(0, 40).replace(/[\uD800-\uDBFF]$/, ''); syncNameNext(); } // the cut mustn't split an emoji
  if (n === STEP.signIn) { renderConnected(); termsBox.checked = !!appState.termsAcceptedAt; syncAccountNext(); }
  if (n === STEP.agent) {
    renderObPrefs(); // settings.ts
    detectTools().catch(() => { /* the agent card shows the error */ });
  }
  if (n === STEP.home) renderHome();
  // Once set up, Home is a screen of its own rather than a setup step, so the progress dots go.
  $('#onboard').classList.toggle('settled', appState.onboarded);
  playStep(prev, n, oldLogo, from);
}
$$('[data-next]').forEach(b => b.onclick = () => goStep(step + 1));

/* ----- Motion between setup steps: going forward the heading or form flies in on a curve, the logo glides between
   its spots on any change, going back everything else just fades. ----- */
const OB_SOFT = 'cubic-bezier(.16, 1, .3, 1)';
const OB_CURVE = 'cubic-bezier(.22, .72, .2, 1)'; // softer off the mark than OB_SOFT, or the curve is over before it's seen
const stepEl = (n: number) => $(`.ob-step[data-step="${n}"]`);
const stepLogo = (n: number) => stepEl(n).querySelector<HTMLImageElement>('.ob-logo, .ob-icon');
const motionOff = () => document.documentElement.classList.contains('win-jump') || matchMedia('(prefers-reduced-motion: reduce)').matches;
let obAnims: Animation[] = [], obGhost: HTMLElement | null = null;
function stopObMotion(): void {
  obAnims.forEach(a => a.cancel());
  obAnims = [];
  obGhost?.remove();
  obGhost = null;
  $('#onboard').classList.remove('ob-flying');
}
const obAnim = (el: Element, frames: Keyframe[], options: KeyframeAnimationOptions) => { obAnims.push(el.animate(frames, { fill: 'backwards', ...options })); };
const riseIn = (el: Element, delay = 0) => obAnim(el, [{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }], { duration: 560, delay, easing: OB_SOFT });
// Flies el into its place along a curve given relative to that place (the last point is always 0,0), fading in on the way.
function curveIn(el: Element, p0: CurvePoint, p1: CurvePoint, p2: CurvePoint, duration: number): void {
  const n = 40, pts = curveFrames(p0, p1, p2, { x: 0, y: 0 }, n);
  obAnim(el, pts.map((p, i) => ({ transform: `translate(${p.x}px, ${p.y}px)`, opacity: Math.min(1, i / n * 2.2) })), { duration, easing: OB_CURVE });
}
// The logo travels from its old spot to its new one. When the picture differs, or there's no new spot, a copy of the old
// one travels along and fades out over the new.
function glideLogo(logo: HTMLImageElement | null, old: HTMLImageElement, from: DOMRect): void {
  const to = logo?.getBoundingClientRect() ?? from, same = logo?.src === old.src;
  const dx = from.left + from.width / 2 - to.left - to.width / 2, dy = from.top + from.height / 2 - to.top - to.height / 2, scale = from.width / to.width;
  const timing = { duration: 760, easing: OB_SOFT };
  if (logo) obAnim(logo, [{ transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: same ? 1 : 0 }, { transform: 'none', opacity: 1 }], timing);
  if (same) return;
  const ghost = obGhost = old.cloneNode() as HTMLImageElement;
  ghost.className = 'ob-ghost';
  ghost.alt = '';
  Object.assign(ghost.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
  $('#onboard').append(ghost);
  ghost.animate([{ transform: 'none', opacity: 1 }, { transform: `translate(${-dx}px, ${-dy}px) scale(${1 / scale})`, opacity: 0 }], { ...timing, fill: 'forwards' })
    .onfinish = () => ghost.remove();
}
function playStep(prev: number, n: number, oldLogo: HTMLImageElement | null, from: DOMRect | null): void {
  const el = stepEl(n), logo = stepLogo(n);
  const settled = () => {
    $('#onboard').classList.remove('ob-flying');
    syncDots();
    if (n === STEP.name) { nameInput.focus({ preventScroll: true }); nameInput.setSelectionRange(nameInput.value.length, nameInput.value.length); }
    // What had focus just went away with the old screen; a keyboard or screen reader user lands on the new one.
    else if (!el.contains(document.activeElement)) el.querySelector<HTMLElement>('h1, h2')?.focus({ preventScroll: true });
  };
  if (prev !== n && !appState.onboarded && !motionOff()) {
    $('#onboard').classList.add('ob-flying');
    if (n !== STEP.home) el.getAnimations({ subtree: true }).forEach(a => a.cancel()); // coming back to the welcome replays its intro otherwise
    if (oldLogo && from) glideLogo(logo, oldLogo, from);
    else if (logo) obAnim(logo, [{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' }); // no logo on the screen it came from
    if (n !== STEP.home) {
      if (n < prev) {
        // Each card fades itself: one fading inside a parent loses its blurred backdrop until the fade ends.
        el.querySelectorAll(':scope > :not(.ob-logo, .ob-icon, .setup-grid), .setup-card').forEach(c => obAnim(c, [{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' }));
      } else if (n === STEP.name) {
        const h = $('h2', el), x = -(h.getBoundingClientRect().right + 40), y = Math.min(innerHeight * .22, 150);
        curveIn(h, { x, y }, { x: x * .62, y: y * .38 }, { x: x * .28, y: 0 }, 860);
        riseIn($('.ob-field', el), 240);
        riseIn(nameNext, 320);
      } else if (n === STEP.signIn) {
        // Up from below the window, bowing out through the left gutter where it can be seen, then level into place.
        const form = $('.ob-form', el), r = form.getBoundingClientRect(), x = -r.left;
        curveIn(form, { x: x * .7, y: innerHeight - r.top }, { x: x * 1.05, y: innerHeight * .3 }, { x: x * .6, y: 0 }, 880);
      } else {
        el.querySelectorAll(':scope > :not(.setup-grid), .setup-card').forEach((c, i) => riseIn(c, i * 50));
      }
    }
  }
  if (obAnims.length) Promise.all(obAnims.map(a => a.finished)).then(settled, () => { /* a newer step took over */ });
  else settled();
}

/* ----- Name ----- */
function syncNameNext(): void { nameNext.disabled = !nameInput.value.trim(); }
nameInput.oninput = syncNameNext;
$('#obNameForm').onsubmit = e => {
  e.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;
  appState.name = name;
  goStep(STEP.signIn);
};
// While the onboarding screen (and so Home) is up, the window buttons sit straight on its backdrop and draw light.
function syncTitleBar(): void {
  const ob = $('#onboard');
  const on = !ob.classList.contains('hidden') && !ob.classList.contains('screen-out') && !ob.classList.contains('screen-prep');
  document.documentElement.classList.toggle('clear-bar', on);
}
new MutationObserver(syncTitleBar).observe($('#onboard'), { attributes: true, attributeFilter: ['class'] });
syncTitleBar();

// The dots before the current one take you back to that step.
$$('.ob-dots span').forEach((d, i) => {
  d.onclick = () => { if (i < step) goStep(i); };
  d.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); d.click(); } };
  d.setAttribute('role', 'button');
  d.setAttribute('aria-label', `Step ${i + 1}: ${['Welcome', 'Your name', 'Account', 'Make it yours', 'Home'][i]}`);
});
// Nothing here has a double-click, and the first click may have changed the screen: the second would land on whatever
// is now under the pointer (a theme, a new file).
$('#onboard').addEventListener('click', e => { if (e.detail > 1) { e.preventDefault(); e.stopPropagation(); } }, true);

/* ----- Accounts ----- */
function setUser(u: User | null): void {
  user = u; appState.user = u; saveApp();
  renderUser();
}
const initialsOf = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(w => [...w][0] ?? '').join('').toUpperCase(); // by code point: w[0] splits an emoji
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
  renderHomeProfile();
  renderConnected();
}
// Home's account button (picture, name and email, or an invitation to sign in) and its greeting.
let homeProfileHtml = '';
function renderHomeProfile(): void {
  const who = displayName(), first = who?.split(/\s+/)[0];
  // Signed out there is no one to welcome back, so it invites them in instead.
  $('#homeGreet').textContent = (!appState.onboarded ? 'Ready when you are' : first ? 'Welcome Back' : 'Welcome to Breeze') + (first ? ',' : '');
  $('#homeLead').textContent = !appState.onboarded ? 'Open a project to start building.'
    : first ? timeGreeting()
    : 'Sign in to bring your name and picture along, or just open a project.';
  $('#homeName').textContent = first ?? '';
  const btn = $('#homeProfile');
  const pic = user?.avatar ? avatarHtml(user, '') : who ? `<span class="avatar tint-host">${esc(initialsOf(who))}</span>` : `<span class="hp-ico">${svgIcon('user', 15)}</span>`;
  const sub = user ? user.email || user.provider : who ? 'Sign in' : '';
  const html = `${pic}<span class="hp-txt"><span class="nm">${esc(who ?? 'Sign in')}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>`;
  // Opening a project redraws the user; redrawing the same picture flashed it out and back as Home left.
  if (html !== homeProfileHtml) { homeProfileHtml = html; btn.innerHTML = html; }
  btn.setAttribute('aria-label', user ? `${who} · ${user.provider}` : `${who ? `${who}. ` : ''}Sign in with GitHub or Google`);
  // Signed in it opens the account menu; signed out it goes straight to signing in.
  btn.setAttribute('aria-haspopup', user ? 'menu' : 'dialog');
}
// The progress dots sit in the gutter under a step. Once the window is too short for that gutter the step scrolls
// under them, so they go. Every step is watched: each has its own height, and showing one resizes it from nothing.
// Mid-flight nothing can be measured, the flying piece counts as overflow; playStep checks again when it lands.
function syncDots(): void {
  const ob = $('#onboard');
  if (!ob.classList.contains('ob-flying')) ob.classList.toggle('no-dots', ob.scrollHeight > ob.clientHeight);
}
const fitDots = new ResizeObserver(syncDots);
[$('#onboard'), ...$$('.ob-step')].forEach(el => fitDots.observe(el));
let accounts: Accounts = { accounts: [], active: null };
const accountKey = (u: User) => `${u.provider}:${u.login ?? ''}`;
async function refreshAccounts(): Promise<void> {
  accounts = await api.auth.accounts().catch(() => accounts);
  void refreshPrs(); // signing in or out, or switching account, changes what the pull request list can show
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
// The hold-to-delete button (same as the branch picker's), used for anything that's hard to undo.
const holdDelHtml = (label: string, attrs = '', tag: 'button' | 'span' = 'button', icon = 'trash') =>
  `<${tag} class="br-del" ${tag === 'span' ? 'role="button" tabindex="0" ' : ''}${attrs} title="Hold for 5 seconds to remove" aria-label="Hold for 5 seconds to remove ${escAttr(label)}">${svgIcon(icon, 14)}</${tag}>`;
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
for (const id of ['#avatars', '#boxAvatar', '#homeProfile']) {
  $(id).onclick = e => {
    const anchor = e.currentTarget as HTMLElement;
    if (anchor.id === 'homeProfile' && !user) { closeMenu(); addAccount(); return; }
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
    <button class="btn" data-signin="Google"><img src="../../assets/icons/google.png" width="18" height="18" alt="">Continue with Google</button>
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
  const hadFocus = signinRoot.contains(document.activeElement); // the part that has it is about to hide
  si('choices').classList.toggle('hidden', waiting);
  si('wait').classList.toggle('hidden', !waiting);
  if (waiting) { si('error').classList.add('hidden'); si('code').classList.add('hidden'); }
  if (hadFocus) (waiting ? si('cancel') : $('[data-signin]', signinRoot)).focus();
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
// Signed in, the account screen's buttons give way to who they're signed in as.
function renderConnected(): void {
  $('#obSignin').classList.toggle('hidden', !!user);
  const row = $('#obConnected');
  row.classList.toggle('hidden', !user);
  if (user) row.innerHTML = `${avatarHtml(user, '')}<span class="ob-connected-txt"><span>Connected as <b>${esc(user.name)}</b></span><small>${esc(user.provider)}</small></span>`;
}
function syncAccountNext(): void { accountNext.disabled = !termsBox.checked; }
termsBox.onchange = syncAccountNext;
$$<HTMLAnchorElement>('.ob-terms a').forEach(a => a.onclick = e => { e.preventDefault(); background(api.sys.openExternal(a.href)); });
// Both ways on need the box ticked, with or without an account. Leaving mid sign-in drops that sign-in.
function leaveAccount(): void {
  if (!termsBox.checked) {
    termsBox.focus();
    if (!motionOff()) termsBox.animate([{ transform: 'none' }, { transform: 'scale(1.4)' }, { transform: 'none' }], { duration: 360, easing: 'ease-out' });
    return;
  }
  if (!si('wait').classList.contains('hidden')) { background(api.auth.cancel()); signinView(false); }
  appState.termsAcceptedAt ??= Date.now();
  goStep(STEP.agent);
}
$('#signinSkip').onclick = leaveAccount;
accountNext.onclick = leaveAccount;
function addAccount(): void {
  const intro = user
    ? '<h3>Add an account</h3><p class="sub">Sign in with another GitHub or Google account. Switch between accounts from your picture in the title bar.</p>'
    : `<h3>Sign in to Breeze</h3><p class="sub">Your browser opens to finish signing in, then you're back here.</p>`;
  openModal(`${intro}<div class="signin-modal">${SIGNIN_PANEL}</div>`, m => {
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
    background(afterSignIn());
    // On the account screen the row that replaces the buttons says it; the box to tick is what's next.
    if (signinRoot === onboardSignin) { if (!appState.onboarded && step === STEP.signIn) termsBox.focus(); }
    else { toast(`Signed in as ${ev.user.name}`); closeModal(); }
  } else if (ev.t === 'error') signinError(ev.text ?? 'Sign-in failed');
});


// Hover icons (breeze.css, .icon-live): the loop runs while the pointer is on the button; leaving eases the icon back
// from its current pose, since dropping a CSS animation snaps it home.
const ICON_HOVER = '#onboard .recent-forget, #onboard .recent-open, #onboard .btn, #homeProfile, #rescan';
document.addEventListener('pointerover', e => (e.target as Element).closest?.(ICON_HOVER)?.classList.add('icon-live'));
document.addEventListener('pointerout', e => {
  const b = (e.target as Element).closest?.(ICON_HOVER);
  if (!b?.classList.contains('icon-live') || b.contains(e.relatedTarget as Node | null)) return;
  const svg = b.querySelector('svg');
  const pose = svg ? getComputedStyle(svg).transform : 'none';
  b.classList.remove('icon-live');
  // The ✕ looks the same every quarter turn, so it turns on to the next one and overshoots a little as it lands.
  if (svg && b.matches('.recent-forget')) {
    const m = new DOMMatrix(pose === 'none' ? undefined : pose);
    const from = (Math.atan2(m.b, m.a) * 180 / Math.PI + 360) % 360;
    svg.animate([{ transform: `rotate(${from}deg)` }, { transform: `rotate(${Math.ceil((from + 30) / 90) * 90}deg)` }],
      { duration: 280, easing: 'cubic-bezier(.34, 1.56, .64, 1)' });
  } else if (svg && pose !== 'none') svg.animate([{ transform: pose }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.2, .8, .2, 1)' });
});
