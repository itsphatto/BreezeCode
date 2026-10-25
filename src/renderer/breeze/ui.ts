/* ================= Modal & misc ================= */
let modalOnClose: (() => void) | null = null;
const modalOpen = () => !!document.querySelector('#modalRoot .scrim:not(.closing)');
// Pop-ups come in Apple-style: the panel settles first and its parts follow one after another (and leave in reverse).
// Elements already running their own animation (spinners and the like) are left alone.
function staggerIn(items: Iterable<Element>, from = 0): void {
  let i = from;
  for (const el of items) {
    if (!(el instanceof HTMLElement) || el.classList.contains('stagger-item')) continue;
    if (getComputedStyle(el).animationName !== 'none') continue;
    el.style.setProperty('--i', String(i++));
    el.classList.add('stagger-item');
  }
}
function staggerModal(m: HTMLElement): void {
  const settings = m.querySelector('.settings-modal');
  if (settings) { staggerIn(settings.querySelectorAll('.set-nav > *')); staggerIn(settings.querySelectorAll('.set-pane > *'), 2); return; }
  const kids = [...m.children];
  staggerIn(kids.length === 1 ? kids[0].children : kids);
}
// A modal opened from Settings (or from a modal that was) leads back there: it gets a "Settings" back button,
// and dismissing it (Esc, its close or cancel button, a click outside) reopens Settings on the same page.
let modalBackToSettings = false;
function openModal(html: string, bind?: (m: HTMLElement) => void, onClose?: () => void, place: 'center' | 'top' = 'center'): void {
  const back = !html.includes('settings-modal') && (!!settingsRoot() || modalBackToSettings);
  closeModal();
  $$('#modalRoot .scrim.closing').forEach(x => x.remove());
  const top = place === 'top';
  const backBtn = back ? `<button type="button" class="modal-back" data-back aria-label="Back to Settings">${svgIcon('chevronLeft', 14)}<span>Settings</span></button>` : '';
  $('#modalRoot').insertAdjacentHTML('beforeend', `<div class="scrim ${top ? 'top' : ''}"><div class="modal ${top ? 'wide' : ''}" role="dialog" aria-modal="true">${backBtn}${html}</div></div>`);
  const m = $('#modalRoot .scrim:not(.closing) .modal');
  modalOnClose = onClose ?? null;
  modalBackToSettings = back;
  $('#modalRoot .scrim:not(.closing)').onmousedown = e => { if ((e.target as HTMLElement).classList.contains('scrim')) dismissModal(); };
  $$('[data-close], [data-back]', m).forEach(b => b.onclick = dismissModal);
  const owner = popOwner();
  if (owner) growFrom(m, owner);
  bind?.(m);
  staggerModal(m);
}
function closeModal(): void {
  const scrim = $('#modalRoot .scrim:not(.closing)');
  modalBackToSettings = false;
  if (!scrim) return;
  // Play the closing animation on a detached copy so a new modal can open immediately.
  scrim.classList.add('closing');
  setTimeout(() => scrim.remove(), scrim.querySelector('.settings-shell') ? 460 : 380);
  const cb = modalOnClose; modalOnClose = null; cb?.();
}
// Closing without acting on the modal: one opened from Settings goes back there.
function dismissModal(): void {
  const back = modalBackToSettings;
  closeModal();
  if (back) openSettings($('#settingsBtn'));
}
function bindToasts(root: ParentNode = document): void {
  $$('[data-toast]', root).forEach(b => b.onclick = () => toast(b.dataset.toast ?? ''));
}

/* ================= Custom Tooltip UI ================= */
// New text in a tip that is already up: the text fades in and the box resizes from its old size to the new one.
function morphTooltip(el: HTMLElement, text: string): void {
  const from = el.getBoundingClientRect();
  el.textContent = text;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const to = el.getBoundingClientRect();
  el.getAnimations().forEach(a => { if (a.id === 'tip') a.cancel(); });
  const size = el.animate([{ width: `${from.width}px`, height: `${from.height}px` }, { width: `${to.width}px`, height: `${to.height}px` }], { duration: 260, easing: 'cubic-bezier(.32, .72, 0, 1)' });
  size.id = 'tip';
  const fade = el.animate([{ color: 'transparent', filter: 'blur(2px)' }, { color: '#f5f5f7', filter: 'blur(0)' }], { duration: 220, easing: 'cubic-bezier(.2, .8, .2, 1)' });
  fade.id = 'tip';
}
let tooltipEl: HTMLElement | null = null;
let tooltipTimer: TimeoutId | undefined;
let cursorX = 0;
let cursorY = 0;
let lastTooltipTime = 0;

function initTooltip(): void {
  tooltipEl = document.createElement('div');
  tooltipEl.className = 'breeze-tooltip';
  tooltipEl.setAttribute('aria-hidden', 'true');
  document.body.appendChild(tooltipEl);

  let hideTimer: TimeoutId | undefined;
  const hideTooltip = () => {
    clearTimeout(tooltipTimer);
    clearTimeout(hideTimer);
    if (tooltipEl?.classList.contains('visible')) {
      lastTooltipTime = Date.now();
      tooltipEl.classList.remove('visible');
    }
  };

  const updateTooltipPos = () => {
    if (!tooltipEl?.classList.contains('visible')) return;
    const tipW = tooltipEl.offsetWidth;
    const tipH = tooltipEl.offsetHeight;
    let left = cursorX + 10;
    let top = cursorY + 14;

    // Flip horizontally if tooltip would overflow right edge
    if (left + tipW > window.innerWidth - 8) {
      left = cursorX - tipW - 8;
    }
    // Flip vertically if tooltip would overflow bottom edge
    if (top + tipH > window.innerHeight - 8) {
      top = cursorY - tipH - 8;
    }
    // Keep within viewport boundaries
    left = Math.max(6, Math.min(left, window.innerWidth - tipW - 6));
    top = Math.max(6, Math.min(top, window.innerHeight - tipH - 6));

    tooltipEl.style.left = `${Math.round(left)}px`;
    tooltipEl.style.top = `${Math.round(top)}px`;
  };

  document.addEventListener('pointermove', (e) => {
    cursorX = e.clientX;
    cursorY = e.clientY;
    if (tooltipEl?.classList.contains('visible')) {
      updateTooltipPos();
    }
  }, { passive: true });

  document.addEventListener('pointerover', (e) => {
    cursorX = e.clientX;
    cursorY = e.clientY;
    const target = (e.target as HTMLElement).closest<HTMLElement>('[title], [data-tooltip], [alt]');
    if (!target) {
      hideTooltip();
      return;
    }

    // Tips only show in the file manager (the Explorer's buttons and file tree). Anywhere else the title is taken off
    // so the system tip doesn't pop up either; an icon-only control keeps it as its aria-label so it still has a name.
    // Iframe titles stay: they name the frame for screen readers and never show a tip.
    if (!target.closest('[data-panel="files"]')) {
      if (target.hasAttribute('title') && target.tagName !== 'IFRAME') {
        const val = target.getAttribute('title')?.trim() ?? '';
        target.removeAttribute('title');
        if (val && !target.hasAttribute('aria-label') && !target.textContent?.trim()) target.setAttribute('aria-label', val);
      }
      hideTooltip();
      return;
    }

    if (target.hasAttribute('title')) {
      const val = target.getAttribute('title') || '';
      target.removeAttribute('title');
      if (val.trim()) target.dataset.tooltip = val.trim();
    } else if (target.hasAttribute('alt') && !target.dataset.tooltip) {
      const val = target.getAttribute('alt') || '';
      if (val.trim()) target.dataset.tooltip = val.trim();
    }
    const tip = target.dataset.tooltip;
    if (!tip || !tooltipEl) {
      hideTooltip();
      return;
    }
    clearTimeout(tooltipTimer);
    clearTimeout(hideTimer);
    // Already showing (moving from one tab to the next): the same tip stays up, its text fades over and its box
    // grows or shrinks to the new text instead of the whole tip fading out and in again.
    if (tooltipEl.classList.contains('visible')) {
      if (tooltipEl.textContent !== tip) morphTooltip(tooltipEl, tip);
      updateTooltipPos();
      lastTooltipTime = Date.now();
      return;
    }
    const warmDelay = (Date.now() - lastTooltipTime < 600) ? 0 : 120;
    tooltipTimer = setTimeout(() => {
      if (!target.isConnected || !tooltipEl) return;
      tooltipEl.textContent = tip;
      tooltipEl.classList.add('visible');
      updateTooltipPos();
      lastTooltipTime = Date.now();
    }, warmDelay);
  }, true);

  document.addEventListener('pointerout', (e) => {
    const related = e.relatedTarget as HTMLElement | null;
    const current = (e.target as HTMLElement).closest<HTMLElement>('[data-tooltip]');
    if (current && related && current.contains(related)) return;
    // A beat of grace, so stepping straight onto the next item morphs the tip instead of hiding it.
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideTooltip, 70);
  }, true);

  document.addEventListener('pointerdown', hideTooltip, true);
  window.addEventListener('scroll', hideTooltip, true);
}

