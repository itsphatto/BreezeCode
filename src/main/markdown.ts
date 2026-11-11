// Markdown to HTML for the preview (previewServer.js): what READMEs use. Headings, paragraphs, lists (nested by
// indent), task boxes, fenced code, block quotes, rules, GitHub tables, links, images, bold, italic, strikethrough and
// inline code. HTML in the file passes through like on GitHub, scripts aside.
// shortcut: no reference-style links, footnotes or setext headings; reach for a full parser if READMEs need them.

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Text with its own HTML kept: a `<` that doesn't start a tag, and a `&` that doesn't start an entity, are escaped.
const keepTags = (s: string) => s.replace(/&(?!#?\w+;)/g, '&amp;').replace(/<(?!\/?[a-zA-Z][^<>]*>|!--)/g, '&lt;');
const safeUrl = (u: string) => (/^\s*(javascript|vbscript|data):/i.test(u) && !/^\s*data:image\//i.test(u) ? '#' : u.replace(/"/g, '%22'));

function inline(text: string): string {
  const codes: string[] = [];
  // Code spans first, held aside so nothing inside them is read as Markdown.
  let s = text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_: string, _t: string, c: string) => `\u0000${codes.push(`<code>${esc(c.trim())}</code>`) - 1}\u0000`);
  s = keepTags(s)
    .replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"([^"]*)")?\s*\)/g, (_: string, alt: string, src: string, t?: string) => `<img src="${safeUrl(src)}" alt="${alt}"${t ? ` title="${t}"` : ''}>`)
    .replace(/\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"([^"]*)")?\s*\)/g, (_: string, label: string, href: string, t?: string) => `<a href="${safeUrl(href)}"${t ? ` title="${t}"` : ''}>${label}</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2">$2</a>')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>')
    .replace(/(^|[^\w*])[*_](?=\S)([^*_]*?\S)[*_](?![\w*])/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
    .replace(/ {2,}\n|\\\n/g, '<br>\n');
  return s.replace(/\u0000(\d+)\u0000/g, (_: string, i: string) => codes[Number(i)]);
}

const cells = (row: string): string[] => row.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
const isRule = (l: string) => /^ {0,3}([-*_])( *\1){2,} *$/.test(l);
const isTableSep = (l: string) => /^ *\|? *:?-+:? *(\| *:?-+:? *)*\|? *$/.test(l) && l.includes('-');
const HTML_BLOCK = /^ {0,3}(<!--|<\/?(address|article|aside|blockquote|center|details|div|dl|dd|dt|fieldset|figure|figcaption|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|picture|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul))/i;
const listItem = (l: string) => /^( *)([-*+]|\d+[.)]) +(.*)$/.exec(l);

// Lines starting at `i` that make up one list; nested lists are the lines indented under an item.
function list(lines: string[], i: number): { html: string; next: number } {
  const first = listItem(lines[i])!;
  const indent = first[1].length, ordered = /\d/.test(first[2]);
  // An item of this list: as indented, and the same kind (a numbered list after a bulleted one is a list of its own).
  const mine = (l: string) => { const m = listItem(l); return m && m[1].length === indent && /\d/.test(m[2]) === ordered ? m : null; };
  const items: string[][] = [];
  while (i < lines.length) {
    const m = mine(lines[i]);
    if (m) { items.push([m[3]]); i++; continue; }
    if (listItem(lines[i])?.[1].length === indent) break;
    if (lines[i].trim() && (/^ +/.exec(lines[i])?.[0].length ?? 0) > indent) { items.at(-1)!.push(lines[i].slice(indent + 2)); i++; continue; }
    if (!lines[i].trim() && lines[i + 1] && (mine(lines[i + 1]) || (/^ */.exec(lines[i + 1])![0].length > indent && lines[i + 1].trim()))) { i++; continue; }
    break;
  }
  const start = ordered && parseInt(first[2], 10) !== 1 ? ` start="${parseInt(first[2], 10)}"` : '';
  const html: string = items.map(body => {
    let text = body.join('\n');
    const task = /^\[([ xX])\] +/.exec(text);
    if (task) text = text.slice(task[0].length);
    const box = task ? `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> ` : '';
    const [head, ...rest] = text.split('\n');
    return `<li${task ? ' class="task"' : ''}>${box}${inline(head)}${rest.length ? blocks(rest) : ''}</li>`;
  }).join('');
  return { html: ordered ? `<ol${start}>${html}</ol>` : `<ul>${html}</ul>`, next: i };
}

function blocks(lines: string[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^ *(```+|~~~+) *([^`\s]*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
      i++;
      out.push(`<pre><code${fence[2] ? ` class="language-${esc(fence[2])}"` : ''}>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^ {0,3}(#{1,6}) +(.*?)(?: +#+)? *$/.exec(line);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (isRule(line)) { out.push('<hr>'); i++; continue; }
    if (/^ {0,3}>/.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && /^ {0,3}>/.test(lines[i]); i++) body.push(lines[i].replace(/^ {0,3}> ?/, ''));
      out.push(`<blockquote>${blocks(body)}</blockquote>`);
      continue;
    }
    if (listItem(line)) { const l: { html: string; next: number } = list(lines, i); out.push(l.html); i = l.next; continue; }
    if (line.includes('|') && lines[i + 1] && isTableSep(lines[i + 1])) {
      const align = cells(lines[i + 1]).map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
      const row = (r: string, tag: string) => `<tr>${cells(r).map((c, n) => `<${tag}${align[n] ? ` align="${align[n]}"` : ''}>${inline(c)}</${tag}>`).join('')}</tr>`;
      const body: string[] = [];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) body.push(row(lines[i], 'td'));
      out.push(`<table><thead>${row(line, 'th')}</thead><tbody>${body.join('')}</tbody></table>`);
      continue;
    }
    // An HTML block runs to the next blank line, as it is: a block tag, a comment, or a tag alone on its line. A line
    // that only starts with an inline tag (<sub>[a](b)</sub>) is a paragraph, whose Markdown is read.
    if (HTML_BLOCK.test(line) || /^ {0,3}<\/?[a-zA-Z][^<>]*> *$/.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && lines[i].trim(); i++) body.push(lines[i]);
      out.push(body.join('\n'));
      continue;
    }
    const para: string[] = [];
    for (; i < lines.length && lines[i].trim() && !/^ *(```|~~~|#{1,6} |>)/.test(lines[i]) && !listItem(lines[i]) && !isRule(lines[i]); i++) para.push(lines[i]);
    out.push(`<p>${inline(para.join('\n'))}</p>`);
  }
  return out.join('\n');
}

const DARK = '--bg:#1d1d1f;--fg:#e6e6e8;--muted:#9b9ba1;--line:#3a3a3f;--code:#2a2a2e;--link:#6ea0ff;--ink:255,255,255;color-scheme:dark';
const STYLE = `<style>
:root{color-scheme:light;--bg:#fff;--fg:#1f2328;--muted:#59636e;--line:#d1d9e0;--code:#f6f8fa;--link:#0969da;--ink:0,0,0}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${DARK}}}
:root[data-theme=dark]{${DARK}}
html{background:var(--bg);transition:background-color .25s ease}
body{margin:0;padding:52px 32px 48px;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--fg);max-width:880px;transition:color .25s ease}
h1,h2{padding-bottom:.3em;border-bottom:1px solid var(--line)}h1,h2,h3,h4{margin:1.4em 0 .6em;line-height:1.25}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}img{max-width:100%}
code{padding:.15em .4em;border-radius:6px;background:var(--code);font:85% ui-monospace,Consolas,monospace}
pre{padding:14px 16px;border-radius:8px;background:var(--code);overflow:auto}pre code{padding:0;background:none;font-size:13px}
blockquote{margin:0;padding:0 1em;color:var(--muted);border-left:3px solid var(--line)}
table{border-collapse:collapse;display:block;overflow:auto}th,td{padding:6px 13px;border:1px solid var(--line)}
hr{border:0;border-top:1px solid var(--line);margin:24px 0}li.task{list-style:none}li.task input{margin:0 .4em 0 -1.3em}
.md-theme{position:fixed;top:10px;left:10px;z-index:10;display:grid;place-items:center;width:30px;height:30px;padding:0;border:1px solid rgba(var(--ink),.12);border-radius:9px;background:rgba(var(--ink),.06);color:var(--muted);cursor:pointer;backdrop-filter:blur(8px);transition:color .15s,background-color .15s}
.md-theme:hover{color:var(--fg);background:rgba(var(--ink),.12)}.md-theme:active svg{scale:.9}
.md-theme svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.md-slider{position:fixed;top:6px;right:3px;bottom:6px;width:12px;display:none;z-index:10}.md-slider.on{display:block}
.md-slider i{position:absolute;top:0;right:2px;width:8px;border-radius:4px;background:rgba(var(--ink),.16);box-shadow:inset 0 0 0 1px rgba(var(--ink),.1);backdrop-filter:blur(6px) saturate(140%);transition:background-color .15s;cursor:pointer}
.md-slider:hover i,.md-slider.drag i{background:rgba(var(--ink),.3)}
</style>`;
const THEME_KEY = 'breeze.mdTheme';
// Read before the body paints, so a page shown light (or dark) on purpose never flashes the other way first.
const HEAD_SCRIPT = `<script>try{const t=localStorage.getItem('${THEME_KEY}');if(t)document.documentElement.dataset.theme=t}catch{}</script>`;
const SUN = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2m-7.07-17.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
const MOON = '<svg viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';
// The toggle (top left) swaps the background between dark and light and is remembered for every Markdown preview.
// The slider stands in for the hidden scrollbar, the same as the editor's (.v-slider in breeze.css): a quarter of the
// window tall at most, dragged or clicked to scroll.
const BODY_SCRIPT = `<script>(() => {
  const root = document.documentElement;
  const dark = () => (root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
  const btn = document.createElement('button');
  btn.className = 'md-theme';
  const paint = () => { btn.innerHTML = dark() ? ${JSON.stringify(SUN)} : ${JSON.stringify(MOON)}; btn.title = dark() ? 'Light background' : 'Dark background'; btn.setAttribute('aria-label', btn.title); };
  btn.onclick = () => {
    root.dataset.theme = dark() ? 'light' : 'dark';
    try { localStorage.setItem('${THEME_KEY}', root.dataset.theme); } catch {}
    paint();
    btn.firstChild.animate([{ rotate: '-90deg', scale: '.5', opacity: 0 }, { rotate: '0deg', scale: '1', opacity: 1 }], { duration: 280, easing: 'cubic-bezier(.2, .8, .2, 1)' });
  };
  paint();
  const track = document.createElement('div'), thumb = document.createElement('i');
  track.className = 'md-slider';
  track.append(thumb);
  document.body.append(btn, track);
  const se = document.scrollingElement, room = () => innerHeight - 12;
  const update = () => {
    const over = se.scrollHeight - innerHeight;
    track.classList.toggle('on', over > 0);
    if (over <= 0) return;
    const len = Math.max(24, Math.min(room() / 4, room() * innerHeight / se.scrollHeight));
    thumb.style.height = len + 'px';
    thumb.style.transform = 'translateY(' + (room() - len) * se.scrollTop / over + 'px)';
  };
  thumb.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const start = e.clientY, from = se.scrollTop;
    thumb.setPointerCapture(e.pointerId);
    track.classList.add('drag');
    thumb.onpointermove = ev => { const travel = room() - thumb.offsetHeight; if (travel > 0) se.scrollTop = from + (ev.clientY - start) * (se.scrollHeight - innerHeight) / travel; };
    thumb.onpointerup = thumb.onpointercancel = () => { track.classList.remove('drag'); thumb.onpointermove = null; };
    e.preventDefault();
  });
  track.addEventListener('pointerdown', e => {
    if (e.target !== track || e.button !== 0) return;
    se.scrollTop = (e.clientY - 6) / room() * se.scrollHeight - innerHeight / 2;
  });
  addEventListener('scroll', update, { passive: true });
  addEventListener('resize', update);
  new ResizeObserver(update).observe(document.body);
  update();
})();</script>`;

// A whole page for the preview frame; `title` is the file's name. Scripts in the file are dropped; the page's own
// (the theme toggle and the slider) are added after that.
function markdownPage(text: string, title = ''): string {
  const body = blocks(text.replace(/\r\n?/g, '\n').split('\n')).replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>${STYLE}${HEAD_SCRIPT}</head><body>${body}${BODY_SCRIPT}</body></html>`;
}

const markdownBody = (text: string) => blocks(text.replace(/\r\n?/g, '\n').split('\n'));

export { markdownPage, markdownBody };
