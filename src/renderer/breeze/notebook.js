"use strict";
const NB_MAX = 50 * 1024 * 1024;
const nbStates = new Map();
const nbRaw = new Set(); // notebooks the user switched to their JSON
const nbIds = new WeakMap(); // a cell's id for kernel requests (never written to the file)
const nbRequests = new Map();
let nbSeq = 0;
const isNotebook = (b) => !!b && b.kind === 'text' && /\.ipynb$/i.test(b.path);
const nbShown = (b) => isNotebook(b) && !nbRaw.has(b.path) && b.text.length <= NB_MAX;
const nbJoin = (t) => (Array.isArray(t) ? t.join('') : t ?? '');
// Jupyter's own layout: a multi-line string as a list of lines, each keeping its "\n".
const nbSplit = (s) => s.split(/(?<=\n)/).filter(Boolean);
function nbState(b) {
    let s = nbStates.get(b.path);
    if (!s) {
        s = { doc: null, error: '', text: '\0', kernel: 'none', running: new Set(), editing: new Set(), selected: null };
        nbStates.set(b.path, s);
    }
    if (s.text !== b.text)
        nbParse(s, b.text); // first open, or the text changed under the view (undo, disk, an agent)
    return s;
}
function nbParse(s, text) {
    s.text = text;
    if (!text.trim()) {
        s.doc = { cells: [{ cell_type: 'code', source: '', metadata: {}, outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 };
        s.error = '';
        return;
    }
    try {
        const d = JSON.parse(text);
        if (!d || !Array.isArray(d.cells))
            throw new Error('it has no cells');
        if (d.nbformat < 4)
            throw new Error(`it is in an old format (nbformat ${d.nbformat})`);
        for (const c of d.cells)
            c.metadata ??= {};
        s.doc = d;
        s.error = '';
        s.running.clear();
        s.editing.clear();
        s.selected = null;
    }
    catch (e) {
        s.doc = null;
        s.error = errMsg(e);
    }
}
function nbSerialize(doc) {
    const lines = (t) => nbSplit(nbJoin(t));
    const out = {
        ...doc,
        cells: doc.cells.map(c => {
            const cell = { ...c, source: lines(c.source) };
            if (c.cell_type === 'code') {
                cell.outputs = (c.outputs ?? []).map(o => {
                    const x = { ...o };
                    if (o.text != null)
                        x.text = lines(o.text);
                    if (o.data)
                        x.data = Object.fromEntries(Object.entries(o.data).map(([k, v]) => [k, k.startsWith('image/') && k !== 'image/svg+xml' ? nbJoin(v) : lines(v)]));
                    return x;
                });
            }
            return cell;
        }),
    };
    return JSON.stringify(out, null, 1) + '\n';
}
// Writes the notebook back into the buffer: one undo step, and the unsaved dot, as an edit would.
function nbCommit(b, now = false) {
    const s = nbStates.get(b.path);
    if (!s?.doc || !b.ta)
        return;
    clearTimeout(s.commitTimer);
    const write = () => {
        s.commitTimer = undefined;
        if (!s.doc || !b.ta || buffers.get(b.path) !== b)
            return;
        const text = nbSerialize(s.doc);
        if (text === b.text)
            return;
        s.text = text;
        if (nbBuilt.path === b.path)
            nbBuilt.text = text; // the view already shows it
        const focus = document.activeElement;
        remember(b, 'command', b.ta);
        b.ta.setRangeText(text, 0, b.ta.value.length, 'start');
        b.ta.dispatchEvent(new Event('input'));
        focus?.focus({ preventScroll: true });
    };
    if (now)
        write();
    else
        s.commitTimer = setTimeout(write, 400);
}
// Before saving: what's typed in a cell is in the file.
function nbFlush(b) {
    if (nbStates.get(b.path)?.commitTimer !== undefined)
        nbCommit(b, true);
}
/* ----- The view ----- */
const nbView = document.createElement('div');
nbView.className = 'nb-view hidden';
nbView.setAttribute('role', 'region');
nbView.setAttribute('aria-label', 'Notebook');
$('#editor').append(nbView);
let nbViewPath = null;
const nbBuilt = { path: '', text: '' }; // the notebook text the view was last built from
// Called by renderEditor: true when the active buffer is a notebook and this view now shows it.
function renderNotebook(b) {
    if (!b || !nbShown(b)) {
        nbView.classList.add('hidden');
        $('#editor').classList.remove('nb-mode');
        nbViewPath = null;
        nbBuilt.path = '';
        return false;
    }
    const s = nbState(b);
    nbView.classList.remove('hidden');
    $('#editor').classList.add('nb-mode');
    // Rebuilt when another notebook shows or the JSON changed under it; typing in a cell changes only its own cell.
    if (nbBuilt.path !== b.path || nbBuilt.text !== s.text)
        nbBuild(b, s);
    nbViewPath = b.path;
    return true;
}
function nbBuild(b, s) {
    const scroll = nbBuilt.path === b.path ? nbView.scrollTop : 0;
    nbBuilt.path = b.path;
    nbBuilt.text = s.text;
    if (!s.doc) {
        nbView.innerHTML = `<div class="nb-broken"><h4>${esc(baseName(b.path))}</h4><div>Breeze couldn't read this notebook: ${esc(s.error)}.</div><button class="btn btn-sm" data-nb="raw">Open as text</button></div>`;
        return;
    }
    const lang = nbLanguage(s.doc);
    nbView.innerHTML = `<div class="nb-bar">
      <button class="btn btn-sm btn-primary" data-nb="runAll" title="Run every code cell, top to bottom">${svgIcon('play', 11)}<span>Run all</span></button>
      <button class="btn btn-sm" data-nb="restart" title="Start Python again: every variable is forgotten">${svgIcon('rotateCcw', 12)}<span>Restart</span></button>
      <button class="btn btn-sm" data-nb="clear" title="Remove every cell's output">${svgIcon('x', 12)}<span>Clear outputs</span></button>
      <span class="nb-kernel" data-kernel="${s.kernel}"></span>
      <button class="btn btn-sm nb-bar-end" data-nb="raw" title="Show the notebook's JSON">${svgIcon('code', 12)}<span>Open as text</span></button>
    </div>
    <div class="nb-cells">${s.doc.cells.map((c, i) => nbCellHtml(s, c, i, lang)).join('')}</div>
    <div class="nb-add">${nbAddHtml(s.doc.cells.length)}</div>`;
    nbKernelLabel(s);
    nbView.scrollTop = scroll;
}
const nbAddHtml = (at) => `<button class="nb-add-btn" data-nb="addCode" data-at="${at}">${svgIcon('plus', 11)} Code</button><button class="nb-add-btn" data-nb="addMd" data-at="${at}">${svgIcon('plus', 11)} Markdown</button>`;
function nbLanguage(doc) {
    const info = doc.metadata.language_info;
    const ks = doc.metadata.kernelspec;
    return String(info?.name ?? ks?.language ?? 'python').toLowerCase();
}
function nbCellHtml(s, c, i, lang) {
    const src = nbJoin(c.source);
    const sel = s.selected === c ? ' selected' : '';
    const tools = `<div class="nb-cell-tools">
      <button class="icon-btn" data-nb="up" title="Move up">${svgIcon('up', 12)}</button>
      <button class="icon-btn" data-nb="down" title="Move down">${svgIcon('down', 12)}</button>
      <button class="icon-btn" data-nb="type" title="${c.cell_type === 'code' ? 'Make it Markdown' : 'Make it code'}">${c.cell_type === 'code' ? 'M↓' : '{ }'}</button>
      <button class="icon-btn" data-nb="del" title="Delete cell">${svgIcon('trash', 12)}</button>
    </div>`;
    if (c.cell_type === 'markdown' && !s.editing.has(c)) {
        return `<div class="nb-cell md${sel}" data-i="${i}">${tools}<div class="nb-md" title="Double-click to edit">${nbMarkdown(src) || '<span class="nb-empty">Empty Markdown cell: double-click to write</span>'}</div></div>`;
    }
    const code = c.cell_type === 'code';
    const running = s.running.has(c);
    const count = running ? '*' : c.execution_count ?? ' ';
    const gutter = code
        ? `<div class="nb-gutter"><button class="icon-btn nb-run${running ? ' busy' : ''}" data-nb="${running ? 'stop' : 'run'}" title="${running ? 'Stop (restarts Python)' : 'Run cell (Shift+Enter)'}">${svgIcon(running ? 'stop' : 'play', 11)}</button><span class="nb-count">[${count}]</span></div>`
        : '<div class="nb-gutter"></div>';
    const lexer = code ? (lang === 'python' ? 'py' : langOf(`x.${lang}`)[0]) : c.cell_type === 'markdown' ? 'md' : '';
    return `<div class="nb-cell ${c.cell_type}${sel}" data-i="${i}">${tools}${gutter}<div class="nb-body">
      <div class="nb-code"><pre class="nb-hl" aria-hidden="true">${nbHighlight(src, lexer)}</pre><textarea class="nb-src" data-lexer="${lexer}" spellcheck="false" aria-label="${code ? 'Code' : 'Markdown'} cell ${i + 1}">${esc(src)}</textarea></div>
      ${code ? `<div class="nb-outputs">${(c.outputs ?? []).map(nbOutputHtml).join('')}</div>` : ''}
    </div></div>`;
}
// Code coloured by the editor's own lexers; a trailing newline keeps the last line's height.
function nbHighlight(src, lexer) {
    if (!lexer || !LEXERS[lexer])
        return esc(src) + '\n';
    const { starts, kinds } = fullToks(src, lexer);
    let h = '';
    for (let k = 0; k < starts.length; k++) {
        const part = src.slice(starts[k], starts[k + 1] ?? src.length);
        h += kinds[k] ? `<span class="tk-${kinds[k]}">${esc(part)}</span>` : esc(part);
    }
    return h + '\n';
}
function nbOutputHtml(o) {
    if (o.output_type === 'stream')
        return `<pre class="nb-out${o.name === 'stderr' ? ' err' : ''}">${esc(nbJoin(o.text).replace(ANSI, ''))}</pre>`;
    if (o.output_type === 'error')
        return `<pre class="nb-out err">${esc((o.traceback?.length ? o.traceback.join('\n') : `${o.ename}: ${o.evalue}`).replace(ANSI, ''))}</pre>`;
    const d = o.data ?? {};
    if (d['image/png'])
        return `<div class="nb-out img"><img alt="Output image" src="data:image/png;base64,${escAttr(nbJoin(d['image/png']).replace(/\s/g, ''))}"></div>`;
    if (d['image/jpeg'])
        return `<div class="nb-out img"><img alt="Output image" src="data:image/jpeg;base64,${escAttr(nbJoin(d['image/jpeg']).replace(/\s/g, ''))}"></div>`;
    if (d['image/svg+xml'])
        return `<div class="nb-out img"><img alt="Output image" src="data:image/svg+xml;base64,${escAttr(btoa(unescape(encodeURIComponent(nbJoin(d['image/svg+xml'])))))}"></div>`;
    if (d['text/html']) {
        const safe = nbSafeHtml(nbJoin(d['text/html']));
        if (safe)
            return `<div class="nb-out html">${safe}</div>`;
    }
    if (d['text/markdown'])
        return `<div class="nb-out nb-md">${nbMarkdown(nbJoin(d['text/markdown']))}</div>`;
    const plain = d['text/plain'];
    if (plain != null)
        return `<pre class="nb-out${o.output_type === 'execute_result' ? ' result' : ''}">${esc(nbJoin(plain).replace(ANSI, ''))}</pre>`;
    return '';
}
// HTML output (pandas tables, say) with only plain formatting tags kept: no scripts, styles, links or attributes
// except a table cell's spans. Empty when nothing worth showing is left.
const NB_TAGS = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'CAPTION', 'B', 'I', 'EM', 'STRONG', 'CODE', 'PRE', 'BR', 'P', 'SPAN', 'DIV', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SUB', 'SUP', 'SMALL', 'HR']);
function nbSafeHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const clean = (el) => {
        for (const child of [...el.children]) {
            if (!NB_TAGS.has(child.tagName)) {
                if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE'].includes(child.tagName))
                    child.remove();
                else {
                    clean(child);
                    child.replaceWith(...child.childNodes);
                }
                continue;
            }
            for (const a of [...child.attributes])
                if (!['colspan', 'rowspan'].includes(a.name))
                    child.removeAttribute(a.name);
            clean(child);
        }
    };
    clean(doc.body);
    return doc.body.textContent?.trim() ? doc.body.innerHTML : '';
}
/* ----- Markdown cells: a safe subset (headings, lists, quotes, code, tables, emphasis, links) ----- */
function nbInline(s) {
    const codes = [];
    let t = esc(s).replace(/`([^`]+)`/g, (_m, c) => `\u0000${codes.push(c) - 1}\u0000`);
    t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label, url) => `<a href="#" data-href="${url}">${label}</a>`)
        .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a, b2) => `<b>${a ?? b2}</b>`)
        .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)|(^|\W)_([^_\n]+)_(?!\w)/g, (_m, p1, a, p3, b2) => `${p1 ?? p3}<i>${a ?? b2}</i>`)
        .replace(/~~([^~]+)~~/g, '<s>$1</s>');
    return t.replace(/\u0000(\d+)\u0000/g, (_m, n) => `<code>${codes[Number(n)]}</code>`);
}
function nbMarkdown(src) {
    const lines = src.replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let para = [];
    const flush = () => { if (para.length)
        out.push(`<p>${nbInline(para.join(' '))}</p>`); para = []; };
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(l);
        if (fence) {
            flush();
            const body = [];
            for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++)
                body.push(lines[i]);
            const lx = fence[2] ? langOf(`x.${LANG_EXT[fence[2].toLowerCase()] ?? fence[2]}`)[0] : '';
            out.push(`<pre class="nb-md-code">${nbHighlight(body.join('\n'), lx)}</pre>`);
            continue;
        }
        const h = /^(#{1,6})\s+(.*)$/.exec(l);
        if (h) {
            flush();
            out.push(`<h${h[1].length}>${nbInline(h[2])}</h${h[1].length}>`);
            continue;
        }
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) {
            flush();
            out.push('<hr>');
            continue;
        }
        if (/^\s*>/.test(l)) {
            flush();
            const q = [];
            for (; i < lines.length && /^\s*>/.test(lines[i]); i++)
                q.push(lines[i].replace(/^\s*>\s?/, ''));
            i--;
            out.push(`<blockquote>${nbMarkdown(q.join('\n'))}</blockquote>`);
            continue;
        }
        const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(l);
        if (li) {
            flush();
            const ordered = /\d/.test(li[1]);
            const items = [];
            for (; i < lines.length; i++) {
                const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
                if (!m || /\d/.test(m[1]) !== ordered)
                    break;
                items.push(`<li>${nbInline(m[2])}</li>`);
            }
            i--;
            out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
            continue;
        }
        if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? '')) {
            flush();
            const row = (r, tag) => `<tr>${r.trim().replace(/^\||\|$/g, '').split('|').map(c => `<${tag}>${nbInline(c.trim())}</${tag}>`).join('')}</tr>`;
            const rows = [`<thead>${row(l, 'th')}</thead><tbody>`];
            for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++)
                rows.push(row(lines[i], 'td'));
            i--;
            out.push(`<table>${rows.join('')}</tbody></table>`);
            continue;
        }
        if (!l.trim()) {
            flush();
            continue;
        }
        para.push(l.trim());
    }
    flush();
    return out.join('');
}
/* ----- Editing ----- */
const nbActive = () => {
    const b = activeBuf();
    return b && nbShown(b) && nbViewPath === b.path ? { b, s: nbState(b) } : null;
};
const nbCellOf = (el, s) => {
    const i = Number(el.closest('.nb-cell')?.dataset.i);
    return Number.isInteger(i) ? s.doc?.cells[i] ?? null : null;
};
function nbSelect(s, c) {
    s.selected = c;
    const i = c ? s.doc?.cells.indexOf(c) ?? -1 : -1;
    for (const el of $$('.nb-cell', nbView))
        el.classList.toggle('selected', Number(el.dataset.i) === i);
}
nbView.addEventListener('input', e => {
    const ta = e.target;
    if (!ta.classList.contains('nb-src'))
        return;
    const a = nbActive();
    const c = a && nbCellOf(ta, a.s);
    if (!a || !c)
        return;
    const t = ta;
    c.source = t.value;
    const pre = t.previousElementSibling;
    pre.innerHTML = nbHighlight(t.value, t.dataset.lexer ?? '');
    nbCommit(a.b);
});
nbView.addEventListener('focusin', e => {
    const a = nbActive();
    const c = a && nbCellOf(e.target, a.s);
    if (a && c && a.s.selected !== c)
        nbSelect(a.s, c);
});
nbView.addEventListener('dblclick', e => {
    const md = e.target.closest('.nb-md');
    const a = nbActive();
    const c = a && md && !md.closest('.nb-out') && nbCellOf(md, a.s);
    if (!a || !c)
        return;
    a.s.editing.add(c);
    nbRefresh(a.b, a.s, c);
});
nbView.addEventListener('click', e => {
    const t = e.target;
    const link = t.closest('a[data-href]');
    if (link) {
        e.preventDefault();
        background(api.sys.openExternal(link.dataset.href));
        return;
    }
    const btn = t.closest('[data-nb]');
    const a = nbActive();
    if (!btn) {
        const c = a && nbCellOf(t, a.s);
        if (a && c)
            nbSelect(a.s, c);
        return;
    }
    const what = btn.dataset.nb;
    if (what === 'raw') {
        run('nb.toggleView');
        return;
    }
    if (!a?.s.doc)
        return;
    const { b, s } = a;
    const doc = s.doc;
    const c = nbCellOf(btn, s);
    const at = c ? doc.cells.indexOf(c) : -1;
    switch (what) {
        case 'run':
            if (c)
                nbRun(b, s, [c]);
            break;
        case 'stop':
        case 'restart':
            nbRestart(b, s);
            break;
        case 'runAll':
            nbRun(b, s, doc.cells.filter(x => x.cell_type === 'code'));
            break;
        case 'clear':
            for (const x of doc.cells)
                if (x.cell_type === 'code') {
                    x.outputs = [];
                    x.execution_count = null;
                }
            nbCommit(b, true);
            nbBuild(b, s);
            break;
        case 'addCode':
        case 'addMd':
            nbInsert(b, s, Number(btn.dataset.at), what === 'addCode' ? 'code' : 'markdown');
            break;
        case 'up':
        case 'down': {
            const to = at + (what === 'up' ? -1 : 1);
            if (!c || to < 0 || to >= doc.cells.length)
                break;
            doc.cells.splice(at, 1);
            doc.cells.splice(to, 0, c);
            nbCommit(b, true);
            nbBuild(b, s);
            break;
        }
        case 'type':
            if (!c)
                break;
            if (c.cell_type === 'code') {
                c.cell_type = 'markdown';
                delete c.outputs;
                delete c.execution_count;
                s.editing.add(c);
            }
            else {
                c.cell_type = 'code';
                c.outputs = [];
                c.execution_count = null;
            }
            nbCommit(b, true);
            nbBuild(b, s);
            break;
        case 'del':
            if (!c)
                break;
            doc.cells.splice(at, 1);
            if (!doc.cells.length)
                doc.cells.push({ cell_type: 'code', source: '', metadata: {}, outputs: [], execution_count: null });
            nbCommit(b, true);
            nbBuild(b, s);
            break;
    }
});
nbView.addEventListener('keydown', e => {
    const t = e.target;
    if (!t.classList.contains('nb-src') || e.key !== 'Enter' && e.key !== 'Escape' && e.key !== 'Tab')
        return;
    const a = nbActive();
    const c = a && nbCellOf(t, a.s);
    if (!a?.s.doc || !c)
        return;
    const ta = t;
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) { // indent, as in the editor
        e.preventDefault();
        const { selectionStart: s0, selectionEnd: s1 } = ta;
        if (e.shiftKey)
            return;
        ta.setRangeText(INDENT, s0, s1, 'end');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return;
    }
    if (e.key === 'Escape') {
        ta.blur();
        return;
    }
    if (!e.shiftKey && !e.ctrlKey && !e.altKey)
        return;
    e.preventDefault();
    e.stopPropagation();
    const doc = a.s.doc;
    if (c.cell_type === 'markdown') {
        a.s.editing.delete(c);
        nbRefresh(a.b, a.s, c);
    }
    else
        nbRun(a.b, a.s, [c]);
    // Shift+Enter moves on (adding a cell at the end), Alt+Enter adds one below, Ctrl+Enter stays.
    const i = doc.cells.indexOf(c);
    if (e.altKey || (e.shiftKey && i === doc.cells.length - 1))
        nbInsert(a.b, a.s, i + 1, 'code');
    else if (e.shiftKey)
        nbFocus(doc.cells[i + 1]);
}, true);
function nbInsert(b, s, at, type) {
    if (!s.doc)
        return;
    const cell = type === 'code' ? { cell_type: 'code', source: '', metadata: {}, outputs: [], execution_count: null } : { cell_type: 'markdown', source: '', metadata: {} };
    if (s.doc.nbformat_minor >= 5)
        cell.id = crypto.randomUUID().slice(0, 8);
    if (type === 'markdown')
        s.editing.add(cell);
    s.doc.cells.splice(Math.max(0, Math.min(at, s.doc.cells.length)), 0, cell);
    nbCommit(b, true);
    nbBuild(b, s);
    nbFocus(cell);
}
function nbFocus(c) {
    const a = nbActive();
    const i = c && a?.s.doc ? a.s.doc.cells.indexOf(c) : -1;
    const el = $$('.nb-cell', nbView).find(x => Number(x.dataset.i) === i);
    if (!el || !a)
        return;
    nbSelect(a.s, c ?? null);
    const ta = $$('.nb-src', el)[0];
    if (ta)
        ta.focus();
    else
        el.scrollIntoView({ block: 'nearest' });
}
// Redraws one cell in place (its outputs or Markdown), leaving the others and the caret alone.
function nbRefresh(b, s, c) {
    if (nbViewPath !== b.path || !s.doc)
        return;
    const i = s.doc.cells.indexOf(c);
    const el = $$('.nb-cell', nbView).find(x => Number(x.dataset.i) === i);
    if (!el)
        return;
    const focused = document.activeElement?.closest('.nb-cell') === el;
    const tmp = document.createElement('div');
    tmp.innerHTML = nbCellHtml(s, c, i, nbLanguage(s.doc));
    const fresh = tmp.firstElementChild;
    const oldSrc = $$('.nb-src', el)[0];
    const newSrc = $$('.nb-src', fresh)[0];
    // Keep the textarea itself (its caret and native undo) when the cell still has one.
    if (oldSrc && newSrc) {
        newSrc.replaceWith(oldSrc);
        el.replaceWith(fresh);
        if (focused)
            oldSrc.focus({ preventScroll: true });
    }
    else {
        el.replaceWith(fresh);
        newSrc?.focus();
    }
}
/* ----- Running ----- */
function nbKernelLabel(s) {
    const el = $$('.nb-kernel', nbView)[0];
    if (!el)
        return;
    el.dataset.kernel = s.kernel;
    el.textContent = { none: 'Python: not started', idle: 'Python: ready', busy: 'Python: running…', dead: 'Python: stopped' }[s.kernel];
}
function nbRun(b, s, cells) {
    if (nbLanguage(s.doc) !== 'python') {
        toast('Breeze runs Python notebooks. This one is for another language.');
        return;
    }
    if (untitledPath(b.path)) {
        toast('Save the notebook first');
        return;
    }
    for (const c of cells) {
        if (s.running.has(c))
            continue;
        const id = `nb${++nbSeq}`;
        nbIds.set(c, id);
        nbRequests.set(id, { path: b.path, cell: c });
        c.outputs = [];
        c.execution_count = null;
        s.running.add(c);
        nbRefresh(b, s, c);
        api.nb.run(b.path, id, nbJoin(c.source)).catch(err => {
            nbRequests.delete(id);
            s.running.delete(c);
            c.outputs = [{ output_type: 'error', ename: 'Error', evalue: errMsg(err), traceback: [errMsg(err)] }];
            if (!s.running.size) {
                s.kernel = 'none';
                nbKernelLabel(s);
            }
            nbRefresh(b, s, c);
            nbCommit(b);
        });
    }
    s.kernel = 'busy';
    nbKernelLabel(s);
}
function nbRestart(b, s) {
    background(api.nb.stop(b.path));
    s.kernel = 'none';
    nbKernelLabel(s);
}
const untitledPath = (p) => p.startsWith(UNTITLED_DIR);
api.nb.onMessage((path, msg) => {
    const req = nbRequests.get(msg.id);
    const b = buffers.get(path);
    if (!req || !b)
        return;
    const s = nbStates.get(path);
    const c = req.cell;
    if (!s)
        return;
    const outs = c.outputs ??= [];
    if (msg.type === 'stream') {
        const last = outs.at(-1);
        if (last?.output_type === 'stream' && last.name === msg.name)
            last.text = nbJoin(last.text) + msg.text;
        else
            outs.push({ output_type: 'stream', name: msg.name, text: msg.text });
    }
    else if (msg.type === 'display')
        outs.push({ output_type: 'display_data', data: msg.data, metadata: {} });
    else if (msg.type === 'result')
        outs.push({ output_type: 'execute_result', data: msg.data, metadata: {}, execution_count: null });
    else if (msg.type === 'error')
        outs.push({ output_type: 'error', ename: msg.ename, evalue: msg.evalue, traceback: msg.traceback });
    else if (msg.type === 'done') {
        nbRequests.delete(msg.id);
        s.running.delete(c);
        c.execution_count = msg.count ?? null;
        for (const o of outs)
            if (o.output_type === 'execute_result')
                o.execution_count = c.execution_count;
    }
    if (s.doc?.cells.includes(c)) {
        nbRefresh(b, s, c);
        nbCommit(b, msg.type === 'done');
    }
});
api.nb.onState((path, state) => {
    const s = nbStates.get(path);
    if (!s)
        return;
    s.kernel = state === 'dead' ? (s.kernel === 'none' ? 'none' : 'dead') : state;
    if (nbViewPath === path)
        nbKernelLabel(s);
});
function nbClosed(path) {
    if (!nbStates.has(path))
        return;
    nbStates.delete(path);
    nbRaw.delete(path);
    background(api.nb.stop(path));
}
// View → Notebook View: the cells, or the notebook's JSON in the editor.
commands['nb.toggleView'] = () => {
    const b = activeBuf();
    if (!isNotebook(b)) {
        toast('Open a .ipynb notebook first');
        return;
    }
    if (nbRaw.has(b.path))
        nbRaw.delete(b.path);
    else {
        nbFlush(b);
        nbRaw.add(b.path);
    }
    renderEditor();
};
