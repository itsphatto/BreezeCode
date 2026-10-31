/* ================= Platform (desktop bridge or in-browser demo) ================= */
const DEMO_FILES: Record<string, string> = {
  'index.html': `<!-- Brewed by Breeze -->
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Ember &amp; Oak Coffee</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="hero">
    <h1>Ember &amp; Oak</h1>
    <p>Slow coffee for fast mornings.</p>
    <a href="#menu" class="cta">See the menu</a>
  </header>
  <section id="menu"></section>
  <script src="script.js"></script>
</body>
</html>
`,
  'styles.css': `/* Cozy, warm palette */
:root {
  --bean: #2b1d12;
  --cream: #f4ece1;
  --ember: #c2410c;
}
body { margin: 0; font-family: Georgia, serif; background: var(--cream); color: var(--bean); }
.hero {
  padding: 96px 24px;
  text-align: center;
}
.cta { background: var(--ember); color: #fff; padding: 10px 18px; border-radius: 999px; }
`,
  'script.js': `// Small touch: greet by time of day
const h = new Date().getHours();
const hello = h < 12 ? "Good morning" : "Hey there";
document.querySelector(".hero p").prepend(hello + ". ");
`,
  '.env': `# Protected — Breeze's local agent can't read this
MAPS_KEY=demo-key-not-real
`,
  'assets/beans.jpg': '',
};
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i;
// Browser preview: a drawn stand-in for the demo project's photo.
const bean = ([x, y, r]: number[]) =>
  `<g transform="translate(${x} ${y}) rotate(${r})"><ellipse rx="54" ry="36" fill="#6b4226"/><path d="M-46 0c24-16 68 16 92 0" fill="none" stroke="#2b1d12" stroke-width="7" stroke-linecap="round"/></g>`;
const DEMO_BEANS = [[190, 160, -30], [320, 225, 20], [450, 150, -10], [255, 300, 40], [470, 290, -40]].map(bean).join('');
const DEMO_IMAGE = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#f4ece1"/>${DEMO_BEANS}</svg>`);

let demoRun = 0;
const agentListeners: ((runId: number, ev: AgentEvent) => void)[] = [];
const authListeners: ((ev: AuthEvent) => void)[] = [];
// The file the canned build run creates, so the preview shows a new file typing in.
const DEMO_NEW_FILE = 'menu.js';
const DEMO_NEW_TEXT = [
  '// The menu cards, filled from one list.',
  'const MENU = [',
  "  { name: 'Espresso', price: 3.0 },",
  "  { name: 'Flat white', price: 3.8 },",
  "  { name: 'Oat latte', price: 4.2 },",
  '];',
  "document.querySelector('#menu').innerHTML = MENU",
  "  .map(item => `<article class=\"card\"><h3>${item.name}</h3><p>$${item.price.toFixed(2)}</p></article>`)",
  "  .join('');",
  '',
].join('\n');
// Browser preview: replays a short, canned agent run. `save` writes a file into the demo project.
async function demoReplay(id: number, mode: AgentMode, save: (rel: string, text: string) => void): Promise<void> {
  const steps: [AgentEvent, number, (() => void)?][] = [
    [{ t: 'session', id: 'demo-session', model: 'demo' }, 100],
    [{ t: 'tool', kind: 'read', label: 'Read index.html' }, 600],
    [{ t: 'tool', kind: 'read', label: 'Read styles.css' }, 900],
  ];
  if (mode === 'build') {
    steps.push(
      [{ t: 'tool', kind: 'edit', label: 'Edited styles.css' }, 2500],
      // The new file's text arrives a line at a time, as a local model writes it, then lands on disk.
      ...DEMO_NEW_TEXT.split('\n').map((_, i, lines): [AgentEvent, number] => [{ t: 'draft', path: DEMO_NEW_FILE, text: lines.slice(0, i + 1).join('\n') }, i ? 300 : 1200]),
      [{ t: 'tool', kind: 'edit', label: `Wrote ${DEMO_NEW_FILE}` }, 300, () => save(DEMO_NEW_FILE, DEMO_NEW_TEXT)],
      [{ t: 'file', path: DEMO_NEW_FILE, created: true }, 0],
      [{ t: 'tool', kind: 'run', label: '$ npx prettier --check styles.css' }, 3000],
      [{ t: 'text', text: 'Done — I warmed up the hero colours in styles.css and added menu.js. (Browser preview: no files were really changed.)' }, 2500],
    );
  } else if (mode === 'plan') {
    steps.push(
      [{ t: 'text', text: 'I looked at the page and its styles.' }, 600],
      [{ t: 'plan', text: '1. Make the hero taller with a warm gradient\n2. Turn the menu into three cards\n3. Add a footer with opening hours' }, 500],
    );
  } else {
    steps.push([{ t: 'text', text: 'The page has a hero section, an empty menu section and a small greeting script. (Browser preview answer.)' }, 600]);
  }
  steps.push([{ t: 'done', ok: true, ms: 2400 }, 300]);
  // Each step waits for the one before it.
  await steps.reduce(async (prev, [ev, ms, before]) => {
    await prev;
    await wait(ms);
    before?.();
    agentListeners.forEach(cb => cb(id, ev));
  }, Promise.resolve());
}
// Browser preview: clipboard and selection commands act on the focused field.
async function demoEdit(role: string): Promise<void> {
  const el = document.activeElement;
  // The code editor's text lives in its surface, not in the hidden input that has focus.
  const surface = surfaceOf(el);
  if (surface) {
    const [s, e] = [surface.selectionStart, surface.selectionEnd];
    if (role === 'copy' || role === 'cut') await navigator.clipboard.writeText(surface.value.slice(s, e));
    if (role === 'cut' && e > s) replaceRange(surface, s, e, '');
    else if (role === 'paste') replaceRange(surface, s, e, (await navigator.clipboard.readText()).replace(/\r\n?/g, '\n'));
    return;
  }
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
  const [s, e] = [el.selectionStart ?? 0, el.selectionEnd ?? 0];
  if (role === 'selectAll') el.select();
  else if (role === 'copy' || role === 'cut') {
    await navigator.clipboard.writeText(el.value.slice(s, e));
    if (role === 'cut') el.setRangeText('', s, e, 'end');
  } else if (role === 'paste') el.setRangeText(await navigator.clipboard.readText(), s, e, 'end');
  el.dispatchEvent(new Event('input'));
}

let demoConnectDone: (() => void) | null = null;
function demoApi(): BreezeApi {
  const files = new Map(Object.entries(DEMO_FILES));
  const binary = new Set(['assets/beans.jpg']);
  const dirs = new Set(['assets']);
  let info: RootInfo = { root: 'demo:/coffee-shop-landing', name: 'coffee-shop-landing' };
  let accounts: User[] = [];
  let current: User | null = null;
  const accountKey = (u: User) => u.provider + ':' + (u.login ?? '');
  const under = (p: string, rel: string) => (rel ? p.startsWith(rel + '/') : true);
  const exists = (p: string) => files.has(p) || dirs.has(p);
  const inside = (k: string, rel: string) => k === rel || k.startsWith(rel + '/');
  const needOpen = () => { if (!store.get('breeze.demoOpen', false)) throw new Error('No folder is open'); };
  const feeds = () => store.get<Record<string, boolean>>('breeze.demoVibe', {});
  const markOpened = () => store.set('breeze.demoOpenedAt', Date.now());
  return {
    fs: {
      async importFile(dir, name, data) {
        needOpen();
        const dot = name.lastIndexOf('.');
        const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
        let rel = joinPath(dir, name);
        let n = 1;
        while (exists(rel)) {
          rel = joinPath(dir, `${stem} (${n})${ext}`);
          n++;
        }
        for (let d = dirName(rel); d; d = dirName(d)) dirs.add(d);
        files.set(rel, new TextDecoder().decode(data));
        return rel;
      },


      openFolder() { store.set('breeze.demoOpen', true); markOpened(); return Promise.resolve(info); },
      // Browser preview: a new, empty in-memory project.
      async createFolder() {
        files.clear(); dirs.clear(); binary.clear();
        files.set('README.md', '# My Breeze project\n');
        info = { root: 'demo:/my-breeze-project', name: 'my-breeze-project' };
        store.set('breeze.demoOpen', true);
        markOpened();
        return info;


      },
      // Browser preview: no file dialog, so "Open file" opens the demo project's README and "New file" adds an empty one.
      openFile() { store.set('breeze.demoOpen', true); markOpened(); return Promise.resolve({ ...info, open: 'README.md', launched: true as const }); },
      newFile() {
        let name = 'untitled.txt';
        for (let i = 2; files.has(name); i++) name = `untitled-${i}.txt`;
        files.set(name, '');
        store.set('breeze.demoOpen', true);
        markOpened();
        return Promise.resolve({ ...info, open: name, launched: true as const });
      },
      restore() { return Promise.resolve(store.get('breeze.demoOpen', false) ? info : null); },
      // Explorer can't launch the browser preview.
      openLaunch() { return Promise.resolve(null); },
      onLaunchRequest() { return () => { }; },
      closeFolder() { store.del('breeze.demoOpen'); return Promise.resolve(); },
      // Empty until a folder has been opened, so a first visit starts with no recent projects.
      recent() {
        const at = store.get<number>('breeze.demoOpenedAt', 0);
        return Promise.resolve(at ? [{ path: info.root, name: info.name, openedAt: at }] : []);
      },
      forgetRecent() { store.del('breeze.demoOpenedAt'); return Promise.resolve(); },
      openRecent() { store.set('breeze.demoOpen', true); markOpened(); return Promise.resolve(info); },
      async readDir(rel) {
        needOpen();
        const seen = new Map<string, boolean>();
        const depth = rel ? rel.split('/').length : 0;
        for (const d of dirs) if (under(d, rel) && d.split('/').length === depth + 1) seen.set(baseName(d), true);
        for (const f of files.keys()) if (under(f, rel) && f.split('/').length === depth + 1) seen.set(baseName(f), false);
        return [...seen].map(([name, dir]) => ({ name, dir })).sort(byDirThenName);
      },
      async readFile(rel) {
        if (!files.has(rel)) throw new Error('File not found');
        if (binary.has(rel)) return IMAGE_FILE.test(rel) ? { image: true, size: 48213 } : { binary: true, size: 48213 };
        return { text: files.get(rel), size: (files.get(rel) ?? '').length };
      },
      writeFile(rel, text) { files.set(rel, text); return Promise.resolve(); },
      async createFile(rel) {
        if (exists(rel)) throw new Error('A file with that name already exists');
        files.set(rel, '');
      },
      async createDir(rel) {
        if (exists(rel)) throw new Error('A folder with that name already exists');
        dirs.add(rel);
      },
      async rename(from, to) {
        if (exists(to)) throw new Error('Something with that name already exists');
        const renamed = (k: string) => to + k.slice(from.length);
        // Snapshot the keys first: the maps change while we go.
        const fileKeys = [...files.keys()].filter(k => inside(k, from));
        for (const k of fileKeys) { files.set(renamed(k), files.get(k) ?? ''); files.delete(k); }
        for (const set of [dirs, binary]) {
          const keys = [...set].filter(k => inside(k, from));
          for (const k of keys) { set.delete(k); set.add(renamed(k)); }
        }
      },
      async trash(rel) {
        const gone = [...files.keys(), ...dirs, ...binary].filter(k => inside(k, rel));
        for (const k of gone) { files.delete(k); dirs.delete(k); binary.delete(k); }
        return null; // no undo copies in the browser demo
      },
      async untrash() { throw new Error('Undo delete needs the desktop app'); },
      listFiles() { return Promise.resolve([...files.keys()]); },
      async search(query, matchCase) {
        const out: SearchHit[] = [];
        const needle = matchCase ? query : query.toLowerCase();
        for (const [path, text] of files) {
          if (binary.has(path)) continue;
          text.split('\n').forEach((line, i) => {
            const col = (matchCase ? line : line.toLowerCase()).indexOf(needle);
            if (col !== -1) out.push({ path, line: i, col, text: line });
          });
        }
        return out;
      },
      // No file URLs in the browser: images get a drawn stand-in, everything else ''.
      async fileUrl(rel) { return binary.has(rel) && IMAGE_FILE.test(rel) ? DEMO_IMAGE : ''; },
      async previewUrl() { return ''; },
      onChange() { return () => { }; },
      onWatchLost() { return () => { }; },
    },
    lint: { check() { return Promise.resolve(null); } },
    term: {
      async cwd() { return 'coffee-shop-landing'; },
      async run() { return { error: 'The terminal runs commands only in the Breeze desktop app (npm start).' }; },
      async kill() { /* nothing runs in the browser */ },
      async write() { /* nothing runs in the browser */ },
      async complete(word) {
        const names = [...new Set([...files.keys(), ...dirs].map(p => p.split('/')[0]))];
        return names.filter(n => n.toLowerCase().startsWith(word.toLowerCase())).sort((a, b) => a.localeCompare(b)).map(n => ({ text: dirs.has(n) ? n + '/' : n, dir: dirs.has(n) }));
      },
      onData() { return () => { }; },
      onExit() { return () => { }; },
    },
    run: { file() { return Promise.resolve({ error: 'Programs run only in the Breeze desktop app (npm start).' }); } },
    sys: {
      async detect() {
        await wait(500);
        const llm = store.get<string | null>('breeze.demoLlm', null);
        return {
          demo: true, platform: 'browser',
          agents: [
            { id: 'antigravity', name: 'Antigravity', vendor: 'Google DeepMind', url: 'https://antigravity.google/', found: false, path: null, version: 'claude-sonnet-4-6', models: ['claude-sonnet-4-6', 'gemini-3.8-flash-high', 'claude-opus-4-6-thinking', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low', 'gpt-oss-120b-medium'] },
            { id: 'codex', name: 'Codex', vendor: 'OpenAI', url: 'https://developers.openai.com/codex/cli', found: false, path: null, version: null, install: 'npm install -g @openai/codex' },
            { id: 'claude', name: 'Claude', vendor: 'Anthropic', url: 'https://claude.com/claude-code', found: false, path: null, version: 'default', models: ['default', 'opus', 'sonnet', 'haiku'], install: 'npm install -g @anthropic-ai/claude-code' },
            { id: 'local', name: 'Ollama', vendor: 'Ollama, LM Studio or any OpenAI-compatible server', url: 'https://ollama.com/download', api: true, found: !!llm, path: llm ? 'http://127.0.0.1:11434/v1' : null, version: llm, models: llm ? ['llama3.1', 'qwen2.5-coder'] : [] },
          ],
          tools: [{ id: 'git', name: 'Git', found: true, version: null }, { id: 'node', name: 'Node.js', found: true, version: null },
          { id: 'dotnet', name: 'C#', found: false, version: null, optional: true, hint: 'winget install Microsoft.DotNet.SDK.10', url: 'https://dotnet.microsoft.com/download' }],
        };
      },
      async openExternal(url) { window.open(url, '_blank', 'noopener'); },
      async runCommand(cmd) { window.open('https://www.google.com/search?q=' + encodeURIComponent(cmd)); return true; },
    },
    live: (() => {
      let mockLiveRunning = false;
      return {
        async status() {
          const index = [...files.keys()].find(path => path === 'index.html' || path.endsWith('/index.html'));
          return { available: !!index, running: mockLiveRunning, url: `http://127.0.0.1:2026/${index?.replace(/index\.html$/, '') ?? ''}` };
        },
        async start() {
          const index = [...files.keys()].find(path => path === 'index.html' || path.endsWith('/index.html'));
          if (!index) throw new Error('Live Share needs an index.html file in the project');
          const url = `http://127.0.0.1:2026/${index.replace(/index\.html$/, '')}`;
          window.open(url, '_blank', 'noopener');
          mockLiveRunning = true;
          return { available: true, running: true, url };
        },
        async stop() {
          const index = [...files.keys()].find(path => path === 'index.html' || path.endsWith('/index.html'));
          mockLiveRunning = false;
          return { available: !!index, running: false, url: `http://127.0.0.1:2026/${index?.replace(/index\.html$/, '') ?? ''}` };
        },
      };
    })(),
    // Browser preview only: canned answers so every panel can be tried without the desktop app.
    llm: {
      async connect(url) {
        await wait(500);
        store.set('breeze.demoLlm', 'llama3.1');
        return { url: url.trim() || 'http://127.0.0.1:11434/v1', model: 'llama3.1', models: ['llama3.1', 'qwen2.5-coder'] };
      },
      async setModel(model) { store.set('breeze.demoLlm', model); },
      async disconnect() { store.del('breeze.demoLlm'); },
    },
    agent: {
      async run({ mode }) {
        const id = ++demoRun;
        background(demoReplay(id, mode, (rel, text) => files.set(rel, text)));
        return id;
      },
      async stop() { /* demo runs finish on their own */ },
      async answer() { /* demo runs never ask */ },
      async setModel() { return true; },
      async fullAccess() { return store.get<boolean>('breeze.demoFullAccess', false); },
      async setFullAccess(on) { store.set('breeze.demoFullAccess', on); return on; },
      // Made-up numbers, so the browser preview shows what Settings → Agents looks like.
      async usage() {
        const in2h = Math.floor(Date.now() / 1000) + 7200, in4d = in2h + 4 * 86400;
        return {
          usage: { claude: 182400, codex: 46100 },
          limits: { claude: [{ label: '5-hour', used: 14, resetsAt: in2h }, { label: 'Weekly', used: 69, resetsAt: in4d }], codex: [{ label: 'Monthly', used: 11, resetsAt: in4d }] },
        };
      },
      onEvent(cb) { agentListeners.push(cb); return () => { }; },
    },
    team: {
      async parse(text) { return { shared: text, tasks: [], unknown: [] }; },
      async claim() { throw new Error('Teams need the desktop app'); },
      async start() { throw new Error('Teams need the desktop app'); },
      async stop() { throw new Error('Teams need the desktop app'); },
      async undo() { throw new Error('Teams need the desktop app'); },
    },
    lsp: {
      async open() { return { available: false }; },
      async change() { },
      async close() { },
      async completion() { return []; },
      async hover() { return null; },
      async definition() { return []; },
      async references() { return []; },
      async rename() { return {}; },
    },
    git: {
      async status() {
        return {
          repo: true, branch: 'main', upstream: 'origin/main', ahead: 1, behind: 1, incoming: ['index.html', 'script.js'], hasCommits: true, hasRemote: true,
          files: [{ path: 'styles.css', x: ' ', y: 'M' }, { path: 'index.html', x: 'M', y: ' ' }, { path: 'assets/new-logo.svg', x: '?', y: '?' }], ignored: []
        };
      },
      async log() {
        const commits = [
          { hash: 'd4f0b19aa', parents: ['b72e1d0aa'], author: 'You', when: '3 minutes ago', refs: ['HEAD -> main'], subject: 'Greeting script' },
          { hash: 'c3d5a8eaa', parents: ['b72e1d0aa'], author: 'You', when: '6 minutes ago', refs: ['try-dark-menu'], subject: 'Try dark menu' },
          { hash: 'b72e1d0aa', parents: ['a91f3c2aa'], author: 'You', when: '9 minutes ago', refs: [], subject: 'Add base styles' },
          { hash: 'a91f3c2aa', parents: [], author: 'You', when: '12 minutes ago', refs: ['origin/main'], subject: 'Start project' },
        ];
        return {
          head: 'd4f0b19aa',
          commits,
          details: commits.map(c => ({
            hash: c.hash, author: c.author, email: 'you@example.com', when: c.when, message: c.subject, files: [{ path: 'styles.css', added: 11, removed: 2 }]
          }))
        };
      },
      async show(hash) { return { hash, author: 'You', email: 'you@example.com', when: 'a few minutes ago', message: 'Demo checkpoint', files: [{ path: 'styles.css', added: 11, removed: 2 }] }; },
      async headText() { return null; },
      async diff() { return '@@ -1,3 +1,3 @@\n /* Cozy, warm palette */\n-:root {\n+:root { /* demo change */\n   --bean: #2b1d12;'; },
      async init() { return ''; },
      async stage() { return ''; },
      async unstage() { return ''; },
      async discard() { /* nothing to discard in the demo */ },
      async commit() { throw new Error('Checkpoints are saved with git in the desktop app.'); },
      async branches() { return ['main', 'try-dark-menu']; },
      async switchTo() { throw new Error('Switching branches works in the desktop app.'); },
      async deleteBranch() { throw new Error('Deleting branches works in the desktop app.'); },
      async sync() { throw new Error('Push and pull work in the desktop app.'); },
      async genCommitMsg() { return 'feat: demo change'; },
    },
    auth: {
      async user() { return current; },
      async accounts() { return { accounts, active: current ? accountKey(current) : null }; },
      async switchTo(id) {
        const u = accounts.find(a => accountKey(a) === id);
        if (!u) throw new Error('That account is no longer signed in');
        current = u;
        return u;
      },
      async start(provider) {
        const n = accounts.filter(a => a.provider === provider).length + 1;
        const user: User = { provider, name: `Demo ${provider} ${n}`, login: 'demo' + n };
        setTimeout(() => {
          accounts = [...accounts, user];
          current = user;
          authListeners.forEach(cb => cb({ t: 'done', user }));
        }, 1400);
        return { started: true };
      },
      async cancel() { /* the demo sign-in finishes by itself */ },
      async signOut() {
        accounts = accounts.filter(a => a !== current);
        current = accounts[0] ?? null;
        return current;
      },
      async remove(id) {
        accounts = accounts.filter(a => accountKey(a) !== id);
        if (current && accountKey(current) === id) current = accounts[0] ?? null;
        return current;
      },
      onEvent(cb) { authListeners.push(cb); return () => { }; },
    },
    // Browser preview: "connecting" opens the site in a new tab; the feed itself only plays in the desktop app.
    vibe: {
      async status() { return feeds(); },
      async connect(id) {
        const site = SOCIAL_SITES.find(s => s.id === id);
        if (site) window.open(site.url, '_blank', 'noopener');
        store.set('breeze.demoVibe', { ...feeds(), [id]: true });
        // The desktop app resolves when the sign-in view is closed; the preview waits for the close button too.
        return new Promise<boolean>(resolve => { demoConnectDone = () => resolve(true); });
      },
      async connectBounds() { /* no view in the browser */ },
      async connectClose() { demoConnectDone?.(); demoConnectDone = null; },
      async disconnect(id) { store.set('breeze.demoVibe', { ...feeds(), [id]: false }); },
      async show() { /* placeholder only */ },
      async bounds() { /* placeholder only */ },
      async mute() { /* placeholder only */ },
      async hide() { /* placeholder only */ },
    },
    discord: {
      async set() { return { user: null }; },
      async clear() { /* nothing to clear in the browser */ },
    },
    // Sync needs an account's cloud, which only the desktop app reaches.
    sync: {
      async status() { return { error: 'Workspace sync works in the desktop app.', code: 'demo' }; },
      async run() { return { error: 'Workspace sync works in the desktop app.', code: 'demo' }; },
      async clone() { return { error: 'Workspace sync works in the desktop app.', code: 'demo' }; },
      async settings() { return { error: 'Workspace sync works in the desktop app.', code: 'demo' }; },
    },
    win: {
      async reload() { location.reload(); },
      async toggleDevTools() { toast('Developer tools are available in the desktop app'); },
      async quit() { window.close(); },
      edit: demoEdit,
      async theme() { /* the browser draws its own title bar */ },
      // Nor are there window buttons: the page shows none in the browser.
      async minimize() { /* */ },
      async toggleMaximize() { /* */ },
      async close() { window.close(); },
      async isMaximized() { return false; },
      onMaximized() { return () => { /* */ }; },
      // No splash window in the browser: the page plays the whole launch itself (init.ts).
      async launchWait() { return null; },
      async launchShow() { /* the page is already showing */ },
      async launchFade() { /* nothing to fade over */ },
    },
  };
}

// The feeds Vibe Mode can play. Sign-in and the feed itself are handled by main.js in the desktop app.
interface SocialSite { id: string; name: string; mark: string; url: string; }
const SOCIAL_SITES: SocialSite[] = [
  { id: 'instagram', name: 'Instagram Reels', mark: '◎', url: 'https://www.instagram.com/reels/' },
  { id: 'facebook', name: 'Facebook Reels', mark: 'f', url: 'https://www.facebook.com/reel/' },
];

// Brand artwork for agents and feeds, keyed by the same id as the tint class. Anything without a file falls back to its letter or symbol.
const BRAND_ICONS: Record<string, string> = {
  codex: 'codex.png',
  claude: 'claude.svg',
  antigravity: 'antigravity.png',
  instagram: 'instagram.png', facebook: 'facebook.png',
  local: 'ollama.svg',
  ollama: 'ollama.svg',
};
// Logos that are a shape rather than a square tile; they show whole instead of clipped to the tile's corners.
const BARE_ICONS = new Set(['facebook']);
function brandMark(cls: string, id: string, fallback: string): string {
  const file = BRAND_ICONS[id];
  const inner = file ? `<img class="brand-img" src="../../assets/icons/${file}" alt="" draggable="false">` : esc(fallback);
  return `<span class="${cls} tint-${id}${file ? ' has-img' : ''}${file && BARE_ICONS.has(id) ? ' bare' : ''}">${inner}</span>`;
}

/* ----- Line icons: 24×24 grid in Lucide's IconNode format, so morphicons can morph one into another ----- */
type IconNode = ReadonlyArray<readonly [string, Record<string, string | number>]>;
const SPEAKER = 'M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z';
const LINE_ICONS: Record<string, IconNode> = {
  plus: [['path', { d: 'M5 12h14' }], ['path', { d: 'M12 5v14' }]],
  minus: [['path', { d: 'M5 12h14' }]],
  x: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]],
  check: [['path', { d: 'M20 6 9 17l-5-5' }]],
  external: [['path', { d: 'M7 7h10v10' }], ['path', { d: 'M7 17 17 7' }]],
  rotateCcw: [['path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }], ['path', { d: 'M3 3v5h5' }]],
  rotateCw: [['path', { d: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8' }], ['path', { d: 'M21 3v5h-5' }]],
  squareMinus: [['rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }], ['path', { d: 'M8 12h8' }]],
  // The window's maximize and restore marks, edge to edge like Minimize and Close beside them; one morphs into the other.
  winMaximize: [['rect', { x: 1.2, y: 1.2, width: 21.6, height: 21.6, rx: 3.6 }]],
  winRestore: [['rect', { x: 1.2, y: 6, width: 16.8, height: 16.8, rx: 3.6 }], ['path', { d: 'M6 1.2h13.2a3.6 3.6 0 0 1 3.6 3.6V18' }]],
  undo: [['path', { d: 'M9 14 4 9l5-5' }], ['path', { d: 'M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11' }]],
  stop: [['rect', { x: 6, y: 6, width: 12, height: 12, rx: 2, fill: 'currentColor' }]],
  play: [['path', { d: 'M6 3l14 9-14 9z', fill: 'currentColor' }]],
  send: [['path', { d: 'M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z' }], ['path', { d: 'M6 12h16' }]],
  more: [['circle', { cx: 12, cy: 12, r: 1 }], ['circle', { cx: 19, cy: 12, r: 1 }], ['circle', { cx: 5, cy: 12, r: 1 }]],
  up: [['path', { d: 'm5 12 7-7 7 7' }], ['path', { d: 'M12 19V5' }]],
  arrowLeftRight: [['path', { d: 'M8 3 4 7l4 4' }], ['path', { d: 'M4 7h16' }], ['path', { d: 'm16 21 4-4-4-4' }], ['path', { d: 'M20 17H4' }]],
  columns: [['rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }], ['path', { d: 'M12 3v18' }]],
  down: [['path', { d: 'M12 5v14' }], ['path', { d: 'm19 12-7 7-7-7' }]],
  chevronRight: [['path', { d: 'm9 18 6-6-6-6' }]],
  chevronDown: [['path', { d: 'm6 9 6 6 6-6' }]],
  chevronLeft: [['path', { d: 'm15 18-6-6 6-6' }]],
  sparkles: [['path', { d: 'm12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z' }], ['path', { d: 'M5 3v4' }], ['path', { d: 'M19 17v4' }], ['path', { d: 'M3 5h4' }], ['path', { d: 'M17 19h4' }]],
  backspace: [['path', { d: 'M10 5a2 2 0 0 0-1.344.519l-6.328 5.74a1 1 0 0 0 0 1.481l6.328 5.741A2 2 0 0 0 10 19h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z' }], ['path', { d: 'm12 9 6 6' }], ['path', { d: 'm18 9-6 6' }]],
  volume: [['path', { d: SPEAKER }], ['path', { d: 'M16 9a5 5 0 0 1 0 6' }], ['path', { d: 'M19.364 18.364a9 9 0 0 0 0-12.728' }]],
  volumeOff: [['path', { d: SPEAKER }], ['path', { d: 'm22 9-6 6' }], ['path', { d: 'm16 9 6 6' }]],
  volumeMin: [['path', { d: SPEAKER }]],
  volumeLow: [['path', { d: SPEAKER }], ['path', { d: 'M16 9a5 5 0 0 1 0 6' }]],
  eye: [['path', { d: 'M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
  gear: [['path', { d: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
  user: [['path', { d: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2' }], ['circle', { cx: 12, cy: 7, r: 4 }]],
  pencil: [['path', { d: 'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z' }], ['path', { d: 'm15 5 4 4' }]],
  terminal: [['path', { d: 'M4 17l6-6-6-6' }], ['path', { d: 'M12 19h8' }]],
  code: [['path', { d: 'm16 18 6-6-6-6' }], ['path', { d: 'm8 6-6 6 6 6' }]],
  search: [['circle', { cx: 11, cy: 11, r: 8 }], ['path', { d: 'm21 21-4.3-4.3' }]],
  globe: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20' }], ['path', { d: 'M2 12h20' }]],
  todo: [['path', { d: 'm3 17 2 2 4-4' }], ['path', { d: 'm3 7 2 2 4-4' }], ['path', { d: 'M13 6h8' }], ['path', { d: 'M13 12h8' }], ['path', { d: 'M13 18h8' }]],
  diamond: [['path', { d: 'M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z' }]],
  dot: [['circle', { cx: 12, cy: 12, r: 2 }]],
  info: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M12 16v-4' }], ['path', { d: 'M12 8h.01' }]],
  keyboard: [['rect', { x: 2, y: 5, width: 20, height: 14, rx: 2 }], ['path', { d: 'M6 9h.01M10 9h.01M14 9h.01M18 9h.01M8 13h.01M12 13h.01M16 13h.01M7 16h10' }]],
  palette: [['path', { d: 'M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z' }], ['circle', { cx: 13.5, cy: 6.5, r: .5, fill: 'currentColor' }], ['circle', { cx: 17.5, cy: 10.5, r: .5, fill: 'currentColor' }], ['circle', { cx: 6.5, cy: 12.5, r: .5, fill: 'currentColor' }], ['circle', { cx: 8.5, cy: 7.5, r: .5, fill: 'currentColor' }]],
  alert: [['path', { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' }], ['path', { d: 'M12 9v4' }], ['path', { d: 'M12 17h.01' }]],
  circleX: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'm15 9-6 6' }], ['path', { d: 'm9 9 6 6' }]],
  gitBranch: [['path', { d: 'M6 3v12' }], ['circle', { cx: 18, cy: 6, r: 3 }], ['circle', { cx: 6, cy: 18, r: 3 }], ['path', { d: 'M18 9a9 9 0 0 1-9 9' }]],
  circle: [['circle', { cx: 12, cy: 12, r: 9 }]],
  copy: [['rect', { x: 8, y: 8, width: 14, height: 14, rx: 2 }], ['path', { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' }]],
  download: [['path', { d: 'M12 15V3' }], ['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }], ['path', { d: 'm7 10 5 5 5-5' }]],
  circleDot: [['circle', { cx: 12, cy: 12, r: 9 }], ['circle', { cx: 12, cy: 12, r: 3, fill: 'currentColor' }]],
  phone: [['rect', { x: 5, y: 2, width: 14, height: 20, rx: 2 }], ['path', { d: 'M12 18h.01' }]],
  trash: [['path', { d: 'M3 6h18' }], ['path', { d: 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6' }], ['path', { d: 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2' }], ['path', { d: 'M10 11v6' }], ['path', { d: 'M14 11v6' }]],
  folder: [['path', { d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z' }]],
  folderPlus: [['path', { d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z' }], ['path', { d: 'M12 10v6' }], ['path', { d: 'M9 13h6' }]],
  file: [['path', { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' }], ['path', { d: 'M14 2v4a2 2 0 0 0 2 2h4' }]],
  filePlus: [['path', { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' }], ['path', { d: 'M14 2v4a2 2 0 0 0 2 2h4' }], ['path', { d: 'M12 12v6' }], ['path', { d: 'M9 15h6' }]],
};
const formatAttr = ([k, v]: [string, string | number]): string => `${k}="${v}"`;
const iconBody = (name: string): string =>
  (LINE_ICONS[name] ?? LINE_ICONS.dot)
    .map(([tag, a]) => {
      const attrs = Object.entries(a).map(formatAttr).join(' ');
      return `<${tag} ${attrs}/>`;
    })
    .join('');
// The speaker shows the level: muted, then no, one or two waves.
const volumeIcon = (v: number): string => (v <= 0 ? 'volumeOff' : v < 34 ? 'volumeMin' : v < 67 ? 'volumeLow' : 'volume');
function svgIcon(name: string, size = 16): string {
  return `<svg class="ico-svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-icon="${name}" aria-hidden="true">${iconBody(name)}</svg>`;
}
// Fills the empty <svg data-i="name"> placeholders written in breeze.html.
function paintIcons(root: ParentNode = document): void {
  root.querySelectorAll<SVGSVGElement>('svg[data-i]').forEach(s => {
    const name = s.dataset.i ?? 'dot';
    const size = s.dataset.size ?? '16';
    s.classList.add('ico-svg');
    for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, v);
    s.dataset.icon = name;
    s.innerHTML = iconBody(name);
    delete s.dataset.i;
  });
}
// A control that changes state morphs its icon; without the library (or offline) the icon just swaps.
interface MorphHandle { morphTo(icon: IconNode, spring?: 'smooth' | 'snappy' | 'bouncy'): void; set(icon: IconNode): void; }
interface MorphLib { createMorph(el: Element, icon: IconNode, options?: { strokeWidth?: number }): MorphHandle; }
// From the page (src/renderer/breeze.html) up to the app root's node_modules. Resolved against the page: a bare
// relative import() resolves against this script's own folder.
const MORPH_URL = new URL('../../node_modules/morphicons/dist/dom.js', document.baseURI).href;
let morphLib: Promise<MorphLib | null> | null = null;
const loadMorph = (): Promise<MorphLib | null> => (morphLib ??= import(MORPH_URL).catch(() => null));
const morphs = new WeakMap<Element, MorphHandle>();
paintIcons();
void loadMorph(); // loaded up front, so the first morph starts on the frame its control shows
// Shows `from` and morphs into the icon the control already has: a view's header taking over from the last one's.
// Snappy, so it settles in about a fifth of a second. Without the library the icon simply stays.
async function morphIconFrom(host: Element, from: string): Promise<void> {
  const svg = host.querySelector<SVGSVGElement>('svg.ico-svg');
  const name = svg?.dataset.icon;
  if (!svg || !name || from === name || !LINE_ICONS[from] || !LINE_ICONS[name]) return;
  const lib = await loadMorph();
  if (!lib) return;
  let m = morphs.get(svg);
  if (m) m.set(LINE_ICONS[from]);
  else {
    svg.innerHTML = '<path/>';
    m = lib.createMorph(svg.firstElementChild as Element, LINE_ICONS[from], { strokeWidth: 2 });
    morphs.set(svg, m);
  }
  m.morphTo(LINE_ICONS[name], 'snappy');
}
async function setIcon(host: Element, name: string): Promise<void> {
  const svg = host.querySelector<SVGSVGElement>('svg.ico-svg');
  if (!svg || svg.dataset.icon === name || !LINE_ICONS[name]) return;
  const from = svg.dataset.icon ?? name;
  svg.dataset.icon = name;
  // The speaker gives a little bounce as its waves change: bigger going louder, a dip going quieter or muted.
  if (name.startsWith('volume') && from.startsWith('volume') && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const rank = (n: string) => ['volumeOff', 'volumeMin', 'volumeLow', 'volume'].indexOf(n);
    const up = rank(name) > rank(from);
    svg.animate([
      { transform: 'scale(1) rotate(0)' },
      { transform: up ? 'scale(1.28) rotate(-8deg)' : 'scale(.74) rotate(6deg)', offset: .4 },
      { transform: 'scale(1) rotate(0)' },
    ], { duration: 380, easing: 'cubic-bezier(.3, 1.4, .5, 1)' });
  }
  const lib = await loadMorph();
  if (!lib) { svg.innerHTML = iconBody(name); return; }
  let m = morphs.get(svg);
  if (!m) {
    svg.innerHTML = '<path/>';
    m = lib.createMorph(svg.firstElementChild as Element, LINE_ICONS[from] ?? LINE_ICONS[name], { strokeWidth: 2 });
    morphs.set(svg, m);
  }
  m.morphTo(LINE_ICONS[name]);
}

const isDesktop = !!window.breeze;
const api: BreezeApi = window.breeze ?? demoApi();

// How blocks glide when the window maximizes or restores (here) and when that reflows Home (glideOnReflow, setup.ts).
// For about 100 ms Windows plays its own transition with the old frame, while the page's frames go unseen; a glide that
// started at once was well along by the time it showed, and leapt. So each block holds where it was for that long, then
// eases off gently and settles softly.
const WIN_GLIDE: KeyframeAnimationOptions = { duration: 420, delay: 100, fill: 'backwards', easing: 'cubic-bezier(.4, 0, .2, 1)' };

/* ----- Window buttons: drawn by the page on Windows and Linux, so they match it; macOS keeps its traffic lights ----- */
if (isDesktop && api.platform !== 'darwin') {
  document.documentElement.classList.add('own-win-controls');
  $('#winControls').classList.remove('hidden');
  const max = $('#winMax');
  const showMaximized = (on: boolean) => {
    void setIcon(max, on ? 'winRestore' : 'winMaximize'); // morphs between the square and the two squares
    max.title = on ? 'Restore' : 'Maximize';
    max.setAttribute('aria-label', max.title);
  };
  // Maximizing, restoring or snapping, every block glides from where it stood to where the new size puts it, instead
  // of jumping: Home's content with its centring, the agents panel with the window's right edge, and so on. A scale of
  // the whole screen couldn't do this: these changes usually move only one side (the height stays), so scaling evenly
  // pushed the bottom of the page off and back, and Windows shows the old frame, cropped, until the first new one.
  // Blocks that reflow inside Home glide on their own (glideOnReflow, setup.ts). None of these nest in one another.
  const GLIDE = ['.ob-step:not(.hidden)', '#homeProfile', '.titlebar > *', '.main > *', '.work > *', '.term-head > *', '.statusbar > *',
    '#editorEmpty > div', '#box > *', '.box-bar > *'].join(', ');
  // Places are kept in the window, not on the screen: until the first new frame, Windows shows the old one drawn at the
  // window's new corner, so each block starts from exactly where that frame shows it.
  let placed = new Map<Element, DOMRect>();
  const notePlaces = () => {
    placed = new Map([...document.querySelectorAll(GLIDE)].filter(el => el.getClientRects().length).map(el => [el, el.getBoundingClientRect()]));
  };
  const glide = () => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (const [el, was] of placed) {
      if (!el.isConnected || !el.getClientRects().length) continue;
      const now = el.getBoundingClientRect(), dx = was.left - now.left, dy = was.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], WIN_GLIDE);
    }
  };
  // Where everything stands is noted while the window is still: right before the buttons act, and every second
  // otherwise (a double-click on the title bar, Win+Up or a snap gives no warning).
  setInterval(() => { if (!document.documentElement.classList.contains('win-resizing')) notePlaces(); }, 1000);
  $('#winMin').onclick = () => background(api.win.minimize());
  max.onclick = () => { notePlaces(); background(api.win.toggleMaximize()); };
  $('#winClose').onclick = () => background(api.win.close());
  api.win.onMaximized(showMaximized);
  background(api.win.isMaximized().then(showMaximized));
  // Watched with a ResizeObserver, not the resize event: Chromium paints the first frame at the new size before the
  // event fires, so that frame showed the new layout and the next jumped back; an observer hears of the new size in
  // the same frame, before it's painted. A maximize, restore or snap is one big jump after a quiet moment; dragging
  // the window's edge is a run of small steps, which never glides.
  let seen = { w: innerWidth, h: innerHeight }; // the last size handled, so the observer and the event never both act
  let lastResize = -Infinity;
  let settle: TimeoutId | undefined;
  const onSize = () => {
    const size = { w: innerWidth, h: innerHeight };
    if (size.w === seen.w && size.h === seen.h) return;
    seen = size;
    markWinResizing(); // the panels, text and chips inside take their new sizes at once (layout.ts)
    const now = performance.now();
    if (now - lastResize > 250) glide();
    lastResize = now;
    clearTimeout(settle);
    settle = setTimeout(notePlaces, 700); // once the glide is done
  };
  new ResizeObserver(onSize).observe(document.documentElement);
  addEventListener('resize', onSize); // a change the observer didn't see (the page's height didn't follow the window's)
  setTimeout(notePlaces, 0);
}
const appVersion = api.version || '0.5.2';

