/* ================= Breeze Box: the file an agent is editing, live ================= */
// The right-hand panel shows one file at a time: the last one a Box agent touched. A new file types in as the agent
// drafts it; an edited one is read back after each write, with the lines that changed marked and scrolled into view.
// What was last shown (or, the first time, the committed version) is what "changed" is measured against.
const LIVE_MAX_LINES = 5000; // past this only the start is drawn; a huge file would take too long to lay out
const liveSeen = new Map<string, string>();
let livePath: string | null = null;
let liveReads = 0; // a later read wins over an earlier one still in flight

function liveEmpty(): void {
  livePath = null;
  $('#boxLive').classList.remove('writing');
  $('#boxLiveHead').innerHTML = '';
  $('#boxLiveBody').innerHTML = `<div class="box-live-empty">${svgIcon('code', 22)}<div>When an agent edits a file, it shows here as it's written.</div></div>`;
}

// The first and last line (0-based, inclusive) where `next` differs from `prev`; null when they match.
function changedLines(prev: string, next: string): [number, number] | null {
  if (prev === next) return null;
  const a = prev.split('\n'), b = next.split('\n');
  let top = 0;
  while (top < a.length && top < b.length && a[top] === b[top]) top++;
  let ea = a.length - 1, eb = b.length - 1;
  while (ea >= top && eb >= top && a[ea] === b[eb]) { ea--; eb--; }
  // Lines only removed: mark the line where they were.
  return [Math.min(top, b.length - 1), Math.max(top, Math.min(eb, b.length - 1))];
}

function liveHead(path: string, status: string): void {
  const p = path.replaceAll('\\', '/');
  const dir = dirName(p);
  $('#boxLiveHead').innerHTML = `<span class="ico">${fileIcon(baseName(p))}</span>
    <span class="box-live-name" title="${escAttr(p)}"><b>${esc(baseName(p))}</b>${dir ? `<small>${esc(dir)}</small>` : ''}</span>
    <span class="box-live-status">${esc(status)}</span>
    ${rootInfo ? `<button class="icon-btn" type="button" id="boxLiveOpen" title="Open in Breeze Code">${svgIcon('external', 14)}</button>` : ''}`;
}

function liveRender(path: string, text: string, prev: string | undefined, writing: boolean): void {
  const switched = livePath !== path;
  livePath = path;
  $('#boxLive').classList.toggle('writing', writing);
  liveHead(path, writing ? 'Writing' : 'Edited');
  const lexer = langOf(path)[0];
  const d: HlDoc = { text, lexer, ...fullToks(text, lexer), lines: lineStartsOf(text), html: [] };
  const count = Math.min(d.lines.length, LIVE_MAX_LINES);
  const changed = prev === undefined ? null : changedLines(prev, text);
  let rows = '';
  for (let i = 0; i < count; i++) {
    const on = changed && i >= changed[0] && i <= changed[1] ? ' changed' : '';
    rows += `<div class="ln${on}"><span class="no">${i + 1}</span><span class="tx">${lineHtmlOf(d, i) || ' '}</span></div>`;
  }
  if (d.lines.length > count) rows += `<div class="box-live-more">${(d.lines.length - count).toLocaleString()} more lines</div>`;
  const body = $('#boxLiveBody');
  body.innerHTML = `<div class="box-live-code">${rows}</div>`;
  // Follow the agent: the end of a file being drafted, otherwise the first changed line.
  const target = writing ? body.querySelector<HTMLElement>('.ln:last-child') : body.querySelector<HTMLElement>('.ln.changed');
  if (target) target.scrollIntoView({ block: writing ? 'end' : 'center', behavior: switched || reduceMotion.matches ? 'auto' : 'smooth' });
  else if (switched) body.scrollTop = 0;
}

// The agent's text for a file it is creating, as it writes it.
function liveDraft(path: string, text: string): void {
  if (baseName(path).startsWith('.env')) return;
  liveRender(path, text, undefined, true);
  liveSeen.set(path, text);
}

// The agent wrote `path`: read it back and show it. Some agents report a file just before writing it, so it is
// read again shortly after, and redrawn only if it changed.
function liveFile(path: string): void {
  if (baseName(path).startsWith('.env')) {
    liveHead(path, 'Edited');
    $('#boxLiveBody').innerHTML = '<div class="box-live-empty"><div>.env files stay private, so this one isn\'t shown.</div></div>';
    livePath = path;
    return;
  }
  const read = ++liveReads;
  const show = async () => {
    const r = await api.fs.readFile(path).catch(() => null);
    if (read !== liveReads) return;
    if (r?.text == null || kindOf(r) !== 'text') {
      liveHead(path, 'Edited');
      $('#boxLiveBody').innerHTML = '<div class="box-live-empty"><div>This file can\'t be shown here (binary, too large or removed).</div></div>';
      livePath = path;
      return;
    }
    let prev = liveSeen.get(path);
    if (prev === r.text && livePath === path && !$('#boxLive').classList.contains('writing')) return;
    if (prev === undefined) prev = await api.git.headText(path).catch(() => null) ?? undefined;
    if (read !== liveReads) return;
    liveRender(path, r.text, prev, false);
    liveSeen.set(path, r.text);
  };
  for (const ms of [0, 400, 1500]) setTimeout(() => background(show()), ms);
}

$('#boxLiveHead').addEventListener('click', e => {
  if (!(e.target as HTMLElement).closest('#boxLiveOpen') || !livePath) return;
  const path = livePath;
  enterMode('ide');
  openFile(path);
});
liveEmpty();
