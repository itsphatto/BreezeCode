/* ================= First-run tips ================= */
// The first time someone opens a screen (the editor, Source Control, the Agent Board, Debug, Manage agents), a blue
// bubble points at the one control worth trying there (tipscore.ts has the list). One at a time; it never dims the
// screen or holds the keyboard. ×, Escape and its button close it for good; Skip all tips closes every one. A bubble
// whose control isn't on screen waits for a later visit, and one whose screen is left closes without counting as seen.
// Closed tips are kept in store under breeze.tipsSeen.
let openTip: { id: TipId; el: HTMLElement; target: HTMLElement; frame: number } | null = null;

const loadTips = () => tipsState(store.get<unknown>('breeze.tipsSeen', null));
const saveTips = (s: TipsState) => store.set('breeze.tipsSeen', s);

// On screen: connected, not inside something hidden, and wholly in the window at a usable size (tipscore.ts).
const tipTargetShown = (el: HTMLElement | null): el is HTMLElement =>
  !!el && el.isConnected && !el.closest('.hidden, [hidden]')
  && tipTargetVisible(el.getBoundingClientRect(), { width: innerWidth, height: innerHeight });

// Where the tip's screen is: being left (it fades out, or its dialog closes), still fading in, or under a dialog that
// isn't its own (Settings over the editor). tipSceneAction (tipscore.ts) turns that into show, wait or close.
// A page screen is being left once another one starts fading in over it.
const TIP_SCREENS = '#onboard, #ide, #box, #debug, #board';
function tipScene(target: HTMLElement) {
  const top = topScrim();
  const screen = target.closest<HTMLElement>(TIP_SCREENS);
  const otherIncoming = !!screen && [...document.querySelectorAll<HTMLElement>(TIP_SCREENS)].some(s => s !== screen && s.classList.contains('screen-prep'));
  return {
    leaving: !tipTargetShown(target) || !!target.closest('.screen-out, .scrim.closing') || otherIncoming,
    settling: !!target.closest('.screen-prep'),
    dialogOver: !!top && !top.contains(target),
  };
}

// "Ask an **agent** here" → escaped text with the bold part in <b>.
const tipHtml = (text: string) => text.split('**').map((part, i) => (i % 2 ? `<b>${esc(part)}</b>` : esc(part))).join('');

// Checked every frame for a short while (TIP_OFFER_FRAMES, about 1.5s): a screen lays out unseen and fades in after
// it is opened, and the screen being left may still have its own bubble up. Not ready by then: a later visit.
const TIP_OFFER_FRAMES = 90;
const tipsPending = new Set<TipId>();
function offerTip(id: TipId, act?: () => void): void {
  if (tipsPending.has(id)) return;
  tipsPending.add(id);
  let frames = 0;
  const attempt = () => {
    if (!shouldOffer(loadTips(), id, appState.onboarded) || openTip?.id === id) { tipsPending.delete(id); return; }
    const def = TIPS.find(t => t.id === id);
    const target = def ? document.querySelector<HTMLElement>(def.target) : null;
    if (!openTip && def && tipTargetShown(target) && tipSceneAction(tipScene(target)) === 'show') {
      tipsPending.delete(id);
      showTip(def, target, act);
      return;
    }
    if (++frames < TIP_OFFER_FRAMES) requestAnimationFrame(attempt);
    else tipsPending.delete(id);
  };
  requestAnimationFrame(attempt);
}

function showTip(def: TipDef, target: HTMLElement, act?: () => void): void {
  const id = def.id;
  const el = document.createElement('div');
  el.className = 'tip-bubble';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Tip');
  el.innerHTML = `<i class="tip-arrow" aria-hidden="true"></i>
    <button type="button" class="tip-x" aria-label="Close tip">${svgIcon('x', 14)}</button>
    <p class="tip-text">${tipHtml(def.text)}</p>
    <button type="button" class="tip-act">${svgIcon('play', 13)}<span>${esc(def.action)}</span></button>
    <button type="button" class="tip-skip">Skip all tips</button>`;
  document.body.append(el);
  openTip = { id, el, target, frame: 0 };
  $('.tip-x', el).onclick = () => closeTip(true);
  $('.tip-act', el).onclick = () => { closeTip(true); act?.(); };
  $('.tip-skip', el).onclick = () => { saveTips({ ...loadTips(), skipped: true }); closeTip(true); };
  placeOpenTip();
  if (!motionReduced() && document.documentElement.dataset.power !== 'saver') {
    el.animate([{ opacity: 0, transform: 'scale(.85)', filter: 'blur(3px)' }, { opacity: 1, transform: 'none', filter: 'none' }], { duration: 420, easing: SPRING_BOUNCE });
  }
}

// Follows its control every frame (resizes, panels dragged, scrolling). Hidden while a dialog covers its screen or the
// screen is still fading in; closed, unseen, once its screen is left.
function placeOpenTip(): void {
  const t = openTip;
  if (!t) return;
  const action = tipSceneAction(tipScene(t.target));
  if (action === 'close') { closeTip(false); return; }
  t.el.classList.toggle('tip-wait', action === 'wait');
  t.frame = requestAnimationFrame(placeOpenTip);
  if (action === 'wait') return;
  const r = t.target.getBoundingClientRect();
  const p = placeTip({ left: r.left, top: r.top, width: r.width, height: r.height }, { width: t.el.offsetWidth, height: t.el.offsetHeight }, { width: innerWidth, height: innerHeight });
  t.el.style.left = `${p.left}px`;
  t.el.style.top = `${p.top}px`;
  t.el.style.setProperty('--arrow-x', `${p.arrowX}px`);
  t.el.dataset.side = p.side;
}

function closeTip(seen: boolean): void {
  const t = openTip;
  if (!t) return;
  openTip = null;
  cancelAnimationFrame(t.frame);
  if (seen) saveTips(markSeen(loadTips(), t.id));
  t.el.remove();
}

// Every tip shows again the next time its screen opens (Settings → Miscellaneous).
function resetTips(): void {
  saveTips({ seen: [], skipped: false });
}

// Escape closes a showing bubble when nothing else wants it (tipTakesEscape): not while a menu is open, a dialog covers
// its screen, or someone is typing (autocomplete, the find bar, a search). A dialog under the bubble (Manage agents)
// stays open until the next Escape.
const tipTyping = () => {
  const a = document.activeElement as HTMLElement | null;
  return !!a && !a.closest('.tip-bubble') && (a.matches('input, textarea, select') || a.isContentEditable);
};
document.addEventListener('keydown', e => {
  const t = openTip;
  if (e.key !== 'Escape' || !t || t.el.classList.contains('tip-wait')) return;
  if (!tipTakesEscape({ menuOpen: !!document.querySelector('#menuRoot .menu'), dialogOver: tipScene(t.target).dialogOver, typing: tipTyping() })) return;
  e.stopImmediatePropagation();
  e.preventDefault();
  closeTip(true);
}, true);
