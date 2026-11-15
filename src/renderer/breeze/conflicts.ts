/* ================= Conflict compare page ================= */
// Resolving a pull request's conflicts without leaving Breeze. Main merges the base branch into the pull request in a
// separate worktree (main/prconflict.js), so the open folder is never touched; this page lists the conflicted files and,
// for the one picked, shows our side (the pull request) and their side (the base branch) above the result, which is the
// file's text with its conflict markers and can be edited by hand. Committing sends the result back and pushes it.
// Text and logic live in conflictcore.ts (parseConflicts, applyChoice, hasMarkers, lineDiff, conflictLines).
//
// Colours: lines only our side has are red, lines only their side has are green, in the two side panes and in the
// result's conflict blocks alike. All three are syntax coloured with the editor's lexers and scroll both ways.

type CfFile = {
  path: string; ours: string | null; theirs: string | null;
  binary: boolean;                    // not UTF-8 text: never shown or edited, only kept from one side or deleted
  hasOurs: boolean; hasTheirs: boolean;
  text: string;                       // the result, for a text file both sides have
  pick: 'keep' | 'delete' | null;     // for a text file one side deleted; null until chosen
  bin: 'ours' | 'theirs' | 'delete' | null; // for a binary file; null until chosen
  cur: number;                        // the conflict being looked at
  crlf: boolean;                      // the file has CRLF line breaks, which the textarea hides
};
const CF_ENDED = 'This conflict session has ended';
// Bumped when the folder changes: a conflict page from before is over, whatever it was doing.
let cfWorkspaceGen = 0;
let cfOpenPage: { end(): void } | null = null;
function endConflictPage(): void {
  cfWorkspaceGen++;
  const page = cfOpenPage;
  cfOpenPage = null;
  page?.end();
}

// The Duel on one conflict: the agent argues for ours, then for theirs, then judges. One card each.
type DuelCard = { state: 'wait' | 'run' | 'done' | 'fail'; text: string };
// The judge's merge. It only goes into the result when the user accepts it; until then the conflict stays as it is.
// `was` is the block as it stood when the Duel started, in the file's own text, to find it again on Accept.
type DuelMerge = { code: string; was: ConflictBlock; state: 'pending' | 'accepted' | 'rejected' };
type Duel = { file: CfFile; agent: string; ours: DuelCard; theirs: DuelCard; judge: DuelCard; note: string; running: boolean; merge: DuelMerge | null };
const NO_ARGUMENT = '(no argument)';

// A text file one side deleted has no markers to resolve: keep it or delete it.
const cfOneSided = (f: CfFile): boolean => !f.binary && (f.ours === null || f.theirs === null);
const cfSurvivor = (f: CfFile): string => f.ours ?? f.theirs ?? '';
const cfResolved = (f: CfFile): boolean => (f.binary ? f.bin !== null : cfOneSided(f) ? f.pick !== null : !hasMarkers(f.text));
const cfResult = (f: CfFile): ConflictResult => (f.binary
  ? { path: f.path, choice: f.bin ?? 'ours' } // only sent once every file is resolved, so bin is set by then
  : { path: f.path, text: cfOneSided(f) ? (f.pick === 'keep' ? cfSurvivor(f) : null) : f.text });
// What is still to resolve in a file: its conflict blocks, or 1 for a file to keep or delete that isn't decided yet.
const cfLeft = (f: CfFile): number => (f.binary ? (f.bin === null ? 1 : 0) : cfOneSided(f) ? (f.pick === null ? 1 : 0) : parseConflicts(f.text).length);

/* ----- Drawing code: syntax colours, line numbers, red and green lines ----- */
const CF_LH = 18;  // line height of every code area here, in px (matches the CSS)
const CF_PAD = 8;  // the result's top padding, in px (matches the CSS)
const CF_CTX = 3;  // lines of the file shown above and below a side
const cfLf = (s: string): string => s.replace(/\r\n/g, '\n');
// A side's text as lines, without the line break the last one ends with.
const cfLines = (s: string): string[] => (s === '' ? [] : cfLf(s).replace(/\n$/, '').split('\n'));
function cfDoc(text: string, path: string, prev?: HlDoc | null): HlDoc {
  const lexer = langOf(path)[0];
  const toks = prev && prev.lexer === lexer && INCREMENTAL.has(lexer) && LEXERS[lexer] && text.length <= HL_MAX && prev.text.length <= HL_MAX
    ? relex(prev, text) : fullToks(text, lexer);
  return { text, lexer, ...toks, lines: lineStartsOf(text).slice(), html: [] };
}
// One line of a highlighted document as HTML, with `mark` ([from, to) in the line) wrapped as the changed part.
function cfLineHtml(d: HlDoc, i: number, mark?: [number, number] | null): string {
  const from = d.lines[i], to = i + 1 < d.lines.length ? d.lines[i + 1] - 1 : d.text.length;
  const m0 = mark ? from + mark[0] : -1, m1 = mark ? from + mark[1] : -1;
  let h = '';
  for (let k = lineOfOffset(d.starts, from); k < d.starts.length && d.starts[k] < to; k++) {
    const s = Math.max(d.starts[k], from), e = Math.min(d.starts[k + 1] ?? to, to);
    const cuts = [m0, m1].filter(c => c > s && c < e);
    let p = s;
    for (const q of [...cuts, e]) {
      const part = d.text.slice(p, q);
      if (part) {
        const x = d.kinds[k] ? `<span class="tk-${d.kinds[k]}">${esc(part)}</span>` : esc(part);
        h += mark && p >= m0 && q <= m1 ? `<mark class="cf-w">${x}</mark>` : x;
      }
      p = q;
    }
  }
  return h;
}
type CfRow = { no: number | null; cls: string; sign?: string; html: string };
const cfRows = (rows: CfRow[]): string => `<div class="cf-rows">${rows.map(r =>
  `<div class="cf-l ${r.cls}"><span class="cf-n">${r.no ?? ''}</span><span class="cf-sg">${r.sign ?? ''}</span><span class="cf-x">${r.html}</span></div>`).join('')}</div>`;
// A whole file (a one-sided file's survivor), highlighted with line numbers.
function cfFileRows(text: string, path: string): string {
  const d = cfDoc(cfLf(text).replace(/\n$/, ''), path);
  return cfRows(d.lines.map((_, i) => ({ no: i + 1, cls: '', html: cfLineHtml(d, i) })));
}

async function openConflictPage(pr: GhPull): Promise<void> {
  const n = pr.number;
  const wsGen = cfWorkspaceGen; // a folder switch ends this page
  const mine = (): boolean => wsGen === cfWorkspaceGen && !!document.querySelector(`#scmDetail .cf-view[data-n="${n}"]`);
  const shell = (inner: string): string => `<div class="pr-view cf-view" data-n="${n}">${inner}</div>`;
  const back = (): void => { void openPr(n); };
  const fail = (text: string): void => {
    showScmDetail(shell(`<div class="pr-loading pr-fail"><p>${esc(text)}</p><button class="btn btn-sm" data-cf="back">Back to pull request</button></div>`));
    ($('#scmDetail .cf-view') as HTMLElement).onclick = e => { if ((e.target as HTMLElement).closest('[data-cf="back"]')) back(); };
  };
  if (pr.head.repo === null) { fail('The source repository no longer exists'); return; }
  showScmDetail(shell(`<div class="pr-loading"><div class="spinner sm"></div>Preparing the merge of ${esc(pr.base)} into #${n}</div>`));
  let session: ConflictSession;
  try {
    session = await api.git.prConflictStart(n); // main asks GitHub for the branches and where to push
  } catch (e) {
    if (mine()) fail(errMsg(e) || 'Couldn\'t prepare the merge');
    return;
  }
  if (!mine()) { api.git.prConflictAbort(session.id).catch(() => {}); return; } // the right side moved on while it was preparing

  const files: CfFile[] = session.files.map(f => {
    const text = f.merged ?? '';
    return { path: f.path, ours: f.ours, theirs: f.theirs, binary: f.kind === 'binary', hasOurs: f.hasOurs, hasTheirs: f.hasTheirs, text, pick: null, bin: null, cur: 0, crlf: text.includes('\r\n') };
  });
  // Start on the first file with something to do.
  let sel = Math.max(0, files.findIndex(f => !cfResolved(f)));
  let busy = false;       // committing or cancelling
  let pushFailed = false; // the resolution is committed in the worktree, only the push is left
  let ended = false;      // main no longer knows this session
  let duel: Duel | null = null; // the latest Duel, running or finished
  // Lines just put into the result by a choice, lit up for a moment so the eye finds them (0-based, in the textarea's text).
  let flash: { file: CfFile; from: number; to: number } | null = null;
  let flashTimer = 0;
  const view = $('#scmDetail .cf-view');
  // Late results are dropped once the page is left (a new page for the same pull request is a different view) or the session is over.
  const alive = (): boolean => mine() && view.isConnected && !ended;
  const ours = session.headRef, theirs = session.base;
  // The folder changed: nothing more is done with this session from here (a commit already in flight finishes on its own).
  cfOpenPage = { end: (): void => {
    if (ended) return;
    ended = true;
    if (!busy) api.git.prConflictAbort(session.id).catch(() => {});
  } };

  const note = (text: string): void => { $('#cfNote', view).textContent = text; };
  const file = (): CfFile => files[sel];
  const unresolved = (): number => files.filter(f => !cfResolved(f)).length;
  const textArea = (): HTMLTextAreaElement | null => view.querySelector<HTMLTextAreaElement>('#cfText');

  const head = (): string => `<div class="pr-head cf-head">
      <div class="pr-title"><h3>Resolve conflicts</h3><span class="pr-n">#${n}</span></div>
      <div class="pr-meta"><span>Merging <b class="cf-br t">${esc(theirs)}</b> into <b class="cf-br o">${esc(ours)}</b></span></div>
      <div class="pr-actions"><button class="btn btn-sm" data-cf="cancel">Cancel</button>${session.clean ? '' : '<button class="btn btn-primary btn-sm" data-cf="commit" disabled>Commit resolution</button>'}</div>
      ${session.clean ? '' : '<div class="cf-prog"><div class="cf-prog-bar"><i id="cfProgBar"></i></div><span id="cfProg"></span></div>'}
      <div class="pr-merge-note cf-note" id="cfNote" role="alert"></div>
    </div>`;

  const paintHeader = (): void => {
    const commit = view.querySelector<HTMLButtonElement>('[data-cf="commit"]');
    const left = unresolved();
    if (commit) {
      commit.textContent = busy ? (pushFailed ? 'Pushing…' : 'Committing…') : pushFailed ? 'Retry push' : 'Commit resolution';
      commit.disabled = busy || ended || left > 0;
      commit.title = left > 0 ? `${plural(left, 'file')} still to resolve` : 'Commit the resolution and push it (Ctrl+Enter)';
      commit.classList.toggle('cf-ready', left === 0 && !busy && !ended);
    }
    view.querySelector<HTMLButtonElement>('[data-cf="cancel"]')!.disabled = busy;
    const prog = view.querySelector<HTMLElement>('#cfProg');
    if (prog) {
      const done = files.length - left;
      prog.textContent = left === 0 ? 'Every file is resolved, ready to commit' : `${done} of ${plural(files.length, 'file')} resolved`;
      $<HTMLElement>('#cfProgBar', view).style.width = `${files.length ? (done / files.length) * 100 : 100}%`;
      prog.parentElement!.classList.toggle('all', left === 0);
    }
  };

  const paintFiles = (): void => {
    $('#cfFiles', view).innerHTML = files.map((f, i) => {
      const done = cfResolved(f), left = cfLeft(f);
      return `<button class="cf-file ${i === sel ? 'on' : ''} ${done ? 'done' : ''}" data-i="${i}" role="tab" aria-selected="${i === sel}" title="${escAttr(f.path)}${done ? ' (resolved)' : ` (${plural(left, 'conflict')} left)`}"><span class="cf-ck" aria-hidden="true">${done ? svgIcon('check', 12) : ''}</span><span class="ico">${fileIcon(f.path)}</span><span class="cf-fname">${esc(f.path)}</span><span class="cf-left"${done ? ' aria-label="Resolved"' : ''}>${done ? '' : left}</span></button>`;
    }).join('');
  };

  /* ----- The two sides of the conflict being looked at ----- */
  // A side with a few lines of the file around it, numbered as they would be in that side's own file; the lines the other
  // side doesn't have are red (ours) or green (theirs), with the changed part of an edited line marked brighter.
  const sideHtml = (f: CfFile, lf: string, b: ConflictBlock, side: 'ours' | 'theirs', diff: LineDiff, o: string[], t: string[]): string => {
    const ctx = blockContext(lf, b, CF_CTX);
    const before = cfLines(ctx.before), after = cfLines(ctx.after);
    const open = lf.slice(0, b.start).split('\n').length - 1; // 0-based line of the <<<<<<< marker
    const lines = side === 'ours' ? o : t;
    const d = cfDoc([...before, ...lines, ...after].join('\n'), f.path);
    const changed = side === 'ours' ? diff.a : diff.b;
    const marks = new Map<number, [number, number]>();
    for (const [ia, ib] of diff.pairs) {
      const span = changedSpan(o[ia], t[ib]);
      if (span) marks.set(side === 'ours' ? ia : ib, side === 'ours' ? span.a : span.b);
    }
    const rows: CfRow[] = [];
    before.forEach((_, k) => rows.push({ no: open - before.length + 1 + k, cls: 'ctx', html: cfLineHtml(d, k) }));
    if (!lines.length) rows.push({ no: null, cls: 'none', html: `${esc(side === 'ours' ? ours : theirs)} has no lines here` });
    lines.forEach((_, k) => rows.push({
      no: open + 1 + k,
      cls: changed[k] ? (side === 'ours' ? 'del' : 'add') : 'same',
      sign: changed[k] ? (side === 'ours' ? '−' : '+') : '',
      html: cfLineHtml(d, before.length + k, changed[k] ? marks.get(k) : null),
    }));
    after.forEach((_, k) => rows.push({ no: open + 1 + lines.length + k, cls: 'ctx', html: cfLineHtml(d, before.length + lines.length + k) }));
    return cfRows(rows);
  };

  // The conflict being looked at: its two sides, the counter, and which buttons work.
  const paintBlock = (): void => {
    const f = file();
    if (f.binary || cfOneSided(f)) return;
    const lf = cfLf(f.text);
    const blocks = parseConflicts(lf);
    f.cur = blocks.length ? clamp(f.cur, 0, blocks.length - 1) : 0;
    const b = blocks[f.cur];
    const oursEl = $('#cfOurs', view), theirsEl = $('#cfTheirs', view);
    const key = b ? `${f.path}\0${b.start}\0${b.ours}\0${b.theirs}` : '';
    if (oursEl.dataset.key !== key) { // only redrawn when the conflict shown changes, so typing elsewhere stays cheap
      oursEl.dataset.key = key;
      if (b) {
        const o = cfLines(b.ours), t = cfLines(b.theirs), diff = lineDiff(o, t);
        oursEl.innerHTML = sideHtml(f, lf, b, 'ours', diff, o, t);
        theirsEl.innerHTML = sideHtml(f, lf, b, 'theirs', diff, o, t);
      } else {
        const msg = hasMarkers(f.text) ? '<div class="cf-gone">A conflict marker is left in the result. Remove it to finish this file.</div>'
          : `<div class="cf-gone cf-done">${svgIcon('check', 16)}<span>Every conflict in this file is resolved</span></div>`;
        oursEl.innerHTML = msg; theirsEl.innerHTML = msg;
      }
      oursEl.scrollTop = theirsEl.scrollTop = 0;
    }
    const count = $('#cfCount', view);
    count.textContent = b ? `Conflict ${f.cur + 1} of ${blocks.length}` : hasMarkers(f.text) ? 'Markers left' : 'Resolved';
    count.classList.toggle('ok', !b && !hasMarkers(f.text));
    const off = !b || pushFailed || busy;
    view.querySelectorAll<HTMLButtonElement>('[data-cf-use]').forEach(btn => { btn.disabled = off; });
    view.querySelectorAll<HTMLButtonElement>('[data-cf-step]').forEach(btn => { btn.disabled = blocks.length < 2; });
    const duelBtn = view.querySelector<HTMLButtonElement>('[data-cf-use="duel"]');
    if (duelBtn) { // one Duel at a time
      const running = !!duel?.running;
      duelBtn.disabled = off || running;
      duelBtn.title = running ? 'A duel is running' : 'Have your AI agent argue both sides and propose a merge you can accept or reject';
    }
    // Done with this file and others are waiting: offer the next one.
    const nextBtn = view.querySelector<HTMLButtonElement>('[data-cf="next-file"]');
    if (nextBtn) nextBtn.hidden = !cfResolved(f) || !files.some(x => x !== f && !cfResolved(x));
    paintResult(true);
  };

  /* ----- The result: a textarea over a highlighted copy of its text ----- */
  // The textarea's own text is transparent; behind it the lines in view are drawn with syntax colours, conflict blocks
  // tinted (our side red, their side green, the one being looked at outlined) and line numbers alongside.
  let resDoc: HlDoc | null = null;
  let resKinds = new Map<number, { kind: ConflictLineKind; block: number }>();
  let resDrawn = '';
  const paintResult = (force = false): void => {
    const ta = textArea(), hl = view.querySelector<HTMLElement>('#cfHl'), gut = view.querySelector<HTMLElement>('#cfGut');
    if (!ta || !hl || !gut) return;
    const f = file();
    const text = ta.value;
    if (resDoc?.text !== text || resDoc.lexer !== langOf(f.path)[0]) {
      resDoc = cfDoc(text, f.path, resDoc);
      resKinds = conflictLines(text);
      force = true;
    }
    const d = resDoc, total = d.lines.length;
    const st = ta.scrollTop, sl = ta.scrollLeft;
    const first = clamp(Math.floor((st - CF_PAD) / CF_LH) - 8, 0, total - 1);
    const last = clamp(Math.ceil((st + ta.clientHeight) / CF_LH) + 8, 0, total - 1);
    const fl = flash?.file === f ? flash : null;
    const drawn = `${first}:${last}:${f.cur}:${fl ? `${fl.from}-${fl.to}` : ''}`;
    if (force || drawn !== resDrawn) {
      resDrawn = drawn;
      let lines = '', nums = '';
      for (let i = first; i <= last; i++) {
        const k = resKinds.get(i);
        let cls = k ? `k-${k.kind}${k.block === f.cur ? ' cur' : ''}` : '';
        if (fl && i >= fl.from && i <= fl.to) cls += ' flash';
        lines += `<div class="cf-rl ${cls}">${cfLineHtml(d, i)}</div>`;
        nums += `<div class="${cls}">${i + 1}</div>`;
      }
      hl.innerHTML = lines;
      gut.innerHTML = nums;
      gut.parentElement!.style.width = `${String(total).length + 2}ch`;
    }
    const y = CF_PAD + first * CF_LH - st;
    hl.style.transform = `translate(${-sl}px, ${y}px)`;
    hl.style.minWidth = `${ta.clientWidth + sl}px`;
    gut.style.transform = `translateY(${y}px)`;
  };

  const scrollResultTo = (lfPos: number): void => {
    const ta = textArea();
    if (!ta) return;
    const line = ta.value.slice(0, lfPos).split('\n').length - 1;
    const top = Math.max(0, (line - 3) * CF_LH);
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches && Math.abs(ta.scrollTop - top) < ta.clientHeight * 4;
    ta.scrollTo({ top, left: 0, behavior: smooth ? 'smooth' : 'auto' });
  };
  // Brings the result to the conflict being looked at.
  const scrollToBlock = (): void => {
    const f = file(), ta = textArea();
    if (!ta) return;
    const b = parseConflicts(ta.value)[f.cur];
    if (b) scrollResultTo(b.start);
  };

  const mainHtml = (): string => {
    const f = file();
    const copy = pushFailed && !f.binary && !(cfOneSided(f) && f.pick !== 'keep') ? '<button class="btn btn-sm" data-cf="copy">Copy resolved file</button>' : '';
    const pane = (cls: string, title: string, sub: string, body: string, extra = ''): string =>
      `<section class="cf-pane ${cls}"><header>${cls.includes('cf-o') ? '<i class="cf-dot o"></i>' : cls.includes('cf-t') ? '<i class="cf-dot t"></i>' : ''}<b>${title}</b><small>${esc(sub)}</small>${extra}</header>${body}</section>`;
    if (f.binary) {
      const off = pushFailed || busy;
      const btn = (choice: 'ours' | 'theirs' | 'delete', label: string, has: boolean): string =>
        `<button class="btn btn-sm" data-cf-bin="${choice}" aria-pressed="${f.bin === choice}"${off || !has ? ' disabled' : ''}${has ? '' : ' title="This side deleted the file"'}>${label}</button>`;
      const state = f.bin === 'ours' ? `Keeping the version from ${ours}` : f.bin === 'theirs' ? `Keeping the version from ${theirs}` : f.bin === 'delete' ? 'The file will be deleted' : 'Keep one side or delete the file';
      const side = (has: boolean): string => `<div class="cf-gone">${has ? 'Not a text file, so it isn\'t shown' : 'Deleted in this branch'}</div>`;
      return `<div class="cf-bar"><span class="cf-path">${esc(f.path)}</span><span class="cf-count">${esc(state)}</span>
        <span class="cf-acts">${btn('ours', 'Keep ours', f.hasOurs)}${btn('theirs', 'Keep theirs', f.hasTheirs)}${btn('delete', 'Delete file', true)}</span></div>
        <div class="cf-panes">${pane('cf-o', 'Ours', ours, side(f.hasOurs))}${pane('cf-t', 'Theirs', theirs, side(f.hasTheirs))}${pane('cf-res', 'Result', '', '<div class="cf-gone">This file can\'t be merged here</div>')}</div>`;
    }
    if (cfOneSided(f)) {
      const side = (text: string | null): string => (text === null ? '<div class="cf-gone">Deleted in this branch</div>' : `<div class="cf-code cf-scroll">${cfFileRows(text, f.path)}</div>`);
      const state = f.pick === 'keep' ? 'The file is kept' : f.pick === 'delete' ? 'The file will be deleted' : 'Keep this file or delete it';
      const resBody = f.pick === 'keep' ? `<div class="cf-code cf-scroll">${cfFileRows(cfSurvivor(f), f.path)}</div>` : `<div class="cf-gone">${state}</div>`;
      return `<div class="cf-bar"><span class="cf-path">${esc(f.path)}</span><span class="cf-count">${esc(state)}</span>
        <span class="cf-acts"><button class="btn btn-sm" data-cf-pick="keep" aria-pressed="${f.pick === 'keep'}"${pushFailed || busy ? ' disabled' : ''}>Keep file</button><button class="btn btn-sm" data-cf-pick="delete" aria-pressed="${f.pick === 'delete'}"${pushFailed || busy ? ' disabled' : ''}>Delete file</button>${copy}</span></div>
        <div class="cf-panes">${pane('cf-o', 'Ours', ours, side(f.ours))}${pane('cf-t', 'Theirs', theirs, side(f.theirs))}${pane('cf-res', 'Result', '', resBody)}</div>`;
    }
    const useBtn = (side: 'ours' | 'theirs', key: string): string =>
      `<button class="btn btn-sm cf-use" data-cf-use="${side}" title="Keep ${side === 'ours' ? ours : theirs}'s lines for this conflict (Alt+${key})">Use ${side}</button>`;
    return `<div class="cf-bar"><span class="cf-path">${esc(f.path)}</span>
        <span class="cf-nav"><button class="icon-btn" data-cf-step="-1" title="Previous conflict (Alt+↑)" aria-label="Previous conflict">${svgIcon('chevronLeft', 14)}</button><span class="cf-count" id="cfCount" aria-live="polite"></span><button class="icon-btn" data-cf-step="1" title="Next conflict (Alt+↓)" aria-label="Next conflict">${svgIcon('chevronRight', 14)}</button></span>
        <span class="cf-acts"><button class="btn btn-sm" data-cf-use="both" title="Keep both: ours, then theirs (Alt+3)">Use both</button><button class="btn btn-sm cf-duel-btn" data-cf-use="duel">${svgIcon('sparkles', 13)}Duel</button><button class="icon-btn" data-cf="undo" title="Undo (Ctrl+Z)" aria-label="Undo"${pushFailed ? ' disabled' : ''}>${svgIcon('undo', 14)}</button><button class="btn btn-sm btn-primary" data-cf="next-file" hidden>Next file${svgIcon('arrowRight', 13)}</button>${copy}</span></div>
      <div class="cf-duel" id="cfDuel" aria-live="polite"></div>
      <div class="cf-panes">${pane('cf-o', 'Ours', ours, '<div class="cf-code cf-scroll" id="cfOurs"></div>', useBtn('ours', '1'))}${pane('cf-t', 'Theirs', theirs, '<div class="cf-code cf-scroll" id="cfTheirs"></div>', useBtn('theirs', '2'))}${pane('cf-res', 'Result', 'edit freely', `<div class="cf-ed"><div class="cf-gut" aria-hidden="true"><div id="cfGut"></div></div><div class="cf-ed-main"><div class="cf-hl" aria-hidden="true"><div class="cf-hl-in" id="cfHl"></div></div><textarea class="cf-text cf-scroll" id="cfText" spellcheck="false" wrap="off" aria-label="Result for ${escAttr(f.path)}"${pushFailed ? ' readonly' : ''}></textarea></div></div>`, '<span class="cf-legend"><i class="cf-dot o"></i>ours<i class="cf-dot t"></i>theirs</span>')}</div>`;
  };

  const paintMain = (): void => {
    $('#cfMain', view).innerHTML = mainHtml();
    resDoc = null; resDrawn = '';
    const f = file();
    if (!f.binary && !cfOneSided(f)) {
      const ta = $<HTMLTextAreaElement>('#cfText', view);
      ta.value = cfLf(f.text);
      ta.addEventListener('scroll', () => paintResult());
      new ResizeObserver(() => { if (ta.isConnected) paintResult(); }).observe(ta);
      // Ours and theirs scroll sideways together, so the same columns line up.
      const o = $('#cfOurs', view), t = $('#cfTheirs', view);
      let syncing = false;
      const sync = (from: HTMLElement, to: HTMLElement) => (): void => { if (syncing) { syncing = false; return; } if (to.scrollLeft !== from.scrollLeft) { syncing = true; to.scrollLeft = from.scrollLeft; } };
      o.addEventListener('scroll', sync(o, t)); t.addEventListener('scroll', sync(t, o));
      paintBlock(); paintDuel(); scrollToBlock();
    }
  };
  const paintAll = (): void => {
    paintHeader();
    if (session.clean) {
      const push = view.querySelector<HTMLButtonElement>('[data-cf="push"]');
      if (push) { push.textContent = busy ? 'Pushing…' : pushFailed ? 'Retry push' : 'Push merge'; push.disabled = busy || ended; }
      return;
    }
    paintFiles(); paintMain();
  };
  // After something changed in the file being edited: not the textarea itself, which would lose the caret.
  const paintState = (): void => { paintHeader(); paintFiles(); paintBlock(); };

  const finish = async (): Promise<void> => {
    if (busy || ended) return;
    busy = true; note(''); paintAll();
    let res: ConflictFinish;
    try {
      res = await api.git.prConflictFinish(session.id, files.map(cfResult));
    } catch (e) {
      // The session is gone, or main refused the resolution: nothing was committed.
      busy = false;
      const msg = errMsg(e);
      if (msg.includes(CF_ENDED)) ended = true;
      if (mine()) { note(msg || 'Couldn\'t commit the resolution'); paintAll(); }
      return;
    }
    busy = false;
    if (!res.ok) {
      // Only a failed push leaves the resolution committed; after a failed commit the page stays as it was, to change and try again.
      if (res.stage === 'push') pushFailed = true;
      if (mine()) {
        note(res.stage === 'push'
          ? `${res.message || 'Couldn\'t push'}. ${session.clean ? 'The merge is committed locally; retry the push' : 'Your resolution is committed locally; retry the push or copy the files'}`
          : `Couldn't commit the resolution: ${res.message || 'git failed'}`);
        paintAll();
      }
      return;
    }
    ended = true; // main has removed the session
    toast('Conflicts resolved and pushed');
    void refreshPrs(true);
    if (mine()) back();
  };

  const cancel = async (): Promise<void> => {
    if (busy) return;
    busy = true; paintHeader();
    await api.git.prConflictAbort(session.id).catch(() => {}); // already gone is as good as aborted
    if (mine()) back();
  };

  /* ----- Changing the result ----- */
  // Replaces a block in the result through the textarea's own editing, so Ctrl+Z (and the Undo button) take it back like
  // typing. Returns where the new lines landed in the textarea's text, or null if the block isn't there.
  const replaceBlock = (f: CfFile, b: ConflictBlock, choice: ConflictChoice): { from: number; to: number } | null => {
    const ta = textArea();
    if (!ta || f !== file()) return null;
    const next = withEol(cfLf(applyChoice(f.text, b, choice)), f.crlf);
    const lfText = cfLf(f.text);
    const lfBlock = parseConflicts(lfText).find(x => cfLf(x.ours) === cfLf(b.ours) && cfLf(x.theirs) === cfLf(b.theirs) && cfLf(f.text.slice(0, b.start)).length === x.start);
    if (!lfBlock) return null;
    const lfNext = cfLf(next);
    const inserted = lfNext.slice(lfBlock.start, lfNext.length - (lfText.length - lfBlock.end));
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(lfBlock.start, lfBlock.end);
    const ok = inserted ? document.execCommand('insertText', false, inserted) : document.execCommand('delete');
    if (!ok || f.text !== next) { // no editing command here: set the text directly (Undo can't take this one back)
      ta.value = lfNext;
      f.text = next;
      ta.setSelectionRange(lfBlock.start + inserted.length, lfBlock.start + inserted.length);
      paintState();
    }
    return { from: lfBlock.start, to: lfBlock.start + inserted.length };
  };
  const lineAt = (lf: string, pos: number): number => lf.slice(0, pos).split('\n').length - 1;
  const lightUp = (f: CfFile, r: { from: number; to: number }): void => {
    const lf = cfLf(f.text);
    if (r.to <= r.from) { flash = null; return; }
    flash = { file: f, from: lineAt(lf, r.from), to: lineAt(lf, r.to - 1) };
    clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => { flash = null; if (alive()) paintResult(true); }, 1600);
    paintResult(true);
  };

  const use = (choice: 'ours' | 'theirs' | 'both'): void => {
    const f = file();
    if (busy || pushFailed) return;
    const b = parseConflicts(f.text)[f.cur];
    if (!b) return;
    const r = replaceBlock(f, b, choice);
    if (!r) return;
    lightUp(f, r);
    // The next conflict is now at the same index (or the one before, if this was the last).
    paintBlock();
    scrollToBlock();
  };

  const undo = (): void => {
    const ta = textArea();
    if (!ta || ta.readOnly) return;
    ta.focus({ preventScroll: true });
    document.execCommand('undo');
  };

  /* ----- Duel ----- */
  const cardHtml = (cls: string, title: string, c: DuelCard, extra = ''): string => {
    const body = c.state === 'wait' ? '<div class="cf-card-dim">Waiting its turn</div>'
      : c.state === 'run' ? '<div class="cf-card-dim cf-thinking">Thinking<span>.</span><span>.</span><span>.</span></div>'
      : c.state === 'fail' ? `<div class="cf-card-text cf-card-err">${esc(c.text)}</div>` // agent output is text, never markup
      : `<div class="cf-card-text">${esc(c.text)}</div>`;
    const dot = cls === 'o' ? '<i class="cf-dot o"></i>' : cls === 't' ? '<i class="cf-dot t"></i>' : svgIcon('sparkles', 13);
    return `<section class="cf-card ${c.state} ${cls}"><header>${dot}<b>${title}</b>${c.state === 'run' ? '<span class="spinner sm" role="status" aria-label="Working"></span>' : ''}</header>${body}${extra}</section>`;
  };
  // Finds the block the Duel was about in the file as it is now; null once it was resolved or edited.
  const duelBlock = (d: Duel): ConflictBlock | null => {
    const was = d.merge?.was;
    if (!was) return null;
    const same = parseConflicts(d.file.text).filter(x => x.ours === was.ours && x.theirs === was.theirs);
    return same.find(x => x.start === was.start) ?? same[0] ?? null;
  };
  const mergeHtml = (d: Duel): string => {
    const m = d.merge;
    if (!m) return '';
    const code = m.code === '' ? '<div class="cf-rows"><div class="cf-l none"><span class="cf-n"></span><span class="cf-sg"></span><span class="cf-x">Removes the conflicting lines</span></div></div>'
      : (() => { const doc = cfDoc(m.code, d.file.path); return cfRows(doc.lines.map((_, i) => ({ no: null, cls: 'add', sign: '+', html: cfLineHtml(doc, i) }))); })();
    const preview = `<div class="cf-merge-code cf-scroll">${code}</div>`;
    if (m.state === 'accepted') return `<div class="cf-merge done"><div class="cf-merge-head">${svgIcon('check', 13)}<span>Accepted. The merge is in the result; Undo takes it back.</span></div></div>`;
    if (m.state === 'rejected') return '<div class="cf-merge rejected"><div class="cf-merge-head"><span>Rejected. The conflict is as it was.</span></div></div>';
    const stale = !duelBlock(d);
    const off = busy || pushFailed || stale;
    const why = stale ? 'This conflict changed after the duel started, so the merge can\'t be applied' : busy || pushFailed ? 'The resolution is being committed' : '';
    return `<div class="cf-merge pending">
        <div class="cf-merge-head"><span class="cf-prop-tag">Proposed merge</span><span>${why ? esc(why) : 'Nothing changes until you accept it'}</span></div>
        ${preview}
        <div class="cf-merge-acts"><button class="btn btn-sm btn-primary" data-cf-prop="accept"${off ? ' disabled' : ''}>${svgIcon('check', 13)}Accept merge</button><button class="btn btn-sm" data-cf-prop="edit"${off ? ' disabled' : ''} title="Accept, then put the caret on it to change it">Accept and edit</button><button class="btn btn-sm btn-ghost" data-cf-prop="reject">Reject</button></div>
      </div>`;
  };
  const paintDuel = (): void => {
    const box = view.querySelector<HTMLElement>('#cfDuel');
    if (!box) return;
    if (!duel || duel.file !== file()) { box.innerHTML = ''; return; }
    const d = duel;
    const step = d.ours.state === 'run' ? 'Arguing for ours' : d.theirs.state === 'run' ? 'Arguing for theirs' : d.judge.state === 'run' ? 'The judge is deciding' : '';
    box.innerHTML = `<div class="cf-duel-head">${svgIcon('sparkles', 14)}<b>Duel</b><small>${esc(d.agent)}${step ? ` · ${step}` : ''}</small>${d.running ? '' : '<button class="icon-btn" data-cf-duel="close" title="Close" aria-label="Close the duel">' + svgIcon('x', 14) + '</button>'}</div>
      <div class="cf-cards">${cardHtml('o', 'For ours', d.ours)}${cardHtml('t', 'For theirs', d.theirs)}${cardHtml('j' + (d.merge?.state === 'pending' ? ' ready' : ''), 'Verdict', d.judge, (d.note ? `<div class="cf-card-dim">${esc(d.note)}</div>` : '') + mergeHtml(d))}</div>`;
  };

  const runDuel = async (): Promise<void> => {
    if (duel?.running) return;
    const agent = currentActiveAgent();
    if (!agent) { openAgentPicker(); return; }
    const model = chosenModelFor(agent); // the user's own model for this agent, as the commit message writer uses
    const f = file();
    const b = parseConflicts(f.text)[f.cur];
    if (!b) return;
    const lf = (s: string): string => s.replace(/\r\n/g, '\n');
    const around = blockContext(f.text, b);
    const prompts = duelPrompts({ path: f.path, before: lf(around.before), ours: lf(b.ours), theirs: lf(b.theirs), after: lf(around.after) });
    const d: Duel = { file: f, agent: agent.name, ours: { state: 'wait', text: '' }, theirs: { state: 'wait', text: '' }, judge: { state: 'wait', text: '' }, note: '', running: true, merge: null };
    duel = d;
    const repaint = (): void => { if (duel === d && alive()) { paintDuel(); paintBlock(); } };
    // One call to the agent into its card; the reply, or '' when it failed (the card shows why).
    const ask = async (card: DuelCard, prompt: string): Promise<string | null> => {
      card.state = 'run'; repaint();
      let reply: string, failed = '';
      try { reply = await api.agent.ask({ agent: agent.id, prompt, model }); } catch (e) { reply = ''; failed = errMsg(e) || 'The agent didn\'t answer'; }
      if (!alive()) return null; // the page was left or the session ended
      if (failed) { card.state = 'fail'; card.text = failed; } else { card.state = 'done'; card.text = reply; }
      repaint();
      return failed ? '' : reply;
    };
    repaint();
    view.querySelector('#cfDuel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const oursReply = await ask(d.ours, prompts.ours);
    if (oursReply === null) return;
    const theirsReply = await ask(d.theirs, prompts.theirs);
    if (theirsReply === null) return;
    const verdict = await ask(d.judge, prompts.judge(oursReply || NO_ARGUMENT, theirsReply || NO_ARGUMENT));
    if (verdict === null) return;
    d.running = false;
    if (d.judge.state === 'done') {
      const code = extractCodeBlock(verdict);
      d.judge.text = withoutCodeBlock(verdict) || (code === null ? verdict : 'The judge proposed a merge.');
      if (code === null) d.note = 'The judge didn\'t propose a merge';
      else d.merge = { code, was: b, state: 'pending' }; // waits for Accept: the result isn't touched yet
    }
    repaint();
    if (d.merge && duel === d && alive()) view.querySelector('.cf-card.j')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  // Puts the judge's merge where the conflict is, now that the user accepted it.
  const acceptMerge = (edit: boolean): void => {
    const d = duel, m = d?.merge;
    if (!d || !m || m.state !== 'pending' || busy || pushFailed || d.file !== file()) return;
    const b = duelBlock(d);
    if (!b) { paintDuel(); return; }
    const f = d.file;
    // The block is whole lines, so the merge is too (unless the file ends right after the closing marker).
    const custom = m.code === '' || !/\n$/.test(f.text.slice(b.start, b.end)) ? m.code : m.code + '\n';
    const r = replaceBlock(f, b, { custom });
    if (!r) return;
    m.state = 'accepted';
    paintDuel();
    lightUp(f, r);
    paintBlock();
    scrollResultTo(r.from);
    if (edit) { const ta = textArea(); ta?.focus({ preventScroll: true }); ta?.setSelectionRange(r.from, r.from); }
  };
  const rejectMerge = (): void => {
    const m = duel?.merge;
    if (!m || m.state !== 'pending') return;
    m.state = 'rejected';
    paintDuel();
  };

  const step = (by: number): void => {
    const f = file(), count = parseConflicts(f.text).length;
    if (count > 1) { f.cur = (f.cur + by + count) % count; paintBlock(); scrollToBlock(); }
  };
  const pickFile = (i: number): void => {
    if (i === sel || !files[i]) return;
    sel = i; paintFiles(); paintMain();
  };

  view.onclick = e => {
    const t = e.target as HTMLElement;
    const fileBtn = t.closest<HTMLElement>('.cf-file');
    if (fileBtn) { pickFile(Number(fileBtn.dataset.i)); return; }
    const useBtn = t.closest<HTMLButtonElement>('[data-cf-use]');
    if (useBtn) { if (useBtn.disabled) return; if (useBtn.dataset.cfUse === 'duel') void runDuel(); else use(useBtn.dataset.cfUse as 'ours' | 'theirs' | 'both'); return; }
    const prop = t.closest<HTMLElement>('[data-cf-prop]')?.dataset.cfProp;
    if (prop) { if (prop === 'reject') rejectMerge(); else acceptMerge(prop === 'edit'); return; }
    if (t.closest('[data-cf-duel="close"]')) { if (!duel?.running) { duel = null; paintDuel(); paintBlock(); } return; }
    const stepBtn = t.closest<HTMLElement>('[data-cf-step]');
    if (stepBtn) { step(Number(stepBtn.dataset.cfStep)); return; }
    const binBtn = t.closest<HTMLButtonElement>('[data-cf-bin]');
    if (binBtn) {
      if (!binBtn.disabled && file().binary) { file().bin = binBtn.dataset.cfBin as 'ours' | 'theirs' | 'delete'; paintHeader(); paintFiles(); paintMain(); }
      return;
    }
    const pick = t.closest<HTMLElement>('[data-cf-pick]');
    if (pick) { file().pick = pick.dataset.cfPick as 'keep' | 'delete'; paintHeader(); paintFiles(); paintMain(); return; }
    const act = t.closest<HTMLElement>('[data-cf]')?.dataset.cf;
    if (act === 'commit' || act === 'push') void finish();
    else if (act === 'cancel') void cancel();
    else if (act === 'undo') undo();
    else if (act === 'next-file') pickFile(files.findIndex((f, i) => i !== sel && !cfResolved(f)));
    else if (act === 'copy') {
      const r = cfResult(file());
      const text = 'text' in r ? r.text : null;
      if (text !== null) background(navigator.clipboard.writeText(text).then(() => toast('File copied')));
    }
  };
  // Editing the result: the file's counter, its tick, the colours and the Commit button follow.
  view.oninput = e => {
    if ((e.target as HTMLElement).id !== 'cfText') return;
    file().text = withEol((e.target as HTMLTextAreaElement).value, file().crlf); // the textarea reads LF
    flash = null;
    paintState();
    const m = duel?.merge;
    if (m && duel && m.state === 'accepted' && duelBlock(duel)) m.state = 'pending'; // Undo brought the conflict back: so is the offer
    if (m && m.state !== 'rejected') paintDuel(); // the conflict it would replace may be gone now, or back
  };
  // Clicking or moving the caret into a conflict in the result makes it the one looked at.
  const followCaret = (): void => {
    const ta = textArea(), f = file();
    if (!ta || document.activeElement !== ta) return;
    const pos = ta.selectionStart;
    const i = parseConflicts(ta.value).findIndex(b => pos >= b.start && pos < b.end);
    if (i >= 0 && i !== f.cur) { f.cur = i; paintBlock(); }
  };
  view.addEventListener('mouseup', e => { if ((e.target as HTMLElement).id === 'cfText') followCaret(); });
  view.addEventListener('keyup', e => { if ((e.target as HTMLElement).id === 'cfText' && SURFACE_NAV_KEYS.has(e.key)) followCaret(); });
  // A vertical wheel over a side that only overflows sideways scrolls it sideways.
  view.addEventListener('wheel', e => {
    const box = (e.target as HTMLElement).closest<HTMLElement>('.cf-code');
    if (!box || e.shiftKey || e.deltaX || box.scrollHeight > box.clientHeight || box.scrollWidth <= box.clientWidth) return;
    box.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });
  view.onkeydown = e => {
    const inText = (e.target as HTMLElement).id === 'cfText';
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); step(e.key === 'ArrowDown' ? 1 : -1); return; }
    if (e.altKey && !e.ctrlKey && !e.metaKey && ['1', '2', '3'].includes(e.key)) {
      e.preventDefault();
      if (!pushFailed && !busy) use(e.key === '1' ? 'ours' : e.key === '2' ? 'theirs' : 'both');
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      const commit = view.querySelector<HTMLButtonElement>('[data-cf="commit"]');
      if (commit && !commit.disabled) { e.preventDefault(); void finish(); }
      return;
    }
    if (!inText && (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && textArea()) { e.preventDefault(); undo(); }
  };

  if (session.clean) {
    view.innerHTML = `${head()}<div class="pr-conflict cf-clean"><h4>No conflicts after all</h4><p>${esc(theirs)} merges into ${esc(ours)} cleanly. Push the merge to update the pull request.</p>
      <button class="btn btn-primary btn-sm" data-cf="push">Push merge</button></div>`;
    paintHeader();
    return;
  }
  view.innerHTML = `${head()}<div class="cf-files" id="cfFiles" role="tablist"></div><div class="cf-main" id="cfMain"></div>`;
  paintAll();
}
