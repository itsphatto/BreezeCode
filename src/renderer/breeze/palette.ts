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
function openPaletteModal(query = ''): void {
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

/* ================= Search field in the title bar (F1, Ctrl+P, Ctrl+Shift+P) =================
   The project-name pill in the middle of the title bar is the search field. Opening it widens the pill and unfolds
   the results under it as one surface, so nothing pops up over the window. Files by default; a leading ">" searches
   commands. When the title bar isn't showing (the debug page, the board), the old dialogs open instead. */
type CmdRow =
  | { kind: 'file'; path: string; hits: number[] }
  | { kind: 'cmd'; label: string; key: string; item: MenuItem; hits: number[] };
const CMD_FILES_MAX = 8, CMD_CMDS_MAX = 5;
let cmdOpen = false, cmdSel = 0, cmdRows: CmdRow[] = [];
let cmdFiles: string[] | null = null;
let cmdReturnFocus: HTMLElement | null = null;
let cmdEntries: ReturnType<typeof paletteEntries> = [];

// The IDE and the Agent board each have their own pill (the board's is a copy, made below); the one on the page
// showing is the one that opens, and `cmdCur` stays that one until it folds back up.
const cmdCenters = (): HTMLElement[] => $$<HTMLElement>('.cmd-center');
let cmdCur: HTMLElement = $('#cmdCenter');
const cmdPart = <T extends HTMLElement = HTMLElement>(cls: string): T => $<T>(`.${cls}`, cmdCur);

function openPalette(query = ''): void { openCmdCenter('>' + query); }
function quickOpen(): void { openCmdCenter(''); }

function openCmdCenter(query = ''): void {
  const center = cmdOpen ? cmdCur : cmdCenters().find(c => c.checkVisibility());
  if (!center) { if (query.startsWith('>')) openPaletteModal(query.slice(1)); else quickOpenModal(); return; }
  cmdCur = center;
  const input = cmdPart<HTMLInputElement>('cmd-in');
  if (modalOpen()) closeModal();
  closeMenu();
  if (!cmdOpen) {
    const active = document.activeElement;
    cmdReturnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
    cmdOpen = true;
    cmdEntries = paletteEntries();
    cmdFiles = null;
    center.classList.add('open');
    input.tabIndex = 0;
    input.setAttribute('aria-expanded', 'true');
    input.placeholder = rootInfo ? `Search ${rootInfo.name}  ·  type > for commands` : 'Search commands';
    if (rootInfo) {
      api.fs.listFiles().then(list => { if (cmdOpen) { cmdFiles = list; renderCmd(); } }, () => { cmdFiles = []; if (cmdOpen) renderCmd(); });
    }
  }
  input.value = query;
  input.focus();
  input.setSelectionRange(query.length, query.length);
  cmdSel = 0;
  renderCmd(true);
}

function closeCmdCenter(refocus = true): void {
  if (!cmdOpen) return;
  cmdOpen = false;
  const input = cmdPart<HTMLInputElement>('cmd-in');
  cmdCur.classList.remove('open');
  input.tabIndex = -1;
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
  cmdPart('cmd-body').style.height = '0px';
  input.blur();
  if (refocus && cmdReturnFocus?.isConnected) cmdReturnFocus.focus();
  cmdReturnFocus = null;
}

const cmdRowId = (i: number): string => `${cmdCur.id}Row${i}`;
function cmdRowHtml(r: CmdRow, i: number): string {
  const on = i === cmdSel ? 'on' : '';
  const open = `<div class="qo-item cmd-row ${on}" id="${cmdRowId(i)}" role="option" aria-selected="${!!on}" data-i="${i}">`;
  if (r.kind === 'file') {
    const dir = dirName(r.path);
    return open + `<span class="cmd-ico">${fileIcon(r.path)}</span><span class="cmd-main">${paletteLabelHtml(baseName(r.path), r.hits)}</span>`
      + `${dir ? `<small><bdo dir="ltr">${esc(dir)}</bdo></small>` : ''}</div>`;
  }
  const tick = r.item.checked?.() ? '✓&nbsp; ' : '';
  return open + `<span class="cmd-ico cmd-chev" aria-hidden="true">›</span><span class="cmd-main">${tick}${paletteLabelHtml(r.label, r.hits)}</span>`
    + `${r.key ? `<kbd>${esc(r.key)}</kbd>` : ''}</div>`;
}

function renderCmd(fresh = false): void {
  if (!cmdOpen) return;
  const raw = cmdPart<HTMLInputElement>('cmd-in').value;
  const cmdMode = raw.startsWith('>') || !rootInfo;
  const q = (raw.startsWith('>') ? raw.slice(1) : raw).trim();
  const recent = store.get<string[]>(PALETTE_RECENT_KEY, []);
  const toRow = (e: (typeof cmdEntries)[number], hits: number[]): CmdRow => ({ kind: 'cmd', label: e.label, key: e.key, item: e.item, hits });

  // Commands: fuzzy-matched, or most recent first while the query is empty (only the recent ones beside files).
  let cmds: CmdRow[];
  if (q) {
    cmds = cmdEntries.flatMap(e => { const f = fuzzyScore(e.label, q); return f ? [{ e, f }] : []; })
      .sort((a, b) => b.f.score - a.f.score || a.e.label.localeCompare(b.e.label))
      .map(({ e, f }) => toRow(e, f.hits));
  } else {
    const rank = (a: string | undefined) => { const r = recent.indexOf(a ?? ''); return r < 0 ? recent.length : r; };
    const sorted = [...cmdEntries].sort((a, b) => rank(a.item.act) - rank(b.item.act) || a.label.localeCompare(b.label));
    cmds = (cmdMode ? sorted : sorted.filter(e => recent.includes(e.item.act ?? ''))).map(e => toRow(e, []));
  }

  // Files: the same ranking as Go to File, with the matched letters of the name lit.
  let files: CmdRow[] = [];
  if (!cmdMode && cmdFiles) {
    const lq = q.toLowerCase();
    files = cmdFiles.map(p => [p, fileScore(p, lq)] as [string, number]).filter(x => x[1] > 0)
      .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).slice(0, CMD_FILES_MAX)
      .map(([p]) => ({ kind: 'file' as const, path: p, hits: q ? fuzzyScore(baseName(p), q)?.hits ?? [] : [] }));
  }

  const sections: string[] = [];
  cmdRows = [];
  const add = (title: string, rows: CmdRow[]) => {
    if (!rows.length) return;
    const start = cmdRows.length;
    cmdRows.push(...rows);
    sections.push(`<div class="cmd-sec" role="presentation">${title}</div>` + rows.map((r, j) => cmdRowHtml(r, start + j)).join(''));
  };
  if (cmdMode) add('Commands', cmds.slice(0, 80));
  else { add('Files', files); add(q ? 'Commands' : 'Recent commands', cmds.slice(0, CMD_CMDS_MAX)); }
  cmdSel = clamp(cmdSel, 0, Math.max(0, cmdRows.length - 1));

  const list = cmdPart('cmd-list');
  let empty = '';
  if (!cmdRows.length) {
    empty = !cmdMode && !cmdFiles ? '<div class="cmd-empty shimmer-text">Loading files</div>'
      : `<div class="cmd-empty">No ${cmdMode ? 'commands' : 'files or commands'} match “${esc(q)}”.</div>`;
  }
  list.innerHTML = sections.join('') || empty;
  // Rows are drawn selected-or-not after the fact, so re-render marks the right one.
  $$<HTMLElement>('[data-i]', list).forEach(el => {
    el.onmousedown = e => e.preventDefault(); // keep the caret in the field
    el.onclick = () => runCmdRow(Number(el.dataset.i));
    el.onmousemove = () => { const i = Number(el.dataset.i); if (i !== cmdSel) { cmdSel = i; markCmdSel(); } };
  });
  const keys = `<span class="cmd-keys"><kbd>↑</kbd><kbd>↓</kbd> move <kbd>↵</kbd> ${cmdMode ? 'run' : 'open'}</span>`;
  cmdPart('cmd-foot').innerHTML = (!rootInfo ? '<span>Open a folder to search its files</span>'
    : cmdMode ? '<span>Delete the <kbd>&gt;</kbd> to search files</span>' : '<span>Type <kbd>&gt;</kbd> for commands</span>') + keys;
  markCmdSel();
  if (fresh) staggerIn($$('.cmd-sec, .cmd-row', list));
  fitCmdBody();
}

// The open panel's height follows its content, so the list grows and shrinks on the spring as you type.
function fitCmdBody(): void {
  const body = cmdPart('cmd-body'), inner = $('.cmd-inner', body);
  body.style.height = `${Math.min(inner.scrollHeight, Math.round(window.innerHeight * 0.6))}px`;
}

function markCmdSel(): void {
  const input = cmdPart<HTMLInputElement>('cmd-in');
  $$<HTMLElement>('.cmd-row', cmdPart('cmd-list')).forEach(el => {
    const on = Number(el.dataset.i) === cmdSel;
    el.classList.toggle('on', on);
    el.setAttribute('aria-selected', String(on));
  });
  if (cmdRows.length) input.setAttribute('aria-activedescendant', cmdRowId(cmdSel));
  else input.removeAttribute('aria-activedescendant');
}

function runCmdRow(i: number): void {
  const r = cmdRows[i];
  if (!r) return;
  closeCmdCenter(false);
  // On the Agent board a file or an editor command goes back to the editor first, so it shows (the boxes keep running).
  const onBoard = boardPageShowing();
  if (r.kind === 'file') { if (onBoard) leaveBoard(); openFile(r.path); return; }
  const act = r.item.act;
  if (!act) return;
  if (onBoard && !BOARD_PAGE_ACTS.has(act)) leaveBoard();
  store.set(PALETTE_RECENT_KEY, [act, ...store.get<string[]>(PALETTE_RECENT_KEY, []).filter(a => a !== act)].slice(0, PALETTE_RECENT_MAX));
  // A command the debug page doesn't answer would act on the hidden editor: go back to it first, so it shows.
  if (debugPageShowing() && !DEBUG_PAGE_ACTS.has(act)) leaveDebugView();
  activateMenuItem(r.item);
}

// The board's title bar gets a copy of the pill (ids dropped, its list and rows named apart), between two spacers as in the IDE's.
{
  const copy = $('#cmdCenter').cloneNode(true) as HTMLElement;
  for (const el of [copy, ...Array.from(copy.querySelectorAll<HTMLElement>('[id]'))]) el.removeAttribute('id');
  copy.id = 'cmdCenterBoard';
  copy.querySelector('.cmd-list')!.id = 'cmdListBoard';
  copy.querySelector('.cmd-in')!.setAttribute('aria-controls', 'cmdListBoard');
  const spacer = $('#board .titlebar .spacer');
  spacer.after(copy, spacer.cloneNode());
}

for (const center of cmdCenters()) {
  const input = $<HTMLInputElement>('.cmd-in', center);
  $('.cmd-label', center).onclick = () => { cmdCur = center; openCmdCenter(''); };
  input.oninput = () => { cmdSel = 0; renderCmd(); };
  input.onkeydown = e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!cmdRows.length) return;
      cmdSel = (cmdSel + (e.key === 'ArrowDown' ? 1 : -1) + cmdRows.length) % cmdRows.length;
      markCmdSel();
      document.getElementById(cmdRowId(cmdSel))?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') { e.preventDefault(); runCmdRow(cmdSel); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); closeCmdCenter(); }
  };
}
// A click anywhere else folds it back up.
document.addEventListener('mousedown', e => { if (cmdOpen && !cmdCur.contains(e.target as Node)) closeCmdCenter(false); }, true);
window.addEventListener('blur', () => closeCmdCenter(false));
window.addEventListener('resize', () => { if (cmdOpen) fitCmdBody(); });
