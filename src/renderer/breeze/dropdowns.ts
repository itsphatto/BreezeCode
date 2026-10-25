/* ----- Custom dropdowns: every select.select gets a button that opens Breeze's own menu ----- */
// The native <select> stays in the page (hidden) so code and forms keep reading its value.
function updateDropdownLabel(sel: HTMLSelectElement, btn: HTMLElement): void {
  const text = sel.selectedOptions[0]?.text || sel.value || '';
  btn.innerHTML = `<span class="dd-val">${esc(text)}</span><svg class="dd-chev" width="10" height="10"><use href="#i-chev"/></svg>`;
  btn.title = text;
}
function openDropdown(sel: HTMLSelectElement, btn: HTMLElement): void {
  if (btn.classList.contains('open') || (justClosedTrigger === btn && Date.now() - justClosedAt < 350)) { closeMenu(); return; }
  closeMenu();
  const label = () => updateDropdownLabel(sel, btn);
  const items: MenuItem[] = [...sel.options].map(o => ({
    label: o.text,
    checked: () => o.value === sel.value,
    enabled: () => !o.disabled,
    run: () => {
      sel.value = o.value;
      label();
      if (sel.onchange) (sel.onchange as (e: Event) => void)(new Event('change'));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      btn.focus();
    },
  }));
  const r = btn.getBoundingClientRect();
  btn.classList.add('open');
  btn.setAttribute('aria-expanded', 'true');
  popupMenu(r.left, r.bottom + 4, items, () => { btn.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }, btn);
  const m = $('#menuRoot .menu');
  if (m) {
    m.classList.add('dd-menu');
    m.style.minWidth = `${Math.max(150, r.width)}px`;
    m.style.left = `${Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8))}px`;
    // Near the bottom of the window (the chat composers) the menu opens upwards.
    if (r.bottom + 4 + m.offsetHeight > innerHeight - 8) { m.style.top = `${Math.max(8, r.top - m.offsetHeight - 4)}px`; m.classList.add('up'); }
  }
}
function enhanceSelect(sel: HTMLSelectElement): void {
  if (sel.dataset.dd) return;
  sel.dataset.dd = '1';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dd-btn' + (sel.classList.contains('hidden') ? ' hidden' : '');
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-label', sel.getAttribute('aria-label') ?? 'Choose');
  if (sel.id) btn.classList.add(`${sel.id}-btn`);
  sel.classList.add('dd-native');
  sel.tabIndex = -1;
  sel.setAttribute('aria-hidden', 'true');
  sel.after(btn);
  const label = () => updateDropdownLabel(sel, btn);
  label();
  sel.addEventListener('change', label);
  btn.onclick = () => openDropdown(sel, btn);
  btn.onkeydown = e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    if (!btn.classList.contains('open')) openDropdown(sel, btn);
  };

  new MutationObserver(() => {
    btn.classList.toggle('hidden', sel.classList.contains('hidden'));
    label();
  }).observe(sel, { childList: true, attributes: true, attributeFilter: ['class'] });
}

$$<HTMLSelectElement>('select.select').forEach(enhanceSelect);
new MutationObserver(() => $$<HTMLSelectElement>('select.select:not([data-dd])').forEach(enhanceSelect)).observe(document.body, { childList: true, subtree: true });

