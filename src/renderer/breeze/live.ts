/* ================= The file an agent is editing, live ================= */
// A panel that shows one file at a time: the last one an agent touched. A new file types in as the agent drafts it;
// an edited one is read back after each write, with the lines that changed marked and scrolled into view.
// What was last shown (or, the first time, the committed version) is what "changed" is measured against.
// Breeze Space has one at its right (#boxLive); an Agent board box alone on the board has one at its left (board.ts).
const LIVE_MAX_LINES = 5000; // past this only the start is drawn; a huge file would take too long to lay out

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

class LivePane {
  path: string | null = null;
  private seen = new Map<string, string>();
  private reads = 0; // a later read wins over an earlier one still in flight
  private hand: CrewHand | null = null; // the drafting agent's cursor, moved to the end of each redraw
  // `onOpen`: what the head's "Open in Breeze Code" button does with the file; `onShow`: the panel got (or lost) a file.
  constructor(readonly root: HTMLElement, readonly head: HTMLElement, readonly body: HTMLElement,
    private onOpen: ((path: string) => void) | null, private onShow?: (has: boolean) => void) {
    head.addEventListener('click', e => {
      if (!(e.target as HTMLElement).closest('.live-open') || !this.path || !this.onOpen) return;
      this.onOpen(this.path);
    });
  }

  // Nothing written: the panel closes, and the conversation takes its room. A write opens it again.
  empty(): void {
    this.path = null;
    this.reads++; // a read still in flight must not reopen it
    this.root.classList.remove('writing');
    this.root.classList.add('closed');
    this.head.innerHTML = '';
    this.body.innerHTML = '';
    this.onShow?.(false);
  }

  private showHead(path: string, status: string): void {
    const p = path.replaceAll('\\', '/');
    const dir = dirName(p);
    this.root.classList.remove('closed');
    this.head.innerHTML = `<span class="ico">${fileIcon(baseName(p))}</span>
      <span class="box-live-name" title="${escAttr(p)}"><b>${esc(baseName(p))}</b>${dir ? `<small>${esc(dir)}</small>` : ''}</span>
      <span class="box-live-status">${esc(status)}</span>
      ${rootInfo && this.onOpen ? `<button class="icon-btn live-open" type="button" title="Open in Breeze Code">${svgIcon('external', 14)}</button>` : ''}`;
    this.onShow?.(true);
  }

  private note(path: string, text: string): void {
    this.showHead(path, 'Edited');
    this.body.innerHTML = `<div class="box-live-empty"><div>${esc(text)}</div></div>`;
    this.path = path;
  }

  private render(path: string, text: string, prev: string | undefined, writing: boolean, phase = 'assistant'): void {
    const switched = this.path !== path;
    this.path = path;
    this.root.classList.toggle('writing', writing);
    this.showHead(path, writing ? 'Writing' : 'Edited');
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
    const body = this.body;
    body.innerHTML = `<div class="box-live-code">${rows}</div>`;
    // A draft is written top to bottom, so the agent's caret and cursor sit after its last character.
    const end = writing && d.lines.length <= count ? body.querySelector<HTMLElement>('.ln:last-child .tx') : null;
    if (end) {
      if (end.textContent === ' ') end.textContent = ''; // the space only keeps an empty line's height
      const at = document.createElement('span');
      at.className = 'box-live-at';
      at.innerHTML = '<span class="type-caret"></span>';
      this.hand ??= crewHand();
      dressCrewHand(this.hand, phase);
      this.hand.el.style.transform = 'translate(3px, 13px)';
      at.append(this.hand.el);
      end.append(at);
    }
    // Follow the agent: the end of a file being drafted, otherwise the first changed line. A hidden panel has no
    // layout to scroll in, so it only resets.
    if (!body.clientHeight) { if (switched) body.scrollTop = 0; return; }
    const target = writing ? body.querySelector<HTMLElement>('.ln:last-child') : body.querySelector<HTMLElement>('.ln.changed');
    if (target) target.scrollIntoView({ block: writing ? 'end' : 'center', behavior: switched ? 'auto' : 'smooth' });
    else if (switched) body.scrollTop = 0;
  }

  // The agent's text for a file it is creating, as it writes it.
  draft(path: string, text: string, phase?: string): void {
    if (baseName(path).startsWith('.env')) return;
    this.render(path, text, undefined, true, phase);
    this.seen.set(path, text);
  }

  // The agent wrote `path`: read it back and show it. Some agents report a file just before writing it, so it is
  // read again shortly after, and redrawn only if it changed.
  file(path: string): void {
    if (baseName(path).startsWith('.env')) { this.note(path, '.env files stay private, so this one isn\'t shown.'); return; }
    const read = ++this.reads;
    const show = async () => {
      const r = await api.fs.readFile(path).catch(() => null);
      if (read !== this.reads) return;
      if (r?.text == null || kindOf(r) !== 'text') { this.note(path, 'This file can\'t be shown here (binary, too large or removed).'); return; }
      let prev = this.seen.get(path);
      if (prev === r.text && this.path === path && !this.root.classList.contains('writing')) return;
      if (prev === undefined) prev = await api.git.headText(path).catch(() => null) ?? undefined;
      if (read !== this.reads) return;
      this.render(path, r.text, prev, false);
      this.seen.set(path, r.text);
    };
    for (const ms of [0, 400, 1500]) setTimeout(() => background(show()), ms);
  }

  // Shown again (the panel was hidden): bring the changed lines, or the end of a draft, into view.
  reveal(): void {
    const writing = this.root.classList.contains('writing');
    const target = writing ? this.body.querySelector<HTMLElement>('.ln:last-child') : this.body.querySelector<HTMLElement>('.ln.changed');
    target?.scrollIntoView({ block: writing ? 'end' : 'center' });
  }
}

/* ----- Breeze Space: the panel at the right ----- */
const spaceLive = new LivePane($('#boxLive'), $('#boxLiveHead'), $('#boxLiveBody'), path => { enterMode('ide'); openFile(path); });
function liveEmpty(): void { spaceLive.empty(); }
function liveDraft(path: string, text: string, phase?: string): void { spaceLive.draft(path, text, phase); }
function liveFile(path: string): void { spaceLive.file(path); }
liveEmpty();
