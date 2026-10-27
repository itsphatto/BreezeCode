/* ================= Terminal ================= */
interface ErrorRef { path: string; line: number; col: number; msg: string; error: boolean; start: number; end: number; }

interface TermSession {
  id: number;
  name: string;
  cwd: string;
  proc: number | null;
  runId: number | null;
  history: string[];
  hIdx: number;
  runCwd: string;
  pending: { el: HTMLElement; text: string } | null;
  refs: ErrorRef[];
  paneEl: HTMLElement;
  inputVal: string;
}

let nextTermSessionId = 1;
const termSessions: TermSession[] = [];
let activeTermSession: TermSession = null as any;

const termOut = $('#termOut');
const termInput = $<HTMLInputElement>('#termInput');
const termGhost = $('#termGhost'); // declared before the first session is made below, which clears it

// Backward-compatibility proxy for code accessing single 'term'
const term = {
  get cwd() { return activeTermSession?.cwd ?? ''; },
  set cwd(v: string) { if (activeTermSession) activeTermSession.cwd = v; },
  get proc() { return activeTermSession?.proc ?? null; },
  set proc(v: number | null) { if (activeTermSession) activeTermSession.proc = v; },
  get runId() { return activeTermSession?.runId ?? null; },
  set runId(v: number | null) { if (activeTermSession) activeTermSession.runId = v; },
  get history() { return activeTermSession?.history ?? store.get<string[]>('breeze.termHistory', []); },
  set history(v: string[]) { if (activeTermSession) activeTermSession.history = v; },
  get hIdx() { return activeTermSession?.hIdx ?? 0; },
  set hIdx(v: number) { if (activeTermSession) activeTermSession.hIdx = v; },
  get runCwd() { return activeTermSession?.runCwd ?? ''; },
  set runCwd(v: string) { if (activeTermSession) activeTermSession.runCwd = v; },
  get pending() { return activeTermSession?.pending ?? null; },
  set pending(v: { el: HTMLElement; text: string } | null) { if (activeTermSession) activeTermSession.pending = v; },
  get refs() { return activeTermSession?.refs ?? []; },
  set refs(v: ErrorRef[]) { if (activeTermSession) activeTermSession.refs = v; },
};

function createPromptHtml(cwd: string): string {
  let path = cwd || '~';
  path = path.replaceAll('/', '\\');
  path = path.replace(/^([a-zA-Z]):/, (_, d) => d.toUpperCase() + ':');
  return `<span class="ps-prefix">PS</span> <span class="ps-path" title="${escAttr(cwd || '~')}">${esc(path)}</span><span class="ps-arrow">&gt;</span>`;
}

function renderPs(): void {
  const el = $('#termPs');
  if (el) el.innerHTML = createPromptHtml(term.cwd);
}

function createPromptElement(cwd: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'ps term-prompt-line';
  span.innerHTML = createPromptHtml(cwd);
  return span;
}

let termScrollRaf = 0;
function scheduleTermScroll(): void {
  if (termScrollRaf) return;
  termScrollRaf = requestAnimationFrame(() => {
    termScrollRaf = 0;
    const b = $('#termBody');
    if (b) b.scrollTop = b.scrollHeight;
  });
}

function activateTermSession(id: number): void {
  const session = termSessions.find(s => s.id === id);
  if (!session) return;

  if (activeTermSession && activeTermSession !== session) {
    activeTermSession.inputVal = termInput.value;
  }

  activeTermSession = session;
  termInput.value = session.inputVal;
  termGhost.innerHTML = '';

  for (const s of termSessions) {
    if (s.paneEl) {
      s.paneEl.style.display = s.id === id ? 'block' : 'none';
    }
  }

  renderPs();
  if (session.proc != null) {
    $('#termPs').classList.add('busy');
  } else {
    $('#termPs').classList.remove('busy');
  }

  renderTermTabs();
  scheduleTermScroll();
  termInput.focus();
}

// The first free name: "Terminal", then "Terminal 2", "Terminal 3"… reusing numbers of closed ones.
function nextTermName(): string {
  const used = new Set(termSessions.map(s => s.name));
  if (!used.has('Terminal')) return 'Terminal';
  let n = 2;
  while (used.has(`Terminal ${n}`)) n++;
  return `Terminal ${n}`;
}

function createTermSession(name?: string): TermSession {
  const id = nextTermSessionId++;
  const sessionName = name || nextTermName();

  let paneEl: HTMLElement;
  const initialPane = $('#termOut');
  if (id === 1 && initialPane) {
    paneEl = initialPane;
  } else {
    paneEl = document.createElement('div');
    paneEl.className = 'term-out-pane';
    const termLine = $('.term-line', $('#termBody'));
    if (termLine) {
      $('#termBody').insertBefore(paneEl, termLine);
    } else {
      $('#termBody').appendChild(paneEl);
    }
  }

  const session: TermSession = {
    id,
    name: sessionName,
    cwd: activeTermSession?.cwd || (rootInfo?.root ?? ''),
    proc: null,
    runId: null,
    history: [...store.get<string[]>('breeze.termHistory', [])],
    hIdx: 0,
    runCwd: '',
    pending: null,
    refs: [],
    paneEl,
    inputVal: '',
  };
  session.hIdx = session.history.length;

  termSessions.push(session);
  activateTermSession(session.id);
  return session;
}

function closeTermSession(id: number, e?: MouseEvent): void {
  if (e) {
    e.stopPropagation();
    e.preventDefault();
  }
  const idx = termSessions.findIndex(s => s.id === id);
  if (idx < 0) return;
  const session = termSessions[idx];

  if (session.proc != null) {
    background(api.term.kill(session.proc));
  }

  const pane = session.paneEl;
  const wasActive = activeTermSession?.id === id;
  termSessions.splice(idx, 1);
  renderTermTabs(); // the tab starts folding away now

  // The closed terminal's output fades and sinks away first, then the next one fades up in its place.
  const shown = wasActive && pane && pane.offsetParent !== null && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  const out = shown ? pane.animate([{ opacity: 1, transform: 'none', filter: 'blur(0)' }, { opacity: 0, transform: 'translateY(6px)', filter: 'blur(2px)' }], { duration: 170, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' }) : null;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    if (pane && pane !== $('#termOut')) pane.remove();
    else if (pane) { pane.getAnimations().forEach(a => a.cancel()); pane.innerHTML = ''; }
    if (termSessions.length === 0) {
      createTermSession();
    } else if (wasActive) {
      const next = termSessions[Math.min(idx, termSessions.length - 1)];
      activateTermSession(next.id);
      if (shown) next.paneEl?.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.16, 1, .3, 1)' });
    }
  };
  if (out) { out.finished.then(finish, finish); setTimeout(finish, 260); } else finish(); // a hidden window pauses animations
}

const TERM_TAB_ANIM_MS = 220;
// Same X as the agent tabs' close button
const TAB_CLOSE_SVG = '<svg class="tab-close-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

function buildTermTab(s: TermSession): HTMLElement {
  const tab = document.createElement('div');
  tab.className = 'term-tab';
  tab.dataset.tid = String(s.id);

  const dot = document.createElement('span');
  dot.className = 'term-tab-dot';
  tab.appendChild(dot);

  const title = document.createElement('span');
  title.className = 'term-tab-title';
  tab.appendChild(title);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'term-tab-close';
  closeBtn.type = 'button';
  closeBtn.title = 'Close terminal';
  closeBtn.setAttribute('aria-label', 'Close terminal');
  closeBtn.innerHTML = TAB_CLOSE_SVG;
  closeBtn.onclick = (e) => closeTermSession(s.id, e);
  tab.appendChild(closeBtn);

  tab.onclick = (e) => {
    if ((e.target as HTMLElement).closest('.term-tab-close') || tab.classList.contains('leaving')) return;
    activateTermSession(s.id);
  };
  return tab;
}

function renderTermTabs(): void {
  const tabsContainer = $('#termTabs');
  if (!tabsContainer) return;
  // With one terminal the lone tab sheds its dot, chip and close button ("solo") and reads like a plain title;
  // from two on it grows them back.
  const many = termSessions.length > 1;
  const firstRender = !tabsContainer.dataset.ready;
  const wasHidden = firstRender;

  const existing = new Map<number, HTMLElement>();
  for (const el of $$<HTMLElement>('.term-tab', tabsContainer)) {
    if (!el.classList.contains('leaving')) existing.set(Number(el.dataset.tid), el);
  }
  const liveIds = new Set(termSessions.map(s => s.id));

  // Collapse out tabs whose session is gone
  for (const [tid, el] of existing) {
    if (liveIds.has(tid)) continue;
    existing.delete(tid);
    if (wasHidden) { el.remove(); continue; }
    el.classList.remove('enter');
    el.style.width = `${el.getBoundingClientRect().width}px`;
    forceReflow(el);
    el.classList.add('leaving');
    let done = false;
    const finish = () => { if (done) { return; } done = true; el.remove(); };
    el.addEventListener('transitionend', e => { if (e.target === el && e.propertyName === 'width') finish(); });
    setTimeout(finish, TERM_TAB_ANIM_MS + 80);
  }

  // Add / update live tabs in session order (leaving tabs stay where they were while they collapse)
  let prev: HTMLElement | null = null;
  for (const s of termSessions) {
    let tab = existing.get(s.id);
    if (!tab) {
      tab = buildTermTab(s);
      if (many) {
        tab.classList.add('enter');
        tab.addEventListener('animationend', () => tab!.classList.remove('enter'), { once: true });
      }
      if (prev) prev.after(tab);
      else tabsContainer.prepend(tab);
    }
    tab.classList.toggle('active', s.id === activeTermSession?.id);
    tab.classList.toggle('busy', s.proc != null);
    tab.title = `${s.name}${s.proc != null ? ' (running)' : ''}`;
    const title = $('.term-tab-title', tab);
    if (title && title.textContent !== s.name) title.textContent = s.name;
    prev = tab;
  }

  if (firstRender) {
    // Settle into the initial state without animating
    tabsContainer.dataset.ready = '1';
    tabsContainer.classList.add('no-morph');
    tabsContainer.classList.remove('hidden');
    $('#termTitleText')?.classList.add('hidden');
    tabsContainer.classList.toggle('solo', !many);
    forceReflow(tabsContainer);
    tabsContainer.classList.remove('no-morph');
    return;
  }

  // 2 → 1 sheds the dot / chip / X while the closed tab collapses; 1 → 2 grows them back
  tabsContainer.classList.toggle('solo', !many);

  // Keep the active tab in view when the strip is squeezed and scrolls
  updateTermTabsTight();
  const activeEl = tabsContainer.querySelector<HTMLElement>('.term-tab.active:not(.leaving)');
  if (many && activeEl && tabsContainer.scrollWidth > tabsContainer.clientWidth) {
    requestAnimationFrame(() => activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }));
  }
}

// Drops the dot and trims padding only when the tabs genuinely can't fit at their normal minimum
function updateTermTabsTight(): void {
  const el = $('#termTabs');
  if (!el) return;
  if (el.classList.contains('solo')) { el.classList.remove('tight'); return; }
  const wasTight = el.classList.contains('tight');
  el.classList.add('no-morph');
  el.classList.remove('tight');
  const overflow = el.scrollWidth > el.clientWidth + 1;
  el.classList.toggle('tight', overflow);
  forceReflow(el);
  el.classList.remove('no-morph');
  if (wasTight !== overflow) {
    // Re-run once the class change has settled so the transition plays from the right state
    el.classList.toggle('tight', wasTight);
    forceReflow(el);
    el.classList.toggle('tight', overflow);
  }
}
{
  const ro = new ResizeObserver(() => updateTermTabsTight());
  const head = $('#termToggle');
  if (head) ro.observe(head);
}

// Squeezed terminal tabs scroll sideways with the mouse wheel
$('#termTabs')?.addEventListener('wheel', e => {
  const el = e.currentTarget as HTMLElement;
  if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
  e.preventDefault();
  el.scrollLeft += e.deltaY;
}, { passive: false });

// Initialise default session if none exists
if (termSessions.length === 0) {
  createTermSession();
}

// Colour codes and lone carriage returns don't render in the panel.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// Where compilers and Python say the trouble is: `file:line:col: error: msg` (GCC, clang), `File "file", line N`,
// and `file(line,col): error CS1002: msg [project.csproj]` (C#).
const GCC_REF = /^((?:[A-Za-z]:[\\/])?[^:\n]+?):(\d+):(?:(\d+):)?[ \t]*(fatal error|error|warning|note):[ \t]*(.*)$/gm;
const CS_REF = /^[ \t]*((?:[A-Za-z]:[\\/])?[^:(\n]+?\.csx?)\((\d+),(\d+)\):[ \t]*(error|warning)[ \t]+(\w+):[ \t]*([^\r\n]*?)(?:[ \t]+\[[^\]\n]+\])?\r?$/gm;
const PY_REF = /^[ \t]*(File "([^"\n]+)", line (\d+))/gm;
// rustc and cargo name the problem on one line and point at it on a later one: `error[E0308]: mismatched types`, then
// ` --> src/main.rs:4:18`. The heading is kept between calls, since the output arrives in pieces. (javac's
// `Main.java:3: error: msg` is GCC's shape.)
const RS_REF = /^(?:(error|warning)(?:\[\w+\])?:[ \t]*([^\r\n]*)|[ \t]*--> ((?:[A-Za-z]:(?=[\\/]))?[^:\n]+?):(\d+):(\d+))/gm;
let rustHead = { error: true, msg: '' };
// Turns a path from the output into a project-relative one, or null when it points outside the project.
// Windows paths (drive letter) compare without regard to case or slash direction.
function projectPath(p: string, cwd: string, root: string): string | null {
  const slash = (x: string) => x.replaceAll('\\', '/');
  const parts = (x: string) => { const out: string[] = []; for (const seg of slash(x).split('/')) { if (seg === '..') out.pop(); else if (seg && seg !== '.') out.push(seg); } return out; };
  const given = slash(p);
  const full = parts(/^(?:[A-Za-z]:)?\//.test(given) ? given : `${slash(cwd)}/${given}`);
  const base = parts(root);
  const same = (a: string, b: string) => (/^[A-Za-z]:/.test(base[0] ?? '') ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (full.length <= base.length || !base.every((seg, i) => same(seg, full[i]))) return null;
  return full.slice(base.length).join('/');
}
function parseErrorRefs(text: string, cwd: string, root: string): ErrorRef[] {
  const refs: ErrorRef[] = [];
  for (const m of text.matchAll(GCC_REF)) {
    const path = projectPath(m[1], cwd, root);
    if (path == null) continue;
    const end = m.index + m[1].length + 1 + m[2].length + (m[3] ? m[3].length + 1 : 0);
    refs.push({ path, line: Number(m[2]) - 1, col: m[3] ? Number(m[3]) - 1 : 0, msg: m[5].replace(/\r$/, ''), error: m[4] !== 'warning' && m[4] !== 'note', start: m.index, end });
  }
  for (const m of text.matchAll(CS_REF)) {
    const path = projectPath(m[1], cwd, root);
    if (path == null) continue;
    const start = m.index + m[0].indexOf(m[1]);
    const end = start + m[1].length + m[2].length + m[3].length + 3; // through "(line,col)"
    refs.push({ path, line: Number(m[2]) - 1, col: Number(m[3]) - 1, msg: `${m[5]}: ${m[6]}`, error: m[4] === 'error', start, end });
  }
  for (const m of text.matchAll(PY_REF)) {
    const path = projectPath(m[2], cwd, root);
    if (path == null) continue;
    const start = m.index + m[0].indexOf(m[1]);
    refs.push({ path, line: Number(m[3]) - 1, col: 0, msg: 'Python error (see the terminal)', error: false, start, end: start + m[1].length });
  }
  for (const m of text.matchAll(RS_REF)) {
    if (m[1]) { rustHead = { error: m[1] === 'error', msg: m[2] }; continue; }
    const path = projectPath(m[3], cwd, root);
    if (path == null) continue;
    const start = m.index + m[0].indexOf(m[3]);
    const end = start + m[3].length + m[4].length + m[5].length + 2; // through ":line:col"
    refs.push({ path, line: Number(m[4]) - 1, col: Number(m[5]) - 1, msg: rustHead.msg || 'Rust error (see the terminal)', error: rustHead.error, start, end });
  }
  return refs.sort((a, b) => a.start - b.start);
}

// 256-color palette mapper
function ansi256Color(n: number): string {
  if (n < 0 || n > 255) return '#ffffff';
  const std16 = [
    '#1f2335', '#f7768e', '#73daca', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5',
    '#565f89', '#ff899d', '#9ece6a', '#f1cf8a', '#89b4fa', '#cba6f7', '#89dceb', '#ffffff'
  ];
  if (n < 16) return std16[n];
  if (n < 232) {
    const idx = n - 16;
    const r = Math.floor(idx / 36);
    const g = Math.floor((idx % 36) / 6);
    const b = idx % 6;
    const toVal = (c: number) => c === 0 ? 0 : 55 + c * 40;
    return `rgb(${toVal(r)}, ${toVal(g)}, ${toVal(b)})`;
  }
  const gray = (n - 232) * 10 + 8;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

// Plain CLI semantic output highlighter (errors, warnings, successes, URLs)
function highlightPlainCli(text: string): string {
  let out = text;
  // npm CLI headers: "npm warn ...", "npm notice ...", "npm ERR! ..."
  out = out.replace(/\b(npm)(\s+)(warn(?:ing)?|notice|invalid|ERR!|error|info|http)\b/gi, (_m, npmWord, space, lvl) => {
    let lvlClass = 'term-kw-info';
    const lower = lvl.toLowerCase();
    if (lower.startsWith('warn')) lvlClass = 'term-kw-warning';
    else if (lower === 'notice' || lower === 'invalid' || lower === 'http') lvlClass = 'term-kw-cyan';
    else if (lower === 'err!' || lower === 'error') lvlClass = 'term-kw-error';
    return `<span class="term-npm">${npmWord}</span>${space}<span class="${lvlClass}">${lvl}</span>`;
  });
  // Secondary keywords: standalone or subsequent "invalid", "notice", "http"
  out = out.replace(/\b(?:invalid|notice|http)\b(?!s?:\/\/)(?![^<]*>)/gi, '<span class="term-kw-cyan">$&</span>');
  // General warning / error / success tokens
  out = out.replace(/\b(?:FATAL|FAIL|ERROR|Error|ERR!|error|fatal error)\b:?(?![^<]*>)/g, '<span class="term-kw-error">$&</span>');
  out = out.replace(/\b(?:WARN|WARNING|Warning|warning|warn)\b:?(?![^<]*>)/g, '<span class="term-kw-warning">$&</span>');
  out = out.replace(/(?:\b(?:SUCCESS|SUCCESSFUL|PASS|passed|compiled successfully|Done in)\b|✓)(?![^<]*>)/g, '<span class="term-kw-success">$&</span>');
  out = out.replace(/\b(?:INFO|Info|NOTE|Note|note|info)\b:?(?![^<]*>)/g, '<span class="term-kw-info">$&</span>');
  return out;
}

interface AnsiStyle {
  fgClass?: string;
  fgColor?: string;
  bgClass?: string;
  bgColor?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

function renderAnsiChunk(text: string, style: AnsiStyle): string {
  const classes: string[] = [];
  if (style.fgClass) classes.push(style.fgClass);
  if (style.bgClass) classes.push(style.bgClass);
  if (style.bold) classes.push('ansi-bold');
  if (style.dim) classes.push('ansi-dim');
  if (style.italic) classes.push('ansi-italic');
  if (style.underline) classes.push('ansi-underline');

  const styles: string[] = [];
  if (style.fgColor) styles.push(`color:${style.fgColor}`);
  if (style.bgColor) styles.push(`background-color:${style.bgColor}`);

  const escaped = esc(text);
  if (!classes.length && !styles.length) {
    return highlightPlainCli(escaped);
  }
  const clsAttr = classes.length ? ` class="${classes.join(' ')}"` : '';
  const styleAttr = styles.length ? ` data-style="${styles.join(';')}"` : '';
  return `<span${clsAttr}${styleAttr}>${escaped}</span>`;
}

function parseAnsiToHtml(raw: string): string {
  const text = raw.replaceAll(/\x1b\[[0-9;?]*[ -/]*[@-ln-~]/g, '').replaceAll(/\r(?!\n)/g, '');
  if (!text) return '';
  if (!text.includes('\x1b[')) {
    return highlightPlainCli(esc(text));
  }

  const SGR_REGEX = /\x1b\[([0-9;]*)m/g;
  let html = '';
  let lastIndex = 0;
  const style: AnsiStyle = {};
  const colorNames = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

  let match: RegExpExecArray | null;
  while ((match = SGR_REGEX.exec(text)) !== null) {
    const chunk = text.slice(lastIndex, match.index);
    if (chunk) {
      html += renderAnsiChunk(chunk, style);
    }
    lastIndex = SGR_REGEX.lastIndex;

    const rawCodes = match[1] ? match[1].split(';').map(Number) : [0];
    let i = 0;
    while (i < rawCodes.length) {
      const code = rawCodes[i];
      if (code === 0) {
        style.fgClass = undefined; style.fgColor = undefined;
        style.bgClass = undefined; style.bgColor = undefined;
        style.bold = false; style.dim = false; style.italic = false; style.underline = false;
      } else if (code === 1) {
        style.bold = true;
      } else if (code === 2) {
        style.dim = true;
      } else if (code === 3) {
        style.italic = true;
      } else if (code === 4) {
        style.underline = true;
      } else if (code === 22) {
        style.bold = false; style.dim = false;
      } else if (code === 23) {
        style.italic = false;
      } else if (code === 24) {
        style.underline = false;
      } else if (code >= 30 && code <= 37) {
        style.fgClass = `ansi-fg-${colorNames[code - 30]}`;
        style.fgColor = undefined;
      } else if (code === 38) {
        if (rawCodes[i + 1] === 5 && rawCodes[i + 2] != null) {
          style.fgColor = ansi256Color(rawCodes[i + 2]);
          style.fgClass = undefined;
          i += 2;
        } else if (rawCodes[i + 1] === 2 && rawCodes[i + 2] != null && rawCodes[i + 3] != null && rawCodes[i + 4] != null) {
          style.fgColor = `rgb(${rawCodes[i + 2]}, ${rawCodes[i + 3]}, ${rawCodes[i + 4]})`;
          style.fgClass = undefined;
          i += 4;
        }
      } else if (code === 39) {
        style.fgClass = undefined; style.fgColor = undefined;
      } else if (code >= 40 && code <= 47) {
        style.bgClass = `ansi-bg-${colorNames[code - 40]}`;
        style.bgColor = undefined;
      } else if (code === 48) {
        if (rawCodes[i + 1] === 5 && rawCodes[i + 2] != null) {
          style.bgColor = ansi256Color(rawCodes[i + 2]);
          style.bgClass = undefined;
          i += 2;
        } else if (rawCodes[i + 1] === 2 && rawCodes[i + 2] != null && rawCodes[i + 3] != null && rawCodes[i + 4] != null) {
          style.bgColor = `rgb(${rawCodes[i + 2]}, ${rawCodes[i + 3]}, ${rawCodes[i + 4]})`;
          style.bgClass = undefined;
          i += 4;
        }
      } else if (code === 49) {
        style.bgClass = undefined; style.bgColor = undefined;
      } else if (code >= 90 && code <= 97) {
        style.fgClass = `ansi-fg-bright-${colorNames[code - 90]}`;
        style.fgColor = undefined;
      } else if (code >= 100 && code <= 107) {
        style.bgClass = `ansi-bg-bright-${colorNames[code - 100]}`;
        style.bgColor = undefined;
      }
      i++;
    }
  }

  const remaining = text.slice(lastIndex);
  if (remaining) {
    html += renderAnsiChunk(remaining, style);
  }
  return html;
}

// Command syntax highlighter (command, flags, strings, numbers, arguments)
function formatCommandSyntax(cmd: string): string {
  if (!cmd) return '';
  const trimmed = cmd.trimStart();
  const leading = cmd.slice(0, cmd.length - trimmed.length);
  const tokenRegex = /--?[a-zA-Z0-9_-]+|"[^"]*"|'[^']*'|\S+/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  let isFirst = true;
  let html = esc(leading);
  while ((match = tokenRegex.exec(trimmed)) !== null) {
    const gap = trimmed.slice(lastIndex, match.index);
    if (gap) html += esc(gap);
    const token = match[0];
    if (isFirst) {
      html += `<span class="term-cmd-name">${esc(token)}</span>`;
      isFirst = false;
    } else if (token.startsWith('-')) {
      html += `<span class="term-cmd-flag">${esc(token)}</span>`;
    } else if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      html += `<span class="term-cmd-str">${esc(token)}</span>`;
    } else if (/^\d+$/.test(token)) {
      html += `<span class="term-cmd-num">${esc(token)}</span>`;
    } else {
      html += `<span class="term-cmd-arg">${esc(token)}</span>`;
    }
    lastIndex = tokenRegex.lastIndex;
  }
  const trailing = trimmed.slice(lastIndex);
  if (trailing) html += esc(trailing);
  return html;
}

const cleanOut = (text: string) => text.replaceAll(ANSI, '').replaceAll(/\r(?!\n)/g, '');

function termAppend(el: HTMLElement, session: TermSession = activeTermSession): void {
  const pane = session?.paneEl || termOut;
  pane.appendChild(el);
  while (pane.childNodes.length > 3000) pane.firstChild?.remove();
  if (session === activeTermSession) scheduleTermScroll();
}

// The page's CSP doesn't allow style="" attributes, so HTML strings carry per-element styles as data-style and
// they're applied through the CSSOM (which the CSP allows) right after the HTML goes in.
function applyDataStyles(root: Element): void {
  for (const el of root.querySelectorAll<HTMLElement | SVGElement>('[data-style]')) {
    el.style.cssText += `;${el.dataset.style ?? ''}`;
    delete el.dataset.style;
  }
}
// Saved HTML (a chat from history) back into the page, keeping the inline styles it was saved with.
function setSavedHtml(el: Element, html: string): void {
  el.innerHTML = html.replaceAll(' style="', ' data-style="');
  applyDataStyles(el);
}
// Terminal output with its ANSI colours (the 256-colour and true-colour ones arrive as data-style).
function setAnsiHtml(el: HTMLElement, raw: string): void {
  el.innerHTML = parseAnsiToHtml(raw);
  applyDataStyles(el);
  linkUrls(el);
}
// Web addresses become plain-click links (they open in the browser), even when colours split one across several
// spans: Vite prints its URL in cyan with the port in bold.
function linkUrls(el: HTMLElement): void {
  const nodes: Text[] = [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) nodes.push(walk.currentNode as Text);
  const starts: number[] = [];
  let text = '';
  for (const n of nodes) { starts.push(text.length); text += n.data; }
  // The node holding text offset i: an end sits at the tail of the node before a boundary, a start at the head of the next.
  const at = (i: number, end: boolean): [Text, number] => {
    let k = nodes.length - 1;
    while (k > 0 && (end ? starts[k] >= i : starts[k] > i)) k--;
    return [nodes[k], i - starts[k]];
  };
  // Last match first: extracting one only cuts nodes after the earlier matches, so their offsets stay right.
  for (const m of [...text.matchAll(/https?:\/\/[^\s<>"'`)]*[^\s<>"'`).,;:!?]/g)].reverse()) {
    const r = document.createRange();
    r.setStart(...at(m.index, false));
    r.setEnd(...at(m.index + m[0].length, true));
    const a = document.createElement('a');
    a.className = 'term-url';
    a.href = m[0];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.append(r.extractContents());
    r.insertNode(a);
  }
}
function termWrite(text: string, cls = '', session: TermSession = activeTermSession): HTMLElement {
  const target = session || activeTermSession;
  const span = document.createElement('span');
  if (cls) span.className = cls;
  setAnsiHtml(span, text);
  if (target) target.pending = null; // anything written here ends the run's open line
  termAppend(span, target);
  return span;
}

// A run's output: finished lines show their error locations as links; the unfinished last line stays
// plain (a prompt like "Name: " has no newline) and is swapped for the linked version once it ends.
function runOutput(chunk: string, session: TermSession = activeTermSession): void {
  const target = session || activeTermSession;
  const full = (target?.pending?.text ?? '') + chunk;
  target?.pending?.el.remove();
  if (target) target.pending = null;
  const nl = full.lastIndexOf('\n');
  if (nl >= 0) termLinked(full.slice(0, nl + 1), target);
  const rest = full.slice(nl + 1);
  if (rest && target) target.pending = { el: termWrite(rest, '', target), text: rest }; // termWrite cleared `pending`; set it after
}

function termLinked(text: string, session: TermSession = activeTermSession): void {
  const target = session || activeTermSession;
  const refs = rootInfo && target ? parseErrorRefs(text, target.runCwd, rootInfo.root) : [];
  if (target) target.refs.push(...refs.filter(r => r.error));
  const span = document.createElement('span');
  let at = 0;
  for (const r of refs) {
    if (r.start < at) continue;
    if (r.start > at) {
      const chunkSpan = document.createElement('span');
      setAnsiHtml(chunkSpan, text.slice(at, r.start));
      span.append(chunkSpan);
    }
    const a = document.createElement('a');
    a.className = 'term-ref';
    a.textContent = cleanOut(text.slice(r.start, r.end));
    a.dataset.path = r.path; a.dataset.line = String(r.line); a.dataset.col = String(r.col);
    span.append(a);
    at = r.end;
  }
  if (at < text.length) {
    const chunkSpan = document.createElement('span');
    setAnsiHtml(chunkSpan, text.slice(at));
    span.append(chunkSpan);
  }
  termAppend(span, target);
}
$('#termBody').addEventListener('click', e => {
  const a = (e.target as HTMLElement).closest<HTMLElement>('.term-ref');
  if (a) openFile(a.dataset.path as string, { line: Number(a.dataset.line), col: Number(a.dataset.col) });
});
// A failed run underlines its errors in the open files (next to the editor's own findings); the next run
// or the next lint of a file takes them away again.
function clearRunDiags(): void {
  let any = false;
  for (const b of buffers.values()) {
    if (!b.runDiags) continue;
    const mine = b.runDiags;
    b.diags = b.diags?.filter(d => !mine.includes(d));
    b.runDiags = undefined; any = true;
  }
  if (any) { renderTabs(); renderCode(); }
}
function showRunErrors(refs: ErrorRef[]): void {
  for (const b of buffers.values()) {
    if (b.kind !== 'text') continue;
    const lines = b.text.split('\n');
    const diags = b.diags ?? [];
    const add: Diag[] = [];
    for (const r of refs) {
      if (r.path !== b.path || r.line >= lines.length || diags.some(d => d.line === r.line) || add.some(d => d.line === r.line)) continue;
      const lt = lines[r.line];
      const col = r.col || Math.max(0, lt.search(/\S/));
      add.push({ line: r.line, col, len: r.col ? (/^\S+/.exec(lt.slice(col))?.[0].length ?? 1) : Math.max(1, lt.trimEnd().length - col), msg: r.msg });
    }
    if (!add.length) continue;
    const had = diags.length > 0;
    b.diags = [...diags, ...add].sort((x, y) => x.line - y.line);
    b.runDiags = add;
    b.diagLines = lines.length;
    if (!had) renderTabs();
    if (b.path === active) renderCode();
  }
}
function killCommand(): void {
  const session = activeTermSession;
  if (session?.proc == null) return;
  background(api.term.kill(session.proc));
  termWrite('^C\n', '', session);
}
function termWriteCommand(cmd: string, session: TermSession = activeTermSession): void {
  const target = session || activeTermSession;
  const span = document.createElement('span');
  span.className = 'cmd';
  span.innerHTML = `${formatCommandSyntax(cmd)}\n`;
  termAppend(span, target);
}
async function runCommand(cmd: string): Promise<void> {
  const session = activeTermSession;
  if (!session) return;
  if (session.proc != null) { background(api.term.write(session.proc, cmd + '\n')); termWrite(cmd + '\n', 'cmd', session); return; }
  termAppend(createPromptElement(session.cwd), session);
  termWriteCommand(cmd, session);
  if (!cmd.trim()) return;
  if (!session.history.length || session.history.at(-1) !== cmd) {
    session.history.push(cmd);
    if (session.history.length > 200) session.history.shift();
    store.set('breeze.termHistory', session.history);
  }
  session.hIdx = session.history.length;
  if (/^\s*(?:cls|clear)\s*$/i.test(cmd)) { if (session.paneEl) { session.paneEl.innerHTML = ''; } return; }
  const r = await api.term.run(cmd).catch((err: unknown) => ({ error: errMsg(err) }) as { id?: number; cwd?: string; error?: string });
  if (r.error) termWrite(r.error + '\n', 'err', session);
  if (r.cwd) { session.cwd = r.cwd; renderPs(); }
  if (r.id != null) {
    session.proc = r.id;
    $('#termPs').classList.add('busy');
    renderTermTabs();
  }
}
// C, C++, C#, Java, Python and Rust files run in the terminal; their input comes from the terminal's input line.
function runnable(path: string | null): boolean { return !!path && /\.(?:c|cpp|cc|cxx|cs|java|py|rs)$/i.test(path); }
async function runFile(): Promise<void> {
  const b = activeBuf();
  if (!active || b?.kind !== 'text') { toast('Save the file first'); return; }
  if (term.proc != null && term.runId == null) { toast('A command is still running — press Ctrl+C to stop it'); return; }
  if (term.runId != null) { // a run is going: main refuses and says so; leave the running program's output and the file alone
    const busy = await api.run.file(active).catch((err: unknown) => ({ error: errMsg(err) }) as { id?: number; error?: string });
    if (busy.error) termWrite(busy.error + '\n', 'err');
    else if (busy.id != null) {
      term.proc = term.runId = busy.id;
      $('#termPs').classList.add('busy');
      renderTermTabs();
    } // it had just finished
    return;
  }
  if (isDirty(b) && !(await saveFile(active))) return;
  layout.termOpen = true; applyLayout();
  clearRunDiags();
  term.runCwd = joinPath(rootInfo?.root ?? '', dirName(active)); term.refs = []; term.pending = null; rustHead = { error: true, msg: '' };
  const r = await api.run.file(active).catch((err: unknown) => ({ error: errMsg(err) }) as { id?: number; cwd?: string; error?: string });
  if (r.cwd) term.runCwd = r.cwd; // a Cargo project runs from its own folder
  if (r.error) termWrite(r.error + '\n', 'err');
  else if (r.id != null) {
    term.proc = term.runId = r.id;
    $('#termPs').classList.add('busy');
    renderTermTabs();
    sfx.play('build');
  }
  termInput.focus();
}
termInput.addEventListener('keydown', e => {
  if (terminalAutofillKeys(e)) return;
  if (e.key === 'c' && e.ctrlKey && term.proc != null && termInput.selectionStart === termInput.selectionEnd) { e.preventDefault(); killCommand(); return; }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    term.hIdx = clamp(term.hIdx + (e.key === 'ArrowUp' ? -1 : 1), 0, term.history.length);
    termInput.value = term.history[term.hIdx] ?? '';
    updateGhost();
    return;
  }
  if (e.key !== 'Enter') return;
  const cmd = termInput.value;
  termInput.value = '';
  termGhost.innerHTML = '';
  void runCommand(cmd);
});

api.term.onData((id, chunk) => {
  const session = termSessions.find(s => s.proc === id);
  if (!session) return;
  if (id === session.runId) {
    runOutput(chunk, session);
  } else {
    termWrite(chunk, '', session);
  }
});

api.term.onExit((id, code) => {
  const session = termSessions.find(s => s.proc === id);
  if (!session) return;
  const runId = session.runId;
  session.proc = null; session.runId = null;
  if (session === activeTermSession) {
    $('#termPs').classList.remove('busy');
  }
  renderTermTabs();
  if (id !== runId) {
    if (code === 0) {
      const okDiv = document.createElement('div');
      okDiv.className = 'term-exit-ok';
      okDiv.textContent = '✓ process completed (exit code 0)';
      termAppend(okDiv, session);
    } else if (code) {
      const errDiv = document.createElement('div');
      errDiv.className = 'term-exit-err';
      errDiv.textContent = `✕ process failed with exit code ${code}`;
      termAppend(errDiv, session);
    }
  }
  if (id !== runId) return;
  if (code === 0) sfx.play('success');
  if (session.pending) {
    const rest = session.pending.text;
    session.pending.el.remove();
    session.pending = null;
    termLinked(rest, session);
  }
  if (session === activeTermSession) {
    clearRunDiags();
    if (code) showRunErrors(session.refs);
  }
});
$('#termBody').addEventListener('mouseup', () => { if (!getSelection()?.toString()) termInput.focus(); });
$('#termToggle').addEventListener('click', e => { if (!(e.target as HTMLElement).closest('button, .term-tabs, .term-tab')) run('term.toggle'); });

