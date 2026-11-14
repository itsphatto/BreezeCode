/* ================= App state (survives reloads) ================= */
type WorkMode = 'ide' | 'box';
interface AppState {
  onboarded: boolean; step: number; name: string | null; termsAcceptedAt: number | null;
  user: User | null; agent: string | null; detect: Detection | null;
  vibeArmed: boolean; vibeSites: string[]; vibeSite: string | null; mode: WorkMode;
  discord: boolean; discordDetails: boolean; devMode: boolean;
  // Friends: share what I'm doing at all, and the open folder's name with it.
  friendsShare: boolean; friendsProject: boolean;
}
const savedApp = store.get<Partial<AppState>>('breeze.app', {});
const appState: AppState = {
  onboarded: false, step: 0, name: null, termsAcceptedAt: null, user: null, agent: null, detect: null, vibeArmed: false, vibeSites: [], vibeSite: null, mode: 'ide',
  discord: false, discordDetails: true, devMode: false, friendsShare: true, friendsProject: true,
  ...savedApp,
};
// A save from before the name screen has no `name` (every save since does) and counts the later steps one lower.
if (savedApp.name === undefined && savedApp.step) appState.step++;
const saveApp = () => store.set('breeze.app', appState);
// The blue app icon, or in developer mode the flipped one (white tile, blue wind).
const appIcon = () => `../../assets/brand/${appState.devMode ? 'IconDev' : 'Icon'}.png`;

/* ================= Onboarding: welcome → name → account → tools → home ================= */
// Home is also where every later launch lands (see init.ts).
const STEP = { welcome: 0, name: 1, signIn: 2, tools: 3, home: 4 };
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
  if (n === STEP.tools) detectTools().catch(() => { /* the tools card shows the error */ });
  if (n === STEP.home) renderHome();
  // Once set up, Home is a screen of its own rather than a setup step, so the progress dots go.
  $('#onboard').classList.toggle('settled', appState.onboarded);
  syncTitleBar(); // Home's title bar is the theme's, setup's is the sky
  playStep(prev, n, oldLogo, from);
}
$$('[data-next]').forEach(b => b.onclick = () => goStep(step + 1));

/* ----- Motion between setup steps: going forward the heading or form flies in on a curve, the logo glides between
   its spots on any change, going back everything else just fades. ----- */
const OB_SOFT = 'cubic-bezier(.16, 1, .3, 1)';
const OB_CURVE = 'cubic-bezier(.22, .72, .2, 1)'; // softer off the mark than OB_SOFT, or the curve is over before it's seen
const stepEl = (n: number) => $(`.ob-step[data-step="${n}"]`);
const stepLogo = (n: number) => stepEl(n).querySelector<HTMLImageElement>('.ob-logo, .ob-icon');
const motionOff = () => document.documentElement.classList.contains('win-jump');
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
// Splits a heading into one box per letter (once), words kept whole so it wraps as before; the heading keeps its
// text for screen readers and the letters are hidden from them.
function letterBoxes(h: HTMLElement): HTMLElement[] {
  if (!h.dataset.split) {
    const text = h.textContent ?? '';
    h.setAttribute('aria-label', text);
    h.textContent = '';
    text.split(/(\s+)/).forEach(part => {
      if (!part) return;
      if (/^\s+$/.test(part)) { h.append(part); return; }
      const word = document.createElement('span');
      word.className = 'ob-word';
      word.setAttribute('aria-hidden', 'true');
      for (const ch of part) {
        const s = document.createElement('span');
        s.className = 'ob-ch';
        s.textContent = ch;
        word.append(s);
      }
      h.append(word);
    });
    h.dataset.split = '1';
  }
  return [...h.querySelectorAll<HTMLElement>('.ob-ch')];
}
// Each letter in turn hops in from the left along a downward parabola: rising, over the top, and down into place.
function lettersIn(h: HTMLElement): void {
  const n = 24, dx = 70, lift = 34;
  letterBoxes(h).forEach((s, i) => {
    const frames: Keyframe[] = [];
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      frames.push({ transform: `translate(${-dx * (1 - t)}px, ${-lift * 4 * t * (1 - t)}px)`, opacity: Math.min(1, t * 2.5) });
    }
    obAnim(s, frames, { duration: 620, delay: i * 24, easing: OB_CURVE });
  });
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
        lettersIn($('h2', el));
        riseIn($('.ob-field', el), 300);
        riseIn(nameNext, 380);
      } else if (n === STEP.signIn) {
        // The title's letters hop in like the name screen's, then the rest rises in under it.
        const form = $('.ob-form', el);
        lettersIn($('h2', form));
        form.querySelectorAll(':scope > :not(h2)').forEach((c, i) => riseIn(c, 300 + i * 60));
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
// While setup is up, the window buttons sit straight on its sky and draw light. Home has a plain title bar of its own,
// like the IDE's, so they keep the theme's colours there.
function syncTitleBar(): void {
  const ob = $('#onboard');
  const on = !ob.classList.contains('hidden') && !ob.classList.contains('screen-out') && !ob.classList.contains('screen-prep')
    && $('.home-step').classList.contains('hidden');
  document.documentElement.classList.toggle('clear-bar', on);
}
new MutationObserver(syncTitleBar).observe($('#onboard'), { attributes: true, attributeFilter: ['class'] });
syncTitleBar();

// The dots before the current one take you back to that step.
$$('.ob-dots span').forEach((d, i) => {
  d.onclick = () => { if (i < step) goStep(i); };
  d.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); d.click(); } };
  d.setAttribute('role', 'button');
  d.setAttribute('aria-label', `Step ${i + 1}: ${['Welcome', 'Your name', 'Account', 'Tools', 'Home'][i]}`);
});
// Nothing here has a double-click, and the first click may have changed the screen: the second would land on whatever
// is now under the pointer (a theme, a new file).
$('#onboard').addEventListener('click', e => { if (e.detail > 1) { e.preventDefault(); e.stopPropagation(); } }, true);

/* ----- Accounts ----- */
function setUser(u: User | null): void {
  user = u; appState.user = u; saveApp();
  renderUser();
  friendsAccountChanged(); // signed in, out or switched: Friends looks again as whoever is active now
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
  // Just the picture, like the IDE's title bar; who it is goes in the tooltip.
  const html = user?.avatar ? avatarHtml(user, '') : who ? `<span class="avatar tint-host">${esc(initialsOf(who))}</span>` : `<span class="avatar hp-ico">${svgIcon('user', 14)}</span>`;
  btn.title = user ? `${who} · ${user.provider}` : 'Sign in';
  // Opening a project redraws the user; redrawing the same picture flashed it out and back as Home left.
  if (html !== homeProfileHtml) { homeProfileHtml = html; btn.innerHTML = html; }
  btn.setAttribute('aria-label', user ? `${who} · ${user.provider}` : `${who ? `${who}. ` : ''}Sign in with GitHub or Google`);
  // Signed in it opens the account menu; signed out it goes straight to signing in.
  btn.setAttribute('aria-haspopup', user ? 'menu' : 'dialog');
  renderHomeContrib();
}

/* ----- Home: the GitHub account's contribution graph ----- */
// Shown only while the signed-in account is a GitHub one. Asked for once per account (main keeps it ten minutes);
// another account, or none, hides it until its own answer lands.
let contribFor: string | null = null;
let contribSeq = 0;
const CONTRIB_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const contribDay = (iso: string) => new Date(`${iso}T00:00:00`);
function renderHomeContrib(): void {
  const box = $('#homeContrib');
  const key = user?.provider === 'GitHub' ? `${user.provider}:${user.login ?? user.name}` : null;
  if (key === contribFor) return;
  contribFor = key;
  box.classList.add('hidden');
  if (!key) return;
  const seq = ++contribSeq;
  background(api.gh.contributions().then(r => {
    if (seq !== contribSeq || !r.ok) return; // signed out meanwhile, or GitHub didn't answer: the graph stays away
    drawContrib(r.data);
    box.classList.remove('hidden');
  }));
}
function drawContrib(c: GhContributions): void {
  $('#homeContribTitle').textContent = `${c.total.toLocaleString()} contribution${c.total === 1 ? '' : 's'} in the last year`;
  const graph = $('#homeContribGraph');
  graph.setAttribute('aria-label', `${c.total} GitHub contributions in the last year`);
  graph.textContent = '';
  // Placed by grid line (set from script: the page's CSP blocks inline style attributes). Column 1 holds the day
  // names, row 1 the month names; a day sits in its week's column and its weekday's row.
  const put = (el: HTMLElement, col: number, row: number) => { el.style.gridColumn = String(col); el.style.gridRow = String(row); graph.append(el); };
  graph.style.setProperty('--weeks', String(c.weeks.length));
  ['Mon', 'Wed', 'Fri'].forEach((d, i) => {
    const s = document.createElement('span');
    s.className = 'cg-wd';
    s.textContent = d;
    put(s, 1, 3 + i * 2);
  });
  let lastMonth = -1;
  c.weeks.forEach((week, w) => {
    const first = contribDay(week[0].date);
    // A month is named over the first week that starts in it, unless it is too near the end to fit its name.
    const m = first.getMonth();
    if (m !== lastMonth && (w > 0 || first.getDate() <= 7) && w < c.weeks.length - 2) {
      const s = document.createElement('span');
      s.className = 'cg-month';
      s.textContent = CONTRIB_MONTHS[m];
      put(s, w + 2, 1);
    }
    lastMonth = m;
    for (const d of week) {
      const day = contribDay(d.date);
      const cell = document.createElement('i');
      cell.className = 'cg-day';
      cell.dataset.l = String(d.level);
      // Only days with something on them get a tip (ui.ts shows it); the graph is one image to screen readers.
      if (d.count) cell.dataset.tooltip = `${d.count} contribution${d.count === 1 ? '' : 's'} on ${day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}`;
      put(cell, w + 2, day.getDay() + 2);
    }
  });
  $('#homeContribOpen').onclick = () => background(api.sys.openExternal(`https://github.com/${encodeURIComponent(c.login)}`));
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
  if (menuWasOpen(anchor)) {
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
    if (menuWasOpen(anchor)) {
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
    <div class="device-code hidden" data-si="code"><span data-si="codeText"></span><button class="btn btn-sm" data-si="copy">Copy</button><button class="btn btn-sm" data-si="openPage">Open page</button></div>
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
  $('#obSkipLine').classList.toggle('hidden', !!user); // signed in, there's nothing to skip
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
    if (!motionOff()) $('.ob-terms .check').animate([{ transform: 'none' }, { transform: 'scale(1.4)' }, { transform: 'none' }], { duration: 360, easing: 'ease-out' });
    return;
  }
  if (!si('wait').classList.contains('hidden')) { background(api.auth.cancel()); signinView(false); }
  appState.termsAcceptedAt ??= Date.now();
  goStep(STEP.tools);
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
    si('msg').textContent = 'Code copied. Paste it on the GitHub page that just opened:';
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
const ICON_HOVER = '#onboard .recent-open, #onboard .btn, #homeProfile, #rescan';
document.addEventListener('pointerover', e => (e.target as Element).closest?.(ICON_HOVER)?.classList.add('icon-live'));
document.addEventListener('pointerout', e => {
  const b = (e.target as Element).closest?.(ICON_HOVER);
  if (!b?.classList.contains('icon-live') || b.contains(e.relatedTarget as Node | null)) return;
  const svg = b.querySelector('svg');
  const pose = svg ? getComputedStyle(svg).transform : 'none';
  b.classList.remove('icon-live');
  if (svg && pose !== 'none') svg.animate([{ transform: pose }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.2, .8, .2, 1)' });
});
