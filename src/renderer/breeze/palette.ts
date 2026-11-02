/* ================= Command Palette (Ctrl+Shift+P) ================= */
const PALETTE_RECENT_KEY = 'breeze.palette.recent';
const PALETTE_RECENT_MAX = 8;
// Every runnable menu command as "Menu: Item", one per command, with the key it has now. On the debug page the
// commands that edit the code at the caret are left out (there is no caret there, only the hidden editor's), and so
// is Open Debug View.
function paletteEntries(): { label: string; key: string; item: MenuItem }[] {
  const seen = new Set<string>();
  const out: { label: string; key: string; item: MenuItem }[] = [];
  const onDebugPage = debugPageShowing();
  for (const menu of MENUS) {
    for (const item of menu.items) {
      if (!item.act || !item.label || item.enabled?.() === false || seen.has(item.act)) continue;
      if (onDebugPage && (item.act === 'debug.open' || (EDITOR_ONLY.has(item.act) && !DEBUG_PAGE_ACTS.has(item.act)))) continue;
      seen.add(item.act);
      out.push({ label: `${menu.name}: ${item.label}`, key: keyBinds[item.act] ?? item.key ?? '', item });
    }
  }
  return out;
}
// The label with the matched letters wrapped in <mark>.
function paletteLabelHtml(label: string, hits: number[]): string {
  const on = new Set(hits);
  let html = '', open = false;
  for (let i = 0; i < label.length; i++) {
    const hit = on.has(i);
    if (hit !== open) { html += hit ? '<mark>' : '</mark>'; open = hit; }
    html += esc(label[i]);
  }
  return open ? html + '</mark>' : html;
}
function openPalette(query = ''): void {
  const entries = paletteEntries();
  const recent = store.get<string[]>(PALETTE_RECENT_KEY, []);
  let sel = 0;
  let shown: { label: string; key: string; item: MenuItem; hits: number[] }[] = [];
  openModal(`<input class="input w-full" id="qoIn" aria-label="Type a command" placeholder="Type a command" spellcheck="false"><div class="qo-list" id="qoList"></div>`, m => {
    const input = $<HTMLInputElement>('#qoIn', m);
    input.value = query;
    input.focus();
    const runAt = (i: number) => {
      const e = shown[i];
      if (!e?.item.act) return;
      closeModal();
      store.set(PALETTE_RECENT_KEY, [e.item.act, ...recent.filter(a => a !== e.item.act)].slice(0, PALETTE_RECENT_MAX));
      // A command the debug page doesn't answer would act on the hidden editor: go back to it first, so it shows.
      if (debugPageShowing() && !DEBUG_PAGE_ACTS.has(e.item.act)) leaveDebugView();
      activateMenuItem(e.item);
    };
    const render = () => {
      const q = input.value.trim();
      if (q) {
        shown = entries.flatMap(e => { const f = fuzzyScore(e.label, q); return f ? [{ ...e, hits: f.hits, score: f.score }] : []; })
          .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label)).slice(0, 80);
      } else {
        const rank = (a: string | undefined) => { const r = recent.indexOf(a ?? ''); return r < 0 ? recent.length : r; };
        shown = entries.map(e => ({ ...e, hits: [] as number[] }))
          .sort((a, b) => rank(a.item.act) - rank(b.item.act) || a.label.localeCompare(b.label));
      }
      sel = clamp(sel, 0, Math.max(0, shown.length - 1));
      const rows = shown.map((e, i) => `<div class="qo-item ${i === sel ? 'on' : ''}" data-i="${i}"><span>${e.item.checked?.() ? '✓&nbsp; ' : ''}${paletteLabelHtml(e.label, e.hits)}</span>${e.key ? `<small>${esc(e.key)}</small>` : ''}</div>`);
      $('#qoList', m).innerHTML = rows.join('') || '<div class="side-note">No matching commands.</div>';
      $$('[data-i]', m).forEach(el => el.onclick = () => runAt(Number(el.dataset.i)));
    };
    input.oninput = () => { sel = 0; render(); };
    input.onkeydown = e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel += e.key === 'ArrowDown' ? 1 : -1; render(); $('.qo-item.on', m)?.scrollIntoView({ block: 'nearest' }); }
      if (e.key === 'Enter') runAt(sel);
    };
    render();
  }, undefined, 'top');
}
