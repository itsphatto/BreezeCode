/* Breeze Code hero: a working copy of the editor window, built from the app's own UI (src/renderer). Everything runs
   in the browser. Files, the terminal, the preview and the agents are simulated in memory and nothing is sent anywhere. */
(() => {
  const root = document.getElementById('bzDemo');
  if (!root) return;
  const sfx = window.sfx || { play() {} };
  const ASSETS = root.dataset.assets || 'assets/';
  const MIN_W = 1060; // narrower frames get the desktop layout scaled down, like the screenshot it replaces
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sleep = ms => new Promise(r => setTimeout(r, calm ? Math.min(ms, 80) : ms));
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const baseName = p => p.slice(p.lastIndexOf('/') + 1);
  const dirName = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const extOf = p => { const n = baseName(p).toLowerCase(); return n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : ''; };

  /* ================= Icons (copied from breeze.html / breezescript.ts) ================= */
  const svg16 = body => `<svg viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
  const badge = (bg, fg, label) => svg16(`<rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="${bg}"/><text x="8" y="11.2" text-anchor="middle" font-family="Inter,Segoe UI,sans-serif" font-weight="800" font-size="6.4" fill="${fg}">${label}</text>`);
  const page = (color, inner = '') => svg16(`<path d="M3.5 1.5h6l3 3v10h-9z" fill="${color}" fill-opacity=".16" stroke="${color}" stroke-width="1.1" stroke-linejoin="round"/><path d="M9.5 1.5v3h3" fill="none" stroke="${color}" stroke-width="1.1" stroke-linejoin="round"/>${inner}`);
  const FILE_ICONS = {
    html: svg16('<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" fill="none" stroke="#f16529" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="m9 3.5-2 9" stroke="#f9a77d" stroke-width="1.4" stroke-linecap="round"/>'),
    css: svg16('<path d="M6.3 2.5 5 13.5M11 2.5 9.7 13.5M2.8 6h11M2.2 10h11" fill="none" stroke="#42a5f5" stroke-width="1.6" stroke-linecap="round"/>'),
    js: badge('#f1d33b', '#1e1e1e', 'JS'),
    ts: badge('#3178c6', '#ffffff', 'TS'),
    json: svg16('<path d="M6 2.5c-1.6 0-1.8.8-1.8 2v1.3c0 1-.5 1.7-1.7 1.9v.6c1.2.2 1.7.9 1.7 1.9v1.3c0 1.2.2 2 1.8 2M10 2.5c1.6 0 1.8.8 1.8 2v1.3c0 1 .5 1.7 1.7 1.9v.6c-1.2.2-1.7.9-1.7 1.9v1.3c0 1.2-.2 2-1.8 2" fill="none" stroke="#f5b942" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="8" r="1" fill="#f5b942"/>'),
    md: svg16('<rect x="1" y="3.5" width="14" height="9" rx="2" fill="none" stroke="#6aa8d8" stroke-width="1.2"/><path d="M3.5 10.5v-4l1.8 2 1.8-2v4M11.2 6.3v4M9.6 8.9l1.6 1.6 1.6-1.6" fill="none" stroke="#6aa8d8" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>'),
    py: svg16('<path d="M8 1.5c-3 0-3 1.3-3 2.3V6h3.2v.6H3.6C2.3 6.6 1.5 7.6 1.5 9.4s.8 2.9 2 2.9H5V10.5c0-1.2 1-2.2 2.2-2.2h3.3c1 0 1.8-.8 1.8-1.8V3.8c0-1.2-1.2-2.3-4.3-2.3z" fill="#3776ab"/><path d="M8 14.5c3 0 3-1.3 3-2.3V10H7.8v-.6h4.6c1.3 0 2.1-1 2.1-2.8s-.8-2.9-2-2.9H11v1.8c0 1.2-1 2.2-2.2 2.2H5.5c-1 0-1.8.8-1.8 1.8v2.7c0 1.2 1.2 2.3 4.3 2.3z" fill="#ffd43b"/>'),
    image: svg16('<rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="#b388ff" fill-opacity=".18" stroke="#b388ff" stroke-width="1.2"/><circle cx="5.5" cy="6" r="1.3" fill="#ffd166"/><path d="m2.5 12.5 4-4 2.5 2.5 1.8-1.8 3 3.3z" fill="#b388ff"/>'),
    git: svg16('<path d="M8 1.6 14.4 8 8 14.4 1.6 8z" fill="#f05033"/><path d="M6.4 5.2v5.6M6.4 6.6 9.6 9.4" stroke="#fff" stroke-width="1.1" stroke-linecap="round"/><circle cx="6.4" cy="10.6" r="1" fill="#fff"/><circle cx="9.6" cy="9.4" r="1" fill="#fff"/><circle cx="6.4" cy="5" r="1" fill="#fff"/>'),
    text: page('#a1a1aa', '<path d="M5.5 7.5h5M5.5 9.5h5M5.5 11.5h3" stroke="#a1a1aa" stroke-width="1" stroke-linecap="round"/>'),
    file: page('#8b8b95'),
  };
  const EXT_ICON = { html: 'html', htm: 'html', css: 'css', js: 'js', mjs: 'js', ts: 'ts', json: 'json', md: 'md', py: 'py', png: 'image', jpg: 'image', svg: 'image', txt: 'text' };
  function fileIcon(name) {
    const n = name.toLowerCase();
    if (n.startsWith('.git')) return FILE_ICONS.git;
    return FILE_ICONS[EXT_ICON[extOf(n)] ?? 'file'];
  }
  const FOLDER_COLORS = [[/^\.git$/, '#f05033'], [/^\.(claude|vscode|github)$/, '#d97757'], [/^(assets|images?|img|public|icons?)$/, '#ffb74d'], [/^(src|app|lib)$/, '#7aa9ff'], [/^(styles?|css)$/, '#42a5f5']];
  function folderIcon(name, open) {
    const c = FOLDER_COLORS.find(([re]) => re.test(name.toLowerCase()))?.[1] ?? '#90a4c4';
    return open
      ? svg16(`<path d="M1.5 4a1 1 0 0 1 1-1h3.4l1.4 1.5h5.7a1 1 0 0 1 1 1V7H4.2a1 1 0 0 0-.95.68L1.5 12.5z" fill="${c}" fill-opacity=".55"/><path d="M3.3 7.7A1 1 0 0 1 4.25 7h10.3l-1.9 5.8a1 1 0 0 1-.95.7H1.5z" fill="${c}"/>`)
      : svg16(`<path d="M1.5 4a1 1 0 0 1 1-1h3.4l1.4 1.5h6.2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="${c}"/><path d="M1.5 6h13" stroke="#000" stroke-opacity=".18"/>`);
  }
  const CHEV = '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // 24×24 line icons: [stroke width, body]
  const LINE = {
    files: [1.7, '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5"/>'],
    search: [1.7, '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>'],
    git: [1.7, '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10M18 11c0 4-6 3-12 6"/>'],
    gear: [1.6, '<path d="M10.46 4.76L10.83 2.47A9.6 9.6 0 0 1 13.17 2.47L13.54 4.76A7.4 7.4 0 0 1 16.03 5.79L17.91 4.44A9.6 9.6 0 0 1 19.56 6.09L18.21 7.97A7.4 7.4 0 0 1 19.24 10.46L21.53 10.83A9.6 9.6 0 0 1 21.53 13.17L19.24 13.54A7.4 7.4 0 0 1 18.21 16.03L19.56 17.91A9.6 9.6 0 0 1 17.91 19.56L16.03 18.21A7.4 7.4 0 0 1 13.54 19.24L13.17 21.53A9.6 9.6 0 0 1 10.83 21.53L10.46 19.24A7.4 7.4 0 0 1 7.97 18.21L6.09 19.56A9.6 9.6 0 0 1 4.44 17.91L5.79 16.03A7.4 7.4 0 0 1 4.76 13.54L2.47 13.17A9.6 9.6 0 0 1 2.47 10.83L4.76 10.46A7.4 7.4 0 0 1 5.79 7.97L4.44 6.09A9.6 9.6 0 0 1 6.09 4.44L7.97 5.79A7.4 7.4 0 0 1 10.46 4.76Z"/><circle cx="12" cy="12" r="3.2"/>'],
    newfile: [1.6, '<path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z M13 3v6h6"/><path d="M12 12v6M9 15h6"/>'],
    newdir: [1.6, '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/>'],
    refresh: [1.6, '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v5h-5"/>'],
    collapse: [1.6, '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 12h8"/>'],
    chev: [1.8, '<path d="M15 6l-6 6 6 6"/>'],
    left: [1.6, '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>'],
    leftOn: [1.6, '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><rect x="3.8" y="4.8" width="4.4" height="14.4" fill="currentColor" stroke="none"/>'],
    bottom: [1.6, '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 14h18"/>'],
    bottomOn: [1.6, '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 14h18"/><rect x="3.8" y="14.8" width="16.4" height="4.4" fill="currentColor" stroke="none"/>'],
    right: [1.6, '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>'],
    rightOn: [1.6, '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/><rect x="15.8" y="4.8" width="4.4" height="14.4" fill="currentColor" stroke="none"/>'],
    history: [1.8, '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3 4v4h4"/><path d="M12 7.5V12l3 2"/>'],
    x: [2, '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'],
    chevronRight: [2, '<path d="m9 18 6-6-6-6"/>'],
    chevronDown: [2, '<path d="m6 9 6 6 6-6"/>'],
    backspace: [2, '<path d="M10 5a2 2 0 0 0-1.344.519l-6.328 5.74a1 1 0 0 0 0 1.481l6.328 5.741A2 2 0 0 0 10 19h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z"/><path d="m12 9 6 6"/><path d="m18 9-6 6"/>'],
    stop: [2, '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>'],
    send: [2, '<path d="M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z"/><path d="M6 12h16"/>'],
    eye: [2, '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>'],
    pencil: [2, '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>'],
    todo: [2, '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>'],
    columns: [1.7, '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>'],
    alert: [1.8, '<path d="M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'],
    gitBranch: [2, '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>'],
    circle: [2, '<circle cx="12" cy="12" r="9"/>'],
    circleDot: [2, '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor"/>'],
    up: [2, '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>'],
    down: [2, '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>'],
    plus: [2, '<path d="M5 12h14"/><path d="M12 5v14"/>'],
    play: [2, '<path d="M6 3l14 9-14 9z" fill="currentColor"/>'],
    check: [2, '<path d="M20 6 9 17l-5-5"/>'],
    minimize: [1.4, '<path d="M5 12h14"/>'],
    maximize: [1.4, '<rect x="5" y="5" width="14" height="14" rx="1"/>'],
    close: [1.4, '<path d="M6 6l12 12M18 6 6 18"/>'],
  };
  const icon = (name, size = 16) => {
    const [w, body] = LINE[name];
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  };

  /* ================= Project files (in memory) ================= */
  const LAUNCH = `{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "breeze-static",
      "runtimeExecutable": "python",
      "runtimeArgs": ["-m", "http.server", "5173", "--bind", "127.0.0.1", "--directory", "D:\\\\Project-B"],
      "port": 5173
    },
    {
      "name": "breeze-web",
      "runtimeExecutable": "python",
      "runtimeArgs": ["-m", "http.server", "5174", "--bind", "127.0.0.1", "--directory", "D:\\\\Demo-IDE"],
      "port": 5174
    }
  ]
}
`;
  const INDEX = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Tidal Coffee</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="top">
    <span class="name">Tidal Coffee</span>
    <span class="status" id="status">Open today</span>
  </header>
  <main>
    <h1>Slow coffee on the river.</h1>
    <p class="intro">A six-seat bar on Charoen Krung. We roast on Mondays and pour until the beans run out.</p>
    <ul class="menu">
      <li><span>Espresso</span><span>฿60</span></li>
      <li><span>Iced long black</span><span>฿75</span></li>
      <li><span>Thai tea latte</span><span>฿85</span></li>
      <li><span>Pour-over, single origin</span><span>฿120</span></li>
    </ul>
    <button class="order" id="order">Order ahead</button>
  </main>
  <script src="site.js"></script>
</body>
</html>
`;
  const SITE = `// Open 7:00 to 16:00, closed on Tuesdays.
const status = document.querySelector('#status');
const order = document.querySelector('#order');
const now = new Date();
const open = now.getDay() !== 2 && now.getHours() >= 7 && now.getHours() < 16;

status.textContent = open ? 'Open now' : 'Closed now';
status.classList.toggle('closed', !open);

order.addEventListener('click', () => {
  order.textContent = 'Ready in about 10 minutes';
  order.disabled = true;
});
`;
  const STYLES = `:root {
  --accent: #b4532a;
  --bg: #f4efe6;
  --text: #1f1b16;
  --muted: #7a7064;
  --line: #ddd3c4;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.6 system-ui, sans-serif;
}

.top {
  display: flex;
  justify-content: space-between;
  padding: 20px 32px;
  border-bottom: 1px solid var(--line);
  font-size: 13px;
}

.name {
  font-weight: 600;
}

.status {
  color: var(--accent);
}

.status.closed {
  color: var(--muted);
}

main {
  max-width: 440px;
  padding: 48px 32px;
}

h1 {
  margin: 0 0 12px;
  font: 400 40px/1.1 Georgia, serif;
}

.intro {
  margin: 0 0 32px;
  color: var(--muted);
}

.menu {
  margin: 0 0 32px;
  padding: 0;
  list-style: none;
}

.menu li {
  display: flex;
  justify-content: space-between;
  padding: 10px 0;
  border-top: 1px solid var(--line);
}

.order {
  padding: 10px 18px;
  border: 0;
  border-radius: 4px;
  background: var(--accent);
  color: var(--bg);
  font: inherit;
  cursor: pointer;
}
`;
  const files = new Map([
    ['.claude/launch.json', { text: LAUNCH }],
    ['.claude/settings.local.json', { text: '{\n  "permissions": {\n    "allow": ["Bash(python -m http.server:*)"]\n  }\n}\n' }],
    ['.git/HEAD', { text: 'ref: refs/heads/master\n' }],
    ['.git/config', { text: '[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = false\n' }],
    ['assets/icon.png', { image: `${ASSETS}brand/Icon.png` }],
    ['assets/city.png', { image: `${ASSETS}Background/pattayacityview.png` }],
    ['index.html', { text: '' }],
    ['site.js', { text: SITE }],
    ['styles.css', { text: '' }],
  ]);
  for (const f of files.values()) if ('text' in f) f.saved = f.text;
  const dirs = new Set(['.claude', '.git', 'assets']);
  const committed = new Map([['.git/HEAD', ''], ['.git/config', '']]); // checkpointed text, by path

  const isDirty = p => { const f = files.get(p); return !!f && 'text' in f && f.text !== f.saved; };
  function gitState(p) {
    if (p.startsWith('.git/')) return '';
    const f = files.get(p);
    if (!committed.has(p)) return 'U';
    return f.image || f.saved === committed.get(p) ? '' : 'M';
  }
  const changedFiles = () => [...files.keys()].filter(gitState).sort();

  /* ================= Highlighting (the app's lexers) ================= */
  const LANGS = { html: ['html', 'HTML'], css: ['css', 'CSS'], js: ['js', 'JavaScript'], mjs: ['js', 'JavaScript'], ts: ['js', 'TypeScript'], json: ['json', 'JSON'], md: ['md', 'Markdown'], py: ['py', 'Python'], png: ['', 'PNG Image'], jpg: ['', 'JPEG Image'] };
  const langOf = p => LANGS[extOf(p)] ?? ['', 'Plain Text'];
  const either = (...ps) => new RegExp(ps.map(p => p.source).join('|'));
  const lexer = rules => new RegExp(rules.map(([k, p]) => `(?<${k}>${p.source})`).join('|'), 'g');
  const keywords = list => new RegExp(String.raw`\b(?:${list.replaceAll(' ', '|')})\b`);
  const JS_KW = 'break case catch class const continue default delete do else export extends finally for from function if import in instanceof let new of return super switch this throw try typeof var void while yield async await static get set true false null undefined';
  const PY_KW = 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self';
  const LINE_COMMENT = /\/\/[^\n]*/;
  const BLOCK_COMMENT = /\/\*[\s\S]*?(?:\*\/|$)/;
  const QUOTED = /"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?/;
  const BACKTICKED = /`(?:\\[\s\S]|[^`\\])*`?/;
  const NUMBER = either(/\b0[xX][\da-fA-F]+\b/, /\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/);
  const LEXERS = {
    js: lexer([['com', either(LINE_COMMENT, BLOCK_COMMENT)], ['str', either(QUOTED, BACKTICKED)], ['num', NUMBER], ['kw', keywords(JS_KW)], ['prop', /\b[A-Za-z_$][\w$]*(?=\()/]]),
    css: lexer([['com', BLOCK_COMMENT], ['str', QUOTED], ['kw', /@[\w-]+|!important/], ['prop', /--?[A-Za-z_][\w-]*(?=\s*:)/], ['num', either(/#[\da-fA-F]{3,8}\b/, /-?\b\d+(?:\.\d+)?(?:%|[a-z]{1,3})?/)]]),
    json: lexer([['prop', /"(?:\\.|[^"\\\n])*"(?=\s*:)/], ['str', /"(?:\\.|[^"\\\n])*"?/], ['num', either(/-/, NUMBER)], ['kw', /\b(?:true|false|null)\b/]]),
    py: lexer([['com', /#[^\n]*/], ['str', either(/"""[\s\S]*?(?:"""|$)/, /'''[\s\S]*?(?:'''|$)/, QUOTED)], ['num', NUMBER], ['kw', keywords(PY_KW)], ['prop', /\b[A-Za-z_]\w*(?=\()/]]),
    md: lexer([['kw', /(?<=^|\n)#{1,6}[^\n]*/], ['str', either(/```[^`]*(?:```|$)/, /`[^`\n]*`/)], ['com', /(?<=^|\n)>[^\n]*/], ['attr', /\*\*[^*\n]+\*\*/]]),
    html: lexer([['com', /<!--[\s\S]*?(?:-->|$)/], ['tagblock', /<[!/]?[A-Za-z][^>]*>?/]]),
  };
  const HTML_TAG = lexer([['tag', /^<[!/]?[\w:-]+|\/?>$/], ['str', /"[^"]*"?|'[^']*'?/], ['attr', /[^\s="'<>/]+/]]);
  function lex(text, re) {
    const out = [];
    let last = 0;
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (!m[0]) { re.lastIndex++; continue; }
      if (m.index > last) out.push([null, text.slice(last, m.index)]);
      const kind = Object.keys(m.groups).find(k => m.groups[k] !== undefined) ?? null;
      if (kind === 'tagblock') out.push(...lex(m[0], HTML_TAG));
      else out.push([kind, m[0]]);
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push([null, text.slice(last)]);
    return out;
  }
  // CSS: plain text outside any { } block is a selector.
  function markSelectors(toks) {
    let depth = 0;
    const out = [];
    for (const [cls, text] of toks) {
      if (cls) { out.push([cls, text]); continue; }
      for (const part of text.split(/([{}])/)) {
        if (part === '{') depth++;
        else if (part === '}') depth = Math.max(0, depth - 1);
        out.push([depth === 0 && part !== '}' && part.trim() !== '' ? 'tag' : null, part]);
      }
    }
    return out;
  }
  function highlightLines(text, name) {
    if (!LEXERS[name]) return text.split('\n').map(esc);
    const lines = [''];
    const toks = lex(text, LEXERS[name]);
    for (const [cls, t] of name === 'css' ? markSelectors(toks) : toks) {
      t.split('\n').forEach((part, i) => {
        if (i > 0) lines.push('');
        if (part) lines[lines.length - 1] += cls ? `<span class="bz-tk-${cls}">${esc(part)}</span>` : esc(part);
      });
    }
    return lines;
  }
  const COMMENT = { js: ['// ', ''], py: ['# ', ''], css: ['/* ', ' */'], html: ['<!-- ', ' -->'], md: ['<!-- ', ' -->'] };

  /* ================= Window ================= */
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Interactive Breeze Code demo');
  root.innerHTML = `
  <div class="bz-ide" id="bzIde">
    <header class="bz-titlebar">
      <span class="bz-logo"><img src="${ASSETS}brand/BreezeCode.png" alt="Breeze Code" width="119" height="20"></span>
      <nav class="bz-menubar" aria-label="Application menu"></nav>
      <span class="bz-spacer"></span>
      <span class="bz-project">Demo-IDE</span>
      <span class="bz-spacer"></span>
      <button class="bz-sync" data-act="sync" title="Sync workspace">${icon('refresh', 14)}<span>Sync</span></button>
      <div class="bz-layout-btns">
        <button class="bz-icon-btn" data-act="view.toggleSide" title="Toggle Primary Side Bar (Ctrl+B)"></button>
        <button class="bz-icon-btn" data-act="term.toggle" title="Toggle Panel (Ctrl+\`)"></button>
        <button class="bz-icon-btn" data-act="view.toggleAgents" title="Toggle Agents (Ctrl+Alt+B)"></button>
      </div>
      <button class="bz-avatar" data-act="account" title="Account" aria-haspopup="menu">Y</button>
      <div class="bz-winbtns">
        <button class="bz-winbtn" data-act="win.min" title="Minimize">${icon('minimize', 14)}</button>
        <button class="bz-winbtn" data-act="win.max" title="Full screen">${icon('maximize', 13)}</button>
        <button class="bz-winbtn close" data-act="win.close" title="Close">${icon('close', 14)}</button>
      </div>
    </header>
    <div class="bz-main" id="bzMain">
      <nav class="bz-activity" aria-label="Views">
        <div class="bz-act-indicator"></div>
        <button class="bz-act-btn on" data-view="files" title="Explorer (Ctrl+Shift+E)">${icon('files', 20)}</button>
        <button class="bz-act-btn" data-view="search" title="Search (Ctrl+Shift+F)">${icon('search', 20)}</button>
        <button class="bz-act-btn" data-view="git" title="Checkpoints (Ctrl+Shift+G)">${icon('git', 20)}<span class="bz-badge"></span></button>
        <span class="bz-spacer"></span>
        <button class="bz-act-btn gear" data-act="settings" title="Settings" aria-haspopup="menu">${icon('gear', 20)}</button>
      </nav>
      <aside class="bz-sidebar" aria-label="Side bar">
        <div data-panel="files">
          <div class="bz-side-head"><span>Explorer</span><span class="bz-head-actions">
            <button class="bz-icon-btn" data-act="file.newFile" title="New File">${icon('newfile', 14)}</button>
            <button class="bz-icon-btn" data-act="file.newFolder" title="New Folder">${icon('newdir', 14)}</button>
            <button class="bz-icon-btn" data-act="explorer.collapse" title="Collapse Folders">${icon('collapse', 14)}</button>
            <button class="bz-icon-btn" data-act="view.toggleSide" title="Hide Side Bar">${icon('chev', 14)}</button>
          </span></div>
        </div>
        <div data-panel="search" class="bz-hidden">
          <div class="bz-side-head"><span>Search</span><span class="bz-head-actions"><button class="bz-icon-btn" data-act="view.toggleSide" title="Hide Side Bar">${icon('chev', 14)}</button></span></div>
          <div class="bz-search-box"><input class="bz-input" id="bzSearch" aria-label="Find in project" placeholder="Find in project" spellcheck="false" autocomplete="off"></div>
        </div>
        <div data-panel="git" class="bz-hidden">
          <div class="bz-side-head"><span>Source Control</span><span class="bz-head-actions"><button class="bz-icon-btn" data-act="view.toggleSide" title="Hide Side Bar">${icon('chev', 14)}</button></span></div>
        </div>
        <div class="bz-side-body" id="bzSideBody" tabindex="-1"></div>
      </aside>
      <section class="bz-center">
        <div class="bz-work no-preview" id="bzWork">
          <div class="bz-pane">
            <div class="bz-tabrow"><div class="bz-tabs" id="bzTabs" role="tablist"></div>
              <button class="bz-run-btn bz-hidden" id="bzRun" data-act="run.start" title="Preview this page (F5)">${icon('play', 12)}<span>Preview</span></button>
              <button class="bz-icon-btn bz-tab-split" data-act="editor.split" title="Split Editor Right (Ctrl+\\)">${icon('columns', 14)}</button></div>
            <div class="bz-editor" id="bzEditor">
              <div class="bz-gutter"><div></div></div>
              <div class="bz-code"><pre class="bz-hl" aria-hidden="true"><div></div></pre><textarea class="bz-ta" id="bzTa" spellcheck="false" autocomplete="off" autocapitalize="off" wrap="off" aria-label="Code editor"></textarea></div>
              <div class="bz-findbar bz-hidden">
                <input class="bz-input" id="bzFind" aria-label="Find in file" placeholder="Find" spellcheck="false" autocomplete="off">
                <span class="bz-find-count"></span>
                <button class="bz-icon-btn" data-act="find.prev" title="Previous (Shift+Enter)">${icon('up', 14)}</button>
                <button class="bz-icon-btn" data-act="find.next" title="Next (Enter)">${icon('down', 14)}</button>
                <button class="bz-icon-btn" data-act="find.close" title="Close (Escape)">${icon('x', 14)}</button>
              </div>
            </div>
            <div class="bz-image bz-hidden"><img alt=""></div>
            <div class="bz-empty bz-hidden" id="bzEmpty"><img src="${ASSETS}brand/Agent.png" alt="" width="64" height="64"><h4>No file open</h4>
              <div class="bz-keys-grid"><span>Go to file</span><kbd>Ctrl+P</kbd><span>New file</span><kbd>Ctrl+N</kbd><span>Search files</span><kbd>Ctrl+Shift+F</kbd><span>Terminal</span><kbd>Ctrl+\`</kbd></div></div>
          </div>
          <div class="bz-pane preview">
            <div class="bz-preview-bar"><span class="bz-preview-label">Preview</span>
              <span class="bz-url" data-act="preview.pages" role="button" tabindex="0" aria-haspopup="menu" title="Switch page">http://127.0.0.1:5173/index.html</span>
              <button class="bz-icon-btn" data-act="run.reload" title="Reload Preview">${icon('refresh', 13)}</button>
              <button class="bz-icon-btn" data-act="run.stop" title="Close Preview">${icon('x', 13)}</button></div>
            <iframe class="bz-preview-frame" title="Preview of index.html" sandbox="allow-scripts"></iframe>
          </div>
        </div>
        <div class="bz-terminal" id="bzTerm">
          <div class="bz-term-head" data-act="term.toggle">
            <span class="bz-term-title">${icon('chevronRight', 14)} Terminal</span>
            <button class="bz-icon-btn" data-act="term.new" title="New Terminal (Ctrl+Shift+\`)">${icon('plus', 13)}</button><span class="bz-spacer"></span>
            <button class="bz-icon-btn" data-act="term.clear" title="Clear">${icon('backspace', 15)}</button>
            <button class="bz-icon-btn" data-act="term.kill" title="Stop running command">${icon('stop', 13)}</button>
            <span>Ctrl+\`</span>
          </div>
          <div class="bz-term-body" id="bzTermBody">
            <div class="bz-term-out" id="bzTermOut"></div>
            <div class="bz-term-line"><span class="bz-ps">PS D:\\Demo-IDE&gt;</span><input id="bzTermIn" spellcheck="false" autocomplete="off" aria-label="Terminal input"></div>
          </div>
        </div>
      </section>
      <aside class="bz-agents" aria-label="Agents">
        <div class="bz-side-head"><span class="bz-agent-title">Agents<span class="bz-head-count bz-hidden" id="bzAgentCount"></span></span><span class="bz-head-actions bz-agent-tools">
          <div class="bz-agent-bar" id="bzAgentBar"></div>
          <button class="bz-icon-btn" data-act="chat.history" title="Chat history" aria-haspopup="menu">${icon('history', 14)}</button>
          <button class="bz-icon-btn flip" data-act="view.toggleAgents" title="Hide Agents">${icon('chev', 14)}</button>
        </span></div>
        <div class="bz-agent-tabs"><span class="bz-agent-tab" id="bzChatTab">Chat 1</span>
          <button class="bz-icon-btn" data-act="chat.new" title="New chat" aria-label="New chat">${icon('plus', 13)}</button></div>
        <div class="bz-agent-cards bz-hidden" id="bzCards"></div>
        <div class="bz-chat" id="bzChat" aria-live="polite"></div>
        <div class="bz-composer"><div class="bz-composer-box">
          <textarea id="bzPrompt" rows="1" aria-label="Message to the agent" placeholder="Describe what you want to build"></textarea>
          <button class="bz-btn bz-btn-primary bz-send" data-act="agent.send" title="Send (Enter)" aria-label="Send">${icon('send', 12)}</button>
        </div></div>
      </aside>
    </div>
    <footer class="bz-statusbar">
      <button class="bz-sb" data-act="branch" title="Branch">${icon('gitBranch', 14)}<span>master</span></button>
      <span class="bz-sb"><span class="bz-dot-ok"></span> Git ready · Node ready · Python ready</span>
      <span class="bz-spacer"></span>
      <button class="bz-sb" data-act="editor.focus" id="bzPos">Ln 1, Col 1</button>
      <span class="bz-sb" id="bzLang">Plain Text</span>
      <span class="bz-sb">UTF-8</span>
      <button class="bz-sb" data-act="account">Not signed in</button>
    </footer>
    <div class="bz-toasts" aria-live="polite"></div>
  </div>`;

  const $ = sel => root.querySelector(sel);
  const $$ = sel => [...root.querySelectorAll(sel)];
  const ide = $('#bzIde');
  const main = $('#bzMain');
  const work = $('#bzWork');
  const ta = $('#bzTa');
  const hlInner = $('.bz-hl > div');
  const gutterInner = $('.bz-gutter > div');
  const editorEl = $('#bzEditor');
  const imageView = $('.bz-image');
  const emptyView = $('#bzEmpty');
  const tabsEl = $('#bzTabs');
  const sideBody = $('#bzSideBody');
  const term = $('#bzTerm');
  const termOut = $('#bzTermOut');
  const termIn = $('#bzTermIn');
  const termBody = $('#bzTermBody');
  const chat = $('#bzChat');
  const promptEl = $('#bzPrompt');
  let frame = $('.bz-preview-frame');
  const runBtn = $('#bzRun');

  /* ----- fit the desktop-sized window into the frame ----- */
  let scale = 1;
  function fit() {
    const w = root.clientWidth, h = root.clientHeight;
    if (!w || !h) return;
    scale = Math.min(1, w / MIN_W);
    ide.style.width = `${w / scale}px`;
    ide.style.height = `${h / scale}px`;
    ide.style.transform = scale < 1 ? `scale(${scale})` : '';
  }
  fit();
  new ResizeObserver(fit).observe(root);
  // Screen position → window coordinates (the frame itself may also be scaled by the page).
  function toIde(x, y) {
    const r = ide.getBoundingClientRect();
    const k = r.width / ide.offsetWidth;
    return [(x - r.left) / k, (y - r.top) / k];
  }

  /* ================= State ================= */
  const layout = { side: true, agents: false, term: false, preview: false, view: 'files' };
  const openDirs = new Set();
  let selected = 'index.html';
  let tabs = ['index.html', 'styles.css'];
  let active = 'index.html';
  const views = new Map(); // path -> { sel, top, left }
  const added = new Map(); // path -> Set of line numbers the agent just wrote
  let pending = null; // inline name box in the explorer: { kind: 'file' | 'dir' | 'rename', parent, path }

  /* ================= Toasts, menus, modal ================= */
  const toasts = $('.bz-toasts');
  function toast(html, ms = 3200) {
    const t = document.createElement('div');
    t.className = 'bz-toast';
    t.innerHTML = html;
    toasts.append(t);
    sfx.play('ping');
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 250); }, ms);
  }
  const DOWNLOAD = 'https://github.com/itsphatto/BreezeCode/releases/latest';
  const desktopOnly = what => toast(`${what} lives in the desktop app. <a href="${DOWNLOAD}" target="_blank" rel="noopener">Grab Breeze Code</a>`, 4200);

  let menu = null;
  function closeMenu() {
    cancelHoverClose();
    if (!menu) return;
    menu.el.remove();
    menu.anchor?.classList.remove('open');
    menu = null;
  }
  // A hover-opened menu closes shortly after the pointer leaves both its button and the list.
  let hoverTimer = 0;
  function cancelHoverClose() { clearTimeout(hoverTimer); }
  function hoverClose() {
    cancelHoverClose();
    hoverTimer = setTimeout(() => { if (menu?.hover) closeMenu(); }, 160);
  }
  // items: { label, icon, key, run, checked, disabled, sep, href }; hover: opened by hovering rather than clicking;
  // keepFocus: typing carries on in the anchor (the @ mention list)
  function openMenu(items, anchor, at, hover = false, keepFocus = false) {
    closeMenu();
    sfx.play('menu');
    const el = document.createElement('div');
    el.className = 'bz-menu';
    el.setAttribute('role', 'menu');
    for (const it of items) {
      if (it.sep) { el.insertAdjacentHTML('beforeend', '<div class="bz-menu-sep"></div>'); continue; }
      const b = document.createElement('button');
      b.className = `bz-menu-item${it.checked ? ' checked' : ''}`;
      b.setAttribute('role', 'menuitem');
      b.disabled = !!it.disabled;
      b.innerHTML = `${it.icon ?? ''}<span>${esc(it.label)}</span>${it.key ? `<span class="key">${esc(it.key)}</span>` : ''}`;
      b.addEventListener('click', () => {
        closeMenu();
        if (it.href) window.open(it.href, '_blank', 'noopener');
        else it.run?.();
      });
      el.append(b);
    }
    ide.append(el);
    let x, y;
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      [x, y] = toIde(r.left, r.bottom + 4);
      anchor.classList.add('open');
      if (at === 'up') {
        [x, y] = toIde(r.right + 6, r.bottom);
        y -= el.offsetHeight;
      } else if (at === 'above') {
        [x, y] = toIde(r.left, r.top - 6);
        y -= el.offsetHeight;
      } else if (at === 'right') {
        const [rx] = toIde(r.right, 0);
        x = rx - el.offsetWidth;
      }
    } else [x, y] = at;
    x = Math.max(4, Math.min(x, ide.offsetWidth - el.offsetWidth - 4));
    y = Math.max(4, Math.min(y, ide.offsetHeight - el.offsetHeight - 4));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    menu = { el, anchor, items, hover };
    el.addEventListener('pointerenter', cancelHoverClose);
    el.addEventListener('pointerleave', hoverClose);
    if (!keepFocus) el.querySelector('.bz-menu-item:not(:disabled)')?.focus({ preventScroll: true });
  }
  document.addEventListener('pointerdown', e => {
    if (menu && !menu.el.contains(e.target) && !menu.anchor?.contains(e.target)) closeMenu();
  });

  function modal(html) {
    const back = document.createElement('div');
    back.className = 'bz-modal-back';
    back.innerHTML = `<div class="bz-modal" role="dialog" aria-modal="true">${html}<button class="bz-btn bz-btn-primary" data-close>Got it</button></div>`;
    const close = () => back.remove();
    back.addEventListener('click', e => { if (e.target === back || e.target.closest('[data-close]')) close(); });
    back.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    ide.append(back);
    back.querySelector('[data-close]').focus({ preventScroll: true });
  }
  const SHORTCUTS = [
    ['Save', 'Ctrl+S'], ['Find', 'Ctrl+F'], ['Toggle line comment', 'Ctrl+/'], ['Move line up / down', 'Alt+↑ / Alt+↓'],
    ['Copy line down', 'Shift+Alt+↓'], ['Select line', 'Ctrl+L'], ['Toggle side bar', 'Ctrl+B'], ['Toggle terminal', 'Ctrl+`'],
    ['Toggle agents', 'Ctrl+Alt+B'], ['Explorer / Search / Checkpoints', 'Ctrl+Shift+E / F / G'], ['Preview the site', 'F5'],
  ];

  /* ================= Menu bar ================= */
  const hasFile = () => !!active && 'text' in (files.get(active) ?? {});
  const MENUS = [
    ['File', () => [
      { label: 'New File…', run: () => cmd('file.newFile') },
      { label: 'New Folder…', run: () => cmd('file.newFolder') },
      { sep: true },
      { label: 'Open Folder…', key: 'Ctrl+O', run: () => desktopOnly('Opening folders') },
      { sep: true },
      { label: 'Save', key: 'Ctrl+S', run: () => cmd('file.save'), disabled: !hasFile() },
      { label: 'Save All', run: () => cmd('file.saveAll'), disabled: ![...files.keys()].some(isDirty) },
      { sep: true },
      { label: 'Close Editor', run: () => active && closeTab(active), disabled: !active },
      { sep: true },
      { label: 'Exit', run: () => cmd('win.close') },
    ]],
    ['Edit', () => [
      { label: 'Undo', key: 'Ctrl+Z', run: () => editCmd('undo'), disabled: !hasFile() },
      { label: 'Redo', key: 'Ctrl+Y', run: () => editCmd('redo'), disabled: !hasFile() },
      { sep: true },
      { label: 'Cut', key: 'Ctrl+X', run: () => editCmd('cut'), disabled: !hasFile() },
      { label: 'Copy', key: 'Ctrl+C', run: () => editCmd('copy'), disabled: !hasFile() },
      { label: 'Paste', key: 'Ctrl+V', run: () => editCmd('paste'), disabled: !hasFile() },
      { sep: true },
      { label: 'Find', key: 'Ctrl+F', run: () => cmd('edit.find'), disabled: !hasFile() },
      { label: 'Find in Files', key: 'Ctrl+Shift+F', run: () => cmd('view.search') },
      { sep: true },
      { label: 'Toggle Line Comment', key: 'Ctrl+/', run: () => cmd('edit.comment'), disabled: !hasFile() },
    ]],
    ['Selection', () => [
      { label: 'Select All', key: 'Ctrl+A', run: () => { focusEditor(); ta.select(); onCaret(); }, disabled: !hasFile() },
      { label: 'Select Line', key: 'Ctrl+L', run: () => cmd('sel.line'), disabled: !hasFile() },
      { sep: true },
      { label: 'Copy Line Down', key: 'Shift+Alt+Down', run: () => cmd('sel.dup'), disabled: !hasFile() },
      { label: 'Move Line Up', key: 'Alt+Up', run: () => cmd('sel.up'), disabled: !hasFile() },
      { label: 'Move Line Down', key: 'Alt+Down', run: () => cmd('sel.down'), disabled: !hasFile() },
    ]],
    ['View', () => [
      { label: 'Explorer', key: 'Ctrl+Shift+E', run: () => cmd('view.files') },
      { label: 'Search', key: 'Ctrl+Shift+F', run: () => cmd('view.search') },
      { label: 'Checkpoints', key: 'Ctrl+Shift+G', run: () => cmd('view.git') },
      { sep: true },
      { label: 'Primary Side Bar', key: 'Ctrl+B', checked: layout.side, run: () => cmd('view.toggleSide') },
      { label: 'Agents Panel', key: 'Ctrl+Alt+B', checked: layout.agents, run: () => cmd('view.toggleAgents') },
      { label: 'Terminal', key: 'Ctrl+`', checked: layout.term, run: () => cmd('term.toggle') },
      { label: 'Preview', key: 'F5', checked: layout.preview, run: () => cmd(layout.preview ? 'run.stop' : 'run.start') },
      { label: 'Reset Layout', run: () => cmd('view.reset') },
    ]],
    ['Terminal', () => [
      { label: 'Focus Terminal', run: () => cmd('term.focus') },
      { label: 'Toggle Terminal', key: 'Ctrl+`', run: () => cmd('term.toggle') },
      { sep: true },
      { label: 'Clear Terminal', run: () => cmd('term.clear') },
      { label: 'Run Preview Server', key: 'F5', run: () => cmd('run.start') },
      { label: 'Stop Preview Server', run: () => cmd('run.stop'), disabled: !layout.preview },
    ]],
  ];
  const menubar = $('.bz-menubar');
  for (const [name, build] of MENUS) {
    const b = document.createElement('button');
    b.className = 'bz-menu-top';
    b.textContent = name;
    b.setAttribute('aria-haspopup', 'menu');
    // Hovering opens the menu and leaving closes it. A click pins it open; the next click closes it.
    b.addEventListener('click', () => {
      if (menu?.anchor !== b) openMenu(build(), b, undefined, false);
      else if (menu.hover) menu.hover = false;
      else closeMenu();
    });
    b.addEventListener('pointerenter', e => {
      if (e.pointerType === 'touch') return;
      cancelHoverClose();
      if (menu?.anchor === b || (menu && !menu.hover && !menu.anchor?.classList.contains('bz-menu-top'))) return;
      // A menu pinned open by a click follows the pointer along the bar; otherwise this is a hover menu.
      openMenu(build(), b, undefined, !menu || menu.hover);
    });
    b.addEventListener('pointerleave', hoverClose);
    menubar.append(b);
  }

  /* ================= Layout ================= */
  function applyLayout() {
    main.classList.toggle('no-side', !layout.side);
    main.classList.toggle('no-agents', !layout.agents);
    work.classList.toggle('no-preview', !layout.preview);
    term.classList.toggle('open', layout.term);
    const [s, t, a] = $$('.bz-layout-btns button');
    s.innerHTML = icon(layout.side ? 'leftOn' : 'left');
    t.innerHTML = icon(layout.term ? 'bottomOn' : 'bottom');
    a.innerHTML = icon(layout.agents ? 'rightOn' : 'right');
    $$('.bz-act-btn[data-view]').forEach(b => b.classList.toggle('on', layout.side && b.dataset.view === layout.view));
    const on = $(`.bz-act-btn[data-view="${layout.view}"]`);
    const ind = $('.bz-act-indicator');
    ind.style.opacity = layout.side ? '1' : '0';
    ind.style.transform = `translateY(${on.offsetTop + 8}px)`;
    $$('[data-panel]').forEach(p => p.classList.toggle('bz-hidden', p.dataset.panel !== layout.view));
    runBtn.classList.toggle('bz-btn-primary', !layout.preview);
    updateTour();
  }
  function showView(v) {
    if (layout.side && layout.view === v) { layout.side = false; applyLayout(); return; }
    layout.side = true;
    layout.view = v;
    applyLayout();
    renderSide();
    if (v === 'search') $('#bzSearch').focus({ preventScroll: true });
  }

  /* ================= Explorer ================= */
  function childrenOf(dir) {
    const pre = dir ? `${dir}/` : '';
    const subdirs = [...dirs].filter(d => d.startsWith(pre) && !d.slice(pre.length).includes('/'));
    const own = [...files.keys()].filter(p => p.startsWith(pre) && !p.slice(pre.length).includes('/'));
    const byName = (a, b) => baseName(a).localeCompare(baseName(b));
    return [...subdirs.sort(byName), ...own.sort(byName)];
  }
  const dirChanged = d => [...files.keys()].some(p => p.startsWith(`${d}/`) && gitState(p));
  function nameBox(depth, value) {
    return `<div class="bz-tree-item" style="padding-left:${4 + depth * 12}px"><span class="bz-chev none">${CHEV}</span><span class="bz-ico">${pending.kind === 'dir' ? folderIcon('', false) : fileIcon(value || 'file')}</span><input class="bz-tree-input" value="${esc(value)}" aria-label="Name" spellcheck="false" autocomplete="off"></div>`;
  }
  function treeHtml(dir, depth) {
    let html = '';
    if (pending && pending.kind !== 'rename' && pending.parent === dir) html += nameBox(depth, '');
    for (const p of childrenOf(dir)) {
      const isDir = dirs.has(p);
      if (pending?.kind === 'rename' && pending.path === p) { html += nameBox(depth, baseName(p)); continue; }
      const st = isDir ? '' : gitState(p);
      const cls = ['bz-tree-item', selected === p ? 'on' : '', st ? `bz-git-${st.toLowerCase()}` : '', isDir && dirChanged(p) ? 'bz-dot' : ''].join(' ');
      const open = openDirs.has(p);
      html += `<button class="${cls}" data-path="${esc(p)}" style="padding-left:${4 + depth * 12}px" ${isDir ? `aria-expanded="${open}"` : ''}>`
        + `<span class="bz-chev ${isDir ? (open ? 'open' : '') : 'none'}">${CHEV}</span>`
        + `<span class="bz-ico">${isDir ? folderIcon(baseName(p), open) : fileIcon(baseName(p))}</span>`
        + `<span class="bz-nm">${esc(baseName(p))}${isDirty(p) ? ' ●' : ''}</span>${st ? `<span class="bz-gst">${st}</span>` : ''}</button>`;
      if (isDir && open) html += treeHtml(p, depth + 1);
    }
    return html;
  }
  function renderTree() {
    sideBody.innerHTML = treeHtml('', 0);
    const box = sideBody.querySelector('.bz-tree-input');
    if (!box) return;
    box.focus({ preventScroll: true });
    if (pending.kind === 'rename') box.setSelectionRange(0, box.value.includes('.') ? box.value.lastIndexOf('.') : box.value.length);
    let done = false;
    const finish = ok => {
      if (done) return;
      done = true;
      const name = box.value.trim();
      const p = pending;
      pending = null;
      if (ok && name) {
        if (/[\\/:*?"<>|]/.test(name)) toast(`A name can't contain \\ / : * ? " < > |`);
        else if (p.kind === 'rename') renameEntry(p.path, name);
        else createEntry(p.kind, p.parent ? `${p.parent}/${name}` : name);
      }
      renderTree();
    };
    box.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    box.addEventListener('blur', () => finish(true));
  }
  function createEntry(kind, path) {
    if (files.has(path) || dirs.has(path)) { toast(`<b>${esc(baseName(path))}</b> already exists here.`); return; }
    if (kind === 'dir') { dirs.add(path); openDirs.add(path); selected = path; return; }
    files.set(path, { text: '', saved: '' });
    selected = path;
    openFile(path, true);
    renderBadge();
  }
  function renameEntry(from, name) {
    const to = dirName(from) ? `${dirName(from)}/${name}` : name;
    if (to === from) return;
    if (files.has(to) || dirs.has(to)) { toast(`<b>${esc(name)}</b> already exists here.`); return; }
    const move = p => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);
    for (const [p, f] of [...files]) if (move(p) !== p) { files.delete(p); files.set(move(p), f); }
    for (const d of [...dirs]) if (move(d) !== d) { dirs.delete(d); dirs.add(move(d)); }
    for (const m of [views, added, committed]) for (const [p, v] of [...m]) if (move(p) !== p) { m.delete(p); m.set(move(p), v); }
    tabs = tabs.map(move);
    if (active) active = move(active);
    selected = move(selected);
    renderTabs();
    renderEditor();
    renderBadge();
  }
  function deleteEntry(path) {
    const gone = p => p === path || p.startsWith(`${path}/`);
    for (const p of [...files.keys()]) if (gone(p)) files.delete(p);
    for (const d of [...dirs]) if (gone(d)) dirs.delete(d);
    for (const p of tabs.filter(gone)) closeTab(p);
    renderTree();
    renderBadge();
    toast(`Deleted <b>${esc(baseName(path))}</b>`);
  }
  sideBody.addEventListener('click', e => {
    const item = e.target.closest('.bz-tree-item[data-path]');
    if (item) {
      const p = item.dataset.path;
      selected = p;
      if (dirs.has(p)) { openDirs.has(p) ? openDirs.delete(p) : openDirs.add(p); renderTree(); }
      else openFile(p);
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) openFile(open.dataset.open, false, open.dataset.at && JSON.parse(open.dataset.at));
  });
  sideBody.addEventListener('contextmenu', e => {
    const item = e.target.closest('.bz-tree-item[data-path]');
    if (!item || layout.view !== 'files') return;
    e.preventDefault();
    const p = item.dataset.path;
    selected = p;
    renderTree();
    const parent = dirs.has(p) ? p : dirName(p);
    openMenu([
      { label: 'New File…', run: () => { pending = { kind: 'file', parent }; openDirs.add(parent); renderTree(); } },
      { label: 'New Folder…', run: () => { pending = { kind: 'dir', parent }; openDirs.add(parent); renderTree(); } },
      { sep: true },
      { label: 'Rename…', key: 'F2', run: () => { pending = { kind: 'rename', path: p }; renderTree(); } },
      { label: 'Delete', key: 'Del', run: () => deleteEntry(p) },
    ], null, toIde(e.clientX, e.clientY));
  });

  /* ================= Search ================= */
  let searchTimer = 0;
  function renderSearch() {
    const q = $('#bzSearch').value;
    if (!q) { sideBody.innerHTML = '<p class="bz-side-note">Type to search across every file in the project.</p>'; return; }
    const lower = q.toLowerCase();
    let html = '', total = 0;
    for (const [p, f] of [...files].sort()) {
      if (!('text' in f) || p.startsWith('.git/')) continue;
      const hits = [];
      f.text.split('\n').forEach((line, i) => {
        const at = line.toLowerCase().indexOf(lower);
        if (at >= 0) hits.push([i, at, line]);
      });
      if (!hits.length) continue;
      total += hits.length;
      html += `<div class="bz-result-file"><span class="bz-ico">${fileIcon(baseName(p))}</span>${esc(baseName(p))} <small>${esc(dirName(p))}</small></div>`;
      for (const [i, at, line] of hits.slice(0, 40)) {
        const from = Math.max(0, at - 18);
        html += `<button class="bz-hit" data-open="${esc(p)}" data-at="[${i},${at},${q.length}]">${from ? '…' : ''}${esc(line.slice(from, at).trimStart())}<mark>${esc(line.slice(at, at + q.length))}</mark>${esc(line.slice(at + q.length))}</button>`;
      }
    }
    sideBody.innerHTML = total ? `<p class="bz-side-note">${total} result${total === 1 ? '' : 's'}</p>${html}` : `<p class="bz-side-note">No results for “${esc(q)}”.</p>`;
  }
  $('#bzSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderSearch, 120); });

  /* ================= Checkpoints (source control) ================= */
  let lastCheckpoint = null;
  const checkpoints = []; // newest first, for the graph
  let draftMsg = ''; // the checkpoint message survives the panel re-rendering
  let pushing = false;
  const scmClosed = new Set(); // sections folded shut
  // As in the app: a message box with Commit & Push, then Changes and the Checkpoints graph, each folding by its header.
  function renderScm() {
    const list = changedFiles();
    const rows = list.map(p => {
      const st = gitState(p);
      return `<div class="bz-scm-row bz-git-${st.toLowerCase()}" data-open="${esc(p)}" title="${esc(p)} · ${st === 'U' ? 'Untracked' : 'Modified'}"><span class="bz-ico">${fileIcon(baseName(p))}</span><span class="bz-nm">${esc(baseName(p))}</span><span class="bz-dir">${esc(dirName(p))}</span><span class="bz-st">${st}</span></div>`;
    }).join('');
    const dot = (i, n) => `<svg width="32" height="36" fill="none" stroke="#7aa9ff" stroke-width="2" stroke-linecap="round" aria-hidden="true">${i ? '<path d="M10 1V18"/>' : ''}${i < n - 1 ? '<path d="M10 18V36"/>' : ''}<circle cx="10" cy="18" r="5" fill="#7aa9ff"/></svg>`;
    const graph = checkpoints.map((c, i) => `<div class="bz-commit" title="${esc(c.msg)} (${c.hash})">${dot(i, checkpoints.length)}<div class="bz-msgline"><div>${i ? '' : '<span class="bz-ref head">master</span>'}${c.pushed && c === checkpoints.find(x => x.pushed) ? '<span class="bz-ref remote">origin/master</span>' : ''}<span class="bz-subj">${esc(c.msg)}</span></div><small>You · ${agoOf(c.at)}</small></div></div>`).join('');
    const sec = (key, title, count, body) => `<div class="bz-scm-sec${scmClosed.has(key) ? ' closed' : ''}" data-sec="${key}"><div class="bz-scm-head" role="button" tabindex="0" aria-expanded="${!scmClosed.has(key)}"><span class="bz-chev">${CHEV}</span><span class="title">${title}</span><span class="count">${count}</span></div><div class="bz-scm-list">${body}</div></div>`;
    sideBody.innerHTML = `<div class="bz-scm">
      <div class="bz-commit-box">
        <textarea class="bz-input" id="bzCommitMsg" rows="1" placeholder="Message (Ctrl+Enter to commit on ‘master’)" aria-label="Commit message" spellcheck="false" autocomplete="off">${esc(draftMsg)}</textarea>
        <button class="bz-btn bz-btn-primary bz-btn-sm" data-act="git.commit" ${list.length && !pushing ? '' : 'disabled'}>${pushing ? 'Pushing…' : 'Commit &amp; Push'}</button>
      </div>
      ${sec('changes', 'Changes', list.length, rows || '<p class="bz-side-note">No changes since the last checkpoint.</p>')}
      ${checkpoints.length ? sec('graph', 'Checkpoints', checkpoints.length, graph) : ''}
    </div>`;
    const msgEl = $('#bzCommitMsg');
    msgEl.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); cmd('git.commit'); } });
    msgEl.addEventListener('input', () => { draftMsg = msgEl.value; updateTour(); });
  }
  const agoOf = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : `${plural(m, 'minute')} ago`; };
  sideBody.addEventListener('click', e => {
    const head = e.target.closest('.bz-scm-head');
    if (!head) return;
    const key = head.parentElement.dataset.sec;
    if (!scmClosed.delete(key)) scmClosed.add(key);
    renderScm();
  });
  sideBody.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('.bz-scm-head')) { e.preventDefault(); e.target.click(); } });
  function commit() {
    const list = changedFiles();
    if (!list.length) return;
    sfx.play('save');
    const typed = $('#bzCommitMsg')?.value.trim();
    // During the tour the visitor writes the message themselves.
    if (!typed && tourStep) { $('#bzCommitMsg')?.focus({ preventScroll: true }); toast('Write a short message first, like <b>Coffee menu in dark mode</b>.'); return; }
    const msg = typed || 'Update site';
    draftMsg = '';
    for (const p of list) committed.set(p, files.get(p).saved ?? '');
    lastCheckpoint = { msg, count: list.length, hash: Math.random().toString(16).slice(2, 9), at: Date.now() };
    checkpoints.unshift(lastCheckpoint);
    if (tourStep === 'commit') tourOff = true; // the tour ends on the commit
    renderSide();
    renderBadge();
    renderTabs();
    updateTour();
    push(); // Commit & Push, in one click as in the app
  }
  async function push() {
    if (!lastCheckpoint || lastCheckpoint.pushed || pushing) return;
    pushing = true;
    sfx.play('launch');
    renderSide();
    await sleep(900);
    lastCheckpoint.pushed = true;
    pushing = false;
    sfx.play('success');
    renderSide();
    toast(`${icon('check', 14)} Committed and pushed · ${plural(lastCheckpoint.count, 'file')}`);
  }

  function renderSide() {
    if (layout.view === 'files') renderTree();
    else if (layout.view === 'search') renderSearch();
    else renderScm();
  }
  function renderBadge() {
    const n = changedFiles().length;
    const b = $('.bz-badge');
    b.textContent = n;
    b.classList.toggle('bz-hidden', !n);
  }

  /* ================= Tabs & editor ================= */
  function renderTabs() {
    tabsEl.innerHTML = tabs.map(p => `<div class="bz-tab${p === active ? ' on' : ''}${isDirty(p) ? ' dirty' : ''}" role="tab" tabindex="0" aria-selected="${p === active}" data-tab="${esc(p)}" title="${esc(p)}"><span class="bz-ico">${fileIcon(baseName(p))}</span><span class="bz-nm">${esc(baseName(p))}</span><span class="bz-x" data-close="1" title="Close">${icon('x', 12)}</span></div>`).join('');
    // Only the tab strip scrolls: scrollIntoView would also scroll the whole page down to the demo.
    const on = tabsEl.querySelector('.bz-tab.on');
    if (on) {
      if (on.offsetLeft < tabsEl.scrollLeft) tabsEl.scrollLeft = on.offsetLeft;
      else if (on.offsetLeft + on.offsetWidth > tabsEl.scrollLeft + tabsEl.clientWidth) tabsEl.scrollLeft = on.offsetLeft + on.offsetWidth - tabsEl.clientWidth;
    }
    // Only the page itself can be previewed, so the button shows on index.html alone.
    runBtn.classList.toggle('bz-hidden', active !== 'index.html');
    updateTour();
  }
  tabsEl.addEventListener('click', e => {
    const t = e.target.closest('.bz-tab');
    if (!t) return;
    if (e.target.closest('[data-close]')) closeTab(t.dataset.tab);
    else openFile(t.dataset.tab);
  });
  tabsEl.addEventListener('auxclick', e => { const t = e.target.closest('.bz-tab'); if (t && e.button === 1) closeTab(t.dataset.tab); });
  tabsEl.addEventListener('keydown', e => { const t = e.target.closest('.bz-tab'); if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openFile(t.dataset.tab, true); } });

  function saveView() {
    if (active && hasFile()) views.set(active, { sel: [ta.selectionStart, ta.selectionEnd], top: ta.scrollTop, left: ta.scrollLeft });
  }
  function openFile(path, focus = false, at = null) {
    if (!files.has(path)) return;
    saveView();
    if (!tabs.includes(path)) {
      const i = tabs.indexOf(active);
      tabs.splice(i < 0 ? tabs.length : i + 1, 0, path);
    }
    active = path;
    selected = path;
    sfx.play('tab');
    renderTabs();
    tabsEl.querySelector('.bz-tab.on')?.classList.add('enter');
    renderEditor();
    if (layout.view === 'files') renderTree();
    if (at) {
      const lines = ta.value.split('\n');
      let pos = 0;
      for (let i = 0; i < at[0]; i++) pos += lines[i].length + 1;
      focusEditor();
      ta.setSelectionRange(pos + at[1], pos + at[1] + at[2]);
      revealLine(at[0]);
      onCaret();
    } else if (focus) focusEditor();
  }
  function closeTab(path) {
    if (path === active) saveView();
    const i = tabs.indexOf(path);
    if (i < 0) return;
    tabs.splice(i, 1);
    if (active === path) active = tabs[Math.min(i, tabs.length - 1)] ?? null;
    sfx.play('close');
    renderTabs();
    renderEditor();
  }
  const focusEditor = () => { if (hasFile()) ta.focus({ preventScroll: true }); };

  let charW = 7.8;
  function measure() {
    const probe = document.createElement('span');
    probe.textContent = 'x'.repeat(100);
    probe.style.cssText = 'position:absolute;visibility:hidden';
    hlInner.append(probe);
    charW = probe.getBoundingClientRect().width / 100 / (ide.getBoundingClientRect().width / ide.offsetWidth || 1) || charW;
    probe.remove();
  }

  function renderEditor() {
    const f = active && files.get(active);
    const text = !!f && 'text' in f;
    editorEl.classList.toggle('bz-hidden', !text);
    imageView.classList.toggle('bz-hidden', !f?.image);
    emptyView.classList.toggle('bz-hidden', !!f);
    if (f?.image) imageView.querySelector('img').src = f.image;
    $('#bzLang').textContent = f ? langOf(active)[1] : 'Plain Text';
    if (!text) { $('#bzPos').textContent = 'Ln 1, Col 1'; closeFind(); return; }
    if (ta.value !== f.text) ta.value = f.text;
    const v = views.get(active) ?? { sel: [0, 0], top: 0, left: 0 };
    ta.setSelectionRange(...v.sel);
    ta.scrollTop = v.top;
    ta.scrollLeft = v.left;
    paint();
    syncScroll();
    if (findOpen) runFind(false);
  }
  const caretLine = () => ta.value.slice(0, ta.selectionStart).split('\n').length - 1;
  function paint() {
    const lines = highlightLines(ta.value, langOf(active)[0]);
    const cur = caretLine();
    const marks = added.get(active);
    hlInner.innerHTML = lines.map((l, i) => `<div class="bz-ln${i === cur ? ' cur-line' : ''}${marks?.has(i) ? ' added' : ''}">${l || ' '}</div>`).join('') + hitsHtml();
    gutterInner.innerHTML = lines.map((_, i) => `<div${i === cur ? ' class="cur"' : ''}>${i + 1}</div>`).join('');
  }
  function onCaret() {
    const cur = caretLine();
    hlInner.querySelectorAll('.bz-ln').forEach((el, i) => el.classList.toggle('cur-line', i === cur));
    gutterInner.querySelectorAll('div').forEach((el, i) => el.classList.toggle('cur', i === cur));
    const col = ta.selectionStart - ta.value.lastIndexOf('\n', ta.selectionStart - 1);
    const n = ta.selectionEnd - ta.selectionStart;
    $('#bzPos').textContent = `Ln ${cur + 1}, Col ${col}${n ? ` (${n} selected)` : ''}`;
  }
  function syncScroll() {
    hlInner.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
    gutterInner.style.transform = `translateY(${-ta.scrollTop}px)`;
  }
  function revealLine(i) {
    const top = 10 + i * 21;
    if (top < ta.scrollTop + 21 || top > ta.scrollTop + ta.clientHeight - 42) ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
    syncScroll();
  }

  let previewTimer = 0;
  function onEdit() {
    const f = files.get(active);
    f.text = ta.value;
    added.delete(active);
    paint();
    onCaret();
    const tab = tabsEl.querySelector('.bz-tab.on');
    if (tab && tab.classList.contains('dirty') !== isDirty(active)) { renderTabs(); if (layout.view === 'files') renderTree(); }
    if (findOpen) runFind(false);
    if (layout.preview) { clearTimeout(previewTimer); previewTimer = setTimeout(refreshPreview, 350); }
  }
  ta.addEventListener('input', onEdit);
  ta.addEventListener('scroll', syncScroll);
  ['keyup', 'pointerup', 'select', 'focus'].forEach(t => ta.addEventListener(t, onCaret));
  document.addEventListener('selectionchange', () => { if (document.activeElement === ta) onCaret(); });

  // Text changes go through insertText so the browser's own undo stack keeps working.
  function replaceRange(from, to, text, selFrom, selTo) {
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(from, to);
    if (!document.execCommand('insertText', false, text)) { ta.setRangeText(text, from, to, 'end'); onEdit(); }
    if (selFrom != null) ta.setSelectionRange(selFrom, selTo ?? selFrom);
    onCaret();
  }
  function lineSpan() {
    const v = ta.value;
    const s = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    let e = v.indexOf('\n', ta.selectionEnd - (ta.selectionEnd > ta.selectionStart && v[ta.selectionEnd - 1] === '\n' ? 1 : 0));
    if (e < 0) e = v.length;
    return [s, e];
  }
  function toggleComment() {
    const [open, close] = COMMENT[langOf(active)[0]] ?? COMMENT.js;
    const [s, e] = lineSpan();
    const lines = ta.value.slice(s, e).split('\n');
    const on = lines.every(l => !l.trim() || l.trimStart().startsWith(open.trim()));
    const out = lines.map(l => {
      if (!l.trim()) return l;
      if (on) return l.replace(open.trim() + ' ', '').replace(open.trim(), '').replace(close.trim() ? new RegExp(`\\s?${close.trim().replace(/[*]/g, '\\*')}$`) : /$^/, '');
      const ind = l.match(/^\s*/)[0];
      return ind + open + l.slice(ind.length) + close;
    }).join('\n');
    replaceRange(s, e, out, s, s + out.length);
  }
  function moveLine(dir) {
    const v = ta.value;
    const [s, e] = lineSpan();
    if (dir < 0 && s === 0) return;
    if (dir > 0 && e >= v.length) return;
    const block = v.slice(s, e);
    const off = ta.selectionStart - s, len = ta.selectionEnd - ta.selectionStart;
    if (dir < 0) {
      const ps = v.lastIndexOf('\n', s - 2) + 1;
      const prev = v.slice(ps, s - 1);
      replaceRange(ps, e, `${block}\n${prev}`, ps + off, ps + off + len);
    } else {
      let ne = v.indexOf('\n', e + 1);
      if (ne < 0) ne = v.length;
      const next = v.slice(e + 1, ne);
      const at = s + next.length + 1;
      replaceRange(s, ne, `${next}\n${block}`, at + off, at + off + len);
    }
  }
  function dupLine() {
    const [s, e] = lineSpan();
    const block = ta.value.slice(s, e);
    const off = ta.selectionStart - s;
    replaceRange(e, e, `\n${block}`, e + 1 + off);
  }
  ta.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod && !e.altKey && (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter')) sfx.play('key');
    if (e.key === 'Tab' && !mod) {
      e.preventDefault();
      const [s, end] = lineSpan();
      if (e.shiftKey || ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n')) {
        const lines = ta.value.slice(s, end).split('\n');
        const out = lines.map(l => (e.shiftKey ? l.replace(/^ {1,2}/, '') : `  ${l}`)).join('\n');
        replaceRange(s, end, out, s, s + out.length);
      } else replaceRange(ta.selectionStart, ta.selectionEnd, '  ');
    } else if (e.key === 'Enter' && !mod && !e.shiftKey) {
      e.preventDefault();
      const before = ta.value.slice(ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1, ta.selectionStart);
      const ind = before.match(/^\s*/)[0];
      const opens = /[{[(]\s*$/.test(before) || /<(?!\/)[^>\/]*>\s*$/.test(before) && !/<(?:meta|link|br|img|input)\b/.test(before);
      const nextCh = ta.value[ta.selectionEnd];
      if (opens && /[}\])<]/.test(nextCh ?? '')) {
        const at = ta.selectionStart + 1 + ind.length + 2;
        replaceRange(ta.selectionStart, ta.selectionEnd, `\n${ind}  \n${ind}`, at);
      } else replaceRange(ta.selectionStart, ta.selectionEnd, `\n${ind}${opens ? '  ' : ''}`);
    } else if (e.altKey && !mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      if (e.shiftKey) dupLine();
      else moveLine(e.key === 'ArrowUp' ? -1 : 1);
    } else if (!mod && !e.altKey && PAIRS[e.key] && ta.selectionStart !== ta.selectionEnd) {
      e.preventDefault(); // wrap the selection
      const s = ta.selectionStart, en = ta.selectionEnd;
      replaceRange(s, en, e.key + ta.value.slice(s, en) + PAIRS[e.key], s + 1, en + 1);
    }
  });
  const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
  async function editCmd(what) {
    focusEditor();
    if (what === 'paste') {
      try { replaceRange(ta.selectionStart, ta.selectionEnd, await navigator.clipboard.readText()); }
      catch { toast('Press <b>Ctrl+V</b> to paste here.'); }
      return;
    }
    if (!document.execCommand(what)) toast(`Press <b>${{ undo: 'Ctrl+Z', redo: 'Ctrl+Y', cut: 'Ctrl+X', copy: 'Ctrl+C' }[what]}</b> instead.`);
  }

  /* ----- find in file ----- */
  let findOpen = false;
  let findHits = [];
  let findCur = -1;
  const findbar = $('.bz-findbar');
  const findIn = $('#bzFind');
  function openFind() {
    if (!hasFile()) return;
    findOpen = true;
    findbar.classList.remove('bz-hidden');
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    if (sel && !sel.includes('\n')) findIn.value = sel;
    findIn.focus({ preventScroll: true });
    findIn.select();
    runFind(false);
  }
  function closeFind() {
    if (!findOpen) return;
    findOpen = false;
    findHits = [];
    findbar.classList.add('bz-hidden');
    paint();
  }
  function hitsHtml() {
    if (!findOpen || !findHits.length) return '';
    if (!measured) { measure(); measured = true; }
    const lines = ta.value.split('\n');
    const starts = [];
    let pos = 0;
    for (const l of lines) { starts.push(pos); pos += l.length + 1; }
    const q = findIn.value.length;
    return findHits.map((at, k) => {
      let i = starts.length - 1;
      while (starts[i] > at) i--;
      const col = ta.value.slice(starts[i], at).replace(/\t/g, '    ').length;
      return `<i class="bz-hitbox${k === findCur ? ' cur' : ''}" style="top:${i * 21}px;left:${col * charW}px;width:${q * charW}px"></i>`;
    }).join('');
  }
  let measured = false;
  function runFind(step, back = false) {
    if (step) sfx.play('tick');
    const q = findIn.value.toLowerCase();
    findHits = [];
    if (q) { const t = ta.value.toLowerCase(); for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + q.length)) findHits.push(i); }
    if (!findHits.length) findCur = -1;
    else if (step) findCur = (findCur + (back ? -1 : 1) + findHits.length) % findHits.length;
    else findCur = Math.max(0, findHits.findIndex(h => h >= ta.selectionStart));
    $('.bz-find-count').textContent = q ? (findHits.length ? `${findCur + 1} of ${findHits.length}` : 'No results') : '';
    paint();
    if (findCur >= 0 && step) {
      ta.setSelectionRange(findHits[findCur], findHits[findCur] + q.length);
      revealLine(ta.value.slice(0, findHits[findCur]).split('\n').length - 1);
      paint();
      onCaret();
    }
  }
  findIn.addEventListener('input', () => runFind(false));
  findIn.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); runFind(true, e.shiftKey); }
    if (e.key === 'Escape') { e.preventDefault(); closeFind(); focusEditor(); }
  });

  /* ================= Preview ================= */
  // The sandboxed preview can't always fetch from the page's own server (browsers block a sandboxed page from
  // reaching localhost), so project images go in as small data URLs, made once and cached.
  const inlined = new Map();
  function inlineImage(url) {
    if (inlined.has(url)) return inlined.get(url);
    inlined.set(url, '');
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = Math.min(960, img.naturalWidth);
      c.height = Math.round((img.naturalHeight * c.width) / img.naturalWidth);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      inlined.set(url, c.toDataURL('image/jpeg', 0.82));
      if (layout.preview) refreshPreview();
    };
    img.src = url;
    return '';
  }
  function buildPage() {
    const read = p => files.get(p)?.text ?? '';
    if (!files.has('index.html')) return '<p style="font-family:sans-serif">index.html is missing.</p>';
    let html = read('index.html') || '<p style="margin:40vh 0 0;color:#8a8f98;font:14px system-ui,sans-serif;text-align:center">index.html is empty. Ask an agent to build something.</p>';
    html = html.replace(/<link[^>]*href="([^"]+\.css)"[^>]*>/g, (m, href) => (files.has(href) ? `<style>${read(href)}</style>` : m));
    html = html.replace(/src="([^"]+\.(?:png|jpe?g|svg))"/g, (m, src) => (files.get(src)?.image ? `src="${inlineImage(files.get(src).image)}"` : m));
    html = html.replace(/<script[^>]*src="([^"]+\.js)"[^>]*><\/script>/g, (m, src) => (files.has(src) ? `<script>${read(src).replace(/<\/script/gi, '<\\/script')}<\/script>` : m));
    return html;
  }
  // Each refresh loads into a hidden second frame and swaps it in once loaded, so the page never flashes blank
  // while an agent types. A newer refresh wins over one still loading.
  let nextFrame = null;
  function refreshPreview() {
    const next = frame.cloneNode(false);
    nextFrame = next;
    next.classList.add('loading');
    next.addEventListener('load', () => {
      if (next !== nextFrame) { next.remove(); return; }
      frame.remove();
      frame = next;
      next.classList.remove('loading');
    }, { once: true });
    next.srcdoc = buildPage();
    frame.after(next);
  }
  function startPreview() {
    if (layout.preview) { refreshPreview(); return; }
    layout.preview = true;
    sfx.play('launch');
    // Make room: the editor and the preview share the middle of the window.
    if (layout.agents && layout.side) layout.side = false;
    applyLayout();
    refreshPreview();
    termPrint('<span class="cmd">python -m http.server 5173 --bind 127.0.0.1</span>\nServing HTTP on 127.0.0.1 port 5173 (<span class="link">http://127.0.0.1:5173/</span>) ...\n');
  }
  function stopPreview() {
    if (!layout.preview) return;
    layout.preview = false;
    applyLayout();
    termPrint('Keyboard interrupt received, exiting.\n');
  }

  /* ================= Terminal ================= */
  const history = [];
  let histAt = 0;
  const termPrint = html => { termOut.insertAdjacentHTML('beforeend', html); termBody.scrollTop = termBody.scrollHeight; };
  const listing = dir => childrenOf(dir).map(p => (dirs.has(p) ? `<span class="link">${esc(baseName(p))}/</span>` : esc(baseName(p)))).join('   ');
  const resolve = arg => arg.replace(/^\.\//, '').replace(/\\/g, '/');
  const COMMANDS = {
    help: () => 'Try: ls, cat <file>, git status, git log, node -v, python --version, touch <file>, mkdir <dir>, rm <file>, echo, date, clear, or start to preview the site (F5).',
    ls: a => listing(resolve(a[0] ?? '').replace(/\/$/, '')),
    dir: a => COMMANDS.ls(a),
    pwd: () => 'D:\\Demo-IDE',
    cat: a => {
      const p = resolve(a[0] ?? '');
      const f = files.get(p);
      if (!f) return `<span class="err">cat : Cannot find path 'D:\\Demo-IDE\\${esc(a[0] ?? '')}' because it does not exist.</span>`;
      return f.image ? `<span class="err">${esc(p)} is an image. Open it from the Explorer.</span>` : esc(f.text);
    },
    type: a => COMMANDS.cat(a),
    echo: a => esc(a.join(' ')),
    date: () => new Date().toString(),
    whoami: () => 'breeze\\you',
    touch: a => { if (!a[0]) return '<span class="err">touch: missing file name</span>'; const p = resolve(a[0]); if (!files.has(p)) { files.set(p, { text: '', saved: '' }); renderSide(); renderBadge(); } return ''; },
    mkdir: a => { if (!a[0]) return '<span class="err">mkdir: missing folder name</span>'; dirs.add(resolve(a[0])); renderSide(); return ''; },
    rm: a => { const p = resolve(a[0] ?? ''); if (!files.has(p) && !dirs.has(p)) return `<span class="err">rm : Cannot find path '${esc(a[0] ?? '')}'.</span>`; deleteEntry(p); return ''; },
    node: a => (a[0] === '-v' || a[0] === '--version' ? 'v22.11.0' : a[0] ? `<span class="err">ReferenceError: document is not defined\n    at ${esc(a[0])}:2:16</span>\n(site.js runs in the page. Press F5 to preview it.)` : 'Welcome to Node.js v22.11.0.'),
    npm: a => (a[0] === '-v' || a[0] === '--version' ? '10.9.0' : `<span class="err">npm error Missing script: "${esc(a[1] ?? a[0] ?? '')}"</span>\n(This project is plain HTML. Press F5 to preview it.)`),
    python: a => {
      if (a[0] === '--version' || a[0] === '-V') return 'Python 3.13.1';
      if (a.join(' ').startsWith('-m http.server')) { setTimeout(startPreview); return ''; }
      return 'Python 3.13.1 (tags/v3.13.1) on win32';
    },
    py: a => COMMANDS.python(a),
    start: () => { setTimeout(startPreview); return ''; },
    git: a => {
      if (a[0] === 'status') {
        const list = changedFiles();
        if (!list.length) return 'On branch master\nnothing to commit, working tree clean';
        const un = list.filter(p => gitState(p) === 'U'), mod = list.filter(p => gitState(p) === 'M');
        return 'On branch master\n' + (mod.length ? `Changes not staged for commit:\n${mod.map(p => `\t<span class="err">modified:   ${esc(p)}</span>`).join('\n')}\n` : '') + (un.length ? `Untracked files:\n${un.map(p => `\t<span class="err">${esc(p)}</span>`).join('\n')}` : '');
      }
      if (a[0] === 'log') return lastCheckpoint ? `<span class="ok">commit ${lastCheckpoint.hash}</span> (HEAD -&gt; master)\n    ${esc(lastCheckpoint.msg)}` : 'fatal: your current branch \'master\' does not have any commits yet';
      if (a[0] === 'branch') return '* <span class="ok">master</span>';
      if (a[0] === 'push') { if (!lastCheckpoint) return 'error: src refspec master does not match any'; if (lastCheckpoint.pushed) return 'Everything up-to-date'; setTimeout(push); return ''; }
      if (a[0] === 'add' || a[0] === 'commit') return 'Use Checkpoints in the side bar (Ctrl+Shift+G) to save your work.';
      return 'usage: git status | log | branch | push';
    },
    code: () => "You're already in it.",
    breeze: () => `Get the full app: <span class="link">${DOWNLOAD}</span>`,
    exit: () => { setTimeout(() => cmd('term.toggle')); return ''; },
  };
  function runTerm(line) {
    termPrint(`<span class="bz-ps">PS D:\\Demo-IDE&gt;</span> <span class="cmd">${esc(line)}</span>\n`);
    const [name, ...args] = line.trim().split(/\s+/);
    if (!name) return;
    if (name === 'clear' || name === 'cls') { termOut.innerHTML = ''; return; }
    const fn = COMMANDS[name.toLowerCase()];
    const out = fn ? fn(args) : `<span class="err">${esc(name)} : The term '${esc(name)}' is not recognized as the name of a cmdlet, function, script file, or operable program.</span>\nType <span class="cmd">help</span> to see what this terminal can do.`;
    if (out) termPrint(`${out}\n`);
  }
  termIn.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const v = termIn.value;
      termIn.value = '';
      if (v.trim()) history.push(v);
      histAt = history.length;
      runTerm(v);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      histAt = Math.max(0, Math.min(history.length, histAt + (e.key === 'ArrowUp' ? -1 : 1)));
      termIn.value = history[histAt] ?? '';
    } else if (e.key === 'c' && e.ctrlKey && !termIn.value) {
      termPrint('^C\n');
    }
  });
  termBody.addEventListener('click', () => { if (!getSelection().toString()) termIn.focus({ preventScroll: true }); });
  termPrint('Breeze Code terminal · this one runs in your browser.\nType <span class="cmd">help</span> to see what it can do.\n');

  /* ================= Agents ================= */
  const AGENTS = ['Claude Code CLI', 'Codex', 'Antigravity', 'Ollama · qwen2.5-coder'];
  const AGENT_LOGOS = { 'Claude Code CLI': 'claude.svg', Codex: 'codex.png', Antigravity: 'antigravity.png', 'Ollama · qwen2.5-coder': 'ollama.svg' };
  let agentName = AGENTS[0];
  const logoOf = name => `<img src="${ASSETS}agents/${AGENT_LOGOS[name]}" alt="">`;
  const agentLogo = () => logoOf(agentName);
  // @mentions, as in the app (src/main/mentions.js): a short name, the full name or the id, longest first.
  const TEAM_AGENTS = [
    { name: 'Claude Code CLI', short: 'Claude', ids: ['claude'] },
    { name: 'Codex', short: 'Codex', ids: ['codex'] },
    { name: 'Antigravity', short: 'Antigravity', ids: ['antigravity'] },
    { name: 'Ollama · qwen2.5-coder', short: 'Ollama', ids: ['ollama', 'local'] },
  ];
  const shortOf = name => TEAM_AGENTS.find(a => a.name === name)?.short ?? name;
  const agentTag = name => `<span class="bz-agent-tag">${logoOf(name)}<b>${esc(shortOf(name))}</b></span>`;
  let busy = false;
  let building = false;
  let planCard = null; // the plan while it waits for approval
  let splitCard = null; // a team's "Who does what" while it waits for Start
  let restyled = false; // the visitor's own change has been built on top of the menu
  let menuMade = false; // index.html and styles.css start empty until an agent writes the coffee menu
  const cards = $('#bzCards');
  const roster = {};
  const STATUS = { idle: 'Idle', working: 'Working', waiting: 'Waiting for you', done: 'Done' };
  // `key` is a role (planner, builder, assistant), or a teammate's agent name with `mate` set.
  // As in the app, every card wears the name and logo of the agent doing the work, then its model, and a meter of its tool calls.
  function setAgent(key, status, task, mate = false) {
    roster[key] = { status, task, mate, used: roster[key]?.used ?? 0 };
    renderCards();
  }
  function renderCards() {
    cards.classList.toggle('bz-hidden', !Object.keys(roster).length);
    cards.innerHTML = Object.entries(roster).map(([k, a]) => {
      const who = a.mate ? k : agentName;
      const [name, model = name] = who.split(' · ');
      return `<div class="bz-agent ${a.status}"><span class="bz-ava">${logoOf(who)}</span><span class="name">${esc(name)}<small>${esc(model)}</small></span><span class="bz-status ${a.status}">${STATUS[a.status]}</span><span class="task">${esc(a.task)}</span><span class="meter" title="${plural(a.used, 'tool call')}"><i style="width:${Math.min(100, a.used * 4)}%"></i></span></div>`;
    }).join('');
    const n = Object.keys(roster).length;
    const count = $('#bzAgentCount');
    count.textContent = n;
    count.title = `${plural(n, 'agent')} on this task`;
    count.classList.toggle('bz-hidden', !n);
  }
  const clock = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  function addChat(html) {
    chat.querySelector('.bz-empty')?.remove();
    chat.insertAdjacentHTML('beforeend', html);
    chat.scrollTop = chat.scrollHeight;
    return chat.lastElementChild;
  }
  // Whoever answers signs with their own name and logo, whichever role they hold (as in the app).
  const say = (role, html) => (sfx.play('msg'), addChat(`<div class="bz-msg"><span class="bz-meta"><span class="bz-ava-mini">${agentLogo()}</span><b>${esc(agentName.split(' · ')[0])}</b>${clock()}</span><div class="bz-body">${html}</div></div>`));
  const mateSay = (name, html) => (sfx.play('msg'), addChat(`<div class="bz-msg"><span class="bz-meta"><span class="bz-ava-mini">${logoOf(name)}</span><b>${esc(shortOf(name))}</b>${clock()}</span><div class="bz-body">${html}</div></div>`));
  // shortcut: a tool call counts towards every working agent's meter, so teammates working at once share one count.
  const tool = (kind, ico, html) => {
    sfx.play('tool');
    for (const a of Object.values(roster)) if (a.status === 'working') a.used++;
    renderCards();
    return addChat(`<div class="bz-tool-line ${kind}">${icon(ico, 14)}<span>${html}</span></div>`);
  };
  // The green line that closes a finished run: how long it took, what changed, and a way to review it.
  const runDone = (ms, changed) => addChat(`<div class="bz-run-done"><span>✓ Done · ${Math.max(1, Math.round(ms / 1000))}s${changed ? ` · ${plural(changed, 'file')} changed` : ''}</span>${changed ? '<button class="bz-btn bz-btn-sm" data-act="view.git">Review changes</button>' : ''}</div>`);
  async function typing(ms) {
    const el = addChat('<div class="bz-msg"><div class="bz-body bz-typing"><i></i><i></i><i></i></div></div>');
    await sleep(ms);
    el.remove();
  }
  function emptyChat() {
    chat.innerHTML = `<div class="bz-empty"><img src="${ASSETS}brand/Agent.png" alt="" width="44" height="44"><h4>What are we building?</h4><div>${menuMade ? 'Ask for a tweak, like<br><b>“add our opening hours”</b>, <b>“put matcha on the menu”</b><br>or <b>“make it dark mode”</b>.<br><br><b>@</b>mention two agents and they split the work.' : 'Nothing here yet. <b>@</b>mention two agents and they build it side by side, like<br><b>“@Claude write a coffee menu page @Codex style it”</b>.'}</div></div>`;
    for (const k of Object.keys(roster)) delete roster[k];
    cards.classList.add('bz-hidden');
    planCard = null;
    splitCard = null;
  }
  emptyChat();

  // The plan: each step is one real edit to the files, matched from the request.
  const COLORS = {
    red: '#b23a3a', crimson: '#a8283a', maroon: '#7a2a2a', burgundy: '#7a2438', coral: '#c4584a', rose: '#b4566a', pink: '#b44a7a', magenta: '#a23d8c', plum: '#6a3a5a',
    orange: '#c4621d', terracotta: '#b4532a', yellow: '#e2b33c', gold: '#d4a12a', amber: '#b07415', brown: '#7a4a2a',
    green: '#2f7a4f', emerald: '#2a7a5a', forest: '#2f5a3a', olive: '#6b6a2a', lime: '#5a7a1f', mint: '#3f8f75', teal: '#2b7a78',
    cyan: '#1f7a93', sky: '#3a7ab0', blue: '#2a5db0', navy: '#24365e', indigo: '#3f4aa0', purple: '#6b4fa0', violet: '#6b4fa0', lavender: '#7a6aa8',
    black: '#1f1b16', charcoal: '#3a3632', gray: '#6b6560', grey: '#6b6560',
  };
  const THEMES = {
    dark: ['Switch the page to a dark theme', { bg: '#171513', text: '#f1ebe2', muted: '#a39a8d', line: '#2e2a25' }],
    light: ['Switch the page back to the light theme', { bg: '#f4efe6', text: '#1f1b16', muted: '#7a7064', line: '#ddd3c4' }],
  };
  // Things the visitor might put on the menu: [what they type, name on the menu, price in baht]
  const NEW_ITEMS = [
    ['matcha', 'Matcha latte', 95], ['cappuccino', 'Cappuccino', 80], ['flat white', 'Flat white', 80], ['mocha', 'Mocha', 90],
    ['cold brew', 'Cold brew', 90], ['americano', 'Americano', 65], ['affogato', 'Affogato', 110], ['hot chocolate', 'Hot chocolate', 85],
    ['cocoa', 'Hot chocolate', 85], ['croissant', 'Butter croissant', 70], ['banana bread', 'Banana bread', 75], ['cake', 'Coconut cake', 95],
    ['cookie', 'Brown butter cookie', 55], ['sandwich', 'Ham and cheese toastie', 120],
  ];
  const MENU_ITEMS = [['espresso', 'Espresso'], ['long black', 'Iced long black'], ['thai tea', 'Thai tea latte'], ['pour-over', 'Pour-over, single origin'], ['pour over', 'Pour-over, single origin']];
  const addCss = (marker, css) => t => (t.includes(marker) ? t : `${t}\n${css}`);
  const STEP = {
    menu: () => ({ say: 'Write a simple coffee menu page', file: 'index.html', edit: () => INDEX, also: 'styles.css', alsoEdit: () => STYLES, menu: true }),
    accent: c => ({ say: `Switch the accent color to ${c}`, file: 'styles.css', edit: t => t.replace(/--accent: [^;]+;/, `--accent: ${COLORS[c]};`) }),
    theme: name => ({ say: THEMES[name][0], file: 'styles.css', edit: t => Object.entries(THEMES[name][1]).reduce((s, [k, v]) => s.replace(new RegExp(`--${k}: [^;]+;`), `--${k}: ${v};`), t) }),
    heading: words => ({ say: `Change the heading to “${words}”`, file: 'index.html', edit: t => t.replace(/<h1>[\s\S]*?<\/h1>/, `<h1>${esc(words)}</h1>`) }),
    rename: name => ({ say: `Rename the café to “${name}”`, file: 'index.html', edit: t => t.replace(/<title>[^<]*<\/title>/, `<title>${esc(name)}</title>`).replace(/<span class="name">[^<]*<\/span>/, `<span class="name">${esc(name)}</span>`) }),
    addItem: ([, name, price]) => ({ say: `Add ${name} to the menu at ฿${price}`, file: 'index.html', edit: t => (t.includes(`<span>${name}</span>`) ? t : t.replace('    </ul>', `      <li><span>${name}</span><span>฿${price}</span></li>\n    </ul>`)) }),
    removeItem: name => ({ say: `Take ${name} off the menu`, file: 'index.html', edit: t => t.replace(new RegExp(`\\n *<li><span>${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</span>.*?</li>`), '') }),
    prices: up => ({ say: up ? 'Raise every price by about 10%' : 'Take about 10% off every price', file: 'index.html', edit: t => t.replace(/฿(\d+)/g, (m, n) => `฿${Math.round((n * (up ? 1.1 : 0.9)) / 5) * 5}`) }),
    hours: () => ({
      say: 'Add the opening hours under the menu', file: 'index.html', also: 'styles.css',
      edit: t => (t.includes('class="hours"') ? t : t.replace('    <button class="order"', '    <dl class="hours">\n      <dt>Wednesday – Monday</dt><dd>7:00 – 16:00</dd>\n      <dt>Tuesday</dt><dd>Closed</dd>\n    </dl>\n    <button class="order"')),
      alsoEdit: addCss('.hours {', '.hours {\n  display: grid;\n  grid-template-columns: 1fr auto;\n  gap: 4px 16px;\n  margin: 0 0 32px;\n  font-size: 13px;\n}\n\n.hours dt {\n  color: var(--muted);\n}\n\n.hours dd {\n  margin: 0;\n}\n'),
    }),
    footer: social => ({
      say: social ? 'Add a footer with the address and Instagram' : 'Add a footer with the address', file: 'index.html', also: 'styles.css',
      edit: t => (t.includes('class="footer"') ? t : t.replace('  <script', `  <footer class="footer">Charoen Krung Soi 38, Bangkok · ${social ? '<a href="#">@tidalcoffee</a>' : 'Walk-ins only'}</footer>\n  <script`)),
      alsoEdit: addCss('.footer {', '.footer {\n  padding: 20px 32px;\n  border-top: 1px solid var(--line);\n  color: var(--muted);\n  font-size: 13px;\n}\n\n.footer a {\n  color: var(--accent);\n}\n'),
    }),
    banner: () => ({
      say: 'Add an announcement bar above the header', file: 'index.html', also: 'styles.css',
      edit: t => (t.includes('class="banner"') ? t : t.replace('<body>\n', '<body>\n  <p class="banner">New beans this week: Doi Chang, washed. Ask at the bar.</p>\n')),
      alsoEdit: addCss('.banner {', '.banner {\n  margin: 0;\n  padding: 8px 32px;\n  background: var(--accent);\n  color: var(--bg);\n  font-size: 13px;\n}\n'),
    }),
    photo: () => ({
      say: 'Put a photo of the river above the heading', file: 'index.html', also: 'styles.css',
      edit: t => (t.includes('class="photo"') ? t : t.replace('    <h1>', '    <img class="photo" src="assets/city.png" alt="The river at dusk">\n    <h1>')),
      alsoEdit: addCss('.photo {', '.photo {\n  display: block;\n  width: 100%;\n  height: 180px;\n  margin: 0 0 28px;\n  border-radius: 4px;\n  object-fit: cover;\n}\n'),
    }),
    button: () => ({ say: 'Round the order button and darken it on hover', file: 'styles.css', edit: t => (t.includes('.order:hover') ? t : `${t.replace(/(\.order \{[\s\S]*?border-radius: )4px/, '$1999px')}\n.order:hover {\n  background: color-mix(in srgb, var(--accent) 82%, black);\n}\n`) }),
    leaders: () => ({ say: 'Join each menu item to its price with a dotted leader', file: 'styles.css', edit: addCss('dotted', '.menu li span:first-child {\n  display: flex;\n  flex: 1;\n  gap: 8px;\n}\n\n.menu li span:first-child::after {\n  content: "";\n  flex: 1;\n  margin: 0 8px 6px 0;\n  border-bottom: 1px dotted var(--muted);\n}\n') }),
    sans: () => ({ say: 'Set the heading in a clean sans-serif', file: 'styles.css', edit: t => t.replace(/(h1 \{[\s\S]*?font: )\d+ (\d+px\/[\d.]+) Georgia, serif;/, '$1650 $2 system-ui, sans-serif;\n  letter-spacing: -.02em;') }),
    size: big => ({ say: big ? 'Make the heading bigger' : 'Make the heading smaller', file: 'styles.css', edit: t => t.replace(/(h1 \{[\s\S]*?font: \d+ )(\d+)px/, (m, a, n) => `${a}${Math.round(n * (big ? 1.3 : 0.8))}px`) }),
    center: () => ({ say: 'Center the content on the page', file: 'styles.css', edit: t => t.replace(/(main \{\n)(?!  margin: 0 auto)/, '$1  margin: 0 auto;\n') }),
    roomy: () => ({ say: 'Give the page more room to breathe', file: 'styles.css', edit: t => t.replace('padding: 48px 32px;', 'padding: 72px 40px;').replace('padding: 10px 0;', 'padding: 14px 0;') }),
  };
  function planFor(prompt) {
    if (!menuMade) return [STEP.menu()]; // nothing to change yet, so the first request writes the page
    const quoted = prompt.match(/["“]([^"”]{2,60})["”]/);
    const p = prompt.replace(/["“][^"”]*["”]/g, ' ').toLowerCase(); // words inside quotes are content, not instructions
    const steps = [];
    const has = re => re.test(p);
    const color = Object.keys(COLORS).find(c => new RegExp(`\\b${c}\\b`).test(p));
    if (color) steps.push(STEP.accent(color));
    else if (has(/\b(colou?rs?|accent|palette|brand)\b/)) steps.push(STEP.accent('teal'));
    if (has(/\bdark(er)?\b|dark mode|\bnight\b|black background|moody/)) steps.push(STEP.theme('dark'));
    else if (has(/\blight(er)?\b|light mode|white background|bright|cream/) && files.get('styles.css')?.text.includes(THEMES.dark[1].bg)) steps.push(STEP.theme('light'));
    const renamed = prompt.match(/\b(?:rename(?: it| the \w+)?(?: to)?|call it|name it)\s+["“]?([^"”.,!?]{2,30})/i);
    if (renamed) steps.push(STEP.rename(renamed[1].trim()));
    else if (quoted || has(/\b(change|rewrite|reword|new|different|replace)\b.*\b(title|heading|headline|tagline|slogan|h1|hero text)\b/)) steps.push(STEP.heading(quoted ? quoted[1] : 'Coffee worth the walk.'));
    if (has(/\b(remove|delete|drop|take off|get rid of|no more|stop selling|replace|swap)\b/)) {
      const gone = MENU_ITEMS.find(([k]) => p.includes(k));
      if (gone) steps.push(STEP.removeItem(gone[1]));
    }
    const item = NEW_ITEMS.find(([k]) => p.includes(k));
    if (item) steps.push(STEP.addItem(item));
    else if (has(/\badd\b.*\b(drink|item|dish|pastry|food|snack|dessert)\b|\bnew (drink|item)\b/)) steps.push(STEP.addItem(has(/pastry|food|snack|dessert/) ? NEW_ITEMS[9] : NEW_ITEMS[4]));
    if (has(/\b(raise|increase|higher|more expensive|inflation)\b/) && has(/pric|cost/)) steps.push(STEP.prices(true));
    else if (has(/cheaper|discount|\bsale\b|lower (the )?prices?|reduce (the )?prices?|happy hour|% off/)) steps.push(STEP.prices(false));
    if (has(/hours|opening|open(ing)? times|closing|schedule|timetable|when .*open/)) steps.push(STEP.hours());
    const social = has(/instagram|social|\big\b|facebook|tiktok/);
    if (social || has(/footer|address|contact|location|\bmap\b|phone|email|copyright/)) steps.push(STEP.footer(social));
    if (has(/banner|announce|notice|promo|special|news|this week/)) steps.push(STEP.banner());
    if (has(/photo|image|picture|\bpic\b|hero image|gallery/)) steps.push(STEP.photo());
    if (has(/button|order|cta|checkout|pill|rounded|hover/)) steps.push(STEP.button());
    if (has(/dots?\b|dotted|leader|align(ed)? (the )?prices|tidy|polish|neater|cleaner|menu look/)) steps.push(STEP.leaders());
    if (has(/sans|modern font|clean font|change the font|typeface|typography/)) steps.push(STEP.sans());
    if (has(/(bigger|larger|huge|giant|bolder) (heading|title|headline|text)|(heading|title|headline) (bigger|larger)/)) steps.push(STEP.size(true));
    else if (has(/(smaller|tiny) (heading|title|headline)|(heading|title|headline) smaller/)) steps.push(STEP.size(false));
    if (has(/\bcent(er|re)(ed)?\b|\bmiddle\b/)) steps.push(STEP.center());
    if (has(/spacing|space out|more space|roomier|breath|whitespace|airy|padding/)) steps.push(STEP.roomy());
    if (!steps.length) steps.push(STEP.hours(), STEP.footer(false));
    return steps.slice(0, 4);
  }
  // Lines in `after` that weren't there before (one contiguous change).
  function changedLines(before, after) {
    const a = before.split('\n'), b = after.split('\n');
    let s = 0;
    while (s < a.length && s < b.length && a[s] === b[s]) s++;
    let e = 0;
    while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
    const set = new Set();
    for (let i = s; i < b.length - e; i++) set.add(i);
    return [set, Math.max(0, a.length - s - e)];
  }
  function write(path, fn) {
    const f = files.get(path);
    if (!f) return null;
    saveView();
    const before = f.text;
    const after = fn(before);
    if (after === before) return { add: 0, del: 0 };
    f.text = f.saved = after;
    const [lines, del] = changedLines(before, after);
    added.set(path, lines);
    if (!tabs.includes(path)) tabs.push(path);
    if (document.activeElement !== ta) {
      active = path;
      const first = Math.min(...lines);
      views.set(path, { sel: [0, 0], top: Math.max(0, 10 + first * 21 - 80), left: 0 });
    }
    renderTabs();
    renderEditor();
    renderSide();
    renderBadge();
    if (layout.preview) refreshPreview();
    return { add: lines.size, del };
  }
  // The same edit, typed out: the old text goes, the new text arrives a few characters at a time, and the
  // preview catches up each time a line lands.
  async function typeOut(path, fn) {
    const f = files.get(path);
    if (!f) return null;
    const before = f.text;
    const after = fn(before);
    if (after === before || calm) return write(path, () => after);
    let s = 0;
    while (s < before.length && s < after.length && before[s] === after[s]) s++;
    let e = 0;
    while (e < before.length - s && e < after.length - s && before[before.length - 1 - e] === after[after.length - 1 - e]) e++;
    const head = after.slice(0, s), mid = after.slice(s, after.length - e), tail = after.slice(after.length - e);
    const first = head.split('\n').length - 1;
    if (!tabs.includes(path)) tabs.push(path);
    if (document.activeElement !== ta) { saveView(); active = path; renderTabs(); renderEditor(); }
    for (let i = 0; i < mid.length;) {
      const next = Math.min(mid.length, i + (mid.length > 600 ? 9 : 3)); // whole files type faster
      sfx.play('key');
      const newLine = mid.slice(i, next).includes('\n');
      i = next;
      f.text = f.saved = head + mid.slice(0, i) + tail;
      const caret = first + (mid.slice(0, i).match(/\n/g)?.length ?? 0);
      added.set(path, new Set(Array.from({ length: caret - first + 1 }, (_, n) => first + n)));
      if (active === path && document.activeElement !== ta) {
        ta.value = f.text;
        paint();
        revealLine(caret);
      }
      if (newLine && layout.preview) refreshPreview();
      await sleep(16);
    }
    f.text = f.saved = before;
    return write(path, () => after);
  }
  async function build(steps) {
    building = true;
    sfx.play('build');
    updateTour();
    const started = Date.now();
    const changed = new Set();
    setAgent('builder', 'working', 'Building the plan');
    await sleep(500);
    for (const [i, st] of steps.entries()) {
      setAgent('builder', 'working', st.say);
      tool('', 'pencil', `Editing ${esc(st.file)}…`);
      await sleep(700);
      const edits = [[st.file, st.edit], ...(st.also ? [[st.also, st.alsoEdit]] : [])];
      for (const [file, fn] of edits) {
        const r = await typeOut(file, fn);
        if (!r) tool('', 'eye', `${esc(file)} is missing, skipped`);
        else if (!r.add && !r.del) tool('', 'check', `${esc(file)} already does this`);
        else { tool('edit', 'pencil', `Edited ${esc(file)} <b>+${r.add}</b>${r.del ? ` −${r.del}` : ''}`); changed.add(file); }
        await sleep(350);
      }
      if (i < steps.length - 1) await sleep(300);
    }
    await typing(700);
    const msg = say('builder', `Done. ${steps.length === 1 ? 'The change is' : `All ${steps.length} changes are`} in, highlighted in green.`);
    setAgent('builder', 'done', changed.size ? `Changed ${plural(changed.size, 'file')}` : 'Answered');
    runDone(Date.now() - started, changed.size);
    busy = false;
    building = false;
    sfx.play('success');
    if (menuMade) restyled = true;
    if (steps.some(st => st.menu)) menuMade = true;
    updateTour();
    return msg;
  }

  /* ----- Agent teams: two or more @mentioned agents split one request and build side by side, each in its own
     files (src/renderer/breeze/teams.ts). They list the files they will change, the visitor settles any file two
     of them want, then they build at the same time. An edit to a teammate's file is a crossing: it is put back. ----- */
  const MENTION_NAMES = TEAM_AGENTS.flatMap(a => [a.short, a.name, ...a.ids].map(n => ({ n: n.toLowerCase(), name: a.name }))).sort((x, y) => y.n.length - x.n.length);
  // Each @mention in `text`: where it starts and ends, and the agent it names.
  function mentionMarks(text) {
    const marks = [];
    const re = /(^|\s)@/g;
    let m;
    while ((m = re.exec(text))) {
      const at = m.index + m[1].length;
      const rest = text.slice(at + 1);
      const hit = MENTION_NAMES.find(x => rest.toLowerCase().startsWith(x.n) && !/[\w-]/.test(rest[x.n.length] || ''));
      if (!hit) continue;
      marks.push({ at, end: at + 1 + hit.n.length, name: hit.name });
      re.lastIndex = at + 1 + hit.n.length;
    }
    return marks;
  }
  // "Coffee site: @Claude write the page @Codex style it": words before the first mention go to everyone.
  function parseMentions(text) {
    const marks = mentionMarks(text);
    const shared = text.slice(0, marks[0]?.at ?? text.length).trim();
    const byAgent = new Map();
    marks.forEach((mk, i) => {
      const body = text.slice(mk.end, marks[i + 1]?.at ?? text.length).trim();
      if (!byAgent.has(mk.name)) byAgent.set(mk.name, []);
      if (body) byAgent.get(mk.name).push(body);
    });
    return { shared, tasks: [...byAgent].map(([name, parts]) => ({ name, task: parts.join(' ') })) };
  }
  function mentionHtml(text) {
    let html = '', from = 0;
    for (const { at, end } of mentionMarks(text)) {
      html += `${esc(text.slice(from, at))}<span class="bz-mention">${esc(text.slice(at, end))}</span>`;
      from = end;
    }
    return html + esc(text.slice(from));
  }
  const listOf = words => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const filesOf = steps => [...new Set(steps.flatMap(st => [st.file, st.also].filter(Boolean)))];

  // A teammate's share of the work. The empty project splits into the page and its styles.
  function teamSteps(task, shared) {
    if (!menuMade) {
      return /\b(styles?|css|look|design|colou?rs?|theme|fonts?|pretty)\b/.test(task.toLowerCase())
        ? [{ say: 'Style the menu page', file: 'styles.css', edit: () => STYLES, menu: true }]
        : [{ say: 'Write the coffee menu page', file: 'index.html', edit: () => INDEX, menu: true }];
    }
    return planFor([shared, task].filter(Boolean).join(' '));
  }

  // One column per teammate and a row per file more than one of them listed. Resolves with the owners on Start,
  // null on Cancel. The first-mentioned agent owns a shared file unless the visitor picks another.
  function whoDoesWhat(members) {
    const claims = members.map(m => [m.name, filesOf(m.steps)]);
    const clashes = [...new Set(claims.flatMap(([, paths]) => paths))]
      .map(path => ({ path, agents: claims.filter(([, paths]) => paths.includes(path)).map(([name]) => name) }))
      .filter(k => k.agents.length > 1);
    const cols = claims.map(([name, paths], i) => `<div class="bz-split-col">${agentTag(name)}<div class="bz-split-task" title="${esc(members[i].task)}">${esc(members[i].task || 'No task')}</div>${paths.length ? `<ul class="bz-split-paths">${paths.map(p => `<li><code>${esc(p)}</code></li>`).join('')}</ul>` : '<p class="bz-split-none">No files listed</p>'}</div>`).join('');
    const rows = clashes.map((k, i) => `<div class="bz-split-clash" data-clash="${i}"><code>${esc(k.path)}</code><div class="bz-seg" role="radiogroup" aria-label="Who owns ${esc(k.path)}">${k.agents.map((a, j) => `<button type="button" role="radio" class="${j ? '' : 'on'}" aria-checked="${!j}" data-pick="${esc(a)}">${esc(shortOf(a))}</button>`).join('')}</div></div>`).join('');
    const card = addChat(`<div class="bz-plan bz-team-split"><h5>${icon('columns', 15)} Who does what</h5><div class="bz-split-cols">${cols}</div>${rows ? `<div class="bz-split-clashes"><p>More than one agent wants these. Pick who owns each:</p>${rows}</div>` : ''}<div class="bz-row"><button class="bz-btn bz-btn-primary" data-split="start">Start</button><button class="bz-btn" data-split="cancel">Cancel</button></div></div>`);
    for (const m of members) setAgent(m.name, 'waiting', 'Waiting for you to start', true);
    splitCard = card;
    sfx.play('plan');
    updateTour();
    return new Promise(resolve => card.addEventListener('click', e => {
      if (splitCard !== card) return;
      const pick = e.target.closest('[data-pick]');
      if (pick) {
        for (const b of pick.parentElement.children) { b.classList.toggle('on', b === pick); b.setAttribute('aria-checked', String(b === pick)); }
        sfx.play('tick');
        return;
      }
      const b = e.target.closest('[data-split]');
      if (!b) return;
      splitCard = null;
      const start = b.dataset.split === 'start';
      const owners = {};
      for (const [name, paths] of claims) for (const p of paths) owners[p] ??= name;
      clashes.forEach((k, i) => { owners[k.path] = card.querySelector(`[data-clash="${i}"] .on`)?.dataset.pick ?? owners[k.path]; });
      card.querySelectorAll('.bz-seg button').forEach(x => { x.disabled = true; });
      card.querySelector('.bz-row').outerHTML = `<div class="bz-resolved">${start ? '✓ Started' : '✕ Cancelled'}</div>`;
      sfx.play(start ? 'approve' : 'close');
      updateTour();
      resolve(start ? owners : null);
    }));
  }

  async function runTeam(parsed) {
    const members = parsed.tasks.map(t => ({ ...t, steps: teamSteps(t.task, parsed.shared), files: new Set() }));
    const names = members.map(m => m.name);
    for (const m of members) setAgent(m.name, 'working', 'Listing the files it will change', true);
    const claiming = addChat(`<div class="bz-team-claiming" role="status">${names.map(agentTag).join('')}<span class="lbl">Planning who does what</span></div>`);
    sfx.play('tool');
    await sleep(1600);
    claiming.classList.add('settled');
    claiming.querySelector('.lbl').textContent = 'Planned who does what';
    const owners = await whoDoesWhat(members);
    if (!owners) {
      for (const m of members) setAgent(m.name, 'idle', 'Cancelled', true);
      busy = false;
      updateTour();
      return;
    }

    building = true;
    sfx.play('build');
    updateTour();
    const strip = document.createElement('div');
    strip.className = 'bz-team-strip';
    strip.setAttribute('role', 'status');
    strip.innerHTML = names.map(n => `<span class="bz-team-chip working" data-chip="${esc(n)}">${agentTag(n)}<span class="state">working</span></span>`).join('');
    chat.prepend(strip); // pinned to the top of the chat while they build
    addChat(`<div class="bz-team-line">${listOf(names.map(n => `<b>${esc(shortOf(n))}</b>`))} are working at the same time, each in its own files</div>`);

    const crossed = new Set();
    const notes = [];
    async function runMember(m, delay) {
      await sleep(delay);
      const tag = agentTag(m.name);
      setAgent(m.name, 'working', 'Reading the project', true);
      tool('', 'eye', `${tag} Read ${esc(m.steps[0]?.file ?? 'index.html')}`);
      await sleep(600);
      for (const st of m.steps) {
        setAgent(m.name, 'working', st.say, true);
        for (const [file, fn] of [[st.file, st.edit], ...(st.also ? [[st.also, st.alsoEdit]] : [])]) {
          const owner = owners[file];
          if (owner !== m.name) {
            // Claude Code gets deny rules for its teammates' files, so it is stopped; any other agent's edit is put back.
            if (!crossed.has(`${m.name}|${file}`)) {
              crossed.add(`${m.name}|${file}`);
              sfx.play('tool');
              addChat(`<div class="bz-plan bz-crossing"><h5>${icon('alert', 15)} Crossing</h5><p>${esc(shortOf(m.name))} tried to edit <code>${esc(file)}</code> (${esc(shortOf(owner))}'s)${m.name === AGENTS[0] ? ' and was stopped.' : '. Breeze put it back.'}</p></div>`);
              notes.push([m.name, owner, `${file} needs a change for “${st.say.toLowerCase()}”`]);
            }
            await sleep(500);
            continue;
          }
          tool('', 'pencil', `${tag} Editing ${esc(file)}…`);
          await sleep(500);
          const r = await typeOut(file, fn);
          if (!r) tool('', 'eye', `${tag} ${esc(file)} is missing, skipped`);
          else if (!r.add && !r.del) tool('', 'check', `${tag} ${esc(file)} already does this`);
          else {
            m.files.add(file);
            tool('edit', 'pencil', `${tag} Edited ${esc(file)} <b>+${r.add}</b>${r.del ? ` −${r.del}` : ''}`);
          }
          await sleep(300);
        }
      }
      const chip = strip.querySelector(`[data-chip="${CSS.escape(m.name)}"]`);
      chip?.classList.replace('working', 'done');
      if (chip) chip.querySelector('.state').textContent = 'done';
      setAgent(m.name, 'done', m.files.size ? `Changed ${plural(m.files.size, 'file')}` : 'No files changed', true);
      sfx.play('tool');
    }
    await Promise.all(members.map((m, i) => runMember(m, i * 650))); // a beat apart, so the first edits don't land at once

    await typing(600);
    const rows = members.map(m => `<div class="bz-ts-member">${agentTag(m.name)}<div class="bz-ts-files">${m.files.size ? [...m.files].map(p => `<code>${esc(p)}</code>`).join('') : '<span class="none">No files changed</span>'}</div></div>`).join('');
    const notesHtml = notes.length ? `<ul class="bz-ts-notes">${notes.map(([from, to, text]) => `<li>${esc(shortOf(from))} → ${esc(shortOf(to))}: ${esc(text)}</li>`).join('')}</ul>` : '';
    addChat(`<div class="bz-plan bz-team-summary"><h5>${icon('check', 15)} Team finished</h5><div class="bz-ts-members">${rows}</div><p class="bz-ts-crossings">${crossed.size ? plural(crossed.size, 'crossing') : 'No crossings'}</p>${notesHtml}<div class="bz-row"><button class="bz-btn bz-btn-primary" data-act="run.start">${icon('play', 12)} Open preview</button><button class="bz-btn" data-act="view.git">Save a checkpoint</button></div></div>`);
    busy = false;
    building = false;
    sfx.play('success');
    if (menuMade) restyled = true;
    if (members.some(m => m.steps.some(st => st.menu))) menuMade = true;
    updateTour();
  }

  // The agent bar in the panel header, as the app shows it in a narrow panel: the default agent's chip, the rest folded into "+N".
  function renderAgentBar() {
    $('#bzAgentBar').innerHTML = `<button type="button" class="bz-chip on" aria-label="Mention @${esc(shortOf(agentName))}">${logoOf(agentName)}<span>${esc(shortOf(agentName))}</span><span class="bz-chip-more" role="button" aria-label="Switch the default agent" aria-haspopup="menu">${icon('chevronDown', 10)}</span></button>
      <button type="button" class="bz-chip bz-chip-rest" aria-haspopup="menu" aria-label="${AGENTS.length - 1} more agents">+${AGENTS.length - 1}</button>`;
  }
  $('#bzAgentBar').addEventListener('click', e => {
    const chip = e.target.closest('.bz-chip');
    if (!chip) return;
    if (menu?.anchor === chip) { closeMenu(); return; }
    const mention = name => pickMention(TEAM_AGENTS.find(a => a.name === name));
    if (chip.classList.contains('bz-chip-rest')) openMenu(AGENTS.filter(a => a !== agentName).map(a => ({ label: shortOf(a), icon: logoOf(a), run: () => mention(a) })), chip, 'right');
    else if (e.target.closest('.bz-chip-more')) openMenu(AGENTS.map(a => ({ label: a, checked: a === agentName, run: () => pickAgent(a) })), chip, 'right');
    else { closeMenu(); mention(agentName); }
  });
  renderAgentBar();

  function pickAgent(name) {
    agentName = name;
    renderAgentBar();
    for (const [r, v] of Object.entries(roster)) setAgent(r, v.status, v.task, v.mate);
  }

  async function send() {
    const text = promptEl.value.trim();
    if (!text || busy || promptEl.readOnly && text !== FIRST_ASK) return;
    busy = true;
    sfx.play('send');
    updateTour();
    promptEl.value = '';
    // No mode picker, as in the app: a question gets an answer, anything else a plan.
    const mode = text.endsWith('?') ? 'ask' : 'plan';
    for (const k of Object.keys(roster)) delete roster[k];
    chat.querySelector('.bz-team-strip')?.remove(); // the last team's strip goes with the next request, as in the app
    addChat(`<div class="bz-msg user"><span class="bz-meta"><b>You</b>${clock()}</span><div class="bz-body">${mentionHtml(text)}</div></div>`);
    await sleep(300);
    const parsed = parseMentions(text);
    if (parsed.tasks.length >= 2) { await runTeam(parsed); return; }
    if (parsed.tasks.length === 1) pickAgent(parsed.tasks[0].name); // one mention: that agent takes the request
    if (mode === 'ask') {
      setAgent('assistant', 'working', 'Reading the project');
      tool('', 'eye', 'Read index.html');
      await sleep(400);
      tool('', 'eye', 'Read styles.css');
      await sleep(300);
      tool('', 'eye', 'Read site.js');
      await typing(900);
      say('assistant', `This is the one-page site for Tidal Coffee. <code>index.html</code> has the menu, <code>styles.css</code> sets the colors through <code>--accent</code>, <code>--bg</code> and <code>--text</code>, and <code>site.js</code> shows whether the bar is open and handles the Order ahead button. Ask me for a change and I'll plan it out for you.`);
      setAgent('assistant', 'done', 'Answered');
      busy = false;
      return;
    }
    const steps = planFor(text);
    if (mode === 'build' || steps[0].menu) {
      addChat(`<div class="bz-team-line">1 agent on this: <b>${esc(agentName.split(' · ')[0])}</b> makes the changes</div>`);
      await build(steps);
      return;
    }
    addChat('<div class="bz-team-line">2 agents on this: <b>Planner</b> writes a plan, then <b>Builder</b> builds it once you approve</div>');
    setAgent('planner', 'working', 'Reading the project');
    await sleep(500);
    tool('', 'eye', 'Read index.html');
    await sleep(450);
    tool('', 'eye', 'Read styles.css');
    await typing(900);
    say('planner', 'I looked at the page and its styles. Here is what I would change.');
    await sleep(250);
    const card = addChat(`<div class="bz-plan"><h5>${icon('todo', 15)} Plan</h5><ol>${steps.map(s => `<li>${esc(s.say)}</li>`).join('')}</ol><div class="bz-row"><button class="bz-btn bz-btn-primary" data-plan="go">Approve &amp; build</button><button class="bz-btn" data-plan="change">Change something</button></div></div>`);
    setAgent('planner', 'waiting', 'Waiting for plan approval');
    planCard = card;
    sfx.play('plan');
    updateTour();
    card.addEventListener('click', async e => {
      const b = e.target.closest('[data-plan]');
      if (!b) return;
      planCard = null;
      updateTour();
      card.querySelector('.bz-row').outerHTML = `<div class="bz-resolved">${b.dataset.plan === 'go' ? '✓ Approved' : '✎ Asked for changes'}</div>`;
      if (b.dataset.plan === 'go') {
        sfx.play('approve');
        setAgent('planner', 'done', 'Plan handed off');
        addChat('<div class="bz-handoff">Planner → Builder</div>');
        await build(steps);
      } else {
        setAgent('planner', 'idle', 'Waiting for your changes');
        say('planner', 'Sure. Tell me what to do differently and I will write a new plan.');
        busy = false;
        promptEl.focus({ preventScroll: true });
      }
    });
  }
  // Typing "@" lists the agents to mention, above the prompt like the app's. Enter or Tab takes the first one.
  const MENTION_AT_CARET = /(^|\s)@([\w-]*)$/;
  function pickMention(a) {
    const caret = promptEl.selectionStart;
    const m = MENTION_AT_CARET.exec(promptEl.value.slice(0, caret));
    promptEl.setRangeText(`@${a.short} `, m ? caret - m[2].length - 1 : caret, caret, 'end');
    promptEl.focus({ preventScroll: true });
  }
  function updateMentionMenu() {
    const m = MENTION_AT_CARET.exec(promptEl.value.slice(0, promptEl.selectionStart));
    const word = m ? m[2].toLowerCase() : '';
    const hits = m ? TEAM_AGENTS.filter(a => [a.short, ...a.ids].some(n => n.toLowerCase().startsWith(word))) : [];
    const ids = hits.map(a => a.short).join();
    if (menu?.mention === ids) return; // already listing these
    if (menu?.mention != null) closeMenu();
    if (!hits.length) return;
    openMenu(hits.map(a => ({ label: a.short, icon: logoOf(a.name), run: () => pickMention(a) })), promptEl, 'above', false, true);
    menu.mention = ids;
  }
  promptEl.addEventListener('input', updateMentionMenu);
  promptEl.addEventListener('click', updateMentionMenu);
  promptEl.addEventListener('keydown', e => {
    if (menu?.mention != null && !e.shiftKey && (e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape')) {
      e.preventDefault();
      e.stopPropagation();
      const first = menu.items[0];
      closeMenu();
      if (e.key !== 'Escape') first?.run();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); closeMenu(); send(); }
  });

  /* ================= Commands ================= */
  let chats = 1;
  const commands = {
    'view.files': () => showView('files'),
    'view.search': () => showView('search'),
    'view.git': () => { if (!(layout.side && layout.view === 'git')) showView('git'); },
    'view.toggleSide': () => { layout.side = !layout.side; sfx.play('menu'); applyLayout(); },
    'view.toggleAgents': () => { layout.agents = !layout.agents; sfx.play('menu'); if (layout.agents && layout.preview) layout.side = false; applyLayout(); if (layout.agents) setTimeout(() => promptEl.focus({ preventScroll: true }), 230); },
    'view.reset': () => { Object.assign(layout, { side: true, agents: false, term: false, preview: false, view: 'files' }); applyLayout(); renderSide(); },
    'term.toggle': () => { layout.term = !layout.term; sfx.play('whoosh'); applyLayout(); if (layout.term) setTimeout(() => termIn.focus({ preventScroll: true }), 230); },
    'term.focus': () => { layout.term = true; applyLayout(); setTimeout(() => termIn.focus({ preventScroll: true }), 230); },
    'term.clear': () => { termOut.innerHTML = ''; },
    'term.kill': () => { if (layout.preview) stopPreview(); else termPrint('^C\n'); },
    'run.start': () => startPreview(),
    'run.reload': () => refreshPreview(),
    'run.stop': () => stopPreview(),
    'file.newFile': () => { layout.side = true; layout.view = 'files'; applyLayout(); const parent = dirs.has(selected) ? selected : dirName(selected ?? ''); if (parent) openDirs.add(parent); pending = { kind: 'file', parent }; renderTree(); },
    'file.newFolder': () => { layout.side = true; layout.view = 'files'; applyLayout(); const parent = dirs.has(selected) ? selected : dirName(selected ?? ''); if (parent) openDirs.add(parent); pending = { kind: 'dir', parent }; renderTree(); },
    'file.save': () => { if (!hasFile()) return; const f = files.get(active); f.saved = f.text; sfx.play('save'); renderTabs(); renderSide(); renderBadge(); if (layout.preview) refreshPreview(); },
    'file.saveAll': () => { for (const f of files.values()) if ('text' in f) f.saved = f.text; renderTabs(); renderSide(); renderBadge(); },
    'explorer.collapse': () => { openDirs.clear(); renderTree(); },
    'edit.find': () => openFind(),
    'edit.comment': () => { if (hasFile()) toggleComment(); },
    'sel.line': () => { if (!hasFile()) return; const [s, e] = lineSpan(); focusEditor(); ta.setSelectionRange(s, Math.min(ta.value.length, e + 1)); onCaret(); },
    'sel.dup': () => { if (hasFile()) dupLine(); },
    'sel.up': () => { if (hasFile()) moveLine(-1); },
    'sel.down': () => { if (hasFile()) moveLine(1); },
    'find.next': () => runFind(true),
    'find.prev': () => runFind(true, true),
    'find.close': () => { closeFind(); focusEditor(); },
    'editor.focus': () => focusEditor(),
    'git.commit': () => commit(),
    'git.push': () => push(),
    'agent.send': () => send(),
    'chat.new': () => { if (busy) return; emptyChat(); $('#bzChatTab').textContent = `Chat ${++chats}`; updateTour(); },
    'chat.history': () => desktopOnly('Chat history'),
    'term.new': () => desktopOnly('Opening more terminals'),
    sync: () => desktopOnly('Cloud sync'),
    'go.file': () => desktopOnly('Go to file'),
    'editor.split': () => desktopOnly('Split editor'),
    'preview.pages': () => openMenu([...files.keys()].filter(p => extOf(p) === 'html').sort().map(p => ({ label: p, checked: layout.preview && p === 'index.html', run: p === 'index.html' ? startPreview : () => desktopOnly(`Previewing ${p}`) })), $('.bz-url'), 'below'),
    settings: () => openMenu([
      { label: 'Keyboard Shortcuts', run: () => modal(`<h4>Keyboard shortcuts</h4><div class="bz-keys">${SHORTCUTS.map(([a, k]) => `<span>${a}</span><kbd>${k}</kbd>`).join('')}</div>`) },
      { sep: true },
      { label: 'Breeze Code', checked: true },
      { label: 'Breeze Box', run: () => desktopOnly('Breeze Box, the chat-only mode,') },
      { sep: true },
      { label: 'Download Breeze Code', href: DOWNLOAD },
    ], $('.bz-act-btn.gear'), 'up'),
    account: () => openMenu([{ label: 'Not signed in', disabled: true }, { sep: true }, { label: 'Sign in with GitHub…', run: () => desktopOnly('Signing in') }, { label: 'Sign in with Google…', run: () => desktopOnly('Signing in') }], $('.bz-avatar'), 'right'),
    branch: () => toast(`${icon('gitBranch', 14)} On branch <b>master</b>`),
    'win.min': () => { root.classList.add('minimized'); setTimeout(() => root.classList.remove('minimized'), 700); },
    'win.max': () => {
      if (document.fullscreenElement) document.exitFullscreen?.();
      else root.requestFullscreen?.().catch(() => toast('Full screen is not available here.'));
    },
    'win.close': () => toast(`Just a demo, can't close it! <a href="${DOWNLOAD}" target="_blank" rel="noopener">Grab Breeze Code</a> for the real deal.`, 4500),
  };
  function cmd(name) { closeMenu(); commands[name]?.(); }

  root.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (b && root.contains(b)) {
      // The terminal header toggles, but its own buttons do their own thing.
      if (b.classList.contains('bz-term-head') && e.target.closest('button')) return;
      // A button that opens a menu closes it again on the second click.
      if (menu?.anchor === b && b.hasAttribute('aria-haspopup')) { closeMenu(); return; }
      cmd(b.dataset.act);
      return;
    }
    const v = e.target.closest('.bz-act-btn[data-view]');
    if (v) cmd(`view.${v.dataset.view}`);
  });

  /* ----- keyboard: only while focus is inside the window, and never leaking out to the page ----- */
  root.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    let run = null;
    if (menu && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const items = [...menu.el.querySelectorAll('.bz-menu-item:not(:disabled)')];
      const i = items.indexOf(document.activeElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus({ preventScroll: true });
      e.preventDefault();
    } else if (e.key === 'Escape') {
      if (menu) { const a = menu.anchor; closeMenu(); a?.focus({ preventScroll: true }); }
      else if (findOpen) { closeFind(); focusEditor(); }
      else if (document.fullscreenElement === root) document.exitFullscreen?.();
    } else if (e.key === 'F5') run = e.shiftKey ? 'run.stop' : 'run.start';
    else if (e.key === 'F2' && layout.view === 'files' && selected && document.activeElement?.closest('.bz-sidebar')) { pending = { kind: 'rename', path: selected }; renderTree(); e.preventDefault(); }
    else if (e.key === 'Delete' && document.activeElement?.closest('.bz-tree-item[data-path]')) { deleteEntry(selected); e.preventDefault(); }
    else if (mod && e.shiftKey && k === 'e') run = 'view.files';
    else if (mod && e.shiftKey && k === 'f') run = 'view.search';
    else if (mod && e.shiftKey && k === 'g') run = 'view.git';
    else if (mod && e.altKey && k === 'b') run = 'view.toggleAgents';
    else if (mod && !e.shiftKey && k === 'b') run = 'view.toggleSide';
    else if (mod && (k === '`' || e.code === 'Backquote')) run = 'term.toggle';
    else if (mod && k === 's') run = e.altKey ? 'file.saveAll' : 'file.save';
    else if (mod && k === 'f' && hasFile()) run = 'edit.find';
    // The shortcuts the empty editor lists. Ctrl+N stays the browser's in most browsers.
    else if (mod && k === 'p') run = 'go.file';
    else if (mod && k === 'n') run = 'file.newFile';
    else if (mod && k === '/' && document.activeElement === ta) run = 'edit.comment';
    else if (mod && k === 'l' && document.activeElement === ta) run = 'sel.line';
    if (run) { e.preventDefault(); cmd(run); }
    e.stopPropagation(); // the page's own scroll-snap keys stay out of the editor
  });
  // Wheel and touch scrolling inside a panel stays in the panel instead of snapping the page.
  const scrollsInside = (el, dy) => {
    for (; el && el !== root; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
        if (dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
      }
    }
    return false;
  };
  root.addEventListener('wheel', e => { if (scrollsInside(e.target, e.deltaY)) e.stopPropagation(); }, { passive: true });
  let touchY = null;
  root.addEventListener('touchstart', e => { touchY = e.touches[0].clientY; e.stopPropagation(); }, { passive: true });
  root.addEventListener('touchmove', e => { if (touchY != null && scrollsInside(e.target, touchY - e.touches[0].clientY)) e.stopPropagation(); }, { passive: true });

  /* ================= Guided tour ================= */
  // Chat bubbles walk a first-time visitor through it, starting from an empty index.html and styles.css: open the
  // preview, open the agent bar, insert the first request so two agents write a coffee menu as a team, start the
  // team, ask for dark mode, a footer and a yellow accent, approve the plan, then save a checkpoint and push it.
  // Every bubble carries a ready-made action (`act`) the visitor can click instead of finding the control themselves.
  const FIRST_ASK = '@Claude write a coffee menu page @Codex style it';
  const RESTYLE = 'Switch to Dark Mode, add footer and location, and make accent yellow';
  const CHECKPOINT_MSG = 'Coffee menu in dark mode with a footer';
  const TOUR = {
    index: { at: () => tabsEl.querySelector('[data-tab="index.html"]') ?? $('.bz-tree-item[data-path="index.html"]'), side: 'below', html: 'Open <b>index.html</b>. Empty for now, but an agent’s about to fill it.', act: ['Open index.html', () => openFile('index.html', true)] },
    preview: { at: () => runBtn, side: 'below', html: 'Blank canvas! Open the <b>Preview</b> and watch the page pop into life.', act: [`${icon('play', 12)} Open the preview`, () => cmd('run.start')] },
    agents: { at: () => $('[data-act="view.toggleAgents"]'), side: 'below', html: 'Now open the <b>agent bar</b>. That’s where your AI crew writes the code.', act: ['Open the agent bar', () => { if (!layout.agents) cmd('view.toggleAgents'); }] },
    insert: { at: () => $('.bz-composer-box'), side: 'left', html: 'Time for their first gig. <b>@mention</b> two agents and they build side by side. Click to send:', act: [`${icon('plus', 12)} Insert “${esc(FIRST_ASK)}”`, () => { promptEl.value = FIRST_ASK; send(); }] },
    start: { at: () => splitCard?.querySelector('[data-split="start"]'), side: 'left', html: 'Each agent called dibs on its files. Hit <b>Start</b> and they build at once, no stepping on toes.', act: [`${icon('play', 12)} Start the team`, () => splitCard?.querySelector('[data-split="start"]')?.click()] },
    restyle: { at: () => $('.bz-composer-box'), side: 'left', html: 'Menu’s live! Now ask for <b>dark mode</b>, a <b>footer with the location</b> and a <b>yellow</b> accent. Type it, or just click:', act: [`${icon('send', 12)} “${esc(RESTYLE)}”`, () => { promptEl.value = RESTYLE; send(); }] },
    approve: { at: () => planCard?.querySelector('[data-plan="go"]'), side: 'left', html: 'The Planner has a plan. <b>Approve</b> it and the Builder gets cracking.', act: [`${icon('check', 12)} Approve &amp; build`, () => planCard?.querySelector('[data-plan="go"]')?.click()] },
    checkpoint: { at: () => [...chat.querySelectorAll('[data-act="view.git"]')].pop() ?? $('.bz-act-btn[data-view="git"]'), side: 'left', html: 'Looking sharp. <b>Save a checkpoint</b> so you can always come back to this.', act: ['Save a checkpoint', () => cmd('view.git')] },
    message: { at: () => $('#bzCommitMsg'), side: 'right', html: 'Sum up the change in a few words. Write your own, or steal this one:', act: [`“${esc(CHECKPOINT_MSG)}”`, () => { draftMsg = CHECKPOINT_MSG; const m = $('#bzCommitMsg'); if (m) { m.value = draftMsg; m.focus({ preventScroll: true }); } updateTour(); }] },
    commit: { at: () => $('[data-act="git.commit"]'), side: 'right', html: 'Lock it in and send it to GitHub. Press <kbd>Ctrl+Enter</kbd> or click:', act: ['Commit &amp; Push', () => cmd('git.commit')] },
    watch: { at: () => $('.bz-url'), side: 'below', html: () => (menuMade ? 'Your agents are updating the page. Watch the preview change as they type.' : 'Claude writes the page while Codex writes its styles. Watch the preview fill in as they type.') },
  };
  const coach = document.createElement('div');
  coach.className = 'bz-coach bz-hidden';
  coach.setAttribute('role', 'status');
  ide.append(coach);
  let tourStep = null;
  let tourOff = false;
  let tourOn = false; // starts the first time the window is on screen
  let onScreen = false;
  let coachRaf = 0;

  function tourStepNow() {
    if (tourOff || !tourOn) return null;
    if (building) return layout.preview ? 'watch' : null;
    if (splitCard) return layout.agents ? 'start' : 'agents';
    if (planCard) return layout.agents ? 'approve' : 'agents';
    if (!layout.preview) return active === 'index.html' ? 'preview' : 'index';
    if (!layout.agents) return 'agents';
    if (!menuMade) return busy ? null : 'insert';
    if (!restyled) return busy ? null : 'restyle';
    if (!lastCheckpoint) {
      if (!(layout.side && layout.view === 'git')) return 'checkpoint';
      return draftMsg.trim() ? 'commit' : 'message';
    }
    return null;
  }
  function placeCoach() {
    const t = TOUR[tourStep]?.at();
    const r = t?.getBoundingClientRect();
    $$('.bz-coach-target').forEach(el => el !== t && el.classList.remove('bz-coach-target'));
    if (!r?.width) { coach.style.visibility = 'hidden'; return; }
    t.classList.add('bz-coach-target');
    coach.style.visibility = '';
    const k = ide.getBoundingClientRect().width / ide.offsetWidth;
    const [x, y] = toIde(r.left, r.top);
    const w = r.width / k, h = r.height / k;
    const cw = coach.offsetWidth, ch = coach.offsetHeight;
    const W = ide.offsetWidth, H = ide.offsetHeight;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    let left, top;
    if (TOUR[tourStep].side === 'below') {
      top = y + h + 12;
      left = clamp(x + w / 2 - cw / 2, 10, W - cw - 10);
      coach.style.setProperty('--arrow', `${clamp(x + w / 2 - left, 16, cw - 16)}px`);
    } else if (TOUR[tourStep].side === 'right') {
      left = x + w + 14;
      top = clamp(y + h / 2 - ch / 2, 10, H - ch - 10);
      coach.style.setProperty('--arrow', `${clamp(y + h / 2 - top, 14, ch - 14)}px`);
    } else {
      left = x - cw - 14;
      top = clamp(y + h / 2 - ch / 2, 10, H - ch - 10);
      coach.style.setProperty('--arrow', `${clamp(y + h / 2 - top, 14, ch - 14)}px`);
    }
    coach.style.left = `${left}px`;
    coach.style.top = `${top}px`;
  }
  // Panels slide open, so the bubble follows its target every frame while it shows.
  function followCoach() { placeCoach(); coachRaf = requestAnimationFrame(followCoach); }
  function updateTour() {
    const step = tourStepNow();
    if (step !== tourStep) {
      tourStep = step;
      if (step) {
        sfx.play('coach');
        const html = TOUR[step].html;
        const act = TOUR[step].act;
        coach.innerHTML = `<div>${typeof html === 'function' ? html() : html}${act ? `<button class="bz-coach-try" data-coach="act">${act[0]}</button>` : ''}</div><button class="bz-coach-x" data-coach="skip" title="Skip the tour" aria-label="Skip the tour">${icon('x', 12)}</button>`;
        coach.dataset.side = TOUR[step].side;
        coach.classList.remove('bz-hidden', 'pop');
        void coach.offsetWidth;
        coach.classList.add('pop');
      } else {
        coach.classList.add('bz-hidden');
        $$('.bz-coach-target').forEach(el => el.classList.remove('bz-coach-target'));
      }
    }
    const locked = tourStep === 'insert';
    promptEl.readOnly = locked;
    promptEl.placeholder = locked ? `Click Insert “${FIRST_ASK}” to start` : 'Describe what you want to build';
    cancelAnimationFrame(coachRaf);
    if (tourStep && onScreen) followCoach();
  }
  coach.addEventListener('click', e => {
    if (e.target.closest('[data-coach="skip"]')) { tourOff = true; sfx.play('close'); updateTour(); return; }
    if (!e.target.closest('[data-coach="act"]')) return;
    sfx.play('tick');
    TOUR[tourStep]?.act?.[1]();
  });
  new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    if (onScreen && !tourOn) setTimeout(() => { tourOn = true; updateTour(); }, 900);
    else updateTour();
  }, { threshold: 0.35 }).observe(root);

  /* ================= First paint: index.html and its styles, ready to preview ================= */
  openDirs.clear();
  applyLayout();
  renderTabs();
  renderEditor();
  renderSide();
  renderBadge();
  onCaret();
  document.fonts?.ready.then(() => { measured = false; paint(); });
})();
