/* ================= Terminal window ================= */
// The page of a terminal window (Terminal → New Terminal Window): a prompt, the output and the window's own buttons.
// It talks to main through its own small bridge (termPreload.js). The whole file is one function so that none of its
// names reach the global scope the main window's scripts share with it when they are type-checked together.
(() => {
  interface TermApi {
    info(): Promise<{ cwd: string; platform: string; user?: string; sys?: [string, string][] }>;
    run(command: string): Promise<{ id?: number; cwd?: string; error?: string }>;
    write(id: number, text: string): Promise<void>;
    kill(id: number): Promise<void>;
    onData(cb: (id: number, chunk: string) => void): () => void;
    onExit(cb: (id: number, code: number | null) => void): () => void;
    win: {
      newTerminal(): Promise<void>; minimize(): Promise<void>; toggleMaximize(): Promise<void>; close(): Promise<void>;
      isMaximized(): Promise<boolean>; onMaximized(cb: (on: boolean) => void): () => void;
    };
  }
  const api = (window as unknown as { breezeTerm: TermApi }).breezeTerm;
  const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const body = el('twBody'), out = el('twOut'), line = el('twLine'), ps = el('twPs');
  const before = el('twBefore'), caret = el('twCaret'), after = el('twAfter');
  const input = el<HTMLTextAreaElement>('twInput'), killBtn = el<HTMLButtonElement>('twKill');
  const quietly = (p: Promise<unknown>) => { p.catch(() => { /* the window is closing */ }); };

  /* ----- Theme and font size: the main window's (Settings → Appearance), kept in step while both are open ----- */
  const read = <T>(key: string, fallback: T): T => {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v) as T; } catch { return fallback; }
  };
  const applyPrefs = () => {
    const theme = read<string>('breeze.theme', 'dark');
    document.documentElement.dataset.theme = ['dark', 'contrast', 'light'].includes(theme) ? theme : 'dark';
    const size = Math.min(24, Math.max(10, Number(read<number>('breeze.codeSize', 13)) || 13));
    document.documentElement.style.setProperty('--code-size', `${size}px`);
  };
  applyPrefs();
  window.addEventListener('storage', e => { if (e.key === 'breeze.theme' || e.key === 'breeze.codeSize') applyPrefs(); });

  /* ----- Output, with the colours programs ask for (ANSI SGR); other escape codes are dropped ----- */
  interface Style { fg?: string; bg?: string; b?: boolean; d?: boolean; i?: boolean; u?: boolean }
  let style: Style = {};
  let pendingEsc = ''; // an escape code split across two chunks
  const xterm256 = (n: number): string => {
    if (n < 16) return `var(--ansi-${n})`;
    if (n < 232) {
      const v = (c: number) => (c ? 55 + c * 40 : 0);
      const k = n - 16;
      return `rgb(${v(Math.floor(k / 36))}, ${v(Math.floor(k / 6) % 6)}, ${v(k % 6)})`;
    }
    const g = (n - 232) * 10 + 8;
    return `rgb(${g}, ${g}, ${g})`;
  };
  function applySgr(codes: number[]): void {
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) style = {};
      else if (c === 1) style.b = true;
      else if (c === 2) style.d = true;
      else if (c === 3) style.i = true;
      else if (c === 4) style.u = true;
      else if (c === 22) style.b = style.d = false;
      else if (c === 23) style.i = false;
      else if (c === 24) style.u = false;
      else if (c >= 30 && c <= 37) style.fg = `var(--ansi-${c - 30})`;
      else if (c >= 90 && c <= 97) style.fg = `var(--ansi-${c - 82})`;
      else if (c >= 40 && c <= 47) style.bg = `color-mix(in srgb, var(--ansi-${c - 40}) 24%, transparent)`;
      else if (c >= 100 && c <= 107) style.bg = `color-mix(in srgb, var(--ansi-${c - 92}) 25%, transparent)`;
      else if (c === 39) style.fg = undefined;
      else if (c === 49) style.bg = undefined;
      else if ((c === 38 || c === 48) && codes[i + 1] === 5) { const col = xterm256(codes[i + 2] ?? 0); if (c === 38) style.fg = col; else style.bg = col; i += 2; }
      else if ((c === 38 || c === 48) && codes[i + 1] === 2) { const col = `rgb(${codes[i + 2] ?? 0}, ${codes[i + 3] ?? 0}, ${codes[i + 4] ?? 0})`; if (c === 38) style.fg = col; else style.bg = col; i += 4; }
    }
  }
  /* ----- The main terminal's highlighting (terminal.ts): uncoloured output gets its errors, warnings, successes,
     notes, npm headers, git diffstats and web addresses coloured; a command gets its name, flags, strings and numbers. */
  const tok = (text: string, cls: string): HTMLElement => {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  };
  const KW = new RegExp([
    /(\b\d+ insertions?\(\+\))/.source, // 1 success
    /(\b\d+ deletions?\(-\))/.source, // 2 error
    /\b(npm)(\s+)(warn(?:ing)?|WARN|notice|invalid|ERR!|error|ERROR|info|http)(?!\w)/.source, // 3, 4, 5
    /(https?:\/\/[^\s<>"'`)]*[^\s<>"'`).,;:!?])/.source, // 6 web address
    /(\b(?:FATAL|FAIL|ERROR|Error|error|fatal error)\b:?|\bERR!)/.source, // 7
    /(\b(?:WARN|WARNING|Warning|warning|warn)\b:?)/.source, // 8
    /(\b(?:SUCCESS|SUCCESSFUL|PASS|passed|compiled successfully|Done in)\b|✓)/.source, // 9
    /(\b(?:INFO|Info|NOTE|Note|note|info)\b:?)/.source, // 10
    /(\b(?:[Ii]nvalid|INVALID|[Nn]otice|NOTICE|[Hh]ttp|HTTP)\b)/.source, // 11
  ].join('|'), 'g');
  const DIFFSTAT = /^( *\S(?:.*?\S)?)( +\| +)(\d+ )(\+*)(-*)$/;
  function keywords(text: string): Node[] {
    const nodes: Node[] = [];
    let last = 0;
    for (const m of text.matchAll(KW)) {
      if (m.index > last) nodes.push(document.createTextNode(text.slice(last, m.index)));
      if (m[1]) nodes.push(tok(m[1], 'term-kw-success'));
      else if (m[2]) nodes.push(tok(m[2], 'term-kw-error'));
      else if (m[3]) {
        const lvl = m[5].toLowerCase();
        const cls = lvl.startsWith('warn') ? 'term-kw-warning'
          : lvl === 'err!' || lvl === 'error' ? 'term-kw-error'
          : lvl === 'info' ? 'term-kw-info' : 'term-kw-cyan';
        nodes.push(tok(m[3], 'term-npm'), document.createTextNode(m[4]), tok(m[5], cls));
      } else if (m[6]) {
        const a = document.createElement('a');
        a.className = 'term-url';
        a.href = m[6];
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = m[6];
        nodes.push(a);
      }
      else if (m[7]) nodes.push(tok(m[7], 'term-kw-error'));
      else if (m[8]) nodes.push(tok(m[8], 'term-kw-warning'));
      else if (m[9]) nodes.push(tok(m[9], 'term-kw-success'));
      else if (m[10]) nodes.push(tok(m[10], 'term-kw-info'));
      else if (m[11]) nodes.push(tok(m[11], 'term-kw-cyan'));
      last = m.index + m[0].length;
    }
    if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
    return nodes;
  }
  function highlightPlain(text: string): Node[] {
    const nodes: Node[] = [];
    for (const ln of text.split(/(?<=\n)/)) {
      const body = ln.endsWith('\n') ? ln.slice(0, -1) : ln;
      const d = DIFFSTAT.exec(body);
      if (d && (d[4] || d[5])) { // git's diffstat: " name | 13 +++--"
        nodes.push(document.createTextNode(d[1] + d[2] + d[3]));
        if (d[4]) nodes.push(tok(d[4], 'term-kw-success'));
        if (d[5]) nodes.push(tok(d[5], 'term-kw-error'));
        if (body !== ln) nodes.push(document.createTextNode('\n'));
      } else nodes.push(...keywords(ln));
    }
    return nodes;
  }
  // A command split into coloured pieces, the same tokens as the main terminal's formatCommandSyntax.
  function commandTokens(cmd: string): { text: string; cls: string }[] {
    const toks: { text: string; cls: string }[] = [];
    let last = 0, first = true;
    for (const m of cmd.matchAll(/--?[a-zA-Z0-9_-]+|"[^"]*"|'[^']*'|\S+/g)) {
      if (m.index > last) toks.push({ text: cmd.slice(last, m.index), cls: '' });
      const t = m[0];
      const quoted = t.length > 1 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")));
      const cls = first ? 'term-cmd-name'
        : t.startsWith('-') ? 'term-cmd-flag'
        : quoted ? 'term-cmd-str'
        : /^\d+$/.test(t) ? 'term-cmd-num' : 'term-cmd-arg';
      first = false;
      toks.push({ text: t, cls });
      last = m.index + t.length;
    }
    if (last < cmd.length) toks.push({ text: cmd.slice(last), cls: '' });
    return toks;
  }
  // The pieces of `cmd` between offsets a and b, as nodes.
  function commandNodes(cmd: string, a = 0, b = cmd.length): Node[] {
    const nodes: Node[] = [];
    let at = 0;
    for (const t of commandTokens(cmd)) {
      const s = Math.max(a, at), e = Math.min(b, at + t.text.length);
      if (s < e) { const piece = cmd.slice(s, e); nodes.push(t.cls ? tok(piece, t.cls) : document.createTextNode(piece)); }
      at += t.text.length;
    }
    return nodes;
  }
  function commandClassAt(cmd: string, i: number): string {
    let at = 0;
    for (const t of commandTokens(cmd)) { if (i < at + t.text.length) return t.cls; at += t.text.length; }
    return '';
  }

  function appendText(text: string, cls = ''): void {
    if (!text) return;
    const plain = !cls && !style.fg && !style.bg && !style.b && !style.d && !style.i && !style.u;
    if (plain) { out.append(...highlightPlain(text)); return; }
    const span = document.createElement('span');
    span.className = [cls, style.b && 'a-b', style.d && 'a-d', style.i && 'a-i', style.u && 'a-u'].filter(Boolean).join(' ');
    if (style.fg) span.style.color = style.fg;
    if (style.bg) span.style.background = style.bg;
    span.textContent = text;
    out.append(span);
  }
  // Escape codes: colours (CSI … m) are applied, any other CSI and OSC (titles, links) are left out.
  const ESC = /\x1b(?:\[([0-9;?]*)([ -/]*[@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
  function write(chunk: string): void {
    let text = pendingEsc + chunk;
    pendingEsc = '';
    const cut = text.lastIndexOf('\x1b');
    if (cut >= 0 && !/^\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/.test(text.slice(cut))) {
      pendingEsc = text.slice(cut);
      text = text.slice(0, cut);
    }
    text = text.replace(/\r+\n/g, '\n').replace(/\r/g, '');
    let last = 0;
    for (const m of text.matchAll(ESC)) {
      appendText(text.slice(last, m.index));
      if (m[2] === 'm') applySgr((m[1] || '0').split(';').map(Number));
      last = (m.index ?? 0) + m[0].length;
    }
    appendText(text.slice(last));
    scrollDown();
  }
  const endsWithNewline = () => !out.lastChild || /\n$/.test(out.lastChild.textContent ?? '');
  const writeLine = (text: string, cls = '') => { if (!endsWithNewline()) out.append('\n'); appendText(text + '\n', cls); scrollDown(); };
  let scrollRaf = 0;
  function scrollDown(): void {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; body.scrollTop = body.scrollHeight; });
  }

  /* ----- The prompt line ----- */
  let cwd = '';
  let platform = '';
  let proc: number | null = null;
  let runMark: HTMLElement | null = null; // the circle of the command that's running
  const promptText = () => (platform === 'win32'
    ? `PS ${cwd.replace(/^([a-z]):/, (_m, d: string) => d.toUpperCase() + ':')}> `
    : `${cwd} $ `);
  // The prompt in the main terminal's colours: "PS", the folder, then ">".
  function promptNode(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'tw-ps-text';
    const m = /^(PS) (.*)(> )$/.exec(promptText());
    if (m) span.append(tok(m[1], 'ps-prefix'), ' ', tok(m[2], 'ps-path'), tok(m[3], 'ps-arrow'));
    else span.textContent = promptText();
    return span;
  }
  const renderPs = () => { ps.replaceChildren(promptNode()); };
  function renderInput(): void {
    const v = input.value, at = input.selectionDirection === 'backward' ? input.selectionStart : input.selectionEnd;
    const onChar = !!v[at] && v[at] !== '\n';
    // While a program runs, what's typed is its input, not a command: it stays uncoloured.
    if (proc != null) {
      before.textContent = v.slice(0, at);
      after.textContent = v.slice(at + (onChar ? 1 : 0));
      caret.className = 'tw-caret';
    } else {
      before.replaceChildren(...commandNodes(v, 0, at));
      after.replaceChildren(...commandNodes(v, at + (onChar ? 1 : 0)));
      caret.className = `tw-caret ${onChar ? commandClassAt(v, at) : ''}`.trim();
    }
    caret.textContent = onChar ? v[at] : ' ';
    scrollDown();
  }
  function setBusy(id: number | null): void {
    proc = id;
    line.classList.toggle('busy', id != null);
    killBtn.disabled = id == null;
    renderInput(); // typed text switches between a coloured command and plain program input
  }
  // What was typed stays in the output as a line of its own, under a circle that later shows how it ended.
  function freezeLine(cmd: string): HTMLElement {
    if (!endsWithNewline()) out.append('\n');
    const mark = document.createElement('span');
    mark.className = 'tw-mark';
    const row = document.createElement('span');
    row.append(mark, promptNode(), ...commandNodes(cmd), '\n');
    out.append(row);
    style = {};
    return mark;
  }
  const finish = (mark: HTMLElement | null, code: number | null) => {
    if (!mark) return;
    mark.classList.add(code === 0 ? 'ok' : 'fail');
    mark.title = code == null ? 'Stopped' : `Exit code ${code}`;
  };

  /* ----- Commands ----- */
  const HISTORY_KEY = 'breeze.termWinHistory';
  const history: string[] = read<string[]>(HISTORY_KEY, []).filter(h => typeof h === 'string').slice(-200);
  let hIdx = history.length;
  async function submit(): Promise<void> {
    const cmd = input.value.replace(/\r?\n$/, '');
    input.value = '';
    renderInput();
    if (proc != null) { // the running program asked for input
      appendText(cmd + '\n', 'tw-dim');
      quietly(api.write(proc, cmd + '\n'));
      return;
    }
    const mark = freezeLine(cmd);
    if (!cmd.trim()) return;
    if (history.at(-1) !== cmd) { history.push(cmd); if (history.length > 200) history.shift(); }
    hIdx = history.length;
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch { /* storage off */ }
    if (/^\s*(?:cls|clear)\s*$/i.test(cmd)) { out.textContent = ''; return; }
    if (/^\s*exit\s*$/i.test(cmd)) { quietly(api.win.close()); return; }
    const r = await api.run(cmd).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }) as { id?: number; cwd?: string; error?: string });
    if (r.error) { writeLine(r.error, 'tw-err'); finish(mark, 1); }
    if (r.cwd) { cwd = r.cwd; renderPs(); finish(mark, 0); }
    if (r.id != null) { runMark = mark; setBusy(r.id); }
    scrollDown();
  }
  function stop(): void {
    if (proc == null) return;
    quietly(api.kill(proc));
    appendText('^C\n', 'tw-dim');
  }
  api.onData((id, chunk) => { if (id === proc) write(chunk); });
  api.onExit((id, code) => {
    if (id !== proc) return;
    write(''); // flush a held-back escape code
    pendingEsc = '';
    finish(runMark, code);
    runMark = null;
    setBusy(null);
    if (!endsWithNewline()) out.append('\n');
    scrollDown();
  });

  /* ----- Keys ----- */
  input.addEventListener('keydown', e => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); return; }
    if (ctrl && e.key.toLowerCase() === 'c' && !e.shiftKey && !e.altKey) {
      const sel = window.getSelection()?.toString() ?? '';
      if (sel) { e.preventDefault(); quietly(navigator.clipboard.writeText(sel)); window.getSelection()?.removeAllRanges(); return; }
      if (input.selectionStart !== input.selectionEnd) return; // copies the selected input
      e.preventDefault();
      if (proc != null) { stop(); return; }
      finish(freezeLine(input.value + '^C'), null);
      input.value = '';
      renderInput();
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'l') { e.preventDefault(); out.textContent = ''; return; }
    if (e.key === 'Tab') { e.preventDefault(); return; }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && proc == null && !input.value.includes('\n')) {
      e.preventDefault();
      hIdx = Math.max(0, Math.min(history.length, hIdx + (e.key === 'ArrowUp' ? -1 : 1)));
      input.value = history[hIdx] ?? '';
      input.setSelectionRange(input.value.length, input.value.length);
      renderInput();
    }
  });
  for (const ev of ['input', 'keyup', 'select', 'click']) input.addEventListener(ev, renderInput);
  document.addEventListener('selectionchange', () => { if (document.activeElement === input) renderInput(); });
  // A click in the terminal types there, unless it was the end of selecting some output to copy.
  body.addEventListener('mouseup', () => { if (!window.getSelection()?.toString()) input.focus(); });
  const focused = (on: boolean) => document.body.classList.toggle('focused', on);
  input.addEventListener('focus', () => focused(true));
  input.addEventListener('blur', () => focused(false));
  window.addEventListener('focus', () => { if (!window.getSelection()?.toString()) input.focus(); });

  /* ----- Title bar ----- */
  el('twNew').onclick = () => quietly(api.win.newTerminal());
  killBtn.onclick = () => { stop(); input.focus(); };
  el('twMin').onclick = () => quietly(api.win.minimize());
  el('twMax').onclick = () => quietly(api.win.toggleMaximize());
  el('twClose').onclick = () => quietly(api.win.close());
  const max = el('twMax');
  const showMaximized = (on: boolean) => {
    max.title = on ? 'Restore' : 'Maximize';
    max.setAttribute('aria-label', max.title);
    max.querySelector('svg')!.innerHTML = on
      ? '<rect x=".5" y="2.5" width="7" height="7"/><path d="M2.5 2.5V.5h7v7h-2"/>'
      : '<rect x=".5" y=".5" width="9" height="9"/>';
  };
  api.win.onMaximized(showMaximized);
  void api.win.isMaximized().then(showMaximized, () => { /* closing */ });

  /* ----- The welcome banner: facts about this PC, like neofetch ----- */
  function banner(user: string, sys: [string, string][]): HTMLElement {
    const box = document.createElement('div');
    box.className = 'tw-fetch';
    const info = document.createElement('div');
    info.className = 'tw-fetch-info';
    const row = (...nodes: (Node | string)[]) => { const d = document.createElement('div'); d.append(...nodes); info.append(d); };
    if (user) { row(tok(user, 'tw-fetch-key')); row('-'.repeat(user.length)); }
    for (const [k, v] of sys) row(tok(`${k}: `, 'tw-fetch-key'), v);
    box.append(info);
    return box;
  }

  void api.info().then(i => {
    cwd = i.cwd;
    platform = i.platform;
    out.prepend(banner(i.user ?? '', i.sys ?? []));
    if (platform === 'darwin') document.documentElement.classList.add('mac');
    const folder = cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd;
    const title = `Terminal - ${folder} - Breeze Code`;
    document.title = title;
    el('twTitle').textContent = title;
    renderPs();
    renderInput();
    input.focus();
  });
})();
