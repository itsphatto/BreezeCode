"use strict";
/* Breeze Code — renderer logic.
   Files, search, terminal and agent detection are real in the desktop app (main.js + preload.js).
   Opened in a plain browser, a small in-memory demo project stands in for the disk.
   Agent conversations, checkpoints and collaboration are still simulated. */
/* ================= Helpers ================= */
function $(s, r = document) {
    return r.querySelector(s);
}
function $$(s, r = document) {
    return [...r.querySelectorAll(s)];
}
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const esc = (s) => s.replaceAll(/[&<>]/g, c => ESCAPES[c]);
const escAttr = (s) => esc(s).replaceAll('"', '&quot;');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
const dirName = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const joinPath = (dir, name) => (dir ? `${dir}/${name}` : name);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// IPC errors arrive as "Error invoking remote method 'x': Error: message" — keep only the message.
const errMsg = (e) => {
    const text = e instanceof Error ? e.message : String(e);
    return text.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
};
// Folders first, then names A–Z.
const byDirThenName = (a, b) => {
    if (a.dir !== b.dir)
        return a.dir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
};
function toast(text) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    $('#toastRoot').replaceChildren(t);
    sfx.play('ping');
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 200); }, 2600);
}
// Starts async work without waiting for it; a failure shows as a toast.
function background(work) {
    work.catch(e => toast(errMsg(e)));
}
const store = {
    get(key, fallback) {
        try {
            const v = localStorage.getItem(key);
            return v == null ? fallback : JSON.parse(v);
        }
        catch {
            return fallback;
        }
    },
    set(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        }
        catch { /* storage blocked or full */ }
    },
    del(key) {
        try {
            localStorage.removeItem(key);
        }
        catch { /* storage blocked */ }
    },
};
/* ================= Sound effects ================= */
// The website's sounds (BreezeCode-Web/sfx.js): tiny synthesized blips, no audio files. Nothing plays until the
// first click or key press, and the speaker button in the status bar (or Settings › Sound Effects) turns them off.
const sfx = (() => {
    let on = store.get('breeze.sound', true);
    let volume = store.get('breeze.volume', 50); // 0–100; the middle is the old fixed level
    let ctx = null;
    let master = null;
    let lastAt = -Infinity; // when any sound last played, so a button that makes its own sound doesn't also click
    // Audio may only start after a gesture, so the context is made on the first one.
    function unlock() {
        if (ctx)
            return;
        try {
            ctx = new AudioContext();
            master = ctx.createGain();
            master.gain.value = volume / 100;
            master.connect(ctx.destination);
        }
        catch {
            ctx = null;
        } // no audio available
    }
    for (const t of ['pointerdown', 'keydown'])
        addEventListener(t, unlock, { capture: true, passive: true });
    // One blip: a pitch (optionally sliding) with a fast attack and a fade-out.
    function tone(freq, dur, { type = 'sine', vol = 0.1, to = freq, at = 0 } = {}) {
        const c = ctx;
        const t0 = c.currentTime + at;
        const osc = c.createOscillator();
        const g = c.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t0);
        if (to !== freq)
            osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(vol, t0 + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(g).connect(master);
        osc.start(t0);
        osc.stop(t0 + dur + 0.02);
    }
    const secureRandom = () => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] / 4294967296; };
    const jitter = (n) => 1 + (secureRandom() - 0.5) * n;
    const SOUNDS = {
        click: () => tone(1500 * jitter(0.06), 0.05, { to: 900, vol: 0.09 }),
        hover: () => tone(2400, 0.025, { vol: 0.025 }),
        key: () => tone(1900 * jitter(0.25), 0.022, { type: 'triangle', vol: 0.035 }),
        tab: () => tone(520, 0.08, { to: 760, vol: 0.09 }),
        close: () => tone(720, 0.08, { to: 420, vol: 0.08 }),
        menu: () => tone(420, 0.09, { to: 640, type: 'triangle', vol: 0.07 }),
        whoosh: () => { tone(300, 0.16, { to: 900, type: 'triangle', vol: 0.05 }); tone(150, 0.16, { to: 450, vol: 0.05 }); },
        save: () => { tone(660, 0.12, { vol: 0.09 }); tone(990, 0.2, { vol: 0.09, at: 0.09 }); },
        tick: () => tone(1250, 0.03, { type: 'triangle', vol: 0.06 }),
        ping: () => tone(880, 0.16, { vol: 0.08, to: 920 }),
        // Agent chat
        send: () => tone(480, 0.12, { to: 1000, type: 'triangle', vol: 0.07 }),
        msg: () => tone(640, 0.09, { to: 470, vol: 0.07 }),
        tool: () => tone(1500 * jitter(0.1), 0.03, { type: 'triangle', vol: 0.035 }),
        plan: () => [523, 659, 784].forEach((f, i) => tone(f, 0.16, { vol: 0.07, at: i * 0.08 })),
        approve: () => { tone(523, 0.12, { type: 'triangle', vol: 0.08 }); tone(784, 0.2, { type: 'triangle', vol: 0.08, at: 0.07 }); },
        build: () => tone(200, 0.35, { to: 620, type: 'sawtooth', vol: 0.03 }),
        success: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i === 3 ? 0.4 : 0.14, { vol: 0.08, at: i * 0.09 })),
        launch: () => { tone(330, 0.16, { to: 660, type: 'triangle', vol: 0.08 }); tone(1320, 0.05, { vol: 0.05, at: 0.14 }); },
    };
    // Fast repeating sounds (typing, tool lines) are spaced out so they stay ticks and don't buzz.
    const GAP = { key: 30, tool: 40 };
    const last = {};
    function play(name) {
        if (!on || !volume || !ctx || document.hidden)
            return;
        if (ctx.state === 'suspended')
            void ctx.resume();
        const now = performance.now();
        const gap = GAP[name];
        if (gap) {
            if (now - (last[name] ?? -Infinity) < gap)
                return;
            last[name] = now;
        }
        lastAt = now;
        SOUNDS[name]();
    }
    // The menu item mutes; the slider in Settings → General sets the level (0 is silent).
    function toggle() {
        unlock();
        on = !on;
        store.set('breeze.sound', on);
        play('tick');
    }
    function setVolume(v) {
        unlock();
        volume = Math.max(0, Math.min(100, Math.round(v)));
        store.set('breeze.volume', volume);
        if (volume && !on) {
            on = true;
            store.set('breeze.sound', on);
        }
        if (master)
            master.gain.value = volume / 100;
    }
    // Buttons click and hover like the website's; one that just made its own sound (send, a menu opening) stays quiet.
    document.addEventListener('click', e => {
        const el = e.target.closest?.('.btn, .pill-btn, .mode-card, .seg button');
        if (el && performance.now() - lastAt > 60)
            play('click');
    });
    document.addEventListener('pointerover', e => {
        if (e.pointerType !== 'mouse')
            return;
        const el = e.target.closest?.('.btn');
        if (el && !el.contains(e.relatedTarget))
            play('hover');
    });
    return { play, toggle, setVolume, get on() { return on; }, get volume() { return on ? volume : 0; } };
})();
/* ================= Platform (desktop bridge or in-browser demo) ================= */
const DEMO_FILES = {
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
const bean = ([x, y, r]) => `<g transform="translate(${x} ${y}) rotate(${r})"><ellipse rx="54" ry="36" fill="#6b4226"/><path d="M-46 0c24-16 68 16 92 0" fill="none" stroke="#2b1d12" stroke-width="7" stroke-linecap="round"/></g>`;
const DEMO_BEANS = [[190, 160, -30], [320, 225, 20], [450, 150, -10], [255, 300, 40], [470, 290, -40]].map(bean).join('');
const DEMO_IMAGE = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#f4ece1"/>${DEMO_BEANS}</svg>`);
let demoRun = 0;
const agentListeners = [];
const authListeners = [];
// Browser preview: replays a short, canned agent run.
async function demoReplay(id, mode) {
    const steps = [
        [{ t: 'session', id: 'demo-session', model: 'demo' }, 100],
        [{ t: 'tool', kind: 'read', label: 'Read index.html' }, 600],
        [{ t: 'tool', kind: 'read', label: 'Read styles.css' }, 900],
    ];
    if (mode === 'build') {
        steps.push([{ t: 'tool', kind: 'edit', label: 'Edited styles.css' }, 2500], [{ t: 'tool', kind: 'run', label: '$ npx prettier --check styles.css' }, 3000], [{ t: 'text', text: 'Done — I warmed up the hero colours in styles.css. (Browser preview: no files were really changed.)' }, 2500]);
    }
    else if (mode === 'plan') {
        steps.push([{ t: 'text', text: 'I looked at the page and its styles.' }, 600], [{ t: 'plan', text: '1. Make the hero taller with a warm gradient\n2. Turn the menu into three cards\n3. Add a footer with opening hours' }, 500]);
    }
    else {
        steps.push([{ t: 'text', text: 'The page has a hero section, an empty menu section and a small greeting script. (Browser preview answer.)' }, 600]);
    }
    steps.push([{ t: 'done', ok: true, ms: 2400 }, 300]);
    // Each step waits for the one before it.
    await steps.reduce(async (prev, [ev, ms]) => {
        await prev;
        await wait(ms);
        agentListeners.forEach(cb => cb(id, ev));
    }, Promise.resolve());
}
// Browser preview: clipboard and selection commands act on the focused field.
async function demoEdit(role) {
    const el = document.activeElement;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement))
        return;
    const [s, e] = [el.selectionStart ?? 0, el.selectionEnd ?? 0];
    if (role === 'selectAll')
        el.select();
    else if (role === 'copy' || role === 'cut') {
        await navigator.clipboard.writeText(el.value.slice(s, e));
        if (role === 'cut')
            el.setRangeText('', s, e, 'end');
    }
    else if (role === 'paste')
        el.setRangeText(await navigator.clipboard.readText(), s, e, 'end');
    el.dispatchEvent(new Event('input'));
}
function demoApi() {
    const files = new Map(Object.entries(DEMO_FILES));
    const binary = new Set(['assets/beans.jpg']);
    const dirs = new Set(['assets']);
    let info = { root: 'demo:/coffee-shop-landing', name: 'coffee-shop-landing' };
    let accounts = [];
    let current = null;
    const accountKey = (u) => u.provider + ':' + (u.login ?? '');
    const under = (p, rel) => (rel ? p.startsWith(rel + '/') : true);
    const exists = (p) => files.has(p) || dirs.has(p);
    const inside = (k, rel) => k === rel || k.startsWith(rel + '/');
    const needOpen = () => { if (!store.get('breeze.demoOpen', false))
        throw new Error('No folder is open'); };
    const feeds = () => store.get('breeze.demoVibe', {});
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
                for (let d = dirName(rel); d; d = dirName(d))
                    dirs.add(d);
                files.set(rel, new TextDecoder().decode(data));
                return rel;
            },
            openFolder() { store.set('breeze.demoOpen', true); return Promise.resolve(info); },
            // Browser preview: a new, empty in-memory project.
            async createFolder() {
                files.clear();
                dirs.clear();
                binary.clear();
                files.set('README.md', '# My Breeze project\n');
                info = { root: 'demo:/my-breeze-project', name: 'my-breeze-project' };
                store.set('breeze.demoOpen', true);
                return info;
            },
            restore() { return Promise.resolve(store.get('breeze.demoOpen', false) ? info : null); },
            closeFolder() { store.del('breeze.demoOpen'); return Promise.resolve(); },
            recent() { return Promise.resolve([{ path: info.root, name: info.name }]); },
            openRecent() { store.set('breeze.demoOpen', true); return Promise.resolve(info); },
            async readDir(rel) {
                needOpen();
                const seen = new Map();
                const depth = rel ? rel.split('/').length : 0;
                for (const d of dirs)
                    if (under(d, rel) && d.split('/').length === depth + 1)
                        seen.set(baseName(d), true);
                for (const f of files.keys())
                    if (under(f, rel) && f.split('/').length === depth + 1)
                        seen.set(baseName(f), false);
                return [...seen].map(([name, dir]) => ({ name, dir })).sort(byDirThenName);
            },
            async readFile(rel) {
                if (!files.has(rel))
                    throw new Error('File not found');
                if (binary.has(rel))
                    return IMAGE_FILE.test(rel) ? { image: true, size: 48213 } : { binary: true, size: 48213 };
                return { text: files.get(rel), size: (files.get(rel) ?? '').length };
            },
            writeFile(rel, text) { files.set(rel, text); return Promise.resolve(); },
            async createFile(rel) {
                if (exists(rel))
                    throw new Error('A file with that name already exists');
                files.set(rel, '');
            },
            async createDir(rel) {
                if (exists(rel))
                    throw new Error('A folder with that name already exists');
                dirs.add(rel);
            },
            async rename(from, to) {
                if (exists(to))
                    throw new Error('Something with that name already exists');
                const renamed = (k) => to + k.slice(from.length);
                // Snapshot the keys first: the maps change while we go.
                const fileKeys = [...files.keys()].filter(k => inside(k, from));
                for (const k of fileKeys) {
                    files.set(renamed(k), files.get(k) ?? '');
                    files.delete(k);
                }
                for (const set of [dirs, binary]) {
                    const keys = [...set].filter(k => inside(k, from));
                    for (const k of keys) {
                        set.delete(k);
                        set.add(renamed(k));
                    }
                }
            },
            async trash(rel) {
                const gone = [...files.keys(), ...dirs, ...binary].filter(k => inside(k, rel));
                for (const k of gone) {
                    files.delete(k);
                    dirs.delete(k);
                    binary.delete(k);
                }
            },
            listFiles() { return Promise.resolve([...files.keys()]); },
            async search(query, matchCase) {
                const out = [];
                const needle = matchCase ? query : query.toLowerCase();
                for (const [path, text] of files) {
                    if (binary.has(path))
                        continue;
                    text.split('\n').forEach((line, i) => {
                        const col = (matchCase ? line : line.toLowerCase()).indexOf(needle);
                        if (col !== -1)
                            out.push({ path, line: i, col, text: line });
                    });
                }
                return out;
            },
            // No file URLs in the browser: images get a drawn stand-in, everything else ''.
            async fileUrl(rel) { return binary.has(rel) && IMAGE_FILE.test(rel) ? DEMO_IMAGE : ''; },
            async previewUrl() { return ''; },
            onChange() { return () => { }; },
        },
        lint: { check() { return Promise.resolve(null); } },
        term: {
            async cwd() { return 'coffee-shop-landing'; },
            async run() { return { error: 'The terminal runs commands only in the Breeze desktop app (npm start).' }; },
            async kill() { },
            async write() { },
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
                const llm = store.get('breeze.demoLlm', null);
                return {
                    demo: true, platform: 'browser',
                    agents: [
                        { id: 'antigravity', name: 'Antigravity', vendor: 'Google DeepMind', url: 'https://antigravity.google/', found: false, path: null, version: 'claude-sonnet-4-6', models: ['claude-sonnet-4-6', 'gemini-3.8-flash-high', 'claude-opus-4-6-thinking', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low', 'gpt-oss-120b-medium'] },
                        { id: 'codex', name: 'Codex', vendor: 'OpenAI', url: 'https://developers.openai.com/codex/cli', found: false, path: null, version: null },
                        { id: 'claude', name: 'Claude Code', vendor: 'Anthropic', url: 'https://claude.com/claude-code', found: false, path: null, version: 'default', models: ['default', 'opus', 'sonnet', 'haiku'] },
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
                    if (!index)
                        throw new Error('Live Share needs an index.html file in the project');
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
                background(demoReplay(id, mode));
                return id;
            },
            async stop() { },
            async setModel() { return true; },
            onEvent(cb) { agentListeners.push(cb); return () => { }; },
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
            async diff() { return '@@ -1,3 +1,3 @@\n /* Cozy, warm palette */\n-:root {\n+:root { /* demo change */\n   --bean: #2b1d12;'; },
            async init() { return ''; },
            async stage() { return ''; },
            async unstage() { return ''; },
            async discard() { },
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
                if (!u)
                    throw new Error('That account is no longer signed in');
                current = u;
                return u;
            },
            async start(provider) {
                const n = accounts.filter(a => a.provider === provider).length + 1;
                const user = { provider, name: `Demo ${provider} ${n}`, login: 'demo' + n };
                setTimeout(() => {
                    accounts = [...accounts, user];
                    current = user;
                    authListeners.forEach(cb => cb({ t: 'done', user }));
                }, 1400);
                return { started: true };
            },
            async cancel() { },
            async signOut() {
                accounts = accounts.filter(a => a !== current);
                current = accounts[0] ?? null;
                return current;
            },
            onEvent(cb) { authListeners.push(cb); return () => { }; },
        },
        // Browser preview: "connecting" opens the site in a new tab; the feed itself only plays in the desktop app.
        vibe: {
            async status() { return feeds(); },
            async connect(id) {
                const site = SOCIAL_SITES.find(s => s.id === id);
                if (site)
                    window.open(site.url, '_blank', 'noopener');
                store.set('breeze.demoVibe', { ...feeds(), [id]: true });
                return true;
            },
            async disconnect(id) { store.set('breeze.demoVibe', { ...feeds(), [id]: false }); },
            async show() { },
            async bounds() { },
            async mute() { },
            async hide() { },
        },
        discord: {
            async set() { return { user: null }; },
            async clear() { },
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
        },
    };
}
const SOCIAL_SITES = [
    { id: 'instagram', name: 'Instagram Reels', mark: '◎', url: 'https://www.instagram.com/reels/' },
    { id: 'facebook', name: 'Facebook Reels', mark: 'f', url: 'https://www.facebook.com/reel/' },
];
// Brand artwork for agents and feeds, keyed by the same id as the tint class. Anything without a file falls back to its letter or symbol.
const BRAND_ICONS = {
    codex: 'codex.png',
    claude: 'claude.svg',
    antigravity: 'antigravity.png',
    instagram: 'instagram.png', facebook: 'facebook.png',
    local: 'ollama.svg',
    ollama: 'ollama.svg',
};
// Logos that are a shape rather than a square tile; they show whole instead of clipped to the tile's corners.
const BARE_ICONS = new Set(['facebook']);
function brandMark(cls, id, fallback) {
    const file = BRAND_ICONS[id];
    const inner = file ? `<img class="brand-img" src="../../assets/icons/${file}" alt="" draggable="false">` : esc(fallback);
    return `<span class="${cls} tint-${id}${file ? ' has-img' : ''}${file && BARE_ICONS.has(id) ? ' bare' : ''}">${inner}</span>`;
}
const SPEAKER = 'M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z';
const LINE_ICONS = {
    plus: [['path', { d: 'M5 12h14' }], ['path', { d: 'M12 5v14' }]],
    minus: [['path', { d: 'M5 12h14' }]],
    x: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]],
    check: [['path', { d: 'M20 6 9 17l-5-5' }]],
    external: [['path', { d: 'M7 7h10v10' }], ['path', { d: 'M7 17 17 7' }]],
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
    sparkles: [['path', { d: 'm12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z' }], ['path', { d: 'M5 3v4' }], ['path', { d: 'M19 17v4' }], ['path', { d: 'M3 5h4' }], ['path', { d: 'M17 19h4' }]],
    backspace: [['path', { d: 'M10 5a2 2 0 0 0-1.344.519l-6.328 5.74a1 1 0 0 0 0 1.481l6.328 5.741A2 2 0 0 0 10 19h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z' }], ['path', { d: 'm12 9 6 6' }], ['path', { d: 'm18 9-6 6' }]],
    volume: [['path', { d: SPEAKER }], ['path', { d: 'M16 9a5 5 0 0 1 0 6' }], ['path', { d: 'M19.364 18.364a9 9 0 0 0 0-12.728' }]],
    volumeOff: [['path', { d: SPEAKER }], ['path', { d: 'm22 9-6 6' }], ['path', { d: 'm16 9 6 6' }]],
    eye: [['path', { d: 'M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
    gear: [['path', { d: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
    user: [['path', { d: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2' }], ['circle', { cx: 12, cy: 7, r: 4 }]],
    pencil: [['path', { d: 'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z' }], ['path', { d: 'm15 5 4 4' }]],
    terminal: [['path', { d: 'M4 17l6-6-6-6' }], ['path', { d: 'M12 19h8' }]],
    search: [['circle', { cx: 11, cy: 11, r: 8 }], ['path', { d: 'm21 21-4.3-4.3' }]],
    globe: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20' }], ['path', { d: 'M2 12h20' }]],
    todo: [['path', { d: 'm3 17 2 2 4-4' }], ['path', { d: 'm3 7 2 2 4-4' }], ['path', { d: 'M13 6h8' }], ['path', { d: 'M13 12h8' }], ['path', { d: 'M13 18h8' }]],
    diamond: [['path', { d: 'M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z' }]],
    dot: [['circle', { cx: 12, cy: 12, r: 2 }]],
    info: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M12 16v-4' }], ['path', { d: 'M12 8h.01' }]],
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
};
const formatAttr = ([k, v]) => `${k}="${v}"`;
const iconBody = (name) => (LINE_ICONS[name] ?? LINE_ICONS.dot)
    .map(([tag, a]) => {
    const attrs = Object.entries(a).map(formatAttr).join(' ');
    return `<${tag} ${attrs}/>`;
})
    .join('');
function svgIcon(name, size = 16) {
    return `<svg class="ico-svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-icon="${name}" aria-hidden="true">${iconBody(name)}</svg>`;
}
// Fills the empty <svg data-i="name"> placeholders written in breeze.html.
function paintIcons(root = document) {
    root.querySelectorAll('svg[data-i]').forEach(s => {
        const name = s.dataset.i ?? 'dot';
        const size = s.dataset.size ?? '16';
        s.classList.add('ico-svg');
        for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }))
            s.setAttribute(k, v);
        s.dataset.icon = name;
        s.innerHTML = iconBody(name);
        delete s.dataset.i;
    });
}
const MORPH_URL = './node_modules/morphicons/dist/dom.js';
let morphLib = null;
const loadMorph = () => (morphLib ??= import(MORPH_URL).catch(() => null));
const morphs = new WeakMap();
paintIcons();
async function setIcon(host, name) {
    const svg = host.querySelector('svg.ico-svg');
    if (!svg || svg.dataset.icon === name || !LINE_ICONS[name])
        return;
    const from = svg.dataset.icon ?? name;
    svg.dataset.icon = name;
    const lib = await loadMorph();
    if (!lib) {
        svg.innerHTML = iconBody(name);
        return;
    }
    let m = morphs.get(svg);
    if (!m) {
        svg.innerHTML = '<path/>';
        m = lib.createMorph(svg.firstElementChild, LINE_ICONS[from] ?? LINE_ICONS[name], { strokeWidth: 2 });
        morphs.set(svg, m);
    }
    m.morphTo(LINE_ICONS[name]);
}
const isDesktop = !!window.breeze;
const api = window.breeze ?? demoApi();
const appState = {
    onboarded: false, step: 0, user: null, agent: null, detect: null, vibeArmed: false, vibeSites: [], vibeSite: null, mode: 'ide',
    discord: false, discordDetails: true,
    ...store.get('breeze.app', {}),
};
const saveApp = () => store.set('breeze.app', appState);
/* ================= Onboarding: welcome → login → agent → mode ================= */
const STEP = { welcome: 0, signIn: 1, agent: 2, mode: 3 };
let step = Math.min(appState.step, STEP.mode);
let user = appState.user;
function goStep(n) {
    step = n;
    appState.step = n;
    saveApp();
    $$('.ob-step').forEach(s => s.classList.toggle('hidden', Number(s.dataset.step) !== n));
    $$('.ob-dots span').forEach((d, i) => { d.classList.toggle('on', i === n); d.classList.toggle('back', i < n); });
    if (n === STEP.agent)
        detectTools().catch(() => { });
    if (n === STEP.mode)
        renderModeChoice();
}
$$('[data-next]').forEach(b => b.onclick = () => goStep(step + 1));
// The dots before the current one take you back to that step.
$$('.ob-dots span').forEach((d, i) => {
    d.onclick = () => { if (i < step)
        goStep(i); };
    d.setAttribute('aria-label', `Step ${i + 1}`);
});
/* ----- Accounts ----- */
function setUser(u) {
    user = u;
    appState.user = u;
    saveApp();
    renderUser();
}
const initialsOf = (name) => name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
function avatarHtml(u, title) {
    const name = u?.name ?? 'You';
    if (u?.avatar)
        return `<img class="avatar" src="${escAttr(u.avatar)}" alt="" title="${escAttr(title)}">`;
    return `<span class="avatar tint-host" title="${escAttr(title)}">${esc(initialsOf(name))}</span>`;
}
function renderUser() {
    const title = user ? `${user.name} · ${user.provider}` : 'Not signed in';
    $('#avatars').innerHTML = avatarHtml(user, title);
    $('#boxAvatar').innerHTML = avatarHtml(user, title);
    $('#userChip').textContent = user ? `● ${user.name} · ${user.provider}` : 'Not signed in';
}
let accounts = { accounts: [], active: null };
const accountKey = (u) => `${u.provider}:${u.login ?? ''}`;
async function refreshAccounts() {
    accounts = await api.auth.accounts().catch(() => accounts);
}
async function switchAccount(a) {
    if (accountKey(a) === accounts.active)
        return;
    setUser(await api.auth.switchTo(accountKey(a)));
    await refreshAccounts();
    toast(`Switched to ${a.name}`);
}
async function signOut() {
    const next = await api.auth.signOut();
    setUser(next);
    await refreshAccounts();
    toast(next ? `Signed out — now using ${next.name}` : 'Signed out');
}
function accountItems() {
    const list = accounts.accounts.map(a => ({
        label: a.name, key: a.provider, checked: () => accountKey(a) === accounts.active, run: () => background(switchAccount(a)),
    }));
    return [...list, ...(list.length ? [{ sep: true }] : []), { label: 'Add account…', run: addAccount }];
}
// Clicking your picture: who you are, your other accounts (in a submenu) and signing out.
function openAccountMenu(anchor) {
    if (anchor.classList.contains('open') || (justClosedTrigger === anchor && Date.now() - justClosedAt < 350)) {
        closeMenu();
        return;
    }
    closeMenu();
    anchor.classList.add('open');
    const r = anchor.getBoundingClientRect();
    const items = user
        ? [{ header: user }, { label: 'Accounts', sub: accountItems }, { sep: true }, ...syncMenuItems(), { sep: true }, { label: 'Sign Out', run: () => background(signOut()) }]
        : [{ label: 'Sign in', run: addAccount }, ...(accounts.accounts.length ? [{ label: 'Accounts', sub: accountItems }] : [])];
    popupMenu(r.right, r.bottom + 6, items, () => anchor.classList.remove('open'), anchor);
    const m = $('#menuRoot .menu');
    if (m) {
        m.classList.add('account-menu');
        m.style.left = `${Math.max(8, r.right - m.offsetWidth)}px`;
    }
}
for (const id of ['#avatars', '#boxAvatar']) {
    $(id).onclick = e => {
        const anchor = e.currentTarget;
        if (anchor.classList.contains('open') || (justClosedTrigger === anchor && Date.now() - justClosedAt < 350)) {
            closeMenu();
            return;
        }
        background(refreshAccounts().then(() => openAccountMenu(anchor)));
    };
}
/* ----- Sign in (GitHub device flow / Google loopback, handled in main.js) ----- */
// The onboarding step and the "Add account" dialog share this panel; signinRoot is the one in use.
const SIGNIN_PANEL = `<div class="signin-btns" data-si="choices">
    <button class="btn" data-signin="GitHub"><svg width="18" height="18"><use href="#i-gh"/></svg>Continue with GitHub</button>
    <button class="btn" data-signin="Google"><img src="../../assets/icons/google.png" width="18" height="18" alt="Google">Continue with Google</button>
    <p class="signin-error hidden" data-si="error" role="alert"></p>
  </div>
  <div class="waiting hidden" data-si="wait">
    <div class="spinner"></div><div data-si="msg">Waiting for your browser…</div>
    <div class="device-code hidden" data-si="code"><span data-si="codeText"></span><button class="btn btn-sm" data-si="copy">Copy</button><button class="btn btn-sm" data-si="openPage">Open page ${svgIcon('external', 12)}</button></div>
    <button class="btn btn-sm" data-si="cancel">Cancel</button>
  </div>`;
const onboardSignin = $('#obSignin');
let signinRoot = onboardSignin;
const si = (part) => $(`[data-si="${part}"]`, signinRoot);
function signinView(waiting) {
    si('choices').classList.toggle('hidden', waiting);
    si('wait').classList.toggle('hidden', !waiting);
    if (waiting) {
        si('error').classList.add('hidden');
        si('code').classList.add('hidden');
    }
}
function signinError(text) {
    signinView(false);
    si('error').textContent = text;
    si('error').classList.remove('hidden');
}
async function startSignIn(provider) {
    signinView(true);
    si('msg').textContent = `Opening ${provider} in your browser…`;
    const r = await api.auth.start(provider).catch((e) => ({ error: errMsg(e) }));
    if (r.error === 'not-configured') {
        signinError(`Looks like ${provider} login isn't hooked up yet! Grab a Client ID, add it to .env (or breeze.config.json — there's an example config to help), and give Breeze a restart. Or, skip it for now and jump right in.`);
    }
    else if (r.error)
        signinError(r.error);
}
function bindSignin(root) {
    $$('[data-signin]', root).forEach(b => b.onclick = () => void startSignIn(b.dataset.signin ?? 'GitHub'));
    $('[data-si="cancel"]', root).onclick = () => { background(api.auth.cancel()); signinView(false); };
    $('[data-si="copy"]', root).onclick = () => background(navigator.clipboard.writeText(si('codeText').textContent ?? '').then(() => toast('Code copied')));
}
bindSignin(onboardSignin);
$('#signinSkip').onclick = () => goStep(STEP.agent);
function addAccount() {
    openModal(`<h3>Add an account</h3><p class="sub">Sign in with another GitHub or Google account. Switch between accounts from your picture in the title bar.</p><div class="signin-modal">${SIGNIN_PANEL}</div>`, m => {
        signinRoot = $('.signin-modal', m);
        bindSignin(signinRoot);
    }, () => {
        if (!si('wait').classList.contains('hidden'))
            background(api.auth.cancel());
        signinRoot = onboardSignin;
    });
}
api.auth.onEvent(ev => {
    if (ev.t === 'code') {
        si('msg').textContent = 'Enter this code on the GitHub page that just opened:';
        si('codeText').textContent = ev.code ?? '';
        si('code').classList.remove('hidden');
        si('openPage').onclick = () => background(api.sys.openExternal(ev.uri ?? 'https://github.com/login/device'));
    }
    else if (ev.t === 'waiting') {
        si('msg').textContent = `Finish signing in with ${ev.provider} in your browser…`;
    }
    else if (ev.t === 'done' && ev.user) {
        setUser(ev.user);
        signinView(false);
        background(refreshAccounts());
        toast(`Signed in as ${ev.user.name}`);
        background(afterSignIn());
        if (signinRoot === onboardSignin) {
            if (!appState.onboarded && step === STEP.signIn)
                goStep(STEP.agent);
        }
        else
            closeModal();
    }
    else if (ev.t === 'error')
        signinError(ev.text ?? 'Sign-in failed');
});
/* ----- Workspace sync (one account, many computers) ----- */
// GitHub accounts sync through a private breeze-sync repo, Google accounts through Drive's hidden app folder.
const isSyncFail = (r) => !!r && typeof r === 'object' && 'error' in r;
// Unwraps a sync result. A failure becomes a toast, or a sign-in prompt when the account needs more access.
function syncOk(r, quiet = false) {
    if (!isSyncFail(r))
        return r;
    if (quiet)
        return null;
    if (r.code === 'reauth') {
        openModal(`<h3>Sign in again to sync</h3><p class="sub">${esc(r.error)} Breeze needs one more permission: a private breeze-sync repo on GitHub, or Breeze's own hidden folder in Google Drive.</p>
      <div class="row end"><button class="btn" data-close>Not now</button><button class="btn btn-primary" id="syncReauth">Sign in</button></div>`, m => {
            $('#syncReauth', m).onclick = () => { closeModal(); addAccount(); };
        });
    }
    else
        toast(r.code === 'signed-out' ? 'Sign in to sync your workspaces' : r.error);
    return null;
}
function syncSummaryText(s) {
    const parts = [
        s.downloaded && `${s.downloaded} down`, s.uploaded && `${s.uploaded} up`, s.removed && `${s.removed} removed`,
        s.conflicts.length && `${s.conflicts.length} conflict${s.conflicts.length > 1 ? 's' : ''} kept side by side`,
    ].filter(Boolean);
    return parts.length ? `Synced: ${parts.join(', ')}` : 'Already in sync';
}
// App settings that follow the account. A change is stamped when first seen, so the newer side wins.
const SYNCED_KEYS = ['breeze.sound', 'breeze.volume', 'breeze.effort', 'breeze.layout'];
const SYNCED_APP = ['agent', 'mode', 'discord', 'discordDetails'];
function settingValues() {
    const values = {};
    for (const k of SYNCED_KEYS) {
        const v = store.get(k, undefined);
        if (v !== undefined)
            values[k] = v;
    }
    for (const k of SYNCED_APP)
        values[`app.${k}`] = appState[k];
    return values;
}
function sharedSettings() {
    const values = settingValues();
    const print = JSON.stringify(values);
    const last = store.get('breeze.settingsSync', { print: '', updatedAt: '' });
    const updatedAt = last.print === print && last.updatedAt ? last.updatedAt : new Date().toISOString();
    store.set('breeze.settingsSync', { print, updatedAt });
    return { updatedAt, values };
}
// Settings from another computer are applied and the window reloads so every part picks them up.
async function syncSettings() {
    const mine = sharedSettings();
    const r = syncOk(await api.sync.settings(mine), true);
    if (!r?.pulled || !r.settings || JSON.stringify(r.settings.values) === JSON.stringify(mine.values))
        return;
    for (const [k, v] of Object.entries(r.settings.values)) {
        const key = k.slice(4);
        if (k.startsWith('app.') && SYNCED_APP.includes(key))
            appState[key] = v;
        else if (SYNCED_KEYS.includes(k))
            store.set(k, v);
    }
    saveApp();
    store.set('breeze.settingsSync', { print: JSON.stringify(settingValues()), updatedAt: r.settings.updatedAt });
    await api.win.reload();
}
let syncing = false;
async function runSync(mode) {
    if (!rootInfo) {
        toast('Open a folder to sync it');
        return;
    }
    if (syncing)
        return;
    syncing = true;
    toast(mode === 'pull' ? 'Getting the latest from the cloud…' : 'Syncing…');
    try {
        const s = syncOk(await api.sync.run(mode));
        if (!s)
            return;
        syncSeenRev = s.rev;
        const backed = s.backedUp.length ? ` · ${s.backedUp.length} local edit${s.backedUp.length > 1 ? 's' : ''} backed up` : '';
        toast(syncSummaryText(s) + backed);
        if (s.downloaded || s.removed || s.conflicts.length)
            await refreshTree();
        void refreshGit();
    }
    finally {
        syncing = false;
    }
    await syncSettings();
}
function confirmPull() {
    openModal(`<h3>Replace with the cloud version?</h3><p class="sub">${esc(rootInfo?.name ?? 'This folder')} will match the newest version synced from your other computer. Edits made here and not synced yet are backed up first, and files the cloud has never seen stay.</p>
    <div class="row end"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="pullOk">Get latest</button></div>`, m => {
        $('#pullOk', m).onclick = () => { closeModal(); background(runSync('pull')); };
    });
}
// The account's cloud workspaces; picking one downloads it to this computer and opens it.
async function openCloudWorkspaces(auto = false) {
    const st = syncOk(await api.sync.status(), auto);
    if (!st || (auto && !st.workspaces.length))
        return;
    const rows = st.workspaces.map(w => `<button class="agent-opt" data-ws="${escAttr(w.id)}">
      <span class="mark avatar tint-host">${esc(initialsOf(w.name) || '?')}</span><span class="nm">${esc(w.name)}</span>
      <span class="sub">From ${esc(w.device)} · ${esc(timeAgo(Date.parse(w.updatedAt)))}</span></button>`).join('');
    const empty = 'Nothing synced yet. Open a folder and choose Sync Workspace from your picture to put it in the cloud.';
    openModal(`<h3>${auto ? 'Pick up where you left off' : 'Your cloud workspaces'}</h3>
    <p class="sub">${st.workspaces.length ? 'Workspaces synced from your other computers. Pick one to download it here.' : empty}</p>
    <div class="agent-list">${rows}</div>
    <div class="row end spaced"><button class="btn" data-close>${auto ? 'Later' : 'Close'}</button></div>`, m => {
        $$('[data-ws]', m).forEach(b => b.onclick = () => background((async () => {
            closeModal();
            toast('Downloading workspace…');
            const r = syncOk(await api.sync.clone(b.dataset.ws ?? ''));
            if (!r)
                return;
            await loadWorkspace(r.info);
            syncSeenRev = r.summary.rev;
            toast(`${r.info.name}: ${r.summary.downloaded} files downloaded`);
        })()));
    });
}
// A fresh install that signs in gets the account's settings, then its workspaces if no folder is open.
async function afterSignIn() {
    if (!isDesktop)
        return;
    await syncSettings();
    if (!rootInfo)
        await openCloudWorkspaces(true);
    else {
        syncCheckedAt = 0;
        await checkCloudNewer();
    }
}
// When another computer has synced a newer version of the open folder, offer to catch up, once per version.
let syncSeenRev = 0, syncCheckedAt = 0;
async function checkCloudNewer() {
    if (!user || !rootInfo || !isDesktop || syncing || Date.now() - syncCheckedAt < 60_000)
        return;
    syncCheckedAt = Date.now();
    const st = syncOk(await api.sync.status(), true);
    if (!st?.newer || !st.remote || st.remote.rev <= syncSeenRev || $('#modalRoot .scrim:not(.closing)'))
        return;
    syncSeenRev = st.remote.rev;
    const w = st.remote;
    openModal(`<h3>Newer version from ${esc(w.device)}</h3><p class="sub">${esc(w.name)} was synced from ${esc(w.device)} ${esc(timeAgo(Date.parse(w.updatedAt)))}. Sync to bring this computer up to date; edits made here are kept.</p>
    <div class="row end"><button class="btn" data-close>Later</button><button class="btn" id="cloudPull">Replace with theirs</button><button class="btn btn-primary" id="cloudSync">Sync now</button></div>`, m => {
        $('#cloudSync', m).onclick = () => { closeModal(); background(runSync('sync')); };
        $('#cloudPull', m).onclick = () => { closeModal(); confirmPull(); };
    });
}
function syncMenuItems() {
    return [
        { label: 'Sync Workspace', act: 'sync.run', enabled: () => !!rootInfo },
        { label: 'Get Latest from Cloud…', act: 'sync.pull', enabled: () => !!rootInfo },
        { label: 'Open Cloud Workspace…', act: 'sync.open' },
    ];
}
window.addEventListener('focus', () => background(checkCloudNewer()));
/* ----- Vibe Mode feeds (the feed picker) ----- */
// Sites the user connected live in appState.vibeSites; signedIn says which of them have a session cookie.
let signedIn = {};
const siteById = (id) => SOCIAL_SITES.find(s => s.id === id);
const connectedSites = () => SOCIAL_SITES.filter(s => appState.vibeSites.includes(s.id));
function feedCardHtml(s) {
    const connected = appState.vibeSites.includes(s.id);
    const cls = ['social-card', connected ? 'connected' : '', s.id === appState.vibeSite ? 'on' : ''].filter(Boolean).join(' ');
    let sub = 'Not connected';
    if (connected)
        sub = 'Signed in';
    const connectLabel = connected ? 'Disconnect' : 'Connect ' + svgIcon('external', 12);
    return `<div class="${cls}" data-site="${s.id}" role="button" tabindex="0">
    ${brandMark('mark', s.id, s.mark)}<span class="nm">${esc(s.name)}</span><span class="sub">${sub}</span>
    <button class="btn btn-sm" data-connect="${s.id}">${connectLabel}</button></div>`;
}
async function renderFeedChoices(root) {
    signedIn = await api.vibe.status().catch(() => ({}));
    // A feed whose sign-in has expired or been cleared is no longer connected.
    const stale = appState.vibeSites.filter(id => id in signedIn && !signedIn[id]);
    if (stale.length) {
        appState.vibeSites = appState.vibeSites.filter(id => !stale.includes(id));
        if (appState.vibeSite && stale.includes(appState.vibeSite))
            appState.vibeSite = appState.vibeSites[0] ?? null;
        saveApp();
    }
    const draw = () => {
        root.innerHTML = SOCIAL_SITES.map(feedCardHtml).join('');
        $$('[data-site]', root).forEach(card => {
            const id = card.dataset.site ?? '';
            const pick = (onButton) => {
                // A connected card's body makes it the feed Vibe Mode plays; the button connects or disconnects.
                if (!onButton && appState.vibeSites.includes(id)) {
                    appState.vibeSite = id;
                    saveApp();
                    draw();
                    return;
                }
                background(toggleFeed(id).then(draw));
            };
            card.onclick = e => pick(!!e.target.closest('[data-connect]'));
            card.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === card) {
                e.preventDefault();
                pick(false);
            } };
        });
    };
    draw();
}
async function toggleFeed(id) {
    const site = siteById(id);
    if (!site)
        return;
    if (appState.vibeSites.includes(id)) {
        await api.vibe.disconnect(id);
        appState.vibeSites = appState.vibeSites.filter(x => x !== id);
        signedIn[id] = false;
        if (appState.vibeSite === id)
            appState.vibeSite = appState.vibeSites[0] ?? null;
        saveApp();
        toast(`${site.name} disconnected`);
        return;
    }
    toast(`Sign in to ${site.name} in the window that opened, then close it`);
    // A feed only counts as connected once the site really has a sign-in; closing the window unsigned adds nothing.
    signedIn[id] = await api.vibe.connect(id).catch(() => false);
    if (!signedIn[id]) {
        toast(`Couldn't confirm a ${site.name} sign-in, so it isn't connected. Try Connect again and sign in first.`);
        return;
    }
    appState.vibeSites = [...appState.vibeSites, id];
    appState.vibeSite = id;
    saveApp();
    setVibeArmed(true);
    toast(`${site.name} connected`);
}
/* ----- AI agent detection ----- */
const AGENT_STYLE = {
    codex: { letter: 'Cx', tint: 'codex' },
    claude: { letter: 'Cc', tint: 'claude' },
    antigravity: { letter: 'Ag', tint: 'antigravity' },
    local: { letter: 'Ol', tint: 'local' },
    ollama: { letter: 'Ol', tint: 'local' },
};
let detecting = null;
function detectTools(force = false) {
    if (detecting !== null)
        return detecting;
    $('#aiPill').className = 'pill';
    $('#aiPill').textContent = 'Scanning…';
    $('#toolsPill').className = 'pill';
    $('#toolsPill').textContent = 'Scanning…';
    if (!appState.detect)
        $('#agentList').innerHTML = '<div class="row text-3"><div class="spinner sm"></div>Checking this computer…</div>';
    detecting = api.sys.detect(force).then(d => {
        appState.detect = d;
        fixSelectedAgent();
        renderDetection();
        return d;
    }).catch((e) => {
        $('#aiPill').className = 'pill warn';
        $('#aiPill').textContent = 'Scan failed';
        $('#aiHint').textContent = errMsg(e);
        throw e;
    }).finally(() => { detecting = null; });
    return detecting;
}
// Keep the chosen agent if it is still usable, else fall back to the first one that is.
function fixSelectedAgent() {
    const found = appState.detect?.agents.filter(a => a.found) ?? [];
    if (!appState.agent || !found.some(a => a.id === appState.agent))
        appState.agent = found[0]?.id ?? null;
    saveApp();
}
const pillClass = (on) => (on ? 'blue' : 'ok');
// The local LLM card: an API key to connect with (the server is found on this computer),
// or (once connected) its address and a model picker.
function localAgentHtml(a, on, mark) {
    const name = `<span class="nm">${esc(a.name)} <small>API</small></span>`;
    if (!a.found) {
        return `<div class="agent-opt api missing">${mark}${name}
      <button class="get side" data-get="${escAttr(a.url)}"><span class="get-label">Get Ollama</span></button>
      <span class="sub">Finds Ollama or LM Studio running on this computer</span>
      <div class="key-row"><input class="input" type="password" data-llm-key aria-label="API key" placeholder="API key" autocomplete="off" spellcheck="false"><button class="btn btn-sm" data-llm-connect>Connect</button></div>
      <div class="key-err hidden"></div></div>`;
    }
    const label = on ? 'Selected' : 'Ready';
    const options = (a.models ?? []).map(m => `<option value="${escAttr(m)}"${m === a.version ? ' selected' : ''}>${esc(m)}</option>`).join('');
    return `<div class="agent-opt api ${on ? 'on' : ''}" role="button" tabindex="0" data-agent="${a.id}">${mark}${name}
    <span class="side row gap-6"><span class="pill ${pillClass(on)}">${label}</span><button class="get" data-llm-off title="Forget this server"><span class="get-label">Remove</span></button></span>
    <span class="sub" title="${escAttr(a.path ?? '')}">${esc(a.path ?? '')}</span>
    <div class="key-row"><select class="select" data-llm-model aria-label="Model">${options}</select></div></div>`;
}
function cliAgentHtml(a, on, mark, demo) {
    const where = a.path ?? (demo ? 'browser preview' : '');
    const version = a.version ? 'v' + a.version : 'Installed';
    const sub = a.found ? [version, where].filter(Boolean).join(' · ') : a.vendor + ' · not installed';
    const label = on ? 'Selected' : 'Detected';
    const side = a.found
        ? `<span class="pill ${pillClass(on)} side">${label}</span>`
        : `<button class="get side" data-get="${escAttr(a.url)}"><span class="get-label">Get it</span></button>`;
    const attrs = a.found ? `role="button" tabindex="0" data-agent="${a.id}"` : '';
    let modelOptions = '';
    if (a.found && a.models?.length && a.id !== 'codex' && a.id !== 'antigravity' && a.id !== 'claude') {
        const opts = a.models.map(m => {
            const sel = m === a.version ? ' selected' : '';
            return `<option value="${escAttr(m)}"${sel}>${esc(m)}</option>`;
        }).join('');
        modelOptions = `<div class="key-row"><select class="select" data-agent-model="${a.id}" aria-label="Model">${opts}</select></div>`;
    }
    return `<div class="agent-opt ${a.found ? '' : 'missing'} ${on ? 'on' : ''}" ${attrs}>
    ${mark}<span class="nm">${esc(a.name)}</span>${side}
    <span class="sub" title="${escAttr(sub)}">${esc(sub)}</span>${modelOptions}</div>`;
}
function agentOptionsHtml(d) {
    return d.agents.map(a => {
        const st = AGENT_STYLE[a.id] ?? { letter: a.name[0], tint: 'default' };
        const on = a.found && a.id === appState.agent;
        const mark = brandMark('mark', st.tint, st.letter);
        return a.api ? localAgentHtml(a, on, mark) : cliAgentHtml(a, on, mark, !!d.demo);
    }).join('');
}
function bindLocalLlm(root, onChange) {
    const local = () => appState.detect?.agents.find(a => a.id === 'local');
    const connect = root.querySelector('[data-llm-connect]');
    if (connect) {
        const key = $('[data-llm-key]', root);
        const save = async () => {
            const err = root.querySelector('.key-err');
            connect.disabled = true;
            connect.textContent = 'Connecting…';
            try {
                const r = await api.llm.connect('', key.value);
                Object.assign(local() ?? {}, { found: true, path: r.url ?? null, version: r.model, models: r.models });
                if (!selectedAgent())
                    appState.agent = 'local';
                saveApp();
                toast(`Connected · ${r.model}`);
                onChange();
            }
            catch (e) {
                connect.disabled = false;
                connect.textContent = 'Connect';
                if (err) {
                    err.textContent = errMsg(e);
                    err.classList.remove('hidden');
                }
            }
        };
        connect.onclick = () => void save();
        key.onkeydown = e => { if (e.key === 'Enter')
            void save(); };
    }
    const model = root.querySelector('[data-llm-model]');
    if (model)
        model.onchange = () => background(api.llm.setModel(model.value).then(() => {
            Object.assign(local() ?? {}, { version: model.value });
            saveApp();
            renderAgentPill();
            toast(`Ollama model · ${model.value}`);
        }));
    root.querySelector('[data-llm-off]')?.addEventListener('click', e => {
        e.stopPropagation();
        background(api.llm.disconnect().then(() => {
            Object.assign(local() ?? {}, { found: false, path: null, version: null, models: [] });
            fixSelectedAgent();
            onChange();
        }));
    });
}
function bindAgentOptions(root, onChange) {
    $$('[data-agent]', root).forEach(el => {
        const pick = () => {
            appState.agent = el.dataset.agent ?? null;
            const curTab = surfaceTabs['ide']?.find(t => t.id === activeTabId['ide']);
            if (curTab && appState.agent)
                curTab.agentId = appState.agent;
            saveApp();
            onChange();
            updateScmGenBtn();
        };
        el.onclick = e => { if (!e.target.closest('button, input, select'))
            pick(); };
        el.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === el) {
            e.preventDefault();
            pick();
        } };
    });
    $$('[data-agent-model]', root).forEach(sel => {
        sel.onchange = async () => {
            const agId = sel.dataset.agentModel;
            const modelVal = sel.value;
            const targetAgent = appState.detect?.agents.find(a => a.id === agId);
            if (agId === 'codex') {
                await api.agent.setModel('codex', modelVal);
                if (targetAgent)
                    targetAgent.version = modelVal;
                saveApp();
                renderAgentPill();
                toast(`Codex model · ${modelVal}`);
            }
            else if (agId === 'antigravity' || agId === 'claude') {
                await api.agent.setModel(agId, modelVal);
                if (targetAgent)
                    targetAgent.version = modelVal;
                saveApp();
                renderAgentPill();
                toast(`${targetAgent?.name ?? agId} model · ${modelVal}`);
            }
        };
    });
    $$('[data-get]', root).forEach(b => b.onclick = e => { e.stopPropagation(); background(api.sys.openExternal(b.dataset.get ?? '')); });
    bindLocalLlm(root, onChange);
}
const TOOL_DOWNLOADS = { git: 'https://git-scm.com/downloads', node: 'https://nodejs.org/en/download' };
function toolHtml(t) {
    if (!t.found) {
        const cmd = t.cmd || (t.hint && /^(?:winget|brew|xcode-select)\b/.test(t.hint) ? t.hint : null);
        const url = t.url || TOOL_DOWNLOADS[t.id] || null;
        const label = t.optional ? `${t.name} not found` : `${t.name} missing`;
        const cls = `pill pill-btn tool-pill-missing ${t.optional ? '' : 'warn'}`.trim();
        const runAttr = cmd ? `data-run-cmd="${escAttr(cmd)}"` : '';
        const getAttr = (!cmd && url) ? `data-get="${escAttr(url)}"` : '';
        return `<button type="button" class="${cls}" data-tool-id="${escAttr(t.id)}" ${runAttr} ${getAttr}>${esc(label)}</button>`;
    }
    const version = t.version ? ' ' + esc(t.version) : '';
    return `<span class="pill ok">${esc(t.name)}${version} ready</span>`;
}
function renderDetection() {
    const d = appState.detect;
    if (!d)
        return;
    const found = d.agents.filter(a => a.found);
    $('#agentList').innerHTML = agentOptionsHtml(d);
    bindAgentOptions($('#agentList'), renderDetection);
    $('#aiPill').className = found.length ? 'pill ok' : 'pill warn';
    $('#aiPill').textContent = found.length ? `${found.length} ready` : 'None ready';
    $('#aiHint').textContent = found.length
        ? 'Pick the agent Breeze hands work to. Installed agents use their own sign-in; a local LLM runs on your own computer.'
        : 'No coding agent found. Install one and rescan, or connect a local LLM server.';
    if (d.demo)
        $('#aiHint').textContent += ' (Browser preview.)';
    $('#toolList').innerHTML = d.tools.map(toolHtml).join('');
    $$('[data-get]', $('#toolList')).forEach(b => b.onclick = () => background(api.sys.openExternal(b.dataset.get ?? '')));
    $$('[data-run-cmd]', $('#toolList')).forEach(b => {
        b.onclick = async () => {
            const cmd = b.dataset.runCmd;
            if (!cmd)
                return;
            b.classList.add('busy');
            const prev = b.textContent;
            b.textContent = 'Running…';
            try {
                if (await api.sys.runCommand(cmd))
                    toast(`Launched terminal command: ${cmd}`);
                else
                    toast(`Breeze can't run that command. Run it yourself: ${cmd}`);
            }
            catch (err) {
                toast(`Failed to run command: ${errMsg(err)}`);
            }
            finally {
                setTimeout(() => {
                    b.classList.remove('busy');
                    b.textContent = prev;
                }, 2000);
            }
        };
    });
    const missing = d.tools.filter(t => !t.found && !t.optional).map(t => t.name);
    $('#toolsPill').className = missing.length ? 'pill warn' : 'pill ok';
    $('#toolsPill').textContent = missing.length ? `${missing.join(' & ')} missing` : 'Ready';
    const summary = d.tools.filter(t => t.found || !t.optional).map(t => `${t.name.replace('.js', '').replace('C/C++', 'C')} ${t.found ? 'ready' : 'missing'}`).join(' · ');
    $('#sbTools').innerHTML = `<span class="${missing.length ? 'dot-warn' : 'dot-ok'}"></span> ${summary}`;
    renderAgentPill();
}
$('#rescan').onclick = () => { detectTools(true).catch(() => { }); };
function selectedAgent() {
    return appState.detect?.agents.find(a => a.id === appState.agent && a.found) ?? null;
}
function modelLabel(a) {
    if (!a)
        return 'no agent';
    return a.api && a.version ? a.version : a.name;
}
const EFFORTS = ['Low', 'Medium', 'High', 'Extra'];
function currentEffort() {
    const stored = store.get('breeze.effort', 'Medium');
    return (EFFORTS.find(e => e.toLowerCase() === stored.toLowerCase()) ?? 'Medium');
}
function setEffort(eff) {
    store.set('breeze.effort', eff);
}
async function applyModelAndEffort(a, model, effort) {
    setEffort(effort);
    if (a.id === 'codex') {
        await api.agent.setModel('codex', model, effort.toLowerCase());
        a.version = model;
        saveApp();
        renderAgentPill();
        toast(`Codex model set to ${model} (${effort} effort)`);
    }
    else if (a.id === 'antigravity' || a.id === 'claude') {
        await api.agent.setModel(a.id, model, effort.toLowerCase());
        a.version = model;
        saveApp();
        renderAgentPill();
        toast(`${a.name} model set to ${model} (${effort} effort)`);
    }
    else if (a.api) {
        await api.llm.setModel(model);
        a.version = model;
        saveApp();
        renderAgentPill();
        toast(`Ollama model set to ${model}`); // a local server has no effort setting
    }
}
function modelMenuItems(a, onSelect) {
    return (a.models ?? []).map(m => ({
        label: m,
        checked: () => (a.version || a.models?.[0]) === m,
        subClass: 'effort-menu',
        sub: () => EFFORTS.map(eff => ({
            label: eff,
            checked: () => (a.version || a.models?.[0]) === m && currentEffort() === eff,
            run: () => {
                background(applyModelAndEffort(a, m, eff).then(() => {
                    onSelect?.();
                }));
            }
        })),
        run: () => {
            background(applyModelAndEffort(a, m, currentEffort()).then(() => {
                onSelect?.();
            }));
        }
    }));
}
function updateComposerModelSelect(a) {
    const sel = $('#agentModelSelect');
    if (!sel)
        return;
    const btn = sel.nextElementSibling?.classList.contains('dd-btn') ? sel.nextElementSibling : null;
    if (!a?.found || !a.models?.length) {
        sel.classList.add('hidden');
        if (btn)
            btn.classList.add('hidden');
        sel.innerHTML = '';
        return;
    }
    sel.classList.remove('hidden');
    if (btn) {
        btn.classList.remove('hidden', 'model-swap');
        const _reflow = btn.offsetWidth;
        btn.classList.add('model-swap');
    }
    const current = a.version || a.models[0];
    const eff = currentEffort();
    sel.innerHTML = a.models.map(m => `<option value="${escAttr(m)}"${m === current ? ' selected' : ''}>${esc(m)}</option>`).join('');
    sel.value = current;
    if (btn) {
        btn.innerHTML = `<span class="dd-val">${esc(current)}<small class="dd-eff"> · ${esc(eff)}</small></span><svg class="dd-chev" width="10" height="10"><use href="#i-chev"/></svg>`;
        btn.title = `${current} (${eff} effort)`;
    }
    sel.onchange = async () => {
        const chosen = sel.value;
        await applyModelAndEffort(a, chosen, currentEffort());
        if (btn) {
            btn.innerHTML = `<span class="dd-val">${esc(chosen)}<small class="dd-eff"> · ${esc(currentEffort())}</small></span><svg class="dd-chev" width="10" height="10"><use href="#i-chev"/></svg>`;
            btn.title = `${chosen} (${currentEffort()} effort)`;
        }
    };
}
function agentPillMenuItems() {
    const items = [];
    items.push({ label: 'Switch Agent:', enabled: () => false });
    for (const ag of appState.detect?.agents ?? []) {
        items.push({
            label: ag.name,
            checked: () => ag.id === appState.agent,
            enabled: () => ag.found,
            run: () => {
                appState.agent = ag.id;
                const curTab = surfaceTabs['ide']?.find(t => t.id === activeTabId['ide']);
                if (curTab)
                    curTab.agentId = ag.id;
                saveApp();
                renderAgentPill();
                updateScmGenBtn();
                toast(`Active agent: ${ag.name}`);
            }
        });
    }
    items.push({ sep: true }, { label: 'Manage agents…', run: openAgentPicker });
    return items;
}
function renderAgentPill() {
    const a = selectedAgent();
    const pill = $('#agentPill');
    const logo = a && BRAND_ICONS[a.id] ? `<img class="pill-logo" src="../../assets/icons/${BRAND_ICONS[a.id]}" alt="" draggable="false">` : '';
    pill.innerHTML = `${logo}<span>${esc(a ? a.name : 'Choose an agent')}</span>`;
    pill.removeAttribute('title');
    delete pill.dataset.tooltip;
    const model = a?.api && a.version ? ' · ' + a.version : '';
    const label = a ? a.name + model : 'Choose an agent';
    $('#boxModel').innerHTML = `${esc(label)}${svgIcon('chevronDown', 12)}`;
    for (const k of Object.values(agentsDef))
        k.model = modelLabel(a);
    renderAgents();
    updateComposerModelSelect(a);
    updateScmGenBtn();
}
$('#agentPill').onclick = e => {
    const btn = e.currentTarget;
    if (btn.classList.contains('open') || (justClosedTrigger === btn && Date.now() - justClosedAt < 350)) {
        closeMenu();
        return;
    }
    closeMenu();
    btn.classList.add('open');
    const r = btn.getBoundingClientRect();
    popupMenu(r.left, r.bottom + 4, agentPillMenuItems(), () => btn.classList.remove('open'), btn);
};
function openAgentPicker() {
    openModal(`<h3>Choose your AI agent</h3><p class="sub">Installed coding agents are found automatically. A local LLM connects by its server address.</p>
    <div class="agent-list" id="pickList"></div>
    <div class="row between spaced"><button class="btn btn-sm btn-ghost" id="pickRescan">Scan again</button><button class="btn btn-primary" data-close>Done</button></div>`, m => {
        const scanning = '<div class="text-3">Scanning…</div>';
        const render = () => {
            if (!appState.detect) {
                $('#pickList', m).innerHTML = scanning;
                return;
            }
            $('#pickList', m).innerHTML = agentOptionsHtml(appState.detect);
            bindAgentOptions($('#pickList', m), () => { render(); renderDetection(); });
        };
        render();
        $('#pickRescan', m).onclick = () => { $('#pickList', m).innerHTML = scanning; detectTools(true).then(render, () => { }); };
    });
}
/* ----- Mode: IDE or Breeze Box, and the project to start with ----- */
function renderModeChoice() {
    $$('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === appState.mode));
    $('#projFolder').textContent = rootInfo ? rootInfo.root : 'No folder yet';
    $('#projFolder').title = rootInfo?.root ?? '';
    $('#startBuilding').textContent = appState.mode === 'box' ? 'Open Breeze Box' : 'Open Breeze Code';
}
$$('[data-mode]').forEach(b => b.onclick = () => {
    appState.mode = b.dataset.mode === 'box' ? 'box' : 'ide';
    saveApp();
    renderModeChoice();
});
// "Open folder" picks an existing folder; "Create new" makes a new, empty project folder. Both open it.
async function chooseProject(create) {
    const r = await (create ? api.fs.createFolder() : api.fs.openFolder());
    if (!r)
        return;
    await loadWorkspace(r);
    renderModeChoice();
    toast(create ? `Created ${r.name}` : `Opened ${r.name}`);
}
$('#pickFolder').onclick = () => background(chooseProject(false));
$('#createFolder').onclick = () => background(chooseProject(true));
$('#startBuilding').onclick = () => {
    appState.onboarded = true;
    saveApp();
    enterMode(appState.mode);
};
// Switching between the onboarding, the IDE and Breeze Box: the old screen fades back, the new one rises in.
let swapTimer;
let booted = false;
function swapScreen(to) {
    const next = $(to);
    const screens = ['#onboard', '#ide', '#box'].map(id => $(id));
    // At launch the remembered screen just appears; the animation is for switching.
    if (!booted) {
        for (const el of screens) {
            el.classList.toggle('hidden', el !== next);
        }
        return;
    }
    const prev = screens.find(el => el !== next && !el.classList.contains('hidden') && !el.classList.contains('screen-out'));
    clearTimeout(swapTimer);
    for (const el of screens) {
        if (el !== next && el !== prev) {
            el.classList.remove('screen-out');
            el.classList.add('hidden');
        }
    }
    if (!next.classList.contains('hidden') && !next.classList.contains('screen-out'))
        return; // already showing
    next.classList.remove('hidden', 'screen-out', 'screen-in');
    const _ = next.offsetWidth; // restart the entrance animation
    next.classList.add('screen-in');
    next.addEventListener('animationend', () => next.classList.remove('screen-in'), { once: true });
    queueDiscord();
    if (!prev)
        return;
    prev.classList.add('screen-out');
    swapTimer = setTimeout(() => {
        prev.classList.remove('screen-out');
        prev.classList.add('hidden');
    }, 260);
}
function showIde() {
    swapScreen('#ide');
    useSurface('ide');
    renderUser();
    applyLayout();
    renderEditor();
    updateActIndicator(true);
}
/* ================= Agents (data) ================= */
const agentsDef = {
    assistant: { name: 'Assistant', letter: 'A', tint: 'assistant', model: 'no agent', status: 'idle', task: 'Waiting for a question', used: 0 },
    planner: { name: 'Planner', letter: 'P', tint: 'planner', model: 'no agent', status: 'idle', task: 'Waiting for a prompt', used: 0 },
    builder: { name: 'Builder', letter: 'B', tint: 'builder', model: 'no agent', status: 'idle', task: 'Waiting for a plan', used: 0 },
};
const statusLabel = { idle: 'Idle', working: 'Working', waiting: 'Waiting for you', done: 'Done' };
const LANGS = {
    html: ['html', 'HTML'], htm: ['html', 'HTML'], xml: ['html', 'XML'], svg: ['html', 'SVG'], vue: ['html', 'Vue'],
    css: ['css', 'CSS'], scss: ['css', 'SCSS'], less: ['css', 'Less'],
    js: ['js', 'JavaScript'], mjs: ['js', 'JavaScript'], cjs: ['js', 'JavaScript'], jsx: ['js', 'JavaScript JSX'],
    ts: ['js', 'TypeScript'], tsx: ['js', 'TypeScript JSX'], mts: ['js', 'TypeScript'], cts: ['js', 'TypeScript'],
    json: ['json', 'JSON'], jsonc: ['js', 'JSON with Comments'],
    md: ['md', 'Markdown'], markdown: ['md', 'Markdown'],
    py: ['py', 'Python'],
    java: ['java', 'Java'], rs: ['rs', 'Rust'],
    cs: ['cs', 'C#'], csx: ['cs', 'C# Script'], csproj: ['html', 'C# Project'],
    png: ['', 'PNG Image'], jpg: ['', 'JPEG Image'], jpeg: ['', 'JPEG Image'], gif: ['', 'GIF Image'], webp: ['', 'WebP Image'],
    avif: ['', 'AVIF Image'], bmp: ['', 'Bitmap Image'], ico: ['', 'Icon'],
};
const extOf = (path) => { const n = baseName(path).toLowerCase(); return n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : ''; };
function langOf(path) {
    if (baseName(path).toLowerCase().startsWith('.env'))
        return ['py', 'Environment'];
    return LANGS[extOf(path)] ?? ['', 'Plain Text'];
}
const either = (...patterns) => new RegExp(patterns.map(p => p.source).join('|'));
const lexer = (rules, flags = 'g') => new RegExp(rules.map(([kind, p]) => `(?<${kind}>${p.source})`).join('|'), flags);
const keywords = (list) => new RegExp(String.raw `\b(?:${list.replaceAll(' ', '|')})\b`);
const JS_KW = 'break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return super switch this throw try typeof var void while with yield async await static get set type interface enum implements private public protected readonly declare as true false null undefined';
const CS_KW = 'abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach get goto if implicit in init int interface internal is lock long namespace new null object operator out override params private protected public readonly record ref required return sbyte sealed set short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile when where while with yield';
const JAVA_KW = 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record sealed permits yield true false null';
const RS_KW = 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Some None Result Ok Err Box';
const PY_KW = 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self';
const LINE_COMMENT = /\/\/[^\n]*/;
const BLOCK_COMMENT = /\/\*[\s\S]*?(?:\*\/|$)/;
const QUOTED = /"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?/;
const BACKTICKED = /`(?:\\[\s\S]|[^`\\])*`?/;
const NUMBER = either(/\b0[xX][\da-fA-F]+\b/, /\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/);
const CALL = /\b[A-Za-z_$][\w$]*(?=\()/;
const LEXERS = {
    js: lexer([['com', either(LINE_COMMENT, BLOCK_COMMENT)], ['str', either(QUOTED, BACKTICKED)], ['num', NUMBER], ['kw', keywords(JS_KW)], ['prop', CALL]]),
    css: lexer([
        ['com', BLOCK_COMMENT], ['str', QUOTED], ['kw', /@[\w-]+|!important/],
        // A property is a name followed by ':' and a value ending in ';' or '}' (a:hover { … } reaches '{' first, so it stays a selector).
        ['prop', /(?<![\w-])-{0,2}[A-Za-z_][\w-]*(?=\s*:(?!:)[^;{}]*[;}])/],
        ['num', either(/#[\da-fA-F]{3,8}\b/, /-?\b\d+(?:\.\d+)?(?:%|[a-z]{1,3})?/)],
    ]),
    json: lexer([['prop', /"(?:\\.|[^"\\\n])*"(?=\s*:)/], ['str', /"(?:\\.|[^"\\\n])*"?/], ['num', either(/-/, NUMBER)], ['kw', /\b(?:true|false|null)\b/]]),
    // C#: raw """…""" strings, verbatim/interpolated @"…" $"…" strings, and #region-style directives.
    cs: lexer([
        ['com', either(LINE_COMMENT, BLOCK_COMMENT)], ['kw', /(?<=^|\n)[ \t]*#[a-z]+/],
        ['str', either(/\$*"""[\s\S]*?(?:"""|$)/, /(?:\$@|@\$|@)"(?:""|[^"])*"?/, /\$?"(?:\\.|[^"\\\n])*"?/, /'(?:\\.|[^'\\\n])*'?/)],
        ['num', either(/\b0[xX][\da-fA-F_]+[uUlL]*\b/, /\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[fFdDmMuUlL]*\b/)], ['kw', keywords(CS_KW)], ['prop', /\b[A-Za-z_]\w*(?=\s*[(<])/],
    ]),
    py: lexer([['com', /#[^\n]*/], ['str', either(/"""[\s\S]*?(?:"""|$)/, /'''[\s\S]*?(?:'''|$)/, QUOTED)], ['num', NUMBER], ['kw', keywords(PY_KW)], ['prop', /\b[A-Za-z_]\w*(?=\()/]]),
    // Java: """text blocks""" and @Annotations.
    java: lexer([
        ['com', either(LINE_COMMENT, BLOCK_COMMENT)], ['str', either(/"""[\s\S]*?(?:"""|$)/, QUOTED)], ['attr', /@[A-Za-z_]\w*/],
        ['num', either(/\b0[xXbB][\da-fA-F_]+[lL]?\b/, /\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[fFdDlL]?\b/)], ['kw', keywords(JAVA_KW)], ['prop', CALL],
    ]),
    // Rust: strings may span lines, r#"raw"# strings, 'c' chars but 'lifetimes, #[attributes] and macro! calls.
    rs: lexer([
        ['com', either(LINE_COMMENT, BLOCK_COMMENT)], ['kw', /#!?\[[^\]\n]*\]?/],
        ['str', either(/b?r#"[\s\S]*?(?:"#|$)/, /b?r"[^"]*"?/, /b?"(?:\\[\s\S]|[^"\\])*"?/, /b?'(?:\\[\s\S]|[^\\'\n])'/)],
        ['attr', /'[A-Za-z_]\w*/],
        ['num', either(/\b0[xob][\da-fA-F_]+(?:[iu](?:8|16|32|64|128|size))?\b/, /\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?(?:[iu](?:8|16|32|64|128|size)|f32|f64)?\b/)],
        ['kw', keywords(RS_KW)], ['prop', either(/\b[A-Za-z_]\w*!/, CALL)],
    ]),
    md: lexer([
        ['kw', /(?<=^|\n)#{1,6}[^\n]*/], ['str', either(/```[^`]*(?:```|$)/, /`[^`\n]*`/)], ['com', /(?<=^|\n)>[^\n]*/],
        ['attr', either(/\*\*[^*\n]+\*\*/, /\[[^[\]\n]*\]\([^()\n]*\)/)],
    ]),
    html: lexer([['com', /<!--[\s\S]*?(?:-->|$)/], ['tagblock', /<[!/]?[A-Za-z][^>]*>?/]]),
};
const HTML_TAG = lexer([['tag', /^<[!/]?[\w:-]+|\/?>$/], ['str', /"[^"]*"?|'[^']*'?/], ['attr', /[^\s="'<>/]+/]]);
function lex(text, re) {
    const out = [];
    let last = 0;
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
        if (!m[0]) {
            re.lastIndex++;
            continue;
        }
        if (m.index > last)
            out.push([null, text.slice(last, m.index)]);
        const groups = m.groups ?? {};
        const kind = Object.keys(groups).find(k => groups[k] !== undefined) ?? null;
        if (kind === 'tagblock')
            out.push(...lex(m[0], HTML_TAG)); // lex() resets lastIndex of the inner regex only
        else
            out.push([kind, m[0]]);
        last = m.index + m[0].length;
    }
    if (last < text.length)
        out.push([null, text.slice(last)]);
    return out;
}
// CSS: plain text outside any { } block is a selector.
function markSelectors(toks) {
    let depth = 0;
    const out = [];
    for (const [cls, text] of toks) {
        if (cls) {
            out.push([cls, text]);
            continue;
        }
        for (const part of text.split(/([{}])/)) {
            if (part === '{')
                depth++;
            else if (part === '}')
                depth = Math.max(0, depth - 1);
            const selector = depth === 0 && part !== '}' && part.trim() !== '';
            out.push([selector ? 'tag' : null, part]);
        }
    }
    return out;
}
// HTML with its <style> and <script> blocks coloured as CSS and JavaScript (TS/JSX and JSON scripts too).
// Comments come first in the pattern, so a commented-out <script> stays a comment.
const EMBEDDED = /<!--[\s\S]*?(?:-->|$)|(<(style|script)\b[^>]*>)([\s\S]*?)(?=<\/\2\s*>|$)/gi;
function htmlToks(text) {
    const out = [];
    let last = 0;
    for (const m of text.matchAll(EMBEDDED)) {
        if (!m[1])
            continue; // a comment: lexed as HTML with the text around it
        const start = (m.index ?? 0) + m[1].length, inner = m[3];
        out.push(...lex(text.slice(last, start), LEXERS.html));
        const type = (/\b(?:type|lang)\s*=\s*["']?([^"'\s>]+)/i.exec(m[1])?.[1] ?? '').toLowerCase();
        if (m[2].toLowerCase() === 'style')
            out.push(...markSelectors(lex(inner, LEXERS.css)));
        else if (!type || /javascript|ecmascript|module|babel|jsx|tsx?$|typescript/.test(type))
            out.push(...lex(inner, LEXERS.js));
        else if (type.includes('json'))
            out.push(...lex(inner, LEXERS.json));
        else
            out.push([null, inner]); // templates and other data blocks stay plain
        last = start + inner.length;
    }
    out.push(...lex(text.slice(last), LEXERS.html));
    return out;
}
// Highlight a whole document and return one HTML string per line (tokens can span lines).
function highlightLines(text, lexerName) {
    if (!LEXERS[lexerName] || text.length > 400000)
        return text.split('\n').map(esc);
    const lines = [''];
    const toks = lexerName === 'html' ? htmlToks(text) : lex(text, LEXERS[lexerName]);
    for (const [cls, t] of lexerName === 'css' ? markSelectors(toks) : toks) {
        t.split('\n').forEach((part, i) => {
            if (i > 0)
                lines.push('');
            if (part)
                lines[lines.length - 1] += cls ? `<span class="tk-${cls}">${esc(part)}</span>` : esc(part);
        });
    }
    return lines;
}
const COMMENT = { js: ['// ', ''], java: ['// ', ''], rs: ['// ', ''], py: ['# ', ''], css: ['/* ', ' */'], html: ['<!-- ', ' -->'], md: ['<!-- ', ' -->'] };
const LINT_MAX = 400000;
const PAIRS = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = ')]}';
const SPACE = ' \n\t\r';
// A "/" starts a regex (not a division) after an operator, an opening bracket or one of these keywords.
const REGEX_AFTER = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await|instanceof))\s*$/;
const JS_SCAN = { lineCom: '//', blockCom: true, quotes: `'"`, template: true, regex: true };
const CSS_SCAN = { blockCom: true, quotes: `'"` };
const PY_SCAN = { lineCom: '#', quotes: `'"`, triple: true };
const JAVA_SCAN = { lineCom: '//', blockCom: true, quotes: `'"`, triple: true };
// Rust strings are blanked before the scan (lintRust), so it only checks comments and brackets.
const RS_SCAN = { lineCom: '//', blockCom: true, quotes: '' };
const neverClosed = (s) => ({ at: s.at, len: 1, msg: s.tmpl == null ? `'${s.ch}' is never closed` : 'Template expression is never closed (missing })' });
// Finds unbalanced brackets and unclosed strings/comments. Also returns the text with comments and
// string contents blanked (same length), so later checks don't trip over them.
class CodeScanner {
    diags = [];
    out = [];
    stack = [];
    i = 0;
    last = 0;
    t;
    o;
    constructor(t, o) { this.t = t; this.o = o; }
    run() {
        while (this.i < this.t.length)
            this.step();
        for (const s of this.stack)
            this.diags.push(neverClosed(s));
        this.out.push(this.t.slice(this.last));
        return { diags: this.diags, masked: this.out.join('') };
    }
    // Python joins lines inside strings so a multi-line string reads as one logical line.
    mask(from, to) {
        this.out.push(this.t.slice(this.last, from), this.t.slice(from, to).replace(this.o.triple ? /[^]/g : /[^\n]/g, ' '));
        this.last = to;
    }
    step() {
        const c = this.t[this.i];
        if (SPACE.includes(c)) {
            this.i++;
            return;
        }
        if (this.comment(c) || this.quoted(c) || this.regex(c))
            return;
        if (PAIRS[c]) {
            this.stack.push({ ch: c, at: this.i });
            this.i++;
            return;
        }
        if (CLOSERS.includes(c)) {
            this.close(c);
            return;
        }
        this.i++;
    }
    comment(c) {
        const { t, o, i } = this;
        if (o.lineCom && t.startsWith(o.lineCom, i) && (o.regex || t[i - 1] !== ':')) {
            const e = lineEnd(t, i);
            this.mask(i, e);
            this.i = e;
            return true;
        }
        if (!o.blockCom || c !== '/' || t[i + 1] !== '*')
            return false;
        const e = t.indexOf('*/', i + 2);
        if (e === -1)
            this.unclosed(i, 2, 'Comment is never closed (missing */)');
        else {
            this.mask(i, e + 2);
            this.i = e + 2;
        }
        return true;
    }
    // The rest of the file was swallowed by something that never ends.
    unclosed(at, len, msg) {
        this.diags.push({ at, len, msg });
        this.mask(at + len, this.t.length);
        this.i = this.t.length;
    }
    quoted(c) {
        const { t, o, i } = this;
        if (o.triple && (t.startsWith('"""', i) || t.startsWith("'''", i))) {
            const q = t.slice(i, i + 3), e = t.indexOf(q, i + 3);
            if (e === -1)
                this.unclosed(i, 3, `String is never closed (missing ${q})`);
            else {
                this.mask(i + 3, e);
                this.i = e + 3;
            }
            return true;
        }
        if (o.template && c === '`') {
            this.i = this.template(i + 1, i);
            return true;
        }
        if (!o.quotes.includes(c))
            return false;
        let j = i + 1;
        while (j < t.length && t[j] !== c && t[j] !== '\n')
            j += t[j] === '\\' ? 2 : 1;
        if (t[j] === c) {
            this.mask(i + 1, j);
            this.i = j + 1;
            return true;
        }
        if (o.jsx) {
            this.i++;
            return true;
        } // JSX text can hold a lone apostrophe
        this.diags.push({ at: i, len: Math.max(1, j - i), msg: `String is never closed (missing ${c})` });
        this.mask(i + 1, j);
        this.i = j;
        return true;
    }
    // Continues a template literal from `from` (just after ` or after a ${…}); returns where code resumes.
    template(from, start) {
        const t = this.t;
        for (let j = from; j < t.length; j++) {
            if (t[j] === '\\')
                j++;
            else if (t[j] === '`') {
                this.mask(from, j);
                return j + 1;
            }
            else if (t[j] === '$' && t[j + 1] === '{') {
                this.mask(from, j);
                this.stack.push({ ch: '{', at: j + 1, tmpl: start });
                return j + 2;
            }
        }
        this.diags.push({ at: start, len: 1, msg: 'Template literal is never closed (missing `)' });
        this.mask(from, t.length);
        return t.length;
    }
    regex(c) {
        const { t, i } = this;
        if (!this.o.regex || c !== '/' || !REGEX_AFTER.test(t.slice(Math.max(0, i - 12), i)))
            return false;
        let j = i + 1, inClass = false;
        while (j < t.length && t[j] !== '\n' && (inClass || t[j] !== '/')) {
            if (t[j] === '\\')
                j++;
            else if (t[j] === '[')
                inClass = true;
            else if (t[j] === ']')
                inClass = false;
            j++;
        }
        if (t[j] !== '/')
            return false; // a division after all
        this.mask(i + 1, j);
        this.i = j + 1;
        return true;
    }
    close(c) {
        if (!this.stack.some(s => PAIRS[s.ch] === c)) {
            this.diags.push({ at: this.i, len: 1, msg: `Unexpected '${c}'` });
            this.i++;
            return;
        }
        // Anything opened after the matching bracket was left open.
        while (PAIRS[this.stack.at(-1)?.ch ?? ''] !== c)
            this.diags.push(neverClosed(this.stack.pop()));
        const open = this.stack.pop();
        this.i = open.tmpl == null ? this.i + 1 : this.template(this.i + 1, open.tmpl);
    }
}
const scanCode = (t, o) => new CodeScanner(t, o).run();
// A small JSON parser that reports where the first mistake is. `loose` allows comments and trailing commas (tsconfig etc.).
class JsonChecker {
    i = 0;
    t;
    loose;
    constructor(t, loose) { this.t = t; this.loose = loose; }
    check() {
        try {
            this.ws();
            if (this.i >= this.t.length)
                return [];
            this.value();
            this.ws();
            if (this.i < this.t.length)
                this.fail('Unexpected text after the end of the JSON');
            return [];
        }
        catch (e) {
            if (e instanceof JsonMistake)
                return [e.diag];
            throw e;
        }
    }
    fail(msg, at = this.i, len = 1) { throw new JsonMistake({ at, len, msg }); }
    get ended() { return this.i >= this.t.length; }
    ws() {
        const t = this.t;
        while (!this.ended) {
            if (SPACE.includes(t[this.i]))
                this.i++;
            else if (this.loose && t.startsWith('//', this.i))
                this.i = lineEnd(t, this.i);
            else if (this.loose && t.startsWith('/*', this.i))
                this.skipComment();
            else
                return;
        }
    }
    skipComment() {
        const e = this.t.indexOf('*/', this.i + 2);
        if (e === -1)
            this.fail('Comment is never closed (missing */)', this.i, 2);
        this.i = e + 2;
    }
    str() {
        const t = this.t, s = this.i++;
        while (!this.ended && t[this.i] !== '"' && t[this.i] !== '\n')
            this.i += t[this.i] === '\\' ? 2 : 1;
        if (t[this.i] !== '"')
            this.fail('String is never closed (missing ")', s, Math.max(1, this.i - s));
        this.i++;
    }
    // The items of an object or array, up to the closing bracket.
    list(close, item) {
        this.i++;
        this.ws();
        if (this.t[this.i] === close) {
            this.i++;
            return;
        }
        for (;;) {
            item();
            this.ws();
            if (this.t[this.i] === close) {
                this.i++;
                return;
            }
            if (this.t[this.i] !== ',')
                this.fail(this.ended ? `Expected '${close}' but the file ended` : `Expected ',' or '${close}'`);
            const comma = this.i++;
            this.ws();
            if (this.t[this.i] === close) {
                if (!this.loose)
                    this.fail('Trailing commas are not allowed in JSON', comma);
                this.i++;
                return;
            }
        }
    }
    member() {
        this.ws();
        const c = this.t[this.i];
        if (c !== '"') {
            if (this.ended)
                this.fail('Expected a property name but the file ended');
            this.fail(/['\w$]/.test(c) ? 'Property names need double quotes' : 'Expected a property name');
        }
        this.str();
        this.ws();
        if (this.t[this.i] !== ':')
            this.fail("Expected ':' after the property name");
        this.i++;
        this.value();
    }
    value() {
        this.ws();
        const c = this.t[this.i];
        if (c === '{') {
            this.list('}', () => this.member());
            return;
        }
        if (c === '[') {
            this.list(']', () => this.value());
            return;
        }
        if (c === '"') {
            this.str();
            return;
        }
        const word = ['true', 'false', 'null'].find(w => this.t.startsWith(w, this.i));
        if (word) {
            this.i += word.length;
            return;
        }
        const num = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
        num.lastIndex = this.i;
        const hit = num.exec(this.t);
        if (hit) {
            this.i += hit[0].length;
            return;
        }
        if (c === "'")
            this.fail('Strings need double quotes in JSON');
        this.fail(this.ended ? 'Expected a value but the file ended' : `Unexpected '${c}'`);
    }
}
class JsonMistake extends Error {
    diag;
    constructor(diag) { super(diag.msg); this.diag = diag; }
}
// CSS: every declaration inside a rule needs "property: value", and a ';' before the next one.
function cssDeclMistake(text, at) {
    if (!text.includes(':'))
        return { at, len: text.length, msg: "Expected ':' between the property and its value" };
    const rows = text.split('\n');
    const k = rows.findIndex((r, n) => n < rows.length - 1 && r.includes(':') && /^\s*[-\w]+\s*:/.test(rows[n + 1]));
    return k === -1 ? null : { at: at + rows.slice(0, k + 1).join('\n').length, len: 1, msg: "Missing ';' at the end of this line" };
}
function lintCssDecls(masked) {
    const out = [];
    let depth = 0, seg = 0;
    for (let i = 0; i < masked.length; i++) {
        const c = masked[i];
        if (c !== '{' && c !== '}' && c !== ';')
            continue;
        const text = masked.slice(seg, i), s = text.trim();
        const mistake = depth > 0 && c !== '{' && s && !s.startsWith('@') ? cssDeclMistake(s, seg + text.indexOf(s[0])) : null;
        if (mistake)
            out.push(mistake);
        depth = Math.max(0, depth + (c === '{' ? 1 : 0) - (c === '}' ? 1 : 0));
        seg = i + 1;
    }
    return out;
}
// Python: block statements end in ':' and indentation has to line up.
const PY_BLOCK = /^(?:async\s+)?(if|elif|else|for|while|def|class|try|except|finally|with)\b/;
const bracketDelta = (ln) => [...ln].reduce((d, ch) => d + Number('([{'.includes(ch)) - Number(')]}'.includes(ch)), 0);
// Joins lines that continue inside brackets or after a backslash.
function logicalLines(masked) {
    const lines = [];
    let cur = null;
    let off = 0, depth = 0;
    for (const ln of masked.split('\n')) {
        const at = off;
        off += ln.length + 1;
        if (!cur && !ln.trim())
            continue;
        if (cur)
            cur.text += '\n' + ln;
        else
            cur = { at, text: ln };
        depth = Math.max(0, depth + bracketDelta(ln));
        if (depth === 0 && !/\\\s*$/.test(ln)) {
            lines.push(cur);
            cur = null;
        }
    }
    if (cur)
        lines.push(cur);
    return lines;
}
// The block's ':' sits outside any brackets (and isn't a := walrus).
function hasBlockColon(body) {
    let d = 0;
    for (let k = 0; k < body.length; k++) {
        const ch = body[k];
        if ('([{'.includes(ch))
            d++;
        else if (')]}'.includes(ch))
            d--;
        else if (ch === ':' && d === 0 && body[k + 1] !== '=')
            return true;
    }
    return false;
}
class PythonChecker {
    out = [];
    indents = [0];
    opener = null; // the keyword of the previous line, if it ended with ':'
    line(L) {
        const lead = /^[ \t]*/.exec(L.text)?.[0] ?? '';
        const body = L.text.trim();
        this.indent(L, lead);
        const kw = PY_BLOCK.exec(body)?.[1] ?? null;
        if (kw && !hasBlockColon(body))
            this.out.push({ at: L.at + L.text.trimEnd().length, len: 1, msg: `Expected ':' after the '${kw}' line` });
        this.opener = /:\s*$/.test(body) ? kw ?? '' : null;
    }
    indent(L, lead) {
        const ind = lead.replaceAll('\t', '        ').length;
        const top = this.indents.at(-1) ?? 0;
        const span = Math.max(1, lead.length);
        if (this.opener !== null && ind <= top) {
            const after = this.opener ? ` after the '${this.opener}' line` : '';
            this.out.push({ at: L.at + lead.length, len: 1, msg: 'Expected an indented block' + after });
        }
        else if (ind > top) {
            if (this.opener === null)
                this.out.push({ at: L.at, len: span, msg: 'Unexpected indent' });
            else
                this.indents.push(ind);
        }
        else if (ind < top) {
            while (this.indents.length > 1 && (this.indents.at(-1) ?? 0) > ind)
                this.indents.pop();
            if (this.indents.at(-1) !== ind)
                this.out.push({ at: L.at, len: span, msg: 'This indent does not match any outer block' });
        }
    }
}
function lintPython(masked) {
    const checker = new PythonChecker();
    for (const L of logicalLines(masked))
        checker.line(L);
    return checker.out;
}
// HTML (and strict XML/SVG): every element that needs a closing tag gets one, in the right order.
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const OPTIONAL_END = new Set(['html', 'head', 'body', 'p', 'li', 'dt', 'dd', 'option', 'optgroup', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'colgroup', 'caption', 'rb', 'rt', 'rtc', 'rp']);
const RAW_TAGS = new Set(['script', 'style', 'textarea', 'title']);
const JS_TYPES = new Set(['module', 'text/javascript', 'application/javascript']);
const MARKUP = /<!--|<!\[CDATA\[|<[!?]|<\/?([A-Za-z][\w:.-]*)/g;
class MarkupChecker {
    out = [];
    stack = [];
    lower;
    re = new RegExp(MARKUP.source, 'g');
    t;
    xml;
    constructor(t, xml) {
        this.t = t;
        this.xml = xml;
        this.lower = xml ? t : t.toLowerCase();
    }
    run() {
        for (let m = this.re.exec(this.t); m; m = this.re.exec(this.t))
            if (!this.token(m))
                break;
        for (const s of this.stack)
            if (this.needsEnd(s.name))
                this.out.push({ at: s.at, len: s.len, msg: `<${s.name}> is never closed` });
        return this.out;
    }
    needsEnd(name) { return this.xml || !OPTIONAL_END.has(name); }
    isVoid(name) { return !this.xml && VOID_TAGS.has(name); }
    // Handles one match; false stops the scan (the rest of the file is unreadable).
    token(m) {
        if (m[0] === '<!--')
            return this.skipTo(m, '-->', 'Comment');
        if (m[0] === '<![CDATA[')
            return this.skipTo(m, ']]>', 'CDATA section');
        if (!m[1])
            return this.skipTo(m, '>', 'Tag');
        const end = this.tagEnd(m);
        if (end === -1)
            return true;
        const name = this.xml ? m[1] : m[1].toLowerCase();
        const tag = { name, at: m.index, len: end + 1 - m.index };
        this.re.lastIndex = end + 1;
        if (m[0][1] === '/')
            this.closeTag(tag, m[1]);
        else
            this.openTag(tag, m[0].length, this.t.slice(m.index + m[0].length, end));
        return true;
    }
    skipTo(m, end, what) {
        const e = this.t.indexOf(end, m.index + m[0].length);
        if (e === -1) {
            this.out.push({ at: m.index, len: m[0].length, msg: `${what} is never closed (missing ${end})` });
            return false;
        }
        this.re.lastIndex = e + end.length;
        return true;
    }
    // Finds the tag's '>' while skipping quoted attribute values; -1 (and a problem) when there is none.
    tagEnd(m) {
        const t = this.t;
        let j = m.index + m[0].length, q = '';
        for (; j < t.length; j++) {
            const c = t[j];
            if (q) {
                if (c === q)
                    q = '';
            }
            else if (c === '"' || c === "'")
                q = c;
            else if (c === '>' || c === '<')
                break;
        }
        if (t[j] === '>')
            return j;
        const msg = q ? `Attribute value is never closed (missing ${q})` : `<${m[1]}> tag is never closed (missing >)`;
        this.out.push({ at: m.index, len: m[0].length, msg });
        this.re.lastIndex = j;
        return -1;
    }
    closeTag(tag, raw) {
        if (this.isVoid(tag.name)) {
            this.out.push({ ...tag, msg: `<${raw}> never takes a closing tag` });
            return;
        }
        const k = this.stack.map(s => s.name).lastIndexOf(tag.name);
        if (k < 0) {
            this.out.push({ ...tag, msg: `Unexpected </${raw}>: no <${raw}> is open here` });
            return;
        }
        for (const s of this.stack.splice(k).slice(1)) {
            if (this.needsEnd(s.name))
                this.out.push({ at: s.at, len: s.len, msg: `<${s.name}> is never closed (expected </${s.name}> before </${raw}>)` });
        }
    }
    openTag(tag, nameLen, attrs) {
        if (attrs.endsWith('/') || this.isVoid(tag.name))
            return;
        this.stack.push({ name: tag.name, at: tag.at, len: nameLen });
        if (!this.xml && RAW_TAGS.has(tag.name))
            this.rawText(tag.name, attrs);
    }
    // <script>, <style>…: skip to the closing tag, checking the code inside on the way.
    rawText(name, attrs) {
        const from = this.re.lastIndex;
        const end = this.lower.indexOf(`</${name}`, from);
        if (end === -1) {
            this.re.lastIndex = this.t.length;
            return;
        } // reported as never closed
        const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1].toLowerCase();
        let opts = null;
        if (name === 'style')
            opts = CSS_SCAN;
        else if (name === 'script' && (!type || JS_TYPES.has(type)))
            opts = JS_SCAN;
        if (opts)
            for (const d of scanCode(this.t.slice(from, end), opts).diags)
                this.out.push({ ...d, at: d.at + from });
        this.re.lastIndex = end;
    }
}
const JS_EXT = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx']);
const V8_EXT = new Set(['js', 'mjs', 'cjs', 'ts', 'mts', 'cts']); // JSX/TSX need a JSX-aware parser
const looseJson = (path) => /^(?:tsconfig|jsconfig)\b/i.test(baseName(path)) || path.startsWith('.vscode/');
function lintCss(text, ext) {
    const r = scanCode(text, ext === 'css' ? CSS_SCAN : { ...CSS_SCAN, lineCom: '//' });
    return ext === 'css' && !r.diags.length ? lintCssDecls(r.masked) : r.diags;
}
function lintPy(text) {
    const r = scanCode(text, PY_SCAN);
    return r.diags.length ? r.diags : lintPython(r.masked);
}
// Rust strings may span lines and hold raw text (r#"…"#), and a lone ' starts a lifetime rather than a string, so
// strings and chars are blanked first (comments stay for the scanner).
const RS_TEXT = /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|b?r(#?)"[\s\S]*?(?:"\1|$)|b?"(?:\\[\s\S]|[^"\\])*(?:"|$)|b?'(?:\\[\s\S]|[^\\'\n])'/g;
function lintRust(text) {
    const diags = [];
    const blanked = text.replace(RS_TEXT, (m, hash, at) => {
        if (m.startsWith('/'))
            return m;
        const open = m.indexOf('"'), close = '"' + (hash ?? '');
        if (open >= 0 && (m.length < open + 1 + close.length || !m.endsWith(close)))
            diags.push({ at, len: open + 1, msg: `String is never closed (missing ${close})` });
        return m.replace(/[^\n]/g, ' ');
    });
    return diags.concat(scanCode(blanked, RS_SCAN).diags);
}
// Which check runs for each file extension.
const LINTERS = {
    json: (t, p) => new JsonChecker(t, looseJson(p)).check(),
    jsonc: t => new JsonChecker(t, true).check(),
    css: t => lintCss(t, 'css'), scss: t => lintCss(t, 'scss'), less: t => lintCss(t, 'less'),
    html: t => new MarkupChecker(t, false).run(), htm: t => new MarkupChecker(t, false).run(), vue: t => new MarkupChecker(t, false).run(),
    xml: t => new MarkupChecker(t, true).run(), svg: t => new MarkupChecker(t, true).run(),
    py: lintPy,
    java: t => scanCode(t, JAVA_SCAN).diags,
    rs: lintRust,
};
for (const ext of JS_EXT)
    LINTERS[ext] = t => scanCode(t, { ...JS_SCAN, jsx: ext === 'jsx' || ext === 'tsx' }).diags;
function lintStructure(text, path) {
    return LINTERS[extOf(path)]?.(text, path) ?? [];
}
function toDiags(t, raw) {
    const starts = [0];
    for (let k = t.indexOf('\n'); k !== -1; k = t.indexOf('\n', k + 1))
        starts.push(k + 1);
    return raw.map(d => {
        let lo = 0, hi = starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid] <= d.at)
                lo = mid;
            else
                hi = mid - 1;
        }
        return { line: lo, col: d.at - starts[lo], len: d.len, msg: d.msg };
    }).sort((a, b) => a.line - b.line || a.col - b.col);
}
/* ----- Colored file & folder icons (16×16 inline SVG) ----- */
const svg16 = (body) => `<svg viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
const badge = (bg, fg, label, size = 6.4) => svg16(`<rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="${bg}"/><text x="8" y="11.2" text-anchor="middle" font-family="Inter,Segoe UI,sans-serif" font-weight="800" font-size="${size}" fill="${fg}">${label}</text>`);
const page = (color, inner = '') => svg16(`<path d="M3.5 1.5h6l3 3v10h-9z" fill="${color}" fill-opacity=".16" stroke="${color}" stroke-width="1.1" stroke-linejoin="round"/><path d="M9.5 1.5v3h3" fill="none" stroke="${color}" stroke-width="1.1" stroke-linejoin="round"/>${inner}`);
const ICONS = {
    html: svg16('<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" fill="none" stroke="#f16529" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="m9 3.5-2 9" stroke="#f9a77d" stroke-width="1.4" stroke-linecap="round"/>'),
    css: svg16('<path d="M6.3 2.5 5 13.5M11 2.5 9.7 13.5M2.8 6h11M2.2 10h11" fill="none" stroke="#42a5f5" stroke-width="1.6" stroke-linecap="round"/>'),
    scss: svg16('<circle cx="8" cy="8" r="6.5" fill="#cd6799"/><path d="M10.5 5.5c-1-1-4-.6-4 .9 0 1.6 3.5 1.3 3.5 3 0 1.4-2.6 1.6-3.8.6" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/>'),
    js: badge('#f1d33b', '#1e1e1e', 'JS'),
    ts: badge('#3178c6', '#ffffff', 'TS'),
    cs: badge('#68217a', '#ffffff', 'C#'),
    jsx: svg16('<g fill="none" stroke="#61dafb" stroke-width="1"><ellipse cx="8" cy="8" rx="6.6" ry="2.6"/><ellipse cx="8" cy="8" rx="6.6" ry="2.6" transform="rotate(60 8 8)"/><ellipse cx="8" cy="8" rx="6.6" ry="2.6" transform="rotate(120 8 8)"/></g><circle cx="8" cy="8" r="1.4" fill="#61dafb"/>'),
    json: svg16('<path d="M6 2.5c-1.6 0-1.8.8-1.8 2v1.3c0 1-.5 1.7-1.7 1.9v.6c1.2.2 1.7.9 1.7 1.9v1.3c0 1.2.2 2 1.8 2M10 2.5c1.6 0 1.8.8 1.8 2v1.3c0 1 .5 1.7 1.7 1.9v.6c-1.2.2-1.7.9-1.7 1.9v1.3c0 1.2-.2 2-1.8 2" fill="none" stroke="#f5b942" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="8" r="1" fill="#f5b942"/>'),
    md: svg16('<rect x="1" y="3.5" width="14" height="9" rx="2" fill="none" stroke="#6aa8d8" stroke-width="1.2"/><path d="M3.5 10.5v-4l1.8 2 1.8-2v4M11.2 6.3v4M9.6 8.9l1.6 1.6 1.6-1.6" fill="none" stroke="#6aa8d8" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>'),
    image: svg16('<rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="#b388ff" fill-opacity=".18" stroke="#b388ff" stroke-width="1.2"/><circle cx="5.5" cy="6" r="1.3" fill="#ffd166"/><path d="m2.5 12.5 4-4 2.5 2.5 1.8-1.8 3 3.3z" fill="#b388ff"/>'),
    svg: svg16('<path d="M8 1.8 14.2 8 8 14.2 1.8 8z" fill="#ffb13b" fill-opacity=".2" stroke="#ffb13b" stroke-width="1.2" stroke-linejoin="round"/><circle cx="8" cy="8" r="1.6" fill="#ffb13b"/>'),
    env: svg16('<circle cx="5.5" cy="8" r="3" fill="none" stroke="#e5c07b" stroke-width="1.5"/><path d="M8.5 8h6M12.5 8v2.4M14.5 8v1.6" fill="none" stroke="#e5c07b" stroke-width="1.5" stroke-linecap="round"/>'),
    git: svg16('<path d="M8 1.6 14.4 8 8 14.4 1.6 8z" fill="#f05033"/><path d="M6.4 5.2v5.6M6.4 6.6 9.6 9.4" stroke="#fff" stroke-width="1.1" stroke-linecap="round"/><circle cx="6.4" cy="10.6" r="1" fill="#fff"/><circle cx="9.6" cy="9.4" r="1" fill="#fff"/><circle cx="6.4" cy="5" r="1" fill="#fff"/>'),
    node: svg16('<path d="M8 1.3 13.8 4.6v6.8L8 14.7 2.2 11.4V4.6z" fill="#8cc84b" fill-opacity=".2" stroke="#8cc84b" stroke-width="1.2" stroke-linejoin="round"/><path d="M6 6.2v3.6M10 6.2v3.6M6 6.2l4 3.6" stroke="#8cc84b" stroke-width="1.2" stroke-linecap="round"/>'),
    py: svg16('<path d="M8 1.5c-3 0-3 1.3-3 2.3V6h3.2v.6H3.6C2.3 6.6 1.5 7.6 1.5 9.4s.8 2.9 2 2.9H5V10.5c0-1.2 1-2.2 2.2-2.2h3.3c1 0 1.8-.8 1.8-1.8V3.8c0-1.2-1.2-2.3-4.3-2.3z" fill="#3776ab"/><path d="M8 14.5c3 0 3-1.3 3-2.3V10H7.8v-.6h4.6c1.3 0 2.1-1 2.1-2.8s-.8-2.9-2-2.9H11v1.8c0 1.2-1 2.2-2.2 2.2H5.5c-1 0-1.8.8-1.8 1.8v2.7c0 1.2 1.2 2.3 4.3 2.3z" fill="#ffd43b"/>'),
    // The real Java and Rust logos, kept once as symbols in breeze.html's sprite.
    java: '<svg viewBox="0 0 16 16" aria-hidden="true"><use href="#i-lang-java" width="16" height="16"/></svg>',
    rust: '<svg viewBox="0 0 16 16" aria-hidden="true"><use href="#i-lang-rust" width="16" height="16"/></svg>',
    cpp: '<svg viewBox="0 0 16 16" aria-hidden="true"><use href="#i-lang-cpp" width="16" height="16"/></svg>',
    exe: svg16('<rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="#4aa3ff" fill-opacity=".16" stroke="#4aa3ff" stroke-width="1.2"/><path d="M1.5 5.5h13" stroke="#4aa3ff" stroke-width="1.2"/><circle cx="3.7" cy="4" r=".6" fill="#4aa3ff"/><path d="m6.5 8 2 1.6-2 1.6" fill="none" stroke="#4aa3ff" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>'),
    bin: page('#9aa5b1', '<path d="M5.6 7.6v2M5.6 11.4v.2M8 7.6v.2M8 9.4v2M10.4 7.6v2M10.4 11.4v.2" stroke="#9aa5b1" stroke-width="1.1" stroke-linecap="round"/>'),
    archive: page('#e6a23c', '<path d="M8 2v8" stroke="#e6a23c" stroke-width="1.2" stroke-dasharray="1.2 1.2"/><rect x="6.6" y="10.2" width="2.8" height="2.4" rx=".6" fill="none" stroke="#e6a23c" stroke-width="1"/>'),
    pdf: badge('#e5483f', '#ffffff', 'PDF', 4.6),
    doc: badge('#2b6cb0', '#ffffff', 'DOC', 4.6),
    xls: badge('#1f8a4c', '#ffffff', 'XLS', 4.6),
    ppt: badge('#d9622b', '#ffffff', 'PPT', 4.6),
    c: badge('#5a6dbd', '#ffffff', 'C'),
    h: badge('#8a63d2', '#ffffff', 'H'),
    go: badge('#00add8', '#ffffff', 'GO', 5.4),
    php: badge('#777bb4', '#ffffff', 'PHP', 4.6),
    rb: svg16('<path d="M4 2.5h8l2.5 3.5L8 14 1.5 6z" fill="#cc342d" fill-opacity=".25" stroke="#cc342d" stroke-width="1.2" stroke-linejoin="round"/><path d="M1.5 6h13M5.5 6 8 14l2.5-8M4 2.5 5.5 6 8 2.5 10.5 6 12 2.5" fill="none" stroke="#cc342d" stroke-width=".9" stroke-linejoin="round"/>'),
    kt: badge('#7f52ff', '#ffffff', 'KT', 5.4),
    swift: badge('#f05138', '#ffffff', 'SW', 5.4),
    sql: svg16('<ellipse cx="8" cy="4" rx="5" ry="2" fill="#42a5f5" fill-opacity=".25" stroke="#42a5f5" stroke-width="1.2"/><path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" fill="none" stroke="#42a5f5" stroke-width="1.2"/>'),
    audio: svg16('<path d="M6 11.5V3.5l7-1.5v8" fill="none" stroke="#ec6aa5" stroke-width="1.4" stroke-linejoin="round"/><circle cx="4.6" cy="11.6" r="1.7" fill="#ec6aa5"/><circle cx="11.6" cy="10.2" r="1.7" fill="#ec6aa5"/>'),
    video: svg16('<rect x="1.5" y="3" width="13" height="10" rx="2" fill="#ff7043" fill-opacity=".18" stroke="#ff7043" stroke-width="1.2"/><path d="m6.8 6 3.4 2-3.4 2z" fill="#ff7043"/>'),
    font: badge('#9c7fd1', '#ffffff', 'Aa', 5.6),
    shell: svg16('<rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="#4caf50" fill-opacity=".14" stroke="#4caf50" stroke-width="1.2"/><path d="m4.3 6 2.2 2-2.2 2M8 10.5h3.5" fill="none" stroke="#4caf50" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'),
    config: page('#c792ea', '<path d="M5.5 8h5M5.5 10.5h3.5" stroke="#c792ea" stroke-width="1.1" stroke-linecap="round"/>'),
    text: page('#a1a1aa', '<path d="M5.5 7.5h5M5.5 9.5h5M5.5 11.5h3" stroke="#a1a1aa" stroke-width="1" stroke-linecap="round"/>'),
    lock: page('#8b8b95', '<rect x="5.6" y="8.6" width="4.8" height="3.6" rx=".8" fill="#8b8b95"/><path d="M6.6 8.6V7.6a1.4 1.4 0 0 1 2.8 0v1" fill="none" stroke="#8b8b95" stroke-width="1"/>'),
    license: page('#e5c07b', '<circle cx="8" cy="9" r="1.8" fill="none" stroke="#e5c07b" stroke-width="1"/>'),
    file: page('#8b8b95'),
};
const EXT_ICON = {
    html: 'html', htm: 'html', xml: 'html', vue: 'html', css: 'css', less: 'css', scss: 'scss', sass: 'scss',
    js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', tsx: 'jsx', ts: 'ts', mts: 'ts', cts: 'ts', json: 'json', jsonc: 'json', md: 'md', markdown: 'md',
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', ico: 'image', bmp: 'image', avif: 'image', svg: 'svg',
    py: 'py', java: 'java', jar: 'java', rs: 'rust', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', cs: 'cs', csx: 'cs', csproj: 'config', sln: 'config', sh: 'shell', bash: 'shell', ps1: 'shell', bat: 'shell', cmd: 'shell', yml: 'config', yaml: 'config', toml: 'config', ini: 'config',
    txt: 'text', log: 'text', csv: 'text', tsv: 'text', rtf: 'text', lock: 'lock', exe: 'exe', msi: 'exe', app: 'exe', apk: 'exe', com: 'exe', scr: 'exe', dll: 'bin', so: 'bin', dylib: 'bin', bin: 'bin', o: 'bin', obj: 'bin', a: 'bin', lib: 'bin', class: 'bin', pyc: 'bin', wasm: 'bin', iso: 'bin', img: 'bin', dat: 'bin', zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive', tgz: 'archive', bz2: 'archive', xz: 'archive', pdf: 'pdf', doc: 'doc', docx: 'doc', odt: 'doc', xls: 'xls', xlsx: 'xls', ods: 'xls', ppt: 'ppt', pptx: 'ppt', odp: 'ppt', c: 'c', h: 'h', go: 'go', php: 'php', rb: 'rb', kt: 'kt', kts: 'kt', swift: 'swift', sql: 'sql', db: 'sql', sqlite: 'sql', sqlite3: 'sql', mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio', m4a: 'audio', aac: 'audio', mp4: 'video', mkv: 'video', mov: 'video', avi: 'video', webm: 'video', ttf: 'font', otf: 'font', woff: 'font', woff2: 'font', tiff: 'image', heic: 'image', psd: 'image',
};
function fileIcon(name) {
    const n = name.toLowerCase();
    if (n.startsWith('.env'))
        return ICONS.env;
    if (n.startsWith('.git'))
        return ICONS.git;
    if (n === 'package.json' || n === 'package-lock.json' || n === '.npmrc' || n === '.nvmrc')
        return ICONS.node;
    if (n.startsWith('license'))
        return ICONS.license;
    if (/^(tsconfig|jsconfig)[\w.-]*\.json$/.test(n))
        return ICONS.ts;
    if (n === 'cargo.toml' || n === 'cargo.lock')
        return ICONS.rust;
    const ext = n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : '';
    return ICONS[EXT_ICON[ext] ?? 'file'];
}
// Folder colours follow what the folder usually holds.
const FOLDER_COLORS = [
    [/^(src|app|lib|source)$/, '#7aa9ff'], [/^(node_modules)$/, '#8cc84b'], [/^\.git$/, '#f05033'], [/^\.(claude|vscode|idea|github)$/, '#d97757'],
    [/^(assets|images?|img|public|static|media|icons?)$/, '#ffb74d'], [/^(tests?|__tests__|spec)$/, '#4db6ac'], [/^(dist|build|out|\.next)$/, '#9e9e9e'],
    [/^(components?|ui|views?|pages?)$/, '#c4b5fd'], [/^(styles?|css)$/, '#42a5f5'], [/^(docs?)$/, '#6aa8d8'],
];
function folderIcon(name, open) {
    const c = FOLDER_COLORS.find(([re]) => re.test(name.toLowerCase()))?.[1] ?? '#90a4c4';
    return open
        ? svg16(`<path d="M1.5 4a1 1 0 0 1 1-1h3.4l1.4 1.5h5.7a1 1 0 0 1 1 1V7H4.2a1 1 0 0 0-.95.68L1.5 12.5z" fill="${c}" fill-opacity=".55"/><path d="M3.3 7.7A1 1 0 0 1 4.25 7h10.3l-1.9 5.8a1 1 0 0 1-.95.7H1.5z" fill="${c}"/>`)
        : svg16(`<path d="M1.5 4a1 1 0 0 1 1-1h3.4l1.4 1.5h6.2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="${c}"/><path d="M1.5 6h13" stroke="#000" stroke-opacity=".18"/>`);
}
const CHEV = '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
let rootInfo = null;
const dirCache = new Map();
const expanded = new Set();
const buffers = new Map();
const textareaOwner = new WeakMap();
const isDirty = (b) => !!b && b.kind === 'text' && b.text !== b.saved;
let sessionTimer;
let openTabs = [];
let active = null;
const locks = {};
const added = {};
let ctxPath = null;
async function refreshLiveShare() {
    const button = $('#liveShare');
    const status = await api.live.status().catch(() => null);
    const show = !!rootInfo && !!status?.available;
    const running = !!status?.running;
    button.classList.toggle('hidden', !show);
    button.classList.toggle('live', running);
    button.title = running
        ? `Live Share is running at ${status?.url ?? ''} · Click to turn off`
        : 'Host index.html locally and open it in your browser';
    $('span', button).textContent = running ? 'Live Share: on' : 'Live Share';
    void setIcon(button, running ? 'stop' : 'play');
}
async function toggleLiveShare() {
    try {
        const current = await api.live.status().catch(() => null);
        if (current?.running) {
            await api.live.stop();
            await refreshLiveShare();
            toast('Live Share turned off');
            return;
        }
        const live = await api.live.start();
        await refreshLiveShare();
        toast(`Live Share opened at ${live.url}`);
    }
    catch (e) {
        toast(errMsg(e));
    }
}
$('#liveShare').onclick = () => background(toggleLiveShare());
const sessionKey = () => `breeze.session:${rootInfo?.root ?? ''}`;
const hotExitKey = () => `breeze.dirty:${rootInfo?.root ?? ''}`;
function saveSession() {
    if (!rootInfo)
        return;
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(flushSession, 300);
}
function flushSession() {
    if (!rootInfo)
        return;
    clearTimeout(sessionTimer);
    const pos = {};
    for (const b of buffers.values())
        if (b.ta)
            pos[b.path] = [b.ta.selectionStart, b.ta.scrollTop];
    store.set(sessionKey(), { tabs: openTabs, active, expanded: [...expanded], pos });
    // Hot exit: unsaved edits survive a reload or a crash.
    const dirty = {};
    for (const b of buffers.values())
        if (isDirty(b))
            dirty[b.path] = b.text;
    if (Object.keys(dirty).length)
        store.set(hotExitKey(), dirty);
    else
        store.del(hotExitKey());
}
window.addEventListener('beforeunload', flushSession);
/* ----- Dropping files from the computer ----- */
// Files dragged in from Explorer are copied into the project: into the clicked folder in the explorer, or the open
// file's folder when dropped on the editor. Anywhere else the drop is refused (it would replace Breeze with the file).
const DROP_MAX_FILES = 500;
const DROP_MAX_BYTES = 50 * 1024 * 1024;
const DROP_SKIP = new Set(['.git', 'node_modules']);
let dropMark = null;
let draggedTreePath = null;
let draggedTreeIsDir = false;
let agentDropMark = null;
const hasFiles = (e) => !!e.dataTransfer?.types.includes('Files');
function markDrop(el) {
    if (dropMark === el)
        return;
    dropMark?.classList.remove('drop-over');
    dropMark = el;
    el?.classList.add('drop-over');
}
const fluidCanvases = new Map();
function sampleBorder(W, H, R, count) {
    const r = Math.max(0, Math.min(R, W / 2, H / 2));
    const wStraight = Math.max(0, W - 2 * r);
    const hStraight = Math.max(0, H - 2 * r);
    const cornerLen = r > 0.5 ? (Math.PI / 2) * r : 0;
    const P = 2 * wStraight + 2 * hStraight + 4 * cornerLen;
    if (P <= 0)
        return { P: 0, samples: [] };
    const samples = [];
    for (let i = 0; i < count; i++) {
        const s = (i / count) * P;
        let bx, by, nx, ny;
        if (r <= 0.5) {
            if (s <= W) {
                bx = s;
                by = 0;
                nx = 0;
                ny = 1;
            }
            else if (s <= W + H) {
                bx = W;
                by = s - W;
                nx = -1;
                ny = 0;
            }
            else if (s <= 2 * W + H) {
                bx = W - (s - W - H);
                by = H;
                nx = 0;
                ny = -1;
            }
            else {
                bx = 0;
                by = H - (s - 2 * W - H);
                nx = 1;
                ny = 0;
            }
        }
        else {
            if (s <= wStraight) {
                bx = r + s;
                by = 0;
                nx = 0;
                ny = 1;
            }
            else if (s <= wStraight + cornerLen) {
                const frac = (s - wStraight) / cornerLen;
                const angle = -Math.PI / 2 + frac * (Math.PI / 2);
                bx = W - r + Math.cos(angle) * r;
                by = r + Math.sin(angle) * r;
                nx = -Math.cos(angle);
                ny = -Math.sin(angle);
            }
            else if (s <= wStraight + cornerLen + hStraight) {
                const dist = s - (wStraight + cornerLen);
                bx = W;
                by = r + dist;
                nx = -1;
                ny = 0;
            }
            else if (s <= wStraight + 2 * cornerLen + hStraight) {
                const frac = (s - (wStraight + cornerLen + hStraight)) / cornerLen;
                const angle = frac * (Math.PI / 2);
                bx = W - r + Math.cos(angle) * r;
                by = H - r + Math.sin(angle) * r;
                nx = -Math.cos(angle);
                ny = -Math.sin(angle);
            }
            else if (s <= 2 * wStraight + 2 * cornerLen + hStraight) {
                const dist = s - (wStraight + 2 * cornerLen + hStraight);
                bx = W - r - dist;
                by = H;
                nx = 0;
                ny = -1;
            }
            else if (s <= 2 * wStraight + 3 * cornerLen + hStraight) {
                const frac = (s - (2 * wStraight + 2 * cornerLen + hStraight)) / cornerLen;
                const angle = Math.PI / 2 + frac * (Math.PI / 2);
                bx = r + Math.cos(angle) * r;
                by = H - r + Math.sin(angle) * r;
                nx = -Math.cos(angle);
                ny = -Math.sin(angle);
            }
            else if (s <= 2 * wStraight + 3 * cornerLen + 2 * hStraight) {
                const dist = s - (2 * wStraight + 3 * cornerLen + hStraight);
                bx = 0;
                by = H - r - dist;
                nx = 1;
                ny = 0;
            }
            else {
                const frac = (s - (2 * wStraight + 3 * cornerLen + 2 * hStraight)) / cornerLen;
                const angle = Math.PI + frac * (Math.PI / 2);
                bx = r + Math.cos(angle) * r;
                by = r + Math.sin(angle) * r;
                nx = -Math.cos(angle);
                ny = -Math.sin(angle);
            }
        }
        samples.push({ bx, by, nx, ny, s });
    }
    return { P, samples };
}
function drawFluidBlurFade(p) {
    const { ctx, samples, P, energies, gx, gy, cfg, W, H } = p;
    const N = samples.length;
    if (N < 4 || P <= 0)
        return;
    const t = cfg.t * cfg.speed;
    const maxSafeDepth = Math.max(24, Math.min(150, Math.min(W, H) * 0.45));
    const [m1, m2, m3, m4] = cfg.harmonics;
    const k1 = (2 * Math.PI * m1) / P;
    const k2 = (2 * Math.PI * m2) / P;
    const k3 = (2 * Math.PI * m3) / P;
    const k4 = (2 * Math.PI * m4) / P;
    const kSwell = (2 * Math.PI * cfg.swellM) / P;
    const outerPts = [];
    const innerPts = [];
    // Buffer offset set to 0 so the blur fade shape fills out directly to the border gap
    const borderBuffer = 0;
    for (let i = 0; i < N; i++) {
        const s = samples[i];
        const S = s.s;
        // Slower, smoother harmonic wave superposition for tranquil breathing motion
        const w1 = Math.sin(k1 * S + t * 0.9);
        const w2 = Math.sin(k2 * S - t * 1.3 + 1.2);
        const w3 = Math.cos(k3 * S + t * 1.7 + 2.5);
        const w4 = Math.sin(k4 * S - t * 2.1 + 3.7);
        const swell = 0.5 + 0.5 * Math.sin(kSwell * S + t * 0.5);
        // Variation factor creating organic, gentle differing wave heights along the border
        const variation = Math.max(0.12, 0.48 + 0.32 * swell + 0.28 * w1 + 0.2 * w2 + 0.12 * w3 + 0.08 * w4);
        // Local energy from state.energies[i] (smooth attack on entry, graceful decay on leave)
        const energy = energies ? (energies[i] || 0) : 0;
        // Modulate depth by energy: when leaving, wave smoothly recedes to border (depth -> 0)
        const baseH = cfg.baseDepth * (0.5 + 0.5 * variation);
        const surgeH = cfg.maxSurge * variation;
        const depth = Math.min(maxSafeDepth, (baseH + surgeH) * energy);
        outerPts.push([s.bx + s.nx * borderBuffer, s.by + s.ny * borderBuffer]);
        innerPts.push([s.bx + s.nx * (borderBuffer + depth), s.by + s.ny * (borderBuffer + depth)]);
    }
    // Draw fluid body ribbon as a pure, soft atmospheric blur fade (NO solid lines, NO border contact)
    ctx.save();
    ctx.filter = `blur(${cfg.blurRadius}px)`;
    ctx.beginPath();
    // Outer perimeter loop (buffered inward)
    ctx.moveTo(outerPts[0][0], outerPts[0][1]);
    for (let i = 1; i < N; i++) {
        ctx.lineTo(outerPts[i][0], outerPts[i][1]);
    }
    ctx.closePath();
    // Inner wavy boundary loop in reverse (smooth quadratic curves)
    ctx.moveTo(innerPts[0][0], innerPts[0][1]);
    for (let i = N - 1; i >= 0; i--) {
        const curr = innerPts[i];
        const prev = innerPts[(i - 1 + N) % N];
        const midX = (curr[0] + prev[0]) / 2;
        const midY = (curr[1] + prev[1]) / 2;
        ctx.quadraticCurveTo(curr[0], curr[1], midX, midY);
    }
    ctx.closePath();
    // Radial gradient centered at border focal point (gx, gy)
    const grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, cfg.influenceRadius * 1.35);
    for (const cs of cfg.colorStops) {
        grad.addColorStop(cs.stop, cs.color);
    }
    ctx.fillStyle = grad;
    ctx.fill('evenodd');
    ctx.restore();
}
function getDistToRoundedBorder(x, y, w, h, r) {
    const clampR = Math.min(r, w / 2, h / 2);
    if (clampR <= 0.5) {
        return Math.min(x, w - x, y, h - y);
    }
    if (x < clampR && y < clampR) {
        return clampR - Math.hypot(clampR - x, clampR - y);
    }
    if (x > w - clampR && y < clampR) {
        return clampR - Math.hypot(x - (w - clampR), clampR - y);
    }
    if (x < clampR && y > h - clampR) {
        return clampR - Math.hypot(clampR - x, y - (h - clampR));
    }
    if (x > w - clampR && y > h - clampR) {
        return clampR - Math.hypot(x - (w - clampR), y - (h - clampR));
    }
    return Math.min(x, w - x, y, h - y);
}
function drawFluidDotGrid(params) {
    const { ctx, w, h, rawR, gx, gy, t, maxEnergy } = params;
    if (maxEnergy <= 0.015)
        return;
    const influenceRadius = 580;
    const influenceRadiusSq = influenceRadius * influenceRadius;
    // High-performance stippled dot matrix field with silky smooth 60fps pacing
    const stepX = 5.0;
    const stepY = 4.2;
    // Active bounding box around glow focal point (gx, gy)
    const minX = Math.max(0, Math.floor((gx - influenceRadius) / stepX) * stepX);
    const maxX = Math.min(w, Math.ceil((gx + influenceRadius) / stepX) * stepX);
    const minY = Math.max(0, Math.floor((gy - influenceRadius) / stepY) * stepY);
    const maxY = Math.min(h, Math.ceil((gy + influenceRadius) / stepY) * stepY);
    const startRow = Math.floor(minY / stepY);
    const endRow = Math.ceil(maxY / stepY);
    // Wave numbers snapped to whole harmonics of the perimeter so the pattern loops seamlessly around corners
    const perim = 2 * (w + h);
    const snapK = (k) => (2 * Math.PI * Math.max(1, Math.round((k * perim) / (2 * Math.PI)))) / perim;
    const k1 = snapK(0.028); // wavelength ~224px
    const k2 = snapK(0.068); // wavelength ~92px
    const k3 = snapK(0.135); // wavelength ~46px
    const kc = snapK(0.018);
    ctx.save();
    ctx.filter = 'none';
    for (let row = startRow; row <= endRow; row++) {
        const dotY = row * stepY;
        if (dotY < 0 || dotY > h)
            continue;
        const rowOffset = (row % 2 === 1) ? stepX * 0.5 : 0;
        const startCol = Math.floor((minX - rowOffset) / stepX);
        const endCol = Math.ceil((maxX - rowOffset) / stepX);
        for (let col = startCol; col <= endCol; col++) {
            const dotX = col * stepX + rowOffset;
            if (dotX < 0 || dotX > w)
                continue;
            // Distance to glow center (fast squared distance check first)
            const dx = dotX - gx, dy = dotY - gy;
            const distSq = dx * dx + dy * dy;
            if (distSq > influenceRadiusSq)
                continue;
            const distToGlow = Math.sqrt(distSq);
            const glowP = Math.max(0, 1 - distToGlow / influenceRadius);
            const energy = glowP * glowP * (3 - 2 * glowP) * maxEnergy;
            if (energy <= 0.02)
                continue;
            // Distance to border with exact rounded-corner calculation (fills out border gap)
            const distToBorder = getDistToRoundedBorder(dotX, dotY, w, h, rawR);
            if (distToBorder < 0)
                continue;
            // Border perimeter coordinate measured along the nearest edge (clockwise from top-left),
            // so wave crests stand straight out from the border instead of slanting diagonally
            const dTop = dotY, dRight = w - dotX, dBottom = h - dotY, dLeft = dotX;
            const dMin = Math.min(dTop, dRight, dBottom, dLeft);
            let u;
            if (Math.abs(dMin - dTop) < 0.001) {
                u = dotX;
            }
            else if (Math.abs(dMin - dRight) < 0.001) {
                u = w + dotY;
            }
            else if (Math.abs(dMin - dBottom) < 0.001) {
                u = w + h + (w - dotX);
            }
            else {
                u = 2 * w + h + (h - dotY);
            }
            // Multi-harmonic undulating wave terrain for organic mountain crests and valleys
            const wave1 = Math.sin(k1 * u + t * 1.6);
            const wave2 = Math.sin(k2 * u - t * 2.2 + 1.25);
            const wave3 = Math.cos(k3 * u + t * 3.0 + 2.6);
            const crestFactor = Math.max(0.15, 0.52 + 0.28 * wave1 + 0.16 * wave2 + 0.10 * wave3);
            // Increased wave height and reach matching the expanded blur fade depth
            const maxAllowedDepth = Math.max(24, Math.min(135, Math.min(w, h) * 0.4));
            const targetReach = (18 + 78 * crestFactor) * energy;
            const maxWaveDepth = Math.min(maxAllowedDepth, targetReach);
            if (distToBorder > maxWaveDepth)
                continue;
            // Depth ratio: 0 at container border to 1.0 at crest peak
            const depthRatio = distToBorder / maxWaveDepth;
            // Soft feathering at crest front and near container boundary (reaches right up to border)
            const crestFeather = Math.max(0, Math.min(1, (1 - depthRatio) / 0.11));
            const borderFeather = Math.max(0, Math.min(1, distToBorder / 2.0));
            const edgeFeather = crestFeather * borderFeather;
            // Crest ridge prominence (dots are largest and brightest along the wave ridge)
            const ridgeProximity = 1 - Math.abs(depthRatio - 0.80) / 0.80;
            const ridgeIntensity = Math.max(0, Math.min(1, ridgeProximity));
            // Delicate micro-stippling dot radius (~0.30px to 1.25px)
            const baseR = 0.40 + 0.18 * energy;
            const ridgeR = 0.55 * (ridgeIntensity * ridgeIntensity);
            const dotRadius = Math.max(0.30, (baseR + ridgeR) * edgeFeather);
            // Dot alpha
            const baseAlpha = 0.38 + 0.54 * (ridgeIntensity * ridgeIntensity);
            const dotAlpha = Math.min(1, baseAlpha * edgeFeather * energy);
            if (dotAlpha <= 0.01)
                continue;
            // Multi-blue gradients with Google Gemini chromatic wave crest tips
            const chromaticShift = 0.5 + 0.5 * Math.sin(kc * u + t * 0.9);
            let r, g, b;
            if (depthRatio < 0.38) {
                // Deep Royal Sapphire into Vivid Azure
                const f = depthRatio / 0.38;
                r = Math.round(29 + f * (14 - 29));
                g = Math.round(78 + f * (165 - 78));
                b = Math.round(216 + f * (233 - 216));
            }
            else if (depthRatio < 0.74) {
                // Vivid Azure to Electric Cyan with subtle violet undertone
                const f = (depthRatio - 0.38) / 0.36;
                const targetR = Math.round(56 + chromaticShift * 65);
                const targetG = Math.round(189 - chromaticShift * 55);
                const targetB = Math.round(248 - chromaticShift * 12);
                r = Math.round(14 + f * (targetR - 14));
                g = Math.round(165 + f * (targetG - 165));
                b = Math.round(233 + f * (targetB - 233));
            }
            else {
                // Crest Ridge: Electric Cyan / Ice Blue transitioning to Google Gemini Violet, Magenta & Coral tips
                const f = (depthRatio - 0.74) / 0.26;
                const crestR = Math.round(168 + chromaticShift * 72);
                const crestG = Math.round(85 - chromaticShift * 20);
                const crestB = Math.round(247 - chromaticShift * 85);
                const mix = 0.32 + 0.68 * chromaticShift * f;
                r = Math.round(56 + (crestR - 56) * mix);
                g = Math.round(189 + (crestG - 189) * mix);
                b = Math.round(248 + (crestB - 248) * mix);
            }
            // Radiant halo glow on crest ridge dots
            if (ridgeIntensity > 0.65 && energy > 0.38) {
                ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${(dotAlpha * 0.18).toFixed(3)})`;
                ctx.beginPath();
                ctx.arc(dotX, dotY, dotRadius * 1.8, 0, Math.PI * 2);
                ctx.fill();
            }
            // Crisp stippled core dot
            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${dotAlpha.toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(dotX, dotY, dotRadius, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    ctx.restore();
}
function renderFluidFrame(state) {
    const { canvas, ctx, container } = state;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w <= 0 || h <= 0)
        return;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
    }
    // Slower, smoother easing for tranquil fluid tracking
    const ease = state.active ? 0.09 : 0.06;
    state.curX += (state.targetX - state.curX) * ease;
    state.curY += (state.targetY - state.curY) * ease;
    state.time += 0.009;
    // Read container border radius with frame-level caching to prevent forced reflows
    const stateAny = state;
    let rawR = stateAny.cachedR;
    if (rawR === undefined || canvas.width !== pw || canvas.height !== ph) {
        const compStyle = window.getComputedStyle(container);
        rawR = stateAny.cachedR = Number.parseFloat(compStyle.borderRadius) || 0;
    }
    const { P, samples } = sampleBorder(w, h, rawR, 180);
    const N = samples.length;
    if (N < 4 || P <= 0)
        return;
    // Initialize or resize energies Float32Array if needed
    if (state.energies?.length !== N) {
        state.energies = new Float32Array(N);
    }
    // Find border perimeter point closest to pointer for target perimeter distance
    let bestDistSq = Infinity;
    let bestS = 0;
    for (let i = 0; i < N; i++) {
        const s = samples[i];
        const d2 = (s.bx - state.curX) ** 2 + (s.by - state.curY) ** 2;
        if (d2 < bestDistSq) {
            bestDistSq = d2;
            bestS = s.s;
        }
    }
    state.targetS = bestS;
    // Smoothly glide glowS along the perimeter loop (slower, smoother travelling wave animation between sides)
    const deltaS = ((state.targetS - state.glowS + 1.5 * P) % P) - 0.5 * P;
    state.glowS = (state.glowS + deltaS * 0.08 + P) % P;
    // Interpolate exact (glowX, glowY) from glowS
    const sNorm = (state.glowS / P) * N;
    const i0 = Math.floor(sNorm) % N;
    const i1 = (i0 + 1) % N;
    const fracS = sNorm - Math.floor(sNorm);
    state.glowX = samples[i0].bx + (samples[i1].bx - samples[i0].bx) * fracS;
    state.glowY = samples[i0].by + (samples[i1].by - samples[i0].by) * fracS;
    // Update per-sample energies with asymmetric attack and decay:
    // - Active Attack: smooth, organic swell
    // - Active Decay: graceful wave dissipation when moving between sides (~500ms)
    // - Inactive Decay: fast fade-out when dropped or pointer leaves
    // Increased influence radius for wider perimeter coverage
    const influenceRadius = 580;
    let maxEnergy = 0;
    for (let i = 0; i < N; i++) {
        const s = samples[i];
        const distToCursor = Math.hypot(s.bx - state.curX, s.by - state.curY);
        const p = Math.max(0, 1 - distToCursor / influenceRadius);
        const targetEnergy = state.active ? (p * p * (3 - 2 * p)) : 0;
        if (state.active) {
            if (targetEnergy > state.energies[i]) {
                state.energies[i] += (targetEnergy - state.energies[i]) * 0.12;
            }
            else {
                state.energies[i] += (targetEnergy - state.energies[i]) * 0.035;
            }
        }
        else {
            // Slow, graceful decay upon drop / leave (~1.5s)
            state.energies[i] *= 0.955;
        }
        if (state.energies[i] > maxEnergy) {
            maxEnergy = state.energies[i];
        }
    }
    // Update dynamic blur focal coordinates so backdrop filter aligns behind gradient
    container.style.setProperty('--glow-x', `${Math.round(state.glowX)}px`);
    container.style.setProperty('--glow-y', `${Math.round(state.glowY)}px`);
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    // Clip strictly inside container so blur radiates inward without spilling outside
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function' && rawR > 0.5) {
        const r = Math.min(rawR, w / 2, h / 2);
        ctx.roundRect(0, 0, w, h, r);
    }
    else {
        ctx.rect(0, 0, w, h);
    }
    ctx.clip();
    const gx = state.glowX;
    const gy = state.glowY;
    const t = state.time;
    // 1. Ambient Deep Blur Fade Layer (Wide atmospheric blue haze with increased height and length)
    drawFluidBlurFade({ ctx, samples, P, energies: state.energies, gx, gy, W: w, H: h, cfg: {
            t,
            speed: 0.65,
            baseDepth: 30,
            maxSurge: 66,
            influenceRadius: 620,
            harmonics: [2, 5, 8, 12],
            swellM: 1,
            blurRadius: 48,
            colorStops: [
                { stop: 0, color: 'rgba(56, 189, 248, 0.38)' },
                { stop: 0.20, color: 'rgba(14, 165, 233, 0.30)' },
                { stop: 0.45, color: 'rgba(37, 99, 235, 0.20)' },
                { stop: 0.70, color: 'rgba(29, 78, 216, 0.10)' },
                { stop: 0.88, color: 'rgba(30, 58, 138, 0.04)' },
                { stop: 1, color: 'rgba(15, 23, 42, 0)' }
            ]
        } });
    // 2. Dynamic Fluid Wave Blur Fade Layer (Oceanic Azure & Cobalt undulating wave with increased height and length)
    drawFluidBlurFade({ ctx, samples, P, energies: state.energies, gx, gy, W: w, H: h, cfg: {
            t,
            speed: 0.9,
            baseDepth: 20,
            maxSurge: 52,
            influenceRadius: 540,
            harmonics: [3, 6, 11, 16],
            swellM: 2,
            blurRadius: 28,
            colorStops: [
                { stop: 0, color: 'rgba(56, 189, 248, 0.48)' },
                { stop: 0.22, color: 'rgba(14, 165, 233, 0.35)' },
                { stop: 0.50, color: 'rgba(37, 99, 235, 0.20)' },
                { stop: 0.78, color: 'rgba(29, 78, 216, 0.08)' },
                { stop: 1, color: 'rgba(30, 27, 75, 0)' }
            ]
        } });
    // 3. Stippled Wave Dot Grid (Gemini-style undulating micro-dot matrix with chromatic crests and increased density)
    drawFluidDotGrid({ ctx, w, h, rawR, gx, gy, t, maxEnergy });
    ctx.restore();
}
function getFluidState(container) {
    let state = fluidCanvases.get(container);
    if (state)
        return state;
    const canvas = container.querySelector('.agent-fluid-canvas');
    if (!canvas)
        return null;
    if (!container.querySelector('.agent-fluid-blur')) {
        const blurEl = document.createElement('div');
        blurEl.className = 'agent-fluid-blur';
        blurEl.setAttribute('aria-hidden', 'true');
        container.insertBefore(blurEl, canvas);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx)
        return null;
    const rect = container.getBoundingClientRect();
    const initX = rect.width / 2;
    const initY = 0;
    state = {
        canvas,
        ctx,
        container,
        curX: initX,
        curY: initY,
        targetX: initX,
        targetY: initY,
        glowS: 0,
        targetS: 0,
        glowX: initX,
        glowY: initY,
        energies: new Float32Array(180),
        active: false,
        fadeStartTime: null,
        animId: null,
        time: 0,
    };
    fluidCanvases.set(container, state);
    return state;
}
function updateAgentDragPointer(container, clientX, clientY) {
    const state = getFluidState(container);
    if (!state)
        return;
    const rect = container.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
    state.targetX = x;
    state.targetY = y;
    state.fadeStartTime = null;
    if (!state.active) {
        state.active = true;
        state.curX = x;
        state.curY = y;
        startFluidCanvasLoop(state);
    }
}
function setFluidContainer(container, clientX, clientY) {
    const containers = [$('#sidebar'), $('#editorPane'), $('#agents'), $('#box')].filter((x) => !!x);
    for (const c of containers) {
        if (c === container) {
            c.classList.add('agent-drop-over', 'drop-over-active');
            updateAgentDragPointer(c, clientX, clientY);
        }
        else {
            c.classList.remove('agent-drop-over', 'drop-over-active');
            const state = fluidCanvases.get(c);
            if (state?.active) {
                state.active = false;
                state.fadeStartTime = performance.now();
            }
        }
    }
}
function stopAgentDragPointer(immediate = false) {
    const now = performance.now();
    for (const state of fluidCanvases.values()) {
        state.active = false;
        state.fadeStartTime = now;
        if (immediate && state.energies) {
            for (let i = 0; i < state.energies.length; i++) {
                state.energies[i] *= 0.85;
            }
        }
    }
    $('#agents')?.classList.remove('agent-drop-over', 'drop-over-active');
    $('#box')?.classList.remove('agent-drop-over', 'drop-over-active');
    $('#sidebar')?.classList.remove('agent-drop-over', 'drop-over-active');
    $('#editorPane')?.classList.remove('agent-drop-over', 'drop-over-active');
}
function startFluidCanvasLoop(state) {
    if (state.animId != null)
        return;
    function loop() {
        if (!state.active) {
            let maxEnergy = 0;
            if (state.energies) {
                for (let i = 0; i < state.energies.length; i++) {
                    if (state.energies[i] > maxEnergy)
                        maxEnergy = state.energies[i];
                }
            }
            const elapsed = performance.now() - (state.fadeStartTime ?? 0);
            if (elapsed > 1800 || maxEnergy < 0.005) {
                state.ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
                if (state.energies)
                    state.energies.fill(0);
                state.animId = null;
                return;
            }
        }
        renderFluidFrame(state);
        state.animId = requestAnimationFrame(loop);
    }
    state.animId = requestAnimationFrame(loop);
}
function markAgentDrop(el) {
    if (agentDropMark === el)
        return;
    agentDropMark?.classList.remove('agent-drop-over', 'drag-over');
    agentDropMark = el;
    if (el) {
        if (el.classList.contains('composer-box'))
            el.classList.add('drag-over');
        else
            el.classList.add('agent-drop-over');
    }
}
function clearAgentDropMarks() {
    if (agentDropMark) {
        agentDropMark.classList.remove('agent-drop-over', 'drag-over');
        agentDropMark = null;
    }
    $('#agents')?.classList.remove('agent-drop-over', 'drop-over-active');
    $('#box')?.classList.remove('agent-drop-over', 'drop-over-active');
    $('#sidebar')?.classList.remove('agent-drop-over', 'drop-over-active');
    $('#editorPane')?.classList.remove('agent-drop-over', 'drop-over-active');
    for (const b of $$('.composer-box'))
        b.classList.remove('drag-over');
    for (const t of $$('.agent-tab'))
        t.classList.remove('agent-drop-over');
    for (const t of $$('.agent-tab-new'))
        t.classList.remove('agent-drop-over');
    stopAgentDragPointer(true);
}
function agentDropTarget(e) {
    const t = e.target;
    if (!t)
        return null;
    if (t.closest('#tglAgents')) {
        if (!layout.agentsOpen) {
            layout.agentsOpen = true;
            applyLayout();
        }
        return { el: $('#agents'), surface: SURFACES.ide };
    }
    const inBox = t.closest('#box');
    const inAgents = t.closest('#agents');
    if (!inBox && !inAgents)
        return null;
    const s = inBox ? SURFACES.box : SURFACES.ide;
    const tabEl = t.closest('.agent-tab');
    if (tabEl?.dataset.agentTab) {
        const tab = surfaceTabs[s.name]?.find(x => x.id === tabEl.dataset.agentTab);
        if (tab)
            return { el: tabEl, surface: s, tab };
    }
    const newTabBtn = t.closest('#agentNewTab, #boxNewTab');
    if (newTabBtn) {
        return { el: newTabBtn, surface: s, isNewTab: true };
    }
    const composerBox = t.closest('.composer-box');
    if (composerBox) {
        return { el: composerBox, surface: s, tab: getActiveTab(s) };
    }
    return { el: inBox ? $('#box') : $('#agents'), surface: s, tab: getActiveTab(s) };
}
function toRelProject(absPath) {
    if (!rootInfo || !absPath)
        return null;
    const normRoot = rootInfo.root.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
    const normAbs = absPath.replaceAll('\\', '/').toLowerCase();
    if (normAbs === normRoot)
        return '';
    if (normAbs.startsWith(normRoot + '/')) {
        return absPath.slice(rootInfo.root.length).replace(/^[\\/]/, '').replaceAll('\\', '/');
    }
    return null;
}
function getDroppedFilePath(file) {
    try {
        if (api.sys.getPathForFile)
            return api.sys.getPathForFile(file) || '';
    }
    catch { }
    return file.path || '';
}
function dropTarget(e) {
    if (!rootInfo)
        return null;
    const t = e.target;
    if (t.closest('#editorPane'))
        return { el: $('#editorPane'), dir: targetDir() };
    const row = t.closest('#tree [data-path]');
    if (row) {
        const p = row.dataset.path;
        return { el: row, dir: row.dataset.dir ? p : dirName(p) };
    }
    return t.closest('#tree') ? { el: $('#tree'), dir: '' } : null;
}
let currentTreeDropMark = null;
function markTreeDrop(el, pos) {
    if (currentTreeDropMark && (currentTreeDropMark.el !== el || currentTreeDropMark.pos !== pos)) {
        currentTreeDropMark.el.classList.remove('drop-line-above', 'drop-line-below', 'drop-into');
        currentTreeDropMark = null;
    }
    if (!el || !pos)
        return;
    if (pos === 'before')
        el.classList.add('drop-line-above');
    else if (pos === 'after')
        el.classList.add('drop-line-below');
    else if (pos === 'into')
        el.classList.add('drop-into');
    currentTreeDropMark = { el, pos };
}
function clearTreeDropMarks() {
    if (currentTreeDropMark) {
        currentTreeDropMark.el.classList.remove('drop-line-above', 'drop-line-below', 'drop-into');
        currentTreeDropMark = null;
    }
    for (const el of $$('#tree .drop-line-above, #tree .drop-line-below, #tree .drop-into')) {
        el.classList.remove('drop-line-above', 'drop-line-below', 'drop-into');
    }
}
function treeDropTarget(e) {
    if (!rootInfo)
        return null;
    const target = e.target;
    if (!target)
        return null;
    const tree = target.closest('#tree');
    if (!tree)
        return null;
    const row = target.closest('#tree .tree-item[data-path]');
    const from = draggedTreePath;
    if (row?.dataset.path) {
        const path = row.dataset.path;
        const isDir = !!row.dataset.dir;
        const parentDir = dirName(path);
        // Cannot drop on oneself
        if (from && path === from)
            return null;
        // Cannot drop a directory into itself or into one of its children
        if (from && draggedTreeIsDir && (path === from || path.startsWith(from + '/')))
            return null;
        const rect = row.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const h = rect.height || 24;
        const ratio = Math.max(0, Math.min(1, y / h));
        let pos;
        if (isDir) {
            if (ratio < 0.28)
                pos = 'before';
            else if (ratio > 0.72)
                pos = 'after';
            else
                pos = 'into';
        }
        else {
            pos = ratio < 0.5 ? 'before' : 'after';
        }
        return { el: row, path, isDir, pos, parentDir };
    }
    // Hovering on empty area of #tree
    const items = $$('#tree .tree-item[data-path]');
    if (items.length > 0) {
        const last = items.at(-1);
        if (last?.dataset.path && last.dataset.path !== from) {
            return {
                el: last,
                path: last.dataset.path,
                isDir: !!last.dataset.dir,
                pos: 'after',
                parentDir: dirName(last.dataset.path),
            };
        }
    }
    return { el: tree, path: '', isDir: true, pos: 'into', parentDir: '' };
}
const treeOrderKey = () => `breeze.treeOrder:${rootInfo?.root ?? ''}`;
let treeOrder = {};
function loadTreeOrder() {
    if (!rootInfo) {
        treeOrder = {};
        return;
    }
    treeOrder = store.get(treeOrderKey(), {});
}
function saveTreeOrder(rel, names) {
    if (!rootInfo)
        return;
    treeOrder[rel] = names;
    store.set(treeOrderKey(), treeOrder);
}
function sortDirEntries(rel, entries) {
    const custom = treeOrder[rel];
    if (!custom?.length)
        return entries;
    const map = new Map();
    custom.forEach((n, i) => map.set(n, i));
    return [...entries].sort((a, b) => {
        const hasA = map.has(a.name);
        const hasB = map.has(b.name);
        if (hasA && hasB)
            return map.get(a.name) - map.get(b.name);
        if (hasA && !hasB)
            return -1;
        if (!hasA && hasB)
            return 1;
        if (a.dir !== b.dir)
            return a.dir ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
}
const actionUndoStack = [];
const actionRedoStack = [];
const APP_UNDO_MAX = 50;
let lastUserTypeAt = 0;
function pushAppAction(action) {
    action.timestamp = Date.now();
    actionUndoStack.push(action);
    if (actionUndoStack.length > APP_UNDO_MAX)
        actionUndoStack.shift();
    actionRedoStack.length = 0;
}
function flashUndoItem(path) {
    const row = $(`#tree .tree-item[data-path="${escAttr(path)}"]`);
    if (!row)
        return;
    row.classList.remove('undo-target');
    const _reflow = row.offsetWidth;
    row.classList.add('undo-target');
    setTimeout(() => row.classList.remove('undo-target'), 800);
}
let layoutAnimTimer;
function applyLayoutAnimated() {
    clearTimeout(layoutAnimTimer);
    document.body.classList.add('layout-animating');
    applyLayout();
    layoutAnimTimer = setTimeout(() => {
        document.body.classList.remove('layout-animating');
    }, 350);
}
async function undoAppAction() {
    const action = actionUndoStack.pop();
    if (!action)
        return false;
    actionRedoStack.push(action);
    if (action.type === 'tree-order') {
        if (action.dir)
            expanded.add(action.dir);
        treeOrder[action.dir] = [...action.prevOrder];
        saveTreeOrder(action.dir, action.prevOrder);
        if (dirCache.has(action.dir)) {
            const list = dirCache.get(action.dir);
            dirCache.set(action.dir, sortDirEntries(action.dir, list));
        }
        renderTreeAnimated();
        flashUndoItem(joinPath(action.dir, action.name));
        toast(`Undid rearrange · ${action.name}`);
        return true;
    }
    if (action.type === 'tree-move') {
        if (action.prevFromOrder) {
            treeOrder[action.fromDir] = [...action.prevFromOrder];
            saveTreeOrder(action.fromDir, action.prevFromOrder);
        }
        if (action.prevTargetOrder) {
            treeOrder[action.targetDir] = [...action.prevTargetOrder];
            saveTreeOrder(action.targetDir, action.prevTargetOrder);
        }
        if (action.fromDir)
            expanded.add(action.fromDir);
        await moveEntry(action.from, action.to);
        flashUndoItem(action.to);
        toast(`Undid move · ${action.name}`);
        return true;
    }
    if (action.type === 'tree-import') {
        for (const p of action.topPaths) {
            try {
                await api.fs.trash(p);
            }
            catch (err) {
                console.warn('Failed to trash imported file/dir:', p, err);
            }
            const d = dirName(p);
            if (treeOrder[d]) {
                treeOrder[d] = treeOrder[d].filter(n => n !== baseName(p));
                saveTreeOrder(d, treeOrder[d]);
            }
            for (const tabPath of openTabs.filter(x => x === p || x.startsWith(p + '/'))) {
                dropTab(tabPath);
            }
            expanded.delete(p);
        }
        dirCache.clear();
        await refreshTree();
        renderTabs();
        renderEditor();
        saveSession();
        toast(`Undid import · ${action.names.join(', ')}`);
        return true;
    }
    if (action.type === 'layout') {
        Object.assign(layout, action.prev);
        applyLayoutAnimated();
        toast('Undid layout');
        return true;
    }
    if (action.type === 'remove-attachment') {
        const list = attachmentsMap[action.surface] || [];
        list.splice(action.index, 0, action.attachment);
        attachmentsMap[action.surface] = list;
        const tab = surfaceTabs[action.surface]?.find(x => x.id === action.tabId) || getActiveTab(SURFACES[action.surface]);
        if (tab)
            tab.attachments = [...list];
        renderAttachments(SURFACES[action.surface]);
        toast(`Restored attachment · ${action.attachment.name}`);
        return true;
    }
    return false;
}
async function redoAppAction() {
    const action = actionRedoStack.pop();
    if (!action)
        return false;
    actionUndoStack.push(action);
    if (action.type === 'tree-order') {
        if (action.dir)
            expanded.add(action.dir);
        treeOrder[action.dir] = [...action.newOrder];
        saveTreeOrder(action.dir, action.newOrder);
        if (dirCache.has(action.dir)) {
            const list = dirCache.get(action.dir);
            dirCache.set(action.dir, sortDirEntries(action.dir, list));
        }
        renderTreeAnimated();
        flashUndoItem(joinPath(action.dir, action.name));
        toast(`Redid rearrange · ${action.name}`);
        return true;
    }
    if (action.type === 'tree-move') {
        await moveEntry(action.to, action.from);
        await refreshTree();
        flashUndoItem(action.from);
        toast(`Redid move · ${action.name}`);
        return true;
    }
    if (action.type === 'tree-import') {
        if (action.cachedFiles && action.cachedFiles.length > 0) {
            for (const item of action.cachedFiles) {
                await api.fs.importFile(action.dir, item.rel, item.data);
            }
            for (let d = action.dir; d; d = dirName(d))
                expanded.add(d);
            dirCache.clear();
            await refreshTree();
            renderTabs();
            renderEditor();
            saveSession();
            toast(`Redid import · ${action.names.join(', ')}`);
            return true;
        }
        toast(`Cannot redo file import after items were moved to ${binName()}`);
        return false;
    }
    if (action.type === 'layout') {
        Object.assign(layout, action.next);
        applyLayoutAnimated();
        toast('Redid layout');
        return true;
    }
    if (action.type === 'remove-attachment') {
        attachmentsMap[action.surface] = (attachmentsMap[action.surface] || []).filter(x => x.id !== action.attachment.id);
        const tab = surfaceTabs[action.surface]?.find(x => x.id === action.tabId) || getActiveTab(SURFACES[action.surface]);
        if (tab)
            tab.attachments = [...attachmentsMap[action.surface]];
        renderAttachments(SURFACES[action.surface]);
        toast(`Removed · ${action.attachment.name}`);
        return true;
    }
    return false;
}
async function rearrangeTreeItem(fromPath, targetPath, pos) {
    if (!fromPath || !rootInfo)
        return;
    if (fromPath === targetPath && pos !== 'into')
        return;
    const fromDir = dirName(fromPath);
    const fromName = baseName(fromPath);
    if (pos === 'into') {
        const destDir = targetPath;
        if (fromPath === destDir || destDir.startsWith(fromPath + '/'))
            return;
        const destPath = destDir ? joinPath(destDir, fromName) : fromName;
        if (destPath === fromPath) {
            const entries = dirCache.get(fromDir);
            if (entries) {
                const fromEntry = entries.find(e => e.name === fromName);
                if (fromEntry) {
                    const prevOrder = entries.map(e => e.name);
                    const remaining = entries.filter(e => e.name !== fromName);
                    remaining.push(fromEntry);
                    const newOrder = remaining.map(e => e.name);
                    pushAppAction({
                        type: 'tree-order',
                        dir: fromDir,
                        prevOrder,
                        newOrder,
                        name: fromName,
                    });
                    dirCache.set(fromDir, remaining);
                    saveTreeOrder(fromDir, newOrder);
                    renderTreeAnimated();
                    toast(`Moved to end · ${fromName}`);
                }
            }
            return;
        }
        const prevFromOrder = (dirCache.get(fromDir) || []).map(e => e.name);
        const prevDestOrder = (dirCache.get(destDir) || []).map(e => e.name);
        if (destDir)
            expanded.add(destDir);
        const destOrder = treeOrder[destDir] ? [...treeOrder[destDir]] : (dirCache.get(destDir) || []).map(e => e.name);
        if (!destOrder.includes(fromName))
            destOrder.push(fromName);
        saveTreeOrder(destDir, destOrder);
        if (treeOrder[fromDir]) {
            saveTreeOrder(fromDir, treeOrder[fromDir].filter(n => n !== fromName));
        }
        pushAppAction({
            type: 'tree-move',
            from: destPath,
            to: fromPath,
            fromDir,
            targetDir: destDir,
            prevFromOrder,
            prevTargetOrder: prevDestOrder,
            name: fromName,
        });
        await moveEntry(fromPath, destPath);
        toast(`Moved ${fromName} into ${destDir ? baseName(destDir) : 'project root'}`);
        return;
    }
    // Dropping before or after targetPath
    const targetDir = dirName(targetPath);
    const targetName = baseName(targetPath);
    if (fromDir === targetDir) {
        // Same directory reordering
        const entries = dirCache.get(fromDir);
        if (!entries)
            return;
        const fromEntry = entries.find(e => e.name === fromName);
        if (!fromEntry)
            return;
        const prevOrder = entries.map(e => e.name);
        const remaining = entries.filter(e => e.name !== fromName);
        const targetIdx = remaining.findIndex(e => e.name === targetName);
        if (targetIdx === -1)
            return;
        const insertIdx = pos === 'before' ? targetIdx : targetIdx + 1;
        remaining.splice(insertIdx, 0, fromEntry);
        const newOrder = remaining.map(e => e.name);
        pushAppAction({
            type: 'tree-order',
            dir: fromDir,
            prevOrder,
            newOrder,
            name: fromName,
        });
        dirCache.set(fromDir, remaining);
        saveTreeOrder(fromDir, newOrder);
        renderTreeAnimated();
        toast(`Reordered · ${fromName}`);
        return;
    }
    // Moving across directories to a specific position
    const destPath = joinPath(targetDir, fromName);
    if (fromPath === destPath)
        return;
    if (fromPath === targetDir || targetDir.startsWith(fromPath + '/'))
        return;
    const prevFromOrder = (dirCache.get(fromDir) || []).map(e => e.name);
    const prevTargetOrder = (dirCache.get(targetDir) || []).map(e => e.name);
    if (targetDir)
        expanded.add(targetDir);
    const currentTargetOrder = treeOrder[targetDir] ? [...treeOrder[targetDir]] : (dirCache.get(targetDir) || []).map(e => e.name);
    const filtered = currentTargetOrder.filter(n => n !== fromName);
    const tIdx = filtered.indexOf(targetName);
    let insIdx = filtered.length;
    if (tIdx !== -1) {
        insIdx = pos === 'before' ? tIdx : tIdx + 1;
    }
    filtered.splice(insIdx, 0, fromName);
    saveTreeOrder(targetDir, filtered);
    if (treeOrder[fromDir]) {
        saveTreeOrder(fromDir, treeOrder[fromDir].filter(n => n !== fromName));
    }
    pushAppAction({
        type: 'tree-move',
        from: destPath,
        to: fromPath,
        fromDir,
        targetDir,
        prevFromOrder,
        prevTargetOrder,
        name: fromName,
    });
    await moveEntry(fromPath, destPath);
    toast(`Moved ${fromName} to ${targetDir ? baseName(targetDir) : 'project root'}`);
}
// A row drops into that folder (or a file's folder), empty explorer space into the project root.
// A folder can't go into itself or anything inside it, and dropping where it already is does nothing.
function moveTarget(e) {
    const from = draggedTreePath;
    if (!from)
        return null;
    const t = e.target;
    const row = t.closest('#tree [data-path]');
    let el, dir;
    if (row) {
        const p = row.dataset.path;
        dir = row.dataset.dir ? p : dirName(p);
        el = dir ? $(`#tree .tree-item[data-path="${escAttr(dir)}"]`) ?? row : $('#tree');
    }
    else if (t.closest('#tree')) {
        el = $('#tree');
        dir = '';
    }
    else
        return null;
    if (dir === dirName(from) || dir === from || dir.startsWith(from + '/'))
        return null;
    return { el, dir };
}
const entryFile = (e) => new Promise((res, rej) => e.file(res, rej));
async function entryChildren(dir) {
    const reader = dir.createReader(), all = [];
    for (;;) { // readEntries returns at most ~100 at a time
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length)
            return all;
        all.push(...batch);
    }
}
async function collectDropped(entry, prefix, out, skipped) {
    if (DROP_SKIP.has(entry.name)) {
        skipped.push(entry.name);
        return;
    }
    if (out.length >= DROP_MAX_FILES)
        return;
    if (entry.isFile) {
        out.push({ rel: prefix + entry.name, file: await entryFile(entry) });
        return;
    }
    for (const child of await entryChildren(entry))
        await collectDropped(child, `${prefix}${entry.name}/`, out, skipped);
}
async function importDropped(entries, dir, openFirst = false) {
    const found = [], skipped = [], saved = [], failed = [];
    for (const entry of entries)
        await collectDropped(entry, '', found, skipped);
    const files = found.filter(d => d.file.size <= DROP_MAX_BYTES);
    const cachedFiles = [];
    let totalBytes = 0;
    for (const d of files) {
        try {
            const buf = new Uint8Array(await d.file.arrayBuffer());
            saved.push(await api.fs.importFile(dir, d.rel, buf));
            totalBytes += buf.length;
            if (totalBytes <= 20 * 1024 * 1024) {
                cachedFiles.push({ rel: d.rel, data: buf });
            }
        }
        catch (err) {
            failed.push(errMsg(err));
        }
    }
    for (let d = dir; d; d = dirName(d))
        expanded.add(d);
    dirCache.clear();
    await refreshTree();
    saveSession();
    if (saved.length > 0) {
        const topPaths = entries.map(e => joinPath(dir, e.name));
        pushAppAction({
            type: 'tree-import',
            dir,
            topPaths,
            savedPaths: [...saved],
            names: entries.map(e => e.name),
            cachedFiles: totalBytes <= 20 * 1024 * 1024 ? cachedFiles : undefined,
        });
    }
    if (saved.length >= 1 && (openFirst || (entries.length === 1 && entries[0].isFile))) {
        openFile(saved[0]);
    }
    const notes = [
        skipped.length ? `skipped ${[...new Set(skipped)].join(', ')}` : '',
        found.length > files.length ? `${plural(found.length - files.length, 'file')} over 50 MB left out` : '',
        found.length >= DROP_MAX_FILES ? `stopped at ${DROP_MAX_FILES} files` : '',
        failed.length ? `${failed.length} failed: ${failed[0]}` : '',
    ].filter(Boolean);
    const noteText = notes.length ? ' · ' + notes.join(' · ') : '';
    toast(`Added ${plural(saved.length, 'file')}${noteText}`);
}
document.addEventListener('dragover', e => {
    if (!hasFiles(e) && !draggedTreePath)
        return;
    const target = e.target;
    const ag = agentDropTarget(e);
    if (ag) {
        e.preventDefault();
        markDrop(null);
        clearTreeDropMarks();
        markAgentDrop(ag.el);
        const container = ag.surface.name === 'box' ? $('#box') : $('#agents');
        setFluidContainer(container, e.clientX, e.clientY);
        if (e.dataTransfer)
            e.dataTransfer.dropEffect = 'copy';
        return;
    }
    if (agentDropMark) {
        agentDropMark.classList.remove('agent-drop-over', 'drag-over');
        agentDropMark = null;
    }
    if (draggedTreePath) {
        if (target?.closest('#editorPane')) {
            e.preventDefault();
            markDrop(null);
            clearTreeDropMarks();
            setFluidContainer($('#editorPane'), e.clientX, e.clientY);
            if (e.dataTransfer)
                e.dataTransfer.dropEffect = 'link';
            return;
        }
        const treeTarget = treeDropTarget(e);
        if (treeTarget) {
            e.preventDefault();
            markDrop(null);
            markTreeDrop(treeTarget.el, treeTarget.pos);
            setFluidContainer($('#sidebar'), e.clientX, e.clientY);
            if (e.dataTransfer)
                e.dataTransfer.dropEffect = 'move';
            return;
        }
        const mt = moveTarget(e);
        if (mt) {
            e.preventDefault();
            clearTreeDropMarks();
            markDrop(mt.el !== $('#tree') ? mt.el : null);
            setFluidContainer($('#sidebar'), e.clientX, e.clientY);
            if (e.dataTransfer)
                e.dataTransfer.dropEffect = 'move';
            return;
        }
        if (target?.closest('#sidebar')) {
            e.preventDefault();
            clearTreeDropMarks();
            markDrop(null);
            setFluidContainer($('#sidebar'), e.clientX, e.clientY);
            if (e.dataTransfer)
                e.dataTransfer.dropEffect = 'none';
            return;
        }
        clearTreeDropMarks();
        markDrop(null);
        setFluidContainer(null, 0, 0);
        return;
    }
    clearTreeDropMarks();
    const dt = dropTarget(e);
    if (target?.closest('#editorPane')) {
        e.preventDefault();
        markDrop(null);
        setFluidContainer($('#editorPane'), e.clientX, e.clientY);
        if (e.dataTransfer)
            e.dataTransfer.dropEffect = 'copy';
        return;
    }
    if (target?.closest('#sidebar')) {
        e.preventDefault();
        markDrop(dt?.el !== $('#tree') ? (dt?.el ?? null) : null);
        setFluidContainer($('#sidebar'), e.clientX, e.clientY);
        if (e.dataTransfer)
            e.dataTransfer.dropEffect = 'copy';
        return;
    }
    markDrop(dt?.el ?? null);
    setFluidContainer(null, 0, 0);
    if (e.dataTransfer) {
        e.dataTransfer.dropEffect = dt ? 'copy' : 'none';
    }
});
document.addEventListener('dragleave', e => {
    if (!e.relatedTarget) {
        markDrop(null);
        clearTreeDropMarks();
        clearAgentDropMarks();
    }
});
document.addEventListener('drop', e => {
    if (!hasFiles(e) && !draggedTreePath)
        return;
    const target = e.target;
    const ag = agentDropTarget(e);
    if (ag) {
        e.preventDefault();
        clearAgentDropMarks();
        clearTreeDropMarks();
        markDrop(null);
        background(handleAgentDrop(e, ag));
        return;
    }
    if (draggedTreePath) {
        const from = draggedTreePath;
        const isDir = draggedTreeIsDir;
        draggedTreePath = null;
        draggedTreeIsDir = false;
        clearAgentDropMarks();
        clearTreeDropMarks();
        markDrop(null);
        if (target?.closest('#editorPane')) {
            e.preventDefault();
            if (!isDir)
                openFile(from);
            return;
        }
        const treeTarget = treeDropTarget(e);
        if (treeTarget) {
            e.preventDefault();
            background(rearrangeTreeItem(from, treeTarget.path, treeTarget.pos));
            return;
        }
        const mt = moveTarget(e);
        if (mt) {
            e.preventDefault();
            const destDir = mt.dir;
            const fromName = baseName(from);
            const destPath = joinPath(destDir, fromName);
            if (from !== destPath && from !== destDir && !destDir.startsWith(from + '/')) {
                if (destDir)
                    expanded.add(destDir);
                const fromDir = dirName(from);
                const prevFromOrder = (dirCache.get(fromDir) || []).map(entry => entry.name);
                const prevDestOrder = (dirCache.get(destDir) || []).map(entry => entry.name);
                pushAppAction({
                    type: 'tree-move',
                    from: destPath,
                    to: from,
                    fromDir,
                    targetDir: destDir,
                    prevFromOrder,
                    prevTargetOrder: prevDestOrder,
                    name: fromName,
                });
                background(moveEntry(from, destPath));
                toast(`Moved ${fromName} into ${destDir ? baseName(destDir) : 'project root'}`);
            }
            return;
        }
        return;
    }
    e.preventDefault();
    clearAgentDropMarks();
    clearTreeDropMarks();
    markDrop(null);
    const entries = [...(e.dataTransfer?.items ?? [])].map(i => i.webkitGetAsEntry()).filter((x) => !!x);
    if (!entries.length)
        return;
    const inEditor = !!target?.closest('#editorPane');
    const dt = dropTarget(e);
    const destDir = inEditor ? targetDir() : (dt?.dir ?? '');
    background(importDropped(entries, destDir, inEditor));
});
// Puts back a tab's unsaved text and caret from the last session.
function restoreBuffer(b, s, dirty) {
    if (b.kind === 'text' && dirty[b.path] != null) {
        b.text = dirty[b.path];
        if (b.ta)
            b.ta.value = b.text;
    }
    const pos = s.pos[b.path];
    if (b.ta && pos) {
        b.ta.setSelectionRange(pos[0], pos[0]);
        b.ta.scrollTop = pos[1];
    }
}
async function loadWorkspace(info) {
    if (rootInfo) {
        flushSession();
        resetWorkspace();
    }
    rootInfo = info;
    loadTreeOrder();
    background(loadNpmScripts());
    $('#projectName').textContent = info.name;
    $('#projectName').title = info.root;
    document.title = `${info.name} — Breeze Code`;
    const s = store.get(sessionKey(), { tabs: [], active: null, expanded: [], pos: {} });
    const dirty = store.get(hotExitKey(), {});
    expanded.clear();
    for (const d of s.expanded)
        expanded.add(d);
    await Promise.all(['', ...s.expanded].map(loadDir));
    renderTree();
    const loaded = await Promise.all(s.tabs.map(loadBuffer));
    for (const b of loaded) {
        if (!b)
            continue;
        restoreBuffer(b, s, dirty);
        openTabs.push(b.path);
    }
    active = s.active && openTabs.includes(s.active) ? s.active : openTabs[0] ?? null;
    renderTabs();
    renderEditor();
    renderTree();
    restoreChat(SURFACES.ide);
    renderBoxFolder();
    void refreshLiveShare();
    void refreshGit();
    syncCheckedAt = 0;
    background(checkCloudNewer());
    term.cwd = await api.term.cwd();
    renderPs();
}
function resetWorkspace() {
    for (const b of buffers.values())
        b.ta?.remove();
    buffers.clear();
    dirCache.clear();
    expanded.clear();
    treeOrder = {};
    openTabs = [];
    active = null;
    rootInfo = null;
    stopPreview();
    $('#projectName').textContent = 'No folder';
    document.title = 'Breeze Code';
    gitState = { repo: false };
    gitLog = { head: null, commits: [] };
    renderScm();
    renderBranch();
    emptyChat();
    void refreshLiveShare();
}
async function loadDir(rel) {
    try {
        dirCache.set(rel, sortDirEntries(rel, await api.fs.readDir(rel)));
    }
    catch {
        dirCache.delete(rel);
        expanded.delete(rel);
    } // gone or unreadable: show it collapsed
}
function kindOf(r) {
    if (r.image)
        return 'image';
    if (r.binary)
        return 'binary';
    return r.tooLarge ? 'large' : 'text';
}
async function loadBuffer(path) {
    const existing = buffers.get(path);
    if (existing)
        return existing;
    let r;
    try {
        r = await api.fs.readFile(path);
    }
    catch (e) {
        toast(`Couldn't open ${baseName(path)}: ${errMsg(e)}`);
        return null;
    }
    const raw = r.text ?? '';
    const b = {
        path, size: r.size, kind: kindOf(r),
        eol: raw.includes('\r\n') ? '\r\n' : '\n',
        text: raw.replaceAll('\r\n', '\n'), saved: '', ta: null,
        undo: [], redo: [], lastEdit: null,
    };
    b.saved = b.text;
    if (b.kind === 'image')
        b.url = await api.fs.fileUrl(path).catch(() => '');
    if (b.kind === 'text') {
        b.ta = createTextarea(b);
        scheduleLint(b, 0);
    }
    buffers.set(path, b);
    return b;
}
/* ----- Syntax errors for a buffer ----- */
function scheduleLint(b, delay = 450) {
    clearTimeout(b.lintTimer);
    b.lintTimer = setTimeout(() => void lintBuffer(b), delay);
}
// V8 has the final word on JavaScript/TypeScript: it is exact, and clean code clears any false alarm.
// When both find something, the structural messages win on shared lines (they say more).
function mergeSyntax(diags, r) {
    if (!r)
        return diags;
    if ('ok' in r)
        return [];
    if (diags.length && (r.eof || diags.some(d => d.line === r.line)))
        return diags;
    return [...diags, { line: r.line, col: r.col, len: r.len, msg: r.msg }].sort((x, y) => x.line - y.line);
}
async function lintBuffer(b) {
    if (b.kind !== 'text' || buffers.get(b.path) !== b)
        return;
    const seq = b.lintSeq = (b.lintSeq ?? 0) + 1;
    const text = b.text, ext = extOf(b.path);
    let diags = [];
    if (text.length <= LINT_MAX) {
        diags = toDiags(text, lintStructure(text, b.path));
        if (V8_EXT.has(ext)) {
            const r = await api.lint.check(text, ext).catch(() => null);
            if (seq !== b.lintSeq)
                return; // a newer check is on its way
            diags = mergeSyntax(diags, r);
        }
    }
    const had = !!b.diags?.length;
    b.diags = diags;
    b.runDiags = undefined;
    b.diagLines = text.split('\n').length;
    if (had !== !!diags.length)
        renderTabs();
    if (b.path === active)
        renderCode();
}
// Each open file keeps its own textarea (and history) across tab switches.
function createTextarea(b) {
    const ta = document.createElement('textarea');
    ta.className = 'ta hidden';
    ta.spellcheck = false;
    ta.wrap = 'off';
    ta.setAttribute('autocapitalize', 'off');
    ta.setAttribute('autocomplete', 'off');
    ta.setAttribute('aria-label', `Editing ${b.path}`);
    ta.value = b.text;
    textareaOwner.set(ta, b);
    ta.addEventListener('beforeinput', e => beforeEdit(b, e));
    ta.addEventListener('input', () => {
        lastUserTypeAt = Date.now();
        const wasDirty = isDirty(b);
        b.text = ta.value;
        if (wasDirty !== isDirty(b)) {
            renderTabs();
            renderTree();
        }
        if (b.path === splitPath)
            renderSplit();
        if (findOpen)
            runFind(false);
        queueRender();
        saveSession();
        scheduleLint(b);
        // Suggest words while typing one; any other edit closes the list.
        if (b.lastEdit?.kind === 'type' && Date.now() - b.lastEdit.at < 100)
            editorSuggest(b);
        else
            hideSuggest();
    });
    ta.addEventListener('blur', hideSuggest);
    ta.addEventListener('mousedown', hideSuggest);
    ta.addEventListener('scroll', () => { if (suggest?.owner === ta)
        editorSuggest(b); }); // follow the caret
    ta.addEventListener('scroll', syncScroll);
    ta.addEventListener('keydown', editorKeys);
    for (const ev of ['keyup', 'mouseup', 'select', 'selectionchange', 'focus'])
        ta.addEventListener(ev, updateCaret);
    $('#editor .code').appendChild(ta);
    return ta;
}
/* ----- Undo & redo ----- */
// The editor records its own history, so edits made by commands (indent, comment, move line…) undo
// exactly like typing. Typing groups into words; a pause of a second starts a new step.
const GROUPED = new Set(['type', 'deleteContentBackward', 'deleteContentForward']);
function remember(b, kind) {
    const ta = b.ta;
    if (!ta)
        return;
    const now = Date.now();
    const grouped = GROUPED.has(kind) && b.lastEdit?.kind === kind && now - b.lastEdit.at < 1000;
    b.lastEdit = { kind, at: now };
    if (grouped)
        return;
    b.undo.push({ text: ta.value, sel: [ta.selectionStart, ta.selectionEnd] });
    if (b.undo.length > 500)
        b.undo.shift();
    b.redo = [];
}
function beforeEdit(b, e) {
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
        e.preventDefault();
        stepHistory(b, e.inputType === 'historyUndo');
        return;
    }
    const word = e.inputType === 'insertText' && !!e.data && !/\s/.test(e.data);
    remember(b, word ? 'type' : e.inputType);
}
function stepHistory(b, back) {
    const ta = b.ta;
    const [from, to] = back ? [b.undo, b.redo] : [b.redo, b.undo];
    const snap = from.pop();
    if (!ta || !snap)
        return;
    to.push({ text: ta.value, sel: [ta.selectionStart, ta.selectionEnd] });
    b.lastEdit = null;
    ta.value = snap.text;
    ta.setSelectionRange(snap.sel[0], snap.sel[1]);
    ta.dispatchEvent(new Event('input'));
    revealOffset(b, snap.sel[0]);
}
/* ================= Explorer ================= */
const GIT_LETTER = { 'git-m': 'M', 'git-u': 'U', 'git-a': 'A', 'git-d': 'D' };
const INCOMING_TAG = '<span class="gst gst-in" title="Changed on the remote · not pulled yet">M↓</span>';
function chevClass(e, open) {
    if (!e.dir)
        return 'none';
    return open ? 'open' : '';
}
function isIgnoredPath(p, ignored) {
    if (ignored.has(p) || p === '.git' || p.startsWith('.git/'))
        return true;
    let cur = p;
    while (cur.includes('/')) {
        cur = cur.slice(0, cur.lastIndexOf('/'));
        if (ignored.has(cur))
            return true;
    }
    return false;
}
function splitFileName(filename) {
    const dot = filename.lastIndexOf('.');
    if (dot > 0 && dot < filename.length - 1) {
        return { base: filename.slice(0, dot), ext: filename.slice(dot) };
    }
    return { base: filename, ext: '' };
}
function fileNameHtml(filename) {
    const { base, ext } = splitFileName(filename);
    if (!ext)
        return `<span class="nm-base">${esc(base)}</span>`;
    return `<span class="nm-base">${esc(base)}</span><span class="nm-ext">${esc(ext)}</span>`;
}
function treeRow(e, p, depth, decor, enter) {
    const open = e.dir && expanded.has(p);
    const lock = locks[p];
    const lockTag = lock ? `<span class="lock tint-${lock}">${agentsDef[lock].name}</span>` : '';
    const g = e.dir ? (decor.dirs.has(p) && 'has-changes') || '' : decor.files.get(p) ?? '';
    const isIgnored = isIgnoredPath(p, decor.ignored);
    const gitTag = !e.dir && g && !lock ? `<span class="gst">${GIT_LETTER[g] ?? ''}</span>` : '';
    // Changed on the remote and not pulled yet; shows beside the local letter when both apply.
    const inTag = !e.dir && decor.incoming.has(p) && !lock ? INCOMING_TAG : '';
    const cls = ['tree-item', p === active ? 'on' : '', isDirty(buffers.get(p)) ? 'dirty' : '', p === ctxPath ? 'ctx' : '', g, e.dir && decor.incomingDirs.has(p) ? 'has-incoming' : '', isIgnored ? 'git-ignored' : '', enter ? 'enter' : ''].filter(Boolean).join(' ');
    const icon = e.dir ? folderIcon(e.name, open) : fileIcon(e.name);
    const nameHtml = e.dir ? `<span class="nm-base">${esc(e.name)}</span>` : fileNameHtml(e.name);
    return `<div class="${cls}" data-depth="${depth}" data-path="${escAttr(p)}" ${e.dir ? 'data-dir="1" ' : ''}draggable="true" title="${escAttr(p)}">
    <span class="chev ${chevClass(e, open)}">${CHEV}</span><span class="ico">${icon}</span><span class="nm">${nameHtml}</span>${lockTag}${gitTag}${inTag}</div>`;
}
function renderTree() {
    const el = $('#tree');
    if (!rootInfo) {
        el.innerHTML = `<div class="side-note">You have not opened a folder yet.<button class="btn btn-primary btn-sm" data-act="file.openFolder">Open Folder</button></div><div id="recentList"></div>`;
        void renderRecent();
        return;
    }
    const rows = [];
    const decor = gitDecor();
    const walk = (rel, depth) => {
        for (const e of dirCache.get(rel) ?? []) {
            const p = joinPath(rel, e.name);
            const isEntering = !!justExpanded && (rel === justExpanded || rel.startsWith(justExpanded + '/'));
            rows.push(treeRow(e, p, depth, decor, isEntering));
            if (e.dir && expanded.has(p))
                walk(p, depth + 1);
        }
    };
    walk('', 0);
    el.innerHTML = rows.join('') || '<p class="side-note">This folder is empty.</p>';
    // Indentation is set through the DOM: the CSP allows no inline style attributes.
    for (const row of $$('[data-depth]', el))
        row.style.paddingLeft = `${4 + Number(row.dataset.depth) * 12}px`;
    justExpanded = null;
}
function captureTreePositions() {
    const map = new Map();
    const rows = $$('#tree .tree-item[data-path]');
    for (const r of rows) {
        const p = r.dataset.path;
        if (p)
            map.set(p, r.getBoundingClientRect().top);
    }
    return map;
}
function playTreeAnimation(oldPositions) {
    const rows = $$('#tree .tree-item[data-path]');
    for (const r of rows) {
        const p = r.dataset.path;
        if (!p)
            continue;
        if (oldPositions.has(p)) {
            const oldTop = oldPositions.get(p);
            const newTop = r.getBoundingClientRect().top;
            const dy = oldTop - newTop;
            if (Math.abs(dy) > 1) {
                r.animate([
                    { transform: `translateY(${dy}px)` },
                    { transform: 'translateY(0)' },
                ], {
                    duration: 220,
                    easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
                });
            }
        }
        else if (!r.classList.contains('enter')) {
            r.animate([
                { opacity: 0, transform: 'scale(0.96) translateY(-4px)' },
                { opacity: 1, transform: 'scale(1) translateY(0)' },
            ], {
                duration: 180,
                easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
            });
        }
    }
}
function renderTreeAnimated() {
    const oldPositions = captureTreePositions();
    renderTree();
    playTreeAnimation(oldPositions);
}
// The folder whose children should animate in on the next render.
let justExpanded = null;
async function renderRecent() {
    const recent = await api.fs.recent().catch(() => []);
    const el = document.getElementById('recentList');
    if (!el || !recent.length)
        return;
    const rows = recent.map(r => `<div class="tree-item" data-recent="${escAttr(r.path)}" title="${escAttr(r.path)}"><span class="ico">${svgIcon('chevronRight', 14)}</span><span class="nm">${esc(r.name)}</span></div>`);
    el.innerHTML = '<div class="side-head pl-8">Recent</div>' + rows.join('');
}
$('#tree').addEventListener('click', e => {
    const t = e.target.closest('[data-path],[data-recent],[data-act]');
    if (!t || t.dataset.act)
        return; // data-act buttons are handled by the global listener
    if (t.dataset.recent) {
        void openRecentFolder(t.dataset.recent);
        return;
    }
    const p = t.dataset.path;
    if (t.dataset.dir)
        void toggleDir(p);
    else
        openFile(p);
});
$('#tree').addEventListener('dragstart', e => {
    const row = e.target.closest('[data-path][draggable="true"]');
    if (!row)
        return;
    draggedTreePath = row.dataset.path;
    draggedTreeIsDir = !!row.dataset.dir;
    row.classList.add('dragging');
    if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'all';
        e.dataTransfer.setData('text/plain', draggedTreePath);
        e.dataTransfer.setData('application/x-breeze-tree-path', draggedTreePath);
        e.dataTransfer.setData('application/x-breeze-is-dir', draggedTreeIsDir ? '1' : '0');
    }
});
$('#tree').addEventListener('dragend', e => {
    e.target.closest('[data-path]')?.classList.remove('dragging');
    draggedTreePath = null;
    draggedTreeIsDir = false;
    markDrop(null);
    clearTreeDropMarks();
    clearAgentDropMarks();
});
document.addEventListener('dragend', () => {
    for (const el of $$('#tree .tree-item.dragging'))
        el.classList.remove('dragging');
    draggedTreePath = null;
    draggedTreeIsDir = false;
    markDrop(null);
    clearTreeDropMarks();
    clearAgentDropMarks();
});
$('#tree').addEventListener('contextmenu', e => {
    e.preventDefault();
    if (!rootInfo)
        return;
    const t = e.target.closest('[data-path]');
    const p = t?.dataset.path ?? '';
    const isDir = !t || !!t.dataset.dir;
    ctxPath = p || null;
    renderTree();
    const dir = isDir ? p : dirName(p);
    const fileItems = p ? [
        ...(isDir ? [] : [{ label: 'Open in Split View', run: () => background(openFileInSplit(p)) }]),
        { sep: true },
        { label: 'Rename…', key: 'F2', run: () => background(renameEntry(p)) },
        { label: 'Delete', key: 'Delete', run: () => deleteEntry(p, isDir) },
        { sep: true },
        { label: 'Copy Relative Path', run: () => background(navigator.clipboard.writeText(p).then(() => toast('Path copied'))) },
    ] : [];
    popupMenu(e.clientX, e.clientY, [
        { label: 'New File…', run: () => background(newEntry(dir, false)) },
        { label: 'New Folder…', run: () => background(newEntry(dir, true)) },
        ...fileItems,
    ], () => { ctxPath = null; renderTree(); });
});
async function toggleDir(p) {
    const rowEl = $(`#tree .tree-item[data-path="${escAttr(p)}"]`);
    const isClosing = expanded.has(p);
    if (rowEl) {
        const chevEl = rowEl.querySelector('.chev');
        const icoEl = rowEl.querySelector('.ico');
        if (chevEl)
            chevEl.classList.toggle('open', !isClosing);
        if (icoEl) {
            const name = p.split('/').pop() || p;
            icoEl.innerHTML = folderIcon(name, !isClosing);
        }
    }
    if (isClosing) {
        const prefix = p + '/';
        const childRows = $$('#tree .tree-item', $('#tree')).filter(r => (r.dataset.path ?? '').startsWith(prefix));
        if (childRows.length > 0) {
            childRows.forEach(r => r.classList.add('leaving'));
            await new Promise(r => setTimeout(r, 130));
        }
        expanded.delete(p);
    }
    else {
        expanded.add(p);
        if (!dirCache.has(p))
            await loadDir(p);
        justExpanded = p;
    }
    renderTreeAnimated();
    saveSession();
}
async function refreshTree() {
    if (!rootInfo)
        return;
    await Promise.all(['', ...expanded].map(loadDir));
    renderTreeAnimated();
}
// The folder new files go into: right-clicked folder, else the active file's folder, else the root.
const targetDir = () => (active ? dirName(active) : '');
// Wraps a promise's resolve so only the first answer counts (a dialog can be confirmed and then closed).
function settleOnce(resolve) {
    let done = false;
    return v => {
        if (done)
            return;
        done = true;
        resolve(v);
    };
}
function askName(title, initial, okLabel) {
    return new Promise(res => {
        const finish = settleOnce(res);
        openModal(`<h3>${esc(title)}</h3><input class="input name-input" id="nameIn" aria-label="${escAttr(title)}" spellcheck="false" value="${escAttr(initial)}">
      <div class="row end"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="nameOk">${okLabel}</button></div>`, m => {
            const input = $('#nameIn', m);
            input.focus();
            const dot = initial.lastIndexOf('.');
            input.setSelectionRange(0, dot > 0 ? dot : initial.length);
            const ok = () => { const v = input.value.trim(); if (v) {
                finish(v);
                closeModal();
            } };
            $('#nameOk', m).onclick = ok;
            input.onkeydown = e => { if (e.key === 'Enter')
                ok(); };
        }, () => finish(null));
    });
}
async function newEntry(dir, folder) {
    if (!rootInfo) {
        toast('Open a folder first');
        return;
    }
    const name = await askName(folder ? 'New folder' : 'New file', '', 'Create');
    if (!name)
        return;
    const rel = joinPath(dir, name.replaceAll('\\', '/').replace(/^\/+/, ''));
    try {
        if (folder)
            await api.fs.createDir(rel);
        else
            await api.fs.createFile(rel);
    }
    catch (e) {
        toast(errMsg(e));
        return;
    }
    for (let d = dirName(rel); d; d = dirName(d))
        expanded.add(d);
    if (folder)
        expanded.add(rel);
    await refreshTree();
    saveSession();
    if (!folder)
        openFile(rel);
}
async function renameEntry(p) {
    const name = await askName('Rename', baseName(p), 'Rename');
    if (!name || name === baseName(p))
        return;
    if (/[\\/]/.test(name)) {
        toast('Names cannot contain slashes');
        return;
    }
    const to = joinPath(dirName(p), name);
    const dir = dirName(p);
    if (treeOrder[dir]) {
        treeOrder[dir] = treeOrder[dir].map(n => n === baseName(p) ? name : n);
        saveTreeOrder(dir, treeOrder[dir]);
    }
    await moveEntry(p, to);
}
async function moveEntry(p, to) {
    if (p === to)
        return;
    try {
        await api.fs.rename(p, to);
    }
    catch (e) {
        toast(errMsg(e));
        return;
    }
    const move = (x) => {
        if (x === p)
            return to;
        return x.startsWith(p + '/') ? to + x.slice(p.length) : x;
    };
    const moved = [...buffers.values()].filter(b => move(b.path) !== b.path);
    for (const b of moved) {
        buffers.delete(b.path);
        b.path = move(b.path);
        buffers.set(b.path, b);
        scheduleLint(b, 0);
    }
    await Promise.all(moved.filter(b => b.kind === 'image').map(async (b) => { b.url = await api.fs.fileUrl(b.path).catch(() => ''); }));
    openTabs = openTabs.map(move);
    if (active)
        active = move(active);
    const dirs = [...expanded];
    expanded.clear();
    for (const d of dirs)
        expanded.add(move(d));
    dirCache.clear();
    await refreshTree();
    renderTabs();
    renderEditor();
    saveSession();
}
const binName = () => (isDesktop && navigator.userAgent.includes('Windows') ? 'Recycle Bin' : 'Trash');
function deleteEntry(p, isDir) {
    const what = isDir ? 'The folder and everything in it' : 'The file';
    const bin = binName();
    openModal(`<h3>Delete ${esc(baseName(p))}?</h3><p class="sub">${what} will be moved to the ${bin}, so you can restore it.</p>
    <div class="row end"><button class="btn" data-close>Cancel</button><button class="btn btn-danger" id="delOk">Move to ${bin}</button></div>`, m => {
        $('#delOk', m).onclick = () => background((async () => {
            closeModal();
            await api.fs.trash(p);
            const dir = dirName(p);
            if (treeOrder[dir]) {
                treeOrder[dir] = treeOrder[dir].filter(n => n !== baseName(p));
                saveTreeOrder(dir, treeOrder[dir]);
            }
            for (const path of openTabs.filter(x => x === p || x.startsWith(p + '/')))
                dropTab(path);
            expanded.delete(p);
            await refreshTree();
            renderTabs();
            renderEditor();
            saveSession();
        })());
    });
}
// Files changed on disk (by an agent, git or another editor): reload what isn't being edited.
async function reloadImage(b) {
    // Same file URL, new query: the viewer reloads the picture.
    const url = b.url ?? '';
    const q = url.indexOf('?');
    b.url = `${q === -1 ? url : url.slice(0, q)}?v=${Date.now()}`;
    b.size = (await api.fs.readFile(b.path).catch(() => null))?.size ?? b.size;
    if (b.path === active)
        renderEditor();
}
async function reloadText(b) {
    const r = await api.fs.readFile(b.path).catch(() => null); // deleted or unreadable: keep the buffer
    if (r?.text == null)
        return;
    const text = r.text.replaceAll('\r\n', '\n');
    if (typingTo.has(b.path)) {
        typingTo.set(b.path, text);
        return;
    } // the running animation heads for the newest text
    if (text === b.saved || isDirty(b))
        return;
    // While an agent works, its edits are typed out instead of swapped in.
    if (hasAnyActiveRun()) {
        void typeAgentEdit(b, text);
        return;
    }
    remember(b, 'reload');
    b.text = b.saved = text;
    if (b.ta) {
        const s = b.ta.selectionStart;
        b.ta.value = text;
        b.ta.setSelectionRange(s, s);
    }
    if (b.path === active)
        renderCode();
    scheduleLint(b, 0);
}
/* ----- Agent edits, typed out: the old text goes, the new text arrives a few characters at a time ----- */
const typingTo = new Map(); // path -> the text the animation is heading for
const typingCaret = new Map(); // path -> where the agent's caret is while it types
const sleepMs = (ms) => new Promise(res => setTimeout(res, ms));
// Follow the agent to the file it edits, unless the person is busy typing somewhere.
function mayFollowAgent() {
    if ($('#ide').classList.contains('hidden') || modalOpen())
        return false;
    return Date.now() - lastUserTypeAt > 3000;
}
function followAgentTo(path) {
    if (active === path || !mayFollowAgent())
        return;
    if (!openTabs.includes(path))
        openTabs.push(path);
    setActive(path);
}
async function typeAgentEdit(b, text) {
    typingTo.set(b.path, text);
    remember(b, 'reload');
    try {
        // Keep going while newer text arrives (the agent edited the file again meanwhile).
        for (let target = text; b.text !== target; target = typingTo.get(b.path) ?? target) {
            if (!await typeOut(b, target))
                break;
        }
    }
    finally {
        typingTo.delete(b.path);
        typingCaret.delete(b.path);
        if (b.path === active)
            renderCode();
        if (b.path === splitPath)
            renderSplit();
        scheduleLint(b, 0);
        // The new lines stay lit for a moment, then fade back to normal.
        setTimeout(() => { if (!typingTo.has(b.path)) {
            delete added[b.path];
            if (b.path === active)
                renderCode();
        } }, 2500);
    }
}
// Types `after` into the buffer; false when the person started editing it (the rest then lands at once).
async function typeOut(b, after) {
    const before = b.text;
    let s = 0;
    while (s < before.length && s < after.length && before[s] === after[s])
        s++;
    let e = 0;
    while (e < before.length - s && e < after.length - s && before[before.length - 1 - e] === after[after.length - 1 - e])
        e++;
    const head = after.slice(0, s), mid = after.slice(s, after.length - e), tail = after.slice(after.length - e);
    // An insertion that starts with a line break begins on the next line; the line above stays unlit.
    const firstLine = lineAt(after, s) + (mid.startsWith('\n') ? 1 : 0);
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Short edits type at a natural pace; long ones speed up so none takes more than ~2.5 s.
    // Very large files would re-highlight every frame, so they change at once.
    const step = reduce || after.length > 150000 ? mid.length : Math.max(3, Math.ceil(mid.length / 150));
    followAgentTo(b.path);
    let shown = before, frames = 0;
    for (let i = 0;; i = Math.min(mid.length, i + step)) {
        if (b.text !== shown) { // typed over by the person: stop animating; their edit now differs from the disk
            b.saved = after;
            return false;
        }
        const text = head + mid.slice(0, i) + tail;
        const caret = s + i;
        shown = text;
        setBuffer(b, text);
        const last = lineAt(text, caret);
        added[b.path] = new Set(Array.from({ length: last - firstLine + 1 }, (_, n) => firstLine + n));
        typingCaret.set(b.path, caret);
        if (b.path === active) {
            renderCode();
            revealOffset(b, caret);
        }
        if (b.path === splitPath)
            renderSplit();
        if (i >= mid.length)
            break;
        if (++frames % 3 === 0)
            sfx.play('key');
        await sleepMs(16);
    }
    if (running && previewPath && /\.(html?|css|js)$/i.test(b.path))
        void reloadPreview();
    return true;
}
// Replaces the buffer's text as saved on disk, keeping the person's caret where it was.
function setBuffer(b, text) {
    b.text = b.saved = text;
    if (b.ta && b.ta.value !== text) {
        const { selectionStart: st, selectionEnd: en } = b.ta;
        b.ta.value = text;
        b.ta.setSelectionRange(Math.min(st, text.length), Math.min(en, text.length));
    }
}
function typingCaretBox(b, cw) {
    const off = typingCaret.get(b.path);
    if (off == null)
        return [];
    const ls = lineStart(b.text, off);
    return [box('type-caret', lineAt(b.text, off) * LINE_H, visualCol(b.text.slice(ls, lineEnd(b.text, ls)), off - ls) * cw)];
}
api.fs.onChange(paths => background((async () => {
    queueGitRefresh();
    // Reload changed folders, and changed paths that are themselves cached folders (e.g. created then filled).
    const dirs = new Set([...paths.map(dirName), ...paths].filter(d => dirCache.has(d)));
    await Promise.all([...dirs].map(loadDir));
    renderTreeAnimated();
    const changed = paths.map(p => buffers.get(p)).filter((b) => !!b);
    await Promise.all(changed.map(b => {
        if (b.kind === 'image' && b.url?.startsWith('file:'))
            return reloadImage(b);
        if (b.kind === 'text' && !isDirty(b))
            return reloadText(b);
        return Promise.resolve();
    }));
    if (paths.some(path => path === 'index.html' || path.endsWith('/index.html')))
        await refreshLiveShare();
})()));
function openFile(path, at) {
    if (baseName(path).startsWith('.env') && !buffers.has(path)) {
        openModal(`<h3>This is a protected file</h3><p class="sub">${esc(baseName(path))} holds secrets. You can view it, but Breeze's local LLM agent can't read or change it. Codex and other installed agents use their own file access, so Breeze can't keep them out.</p><div class="row end"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="openEnv">Open for me only</button></div>`, m => { $('#openEnv', m).onclick = () => { closeModal(); void actuallyOpen(path, at); }; });
        return;
    }
    void actuallyOpen(path, at);
}
async function actuallyOpen(path, at) {
    const b = await loadBuffer(path);
    if (!b)
        return;
    if (!openTabs.includes(path))
        openTabs.push(path);
    setActive(path);
    if (at && b.ta) {
        const off = offsetOf(b.text, at.line, at.col);
        b.ta.focus();
        b.ta.setSelectionRange(off, off + (at.len ?? 0));
        revealOffset(b, off);
    }
}
// Opens a file on the right side of the split; the left keeps its file (or shows this one too if it had none).
async function openFileInSplit(path) {
    if (baseName(path).startsWith('.env') && !buffers.has(path)) {
        toast('Open this protected file in a tab first');
        return;
    }
    const b = await loadBuffer(path);
    if (!b)
        return;
    if (b.kind !== 'text') {
        toast('Only text files open in the split view');
        return;
    }
    if (!openTabs.includes(path))
        openTabs.push(path);
    if (!active)
        setActive(path);
    else
        renderEditor();
    openSplit(path, true);
    renderTabs();
}
function setActive(path) {
    const changed = active !== path;
    active = path;
    if (changed && path)
        sfx.play('tab');
    renderTabs();
    renderEditor();
    renderTree();
    saveSession();
    if (changed)
        queueDiscord();
    if (changed)
        for (const el of [$('#hl'), $('#gutter')])
            el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
    if (running && path && /\.(html?|css|js)$/i.test(path))
        $('#urlText').title = path;
}
const seenTabs = new Set();
function tabHtml(n) {
    const lock = locks[n];
    const b = buffers.get(n);
    const cls = ['tab', n === active ? 'on' : '', isDirty(b) ? 'dirty' : '', b?.diags?.length ? 'has-err' : '', seenTabs.has(n) ? '' : 'enter'].filter(Boolean).join(' ');
    seenTabs.add(n);
    const dot = lock ? `<span class="dot tint-${lock}"></span>` : '';
    const f = gitState.files?.find(x => x.path === n);
    const st = f && statusOf(f);
    const gitTag = st ? `<span class="gst ${st.cls}" title="${st.title}">${st.letter}</span>` : '';
    const nameHtml = fileNameHtml(baseName(n));
    return `<div class="${cls}" data-tab="${escAttr(n)}" title="${escAttr(n)}">${dot}<span class="ico">${fileIcon(baseName(n))}</span><span class="nm">${nameHtml}</span>${gitTag}<span class="x" data-close-tab="1" title="Close (Ctrl+W)">${svgIcon('x', 12)}</span></div>`;
}
function renderTabs() {
    // Re-rendering mid-drag would drop the tab being dragged; catch up when it lands.
    if (tabDrag?.moved) {
        tabDrag.stale = true;
        return;
    }
    const tabsEl = $('#tabs');
    const hasTabs = openTabs.length > 0;
    tabsEl.classList.toggle('hidden', !hasTabs);
    if (!hasTabs) {
        tabsEl.innerHTML = '';
    }
    else {
        let runBtn = '';
        if (runnable(active)) {
            runBtn = `<button class="tab-run" data-run-file="1" title="Run File (F5)">${svgIcon('play', 12)}<span>Run</span></button>`;
        }
        else if (isHtml(active)) {
            runBtn = `<button class="tab-run tab-preview" data-preview-file="1" title="Preview this page (F5)">${svgIcon('play', 12)}<span>Preview</span></button>`;
        }
        const splitTitle = splitPath ? 'Close Split' : 'Split Editor Right';
        const splitBtn = `<button class="icon-btn tab-split${splitPath ? ' on' : ''}" data-split="1" title="${splitTitle} (Ctrl+\\)">${svgIcon('columns', 14)}</button>`;
        tabsEl.innerHTML = openTabs.map(tabHtml).join('') + runBtn + splitBtn;
    }
    placeTabInk();
    fitTabRunBtn();
    if (!running)
        renderPreviewEmpty();
    renderSplit();
}
// Run / Preview is sticky at the right edge, so on a narrow editor it would cover the file name. Hide it when the tabs and button don't both fit.
function fitTabRunBtn() {
    const tabs = $('#tabs');
    const btn = tabs.querySelector('.tab-run');
    if (!btn)
        return;
    btn.style.display = '';
    const split = tabs.querySelector('.tab-split');
    let need = (split ? split.offsetWidth + 4 : 0) + btn.offsetWidth + 16;
    tabs.querySelectorAll('.tab').forEach((t) => { need += t.offsetWidth + 4; });
    if (need > tabs.clientWidth)
        btn.style.display = 'none';
}
new ResizeObserver(() => fitTabRunBtn()).observe($('#tabs'));
// The blue line under the open tab is one element that glides from the last tab to the new one.
// Tabs are re-rendered, so the line restarts from where it was drawn last and then moves.
let inkAt = null;
function placeTabInk() {
    const tabs = $('#tabs');
    const on = tabs.querySelector('.tab.on');
    const old = tabs.querySelector('.tab-ink');
    if (!on) {
        old?.remove();
        inkAt = null;
        return;
    }
    const ink = old ?? tabs.appendChild(Object.assign(document.createElement('span'), { className: 'tab-ink' }));
    const next = { x: on.offsetLeft + 10, y: on.offsetTop + on.offsetHeight - 1, w: Math.max(0, on.offsetWidth - 20) };
    const draw = (p) => { ink.style.transform = `translate(${p.x}px, ${p.y}px)`; ink.style.width = `${p.w}px`; };
    if (inkAt) {
        ink.style.transition = 'none';
        draw(inkAt);
        const _reflow = ink.offsetWidth; // commit the old spot so the move animates
        ink.style.transition = '';
    }
    draw(next);
    inkAt = next;
}
// A new tab grows in; the line follows its final width once it has.
$('#tabs').addEventListener('animationend', e => { if (e.target.classList.contains('tab'))
    placeTabInk(); });
$('#tabs').addEventListener('click', e => {
    if (e.target.closest('[data-run-file]')) {
        run('run.file');
        return;
    }
    if (e.target.closest('[data-preview-file]')) {
        if (active) {
            void startPreview(active);
        }
        return;
    }
    if (e.target.closest('[data-split]')) {
        run('view.splitEditor');
        return;
    }
    const tab = e.target.closest('[data-tab]');
    if (!tab || justDragged)
        return;
    const p = tab.dataset.tab;
    if (e.target.closest('[data-close-tab]'))
        closeTab(p);
    else
        setActive(p);
});
$('#tabs').addEventListener('wheel', e => {
    const t = e.currentTarget;
    if (!e.deltaX && e.deltaY) {
        t.scrollLeft += e.deltaY;
        e.preventDefault();
    }
}, { passive: false });
$('#tabs').addEventListener('auxclick', e => {
    const tab = e.target.closest('[data-tab]');
    if (tab && e.button === 1)
        closeTab(tab.dataset.tab);
});
// Closes several tabs at once, asking once about any unsaved ones.
function closeTabs(paths) {
    const dirty = paths.map(p => buffers.get(p)).filter((b) => isDirty(b));
    const finish = () => {
        const tabEls = paths.map(p => $(`#tabs [data-tab="${CSS.escape(p)}"]`)).filter((el) => !!el);
        const isClosingAll = paths.length >= openTabs.length;
        if (tabEls.length) {
            tabEls.forEach(el => {
                if (el.classList.contains('closing'))
                    return;
                const w = el.getBoundingClientRect().width;
                el.style.width = `${w}px`;
                el.style.maxWidth = `${w}px`;
                const _reflow = el.offsetWidth;
                el.classList.add('closing');
            });
            if (isClosingAll) {
                const ink = $('#tabs .tab-ink');
                if (ink) {
                    ink.style.opacity = '0';
                    ink.style.transition = 'opacity .12s ease-out';
                }
                $$('#editor .gutter, #editor .code').forEach(el => el.classList.add('editor-blur-out'));
                const empty = $('#editorEmpty');
                if (empty && !empty.classList.contains('hidden'))
                    empty.classList.add('editor-blur-out');
            }
            setTimeout(() => {
                $$('#editor .gutter, #editor .code, #editorEmpty').forEach(el => el.classList.remove('editor-blur-out'));
                for (const p of paths)
                    dropTab(p);
                renderTabs();
                renderEditor();
                renderTree();
                saveSession();
            }, 190);
        }
        else {
            for (const p of paths)
                dropTab(p);
            renderTabs();
            renderEditor();
            renderTree();
            saveSession();
        }
    };
    if (!dirty.length) {
        finish();
        return;
    }
    openModal(`<h3>Save changes to ${plural(dirty.length, 'file')}?</h3><p class="sub">${dirty.map(b => esc(b.path)).join('<br>')}</p>
    <div class="row end"><button class="btn" data-close>Cancel</button><button class="btn" id="tabsDontSave">Don't Save</button><button class="btn btn-primary" id="tabsSave">Save</button></div>`, m => {
        $('#tabsDontSave', m).onclick = () => { closeModal(); finish(); };
        $('#tabsSave', m).onclick = () => {
            closeModal();
            background(Promise.all(dirty.map(b => saveFile(b.path))).then(saved => { if (saved.every(Boolean))
                finish(); }));
        };
    });
}
// Shows a file in the explorer, opening the folders above it.
function revealInTree(p) {
    for (let d = dirName(p); d; d = dirName(d))
        expanded.add(d);
    showView('files', true);
    background(refreshTree().then(() => $$('#tree [data-path]').find(el => el.dataset.path === p)?.scrollIntoView({ block: 'nearest' })));
}
// Right-clicking a tab: close it, the others, the ones to its right, the saved ones or all of them.
$('#tabs').addEventListener('contextmenu', e => {
    const tab = e.target.closest('[data-tab]');
    if (!tab)
        return;
    e.preventDefault();
    const p = tab.dataset.tab;
    const others = openTabs.filter(x => x !== p);
    const right = openTabs.slice(openTabs.indexOf(p) + 1);
    const saved = openTabs.filter(x => !isDirty(buffers.get(x)));
    popupMenu(e.clientX, e.clientY, [
        { label: 'Close', key: 'Ctrl+W', run: () => closeTab(p) },
        { label: 'Close Other Tabs', enabled: () => others.length > 0, run: () => closeTabs(others) },
        { label: 'Close Tabs to the Right', enabled: () => right.length > 0, run: () => closeTabs(right) },
        { label: 'Close Saved Tabs', enabled: () => saved.length > 0, run: () => closeTabs(saved) },
        { label: 'Close All Tabs', run: () => closeTabs([...openTabs]) },
        { sep: true },
        { label: 'Open in Split Right', enabled: () => buffers.get(p)?.kind === 'text', run: () => { openSplit(p, true); renderTabs(); } },
        { sep: true },
        { label: 'Copy Relative Path', run: () => background(navigator.clipboard.writeText(p).then(() => toast('Path copied'))) },
        { label: 'Reveal in Explorer', run: () => revealInTree(p) },
    ]);
});
let tabDrag = null;
let justDragged = false;
const middle = (el) => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; };
function slideFrom(el, fromLeft) {
    const dx = fromLeft - el.getBoundingClientRect().left;
    if (dx)
        el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)' });
}
// Moves `other` to the far side of the dragged tab, keeping the dragged tab under the pointer.
function swapTab(d, other, clientX) {
    const before = d.el.offsetLeft, otherLeft = other.getBoundingClientRect().left;
    if (other === d.el.nextElementSibling)
        d.el.before(other);
    else
        d.el.after(other);
    d.startX += d.el.offsetLeft - before;
    d.el.style.transform = `translateX(${clientX - d.startX}px)`;
    slideFrom(other, otherLeft);
}
function dragTabMove(e) {
    const d = tabDrag;
    if (!d)
        return;
    const dx = e.clientX - d.startX;
    if (!d.moved && Math.abs(dx) < 5)
        return;
    if (!d.moved) {
        d.moved = true;
        d.el.classList.add('dragging');
        $('#tabs').classList.add('drag-active');
    }
    d.el.style.transform = `translateX(${dx}px)`;
    const mid = middle(d.el);
    const next = d.el.nextElementSibling, prev = d.el.previousElementSibling;
    if (next && mid > middle(next))
        swapTab(d, next, e.clientX);
    else if (prev && mid < middle(prev))
        swapTab(d, prev, e.clientX);
}
function dragTabEnd(e) {
    removeEventListener('pointermove', dragTabMove);
    removeEventListener('pointerup', dragTabEnd);
    const d = tabDrag;
    tabDrag = null;
    if (!d?.moved)
        return;
    // The click that follows a drag must not activate or close anything.
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 0);
    $('#tabs').classList.remove('drag-active');
    openTabs = $$('#tabs [data-tab]').map(t => t.dataset.tab);
    const rest = e.clientX - d.startX;
    setActive(d.path);
    const landed = $$('#tabs [data-tab]').find(t => t.dataset.tab === d.path);
    if (landed && rest)
        landed.animate([{ transform: `translateX(${rest}px)` }, { transform: 'none' }], { duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)' });
    const dropEl = document.elementFromPoint(e.clientX, e.clientY);
    if (dropEl?.closest('#agents, #box')) {
        const s = dropEl.closest('#box') ? SURFACES.box : SURFACES.ide;
        void attachPathToAgent(d.path, false, s);
    }
}
$('#tabs').addEventListener('pointerdown', e => {
    const t = e.target;
    const el = t.closest('[data-tab]');
    if (!el || e.button !== 0 || t.closest('[data-close-tab]'))
        return;
    tabDrag = { el, path: el.dataset.tab, startX: e.clientX, moved: false, stale: false };
    addEventListener('pointermove', dragTabMove);
    addEventListener('pointerup', dragTabEnd);
});
function dropTab(path) {
    const i = openTabs.indexOf(path);
    if (i === -1)
        return;
    openTabs.splice(i, 1);
    buffers.get(path)?.ta?.remove();
    buffers.delete(path);
    if (active === path)
        active = openTabs[Math.min(i, openTabs.length - 1)] ?? null;
}
function closeTab(path) {
    const b = buffers.get(path);
    const finish = () => {
        const tabEl = $(`#tabs [data-tab="${CSS.escape(path)}"]`);
        const isLastTab = openTabs.length <= 1;
        if (!tabEl?.classList.contains('closing'))
            sfx.play('close');
        if (tabEl) {
            if (tabEl.classList.contains('closing'))
                return;
            const w = tabEl.getBoundingClientRect().width;
            tabEl.style.width = `${w}px`;
            tabEl.style.maxWidth = `${w}px`;
            const _reflow = tabEl.offsetWidth;
            tabEl.classList.add('closing');
            if (isLastTab) {
                const ink = $('#tabs .tab-ink');
                if (ink) {
                    ink.style.opacity = '0';
                    ink.style.transition = 'opacity .12s ease-out';
                }
                $$('#editor .gutter, #editor .code').forEach(el => el.classList.add('editor-blur-out'));
                const empty = $('#editorEmpty');
                if (empty && !empty.classList.contains('hidden'))
                    empty.classList.add('editor-blur-out');
            }
            setTimeout(() => {
                $$('#editor .gutter, #editor .code, #editorEmpty').forEach(el => el.classList.remove('editor-blur-out'));
                dropTab(path);
                renderTabs();
                renderEditor();
                renderTree();
                saveSession();
            }, 190);
        }
        else {
            dropTab(path);
            renderTabs();
            renderEditor();
            renderTree();
            saveSession();
        }
    };
    if (!isDirty(b)) {
        finish();
        return;
    }
    openModal(`<h3>Save changes to ${esc(baseName(path))}?</h3><p class="sub">Your changes will be lost if you don't save them.</p>
    <div class="row end"><button class="btn" data-close>Cancel</button><button class="btn" id="dontSave">Don't Save</button><button class="btn btn-primary" id="doSave">Save</button></div>`, m => {
        $('#dontSave', m).onclick = () => { closeModal(); finish(); };
        $('#doSave', m).onclick = () => { closeModal(); background(saveFile(path).then(ok => { if (ok)
            finish(); })); };
    });
}
async function saveFile(path = active) {
    const b = path ? buffers.get(path) : undefined;
    if (b?.kind !== 'text')
        return false;
    const text = b.text;
    try {
        await api.fs.writeFile(b.path, b.eol === '\r\n' ? text.replaceAll('\n', '\r\n') : text);
    }
    catch (e) {
        toast(`Couldn't save ${baseName(b.path)}: ${errMsg(e)}`);
        return false;
    }
    b.saved = text;
    renderTabs();
    renderTree();
    flushSession();
    if (running)
        void reloadPreview();
    return true;
}
async function saveAll() {
    const dirty = [...buffers.values()].filter(isDirty);
    await Promise.all(dirty.map(b => saveFile(b.path)));
    if (dirty.length)
        toast(`Saved ${plural(dirty.length, 'file')}`);
}
/* ================= Code editor ================= */
const LINE_H = 21;
const INDENT = '  ';
const hlInner = document.createElement('div');
$('#hl').appendChild(hlInner);
hlInner.style.position = 'relative';
const hlLines = document.createElement('div'); // the rendered window of lines
hlLines.style.position = 'relative';
const hlBoxes = document.createElement('div'); // find hits, squiggles, tag pairs
hlInner.append(hlLines, hlBoxes);
const gutInner = document.createElement('div');
$('#gutter').appendChild(gutInner);
const gutLines = document.createElement('div');
gutLines.style.position = 'relative';
gutInner.append(gutLines);
let charW = 0; //variable
let curLine = -1; //variable
let renderQueued = false; //variable
const activeBuf = () => (active ? buffers.get(active) : undefined);
function activeText() {
    const b = activeBuf();
    return b?.kind === 'text' && b.ta ? b : undefined;
}
function measureChar() {
    if (charW)
        return charW;
    const s = document.createElement('span');
    s.textContent = 'x'.repeat(200);
    s.style.visibility = 'hidden';
    hlInner.appendChild(s);
    charW = s.getBoundingClientRect().width / 200 || 7.8;
    s.remove();
    return charW;
}
void document.fonts?.ready.then(() => { charW = 0; renderCode(); });
const lineStart = (v, pos) => v.lastIndexOf('\n', pos - 1) + 1;
const lineEnd = (v, pos) => { const i = v.indexOf('\n', pos); return i === -1 ? v.length : i; };
function lineAt(v, pos) {
    let n = 0;
    for (let i = v.indexOf('\n'); i !== -1 && i < pos; i = v.indexOf('\n', i + 1))
        n++;
    return n;
}
function offsetOf(v, line, col) {
    let off = 0;
    for (let i = 0; i < line; i++) {
        const nl = v.indexOf('\n', off);
        if (nl === -1)
            return v.length;
        off = nl + 1;
    }
    return Math.min(off + col, lineEnd(v, off));
}
function visualCol(lineText, col) {
    let v = 0;
    for (let i = 0; i < col; i++)
        v = lineText[i] === '\t' ? v + 4 - (v % 4) : v + 1;
    return v;
}
function editorNote(b) {
    if (b.kind === 'binary')
        return 'This file is binary, so Breeze can\'t show it as text.';
    if (b.kind === 'image')
        return 'Breeze couldn\'t load this image.';
    return `This file is too large to open (${(b.size / 1048576).toFixed(1)} MB).`;
}
function renderEditor() {
    hideSuggest();
    const b = activeBuf();
    for (const x of buffers.values())
        x.ta?.classList.toggle('hidden', x !== b);
    const empty = $('#editorEmpty');
    if (b?.kind !== 'text') {
        const wasHidden = empty.classList.contains('hidden');
        empty.classList.remove('hidden');
        if (b?.kind === 'image' && b.url)
            showImage(empty, b);
        else {
            empty.classList.remove('img-mode');
            delete empty.dataset.img;
            empty.innerHTML = b ? fileNoteHtml(b.path, editorNote(b)) : welcomeHtml();
        }
        if (wasHidden || !b) {
            empty.classList.remove('enter');
            const _reflow = empty.offsetWidth;
            empty.classList.add('enter');
            empty.addEventListener('animationend', () => empty.classList.remove('enter'), { once: true });
        }
        hlLines.replaceChildren();
        hlBoxes.replaceChildren();
        gutLines.replaceChildren();
        closeFind();
        updateStatus();
        return;
    }
    empty.classList.add('hidden');
    empty.classList.remove('enter');
    if (findOpen)
        runFind(false);
    renderCode();
    if (document.activeElement === document.body || document.activeElement?.classList.contains('ta'))
        b.ta?.focus({ preventScroll: true });
}
const fileNoteHtml = (path, note) => `<div><h4>${esc(baseName(path))}</h4><div>${esc(note)}</div></div>`;
function fmtSize(n) {
    if (n < 1024)
        return `${n} B`;
    return n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}
// Images open in a viewer: fitted to the editor, click to see them at actual size.
function showImage(el, b) {
    el.classList.add('img-mode');
    if (el.dataset.img === b.url)
        return; // already showing it: keep its zoom and scroll
    el.dataset.img = b.url;
    el.innerHTML = `<div class="img-stage fit"><img src="${escAttr(b.url ?? '')}" alt="${escAttr(baseName(b.path))}" draggable="false"></div>
    <div class="img-meta"><span class="img-dims">Loading…</span><span>${fmtSize(b.size)}</span><span class="img-zoom hidden"></span></div>`;
    const stage = $('.img-stage', el), img = $('img', el), zoom = $('.img-zoom', el);
    const shrunk = () => img.naturalWidth > img.clientWidth + 1 || img.naturalHeight > img.clientHeight + 1;
    const hint = () => {
        const fit = stage.classList.contains('fit');
        zoom.textContent = fit ? 'Fit to window · click to zoom' : 'Actual size · click to fit';
        zoom.classList.toggle('hidden', fit && !shrunk());
        stage.classList.toggle('zoomable', !fit || shrunk());
    };
    img.onload = () => { $('.img-dims', el).textContent = `${img.naturalWidth} × ${img.naturalHeight}`; hint(); };
    img.onmouseenter = hint; // panels may have been resized since it loaded
    img.onerror = () => { el.classList.remove('img-mode'); el.innerHTML = fileNoteHtml(b.path, 'Breeze couldn\'t load this image.'); };
    img.onclick = e => {
        const fit = stage.classList.contains('fit');
        if (fit && !shrunk())
            return;
        // Zoom in around the clicked point.
        const r = img.getBoundingClientRect(), s = stage.getBoundingClientRect();
        const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
        stage.classList.toggle('fit');
        if (fit) {
            stage.scrollLeft = img.offsetLeft + fx * img.naturalWidth - (e.clientX - s.left);
            stage.scrollTop = img.offsetTop + fy * img.naturalHeight - (e.clientY - s.top);
        }
        hint();
    };
}
function welcomeHtml() {
    const k = (keys, what) => `<span>${what}</span><kbd>${keys}</kbd>`;
    const keys = rootInfo
        ? k('Ctrl+P', 'Go to file') + k('Ctrl+N', 'New file') + k('Ctrl+Shift+F', 'Search files') + k('Ctrl+`', 'Terminal')
        : k('Ctrl+O', 'Open folder') + k('Ctrl+B', 'Toggle side bar') + k('Ctrl+Alt+B', 'Toggle agents');
    return `<div><img src="../../assets/brand/Agent.png" alt="" draggable="false"><h4>${rootInfo ? 'No file open' : 'Open a folder to start'}</h4><div class="keys">${keys}</div></div>`;
}
function queueRender() {
    if (renderQueued)
        return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderCode(); });
}
// Overlay boxes (find hits, squiggles) are placed through the DOM, not style attributes.
function box(cls, top, left, width) {
    const d = document.createElement('div');
    d.className = cls;
    d.style.top = `${top}px`;
    d.style.left = `${left}px`;
    if (width != null)
        d.style.width = `${width}px`;
    return d;
}
function findBoxes(b, cw) {
    if (!findOpen || !findLen)
        return [];
    const vis = findHits.length > 3000 ? findHits.slice(Math.max(0, findIdx - 1500), findIdx + 1500) : findHits;
    return vis.map(off => {
        const ln = lineAt(b.text, off), ls = lineStart(b.text, off);
        const lt = b.text.slice(ls, lineEnd(b.text, ls));
        const x = visualCol(lt, off - ls) * cw, w = (visualCol(lt, off - ls + findLen) * cw) - x;
        return box(off === findHits[findIdx] ? 'hit cur' : 'hit', ln * LINE_H, x, Math.max(w, 2));
    });
}
// Syntax errors: a red line, a squiggle under the mistake and the message after the code.
// While an edit has added or removed lines they wait for the next check instead of drifting.
function visibleDiags(b, lineCount) {
    const errAt = new Map();
    if (!b.diags?.length || b.diagLines !== lineCount)
        return errAt;
    for (const d of b.diags) {
        const ln = Math.min(d.line, lineCount - 1);
        if (!errAt.has(ln))
            errAt.set(ln, d);
    }
    return errAt;
}
function squiggles(b, lineCount, cw) {
    if (!b.diags?.length || b.diagLines !== lineCount)
        return [];
    const raw = b.text.split('\n');
    return b.diags.map(d => {
        const ln = Math.min(d.line, raw.length - 1), lt = raw[ln];
        const from = Math.min(d.col, lt.length), to = Math.min(lt.length, d.col + d.len);
        const x = visualCol(lt, from) * cw;
        return box('squig', ln * LINE_H + 15, x, Math.max(visualCol(lt, to) * cw - x, cw));
    });
}
/* ----- Matching tags: with the caret in an opening or closing tag, both halves light up ----- */
const VOID_HTML = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
// Pairs every opening tag with its closing tag (void and self-closing tags have no partner; stray closers are ignored).
function tagPairs(text, xml) {
    const re = /<!--[\s\S]*?(?:-->|$)|<(\/?)([A-Za-z][\w:.-]*)([^>]*)>/g;
    const stack = [];
    const pairs = [];
    for (let m = re.exec(text); m; m = re.exec(text)) {
        if (m[0].startsWith('<!--'))
            continue;
        const name = xml ? m[2] : m[2].toLowerCase();
        const nameStart = m.index + 1 + m[1].length;
        const span = { start: m.index, end: m.index + m[0].length, nameStart, nameEnd: nameStart + m[2].length };
        if (m[1]) {
            const at = stack.map(s => s.name).lastIndexOf(name);
            if (at === -1)
                continue;
            pairs.push([stack[at].span, span]);
            stack.length = at; // anything opened after it was left open
        }
        else if (!m[3].endsWith('/') && (xml || !VOID_HTML.has(name)))
            stack.push({ name, span });
    }
    return pairs;
}
// The two tags around the caret as offset ranges to mark: exactly the tag names, so the boxes hug the letters.
function tagMarks(b) {
    const lexer = langOf(b.path)[0], ext = b.path.split('.').pop()?.toLowerCase() ?? '';
    if ((lexer !== 'html' && ext !== 'jsx' && ext !== 'tsx') || b.text.length > 200000)
        return [];
    if (!b.ta)
        return [];
    const caret = b.ta.selectionStart;
    const hit = (t, strict) => (strict ? t.start < caret && caret < t.end : t.start <= caret && caret <= t.end);
    const pairs = tagPairs(b.text, ext === 'xml' || ext === 'svg' || ext === 'jsx' || ext === 'tsx');
    const pair = pairs.find(p => p.some(t => hit(t, true))) ?? pairs.find(p => p.some(t => hit(t, false)));
    return pair ? pair.map(t => [t.nameStart, t.nameEnd]) : [];
}
function tagBoxes(b, cw) {
    return tagMarks(b).map(([from, to]) => {
        const ln = lineAt(b.text, from), ls = lineStart(b.text, from);
        const lt = b.text.slice(ls, lineEnd(b.text, ls));
        const x = visualCol(lt, from - ls) * cw;
        return box('tagpair', ln * LINE_H, x, Math.max(visualCol(lt, to - ls) * cw - x, 2));
    });
}
const blockCache = new WeakMap();
function lineStarts(text) {
    const s = [0];
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1))
        s.push(i + 1);
    return s;
}
function lineOfOffset(starts, off) {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= off)
            lo = mid;
        else
            hi = mid - 1;
    }
    return lo;
}
// Every {} [] () pair as [open, close] offsets, skipping strings and comments.
const OPENER = { '}': '{', ']': '[', ')': '(' };
function bracketPairs(text) {
    const pairs = [], stack = [];
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '/' && text[i + 1] === '/') {
            const nl = text.indexOf('\n', i);
            if (nl === -1)
                break;
            i = nl;
            continue;
        }
        if (c === '/' && text[i + 1] === '*') {
            const e = text.indexOf('*/', i + 2);
            if (e === -1)
                break;
            i = e + 1;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            let j = i + 1;
            while (j < text.length && text[j] !== c && (c === '`' || text[j] !== '\n'))
                j += text[j] === '\\' ? 2 : 1;
            i = j;
            continue;
        }
        if (c === '{' || c === '[' || c === '(')
            stack.push(i);
        else if (OPENER[c]) {
            let at = stack.length - 1;
            while (at >= 0 && text[stack[at]] !== OPENER[c])
                at--;
            if (at !== -1) {
                pairs.push([stack[at], i]);
                stack.length = at;
            }
        }
    }
    return pairs;
}
function blocksOf(b) {
    const c = blockCache.get(b);
    if (c?.text === b.text)
        return c.blocks;
    const text = b.text, lexer = langOf(b.path)[0], ext = extOf(b.path);
    const blocks = [];
    if (text.length <= 200000) {
        const starts = lineStarts(text);
        const indentOf = (ln) => {
            const lt = text.slice(starts[ln], lineEnd(text, starts[ln]));
            return visualCol(lt, lt.length - lt.trimStart().length);
        };
        const add = (open, close) => {
            const from = lineOfOffset(starts, open), to = lineOfOffset(starts, close);
            if (to - from >= 2)
                blocks.push({ from, to, start: open, end: close + 1, col: Math.min(indentOf(from), indentOf(to)) });
        };
        if (lexer === 'html' || ext === 'jsx' || ext === 'tsx') {
            for (const [o, cl] of tagPairs(text, lexer !== 'html' || ext === 'xml' || ext === 'svg'))
                add(o.start, cl.start);
        }
        if (['js', 'css', 'json', 'java', 'rs', 'cs'].includes(lexer))
            for (const [o, cl] of bracketPairs(text))
                add(o, cl);
        if (lexer === 'py') {
            // Python blocks are the lines indented under a line that ends with ':'.
            const raw = text.split('\n');
            raw.forEach((lt, i) => {
                if (!/:\s*(?:#.*)?$/.test(lt) || !lt.trim())
                    return;
                const ind = indentOf(i);
                let last = i;
                for (let j = i + 1; j < raw.length; j++) {
                    if (!raw[j].trim())
                        continue;
                    if (indentOf(j) <= ind)
                        break;
                    last = j;
                }
                if (last > i)
                    blocks.push({ from: i, to: last + 1, start: starts[i], end: starts[last] + raw[last].length, col: ind });
            });
        }
    }
    blockCache.set(b, { text, blocks });
    return blocks;
}
// Guides for the blocks in view; the innermost one around the caret is brighter.
function guideBoxes(b, caret, cw, first = winFirst, last = winLast) {
    const blocks = blocksOf(b);
    let on;
    for (const k of blocks)
        if (k.start <= caret && caret <= k.end && (!on || k.end - k.start < on.end - on.start))
            on = k;
    return blocks.filter(k => k.to > first && k.from < last).map(k => {
        const d = box(k === on ? 'guide on' : 'guide', (k.from + 1) * LINE_H, k.col * cw);
        d.style.height = `${(k.to - k.from - 1) * LINE_H}px`;
        return d;
    });
}
let tagKey = '';
function lineHtml(h, i, add, d) {
    const cls = ['ln', add?.has(i) ? 'added' : '', d ? 'err' : '', i === curLine ? 'cur-line' : ''].filter(Boolean).join(' ');
    const msg = d ? `<span class="diag-msg">${esc(d.msg)}</span>` : '';
    return `<div class="${cls}">${h}${msg}</div>`;
}
function gutterHtml(i, d) {
    const cls = [i === curLine ? 'cur' : '', d ? 'err' : ''].filter(Boolean).join(' ');
    const attrs = (cls ? ` class="${cls}"` : '') + (d ? ` title="${escAttr(d.msg)}"` : '');
    return `<div${attrs}>${i + 1}</div>`;
}
const OVERSCAN = 40;
let winFirst = 0, winLast = 0, winTotal = 1;
const hlCache = new WeakMap();
// Re-lexes only when the text changed, so scrolling never re-highlights.
function highlighted(b) {
    const lexer = langOf(b.path)[0];
    const c = hlCache.get(b);
    if (c?.text === b.text && c.lexer === lexer)
        return c.lines;
    const lines = highlightLines(b.text, lexer);
    hlCache.set(b, { text: b.text, lexer, lines });
    return lines;
}
function visibleLines(ta, total) {
    const first = clamp(Math.floor((ta.scrollTop - 10) / LINE_H), 0, total - 1);
    const last = clamp(Math.ceil((ta.scrollTop + (ta.clientHeight || 800)) / LINE_H), 0, total);
    return [first, last];
}
function renderCode() {
    const b = activeText();
    if (!b)
        return;
    const lines = highlighted(b);
    winTotal = lines.length;
    curLine = lineAt(b.text, b.ta.selectionStart);
    const cw = measureChar();
    const errAt = visibleDiags(b, lines.length);
    const add = added[b.path];
    const [vf, vl] = visibleLines(b.ta, lines.length);
    winFirst = Math.max(0, vf - OVERSCAN);
    winLast = Math.min(lines.length, vl + OVERSCAN);
    const rows = [], nums = [];
    for (let i = winFirst; i < winLast; i++) {
        rows.push(lineHtml(lines[i], i, add, errAt.get(i)));
        nums.push(gutterHtml(i, errAt.get(i)));
    }
    hlLines.innerHTML = rows.join('');
    hlLines.style.top = `${winFirst * LINE_H}px`;
    gutLines.innerHTML = nums.join('');
    gutLines.style.top = `${winFirst * LINE_H}px`;
    hlBoxes.replaceChildren(...guideBoxes(b, b.ta.selectionStart, cw), ...findBoxes(b, cw), ...squiggles(b, lines.length, cw), ...tagBoxes(b, cw), ...typingCaretBox(b, cw));
    tagKey = `${b.path}:${b.ta.selectionStart}:${b.text.length}`;
    $('#gutter').style.width = `${Math.max(3, String(lines.length).length) * 8 + 32}px`;
    syncScroll();
    updateStatus();
}
function syncScroll() {
    const b = activeText();
    if (!b)
        return;
    // Scrolled past the rendered window: draw the new one (cheap, the highlighting is cached).
    const [vf, vl] = visibleLines(b.ta, winTotal);
    if (vf < winFirst || vl > winLast) {
        renderCode();
        return;
    }
    hlInner.style.transform = `translate(${-b.ta.scrollLeft}px, ${-b.ta.scrollTop}px)`;
    gutInner.style.transform = `translateY(${-b.ta.scrollTop}px)`;
    updateVSlider(b.ta);
}
/* ----- Vertical scroll slider on the right edge of the editor (native scrollbars are hidden) ----- */
const vTrack = document.createElement('div');
vTrack.className = 'v-slider';
const vThumb = document.createElement('div');
vThumb.className = 'v-slider-thumb';
vTrack.append(vThumb);
$('#editor').append(vTrack);
function updateVSlider(ta) {
    const room = vTrack.clientHeight;
    const overflow = ta.scrollHeight - ta.clientHeight;
    vTrack.classList.toggle('on', overflow > 0 && room > 0);
    if (overflow <= 0 || room <= 0)
        return;
    const h = Math.max(32, room * ta.clientHeight / ta.scrollHeight);
    vThumb.style.height = `${h}px`;
    vThumb.style.transform = `translateY(${(room - h) * ta.scrollTop / overflow}px)`;
}
vThumb.addEventListener('pointerdown', e => {
    const b = activeText();
    if (!b)
        return;
    const ta = b.ta;
    const startY = e.clientY, startTop = ta.scrollTop;
    vThumb.setPointerCapture(e.pointerId);
    vTrack.classList.add('drag');
    const move = (ev) => {
        const travel = vTrack.clientHeight - vThumb.offsetHeight;
        if (travel > 0)
            ta.scrollTop = startTop + (ev.clientY - startY) * (ta.scrollHeight - ta.clientHeight) / travel;
    };
    const up = () => {
        vTrack.classList.remove('drag');
        vThumb.removeEventListener('pointermove', move);
        vThumb.removeEventListener('pointerup', up);
    };
    vThumb.addEventListener('pointermove', move);
    vThumb.addEventListener('pointerup', up);
    e.preventDefault();
});
vTrack.addEventListener('pointerdown', e => {
    if (e.target !== vTrack)
        return;
    const b = activeText();
    if (!b)
        return;
    const r = vTrack.getBoundingClientRect();
    b.ta.scrollTop = (e.clientY - r.top) / r.height * (b.ta.scrollHeight - b.ta.clientHeight);
});
/* ----- Split editor: a second text file on the right, editing the same buffer as its tab ----- */
let splitPath = null;
const splitTa = $('#splitTa');
const splitLines = document.createElement('div');
splitLines.style.position = 'relative';
const splitInner = document.createElement('div');
splitInner.style.position = 'relative';
splitInner.append(splitLines);
$('#splitHl').appendChild(splitInner);
const splitGutInner = document.createElement('div');
const splitGutLines = document.createElement('div');
splitGutLines.style.position = 'relative';
splitGutInner.append(splitGutLines);
$('#splitGutter').appendChild(splitGutInner);
let splitWin = { first: 0, last: 0, total: 1 };
const splitBuf = () => { const b = splitPath ? buffers.get(splitPath) : undefined; return b?.kind === 'text' ? b : undefined; };
const textTabs = () => openTabs.filter(p => buffers.get(p)?.kind === 'text');
function openSplit(path = active, exact = false) {
    // Split the file next to the open one when possible, so the two sides start out different.
    const others = textTabs().filter(p => p !== active);
    const target = exact || (path && path !== active) ? path : others[0] ?? path;
    if (!target || buffers.get(target)?.kind !== 'text') {
        toast('Open a text file to split the editor');
        return;
    }
    splitPath = target;
    const split = $('#split');
    // Slides in from the right edge (only when it wasn't already showing).
    if (split.classList.contains('hidden') || split.classList.contains('closing')) {
        split.classList.remove('hidden', 'closing');
        split.classList.add('opening');
        const end = (e) => { if (!e || e.target === split) {
            split.classList.remove('opening');
            split.removeEventListener('animationend', end);
        } };
        split.addEventListener('animationend', end);
        setTimeout(end, 450); // the animation didn't run (hidden window, reduced motion): settle anyway
    }
    $('#editorRow').classList.add('is-split');
    splitTa.value = '';
    renderSplit();
    splitTa.scrollTop = 0;
    splitTa.focus({ preventScroll: true });
    syncScroll();
}
function closeSplit() {
    splitPath = null;
    const split = $('#split');
    if (split.classList.contains('hidden'))
        return;
    // Slides back out to the right, then hides.
    split.classList.remove('opening');
    split.classList.add('closing');
    const done = () => {
        if (splitPath || !split.classList.contains('closing'))
            return; // reopened meanwhile
        split.classList.remove('closing');
        split.classList.add('hidden');
        $('#editorRow').classList.remove('is-split');
        splitLines.replaceChildren();
        splitGutLines.replaceChildren();
        queueRender();
    };
    const end = (e) => { if (e.target === split) {
        split.removeEventListener('animationend', end);
        done();
    } };
    split.addEventListener('animationend', end);
    setTimeout(done, 400); // no animation (reduced motion): hide anyway
}
// Brings the right side up to date with its buffer (after edits on the left, a save, or an agent's change).
function renderSplit() {
    if (!splitPath)
        return;
    const b = splitBuf();
    if (!b) {
        closeSplit();
        return;
    }
    const sel = $('#splitFile');
    const opts = textTabs();
    const html = opts.map(p => `<option value="${escAttr(p)}"${p === splitPath ? ' selected' : ''}>${esc(baseName(p))}${dirName(p) ? ` — ${esc(dirName(p))}` : ''}</option>`).join('');
    if (sel.innerHTML !== html)
        sel.innerHTML = html;
    sel.value = splitPath;
    $('#splitIco').innerHTML = fileIcon(baseName(splitPath));
    $('#splitDirty').classList.toggle('hidden', !isDirty(b));
    if (splitTa.value !== b.text) {
        const { selectionStart: s, selectionEnd: e, scrollTop } = splitTa;
        splitTa.value = b.text;
        splitTa.setSelectionRange(Math.min(s, b.text.length), Math.min(e, b.text.length));
        splitTa.scrollTop = scrollTop;
    }
    paintSplit();
}
function paintSplit() {
    const b = splitBuf();
    if (!b)
        return;
    const lines = highlighted(b);
    const cur = lineAt(b.text, splitTa.selectionStart);
    const [vf, vl] = visibleLines(splitTa, lines.length);
    splitWin = { first: Math.max(0, vf - OVERSCAN), last: Math.min(lines.length, vl + OVERSCAN), total: lines.length };
    const rows = [], nums = [];
    for (let i = splitWin.first; i < splitWin.last; i++) {
        rows.push(`<div class="ln${i === cur ? ' cur-line' : ''}">${lines[i]}</div>`);
        nums.push(`<div${i === cur ? ' class="cur"' : ''}>${i + 1}</div>`);
    }
    splitLines.innerHTML = rows.join('');
    splitLines.style.top = splitGutLines.style.top = `${splitWin.first * LINE_H}px`;
    splitGutLines.innerHTML = nums.join('');
    $('#splitGutter').style.width = `${Math.max(3, String(lines.length).length) * 8 + 32}px`;
    splitInner.querySelectorAll('.guide').forEach(g => g.remove());
    splitInner.append(...guideBoxes(b, splitTa.selectionStart, measureChar(), splitWin.first, splitWin.last));
    syncSplitScroll();
}
function syncSplitScroll() {
    const [vf, vl] = visibleLines(splitTa, splitWin.total);
    if (vf < splitWin.first || vl > splitWin.last) {
        paintSplit();
        return;
    }
    splitInner.style.transform = `translate(${-splitTa.scrollLeft}px, ${-splitTa.scrollTop}px)`;
    splitGutInner.style.transform = `translateY(${-splitTa.scrollTop}px)`;
}
splitTa.addEventListener('scroll', syncSplitScroll);
splitTa.addEventListener('input', () => {
    const b = splitBuf();
    if (!b)
        return;
    const wasDirty = isDirty(b);
    b.text = splitTa.value;
    // The same file open on the left follows along, keeping its own caret.
    if (b.ta && b.ta.value !== b.text) {
        const { selectionStart: s, selectionEnd: e } = b.ta;
        b.ta.value = b.text;
        b.ta.setSelectionRange(Math.min(s, b.text.length), Math.min(e, b.text.length));
    }
    if (wasDirty !== isDirty(b)) {
        renderTabs();
        renderTree();
    }
    if (b.path === active)
        queueRender();
    paintSplit();
    saveSession();
    scheduleLint(b);
    $('#splitDirty').classList.toggle('hidden', !isDirty(b));
});
for (const ev of ['click', 'keyup', 'select'])
    splitTa.addEventListener(ev, paintSplit);
splitTa.addEventListener('keydown', e => {
    const b = splitBuf();
    if (!b)
        return;
    // Ctrl+S goes through file.save, which saves this side's file while it has focus.
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        document.execCommand('insertText', false, INDENT);
    }
});
$('#splitFile').onchange = e => { splitPath = e.target.value; splitTa.value = ''; renderSplit(); splitTa.scrollTop = 0; };
$('#splitClose').onclick = closeSplit;
$('#splitSwap').onclick = () => {
    if (!splitPath)
        return;
    const left = active, right = splitPath;
    setActive(right);
    if (left && left !== right) {
        splitPath = left;
        splitTa.value = '';
        renderSplit();
    }
};
// Drag the split's left edge to share the width between the two sides.
$('#splitSash').addEventListener('pointerdown', e => {
    if (e.button !== 0)
        return;
    e.preventDefault();
    const row = $('#editorRow'), split = $('#split');
    const sx = e.clientX, startW = split.getBoundingClientRect().width;
    document.body.classList.add('resizing');
    const move = (ev) => {
        const w = clamp(startW - (ev.clientX - sx), 200, row.clientWidth - 200);
        split.style.flexBasis = `${w}px`;
        paintSplit();
        syncScroll();
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); document.body.classList.remove('resizing'); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
});
function updateCaret() {
    const b = activeText();
    if (!b)
        return;
    const i = lineAt(b.text, b.ta.selectionStart);
    if (i !== curLine) {
        hlLines.children[curLine - winFirst]?.classList.remove('cur-line');
        gutLines.children[curLine - winFirst]?.classList.remove('cur');
        hlLines.children[i - winFirst]?.classList.add('cur-line');
        gutLines.children[i - winFirst]?.classList.add('cur');
        curLine = i;
    }
    // Clicking (or arrowing) into a tag marks it and its partner; the boxes are swapped without redrawing the code.
    const key = `${b.path}:${b.ta.selectionStart}:${b.text.length}`;
    if (key !== tagKey) {
        tagKey = key;
        $$('.tagpair, .guide', hlBoxes).forEach(x => x.remove());
        hlBoxes.prepend(...guideBoxes(b, b.ta.selectionStart, measureChar()));
        hlBoxes.append(...tagBoxes(b, measureChar()));
    }
    updateStatus();
} //end of update caret
function updateStatus() {
    const b = activeBuf();
    const tb = activeText();
    $('#sbPos').classList.toggle('hidden', !tb);
    $('#sbLang').textContent = b ? langOf(b.path)[1] : '';
    $('#sbLang').classList.toggle('hidden', !b);
    const eol = b?.eol === '\r\n' ? 'CRLF' : 'LF';
    $('#sbEol').textContent = b?.kind === 'text' ? `${eol} · UTF-8` : '';
    $('#sbEol').classList.toggle('hidden', b?.kind !== 'text');
    const problems = tb?.diags?.length ?? 0;
    $('#sbProblems').innerHTML = `${svgIcon('circleX', 12)}<span>${plural(problems, 'problem')}</span>`;
    $('#sbProblems').classList.toggle('hidden', !problems);
    if (!tb)
        return;
    const { selectionStart: s, selectionEnd: e } = tb.ta;
    const ls = lineStart(tb.text, s);
    const selected = e > s ? ` (${e - s} selected)` : '';
    $('#sbPos').textContent = `Ln ${lineAt(tb.text, s) + 1}, Col ${s - ls + 1}${selected}`;
}
// F8: move the caret to the next syntax error after it, wrapping around.
function nextProblem() {
    const b = activeText();
    if (!b?.diags?.length) {
        toast('No problems in this file');
        return;
    }
    const offs = b.diags.map(d => offsetOf(b.text, d.line, d.col));
    const off = offs.find(o => o > b.ta.selectionStart) ?? offs[0];
    b.ta.focus();
    b.ta.setSelectionRange(off, off);
    revealOffset(b, off);
}
function revealOffset(b, off) {
    if (!b.ta)
        return;
    const top = lineAt(b.text, off) * LINE_H;
    const ta = b.ta;
    if (top < ta.scrollTop || top > ta.scrollTop + ta.clientHeight - LINE_H * 3)
        ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
    const ls = lineStart(b.text, off);
    const x = visualCol(b.text.slice(ls, lineEnd(b.text, ls)), off - ls) * measureChar();
    if (x < ta.scrollLeft || x > ta.scrollLeft + ta.clientWidth - 80)
        ta.scrollLeft = Math.max(0, x - ta.clientWidth / 2);
    syncScroll();
    updateCaret();
}
// Replaces a range as one undoable step.
function replaceRange(ta, start, end, text, selStart, selEnd) {
    const b = textareaOwner.get(ta);
    if (b)
        remember(b, 'command');
    ta.focus();
    ta.setRangeText(text, start, end, 'end');
    if (selStart != null)
        ta.setSelectionRange(selStart, selEnd ?? selStart);
    ta.dispatchEvent(new Event('input'));
}
function selectedLines(ta) {
    const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    return [lineStart(v, s), lineEnd(v, e > s && v[e - 1] === '\n' ? e - 1 : e)];
}
function indentKey(ta, outdent) {
    const v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
    if (!outdent && !v.slice(s, en).includes('\n')) {
        replaceRange(ta, s, en, INDENT);
        return;
    }
    const [ls, le] = selectedLines(ta);
    const block = v.slice(ls, le);
    const lines = block.split('\n');
    const out = lines.map(l => (outdent ? l.replace(/^(?: {1,2}|\t)/, '') : INDENT + l)).join('\n');
    const firstDelta = out.split('\n')[0].length - lines[0].length;
    replaceRange(ta, ls, le, out, Math.max(ls, s + firstDelta), en + out.length - block.length);
}
// True when `before` ends with an opening tag such as <div class="x">.
function endsWithOpenTag(before) {
    const lt = before.lastIndexOf('<');
    if (lt === -1 || !before.endsWith('>'))
        return false;
    const tag = before.slice(lt);
    return /^<[A-Za-z]/.test(tag) && !tag.endsWith('/>');
}
function enterKey(ta) {
    const v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
    const before = v.slice(lineStart(v, s), s);
    const indent = /^[ \t]*/.exec(before)?.[0] ?? '';
    const isPy = langOf(active ?? '')[0] === 'py';
    const opens = /[{[(]\s*$/.test(before) || (isPy && /:\s*$/.test(before)) || (endsWithOpenTag(before) && v.slice(en).startsWith('</'));
    const extra = opens ? INDENT : '';
    // Between a pair like {|} the closing half moves to its own line.
    if (opens && /^\s*[}\])<]/.test(v.slice(en, lineEnd(v, en))))
        replaceRange(ta, s, en, `\n${indent}${extra}\n${indent}`, s + 1 + indent.length + extra.length);
    else
        replaceRange(ta, s, en, `\n${indent}${extra}`);
}
const plainKey = (e) => !e.ctrlKey && !e.altKey && !e.metaKey;
// Auto-closing pairs: typing an opener adds its closer, typing the closer steps over it,
// Backspace inside an empty pair removes both, and a selection gets wrapped.
const AUTO_PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
const AUTO_CLOSERS = new Set(Object.values(AUTO_PAIRS));
function pairKey(e, ta) {
    if (!plainKey(e) || e.isComposing)
        return false;
    const v = ta.value, s = ta.selectionStart, en = ta.selectionEnd, ch = e.key;
    if (ch === 'Backspace') {
        if (s !== en || s === 0 || AUTO_PAIRS[v[s - 1]] !== v[s])
            return false;
        replaceRange(ta, s - 1, s + 1, '', s - 1);
        return true;
    }
    if (ch.length !== 1)
        return false;
    if (s === en && AUTO_CLOSERS.has(ch) && v[s] === ch) {
        ta.setSelectionRange(s + 1, s + 1);
        updateCaret();
        return true;
    }
    const close = AUTO_PAIRS[ch];
    if (!close)
        return false;
    if (s !== en) {
        replaceRange(ta, s, en, ch + v.slice(s, en) + close, s + 1, en + 1);
        return true;
    }
    const prev = v[s - 1] ?? '', next = v[s] ?? '';
    // Quotes after a letter are apostrophes (don't), and a pair only opens before a space, a closer or punctuation.
    if (ch === close && (/[\w\\]/.test(prev) || prev === ch))
        return false;
    if (next && !/[\s)\]};,:.>]/.test(next))
        return false;
    replaceRange(ta, s, en, ch + close, s + 1);
    return true;
}
function editorKeys(e) {
    const ta = e.target;
    const b = textareaOwner.get(ta);
    const k = e.key.toLowerCase();
    if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter')) {
        lastUserTypeAt = Date.now();
        sfx.play('key');
    }
    if (suggestKeys(e, ta))
        return;
    if (b && pairKey(e, ta)) {
        e.preventDefault();
        return;
    }
    if (b && e.ctrlKey && e.key === ' ') {
        e.preventDefault();
        editorSuggest(b, true);
        return;
    }
    if (b && (e.ctrlKey || e.metaKey) && !e.altKey && (k === 'z' || k === 'y')) {
        const isUndo = k === 'z' && !e.shiftKey;
        if (isUndo) {
            const topAction = actionUndoStack[actionUndoStack.length - 1];
            const isRecentTreeAction = topAction && topAction.type.startsWith('tree-') &&
                (topAction.timestamp ?? 0) > (lastUserTypeAt || 0);
            if (isRecentTreeAction) {
                e.preventDefault();
                void undoAppAction();
                return;
            }
            if (b.undo.length > 0) {
                e.preventDefault();
                stepHistory(b, true);
                return;
            }
            if (actionUndoStack.length > 0) {
                e.preventDefault();
                void undoAppAction();
                return;
            }
            e.preventDefault();
            return;
        }
        else {
            const topRedo = actionRedoStack[actionRedoStack.length - 1];
            const isRecentTreeRedo = topRedo && topRedo.type.startsWith('tree-');
            if (isRecentTreeRedo) {
                e.preventDefault();
                void redoAppAction();
                return;
            }
            if (b.redo.length > 0) {
                e.preventDefault();
                stepHistory(b, false);
                return;
            }
            if (actionRedoStack.length > 0) {
                e.preventDefault();
                void redoAppAction();
                return;
            }
            e.preventDefault();
            return;
        }
    }
    else if (e.key === 'Tab' && plainKey(e)) {
        e.preventDefault();
        indentKey(ta, e.shiftKey);
    }
    else if (e.key === 'Enter' && plainKey(e) && !e.shiftKey) {
        e.preventDefault();
        enterKey(ta);
    }
}
// Removes one comment marker pair from a line, keeping its indentation.
function uncommentLine(l, open, close) {
    const indent = l.length - l.trimStart().length;
    let body = l.slice(indent);
    if (body.startsWith(open))
        body = body.slice(open.length).replace(/^ /, '');
    const trimmed = body.trimEnd();
    if (close && trimmed.endsWith(close))
        body = trimmed.slice(0, -close.length).replace(/ $/, '');
    return l.slice(0, indent) + body;
}
function toggleComment() {
    const b = activeText();
    if (!b)
        return;
    const c = COMMENT[langOf(b.path)[0]];
    if (!c) {
        toast('No comment syntax for this file type');
        return;
    }
    const ta = b.ta;
    const [ls, le] = selectedLines(ta);
    const lines = ta.value.slice(ls, le).split('\n');
    const [open, close] = c;
    const [o, cl] = [open.trim(), close.trim()];
    const isCommented = (l) => !l.trim() || (l.trimStart().startsWith(o) && (!cl || l.trimEnd().endsWith(cl)));
    const uncomment = lines.every(isCommented) && lines.some(l => l.trim());
    const minIndent = Math.min(...lines.filter(l => l.trim()).map(l => l.length - l.trimStart().length));
    const out = lines.map(l => {
        if (!l.trim())
            return l;
        return uncomment ? uncommentLine(l, o, cl) : l.slice(0, minIndent) + open + l.slice(minIndent) + close;
    }).join('\n');
    replaceRange(ta, ls, le, out, ls, ls + out.length);
}
function moveLines(dir) {
    const b = activeText();
    if (!b)
        return;
    const ta = b.ta, v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
    const [ls, le] = selectedLines(ta);
    const block = v.slice(ls, le);
    if (dir < 0) {
        if (ls === 0)
            return;
        const pls = lineStart(v, ls - 1);
        const prev = v.slice(pls, ls - 1);
        replaceRange(ta, pls, le, `${block}\n${prev}`, s - prev.length - 1, en - prev.length - 1);
    }
    else {
        if (le >= v.length)
            return;
        const nle = lineEnd(v, le + 1);
        const next = v.slice(le + 1, nle);
        replaceRange(ta, ls, nle, `${next}\n${block}`, s + next.length + 1, en + next.length + 1);
    }
}
function duplicateLines() {
    const b = activeText();
    if (!b)
        return;
    const ta = b.ta, s = ta.selectionStart, en = ta.selectionEnd;
    const [ls, le] = selectedLines(ta);
    const block = ta.value.slice(ls, le);
    replaceRange(ta, le, le, `\n${block}`, s + block.length + 1, en + block.length + 1);
}
function selectLine() {
    const b = activeText();
    if (!b)
        return;
    const [ls, le] = selectedLines(b.ta);
    b.ta.focus();
    b.ta.setSelectionRange(ls, Math.min(le + 1, b.ta.value.length));
    updateCaret();
}
/* ----- Find in file ----- */
let findOpen = false;
let findHits = [];
let findIdx = -1;
let findLen = 0;
const findInput = $('#findInput');
function openFind() {
    const b = activeText();
    if (!b)
        return;
    const sel = b.ta.value.slice(b.ta.selectionStart, b.ta.selectionEnd);
    if (sel && !sel.includes('\n'))
        findInput.value = sel;
    findOpen = true;
    $('#findbar').classList.remove('hidden');
    findInput.focus();
    findInput.select();
    runFind(true);
}
function closeFind() {
    if (!findOpen)
        return;
    findOpen = false;
    findHits = [];
    findLen = 0;
    $('#findbar').classList.add('hidden');
    renderCode();
}
function runFind(jump) {
    const b = activeText();
    const q = findInput.value;
    findHits = [];
    findLen = q.length;
    if (b && q) {
        const hay = b.text.toLowerCase(), n = q.toLowerCase();
        for (let i = hay.indexOf(n); i !== -1 && findHits.length < 20000; i = hay.indexOf(n, i + n.length))
            findHits.push(i);
    }
    const from = b ? b.ta.selectionStart : 0;
    findIdx = findHits.length ? Math.max(0, findHits.findIndex(h => h >= from)) : -1;
    if (findIdx === -1 && findHits.length)
        findIdx = 0;
    if (jump)
        selectHit();
    else {
        renderFindCount();
        queueRender();
    }
}
function renderFindCount() {
    let text = '';
    if (findInput.value)
        text = findHits.length ? `${findIdx + 1} of ${findHits.length}` : 'No results';
    $('#findCount').textContent = text;
}
function stepFind(d) {
    if (!findHits.length)
        return;
    findIdx = (findIdx + d + findHits.length) % findHits.length;
    selectHit();
}
function selectHit() {
    const b = activeText();
    renderFindCount();
    if (b && findIdx >= 0) {
        const off = findHits[findIdx];
        b.ta.setSelectionRange(off, off + findLen);
        revealOffset(b, off);
    }
    renderCode();
}
findInput.addEventListener('input', () => runFind(true));
findInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
        e.preventDefault();
        sfx.play('tick');
        stepFind(e.shiftKey ? -1 : 1);
    }
    if (e.key === 'Escape') {
        e.stopPropagation();
        closeFind();
        activeText()?.ta.focus();
    }
});
$('#findNext').onclick = () => { sfx.play('tick'); stepFind(1); };
$('#findPrev').onclick = () => { sfx.play('tick'); stepFind(-1); };
$('#findClose').onclick = () => { closeFind(); activeText()?.ta.focus(); };
/* ----- Go to line / file ----- */
function goToLine() {
    const b = activeText();
    if (!b) {
        toast('Open a file first');
        return;
    }
    const total = b.text.split('\n').length;
    openModal(`<input class="input w-full" id="lineIn" aria-label="Line number" placeholder="Go to line (1 – ${total})" inputmode="numeric">`, m => {
        const input = $('#lineIn', m);
        input.focus();
        input.onkeydown = e => {
            if (e.key !== 'Enter')
                return;
            const n = clamp(Number.parseInt(input.value, 10) || 1, 1, total);
            closeModal();
            const off = offsetOf(b.text, n - 1, 0);
            b.ta.focus();
            b.ta.setSelectionRange(off, off);
            revealOffset(b, off);
        };
    }, undefined, 'top');
}
// How well a path matches a quick-open query: name prefix > name > path > letters in order.
function fileScore(p, q) {
    const name = baseName(p).toLowerCase(), full = p.toLowerCase();
    if (!q)
        return 1;
    if (name.startsWith(q))
        return 4;
    if (name.includes(q))
        return 3;
    if (full.includes(q))
        return 2;
    let i = 0;
    for (const ch of full)
        if (ch === q[i])
            i++;
    return i === q.length ? 1 : 0;
}
function quickOpen() {
    if (!rootInfo) {
        toast('Open a folder first');
        return;
    }
    let all = [];
    let sel = 0;
    let shown = [];
    openModal(`<input class="input w-full" id="qoIn" aria-label="Search files by name" placeholder="Search files by name" spellcheck="false"><div class="qo-list" id="qoList"><div class="side-note">Loading…</div></div>`, m => {
        const input = $('#qoIn', m);
        input.focus();
        const render = () => {
            const q = input.value.trim().toLowerCase();
            shown = all.map(p => [p, fileScore(p, q)]).filter(x => x[1] > 0)
                .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).slice(0, 60).map(x => x[0]);
            sel = clamp(sel, 0, Math.max(0, shown.length - 1));
            const rows = shown.map((p, i) => `<div class="qo-item ${i === sel ? 'on' : ''}" data-i="${i}"><span>${fileIcon(baseName(p))}&nbsp; ${esc(baseName(p))}</span><small>${esc(dirName(p))}</small></div>`);
            $('#qoList', m).innerHTML = rows.join('') || '<div class="side-note">No matching files.</div>';
            $$('[data-i]', m).forEach(el => el.onclick = () => { closeModal(); openFile(shown[Number(el.dataset.i)]); });
        };
        input.oninput = () => { sel = 0; render(); };
        input.onkeydown = e => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                sel += e.key === 'ArrowDown' ? 1 : -1;
                render();
                $('.qo-item.on', m)?.scrollIntoView({ block: 'nearest' });
            }
            if (e.key === 'Enter' && shown[sel]) {
                closeModal();
                openFile(shown[sel]);
            }
        };
        api.fs.listFiles().then(list => { all = list; render(); }, (err) => { $('#qoList', m).innerHTML = `<div class="side-note">${esc(errMsg(err))}</div>`; });
    }, undefined, 'top');
}
/* ================= Search across files ================= */
let searchCase = false;
$('#searchCase').onclick = () => { searchCase = !searchCase; $('#searchCase').classList.toggle('on', searchCase); void runSearch(); };
$('#searchInput').addEventListener('keydown', e => { if (e.key === 'Enter')
    void runSearch(); });
function hitLineHtml(h, i, qLen) {
    const start = Math.max(0, h.col - 30);
    const pre = h.text.slice(start, h.col).trimStart(), hit = h.text.slice(h.col, h.col + qLen), post = h.text.slice(h.col + qLen, h.col + qLen + 80);
    return `<div class="result-line" data-p="${escAttr(h.path)}" data-i="${i}">${esc(pre)}<mark>${esc(hit)}</mark>${esc(post)}</div>`;
}
async function runSearch() {
    const q = $('#searchInput').value;
    const out = $('#searchResults');
    if (!rootInfo) {
        out.innerHTML = '<p class="side-note">Open a folder to search it.</p>';
        return;
    }
    if (!q) {
        out.innerHTML = '<p class="side-note">Type and press Enter to search across files.</p>';
        return;
    }
    out.innerHTML = '<p class="side-note">Searching…</p>';
    let hits;
    try {
        hits = await api.fs.search(q, searchCase);
    }
    catch (e) {
        out.innerHTML = `<p class="side-note">${esc(errMsg(e))}</p>`;
        return;
    }
    if (!hits.length) {
        out.innerHTML = '<p class="side-note">No results.</p>';
        return;
    }
    const byFile = new Map();
    for (const h of hits)
        byFile.set(h.path, [...(byFile.get(h.path) ?? []), h]);
    const more = hits.length >= 500 ? '+' : '';
    const groups = [...byFile].map(([p, hs]) => `<div class="result-file">${fileIcon(baseName(p))} ${esc(baseName(p))} <small>${esc(dirName(p))}</small></div>` + hs.map((h, i) => hitLineHtml(h, i, q.length)).join(''));
    out.innerHTML = `<p class="side-note pt-0">${hits.length}${more} results in ${plural(byFile.size, 'file')}</p>` + groups.join('');
    $$('.result-line', out).forEach(el => el.onclick = () => {
        const h = (byFile.get(el.dataset.p) ?? [])[Number(el.dataset.i)];
        if (h)
            openFile(h.path, { line: h.line, col: h.col, len: q.length });
    });
}
/* ================= Preview ================= */
let running = false;
let previewPath = null;
const frame = $('#previewFrame');
frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
function isHtml(p) { return !!p && /\.html?$/i.test(p); }
// The page Preview opens by default: the open HTML file, else the project's index.html.
function previewTarget() {
    if (isHtml(active))
        return active;
    return (dirCache.get('') ?? []).find(e => !e.dir && /^index\.html?$/i.test(e.name))?.name ?? null;
}
function renderPreview() {
    $('#previewEmpty').classList.toggle('hidden', running);
    frame.classList.toggle('hidden', !running);
    if (!running) {
        $('#urlText').textContent = 'Not running';
        frame.removeAttribute('src');
        frame.removeAttribute('srcdoc');
    }
    renderPreviewEmpty();
}
// With an HTML page in the project, the empty preview offers a button for it instead of a key to remember.
function renderPreviewEmpty() {
    const target = rootInfo ? previewTarget() : null;
    const hint = $('#previewHint');
    hint.innerHTML = target
        ? `<button class="btn btn-primary btn-sm" data-preview-file="1">${svgIcon('play', 12)} Preview ${esc(baseName(target))}</button>`
        : 'Add an <b>index.html</b> to preview it here.';
}
$('#previewEmpty').addEventListener('click', e => {
    if (!e.target.closest('[data-preview-file]'))
        return;
    const target = previewTarget();
    if (target)
        void startPreview(target);
});
async function startPreview(path) {
    if (!rootInfo) {
        toast('Open a folder first');
        return;
    }
    const target = path ?? previewTarget();
    if (!target) {
        toast('Add an index.html (or open an .html file) to preview it');
        return;
    }
    previewPath = target;
    if (!running)
        sfx.play('launch');
    running = true;
    layout.previewOpen = true;
    applyLayout();
    renderPreview();
    await reloadPreview();
}
async function reloadPreview() {
    if (!running || !previewPath)
        return;
    const url = await api.fs.previewUrl(previewPath).catch(() => '');
    if (url) {
        $('#urlText').textContent = previewPath;
        frame.removeAttribute('srcdoc');
        frame.src = `${url}?t=${Date.now()}`;
    }
    else {
        // Browser demo: no file URLs, so inline the saved HTML.
        const r = await api.fs.readFile(previewPath).catch(() => null);
        $('#urlText').textContent = previewPath;
        frame.srcdoc = (r?.text ?? '') + '<style>html,body{scrollbar-width:none}::-webkit-scrollbar{display:none}</style>';
    }
}
function stopPreview() { running = false; previewPath = null; renderPreview(); }
let nextTermSessionId = 1;
const termSessions = [];
let activeTermSession = null;
const termOut = $('#termOut');
const termInput = $('#termInput');
const termGhost = $('#termGhost'); // declared before the first session is made below, which clears it
// Backward-compatibility proxy for code accessing single 'term'
const term = {
    get cwd() { return activeTermSession?.cwd ?? ''; },
    set cwd(v) { if (activeTermSession)
        activeTermSession.cwd = v; },
    get proc() { return activeTermSession?.proc ?? null; },
    set proc(v) { if (activeTermSession)
        activeTermSession.proc = v; },
    get runId() { return activeTermSession?.runId ?? null; },
    set runId(v) { if (activeTermSession)
        activeTermSession.runId = v; },
    get history() { return activeTermSession?.history ?? store.get('breeze.termHistory', []); },
    set history(v) { if (activeTermSession)
        activeTermSession.history = v; },
    get hIdx() { return activeTermSession?.hIdx ?? 0; },
    set hIdx(v) { if (activeTermSession)
        activeTermSession.hIdx = v; },
    get runCwd() { return activeTermSession?.runCwd ?? ''; },
    set runCwd(v) { if (activeTermSession)
        activeTermSession.runCwd = v; },
    get pending() { return activeTermSession?.pending ?? null; },
    set pending(v) { if (activeTermSession)
        activeTermSession.pending = v; },
    get refs() { return activeTermSession?.refs ?? []; },
    set refs(v) { if (activeTermSession)
        activeTermSession.refs = v; },
};
function createPromptHtml(cwd) {
    let path = cwd || '~';
    path = path.replaceAll('/', '\\');
    path = path.replace(/^([a-zA-Z]):/, (_, d) => d.toUpperCase() + ':');
    return `<span class="ps-prefix">PS</span> <span class="ps-path" title="${escAttr(cwd || '~')}">${esc(path)}</span><span class="ps-arrow">&gt;</span>`;
}
function renderPs() {
    const el = $('#termPs');
    if (el)
        el.innerHTML = createPromptHtml(term.cwd);
}
function createPromptElement(cwd) {
    const span = document.createElement('span');
    span.className = 'ps term-prompt-line';
    span.innerHTML = createPromptHtml(cwd);
    return span;
}
let termScrollRaf = 0;
function scheduleTermScroll() {
    if (termScrollRaf)
        return;
    termScrollRaf = requestAnimationFrame(() => {
        termScrollRaf = 0;
        const b = $('#termBody');
        if (b)
            b.scrollTop = b.scrollHeight;
    });
}
function activateTermSession(id) {
    const session = termSessions.find(s => s.id === id);
    if (!session)
        return;
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
    }
    else {
        $('#termPs').classList.remove('busy');
    }
    renderTermTabs();
    scheduleTermScroll();
    termInput.focus();
}
// The first free name: "Terminal", then "Terminal 2", "Terminal 3"… reusing numbers of closed ones.
function nextTermName() {
    const used = new Set(termSessions.map(s => s.name));
    if (!used.has('Terminal'))
        return 'Terminal';
    let n = 2;
    while (used.has(`Terminal ${n}`))
        n++;
    return `Terminal ${n}`;
}
function createTermSession(name) {
    const id = nextTermSessionId++;
    const sessionName = name || nextTermName();
    let paneEl;
    const initialPane = $('#termOut');
    if (id === 1 && initialPane) {
        paneEl = initialPane;
    }
    else {
        paneEl = document.createElement('div');
        paneEl.className = 'term-out-pane';
        const termLine = $('.term-line', $('#termBody'));
        if (termLine) {
            $('#termBody').insertBefore(paneEl, termLine);
        }
        else {
            $('#termBody').appendChild(paneEl);
        }
    }
    const session = {
        id,
        name: sessionName,
        cwd: activeTermSession?.cwd || (rootInfo?.root ?? ''),
        proc: null,
        runId: null,
        history: [...store.get('breeze.termHistory', [])],
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
function closeTermSession(id, e) {
    if (e) {
        e.stopPropagation();
        e.preventDefault();
    }
    const idx = termSessions.findIndex(s => s.id === id);
    if (idx < 0)
        return;
    const session = termSessions[idx];
    if (session.proc != null) {
        background(api.term.kill(session.proc));
    }
    if (session.paneEl && session.paneEl !== $('#termOut')) {
        session.paneEl.remove();
    }
    else if (session.paneEl === $('#termOut')) {
        session.paneEl.innerHTML = '';
    }
    termSessions.splice(idx, 1);
    if (termSessions.length === 0) {
        createTermSession();
    }
    else if (activeTermSession?.id === id) {
        const nextIdx = Math.min(idx, termSessions.length - 1);
        activateTermSession(termSessions[nextIdx].id);
    }
    else {
        renderTermTabs();
    }
}
const TERM_TAB_ANIM_MS = 220;
// Same X as the agent tabs' close button
const TAB_CLOSE_SVG = '<svg class="tab-close-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
function buildTermTab(s) {
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
        if (e.target.closest('.term-tab-close') || tab.classList.contains('leaving'))
            return;
        activateTermSession(s.id);
    };
    return tab;
}
function renderTermTabs() {
    const tabsContainer = $('#termTabs');
    if (!tabsContainer)
        return;
    // With one terminal the lone tab sheds its dot, chip and close button ("solo") and reads like a plain title;
    // from two on it grows them back.
    const many = termSessions.length > 1;
    const firstRender = !tabsContainer.dataset.ready;
    const wasHidden = firstRender;
    const existing = new Map();
    for (const el of $$('.term-tab', tabsContainer)) {
        if (!el.classList.contains('leaving'))
            existing.set(Number(el.dataset.tid), el);
    }
    const liveIds = new Set(termSessions.map(s => s.id));
    // Collapse out tabs whose session is gone
    let anyLeaving = false;
    for (const [tid, el] of existing) {
        if (liveIds.has(tid))
            continue;
        existing.delete(tid);
        if (wasHidden) {
            el.remove();
            continue;
        }
        anyLeaving = true;
        el.classList.remove('enter');
        el.style.width = `${el.getBoundingClientRect().width}px`;
        void el.offsetWidth;
        el.classList.add('leaving');
        let done = false;
        const finish = () => { if (done) {
            return;
        } done = true; el.remove(); };
        el.addEventListener('transitionend', e => { if (e.target === el && e.propertyName === 'width')
            finish(); });
        setTimeout(finish, TERM_TAB_ANIM_MS + 80);
    }
    // Add / update live tabs in session order (leaving tabs stay where they were while they collapse)
    let prev = null;
    for (const s of termSessions) {
        let tab = existing.get(s.id);
        if (!tab) {
            tab = buildTermTab(s);
            if (many) {
                tab.classList.add('enter');
                tab.addEventListener('animationend', () => tab.classList.remove('enter'), { once: true });
            }
            if (prev)
                prev.after(tab);
            else
                tabsContainer.prepend(tab);
        }
        tab.classList.toggle('active', s.id === activeTermSession?.id);
        tab.classList.toggle('busy', s.proc != null);
        tab.title = `${s.name}${s.proc != null ? ' (running)' : ''}`;
        const title = $('.term-tab-title', tab);
        if (title && title.textContent !== s.name)
            title.textContent = s.name;
        prev = tab;
    }
    if (firstRender) {
        // Settle into the initial state without animating
        tabsContainer.dataset.ready = '1';
        tabsContainer.classList.add('no-morph');
        tabsContainer.classList.remove('hidden');
        $('#termTitleText')?.classList.add('hidden');
        tabsContainer.classList.toggle('solo', !many);
        void tabsContainer.offsetWidth;
        tabsContainer.classList.remove('no-morph');
        return;
    }
    // 2 → 1 sheds the dot / chip / X while the closed tab collapses; 1 → 2 grows them back
    tabsContainer.classList.toggle('solo', !many);
    // Keep the active tab in view when the strip is squeezed and scrolls
    updateTermTabsTight();
    const activeEl = tabsContainer.querySelector('.term-tab.active:not(.leaving)');
    if (many && activeEl && tabsContainer.scrollWidth > tabsContainer.clientWidth) {
        requestAnimationFrame(() => activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }));
    }
}
// Drops the dot and trims padding only when the tabs genuinely can't fit at their normal minimum
function updateTermTabsTight() {
    const el = $('#termTabs');
    if (!el)
        return;
    if (el.classList.contains('solo')) {
        el.classList.remove('tight');
        return;
    }
    const wasTight = el.classList.contains('tight');
    el.classList.add('no-morph');
    el.classList.remove('tight');
    const overflow = el.scrollWidth > el.clientWidth + 1;
    el.classList.toggle('tight', overflow);
    void el.offsetWidth;
    el.classList.remove('no-morph');
    if (wasTight !== overflow) {
        // Re-run once the class change has settled so the transition plays from the right state
        el.classList.toggle('tight', wasTight);
        void el.offsetWidth;
        el.classList.toggle('tight', overflow);
    }
}
{
    const ro = new ResizeObserver(() => updateTermTabsTight());
    const head = $('#termToggle');
    if (head)
        ro.observe(head);
}
// Squeezed terminal tabs scroll sideways with the mouse wheel
$('#termTabs')?.addEventListener('wheel', e => {
    const el = e.currentTarget;
    if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY))
        return;
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
function projectPath(p, cwd, root) {
    const slash = (x) => x.replaceAll('\\', '/');
    const parts = (x) => { const out = []; for (const seg of slash(x).split('/')) {
        if (seg === '..')
            out.pop();
        else if (seg && seg !== '.')
            out.push(seg);
    } return out; };
    const given = slash(p);
    const full = parts(/^(?:[A-Za-z]:)?\//.test(given) ? given : `${slash(cwd)}/${given}`);
    const base = parts(root);
    const same = (a, b) => (/^[A-Za-z]:/.test(base[0] ?? '') ? a.toLowerCase() === b.toLowerCase() : a === b);
    if (full.length <= base.length || !base.every((seg, i) => same(seg, full[i])))
        return null;
    return full.slice(base.length).join('/');
}
function parseErrorRefs(text, cwd, root) {
    const refs = [];
    for (const m of text.matchAll(GCC_REF)) {
        const path = projectPath(m[1], cwd, root);
        if (path == null)
            continue;
        const end = m.index + m[1].length + 1 + m[2].length + (m[3] ? m[3].length + 1 : 0);
        refs.push({ path, line: Number(m[2]) - 1, col: m[3] ? Number(m[3]) - 1 : 0, msg: m[5].replace(/\r$/, ''), error: m[4] !== 'warning' && m[4] !== 'note', start: m.index, end });
    }
    for (const m of text.matchAll(CS_REF)) {
        const path = projectPath(m[1], cwd, root);
        if (path == null)
            continue;
        const start = m.index + m[0].indexOf(m[1]);
        const end = start + m[1].length + m[2].length + m[3].length + 3; // through "(line,col)"
        refs.push({ path, line: Number(m[2]) - 1, col: Number(m[3]) - 1, msg: `${m[5]}: ${m[6]}`, error: m[4] === 'error', start, end });
    }
    for (const m of text.matchAll(PY_REF)) {
        const path = projectPath(m[2], cwd, root);
        if (path == null)
            continue;
        const start = m.index + m[0].indexOf(m[1]);
        refs.push({ path, line: Number(m[3]) - 1, col: 0, msg: 'Python error (see the terminal)', error: false, start, end: start + m[1].length });
    }
    for (const m of text.matchAll(RS_REF)) {
        if (m[1]) {
            rustHead = { error: m[1] === 'error', msg: m[2] };
            continue;
        }
        const path = projectPath(m[3], cwd, root);
        if (path == null)
            continue;
        const start = m.index + m[0].indexOf(m[3]);
        const end = start + m[3].length + m[4].length + m[5].length + 2; // through ":line:col"
        refs.push({ path, line: Number(m[4]) - 1, col: Number(m[5]) - 1, msg: rustHead.msg || 'Rust error (see the terminal)', error: rustHead.error, start, end });
    }
    return refs.sort((a, b) => a.start - b.start);
}
// 256-color palette mapper
function ansi256Color(n) {
    if (n < 0 || n > 255)
        return '#ffffff';
    const std16 = [
        '#1f2335', '#f7768e', '#73daca', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5',
        '#565f89', '#ff899d', '#9ece6a', '#f1cf8a', '#89b4fa', '#cba6f7', '#89dceb', '#ffffff'
    ];
    if (n < 16)
        return std16[n];
    if (n < 232) {
        const idx = n - 16;
        const r = Math.floor(idx / 36);
        const g = Math.floor((idx % 36) / 6);
        const b = idx % 6;
        const toVal = (c) => c === 0 ? 0 : 55 + c * 40;
        return `rgb(${toVal(r)}, ${toVal(g)}, ${toVal(b)})`;
    }
    const gray = (n - 232) * 10 + 8;
    return `rgb(${gray}, ${gray}, ${gray})`;
}
// Plain CLI semantic output highlighter (errors, warnings, successes, URLs)
function highlightPlainCli(text) {
    let out = text;
    // npm CLI headers: "npm warn ...", "npm notice ...", "npm ERR! ..."
    out = out.replace(/\b(npm)(\s+)(warn(?:ing)?|notice|invalid|ERR!|error|info|http)\b/gi, (_m, npmWord, space, lvl) => {
        let lvlClass = 'term-kw-info';
        const lower = lvl.toLowerCase();
        if (lower.startsWith('warn'))
            lvlClass = 'term-kw-warning';
        else if (lower === 'notice' || lower === 'invalid' || lower === 'http')
            lvlClass = 'term-kw-cyan';
        else if (lower === 'err!' || lower === 'error')
            lvlClass = 'term-kw-error';
        return `<span class="term-npm">${npmWord}</span>${space}<span class="${lvlClass}">${lvl}</span>`;
    });
    // Secondary keywords: standalone or subsequent "invalid", "notice", "http"
    out = out.replace(/\b(?:invalid|notice|http)\b(?![^<]*>)/gi, '<span class="term-kw-cyan">$&</span>');
    // General warning / error / success tokens
    out = out.replace(/\b(?:FATAL|FAIL|ERROR|Error|ERR!|error|fatal error)\b:?(?![^<]*>)/g, '<span class="term-kw-error">$&</span>');
    out = out.replace(/\b(?:WARN|WARNING|Warning|warning|warn)\b:?(?![^<]*>)/g, '<span class="term-kw-warning">$&</span>');
    out = out.replace(/(?:\b(?:SUCCESS|SUCCESSFUL|PASS|passed|compiled successfully|Done in)\b|✓)(?![^<]*>)/g, '<span class="term-kw-success">$&</span>');
    out = out.replace(/\b(?:INFO|Info|NOTE|Note|note|info)\b:?(?![^<]*>)/g, '<span class="term-kw-info">$&</span>');
    out = out.replace(/(https?:\/\/[^\s<>"'`)]+)/g, '<a class="term-url" href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    return out;
}
function renderAnsiChunk(text, style) {
    const classes = [];
    if (style.fgClass)
        classes.push(style.fgClass);
    if (style.bgClass)
        classes.push(style.bgClass);
    if (style.bold)
        classes.push('ansi-bold');
    if (style.dim)
        classes.push('ansi-dim');
    if (style.italic)
        classes.push('ansi-italic');
    if (style.underline)
        classes.push('ansi-underline');
    const styles = [];
    if (style.fgColor)
        styles.push(`color:${style.fgColor}`);
    if (style.bgColor)
        styles.push(`background-color:${style.bgColor}`);
    const escaped = esc(text);
    if (!classes.length && !styles.length) {
        return highlightPlainCli(escaped);
    }
    const clsAttr = classes.length ? ` class="${classes.join(' ')}"` : '';
    const styleAttr = styles.length ? ` style="${styles.join(';')}"` : '';
    return `<span${clsAttr}${styleAttr}>${escaped}</span>`;
}
function parseAnsiToHtml(raw) {
    const text = raw.replaceAll(/\x1b\[[0-9;?]*[ -/]*[@-ln-~]/g, '').replaceAll(/\r(?!\n)/g, '');
    if (!text)
        return '';
    if (!text.includes('\x1b[')) {
        return highlightPlainCli(esc(text));
    }
    const SGR_REGEX = /\x1b\[([0-9;]*)m/g;
    let html = '';
    let lastIndex = 0;
    const style = {};
    const colorNames = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
    let match;
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
                style.fgClass = undefined;
                style.fgColor = undefined;
                style.bgClass = undefined;
                style.bgColor = undefined;
                style.bold = false;
                style.dim = false;
                style.italic = false;
                style.underline = false;
            }
            else if (code === 1) {
                style.bold = true;
            }
            else if (code === 2) {
                style.dim = true;
            }
            else if (code === 3) {
                style.italic = true;
            }
            else if (code === 4) {
                style.underline = true;
            }
            else if (code === 22) {
                style.bold = false;
                style.dim = false;
            }
            else if (code === 23) {
                style.italic = false;
            }
            else if (code === 24) {
                style.underline = false;
            }
            else if (code >= 30 && code <= 37) {
                style.fgClass = `ansi-fg-${colorNames[code - 30]}`;
                style.fgColor = undefined;
            }
            else if (code === 38) {
                if (rawCodes[i + 1] === 5 && rawCodes[i + 2] != null) {
                    style.fgColor = ansi256Color(rawCodes[i + 2]);
                    style.fgClass = undefined;
                    i += 2;
                }
                else if (rawCodes[i + 1] === 2 && rawCodes[i + 2] != null && rawCodes[i + 3] != null && rawCodes[i + 4] != null) {
                    style.fgColor = `rgb(${rawCodes[i + 2]}, ${rawCodes[i + 3]}, ${rawCodes[i + 4]})`;
                    style.fgClass = undefined;
                    i += 4;
                }
            }
            else if (code === 39) {
                style.fgClass = undefined;
                style.fgColor = undefined;
            }
            else if (code >= 40 && code <= 47) {
                style.bgClass = `ansi-bg-${colorNames[code - 40]}`;
                style.bgColor = undefined;
            }
            else if (code === 48) {
                if (rawCodes[i + 1] === 5 && rawCodes[i + 2] != null) {
                    style.bgColor = ansi256Color(rawCodes[i + 2]);
                    style.bgClass = undefined;
                    i += 2;
                }
                else if (rawCodes[i + 1] === 2 && rawCodes[i + 2] != null && rawCodes[i + 3] != null && rawCodes[i + 4] != null) {
                    style.bgColor = `rgb(${rawCodes[i + 2]}, ${rawCodes[i + 3]}, ${rawCodes[i + 4]})`;
                    style.bgClass = undefined;
                    i += 4;
                }
            }
            else if (code === 49) {
                style.bgClass = undefined;
                style.bgColor = undefined;
            }
            else if (code >= 90 && code <= 97) {
                style.fgClass = `ansi-fg-bright-${colorNames[code - 90]}`;
                style.fgColor = undefined;
            }
            else if (code >= 100 && code <= 107) {
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
function formatCommandSyntax(cmd) {
    if (!cmd)
        return '';
    const trimmed = cmd.trimStart();
    const leading = cmd.slice(0, cmd.length - trimmed.length);
    const tokenRegex = /--?[a-zA-Z0-9_-]+|"[^"]*"|'[^']*'|\S+/g;
    let match;
    let lastIndex = 0;
    let isFirst = true;
    let html = esc(leading);
    while ((match = tokenRegex.exec(trimmed)) !== null) {
        const gap = trimmed.slice(lastIndex, match.index);
        if (gap)
            html += esc(gap);
        const token = match[0];
        if (isFirst) {
            html += `<span class="term-cmd-name">${esc(token)}</span>`;
            isFirst = false;
        }
        else if (token.startsWith('-')) {
            html += `<span class="term-cmd-flag">${esc(token)}</span>`;
        }
        else if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
            html += `<span class="term-cmd-str">${esc(token)}</span>`;
        }
        else if (/^\d+$/.test(token)) {
            html += `<span class="term-cmd-num">${esc(token)}</span>`;
        }
        else {
            html += `<span class="term-cmd-arg">${esc(token)}</span>`;
        }
        lastIndex = tokenRegex.lastIndex;
    }
    const trailing = trimmed.slice(lastIndex);
    if (trailing)
        html += esc(trailing);
    return html;
}
const cleanOut = (text) => text.replaceAll(ANSI, '').replaceAll(/\r(?!\n)/g, '');
function termAppend(el, session = activeTermSession) {
    const pane = session?.paneEl || termOut;
    pane.appendChild(el);
    while (pane.childNodes.length > 3000)
        pane.firstChild?.remove();
    if (session === activeTermSession)
        scheduleTermScroll();
}
function termWrite(text, cls = '', session = activeTermSession) {
    const target = session || activeTermSession;
    const span = document.createElement('span');
    if (cls)
        span.className = cls;
    span.innerHTML = parseAnsiToHtml(text);
    if (target)
        target.pending = null; // anything written here ends the run's open line
    termAppend(span, target);
    return span;
}
// A run's output: finished lines show their error locations as links; the unfinished last line stays
// plain (a prompt like "Name: " has no newline) and is swapped for the linked version once it ends.
function runOutput(chunk, session = activeTermSession) {
    const target = session || activeTermSession;
    const full = (target?.pending?.text ?? '') + chunk;
    target?.pending?.el.remove();
    if (target)
        target.pending = null;
    const nl = full.lastIndexOf('\n');
    if (nl >= 0)
        termLinked(full.slice(0, nl + 1), target);
    const rest = full.slice(nl + 1);
    if (rest && target)
        target.pending = { el: termWrite(rest, '', target), text: rest }; // termWrite cleared `pending`; set it after
}
function termLinked(text, session = activeTermSession) {
    const target = session || activeTermSession;
    const refs = rootInfo && target ? parseErrorRefs(text, target.runCwd, rootInfo.root) : [];
    if (target)
        target.refs.push(...refs.filter(r => r.error));
    const span = document.createElement('span');
    let at = 0;
    for (const r of refs) {
        if (r.start < at)
            continue;
        if (r.start > at) {
            const chunkSpan = document.createElement('span');
            chunkSpan.innerHTML = parseAnsiToHtml(text.slice(at, r.start));
            span.append(chunkSpan);
        }
        const a = document.createElement('a');
        a.className = 'term-ref';
        a.textContent = cleanOut(text.slice(r.start, r.end));
        a.dataset.path = r.path;
        a.dataset.line = String(r.line);
        a.dataset.col = String(r.col);
        span.append(a);
        at = r.end;
    }
    if (at < text.length) {
        const chunkSpan = document.createElement('span');
        chunkSpan.innerHTML = parseAnsiToHtml(text.slice(at));
        span.append(chunkSpan);
    }
    termAppend(span, target);
}
$('#termBody').addEventListener('click', e => {
    const a = e.target.closest('.term-ref');
    if (a)
        openFile(a.dataset.path, { line: Number(a.dataset.line), col: Number(a.dataset.col) });
});
// A failed run underlines its errors in the open files (next to the editor's own findings); the next run
// or the next lint of a file takes them away again.
function clearRunDiags() {
    let any = false;
    for (const b of buffers.values()) {
        if (!b.runDiags)
            continue;
        const mine = b.runDiags;
        b.diags = b.diags?.filter(d => !mine.includes(d));
        b.runDiags = undefined;
        any = true;
    }
    if (any) {
        renderTabs();
        renderCode();
    }
}
function showRunErrors(refs) {
    for (const b of buffers.values()) {
        if (b.kind !== 'text')
            continue;
        const lines = b.text.split('\n');
        const diags = b.diags ?? [];
        const add = [];
        for (const r of refs) {
            if (r.path !== b.path || r.line >= lines.length || diags.some(d => d.line === r.line) || add.some(d => d.line === r.line))
                continue;
            const lt = lines[r.line];
            const col = r.col || Math.max(0, lt.search(/\S/));
            add.push({ line: r.line, col, len: r.col ? (/^\S+/.exec(lt.slice(col))?.[0].length ?? 1) : Math.max(1, lt.trimEnd().length - col), msg: r.msg });
        }
        if (!add.length)
            continue;
        const had = diags.length > 0;
        b.diags = [...diags, ...add].sort((x, y) => x.line - y.line);
        b.runDiags = add;
        b.diagLines = lines.length;
        if (!had)
            renderTabs();
        if (b.path === active)
            renderCode();
    }
}
function killCommand() {
    const session = activeTermSession;
    if (!session || session.proc == null)
        return;
    background(api.term.kill(session.proc));
    termWrite('^C\n', '', session);
}
function termWriteCommand(cmd, session = activeTermSession) {
    const target = session || activeTermSession;
    const span = document.createElement('span');
    span.className = 'cmd';
    span.innerHTML = `${formatCommandSyntax(cmd)}\n`;
    termAppend(span, target);
}
async function runCommand(cmd) {
    const session = activeTermSession;
    if (!session)
        return;
    if (session.proc != null) {
        background(api.term.write(session.proc, cmd + '\n'));
        termWrite(cmd + '\n', 'cmd', session);
        return;
    }
    termAppend(createPromptElement(session.cwd), session);
    termWriteCommand(cmd, session);
    if (!cmd.trim())
        return;
    if (!session.history.length || session.history.at(-1) !== cmd) {
        session.history.push(cmd);
        if (session.history.length > 200)
            session.history.shift();
        store.set('breeze.termHistory', session.history);
    }
    session.hIdx = session.history.length;
    if (/^\s*(?:cls|clear)\s*$/i.test(cmd)) {
        if (session.paneEl) {
            session.paneEl.innerHTML = '';
        }
        return;
    }
    const r = await api.term.run(cmd).catch((err) => ({ error: errMsg(err) }));
    if (r.error)
        termWrite(r.error + '\n', 'err', session);
    if (r.cwd) {
        session.cwd = r.cwd;
        renderPs();
    }
    if (r.id != null) {
        session.proc = r.id;
        $('#termPs').classList.add('busy');
        renderTermTabs();
    }
}
// C, C++, C#, Java, Python and Rust files run in the terminal; their input comes from the terminal's input line.
function runnable(path) { return !!path && /\.(?:c|cpp|cc|cxx|cs|java|py|rs)$/i.test(path); }
async function runFile() {
    const b = activeBuf();
    if (!active || b?.kind !== 'text') {
        toast('Save the file first');
        return;
    }
    if (term.proc != null && term.runId == null) {
        toast('A command is still running — press Ctrl+C to stop it');
        return;
    }
    if (term.runId != null) { // a run is going: main refuses and says so; leave the running program's output and the file alone
        const busy = await api.run.file(active).catch((err) => ({ error: errMsg(err) }));
        if (busy.error)
            termWrite(busy.error + '\n', 'err');
        else if (busy.id != null) {
            term.proc = term.runId = busy.id;
            $('#termPs').classList.add('busy');
            renderTermTabs();
        } // it had just finished
        return;
    }
    if (isDirty(b) && !(await saveFile(active)))
        return;
    layout.termOpen = true;
    applyLayout();
    clearRunDiags();
    term.runCwd = joinPath(rootInfo?.root ?? '', dirName(active));
    term.refs = [];
    term.pending = null;
    rustHead = { error: true, msg: '' };
    const r = await api.run.file(active).catch((err) => ({ error: errMsg(err) }));
    if (r.cwd)
        term.runCwd = r.cwd; // a Cargo project runs from its own folder
    if (r.error)
        termWrite(r.error + '\n', 'err');
    else if (r.id != null) {
        term.proc = term.runId = r.id;
        $('#termPs').classList.add('busy');
        renderTermTabs();
        sfx.play('build');
    }
    termInput.focus();
}
termInput.addEventListener('keydown', e => {
    if (terminalAutofillKeys(e))
        return;
    if (e.key === 'c' && e.ctrlKey && term.proc != null && termInput.selectionStart === termInput.selectionEnd) {
        e.preventDefault();
        killCommand();
        return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        term.hIdx = clamp(term.hIdx + (e.key === 'ArrowUp' ? -1 : 1), 0, term.history.length);
        termInput.value = term.history[term.hIdx] ?? '';
        updateGhost();
        return;
    }
    if (e.key !== 'Enter')
        return;
    const cmd = termInput.value;
    termInput.value = '';
    termGhost.innerHTML = '';
    void runCommand(cmd);
});
api.term.onData((id, chunk) => {
    const session = termSessions.find(s => s.proc === id);
    if (!session)
        return;
    if (id === session.runId) {
        runOutput(chunk, session);
    }
    else {
        termWrite(chunk, '', session);
    }
});
api.term.onExit((id, code) => {
    const session = termSessions.find(s => s.proc === id);
    if (!session)
        return;
    const runId = session.runId;
    session.proc = null;
    session.runId = null;
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
        }
        else if (code) {
            const errDiv = document.createElement('div');
            errDiv.className = 'term-exit-err';
            errDiv.textContent = `✕ process failed with exit code ${code}`;
            termAppend(errDiv, session);
        }
    }
    if (id !== runId)
        return;
    if (code === 0)
        sfx.play('success');
    if (session.pending) {
        const rest = session.pending.text;
        session.pending.el.remove();
        session.pending = null;
        termLinked(rest, session);
    }
    if (session === activeTermSession) {
        clearRunDiags();
        if (code)
            showRunErrors(session.refs);
    }
});
$('#termBody').addEventListener('mouseup', () => { if (!getSelection()?.toString())
    termInput.focus(); });
$('#termToggle').addEventListener('click', e => { if (!e.target.closest('button, .term-tabs, .term-tab'))
    run('term.toggle'); });
let suggest = null;
const suggestEl = document.createElement('div');
suggestEl.className = 'suggest hidden';
suggestEl.setAttribute('role', 'listbox');
document.body.append(suggestEl);
// Greyed-out rest of the selected suggestion, drawn right after the editor's caret.
const editorGhost = document.createElement('span');
editorGhost.className = 'editor-ghost';
editorGhost.setAttribute('aria-hidden', 'true');
document.body.append(editorGhost);
suggestEl.addEventListener('mousedown', e => e.preventDefault()); // keep focus where the user is typing
suggestEl.addEventListener('click', e => {
    const row = e.target.closest('[data-sg]');
    if (row && suggest)
        suggest.accept(suggest.items[Number(row.dataset.sg)]);
});
function renderSuggest() {
    if (!suggest)
        return;
    const { items, sel, typed } = suggest;
    suggestEl.innerHTML = items.map((s, i) => {
        const hint = s.hint ? `<small>${esc(s.hint)}</small>` : '';
        return `<div class="${i === sel ? 'on' : ''}" data-sg="${i}" role="option"><span><b>${esc(s.text.slice(0, typed))}</b>${esc(s.text.slice(typed))}</span>${hint}</div>`;
    }).join('');
    suggestEl.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
    suggest.onRender?.();
}
// Shows suggestions under (x, y), or above `above` when they don't fit below.
function showSuggest(state, x, y, above) {
    if (!state.items.length) {
        hideSuggest();
        return;
    }
    suggest = state;
    renderSuggest();
    suggestEl.classList.remove('hidden');
    const h = suggestEl.offsetHeight, w = suggestEl.offsetWidth;
    suggestEl.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
    suggestEl.style.top = `${y + h > innerHeight - 8 ? Math.max(8, above - h) : y}px`;
}
function hideSuggest() {
    suggest = null;
    suggestEl.classList.add('hidden');
    editorGhost.textContent = '';
}
// Arrow keys move, Tab or Enter accepts, Escape closes. True when the key was used.
function suggestKeys(e, owner) {
    if (suggest?.owner !== owner)
        return false;
    const s = suggest;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp')
        s.sel = (s.sel + (e.key === 'ArrowDown' ? 1 : -1) + s.items.length) % s.items.length;
    else if (e.key === 'Tab' || e.key === 'Enter')
        s.accept(s.items[s.sel]);
    else if (e.key === 'Escape')
        hideSuggest();
    else
        return false;
    e.preventDefault();
    e.stopPropagation();
    if (suggest)
        renderSuggest();
    return true;
}
/* ----- Code editor: words from the file plus the language's keywords ----- */
const CSS_PROPS = 'display position top right bottom left margin padding color background background-color border border-radius box-shadow font font-family font-size font-weight line-height letter-spacing text-align text-decoration width height min-width max-width min-height max-height flex flex-direction flex-wrap align-items justify-content gap grid grid-template-columns grid-template-rows place-items overflow opacity transform transition animation cursor z-index content outline visibility white-space inset aspect-ratio object-fit';
const HTML_TAGS = 'html head body title meta link script style div span section header footer main nav article aside button input label form select option textarea img picture video audio a ul ol li p h1 h2 h3 h4 h5 h6 strong em small code pre table thead tbody tr td th template iframe canvas svg';
const JS_EXTRA = 'console log document window querySelector querySelectorAll addEventListener removeEventListener getElementById createElement appendChild classList textContent innerHTML length forEach filter reduce includes startsWith endsWith JSON stringify parse Promise resolve setTimeout clearTimeout fetch Math Object keys values entries Array Number String Boolean Map Set';
const PY_EXTRA = 'print range len str int float list dict set tuple open enumerate zip isinstance sorted append extend items keys values format join split strip __init__ __name__ __main__';
const JAVA_EXTRA = 'System out println print printf String Integer Double Boolean Character Math List ArrayList Map HashMap Set HashSet Arrays Collections Scanner main args length size add get put remove contains equals toString Override Exception RuntimeException';
const RS_EXTRA = 'println! print! format! vec! panic! assert! assert_eq! main unwrap expect clone iter into_iter map filter collect push pop len is_empty new into to_string as_str HashMap HashSet derive Debug Clone';
const EDITOR_WORDS = {
    js: `${JS_KW} ${JS_EXTRA}`.split(' '),
    py: `${PY_KW} ${PY_EXTRA}`.split(' '),
    java: `${JAVA_KW} ${JAVA_EXTRA}`.split(' '),
    rs: `${RS_KW} ${RS_EXTRA}`.split(' '),
    css: CSS_PROPS.split(' '),
    html: HTML_TAGS.split(' '),
    json: ['true', 'false', 'null'],
};
// Word counts per open file, refreshed at most every second and a half while typing.
const wordCache = new WeakMap();
function fileWords(b) {
    const cached = wordCache.get(b);
    if (cached && Date.now() - cached.at < 1500)
        return cached.counts;
    const counts = new Map();
    for (const m of b.text.slice(0, LINT_MAX).matchAll(/[A-Za-z_$][\w$-]{2,}/g))
        counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
    wordCache.set(b, { at: Date.now(), counts });
    return counts;
}
function editorCandidates(b, prefix) {
    const counts = fileWords(b);
    const lower = prefix.toLowerCase();
    const words = new Map();
    for (const w of EDITOR_WORDS[langOf(b.path)[0]] ?? [])
        words.set(w, 1000);
    for (const [w, n] of counts)
        words.set(w, (words.get(w) ?? 0) + n);
    // The word being typed counts once in the file; it isn't a suggestion by itself.
    return [...words]
        .filter(([w, n]) => w.toLowerCase().startsWith(lower) && w !== prefix && !(n === 1 && counts.get(w) === 1 && w.startsWith(prefix)))
        .sort((a, b2) => Number(b2[0].startsWith(prefix)) - Number(a[0].startsWith(prefix)) || b2[1] - a[1] || a[0].length - b2[0].length)
        .slice(0, 8)
        .map(([w, n]) => ({ text: w, hint: n >= 1000 ? 'keyword' : '' }));
}
// The word (letters, digits, _ $ and -) that ends at the caret.
function wordBefore(ta) {
    const v = ta.value, end = ta.selectionStart;
    let i = end;
    while (i > 0 && end - i < 60 && /[\w$-]/.test(v[i - 1]))
        i--;
    while (i < end && !/[A-Za-z_$]/.test(v[i]))
        i++; // words start with a letter, _ or $
    return v.slice(i, end);
}
function editorSuggest(b, force = false) {
    const ta = b.ta;
    if (!ta || ta.selectionStart !== ta.selectionEnd) {
        hideSuggest();
        return;
    }
    const prefix = wordBefore(ta);
    if (prefix.length < (force ? 0 : 2)) {
        hideSuggest();
        return;
    }
    const pos = ta.selectionStart, ls = lineStart(b.text, pos), line = b.text.slice(ls, pos);
    const cw = measureChar();
    const r = ta.getBoundingClientRect();
    const x = r.left + 4 + visualCol(line, pos - ls - prefix.length) * cw - ta.scrollLeft;
    const top = r.top + 10 + lineAt(b.text, pos) * LINE_H - ta.scrollTop;
    // Only where nothing follows on the line, so the hint never covers real text.
    const lineEnd = b.text.indexOf('\n', pos);
    const clear = !b.text.slice(pos, lineEnd < 0 ? undefined : lineEnd).trim();
    const ghost = () => {
        const s = suggest?.items[suggest.sel];
        editorGhost.textContent = clear && s?.text.startsWith(prefix) ? s.text.slice(prefix.length) : '';
        editorGhost.style.left = `${r.left + 4 + visualCol(line, pos - ls) * cw - ta.scrollLeft}px`;
        editorGhost.style.top = `${top}px`;
    };
    showSuggest({
        owner: ta, items: editorCandidates(b, prefix), sel: 0, typed: prefix.length,
        accept: s => { hideSuggest(); replaceRange(ta, pos - prefix.length, ta.selectionStart, s.text); },
        onRender: ghost,
    }, x - 8, top + LINE_H + 2, top - 2);
}
/* ----- Terminal: files and folders, commands, and your history ----- */
const COMMANDS = ['git', 'npm', 'npx', 'node', 'cd', 'dir', 'ls', 'cls', 'clear', 'mkdir', 'python', 'pip', 'echo', 'type', 'cat', 'code'];
const SUBCOMMANDS = {
    git: ['status', 'add', 'commit', 'push', 'pull', 'fetch', 'switch', 'checkout', 'branch', 'log', 'diff', 'init', 'clone', 'merge', 'stash', 'restore'],
    npm: ['install', 'run', 'start', 'test', 'init', 'uninstall', 'update'],
};
// The project's npm scripts, so `npm s` hints `npm start` and `npm run b` hints `npm run build`.
let npmScripts = [];
async function loadNpmScripts() {
    if (!rootInfo) {
        npmScripts = [];
        return;
    }
    const r = await api.fs.readFile('package.json').catch(() => null);
    try {
        npmScripts = Object.keys(JSON.parse(r?.text ?? '{}').scripts ?? {});
    }
    catch {
        npmScripts = [];
    }
}
background(loadNpmScripts());
api.fs.onChange(paths => { if (paths.includes('package.json'))
    background(loadNpmScripts()); });
function subcommandsOf(cmd) {
    return cmd === 'npm' ? [...new Set([...SUBCOMMANDS.npm, ...npmScripts.filter(s => ['start', 'test'].includes(s))])] : SUBCOMMANDS[cmd] ?? [];
}
// The known words that can finish the last word of `words`.
function knownWords(words) {
    if (words.length === 1)
        return [...new Set([...term.history.map(h => h.split(' ')[0]), ...COMMANDS])];
    if (words.length === 2)
        return subcommandsOf(words[0]);
    if (words.length === 3 && words[0] === 'npm' && words[1] === 'run')
        return npmScripts;
    return [];
}
// Greyed-out rest of the line: the last matching command from history, else a known command; → accepts it.
function ghostMatch(value) {
    if (!value)
        return '';
    const past = [...term.history].reverse().find(h => h.startsWith(value) && h !== value);
    if (past)
        return past;
    const words = value.split(' '), token = words.at(-1) ?? '';
    if (!token)
        return '';
    const word = knownWords(words).find(w => w.startsWith(token) && w !== token);
    return word ? value + word.slice(token.length) : '';
}
function updateGhost() {
    if (term.proc != null) {
        termGhost.innerHTML = '';
        termInput.classList.add('raw-input');
        return;
    }
    termInput.classList.remove('raw-input');
    const v = termInput.value;
    if (!v) {
        termGhost.innerHTML = '';
        return;
    }
    const match = ghostMatch(v);
    const highlightedTyped = formatCommandSyntax(v);
    const ghostTail = match?.startsWith(v) ? match.slice(v.length) : '';
    const ghostSpan = ghostTail ? `<span class="term-ghost-text">${esc(ghostTail)}</span>` : '';
    termGhost.innerHTML = `${highlightedTyped}${ghostSpan}`;
}
// Width of text in an input's own font.
const measureCtx = document.createElement('canvas').getContext('2d');
function textWidth(text, el) {
    if (!measureCtx)
        return text.length * 7;
    measureCtx.font = getComputedStyle(el).font;
    return measureCtx.measureText(text).width;
}
function commonPrefix(words) {
    let shared = words[0] ?? '';
    for (const w of words) {
        let i = 0;
        while (i < shared.length && shared[i].toLowerCase() === w[i]?.toLowerCase())
            i++;
        shared = shared.slice(0, i);
    }
    return shared;
}
async function terminalCandidates(line) {
    const words = line.split(' ');
    const token = words.at(-1) ?? '';
    if (words.length === 1) {
        const commands = knownWords(words).filter(c => c.startsWith(token) && c !== token).map(c => ({ text: c, hint: 'command' }));
        const files = token ? await api.term.complete(token).catch(() => []) : [];
        return { token, items: [...commands, ...files.map(f => ({ text: f.text, hint: f.dir ? 'folder' : 'file' }))].slice(0, 40) };
    }
    const hint = words.length === 3 ? 'script' : words[0];
    const subs = knownWords(words).filter(c => c.startsWith(token) && c !== token).map(c => ({ text: c, hint }));
    const files = await api.term.complete(token).catch(() => []);
    return { token, items: [...subs, ...files.map(f => ({ text: f.text, hint: f.dir ? 'folder' : 'file' }))].slice(0, 40) };
}
// Tab completes the last word: one match fills in, several fill the shared start and list the rest.
async function completeTerminal() {
    const line = termInput.value;
    const { token, items } = await terminalCandidates(line);
    if (termInput.value !== line || !items.length)
        return;
    const base = line.slice(0, line.length - token.length);
    const put = (text) => { termInput.value = base + text; updateGhost(); };
    if (items.length === 1) {
        put(items[0].text);
        hideSuggest();
        return;
    }
    const shared = commonPrefix(items.map(i => i.text));
    if (shared.length > token.length)
        put(shared);
    const r = termInput.getBoundingClientRect();
    const x = r.left + textWidth(base, termInput);
    showSuggest({ owner: termInput, items, sel: 0, typed: termInput.value.length - base.length, accept: s => { put(s.text); hideSuggest(); termInput.focus(); } }, x, r.bottom + 4, r.top - 4);
}
// Keys the terminal's autofill handles before the normal ones; true when handled.
function terminalAutofillKeys(e) {
    if (term.proc != null)
        return false;
    if (suggestKeys(e, termInput))
        return true;
    const match = ghostMatch(termInput.value);
    if ((e.key === 'Tab' || e.key === 'ArrowRight') && match && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        termInput.value = match;
        updateGhost();
        return true;
    }
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        void completeTerminal();
        return true;
    }
    return false;
}
termInput.addEventListener('input', () => { updateGhost(); if (suggest?.owner === termInput)
    hideSuggest(); });
termInput.addEventListener('blur', () => { termGhost.innerHTML = ''; hideSuggest(); });
termInput.addEventListener('focus', updateGhost);
const DEFAULT_LAYOUT = { side: 240, agents: 340, term: 200, preview: 460, sideOpen: true, agentsOpen: true, termOpen: false, previewOpen: true, view: 'files' };
const layout = { ...DEFAULT_LAYOUT, ...store.get('breeze.layout', {}) };
function applyLayout() {
    const main = $('#main'), work = $('#work'), t = $('#terminal');
    main.style.setProperty('--side-w', layout.sideOpen ? `${layout.side}px` : '0px');
    main.style.setProperty('--agents-w', layout.agentsOpen ? `${layout.agents}px` : '0px');
    main.classList.toggle('no-side', !layout.sideOpen);
    main.classList.toggle('no-agents', !layout.agentsOpen);
    const maxPreview = work.clientWidth ? work.clientWidth - 220 : layout.preview;
    // The inline width beats the .no-preview rule, so a closed preview has to be zeroed here or its column stays as a blank gap.
    work.style.setProperty('--preview-w', layout.previewOpen ? `${clamp(layout.preview, 220, Math.max(220, maxPreview))}px` : '0px');
    work.classList.toggle('no-preview', !layout.previewOpen);
    t.style.setProperty('--term-h', `${clamp(layout.term, 80, Math.max(80, innerHeight - 220))}px`);
    t.classList.toggle('open', layout.termOpen);
    void setIcon($('#termTitle'), layout.termOpen ? 'chevronDown' : 'chevronRight');
    const icon = (id, sym, on) => $(`#${id} use`).setAttribute('href', `#i-${sym}${on ? '-on' : ''}`);
    icon('tglSide', 'left', layout.sideOpen);
    icon('tglTerm', 'bottom', layout.termOpen);
    icon('tglAgents', 'right', layout.agentsOpen);
    store.set('breeze.layout', layout);
    syncScroll();
    updateActIndicator();
}
window.addEventListener('resize', applyLayout);
// Dragging below a threshold collapses the panel; dragging back out reopens it.
const SASH_DRAG = {
    side: (start, dx) => { const w = start.side + dx; layout.sideOpen = w >= 120; if (layout.sideOpen)
        layout.side = clamp(w, 170, 640); },
    agents: (start, dx) => { const w = start.agents - dx; layout.agentsOpen = w >= 180; if (layout.agentsOpen)
        layout.agents = clamp(w, 260, 720); },
    preview: (start, dx) => { const w = start.preview - dx; layout.previewOpen = w >= 140; if (layout.previewOpen)
        layout.preview = clamp(w, 220, $('#work').clientWidth - 220); },
    term: (start, _dx, dy) => { const h = start.term - dy; layout.termOpen = h >= 60; if (layout.termOpen)
        layout.term = clamp(h, 80, innerHeight - 220); },
};
function startSashDrag(sash, kind, e) {
    const sx = e.clientX, sy = e.clientY, start = { ...layout };
    if (kind === 'preview')
        start.preview = $('#previewPane').getBoundingClientRect().width;
    document.body.classList.add(kind === 'term' ? 'resizing-h' : 'resizing');
    sash.classList.add('active');
    const move = (ev) => { SASH_DRAG[kind](start, ev.clientX - sx, ev.clientY - sy); applyLayout(); };
    const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        document.body.classList.remove('resizing', 'resizing-h');
        sash.classList.remove('active');
        if (layout.side !== start.side || layout.agents !== start.agents || layout.preview !== start.preview || layout.term !== start.term || layout.sideOpen !== start.sideOpen || layout.agentsOpen !== start.agentsOpen || layout.previewOpen !== start.previewOpen || layout.termOpen !== start.termOpen) {
            pushAppAction({ type: 'layout', prev: start, next: { ...layout } });
        }
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
}
$$('[data-sash]').forEach(sash => {
    const kind = sash.dataset.sash;
    sash.addEventListener('pointerdown', e => {
        if (e.button !== 0)
            return;
        e.preventDefault();
        startSashDrag(sash, kind, e);
    });
    sash.addEventListener('dblclick', () => {
        const prev = { ...layout };
        layout[kind] = DEFAULT_LAYOUT[kind];
        pushAppAction({ type: 'layout', prev, next: { ...layout } });
        applyLayoutAnimated();
    });
});
$('#tglSide').onclick = () => run('view.toggleSide');
$('#tglTerm').onclick = () => run('term.toggle');
$('#tglAgents').onclick = () => run('view.toggleAgents');
const hasFile = () => !!activeText();
function searchSelection() {
    showView('search', true);
    const i = $('#searchInput');
    const b = activeText();
    const s = b ? b.ta.value.slice(b.ta.selectionStart, b.ta.selectionEnd) : '';
    if (s && !s.includes('\n'))
        i.value = s;
    i.focus();
    i.select();
}
function backToOnboarding(n) {
    appState.onboarded = false;
    saveApp();
    $('#ide').classList.add('hidden');
    $('#box').classList.add('hidden');
    $('#onboard').classList.remove('hidden');
    goStep(n);
}
const commands = {
    'file.newFile': () => newEntry(targetDir(), false),
    'file.newFolder': () => newEntry(targetDir(), true),
    'file.openFolder': openFolderCmd,
    'file.openRecent': openRecentPicker,
    'file.save': () => saveFile(focused() === splitTa ? splitPath : active).then(ok => { if (ok)
        sfx.play('save'); }),
    'file.saveAll': saveAll,
    'file.closeEditor': () => { if (active)
        closeTab(active); },
    'file.closeFolder': closeFolderCmd,
    'file.exit': () => api.win.quit(),
    'edit.undo': () => editRole('undo'),
    'edit.redo': () => editRole('redo'),
    'edit.cut': () => editRole('cut'),
    'edit.copy': () => editRole('copy'),
    'edit.paste': () => editRole('paste'),
    'edit.find': openFind,
    'edit.comment': toggleComment,
    'edit.selectAll': () => editRole('selectAll'),
    'sel.line': selectLine,
    'sel.dup': duplicateLines,
    'sel.up': () => moveLines(-1),
    'sel.down': () => moveLines(1),
    'view.files': () => showView('files', true),
    'view.search': searchSelection,
    'view.git': () => showView('git', true),
    'view.toggleSide': () => {
        const prev = { ...layout };
        layout.sideOpen = !layout.sideOpen;
        sfx.play('menu');
        pushAppAction({ type: 'layout', prev, next: { ...layout } });
        applyLayoutAnimated();
    },
    'view.toggleAgents': () => {
        const prev = { ...layout };
        layout.agentsOpen = !layout.agentsOpen;
        sfx.play('menu');
        pushAppAction({ type: 'layout', prev, next: { ...layout } });
        applyLayoutAnimated();
    },
    'view.togglePreview': () => {
        const prev = { ...layout };
        layout.previewOpen = !layout.previewOpen;
        pushAppAction({ type: 'layout', prev, next: { ...layout } });
        applyLayoutAnimated();
    },
    'view.splitEditor': () => { if (splitPath) {
        closeSplit();
    }
    else {
        openSplit();
    } renderTabs(); },
    'view.resetLayout': () => {
        const prev = { ...layout };
        Object.assign(layout, DEFAULT_LAYOUT, { view: layout.view });
        pushAppAction({ type: 'layout', prev, next: { ...layout } });
        applyLayoutAnimated();
    },
    'win.reload': () => { flushSession(); return api.win.reload(); },
    'win.devtools': () => api.win.toggleDevTools(),
    'go.file': quickOpen,
    'go.line': goToLine,
    'go.nextProblem': nextProblem,
    'go.nextEditor': () => cycleTab(1),
    'go.prevEditor': () => cycleTab(-1),
    'run.file': runFile,
    'run.start': () => {
        if (runnable(active))
            return run('run.file');
        return running && previewPath === previewTarget() ? reloadPreview() : startPreview();
    },
    'run.reload': reloadPreview,
    'run.stop': () => { if (term.runId != null)
        killCommand();
    else {
        stopPreview();
        toast('Preview stopped');
    } },
    'live.toggle': toggleLiveShare,
    'live.start': () => background((async () => {
        try {
            const live = await api.live.start();
            await refreshLiveShare();
            toast(`Live Share opened at ${live.url}`);
        }
        catch (e) {
            toast(errMsg(e));
        }
    })()),
    'live.stop': () => background((async () => {
        try {
            await api.live.stop();
            await refreshLiveShare();
            toast('Live Share turned off');
        }
        catch (e) {
            toast(errMsg(e));
        }
    })()),
    'term.toggle': () => {
        const prev = { ...layout };
        layout.termOpen = !layout.termOpen;
        sfx.play('whoosh');
        pushAppAction({ type: 'layout', prev, next: { ...layout } });
        applyLayoutAnimated();
        if (layout.termOpen)
            termInput.focus();
    },
    'term.focus': () => { layout.termOpen = true; applyLayoutAnimated(); termInput.focus(); },
    'term.new': () => {
        layout.termOpen = true;
        applyLayoutAnimated();
        createTermSession();
        termInput.focus();
    },
    'term.clear': () => {
        if (activeTermSession?.paneEl) {
            activeTermSession.paneEl.innerHTML = '';
        }
    },
    'term.kill': () => { if (term.proc == null)
        toast('Nothing is running');
    else
        killCommand(); },
    'explorer.refresh': refreshTree,
    'explorer.collapse': () => { expanded.clear(); renderTree(); saveSession(); },
    'help.welcome': () => setActive(null),
    'help.keys': showShortcuts,
    'help.setup': () => backToOnboarding(STEP.agent),
    'account.signIn': addAccount,
    'account.signOut': signOut,
    'sync.run': () => runSync('sync'),
    'sync.pull': confirmPull,
    'sync.open': () => openCloudWorkspaces(),
    'mode.ide': () => enterMode('ide'),
    'mode.box': () => enterMode('box'),
    'help.about': showAbout,
};
function showAbout() {
    const where = isDesktop ? 'Desktop app' : 'Browser preview';
    const engine = /Electron\/[\d.]+|Chrome\/[\d.]+/.exec(navigator.userAgent)?.[0] ?? '';
    openModal(`<h3>Breeze Code</h3><p class="sub">Smooth as a breeze.</p><p class="sub fs-12">${where} · ${esc(engine)}</p><div class="row end"><button class="btn btn-primary" data-close>OK</button></div>`);
}
function run(act) {
    const fn = commands[act];
    if (fn)
        Promise.resolve(fn()).catch((e) => toast(errMsg(e)));
}
// Undo and redo in the code editor use its own history; everything else goes to the focused field.
function editRole(role) {
    const b = activeText();
    const topAction = actionUndoStack[actionUndoStack.length - 1];
    const isRecentTreeAction = topAction && topAction.type.startsWith('tree-') &&
        (topAction.timestamp ?? 0) > (lastUserTypeAt || 0);
    if (role === 'undo') {
        if (isRecentTreeAction) {
            void undoAppAction();
            return;
        }
        if (b && b.undo.length > 0) {
            stepHistory(b, true);
            b.ta.focus();
            return;
        }
        if (actionUndoStack.length > 0) {
            void undoAppAction();
            return;
        }
        if (b) {
            stepHistory(b, true);
            b.ta.focus();
            return;
        }
    }
    if (role === 'redo') {
        const topRedo = actionRedoStack[actionRedoStack.length - 1];
        const isRecentTreeRedo = topRedo && topRedo.type.startsWith('tree-');
        if (isRecentTreeRedo) {
            void redoAppAction();
            return;
        }
        if (b && b.redo.length > 0) {
            stepHistory(b, false);
            b.ta.focus();
            return;
        }
        if (actionRedoStack.length > 0) {
            void redoAppAction();
            return;
        }
        if (b) {
            stepHistory(b, false);
            b.ta.focus();
            return;
        }
    }
    b?.ta.focus();
    background(api.win.edit(role));
}
function cycleTab(d) {
    if (!openTabs.length)
        return;
    const i = active ? openTabs.indexOf(active) : -1;
    setActive(openTabs[(i + d + openTabs.length) % openTabs.length]);
}
async function openFolderCmd() {
    if (!(await confirmDiscard()))
        return;
    const r = await api.fs.openFolder();
    if (r)
        await loadWorkspace(r);
}
async function openRecentFolder(dir) {
    if (!(await confirmDiscard()))
        return;
    try {
        await loadWorkspace(await api.fs.openRecent(dir));
    }
    catch (e) {
        toast(errMsg(e));
    }
}
async function openRecentPicker() {
    const recent = await api.fs.recent();
    if (!recent.length) {
        toast('No recent folders yet');
        return;
    }
    const rows = recent.map(r => `<div class="qo-item" data-r="${escAttr(r.path)}"><span>${esc(r.name)}</span><small>${esc(r.path)}</small></div>`);
    openModal(`<h3>Open recent</h3><div class="qo-list">${rows.join('')}</div>`, m => $$('[data-r]', m).forEach(el => el.onclick = () => { closeModal(); void openRecentFolder(el.dataset.r); }), undefined, 'top');
}
async function closeFolderCmd() {
    if (!rootInfo || !(await confirmDiscard()))
        return;
    store.del(hotExitKey());
    await api.fs.closeFolder();
    resetWorkspace();
    renderTree();
    renderTabs();
    renderEditor();
}
// Before leaving a folder: save, discard or cancel any unsaved files.
function confirmDiscard() {
    const dirty = [...buffers.values()].filter(isDirty);
    if (!dirty.length)
        return Promise.resolve(true);
    return new Promise(res => {
        const finish = settleOnce(res);
        openModal(`<h3>Save changes to ${plural(dirty.length, 'file')}?</h3><p class="sub">${dirty.map(b => esc(b.path)).join('<br>')}</p>
      <div class="row end"><button class="btn" data-close>Cancel</button><button class="btn" id="dDiscard">Don't Save</button><button class="btn btn-primary" id="dSave">Save All</button></div>`, m => {
            $('#dDiscard', m).onclick = () => {
                for (const b of dirty) {
                    b.text = b.saved;
                    if (b.ta)
                        b.ta.value = b.saved;
                }
                finish(true);
                closeModal();
            };
            $('#dSave', m).onclick = () => background(saveAll().then(() => { finish(true); closeModal(); }));
        }, () => finish(false));
    });
}
const MENUS = [
    {
        name: 'File', items: [
            { label: 'New File…', act: 'file.newFile', key: 'Ctrl+N' },
            { label: 'New Folder…', act: 'file.newFolder' },
            { sep: true },
            { label: 'Open Folder…', act: 'file.openFolder', key: 'Ctrl+O' },
            { label: 'Open Recent…', act: 'file.openRecent' },
            { sep: true },
            { label: 'Save', act: 'file.save', key: 'Ctrl+S', enabled: hasFile },
            { label: 'Save All', act: 'file.saveAll', key: 'Ctrl+Alt+S', enabled: () => [...buffers.values()].some(isDirty) },
            { sep: true },
            { label: 'Close Editor', act: 'file.closeEditor', key: 'Ctrl+W', enabled: () => !!active },
            { label: 'Close Folder', act: 'file.closeFolder', enabled: () => !!rootInfo },
            { sep: true },
            { label: 'Exit', act: 'file.exit' },
        ]
    },
    {
        name: 'Edit', items: [
            { label: 'Undo', act: 'edit.undo', key: 'Ctrl+Z', native: true },
            { label: 'Redo', act: 'edit.redo', key: 'Ctrl+Y', native: true },
            { sep: true },
            { label: 'Cut', act: 'edit.cut', key: 'Ctrl+X', native: true },
            { label: 'Copy', act: 'edit.copy', key: 'Ctrl+C', native: true },
            { label: 'Paste', act: 'edit.paste', key: 'Ctrl+V', native: true },
            { sep: true },
            { label: 'Find', act: 'edit.find', key: 'Ctrl+F', enabled: hasFile },
            { label: 'Find in Files', act: 'view.search', key: 'Ctrl+Shift+F' },
            { sep: true },
            { label: 'Toggle Line Comment', act: 'edit.comment', key: 'Ctrl+/', enabled: hasFile },
        ]
    },
    {
        name: 'Selection', items: [
            { label: 'Select All', act: 'edit.selectAll', key: 'Ctrl+A', native: true },
            { label: 'Select Line', act: 'sel.line', key: 'Ctrl+L', enabled: hasFile },
            { sep: true },
            { label: 'Copy Line Down', act: 'sel.dup', key: 'Shift+Alt+Down', enabled: hasFile },
            { label: 'Move Line Up', act: 'sel.up', key: 'Alt+Up', enabled: hasFile },
            { label: 'Move Line Down', act: 'sel.down', key: 'Alt+Down', enabled: hasFile },
        ]
    },
    {
        name: 'View', items: [
            { label: 'Explorer', act: 'view.files', key: 'Ctrl+Shift+E' },
            { label: 'Search', act: 'view.search', key: 'Ctrl+Shift+F' },
            { label: 'Checkpoints', act: 'view.git', key: 'Ctrl+Shift+G' },
            { sep: true },
            { label: 'Primary Side Bar', act: 'view.toggleSide', key: 'Ctrl+B', checked: () => layout.sideOpen },
            { label: 'Agents Panel', act: 'view.toggleAgents', key: 'Ctrl+Alt+B', checked: () => layout.agentsOpen },
            { label: 'Terminal', act: 'term.toggle', key: 'Ctrl+`', checked: () => layout.termOpen },
            { label: 'Preview', act: 'view.togglePreview', checked: () => layout.previewOpen },
            { label: 'Split Editor Right', act: 'view.splitEditor', key: 'Ctrl+\\', checked: () => !!splitPath },
            { label: 'Reset Layout', act: 'view.resetLayout' },
            { sep: true },
            { label: 'Reload Window', act: 'win.reload', key: 'Ctrl+R' },
            { label: 'Toggle Developer Tools', act: 'win.devtools', key: 'Ctrl+Shift+I' },
        ]
    },
    {
        name: 'Go', items: [
            { label: 'Go to File…', act: 'go.file', key: 'Ctrl+P' },
            { label: 'Go to Line…', act: 'go.line', key: 'Ctrl+G', enabled: hasFile },
            { label: 'Next Problem', act: 'go.nextProblem', key: 'F8', enabled: hasFile },
            { sep: true },
            { label: 'Next Editor', act: 'go.nextEditor', key: 'Ctrl+Tab' },
            { label: 'Previous Editor', act: 'go.prevEditor', key: 'Ctrl+Shift+Tab' },
        ]
    },
    {
        name: 'Run', items: [
            { label: 'Run File', act: 'run.file', enabled: () => runnable(active) },
            { label: 'Start Preview / Run File', act: 'run.start', key: 'F5' },
            { label: 'Reload Preview', act: 'run.reload', key: 'Ctrl+F5', enabled: () => running },
            { label: 'Stop Preview', act: 'run.stop', key: 'Shift+F5', enabled: () => running || term.runId != null },
            { sep: true },
            { label: 'Toggle Live Share', act: 'live.toggle' },
        ]
    },
    {
        name: 'Terminal', items: [
            { label: 'New Terminal', act: 'term.new', key: 'Ctrl+Shift+`' },
            { label: 'Toggle Terminal', act: 'term.toggle', key: 'Ctrl+`' },
            { sep: true },
            { label: 'Clear Terminal', act: 'term.clear' },
            { label: 'Stop Running Command', act: 'term.kill', enabled: () => term.proc != null },
        ]
    },
    {
        name: 'Help', items: [
            { label: 'Settings', act: 'settings.open', key: 'Ctrl+,' },
            { label: 'Keyboard Shortcuts', act: 'help.keys' },
            { label: 'Run Setup Again', act: 'help.setup' },
            { label: 'Vibe Mode Feeds…', act: 'vibe.feeds' },
            { label: 'Sound Effects', act: 'sound.toggle', checked: () => sfx.on },
            { sep: true },
            { label: 'Breeze Code', act: 'mode.ide', checked: () => appState.mode === 'ide' },
            { label: 'Breeze Box', act: 'mode.box', checked: () => appState.mode === 'box' },
            { sep: true },
            { label: 'Sync Workspace', act: 'sync.run', enabled: () => !!user && !!rootInfo },
            { label: 'Open Cloud Workspace…', act: 'sync.open', enabled: () => !!user },
            { sep: true },
            { label: 'Add Account', act: 'account.signIn' },
            { label: 'Sign Out', act: 'account.signOut', enabled: () => !!user },
        ]
    },
];
// Go, Run and Help stay out of the menu bar; their shortcuts still work and Help lives under the gear button.
const BAR_MENUS = MENUS.filter(m => !['Go', 'Run', 'Help'].includes(m.name));
// Shortcuts handled by the editor itself or by keydown elsewhere, but listed for discoverability.
const EXTRA_KEYS = [['F2', 'explorer.rename']];
commands['explorer.rename'] = () => { if (active)
    return renameEntry(active); };
commands['sound.toggle'] = () => sfx.toggle();
const canonKey = (combo) => {
    const parts = combo.split('+');
    const key = parts.pop();
    const mods = new Set(parts);
    return ['Ctrl', 'Shift', 'Alt'].filter(m => mods.has(m)).concat(key.length === 1 ? key.toUpperCase() : key).join('+');
};
const keymap = new Map();
for (const { items } of MENUS)
    for (const it of items)
        if (it.key && it.act && !it.native)
            keymap.set(canonKey(it.key), it.act);
for (const [k, act] of EXTRA_KEYS)
    keymap.set(canonKey(k), act);
const KEY_BY_CODE = { Backquote: '`', Slash: '/', Backslash: '\\', Comma: ',' };
function keyName(e) {
    if (KEY_BY_CODE[e.code])
        return KEY_BY_CODE[e.code];
    if (e.key.startsWith('Arrow'))
        return e.key.slice(5);
    return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}
function comboOf(e) {
    return [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.shiftKey ? 'Shift' : '', e.altKey ? 'Alt' : '', keyName(e)].filter(Boolean).join('+');
}
// Commands that only make sense while typing in the code editor.
const EDITOR_ONLY = new Set(['edit.comment', 'sel.line', 'sel.dup', 'sel.up', 'sel.down']);
/* ----- Menus: the bar opens on hover; the gear and right-clicks pop up ----- */
let openMenuIdx = -1; // bar menu index, -2 for a popup, -1 when closed
let menuPinned = false; // opened by a click or the keyboard: stays open when the pointer leaves
let menuCloseTimer;
let kbIdx = -1;
let menuItems = [];
let menuOnClose = null;
function cancelMenuClose() { clearTimeout(menuCloseTimer); }
// A menu opened by hovering closes shortly after the pointer leaves both the bar and the menu.
function scheduleMenuClose() {
    cancelMenuClose();
    menuCloseTimer = setTimeout(() => { if (openMenuIdx >= 0 && !menuPinned)
        closeMenu(); }, 130);
}
function buildMenubar() {
    $('#menubar').innerHTML = BAR_MENUS.map((m, i) => `<button class="menu-top" data-menu="${i}" aria-haspopup="menu">${esc(m.name)}</button>`).join('');
    $$('[data-menu]').forEach(b => {
        const i = Number(b.dataset.menu);
        b.onmouseenter = () => {
            cancelMenuClose();
            if (openMenuIdx !== i)
                openMenu(i, false, menuPinned && openMenuIdx >= 0);
        };
        b.onmouseleave = scheduleMenuClose;
        b.onmousedown = e => {
            e.preventDefault();
            // A click pins a hover-opened menu; clicking a pinned menu closes it.
            if (openMenuIdx === i && menuPinned)
                closeMenu();
            else
                openMenu(i, false, true);
        };
    });
}
function openMenu(i, viaKeyboard = false, pinned = viaKeyboard) {
    const btn = $(`[data-menu="${i}"]`);
    const r = btn.getBoundingClientRect();
    showMenu(r.left, r.bottom + 2, BAR_MENUS[i].items, viaKeyboard);
    openMenuIdx = i;
    menuPinned = pinned;
    $$('[data-menu]').forEach(b => b.classList.toggle('open', b === btn));
    const m = $('#menuRoot .menu');
    m.onmouseenter = cancelMenuClose;
    m.onmouseleave = scheduleMenuClose;
}
/* ----- Popups grow out of the icon that opened them and shrink back into it ----- */
let popTrigger = null;
let menuOwner = null; // the button whose menu is (or was just) open, for modals its items open
let activeMenuTrigger = null;
let justClosedTrigger = null;
let justClosedAt = 0;
const noteTrigger = (e) => {
    const el = e.target.closest('button, [role="button"]');
    if (el)
        popTrigger = { el, at: Date.now() };
};
document.addEventListener('pointerdown', noteTrigger, true);
document.addEventListener('click', noteTrigger, true);
// The button that just opened a popup, if it carries an icon (a text-only button keeps the plain animation).
function popOwner() {
    if (!popTrigger || Date.now() - popTrigger.at > 700)
        return null;
    const el = popTrigger.el.closest('.menu') ? menuOwner : popTrigger.el;
    return el?.isConnected && el.querySelector('svg') ? el : null;
}
// Sets the scale-from point of `pop` (placed at left/top, or wherever it sits) to the owner's icon.
function growFrom(pop, owner, at) {
    const icon = owner.querySelector('svg'), i = icon.getBoundingClientRect();
    const p = at ?? pop.getBoundingClientRect();
    pop.style.transformOrigin = `${i.left + i.width / 2 - p.left}px ${i.top + i.height / 2 - p.top}px`;
    pop.classList.add('from-icon');
}
function popupMenu(x, y, items, onClose, trigger) {
    const trig = trigger || popOwner() || popTrigger?.el || null;
    activeMenuTrigger = trig;
    if (trig) {
        trig.classList.add('open');
        trig.setAttribute('aria-expanded', 'true');
    }
    showMenu(x, y, items, false);
    openMenuIdx = -2;
    menuPinned = true;
    menuOnClose = () => {
        if (trig) {
            trig.classList.remove('open');
            trig.setAttribute('aria-expanded', 'false');
        }
        onClose?.();
    };
}
// A non-clickable row showing who is signed in.
function menuHeaderHtml(u) {
    const detail = [u.email ?? u.login, u.provider].filter(Boolean).join(' · ');
    return `<div class="menu-label">${avatarHtml(u, '')}<span class="who"><b>${esc(u.name)}</b><small>${esc(detail)}</small></span></div>`;
}
function menuItemHtml(it, i) {
    if (it.sep)
        return '<div class="menu-sep"></div>';
    if (it.header)
        return menuHeaderHtml(it.header);
    const cls = ['menu-item', it.checked?.() ? 'checked' : '', it.sub ? 'has-sub' : '', i === kbIdx ? 'kb' : ''].filter(Boolean).join(' ');
    const disabled = it.enabled && !it.enabled() ? ' disabled' : '';
    const key = it.key ? `<span class="key">${esc(it.key)}</span>` : '';
    const popup = it.sub ? ' aria-haspopup="menu"' : '';
    return `<button class="${cls}" role="menuitem" data-mi="${i}"${disabled}${popup}><span>${esc(it.label ?? '')}</span>${key}</button>`;
}
// Builds a menu element at (x, y), kept inside the window.
function renderMenu(x, y, items, cls = 'menu') {
    const m = document.createElement('div');
    m.className = cls;
    m.setAttribute('role', 'menu');
    m.innerHTML = items.map((it, i) => menuItemHtml(it, i)).join('');
    $('#menuRoot').append(m);
    m.style.left = `${Math.max(8, Math.min(x, innerWidth - m.offsetWidth - 8))}px`;
    m.style.top = `${Math.max(8, Math.min(y, innerHeight - m.offsetHeight - 8))}px`;
    $$('[data-mi]', m).forEach(b => {
        const it = items[Number(b.dataset.mi)];
        b.onmousedown = e => e.preventDefault(); // keep focus (and the selection) in the editor
        b.onclick = () => (it.sub ? openSubmenu(b, it) : activateMenuItem(it));
        if (cls === 'menu')
            b.onmouseenter = () => (it.sub ? openSubmenu(b, it) : closeSubmenu());
    });
    return m;
}
// Hovering an item with "›" opens its submenu beside it.
function openSubmenu(btn, it) {
    if (btn.classList.contains('sub-open'))
        return;
    closeSubmenu();
    btn.classList.add('sub-open');
    const r = btn.getBoundingClientRect();
    const cls = 'menu sub' + (it.subClass ? ` ${it.subClass}` : '');
    const sub = renderMenu(r.right + 4, r.top - 5, it.sub?.() ?? [], cls);
    if (btn.closest('.menu.up')) {
        sub.style.top = `${Math.max(8, r.bottom - sub.offsetHeight + 5)}px`;
    }
    if (sub.getBoundingClientRect().left < r.right)
        sub.style.left = `${Math.max(8, r.left - sub.offsetWidth - 4)}px`; // no room on the right
}
function closeSubmenu() {
    $$('#menuRoot .menu.sub').forEach(s => s.remove());
    $$('#menuRoot .sub-open').forEach(b => b.classList.remove('sub-open'));
}
function showMenu(x, y, items, viaKeyboard) {
    cancelMenuClose();
    sfx.play('menu');
    menuItems = items;
    kbIdx = viaKeyboard ? items.findIndex(it => !it.sep && !it.header) : -1;
    $('#menuRoot').innerHTML = '';
    menuOwner = popOwner();
    const m = renderMenu(x, y, items);
    // Callers may still restyle the menu (width, flip above its button), so the origin is set once they are done.
    const owner = menuOwner;
    if (owner)
        queueMicrotask(() => { if (m.isConnected)
            growFrom(m, owner, { left: Number.parseFloat(m.style.left), top: Number.parseFloat(m.style.top) }); });
}
function activateMenuItem(it) {
    if (it.enabled && !it.enabled())
        return;
    closeMenu();
    if (it.run)
        it.run();
    else if (it.act)
        run(it.act);
}
function closeMenu() {
    cancelMenuClose();
    if (openMenuIdx === -1)
        return;
    if (activeMenuTrigger) {
        justClosedTrigger = activeMenuTrigger;
        justClosedAt = Date.now();
        activeMenuTrigger.classList.remove('open');
        activeMenuTrigger.setAttribute('aria-expanded', 'false');
        activeMenuTrigger = null;
    }
    openMenuIdx = -1;
    kbIdx = -1;
    menuPinned = false;
    // Menus fade out before they are removed; opening another menu clears the root straight away.
    const root = $('#menuRoot');
    const leaving = $$('.menu', root);
    if (!leaving.length)
        root.innerHTML = '';
    for (const m of leaving) {
        m.classList.add('closing');
        m.addEventListener('animationend', () => m.remove(), { once: true });
        setTimeout(() => m.remove(), 250);
    }
    $$('[data-menu]').forEach(b => b.classList.remove('open'));
    const cb = menuOnClose;
    menuOnClose = null;
    cb?.();
}
document.addEventListener('mousedown', e => {
    const target = e.target;
    if (openMenuIdx !== -1) {
        const trig = activeMenuTrigger;
        if (trig && (trig === target || trig.contains(target))) {
            justClosedTrigger = trig;
            justClosedAt = Date.now();
            closeMenu();
            return;
        }
        if (!target.closest('.menu, .menubar, #settingsBtn, #boxSettings, .avatars, .dd-btn, #chatHistory, #boxHistory, #boxModel, #boxFolder, #agentPill, [data-act="git.more"]')) {
            closeMenu();
        }
    }
});
window.addEventListener('blur', closeMenu);
function moveKbSelection(down) {
    const usable = menuItems.map((it, i) => (!it.sep && !it.header && (!it.enabled || it.enabled()) ? i : -1)).filter(i => i !== -1);
    const pos = usable.indexOf(kbIdx);
    kbIdx = usable[(pos + (down ? 1 : -1) + usable.length) % usable.length] ?? -1;
    $$('[data-mi]').forEach(b => b.classList.toggle('kb', Number(b.dataset.mi) === kbIdx));
}
function menuKeys(e) {
    if (openMenuIdx === -1)
        return false;
    if (e.key === 'Escape')
        closeMenu();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp')
        moveKbSelection(e.key === 'ArrowDown');
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && openMenuIdx >= 0) {
        openMenu((openMenuIdx + (e.key === 'ArrowRight' ? 1 : -1) + BAR_MENUS.length) % BAR_MENUS.length, true);
    }
    else if (e.key === 'Enter' && kbIdx >= 0)
        activateMenuItem(menuItems[kbIdx]);
    else
        return false;
    e.preventDefault();
    return true;
}
const focused = () => document.activeElement;
document.addEventListener('keydown', e => {
    if (menuKeys(e))
        return;
    if (e.key === 'Escape') {
        if (vibeOn) {
            exitVibe();
            return;
        }
        if (modalOpen()) {
            closeModal();
            return;
        }
        if (findOpen) {
            closeFind();
            activeText()?.ta.focus();
            return;
        }
    }
    if (modalOpen() || vibeOn || $('#ide').classList.contains('hidden'))
        return;
    const isCtrlZ = (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z' && !e.shiftKey;
    const isCtrlY = (e.ctrlKey || e.metaKey) && !e.altKey && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey));
    if (isCtrlZ) {
        const el = focused();
        if (el && el.matches('input, textarea') && !el.classList.contains('ta')) {
            return;
        }
        if (el?.classList.contains('ta')) {
            const topAction = actionUndoStack[actionUndoStack.length - 1];
            const isRecentTreeAction = topAction && topAction.type.startsWith('tree-') &&
                (topAction.timestamp ?? 0) > (lastUserTypeAt || 0);
            if (isRecentTreeAction) {
                e.preventDefault();
                e.stopPropagation();
                void undoAppAction();
                return;
            }
            const b = activeText();
            if (b && b.undo.length > 0) {
                return;
            }
        }
        if (actionUndoStack.length > 0) {
            e.preventDefault();
            e.stopPropagation();
            void undoAppAction();
            return;
        }
        const b = activeText();
        if (b && b.undo.length > 0) {
            e.preventDefault();
            e.stopPropagation();
            stepHistory(b, true);
            return;
        }
    }
    if (isCtrlY) {
        const el = focused();
        if (el && el.matches('input, textarea') && !el.classList.contains('ta')) {
            return;
        }
        if (el?.classList.contains('ta')) {
            const topRedo = actionRedoStack[actionRedoStack.length - 1];
            const isRecentTreeRedo = topRedo && topRedo.type.startsWith('tree-');
            if (isRecentTreeRedo) {
                e.preventDefault();
                e.stopPropagation();
                void redoAppAction();
                return;
            }
            const b = activeText();
            if (b && b.redo.length > 0) {
                return;
            }
        }
        if (actionRedoStack.length > 0) {
            e.preventDefault();
            e.stopPropagation();
            void redoAppAction();
            return;
        }
        const b = activeText();
        if (b && b.redo.length > 0) {
            e.preventDefault();
            e.stopPropagation();
            stepHistory(b, false);
            return;
        }
    }
    const act = keymap.get(comboOf(e));
    if (!act)
        return;
    if (EDITOR_ONLY.has(act) && !focused()?.classList.contains('ta'))
        return;
    if (act === 'explorer.rename' && focused()?.matches('input, textarea'))
        return;
    e.preventDefault();
    run(act);
}, true);
// Alt alone (released without another key) opens the menu bar, like a native app.
let altAlone = false;
document.addEventListener('keydown', e => { altAlone = e.key === 'Alt' && !e.ctrlKey && !e.shiftKey; }, true);
document.addEventListener('keyup', e => {
    if (e.key === 'Alt' && altAlone && !$('#ide').classList.contains('hidden') && !modalOpen()) {
        e.preventDefault();
        if (openMenuIdx === -1)
            openMenu(0, true);
        else
            closeMenu();
    }
    altAlone = false;
}, true);
const SETTINGS_TABS = [
    ['general', 'General', 'gear'],
    ['agents', 'Agents', 'terminal'],
    ['vibe', 'Vibe Code Mode', 'phone'],
    ['discord', 'Discord', 'img:discord.png'],
    ['help', 'Help & About', 'info'],
];
// Agents the user has come first, then this order; anything else keeps its place after.
const AGENT_ORDER = ['claude', 'codex', 'antigravity', 'ollama'];
const agentRank = (a) => (a.found ? 0 : 100) + (AGENT_ORDER.indexOf(a.id) + 1 || AGENT_ORDER.length + 1);
let settingsTab = 'general';
const settingsRoot = () => document.querySelector('#modalRoot .scrim:not(.closing) .settings-modal');
const switchHtml = (id, on, label) => `<button class="switch ${on ? 'on' : ''}" id="${id}" role="switch" aria-checked="${on}" aria-label="${escAttr(label)}"><span></span></button>`;
const settingRow = (title, sub, control) => `<div class="set-row"><div class="set-text"><div class="set-title">${title}</div>${sub ? `<div class="set-sub">${sub}</div>` : ''}</div><div class="set-ctl">${control}</div></div>`;
const segHtml = (id, opts, cur) => `<div class="seg set-seg" id="${id}">${opts.map(([v, l]) => `<button data-v="${v}" class="${v === cur ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>`;
// The account card sits at the top of General.
function accountHtml() {
    const others = accounts.accounts.map(a => `<div class="set-row"><div class="set-text"><div class="set-title">${esc(a.name)}</div><div class="set-sub">${esc(a.provider)}</div></div>
      <div class="set-ctl">${accountKey(a) === accounts.active ? '<span class="pill blue">Active</span>' : `<button class="btn btn-sm" data-switch-acct="${escAttr(accountKey(a))}">Switch</button>`}</div></div>`).join('');
    return `<div class="set-user">${avatarHtml(user, user?.name ?? 'Not signed in')}<div class="set-user-text"><div class="set-title">${user ? esc(user.name) : 'Not signed in'}</div><div class="set-sub">${user ? esc(user.provider) : 'Sign in to sync your name and picture.'}</div></div>
      <div class="set-user-actions"><button class="btn btn-sm" id="sAddAcct">Add account…</button>${user ? '<button class="btn btn-sm" id="sSignOut">Sign out</button>' : ''}</div></div>
    ${others ? `<h5>Accounts</h5>${others}` : ''}`;
}
function settingsBody(tab) {
    switch (tab) {
        case 'general': return `<h4>General</h4>
      ${accountHtml()}
      <h5>Preferences</h5>
      ${settingRow('Workspace', 'Full editor, or chat only.', segHtml('sMode', [['ide', 'Breeze Code'], ['box', 'Breeze Box']], appState.mode))}
      ${settingRow('Sound', 'Clicks, typing ticks and agent chimes.', `<div class="set-volume">${svgIcon('volume', 14)}<input type="range" id="sVolume" min="0" max="100" step="5" value="${sfx.volume}" aria-label="Sound volume" style="--fill:${sfx.volume}%"><span class="set-volume-val" id="sVolumeVal">${sfx.volume}%</span></div>`)}
      <h5>Layout</h5>
      ${settingRow('Side bar', 'Ctrl+B', switchHtml('sSide', layout.sideOpen, 'Side bar'))}
      ${settingRow('Agents panel', 'Ctrl+Alt+B', switchHtml('sAgents', layout.agentsOpen, 'Agents panel'))}
      ${settingRow('Terminal', 'Ctrl+`', switchHtml('sTerm', layout.termOpen, 'Terminal'))}
      ${settingRow('Preview', '', switchHtml('sPreview', layout.previewOpen, 'Preview'))}
      ${settingRow('Reset layout', 'Put every panel back where it started.', '<button class="btn btn-sm" id="sResetLayout">Reset</button>')}`;
        case 'agents': {
            const agents = [...appState.detect?.agents ?? []].sort((a, b) => agentRank(a) - agentRank(b));
            const list = agents.length
                ? agents.map(a => `<button class="set-agent ${a.id === appState.agent ? 'on' : ''}" data-agent-pick="${a.id}" ${a.found ? '' : 'disabled'} title="${escAttr(a.name)} (${escAttr(a.found ? a.version ?? a.vendor : 'not set up')} )">
            ${brandMark('set-agent-mark', a.id, a.name[0])}<span class="nm">${esc(a.name)}</span><span class="set-sub">${a.found ? esc(a.version ?? a.vendor) : 'not set up'}</span></button>`).join('')
                : '<p class="set-sub">No agents found yet. Scan again or run setup.</p>';
            return `<h4>Agents</h4>
        <div class="set-agents">${list}</div>
        ${settingRow('Manage agents', 'Install, sign in and pick models.', '<button class="btn btn-sm" id="sAgentPicker">Open…</button>')}
        ${settingRow('Scan again', 'Look for newly installed tools.', '<button class="btn btn-sm" id="sRescan">Scan</button>')}`;
        }
        case 'vibe': return `<h4>Vibe Code Mode</h4>
      ${settingRow('Vibe Code Mode', 'Play your feed while agents work.', switchHtml('sVibe', appState.vibeArmed, 'Vibe Code Mode'))}
      <h5>Feed</h5><p class="set-sub mb-12">Connect a site to sign in. Click a connected card to make it the one that plays.</p>
      <div class="social-grid" id="sFeeds"></div>`;
        case 'discord': {
            const a = discordActivity();
            const status = { on: 'Connected', off: 'Off', error: 'Not connected' }[discordState.state];
            return `<h4>Discord</h4>
        ${settingRow('Rich presence', `Status: ${status}${discordState.why ? ` · ${esc(discordState.why)}` : ''}`, switchHtml('sDiscord', appState.discord, 'Discord presence'))}
        ${settingRow('Show project and file names', 'Names can include client or employer names.', switchHtml('sDiscordDetails', appState.discordDetails, 'Show project and file names'))}
        <h5>Friends will see</h5>
        <div class="setup-card"><b>Breeze Code</b><div class="text-2">${esc(a.details ?? '')}</div><div class="text-2">${esc(a.state ?? '')}</div><div class="text-3 fs-12">elapsed time</div></div>
        <p class="set-sub">The Discord app must be running on this computer.</p>`;
        }
        case 'help': {
            const where = isDesktop ? 'Desktop app' : 'Browser preview';
            const engine = /Electron\/[\d.]+|Chrome\/[\d.]+/.exec(navigator.userAgent)?.[0] ?? '';
            return `<h4>Help & About</h4>
      ${settingRow('Keyboard shortcuts', '', '<button class="btn btn-sm" data-set-cmd="help.keys">Show</button>')}
      ${settingRow('Run setup again', 'Pick your agent and workspace again.', '<button class="btn btn-sm" data-set-cmd="help.setup">Start</button>')}
      ${settingRow('Developer tools', 'Ctrl+Shift+I', '<button class="btn btn-sm" data-set-cmd="win.devtools">Toggle</button>')}
      ${settingRow('Reload window', 'Ctrl+R', '<button class="btn btn-sm" data-set-cmd="win.reload">Reload</button>')}
      ${settingRow('About Breeze Code', `Smooth as a breeze · ${where}${engine ? ` · ${esc(engine)}` : ''}`, '<span class="pill blue">v0.5.0</span>')}`;
        }
    }
}
function bindSettings(m) {
    const pane = $('.set-pane', m);
    // Switches are rebuilt with the pane, so remember where each one was and replay the move.
    const prevSwitch = new Map();
    pane.querySelectorAll('.switch').forEach(s => prevSwitch.set(s.id, s.classList.contains('on')));
    pane.innerHTML = settingsBody(settingsTab);
    pane.querySelectorAll('.switch').forEach(s => {
        const was = prevSwitch.get(s.id), now = s.classList.contains('on');
        if (was === undefined || was === now)
            return;
        s.classList.toggle('on', was);
        void s.offsetWidth;
        s.classList.toggle('on', now);
        s.classList.add(now ? 'bounce-on' : 'bounce-off');
    });
    $$('[data-set-tab]', m).forEach(b => b.classList.toggle('on', b.dataset.setTab === settingsTab));
    const on = (id, fn) => { const el = $(`#${id}`, pane); if (el)
        el.onclick = () => fn(el); };
    const layoutSwitch = (id, act) => on(id, () => { run(act); refreshSettings(); });
    const seg = (id, fn) => $$(`#${id} button`, pane).forEach(b => b.onclick = () => fn(b.dataset.v ?? ''));
    // General
    seg('sMode', v => { if (v !== appState.mode) {
        closeModal();
        enterMode(v);
    } });
    layoutSwitch('sSide', 'view.toggleSide');
    layoutSwitch('sAgents', 'view.toggleAgents');
    layoutSwitch('sTerm', 'term.toggle');
    layoutSwitch('sPreview', 'view.togglePreview');
    layoutSwitch('sResetLayout', 'view.resetLayout');
    // Agents
    $$('[data-agent-pick]', pane).forEach(b => b.onclick = () => {
        const ag = appState.detect?.agents.find(a => a.id === b.dataset.agentPick);
        if (!ag?.found)
            return;
        appState.agent = ag.id;
        const curTab = surfaceTabs['ide']?.find(t => t.id === activeTabId['ide']);
        if (curTab)
            curTab.agentId = ag.id;
        saveApp();
        renderAgentPill();
        updateScmGenBtn();
        refreshSettings();
    });
    if ($('#sEffort', pane))
        seg('sEffort', v => { setEffort(v); renderAgentPill(); refreshSettings(); });
    on('sAgentPicker', () => openAgentPicker());
    on('sRescan', el => {
        el.textContent = 'Scanning…';
        el.disabled = true;
        detectTools(true).catch(() => { }).finally(refreshSettings);
    });
    // Vibe
    on('sVibe', () => {
        if (appState.vibeArmed) {
            setVibeArmed(false);
            return;
        }
        if (!connectedSites().length) {
            toast('Connect a feed first');
            return;
        }
        setVibeArmed(true);
    });
    const feeds = $('#sFeeds', pane);
    if (feeds)
        void renderFeedChoices(feeds);
    // Discord
    on('sDiscord', el => {
        if (appState.discord) {
            discordOff();
            return;
        }
        el.disabled = true;
        void discordOn(appState.discordDetails).then(refreshSettings);
    });
    on('sDiscordDetails', () => { appState.discordDetails = !appState.discordDetails; saveApp(); queueDiscord(); refreshSettings(); });
    // Sound: drag to set the level, one tick on release so you hear it.
    const vol = $('#sVolume', pane);
    if (vol) {
        vol.oninput = () => {
            sfx.setVolume(+vol.value);
            vol.style.setProperty('--fill', `${vol.value}%`);
            $('#sVolumeVal', pane).textContent = `${vol.value}%`;
        };
        vol.onchange = () => sfx.play('tick');
    }
    // Account
    $$('[data-switch-acct]', pane).forEach(b => b.onclick = () => {
        const a = accounts.accounts.find(x => accountKey(x) === b.dataset.switchAcct);
        if (a)
            background(switchAccount(a).then(refreshSettings));
    });
    on('sAddAcct', () => addAccount());
    on('sSignOut', () => background(signOut().then(refreshSettings)));
    // Help
    $$('[data-set-cmd]', pane).forEach(b => b.onclick = () => { const c = b.dataset.setCmd ?? ''; closeModal(); run(c); });
}
// Redraws the open pane when something changes elsewhere (Discord connects, a feed signs in, …).
function refreshSettings() {
    const m = settingsRoot();
    if (m)
        bindSettings(m);
}
function openSettings(gear, tab) {
    if (settingsRoot()) {
        closeModal();
        return;
    }
    closeMenu();
    if (tab)
        settingsTab = tab;
    const gears = [$('#settingsBtn'), $('#boxSettings')];
    gears.forEach(g => { g.classList.add('open'); g.setAttribute('aria-expanded', 'true'); });
    const nav = SETTINGS_TABS.map(([id, label, icon]) => {
        const iconHtml = icon.startsWith('img:')
            ? '<img class="set-nav-img" src="../../assets/icons/' + icon.slice(4) + '" width="15" height="15" alt="" draggable="false">'
            : svgIcon(icon, 15);
        return '<button data-set-tab="' + id + '">' + iconHtml + '<span>' + esc(label) + '</span></button>';
    }).join('');
    openModal(`<div class="settings-modal" aria-label="Settings">
      <nav class="set-nav"><h3>Settings</h3>${nav}</nav>
      <div class="set-main"><button class="set-close tab-close" data-close title="Close (Esc)" aria-label="Close"><svg class="tab-close-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button><div class="set-pane"></div></div>
    </div>`, m => {
        m.classList.add('settings-shell');
        const root = $('.settings-modal', m);
        $$('[data-set-tab]', root).forEach(b => b.onclick = () => {
            if (settingsTab === b.dataset.setTab)
                return;
            settingsTab = b.dataset.setTab;
            const pane = $('.set-pane', root);
            if (pane) {
                pane.style.animation = 'none';
                void pane.offsetHeight;
                pane.style.animation = '';
            }
            bindSettings(root);
        });
        background(refreshAccounts().then(refreshSettings));
        bindSettings(root);
        gear.blur();
    }, () => gears.forEach(g => { g.classList.remove('open'); g.setAttribute('aria-expanded', 'false'); }));
}
commands['settings.open'] = () => openSettings($('#settingsBtn'));
$('#settingsBtn').onclick = e => openSettings(e.currentTarget);
$('#boxSettings').onclick = e => openSettings(e.currentTarget);
function showShortcuts() {
    const all = [];
    for (const { items } of MENUS) {
        for (const it of items) {
            if (it.key && it.label)
                all.push({ label: it.label, key: it.key });
        }
    }
    all.push({ label: 'Indent / outdent', key: 'Tab / Shift+Tab' }, { label: 'Rename file', key: 'F2' }, { label: 'Menu bar', key: 'Alt' }, { label: 'Reorder tabs', key: 'Drag a tab' });
    openModal(`<h3>Keyboard shortcuts</h3><p class="sub">Drag any panel edge to resize it; drag it closed to hide it.</p>
    <input class="input w-full mb-12" id="shortcutSearch" placeholder="Search keyboard shortcuts…" spellcheck="false" autocomplete="off">
    <div class="kbd-table" id="shortcutList"></div>
    <div class="row end"><button class="btn btn-primary" data-close>Close</button></div>`, m => {
        const input = $('#shortcutSearch', m);
        const list = $('#shortcutList', m);
        input?.focus();
        const render = () => {
            const q = (input?.value || '').toLowerCase().trim();
            const filtered = q
                ? all.filter(s => s.label.toLowerCase().includes(q) || s.key.toLowerCase().includes(q))
                : all;
            if (!filtered.length) {
                list.innerHTML = '<div class="side-note" style="grid-column: 1 / -1; text-align: center; padding: 20px 0;">No matching shortcuts</div>';
            }
            else {
                list.innerHTML = filtered.map(s => `<span>${esc(s.label)}</span><kbd>${esc(s.key)}</kbd>`).join('');
            }
        };
        render();
        if (input)
            input.oninput = render;
    });
}
// Buttons with data-act anywhere in the page run the matching command.
document.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (b && !b.closest('.menu')) {
        e.stopPropagation();
        run(b.dataset.act);
    }
});
/* ================= Agents (UI) ================= */
// No agent cards show until a task is under way. Once the agent answers, the panel says how many
// agents the task needs, and each card appears when that agent starts working.
let team = [];
let teamNeed = 0; // how many agents the current task needs
const TEAM_SIZE = { ask: 1, build: 1, plan: 2 };
const TEAM_LINE = {
    ask: '1 agent on this: <b>Assistant</b> answers without changing files',
    build: '1 agent on this: <b>Builder</b> makes the changes',
    plan: '2 agents on this: <b>Planner</b> writes a plan, then <b>Builder</b> builds it once you approve',
};
// Planner, Builder and Assistant wear the logo of the agent doing the work (Codex, Claude Code…).
function roleMark(k) {
    const chosen = selectedAgent();
    if (!chosen)
        return { letter: agentsDef[k].letter, tint: agentsDef[k].tint };
    return AGENT_STYLE[chosen.id] ?? { letter: chosen.name[0], tint: chosen.id };
}
function teamLineHtml(mode) {
    const chosen = selectedAgent();
    const agentName = chosen?.name ?? 'Assistant';
    if (mode === 'ask') {
        return `1 agent on this: <b>${esc(agentName)}</b> answers without changing files`;
    }
    return TEAM_LINE[mode] ?? '';
}
function renderAgents() {
    const cards = $('#agentCards');
    const shown = new Set($$('[data-agent-card]', cards).map(el => el.dataset.agentCard));
    cards.classList.toggle('hidden', !team.length);
    cards.innerHTML = team.map(k => {
        const a = agentsDef[k];
        const m = roleMark(k);
        return `<div class="agent ${a.status}${shown.has(k) ? '' : ' enter'}" data-agent-card="${k}">
      ${brandMark('ava', m.tint, m.letter)}
      <div><span class="name">${a.name}</span> <span class="fs-11 text-3">${esc(a.model)}</span></div>
      <div class="row gap-4"><span class="status ${a.status}">${statusLabel[a.status]}</span>
        ${a.status === 'working' ? `<button class="icon-btn" title="Stop" data-act="agent.stop">${svgIcon('stop')}</button>` : ''}</div>
      <div class="task">${esc(a.task)}</div>
      <div class="meter" title="${a.used} tool calls"><i class="tint-${a.tint}" data-used="${a.used}"></i></div>
    </div>`;
    }).join('');
    // The meter's fill is set through the DOM: the CSP allows no inline style attributes.
    for (const i of $$('[data-used]', cards))
        i.style.width = `${Math.min(100, Number(i.dataset.used) * 4)}%`;
    const count = $('#agentCount');
    const n = Math.max(teamNeed, team.length);
    count.textContent = String(n);
    count.title = `${plural(n, 'agent')} on this task`;
    count.classList.toggle('hidden', !n);
}
function joinTeam(k) {
    if (team.includes(k))
        return;
    team.push(k);
    renderAgents();
}
function resetTeam() {
    team = [];
    teamNeed = 0;
    setAgent('assistant', 'idle', 'Waiting for a question', 0);
    setAgent('planner', 'idle', 'Waiting for a prompt', 0);
    setAgent('builder', 'idle', 'Waiting for a plan', 0);
}
function setAgent(k, status, task, used) {
    Object.assign(agentsDef[k], { status, task });
    if (used != null)
        agentsDef[k].used = used;
    renderAgents();
    vibeTick();
    queueDiscord();
    const curTab = surfaceTabs[surface.name]?.find(t => t.id === activeTabId[surface.name]);
    if (status === 'working' && curTab?.run?.phase === k)
        showThinking(thinkingLabel(k), k, curTab);
}
const attachmentsMap = { ide: [], box: [] };
const SURFACES = {
    ide: { name: 'ide', chat: $('#chat'), prompt: $('#prompt'), send: $('#send'), mode: $('#agentMode'), attachmentsEl: $('#promptAttachments') },
    box: { name: 'box', chat: $('#boxChat'), prompt: $('#boxPrompt'), send: $('#boxSend'), mode: $('#boxMode'), attachmentsEl: $('#boxPromptAttachments') },
};
let surface = SURFACES.ide; // the one on screen
let msgSurface = surface; // fallback surface
let agentRun = null;
let lastRunFiles = [];
const surfaceTabs = { ide: [], box: [] };
const activeTabId = { ide: '', box: '' };
const createdTabIds = new Set();
function hasAnyActiveRun() {
    for (const list of Object.values(surfaceTabs)) {
        if (list.some(t => t.runId != null))
            return true;
    }
    return false;
}
function getActiveTab(s = surface) {
    const list = surfaceTabs[s.name];
    if (!list.length) {
        const initial = createAgentTab(s);
        activeTabId[s.name] = initial.id;
        initial.panel.classList.add('active');
        renderAgentTabs(s);
        return initial;
    }
    let tab = list.find(t => t.id === activeTabId[s.name]);
    if (!tab) {
        tab = list[0];
        activeTabId[s.name] = tab.id;
        tab.panel.classList.add('active');
        renderAgentTabs(s);
    }
    return tab;
}
function createAgentTab(s, title, initialHtml, session, markNew = false) {
    const count = surfaceTabs[s.name].length + 1;
    const tab = {
        id: 'atab_' + crypto.randomUUID().slice(0, 8),
        surfaceName: s.name,
        title: title || `Chat ${count}`,
        panel: document.createElement('div'),
        runId: null,
        run: null,
        session: session ?? null,
        sessionAgent: session ? appState.agent : null,
        agentId: appState.agent || 'antigravity',
        uiMode: s.mode?.value || 'plan',
        promptDraft: '',
        attachments: [],
    };
    tab.panel.className = 'agent-tab-panel';
    if (initialHtml) {
        tab.panel.innerHTML = initialHtml;
    }
    else if (s.name === 'box') {
        const agent = selectedAgent();
        const who = agent ? `Breeze Box talks to ${esc(agent.name)}. Pick another agent below.` : 'Pick an agent below to start.';
        tab.panel.innerHTML = `<div class="empty"><div><img src="../../assets/brand/Agent.png" alt="" width="56" height="56"><h4>What can I help with?</h4><div>${who}</div></div></div>`;
    }
    else {
        tab.panel.innerHTML = `<div class="empty"><div><img src="../../assets/brand/Agent.png" alt="" width="40" height="40"><h4>Your agents are ready</h4><div>Tell them what to build. They'll ask if anything's unclear.</div></div></div>`;
    }
    s.chat.appendChild(tab.panel);
    surfaceTabs[s.name].push(tab);
    if (markNew)
        createdTabIds.add(tab.id);
    renderAgentTabs(s);
    return tab;
}
const agentInkAt = { ide: null, box: null };
function placeAgentTabInk(s) {
    const tabsList = s.name === 'box' ? $('#boxAgentTabsList') : $('#agentTabsList');
    if (!tabsList)
        return;
    const on = tabsList.querySelector('.agent-tab.active:not(.leaving)');
    const old = tabsList.querySelector('.agent-tab-ink');
    if (!on) {
        if (old) {
            old.style.opacity = '0';
            setTimeout(() => old.remove(), 120);
        }
        agentInkAt[s.name] = null;
        return;
    }
    const ink = old ?? tabsList.appendChild(Object.assign(document.createElement('span'), { className: 'agent-tab-ink' }));
    ink.style.opacity = '1';
    const next = {
        x: on.offsetLeft + 8,
        y: on.offsetTop + on.offsetHeight - 2,
        w: Math.max(0, on.offsetWidth - 16)
    };
    const draw = (p) => {
        ink.style.transform = `translate(${p.x}px, ${p.y}px)`;
        ink.style.width = `${p.w}px`;
    };
    if (agentInkAt[s.name]) {
        ink.style.transition = 'none';
        draw(agentInkAt[s.name]);
        const _reflow = ink.offsetWidth;
        ink.style.transition = '';
    }
    draw(next);
    agentInkAt[s.name] = next;
}
function renderAgentTabs(s) {
    const tabsList = s.name === 'box' ? $('#boxAgentTabsList') : $('#agentTabsList');
    if (!tabsList)
        return;
    const list = surfaceTabs[s.name];
    const curId = activeTabId[s.name];
    const isMulti = list.length > 1;
    const currentTabIds = new Set(list.map(t => t.id));
    tabsList.querySelectorAll('.agent-tab').forEach(el => {
        const tid = el.dataset.agentTab;
        if (tid && !currentTabIds.has(tid) && !el.classList.contains('leaving')) {
            el.remove();
        }
    });
    list.forEach(t => {
        const isActive = t.id === curId;
        const isRunning = t.runId != null;
        let el = tabsList.querySelector(`[data-agent-tab="${t.id}"]`);
        if (!el) {
            const newEl = document.createElement('div');
            newEl.dataset.agentTab = t.id;
            newEl.className = `agent-tab ${isActive ? 'active' : ''} ${isRunning ? 'running' : 'idle'} ${isMulti ? 'closable' : 'single'}`;
            newEl.innerHTML = `
        <span class="tab-status" aria-hidden="true"></span>
        <span class="tab-title">${esc(t.title)}</span>
        <button class="tab-close" type="button" data-close-tab="${escAttr(t.id)}" title="Close tab" aria-label="Close tab">
          <svg class="tab-close-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      `;
            if (createdTabIds.has(t.id)) {
                newEl.classList.add('enter');
                newEl.addEventListener('animationend', () => {
                    newEl.classList.remove('enter');
                    placeAgentTabInk(s);
                }, { once: true });
                createdTabIds.delete(t.id);
            }
            newEl.onclick = (e) => {
                const target = e.target;
                if (target.closest('[data-close-tab]') || newEl.classList.contains('leaving'))
                    return;
                switchAgentTab(s, t.id);
            };
            const closeBtn = newEl.querySelector('[data-close-tab]');
            if (closeBtn) {
                closeBtn.onclick = (e) => {
                    e.stopPropagation();
                    closeAgentTab(s, t.id);
                };
            }
            tabsList.appendChild(newEl);
        }
        else {
            el.classList.toggle('active', isActive);
            el.classList.toggle('running', isRunning);
            el.classList.toggle('idle', !isRunning);
            el.classList.remove('unread');
            el.classList.toggle('closable', isMulti);
            el.classList.toggle('single', !isMulti);
            el.removeAttribute('title');
            const titleSpan = el.querySelector('.tab-title');
            if (titleSpan && titleSpan.textContent !== t.title) {
                titleSpan.textContent = t.title;
            }
            const statusSpan = el.querySelector('.tab-status');
            if (statusSpan) {
                statusSpan.title = isRunning ? 'Working...' : '';
            }
            tabsList.appendChild(el);
        }
    });
    placeAgentTabInk(s);
}
function switchAgentTab(s, tid) {
    const current = getActiveTab(s);
    if (current && current.id !== tid) {
        current.promptDraft = s.prompt.value;
        current.uiMode = s.mode.value;
        current.attachments = [...(attachmentsMap[s.name] || [])];
        current.panel.classList.remove('active');
    }
    const next = surfaceTabs[s.name].find(t => t.id === tid);
    if (!next)
        return;
    activeTabId[s.name] = next.id;
    next.unreadDone = false;
    next.panel.classList.add('active');
    if (s.name === 'ide' && next.agentId && appState.agent !== next.agentId) {
        appState.agent = next.agentId;
        saveApp();
        renderAgentPill();
    }
    s.prompt.value = next.promptDraft || '';
    s.mode.value = next.uiMode || 'plan';
    attachmentsMap[s.name] = next.attachments || [];
    renderAttachments(s);
    updateTabBusyState(s, next);
    renderAgentTabs(s);
    scrollChat(s);
    s.prompt.focus();
    updateScmGenBtn();
}
function closeAgentTab(s, tid) {
    const idx = surfaceTabs[s.name].findIndex(t => t.id === tid);
    if (idx === -1)
        return;
    const tab = surfaceTabs[s.name][idx];
    archiveChatTab(s, tab);
    if (tab.runId != null) {
        background(api.agent.stop(tab.runId));
    }
    const tabsList = s.name === 'box' ? $('#boxAgentTabsList') : $('#agentTabsList');
    const tabEl = tabsList?.querySelector(`[data-agent-tab="${tid}"]`);
    const finalize = () => {
        tab.panel.remove();
        const curIdx = surfaceTabs[s.name].findIndex(t => t.id === tid);
        if (curIdx !== -1)
            surfaceTabs[s.name].splice(curIdx, 1);
        tabEl?.remove();
        if (surfaceTabs[s.name].length === 0) {
            const newTab = createAgentTab(s);
            activeTabId[s.name] = newTab.id;
            newTab.panel.classList.add('active');
            updateTabBusyState(s, newTab);
        }
        else if (activeTabId[s.name] === tid) {
            const nextIdx = Math.min(idx, surfaceTabs[s.name].length - 1);
            const nextTab = surfaceTabs[s.name][nextIdx];
            activeTabId[s.name] = nextTab.id;
            nextTab.panel.classList.add('active');
            updateTabBusyState(s, nextTab);
        }
        renderAgentTabs(s);
    };
    if (tabEl && !tabEl.classList.contains('leaving')) {
        if (activeTabId[s.name] === tid && surfaceTabs[s.name].length > 1) {
            const nextIdx = idx === surfaceTabs[s.name].length - 1 ? idx - 1 : idx + 1;
            const nextTab = surfaceTabs[s.name][nextIdx];
            if (nextTab) {
                activeTabId[s.name] = nextTab.id;
                nextTab.unreadDone = false;
                tab.panel.classList.remove('active');
                nextTab.panel.classList.add('active');
                s.prompt.value = nextTab.promptDraft || '';
                s.mode.value = nextTab.uiMode || 'plan';
                attachmentsMap[s.name] = nextTab.attachments || [];
                renderAttachments(s);
                updateTabBusyState(s, nextTab);
            }
        }
        const w = tabEl.getBoundingClientRect().width;
        tabEl.style.width = `${w}px`;
        tabEl.style.maxWidth = `${w}px`;
        const _reflow = tabEl.offsetWidth;
        tabEl.classList.add('leaving');
        if (surfaceTabs[s.name].length === 2) {
            const remainingTab = surfaceTabs[s.name].find(t => t.id !== tid);
            if (remainingTab) {
                const remainingEl = tabsList?.querySelector(`[data-agent-tab="${remainingTab.id}"]`);
                if (remainingEl) {
                    remainingEl.classList.remove('closable');
                    remainingEl.classList.add('single');
                }
            }
        }
        renderAgentTabs(s);
        let finished = false;
        const onEnd = () => {
            if (finished)
                return;
            finished = true;
            finalize();
        };
        tabEl.addEventListener('transitionend', onEnd, { once: true });
        setTimeout(onEnd, 220);
    }
    else {
        finalize();
    }
}
function updateTabBusyState(s, tab) {
    const t = tab || getActiveTab(s);
    const on = t.runId != null;
    s.send.classList.toggle('stop', on);
    void setIcon(s.send, on ? 'stop' : 'send');
    const span = $('span', s.send);
    if (span)
        span.textContent = on ? 'Stop' : 'Send';
    s.send.title = on ? 'Stop the agent' : 'Send (Enter)';
    s.prompt.closest('.composer-box')?.classList.toggle('busy', on);
}
function setBusy(on) {
    updateTabBusyState(surface);
}
function newAgentTabAction(s = surface) {
    const cur = getActiveTab(s);
    if (cur)
        archiveChatTab(s, cur);
    const newTab = createAgentTab(s, undefined, undefined, null, true);
    switchAgentTab(s, newTab.id);
    const bar = s.name === 'box' ? $('#boxAgentTabsBar') : $('#agentTabsBar');
    bar?.scrollTo({ left: bar.scrollWidth, behavior: 'smooth' });
}
function useSurface(name) {
    surface = SURFACES[name];
    msgSurface = surface;
}
function scrollChat(s) {
    const scroller = s.name === 'box' ? $('.box-main') : s.chat;
    if (scroller)
        scroller.scrollTop = scroller.scrollHeight;
}
function addMsg(html, tab) {
    const t = tab || getActiveTab(msgSurface);
    const d = document.createElement('div');
    d.innerHTML = html;
    const el = d.firstElementChild;
    const thinking = t.panel.querySelector('.thinking');
    if (thinking) {
        t.panel.insertBefore(el, thinking);
    }
    else {
        t.panel.appendChild(el);
    }
    if (t.id === activeTabId[t.surfaceName]) {
        scrollChat(SURFACES[t.surfaceName]);
    }
    saveChat(t);
    return el;
}
const clockTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function speaker(k, s = msgSurface) {
    const chosen = selectedAgent();
    if (chosen && (s.name === 'box' || k === 'assistant')) {
        const st = AGENT_STYLE[chosen.id] ?? { letter: chosen.name[0], tint: chosen.id };
        return { name: chosen.name, ...st };
    }
    return { name: agentsDef[k].name, ...roleMark(k) };
}
function agentMsg(k, html, tab) {
    const t = tab || getActiveTab(msgSurface);
    const { name, letter, tint } = speaker(k, SURFACES[t.surfaceName]);
    sfx.play('msg');
    return addMsg(`<div class="msg"><div class="meta">${brandMark('avatar mini', tint, letter)}<b>${esc(name)}</b> ${clockTime()}</div><div class="body">${html}</div></div>`, t);
}
function userMsg(text, attachments, tab) {
    const t = tab || getActiveTab(msgSurface);
    let imgHtml = '';
    if (attachments?.length) {
        const items = attachments.map(a => {
            const kind = a.kind || (a.dataUrl || (a.fileUrl && IMAGE_FILE.test(a.name)) ? 'image' : 'file');
            const p = a.path || a.fileRel || a.name;
            if (kind === 'folder') {
                return `<div class="chat-file-chip folder" data-path="${escAttr(p)}" title="Folder: ${escAttr(p)} (click to reveal)"><span class="ico">${folderIcon(a.name, false)}</span><span class="nm">${esc(p)}</span></div>`;
            }
            if (kind === 'file') {
                return `<div class="chat-file-chip file" data-path="${escAttr(p)}" title="File: ${escAttr(p)} (click to open)"><span class="ico">${fileIcon(a.name)}</span><span class="nm">${esc(p)}</span></div>`;
            }
            const src = a.fileUrl || a.dataUrl || '';
            return `<div class="chat-img-wrap" title="Click to view full size"><img src="${escAttr(src)}" class="chat-img" alt="${escAttr(a.name)}" data-full="${escAttr(src)}"></div>`;
        }).join('');
        imgHtml = `<div class="msg-attachments">${items}</div>`;
    }
    const bodyText = text ? `<div>${esc(text).replaceAll('\n', '<br>')}</div>` : '';
    addMsg(`<div class="msg user"><div class="meta"><b>${esc(user?.name ?? 'You')}</b> ${clockTime()}</div><div class="body">${bodyText}${imgHtml}</div></div>`, t);
}
function thinkingLabel(k) {
    const who = speaker(k).name;
    const task = agentsDef[k].task;
    return msgSurface.name === 'box' || !task ? `${who} is thinking` : `${who} · ${task}`;
}
function showThinking(label, k = 'assistant', tab) {
    const t = tab || getActiveTab(msgSurface);
    let el = t.panel.querySelector('.thinking');
    if (!el) {
        el = document.createElement('div');
        el.className = 'thinking';
        el.setAttribute('role', 'status');
        el.innerHTML = '<span class="avatar mini"></span><span class="lbl"></span><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>';
        t.panel.appendChild(el);
        if (t.id === activeTabId[t.surfaceName])
            scrollChat(SURFACES[t.surfaceName]);
    }
    const { letter, tint } = speaker(k, SURFACES[t.surfaceName]);
    const avatar = $('.avatar', el);
    if (avatar)
        avatar.outerHTML = brandMark('avatar mini', tint, letter);
    const lbl = $('.lbl', el);
    if (lbl)
        lbl.textContent = label;
}
function hideThinking(tab) {
    if (tab) {
        tab.panel.querySelector('.thinking')?.remove();
    }
    else {
        for (const list of Object.values(surfaceTabs)) {
            for (const t of list)
                t.panel.querySelector('.thinking')?.remove();
        }
    }
}
function emptyChat(s = SURFACES.ide, tab) {
    const t = tab || getActiveTab(s);
    if (s.name === 'box') {
        const agent = selectedAgent();
        const who = agent ? `Breeze Box talks to ${esc(agent.name)}. Pick another agent below.` : 'Pick an agent below to start.';
        t.panel.innerHTML = `<div class="empty"><div><img src="../../assets/brand/Agent.png" alt="" width="56" height="56"><h4>What can I help with?</h4><div>${who}</div></div></div>`;
        return;
    }
    t.panel.innerHTML = `<div class="empty"><div><img src="../../assets/brand/Agent.png" alt="" width="40" height="40"><h4>Your agents are ready</h4><div>Tell them what to build. They'll ask if anything's unclear.</div></div></div>`;
}
// A small, safe subset of Markdown for agent replies: inline code, bold and line breaks. Fenced code blocks
// become artifacts: a card with the file name, Copy and Download. A fence may name its file: ```html index.html
const inlineMd = (s) => esc(s).replaceAll(/`([^`\n]+)`/g, '<code>$1</code>').replaceAll(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replaceAll('\n', '<br>');
function md(text) {
    const out = [];
    let last = 0;
    // An unclosed fence (the reply was cut off) still shows its code.
    for (const m of text.matchAll(/```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g)) {
        out.push(inlineMd(text.slice(last, m.index)), artifactHtml(m[1].trim(), m[2].replace(/\n$/, '')));
        last = m.index + m[0].length;
    }
    out.push(inlineMd(text.slice(last)));
    return out.join('');
}
const LANG_EXT = {
    javascript: 'js', js: 'js', jsx: 'jsx', typescript: 'ts', ts: 'ts', tsx: 'tsx', python: 'py', py: 'py', html: 'html', css: 'css',
    json: 'json', markdown: 'md', md: 'md', bash: 'sh', sh: 'sh', shell: 'sh', powershell: 'ps1', ps1: 'ps1', c: 'c', cpp: 'cpp', 'c++': 'cpp',
    java: 'java', go: 'go', rust: 'rs', rs: 'rs', sql: 'sql', yaml: 'yml', yml: 'yml', xml: 'xml', svg: 'svg', csharp: 'cs', cs: 'cs', php: 'php', ruby: 'rb',
};
// "html index.html", "index.html" or "python": the file name to show and to save as.
function artifactName(info) {
    const [first = '', second = ''] = info.split(/\s+/);
    const named = [second, first].find(t => /^[\w.-]+\.\w+$/.test(t) && !/^\.+$/.test(t));
    if (named)
        return named;
    return `snippet.${LANG_EXT[first.toLowerCase()] ?? 'txt'}`;
}
function artifactHtml(info, code) {
    const name = artifactName(info);
    const lines = code ? code.split('\n').length : 0;
    return `<div class="artifact"><div class="artifact-head"><span class="ico">${fileIcon(name)}</span><span class="artifact-name">${esc(name)}</span><span class="artifact-meta">${plural(lines, 'line')}</span>`
        + `<button class="icon-btn" data-artifact="copy" title="Copy">${svgIcon('copy')}</button><button class="icon-btn" data-artifact="download" title="Download ${escAttr(name)}">${svgIcon('download')}</button></div>`
        + `<pre>${esc(code)}</pre></div>`;
}
// Works for replies restored from a saved chat too: the code is read back from the card itself.
document.addEventListener('click', e => {
    const btn = e.target.closest('[data-artifact]');
    const card = btn?.closest('.artifact');
    if (!btn || !card)
        return;
    const code = $('pre', card).textContent ?? '';
    const name = $('.artifact-name', card).textContent ?? 'snippet.txt';
    if (btn.dataset.artifact === 'copy') {
        navigator.clipboard.writeText(code).then(() => {
            void setIcon(btn, 'check');
            setTimeout(() => void setIcon(btn, 'copy'), 1400);
        }, () => toast('Couldn’t copy to the clipboard'));
        return;
    }
    const url = URL.createObjectURL(new Blob([code], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
});
const TOOL_ICON = { read: 'eye', edit: 'pencil', run: 'terminal', search: 'search', web: 'globe', todo: 'todo', agent: 'diamond', tool: 'dot', note: 'info' };
function toolLine(kind, label, tab) {
    sfx.play('tool');
    addMsg(`<div class="tool-line ${kind}"><span class="ti">${svgIcon(TOOL_ICON[kind] ?? 'dot', 14)}</span><span class="tl">${esc(label)}</span></div>`, tab);
}
// The open chat is kept per project folder (and once for Breeze Box) so a reload brings it back.
const chatScope = (s) => (s.name === 'box' ? 'box' : rootInfo?.root ?? '');
const chatKey = (s = msgSurface) => `breeze.chat:${chatScope(s)}`;
const agentSessionKey = (s = msgSurface) => `breeze.agentSession:${chatScope(s)}:${appState.agent ?? ''}`;
const historyKey = (s) => `breeze.history:${chatScope(s)}`;
const chatIdKey = (s) => `breeze.chatId:${chatScope(s)}`;
const HISTORY_MAX = 30, HISTORY_BYTES = 1_500_000;
const newChatId = () => crypto.randomUUID();
const chatHistory = (s) => store.get(historyKey(s), []);
function archiveChatTab(s, tab) {
    if (s.name === 'ide' && !rootInfo)
        return;
    if (tab.panel.querySelector('.empty') && !tab.panel.querySelector('.msg'))
        return;
    const html = [...tab.panel.children].filter(c => !c.classList.contains('thinking')).map(c => c.outerHTML).join('');
    if (!html?.includes('class="msg'))
        return;
    if (!tab.historyId)
        tab.historyId = newChatId();
    const id = tab.historyId;
    const first = tab.panel.querySelector('.msg.user .body')?.textContent ?? tab.title ?? 'Chat';
    const title = first.trim().replaceAll(/\s+/g, ' ').slice(0, 64) || tab.title || 'Chat';
    const entry = { id, title, at: Date.now(), html, agent: tab.agentId || appState.agent, session: tab.session ?? null };
    let bytes = 0;
    const list = [entry, ...chatHistory(s).filter(e => e.id !== id)].filter(e => (bytes += e.html.length) < HISTORY_BYTES).slice(0, HISTORY_MAX);
    store.set(historyKey(s), list);
}
function archiveChat(s) {
    const t = getActiveTab(s);
    if (t)
        archiveChatTab(s, t);
}
// The chat's saveable HTML; empty when there is nothing to keep.
function chatHtml(s) {
    const t = getActiveTab(s);
    if (t.panel.querySelector('.empty'))
        return '';
    return [...t.panel.children].filter(c => !c.classList.contains('thinking')).map(c => c.outerHTML).join('');
}
let chatTimer;
function saveChat(tab) {
    clearTimeout(chatTimer);
    const t = tab || getActiveTab(msgSurface);
    chatTimer = setTimeout(() => {
        if (t.surfaceName === 'ide' && !rootInfo)
            return;
        const s = SURFACES[t.surfaceName];
        archiveChatTab(s, t);
    }, 400);
}
function restoreChat(s = SURFACES.ide) {
    const html = store.get(chatKey(s), '');
    // If an earlier session was stored in chatKey, archive it into chat history so it is never lost
    if (html?.includes('msg')) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;
        const first = tempDiv.querySelector('.msg.user .body')?.textContent ?? 'Chat';
        const title = first.trim().replaceAll(/\s+/g, ' ').slice(0, 64) || 'Chat';
        const entry = {
            id: newChatId(),
            title,
            at: Date.now(),
            html,
            agent: appState.agent,
            session: store.get(agentSessionKey(s), null),
        };
        let bytes = 0;
        const existing = chatHistory(s);
        if (!existing.some(e => e.title === title && Math.abs(e.at - entry.at) < 60000)) {
            const list = [entry, ...existing.filter(e => e.id !== entry.id)].filter(e => (bytes += e.html.length) < HISTORY_BYTES).slice(0, HISTORY_MAX);
            store.set(historyKey(s), list);
        }
    }
    // Clear lingering chatKey so startup is always clean and never resurrects ghost chats
    store.del(chatKey(s));
    surfaceTabs[s.name] = [];
    s.chat.innerHTML = '';
    // Fresh, clean initial chat tab
    const initial = createAgentTab(s, 'Chat 1');
    activeTabId[s.name] = initial.id;
    initial.panel.classList.add('active');
    renderAgentTabs(s);
    scrollChat(s);
}
function openChat(s, e) {
    const cur = getActiveTab(s);
    const isCurEmpty = !cur.runId && (cur.panel.querySelector('.empty') || !cur.panel.children.length);
    const tab = isCurEmpty ? cur : createAgentTab(s, e.title);
    tab.title = e.title;
    tab.historyId = e.id;
    tab.session = (e.session && e.agent === appState.agent) ? e.session : null;
    tab.sessionAgent = tab.session ? e.agent : null;
    tab.panel.innerHTML = e.html;
    $$('[data-live]', tab.panel).forEach(el => { el.outerHTML = '<div class="resolved">Earlier session</div>'; });
    switchAgentTab(s, tab.id);
    resetTeam();
    s.prompt.focus();
}
function timeAgo(at) {
    const m = Math.round((Date.now() - at) / 60000);
    if (m < 1)
        return 'just now';
    if (m < 60)
        return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24)
        return `${h}h ago`;
    const d = Math.round(h / 24);
    return d < 30 ? `${d}d ago` : new Date(at).toLocaleDateString();
}
function showHistory(s, anchor) {
    if (anchor.classList.contains('open') || (justClosedTrigger === anchor && Date.now() - justClosedAt < 350)) {
        closeMenu();
        return;
    }
    closeMenu();
    const list = chatHistory(s);
    const items = list.length
        ? list.map(e => ({ label: e.title, key: timeAgo(e.at), run: () => openChat(s, e) }))
        : [{ label: 'No earlier chats yet', enabled: () => false }];
    if (list.length)
        items.push({ sep: true }, { label: 'Clear chat history', run: () => { store.del(historyKey(s)); toast('Chat history cleared'); } });
    const r = anchor.getBoundingClientRect();
    anchor.classList.add('open');
    popupMenu(r.right - 300, r.bottom + 4, items, () => anchor.classList.remove('open'), anchor);
    $('#menuRoot .menu')?.classList.add('history-menu');
}
$('#chatHistory').onclick = e => showHistory(SURFACES.ide, e.currentTarget);
$('#boxHistory').onclick = e => showHistory(SURFACES.box, e.currentTarget);
commands['chat.history'] = () => showHistory(surface, surface.name === 'box' ? $('#boxHistory') : $('#chatHistory'));
function renderAttachments(s) {
    const list = attachmentsMap[s.name] || [];
    if (!list.length) {
        s.attachmentsEl.classList.remove('collapsing');
        s.attachmentsEl.classList.add('hidden');
        s.attachmentsEl.innerHTML = '';
        return;
    }
    s.attachmentsEl.classList.remove('hidden', 'collapsing');
    s.attachmentsEl.innerHTML = list.map(a => {
        const kind = a.kind || (a.dataUrl || (a.fileUrl && IMAGE_FILE.test(a.name)) ? 'image' : 'file');
        let thumbHtml = '';
        if (kind === 'image') {
            const src = a.dataUrl || a.fileUrl || '';
            thumbHtml = `<img src="${escAttr(src)}" class="attachment-thumb" alt="${escAttr(a.name)}" title="Click to preview">`;
        }
        else if (kind === 'folder') {
            thumbHtml = `<span class="attachment-thumb attachment-icon folder-icon" title="Folder: ${escAttr(a.path || a.name)}">${folderIcon(a.name, false)}</span>`;
        }
        else {
            thumbHtml = `<span class="attachment-thumb attachment-icon file-icon" title="File: ${escAttr(a.path || a.name)}">${fileIcon(a.name)}</span>`;
        }
        const displayName = a.path || a.name;
        return `
      <div class="attachment-chip ${kind}-chip" data-att-id="${escAttr(a.id)}" data-path="${escAttr(a.path || '')}" title="${escAttr(displayName)}">
        ${thumbHtml}
        <span class="attachment-name" title="${escAttr(displayName)}">${esc(displayName)}</span>
        <button class="attachment-del" type="button" title="Remove" data-del-id="${escAttr(a.id)}">✕</button>
      </div>
    `;
    }).join('');
    $$('[data-del-id]', s.attachmentsEl).forEach(btn => {
        btn.onclick = async (e) => {
            e.stopPropagation();
            const id = btn.dataset.delId;
            const chip = btn.closest('.attachment-chip');
            const list = attachmentsMap[s.name] || [];
            const idx = list.findIndex(x => x.id === id);
            const att = list[idx];
            if (!att)
                return;
            const tab = getActiveTab(s);
            pushAppAction({
                type: 'remove-attachment',
                surface: s.name,
                tabId: tab.id,
                attachment: att,
                index: idx,
            });
            sfx.play('close');
            const isLast = list.length <= 1;
            if (chip) {
                chip.classList.add('leaving');
                if (isLast)
                    s.attachmentsEl.classList.add('collapsing');
                await new Promise(r => setTimeout(r, 270));
            }
            attachmentsMap[s.name] = (attachmentsMap[s.name] || []).filter(x => x.id !== id);
            tab.attachments = [...(attachmentsMap[s.name] || [])];
            s.attachmentsEl.classList.remove('collapsing');
            renderAttachments(s);
            toast(`Removed · ${att.name}`);
        };
    });
    $$('.attachment-chip', s.attachmentsEl).forEach(chip => {
        chip.onclick = e => {
            const target = e.target;
            if (target.closest('.attachment-del'))
                return;
            const id = chip.dataset.attId;
            const att = (attachmentsMap[s.name] || []).find(x => x.id === id);
            if (!att?.path)
                return;
            if (att.kind === 'folder') {
                expanded.add(att.path);
                renderTree();
                toast(`Revealed folder · ${att.path}`);
            }
            else if (att.kind === 'file') {
                openFile(att.path);
            }
        };
    });
}
async function addPastedImage(file, s, tab) {
    const targetTab = tab || getActiveTab(s);
    const dataUrl = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = rej;
        fr.readAsDataURL(file);
    });
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const extMap = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
    const ext = extMap[file.type] ?? 'png';
    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const name = file.name && file.name !== 'image.png' ? file.name : `image_${ts}.${ext}`;
    let fileRel;
    let fileUrl;
    try {
        fileRel = await api.fs.importFile('attachments', name, bytes);
        if (fileRel)
            fileUrl = await api.fs.fileUrl(fileRel);
    }
    catch {
        // In browser demo or if import fails, keep dataUrl
    }
    const att = { id: crypto.randomUUID().slice(0, 8), name, kind: 'image', dataUrl, fileUrl, fileRel, path: fileRel };
    attachmentsMap[s.name].push(att);
    targetTab.attachments = [...attachmentsMap[s.name]];
    renderAttachments(s);
    s.prompt.focus();
    toast(`Image attached · ${name}`);
}
async function attachPathToAgent(rawPath, isDir, s, tab) {
    const targetTab = tab || getActiveTab(s);
    const cleanPath = rawPath.replaceAll('\\', '/').replace(/\/$/, '');
    const name = baseName(cleanPath) || cleanPath;
    const list = attachmentsMap[s.name] || [];
    if (list.some(a => (a.path?.toLowerCase() === cleanPath.toLowerCase()) || (a.fileRel?.toLowerCase() === cleanPath.toLowerCase()))) {
        toast(`Already attached · ${name}`);
        return false;
    }
    let kind = 'file';
    if (isDir) {
        kind = 'folder';
    }
    else if (IMAGE_FILE.test(name)) {
        kind = 'image';
    }
    let fileUrl;
    if (kind === 'image') {
        try {
            fileUrl = await api.fs.fileUrl(cleanPath);
        }
        catch { }
    }
    const att = {
        id: crypto.randomUUID().slice(0, 8),
        name,
        kind,
        path: cleanPath,
        fileRel: cleanPath,
        fileUrl,
        dataUrl: fileUrl,
    };
    list.push(att);
    attachmentsMap[s.name] = list;
    targetTab.attachments = [...list];
    renderAttachments(s);
    s.prompt.focus();
    const labelMap = { folder: 'Folder', image: 'Image', file: 'File' };
    const label = labelMap[kind] ?? 'File';
    toast(`${label} attached · ${name}`);
    return true;
}
async function handleAgentDrop(e, ag) {
    clearAgentDropMarks();
    let targetTab;
    if (ag.isNewTab) {
        targetTab = createAgentTab(ag.surface, undefined, undefined, null, true);
        activeTabId[ag.surface.name] = targetTab.id;
        switchAgentTab(ag.surface, targetTab.id);
    }
    else if (ag.tab) {
        if (ag.tab.id !== activeTabId[ag.surface.name]) {
            switchAgentTab(ag.surface, ag.tab.id);
        }
        targetTab = ag.tab;
    }
    else {
        targetTab = getActiveTab(ag.surface);
    }
    if (draggedTreePath) {
        const p = draggedTreePath;
        const isDir = draggedTreeIsDir;
        draggedTreePath = null;
        draggedTreeIsDir = false;
        await attachPathToAgent(p, isDir, ag.surface, targetTab);
        return;
    }
    if (e.dataTransfer) {
        await handleAgentDroppedFiles(e.dataTransfer, ag.surface, targetTab);
    }
}
async function handleAgentDroppedFiles(dt, s, tab) {
    const targetTab = tab || getActiveTab(s);
    const items = Array.from(dt.items || []);
    const files = Array.from(dt.files || []);
    const entries = items.map(i => {
        try {
            return i.webkitGetAsEntry();
        }
        catch {
            return null;
        }
    }).filter((x) => !!x);
    if (entries.length > 0) {
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const file = files[i];
            const diskPath = file ? getDroppedFilePath(file) : '';
            const rel = diskPath && rootInfo ? toRelProject(diskPath) : null;
            if (entry.isDirectory) {
                const folderPath = rel || diskPath || entry.name;
                await attachPathToAgent(folderPath, true, s, targetTab);
            }
            else if (entry.isFile) {
                if (file && (file.type.startsWith('image/') || IMAGE_FILE.test(file.name))) {
                    await addPastedImage(file, s, targetTab);
                }
                else {
                    const filePath = rel || diskPath || entry.name;
                    await attachPathToAgent(filePath, false, s, targetTab);
                }
            }
        }
        return;
    }
    for (const file of files) {
        const diskPath = getDroppedFilePath(file);
        const rel = diskPath && rootInfo ? toRelProject(diskPath) : null;
        if (file.type.startsWith('image/') || IMAGE_FILE.test(file.name)) {
            await addPastedImage(file, s, targetTab);
        }
        else {
            const filePath = rel || diskPath || file.name;
            await attachPathToAgent(filePath, false, s, targetTab);
        }
    }
}
for (const s of Object.values(SURFACES)) {
    s.send.onclick = () => {
        const tab = getActiveTab(s);
        if (tab.runId != null)
            stopAgent(tab);
        else
            void sendPrompt();
    };
    s.prompt.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void sendPrompt();
    } });
    const box = s.prompt.closest('.composer-box');
    if (box) {
        box.addEventListener('dragover', e => {
            if (hasFiles(e) || draggedTreePath) {
                e.preventDefault();
                box.classList.add('drag-over');
                if (e.dataTransfer)
                    e.dataTransfer.dropEffect = 'copy';
            }
        });
        box.addEventListener('dragleave', () => box.classList.remove('drag-over'));
        box.addEventListener('drop', async (e) => {
            clearAgentDropMarks();
            box.classList.remove('drag-over');
            e.preventDefault();
            e.stopPropagation();
            await handleAgentDrop(e, { el: box, surface: s, tab: getActiveTab(s) });
        });
    }
}
// Copy-paste image into agent tab (IDE aside/composer) or Breeze Box
document.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items;
    const filesList = e.clipboardData?.files;
    const imgItem = items ? [...items].find(it => it.type.startsWith('image/')) : null;
    const imgFile = !imgItem && filesList?.length ? [...filesList].find(x => x.type.startsWith('image/') || IMAGE_FILE.test(x.name)) : null;
    if (!imgItem && !imgFile)
        return;
    const target = e.target;
    const activeEl = document.activeElement;
    const inBox = !!(target?.closest('#box, .box-composer') || activeEl === SURFACES.box.prompt || appState.mode === 'box');
    const inIde = !!(target?.closest('#agents, .composer') || activeEl === SURFACES.ide.prompt || (!inBox && appState.mode === 'ide'));
    if (!inBox && !inIde)
        return;
    if (activeEl?.classList.contains('ta') && !target?.closest('#agents, #box, .composer, .box-composer'))
        return;
    const targetSurface = inBox ? SURFACES.box : SURFACES.ide;
    const file = imgItem ? imgItem.getAsFile() : (imgFile || null);
    if (!file)
        return;
    e.preventDefault();
    await addPastedImage(file, targetSurface);
});
// Click thumbnail or chat image to view full size modal, or click chat chip to open file / reveal folder
document.addEventListener('click', e => {
    const target = e.target;
    const chip = target.closest('.chat-file-chip');
    if (chip?.dataset.path) {
        const p = chip.dataset.path;
        const isDir = chip.classList.contains('folder');
        if (isDir) {
            expanded.add(p);
            renderTree();
            toast(`Revealed folder · ${p}`);
        }
        else {
            openFile(p);
        }
        return;
    }
    const img = target.closest('.chat-img, .attachment-thumb');
    if (img?.src && !img.closest('.attachment-icon')) {
        const full = img.dataset.full || img.src;
        openModal(`<div class="img-modal-view"><img src="${escAttr(full)}" class="img-modal-img"><div class="row end w-full"><button class="btn btn-primary btn-sm" data-close>Close</button></div></div>`);
    }
});
// Hook up new chat buttons to create new tabs
const newChatBtn = document.getElementById('newChat');
if (newChatBtn)
    newChatBtn.onclick = () => newAgentTabAction(SURFACES.ide);
$('#agentNewTab')?.addEventListener('click', () => newAgentTabAction(SURFACES.ide));
$('#boxNewTab')?.addEventListener('click', () => newAgentTabAction(SURFACES.box));
$('[data-act="chat.new"]')?.addEventListener('click', () => newAgentTabAction(SURFACES.box));
commands['chat.new'] = () => newAgentTabAction(surface);
commands['agent.stop'] = () => stopAgent();
function stopAgent(targetTab) {
    const tab = targetTab || getActiveTab(surface);
    if (tab.runId != null)
        background(api.agent.stop(tab.runId));
}
const MODES = { build: 'build', ask: 'ask', plan: 'plan' };
const phaseFor = (mode) => ({ build: 'builder', plan: 'planner', ask: 'assistant' }[mode]);
async function sendPrompt() {
    const s = surface;
    const text = s.prompt.value.trim();
    const attachments = [...(attachmentsMap[s.name] || [])];
    const tab = getActiveTab(s);
    if ((!text && !attachments.length) || tab.runId != null)
        return;
    const agent = selectedAgent();
    if (!agent) {
        openAgentPicker();
        return;
    }
    if (s.name === 'ide' && !rootInfo) {
        toast('Open a folder first, so the agent knows what to work on');
        return;
    }
    msgSurface = s;
    sfx.play('send');
    const uiMode = s.mode.value;
    s.prompt.value = '';
    tab.promptDraft = '';
    attachmentsMap[s.name] = [];
    tab.attachments = [];
    renderAttachments(s);
    if (tab.panel.querySelector('.empty'))
        tab.panel.innerHTML = '';
    if (/^Chat \d+$/i.test(tab.title) || tab.title === 'New chat') {
        if (text) {
            tab.title = text.length > 20 ? text.slice(0, 18) + '…' : text;
        }
        else {
            tab.title = 'Task';
        }
        renderAgentTabs(s);
    }
    team = [];
    teamNeed = 0;
    renderAgents();
    userMsg(text, attachments, tab);
    let agentPrompt = text;
    if (attachments.length) {
        const fileHeaders = attachments.map(a => {
            const kind = a.kind || (a.dataUrl || (a.fileUrl && IMAGE_FILE.test(a.name)) ? 'image' : 'file');
            if (kind === 'folder')
                return `[Attached folder: ${a.path || a.fileRel || a.name}]`;
            if (kind === 'file')
                return `[Attached file: ${a.path || a.fileRel || a.name}]`;
            return `[Attached image: ${a.fileRel || a.name}]`;
        }).join('\n');
        agentPrompt = fileHeaders + (text ? `\n\n${text}` : '\nPlease inspect the attached files/folders.');
    }
    await startAgentRun(agent.id, MODES[uiMode] ?? 'plan', agentPrompt, uiMode, tab, true);
}
async function startAgentRun(agentId, mode, prompt, uiMode, tab, announce = false) {
    const phase = phaseFor(mode);
    showThinking(`${speaker(phase).name} is reading your message`, phase, tab);
    tab.agentId = agentId;
    tab.uiMode = uiMode;
    agentsDef[phase].used = 0;
    try {
        const box = tab.surfaceName === 'box';
        // A session belongs to the agent that started it (a Codex thread id means nothing to Claude Code).
        if (tab.sessionAgent !== agentId)
            tab.session = null;
        const id = await api.agent.run({ agent: agentId, mode, prompt, session: tab.session, box });
        const run = {
            id,
            tabId: tab.id,
            surfaceName: tab.surfaceName,
            agent: agentId,
            mode,
            uiMode,
            phase,
            tools: 0,
            files: new Set(),
            plan: null,
            lastText: '',
            replied: false,
            announce,
        };
        tab.runId = id;
        tab.run = run;
        agentRun = run;
        updateTabBusyState(SURFACES[tab.surfaceName], tab);
        renderAgentTabs(SURFACES[tab.surfaceName]);
        for (const [runId, ev] of earlyEvents.splice(0)) {
            if (runId === id)
                handleAgentEvent(run, ev, tab);
        }
        if (tab.runId === id)
            setAgent(phase, 'working', mode === 'build' ? 'Working on your request' : 'Reading the project', 0);
    }
    catch (e) {
        tab.runId = null;
        tab.run = null;
        updateTabBusyState(SURFACES[tab.surfaceName], tab);
        renderAgentTabs(SURFACES[tab.surfaceName]);
        hideThinking(tab);
        joinTeam(phase);
        setAgent(phase, 'idle', 'Could not start', 0);
        errorCard(errMsg(e), undefined, tab);
    }
}
function errorCard(text, hint, tab) {
    const hintHtml = hint ? `<p>${esc(hint)}</p>` : '';
    addMsg(`<div class="card error"><h5>${svgIcon('alert', 14)} The agent hit a problem</h5><pre>${esc(text)}</pre>${hintHtml}</div>`, tab);
}
function onAgentFile(r, path) {
    r.files.add(path);
    locks[path] = r.phase;
    renderTree();
    renderTabs();
    queueGitRefresh();
    if (r.surfaceName === 'ide')
        background(openAgentFile(path));
}
// Opens the file an agent is editing and shows it, so its changes type out in front of the person.
async function openAgentFile(path) {
    if (baseName(path).startsWith('.env') || !rootInfo)
        return;
    if (!buffers.has(path)) {
        const r = await api.fs.readFile(path).catch(() => null);
        if (r?.text == null || kindOf(r) !== 'text')
            return; // deleted, binary or too large
        if (!await loadBuffer(path))
            return;
    }
    followAgentTo(path);
    // Some agents report the file before writing it: catch a write that landed while it was opening.
    const b = buffers.get(path);
    if (b?.kind === 'text')
        for (const ms of [400, 1500])
            setTimeout(() => { if (!isDirty(b))
                void reloadText(b); }, ms);
}
function onAgentError(r, ev, tab) {
    if (r.lastMsg && ev.text?.trim() === r.lastText.trim())
        r.lastMsg.remove();
    errorCard(ev.text ?? 'Unknown error', ev.hint, tab);
}
function onFirstReply(r, tab) {
    r.replied = true;
    if (r.announce)
        teamNeed = TEAM_SIZE[r.uiMode] ?? 1;
    joinTeam(r.phase);
    if (r.announce && tab.surfaceName === 'ide')
        addMsg(`<div class="team-line">${teamLineHtml(r.uiMode || r.mode)}</div>`, tab);
}
const AGENT_EVENTS = {
    session: (_r, ev, tab) => {
        if (ev.id) {
            tab.session = ev.id;
            tab.sessionAgent = tab.agentId;
            store.set(agentSessionKey(SURFACES[tab.surfaceName]), ev.id);
        }
    },
    text: (r, ev, tab) => {
        if (!ev.text)
            return;
        if (r.lastMsg && r.lastText && (ev.text.startsWith(r.lastText) || ev.text === r.lastText)) {
            const bodyEl = r.lastMsg.querySelector('.body');
            if (bodyEl) {
                bodyEl.innerHTML = md(ev.text);
                r.lastText = ev.text;
                if (tab.id === activeTabId[tab.surfaceName])
                    scrollChat(SURFACES[tab.surfaceName]);
                saveChat(tab);
                return;
            }
        }
        r.lastText = ev.text;
        r.lastMsg = agentMsg(r.phase, md(ev.text), tab);
    },
    tool: (r, ev, tab) => {
        r.lastMsg = undefined;
        r.tools++;
        toolLine(ev.kind ?? 'tool', ev.label ?? '', tab);
        setAgent(r.phase, 'working', ev.label ?? 'Working', r.tools);
    },
    file: (r, ev) => { if (ev.path)
        onAgentFile(r, ev.path); },
    plan: (r, ev) => { r.plan = ev.text ?? ''; },
    note: (_r, ev, tab) => { if (ev.text)
        toolLine('note', ev.text, tab); },
    auth: (_r, ev, tab) => {
        const url = ev.url;
        const cmd = ev.command;
        let actionHtml = '';
        if (url) {
            actionHtml = '<div class="row" style="margin-top:8px;"><button class="btn btn-primary btnAgentAuth">Sign in with Google</button></div>';
        }
        else if (cmd) {
            actionHtml = `<p class="sub">Run <code>${esc(cmd)}</code> to sign in</p>`;
        }
        const cardHtml = `<div class="card warn"><h5>${svgIcon('alert', 14)} Sign-in Required</h5><p>${esc(ev.text || 'Antigravity session expired or unauthenticated.')}</p>${actionHtml}</div>`;
        const el = addMsg(cardHtml, tab);
        if (url) {
            el.querySelector('.btnAgentAuth')?.addEventListener('click', () => {
                background(api.sys.openExternal(url));
            });
        }
    },
    'auth-required': (r, ev, tab) => {
        AGENT_EVENTS.auth?.(r, ev, tab);
    },
    error: (r, ev, tab) => onAgentError(r, ev, tab),
    done: (r, ev, tab) => finishRun(r, ev, tab),
};
function handleAgentEvent(r, ev, tab) {
    if (!r.replied && ev.t !== 'session' && ev.t !== 'done')
        onFirstReply(r, tab);
    AGENT_EVENTS[ev.t]?.(r, ev, tab);
}
const earlyEvents = [];
api.agent.onEvent((runId, ev) => {
    let foundTab;
    for (const sName of ['ide', 'box']) {
        const t = surfaceTabs[sName].find(x => x.runId === runId);
        if (t) {
            foundTab = t;
            break;
        }
    }
    if (foundTab?.run) {
        handleAgentEvent(foundTab.run, ev, foundTab);
    }
    else if (earlyEvents.length < 200) {
        earlyEvents.push([runId, ev]);
    }
});
function runSummary(r, ev) {
    const time = ev.ms ? `${Math.max(1, Math.round(ev.ms / 1000))}s` : '';
    const files = r.files.size ? `${plural(r.files.size, 'file')} changed` : '';
    let usage = '';
    if (ev.cost)
        usage = `$${ev.cost.toFixed(2)}`;
    else if (ev.tokens)
        usage = `${ev.tokens.toLocaleString()} tokens`;
    return [time, files, usage].filter(Boolean);
}
function showPlan(r, tab) {
    const plan = (r.plan || r.lastText).trim();
    if (!plan) {
        setAgent('planner', 'done', 'Answered', r.tools);
        return;
    }
    setAgent('planner', 'waiting', 'Waiting for plan approval', r.tools);
    sfx.play('plan');
    const el = addMsg(`<div class="card plan"><h5>${svgIcon('todo', 14)} Plan</h5><div class="plan-body">${md(plan)}</div><div class="row" data-live><button class="btn btn-primary btn-sm" data-plan="ok">Approve &amp; build</button><button class="btn btn-sm" data-plan="edit">Change something</button></div></div>`, tab);
    $$('[data-plan]', el).forEach(b => b.onclick = () => {
        const ok = b.dataset.plan === 'ok';
        $('[data-live]', el).outerHTML = `<div class="resolved">${ok ? '✓ Approved' : '✎ Asked for changes'}</div>`;
        saveChat(tab);
        if (ok) {
            sfx.play('approve');
            setAgent('planner', 'done', 'Plan handed off', r.tools);
            addMsg('<div class="handoff">Planner → Builder</div>', tab);
            void startAgentRun(r.agent, 'build', 'The plan is approved. Implement it now, then summarize what you changed.', 'build', tab);
        }
        else {
            setAgent('planner', 'idle', 'Waiting for your changes', r.tools);
            const s = SURFACES[tab.surfaceName];
            s.prompt.focus();
            s.prompt.placeholder = 'What should change in the plan?';
        }
    });
}
function finishRun(r, ev, tab) {
    tab.runId = null;
    tab.run = null;
    if (agentRun?.id === r.id)
        agentRun = null;
    hideThinking(tab);
    const s = SURFACES[tab.surfaceName];
    if (tab.id === activeTabId[tab.surfaceName]) {
        updateTabBusyState(s, tab);
    }
    renderAgentTabs(s);
    for (const k of Object.keys(locks))
        delete locks[k];
    renderTree();
    renderTabs();
    lastRunFiles = [...r.files];
    queueGitRefresh();
    const allDone = !hasAnyActiveRun();
    if (ev.stopped) {
        addMsg('<div class="handoff">Stopped by you</div>', tab);
        setAgent(r.phase, 'idle', 'Stopped', r.tools);
        if (allDone)
            vibeDone(false);
        return;
    }
    if (!ev.ok) {
        setAgent(r.phase, 'idle', 'Stopped with an error', r.tools);
        if (allDone)
            vibeDone(false);
        return;
    }
    if (r.uiMode === 'plan' && r.mode === 'plan') {
        showPlan(r, tab);
        if (allDone)
            vibeDone(true, true);
        return;
    }
    const changed = r.files.size ? `Changed ${plural(r.files.size, 'file')}` : 'Answered';
    setAgent(r.phase, 'done', changed, r.tools);
    sfx.play('success');
    if (allDone)
        vibeDone(true);
    const bits = runSummary(r, ev);
    const summary = bits.length ? ' · ' + bits.join(' · ') : '';
    const review = r.files.size ? '<button class="btn btn-sm" data-live data-review>Review changes</button>' : '';
    const el = addMsg(`<div class="run-done"><span>✓ Done${summary}</span>${review}</div>`, tab);
    el.querySelector('[data-review]')?.addEventListener('click', () => showView('git', true));
    s.prompt.placeholder = s.name === 'box' ? 'Ask Breeze anything…' : 'Describe what you want to build…';
    if (r.files.size && running)
        void reloadPreview();
}
/* ----- Custom dropdowns: every select.select gets a button that opens Breeze's own menu ----- */
// The native <select> stays in the page (hidden) so code and forms keep reading its value.
function openDropdown(sel, btn) {
    if (btn.classList.contains('open') || (justClosedTrigger === btn && Date.now() - justClosedAt < 350)) {
        closeMenu();
        return;
    }
    closeMenu();
    const label = () => {
        const text = sel.selectedOptions[0]?.text || sel.value || '';
        if (sel.id === 'agentModelSelect') {
            const eff = currentEffort();
            btn.innerHTML = `<span class="dd-val">${esc(text)}<small class="dd-eff"> · ${esc(eff)}</small></span><svg class="dd-chev" width="10" height="10"><use href="#i-chev"/></svg>`;
            btn.title = `${text} (${eff} effort)`;
            return;
        }
        btn.innerHTML = `<span class="dd-val">${esc(text)}</span><svg class="dd-chev" width="10" height="10"><use href="#i-chev"/></svg>`;
        btn.title = text;
    };
    const a = sel.id === 'agentModelSelect' ? selectedAgent() : null;
    const items = (a?.found && a.models?.length)
        ? modelMenuItems(a, () => {
            sel.value = a.version || a.models?.[0] || '';
            label();
            btn.focus();
        })
        : [...sel.options].map(o => ({
            label: o.text,
            checked: () => o.value === sel.value,
            enabled: () => !o.disabled,
            run: () => {
                sel.value = o.value;
                label();
                if (sel.onchange)
                    sel.onchange(new Event('change'));
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                btn.focus();
            },
        }));
    const r = btn.getBoundingClientRect();
    btn.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    popupMenu(r.left, r.bottom + 4, items, () => { btn.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }, btn);
    const m = $('#menuRoot .menu');
    if (m) {
        m.classList.add('dd-menu');
        m.style.minWidth = `${Math.max(150, r.width)}px`;
        m.style.left = `${Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8))}px`;
        // Near the bottom of the window (the chat composers) the menu opens upwards.
        if (r.bottom + 4 + m.offsetHeight > innerHeight - 8) {
            m.style.top = `${Math.max(8, r.top - m.offsetHeight - 4)}px`;
            m.classList.add('up');
        }
    }
}
function enhanceSelect(sel) {
    if (sel.dataset.dd)
        return;
    sel.dataset.dd = '1';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dd-btn' + (sel.classList.contains('hidden') ? ' hidden' : '');
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', sel.getAttribute('aria-label') ?? 'Choose');
    if (sel.id)
        btn.classList.add(`${sel.id}-btn`);
    sel.classList.add('dd-native');
    sel.tabIndex = -1;
    sel.setAttribute('aria-hidden', 'true');
    sel.after(btn);
    const label = () => {
        const text = sel.selectedOptions[0]?.text || sel.value || '';
        if (sel.id === 'agentModelSelect') {
            const eff = currentEffort();
            btn.innerHTML = `<span class="dd-val">${esc(text)}<small class="dd-eff"> · ${esc(eff)}</small></span><svg class="dd-chev" width="10" height="10"><use href="#i-chev"/></svg>`;
            btn.title = `${text} (${eff} effort)`;
            return;
        }
        btn.innerHTML = `<span class="dd-val">${esc(text)}</span><svg class="dd-chev" width="10" height="10"><use href="#i-chev"/></svg>`;
        btn.title = text;
    };
    label();
    sel.addEventListener('change', label);
    btn.onclick = () => openDropdown(sel, btn);
    btn.onkeydown = e => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')
            return;
        e.preventDefault();
        if (!btn.classList.contains('open'))
            openDropdown(sel, btn);
    };
    new MutationObserver(() => {
        btn.classList.toggle('hidden', sel.classList.contains('hidden'));
        label();
    }).observe(sel, { childList: true, attributes: true, attributeFilter: ['class'] });
}
$$('select.select').forEach(enhanceSelect);
new MutationObserver(() => $$('select.select:not([data-dd])').forEach(enhanceSelect)).observe(document.body, { childList: true, subtree: true });
/* ================= Source control (git) ================= */
let gitState = { repo: false };
let gitLog = { head: null, commits: [] };
let gitBusy = false;
let openCommit = null;
const commitDetails = new Map();
const scmCollapsed = new Set(store.get('breeze.scmCollapsed', []));
let gitTimer;
function queueGitRefresh() { clearTimeout(gitTimer); gitTimer = setTimeout(() => void refreshGit(), 400); }
window.addEventListener('focus', () => { if (rootInfo)
    queueGitRefresh(); });
async function refreshGit() {
    if (!rootInfo) {
        gitState = { repo: false };
        renderScm();
        renderBranch();
        return;
    }
    try {
        gitState = await api.git.status();
        gitLog = gitState.repo && gitState.hasCommits ? await api.git.log() : { head: null, commits: [], details: [] };
    }
    catch {
        gitState = { repo: false }; // git missing or not a repository: show the "initialize" panel
    }
    if (gitLog.details?.length) {
        for (const d of gitLog.details) {
            commitDetails.set(d.hash, d);
        }
    }
    renderScm();
    renderBranch();
    renderTree();
    renderTabs();
    if (gitLog.commits.length) {
        for (const c of gitLog.commits) {
            if (!commitDetails.has(c.hash)) {
                api.git.show(c.hash).then(d => {
                    commitDetails.set(c.hash, d);
                    if (openCommit === c.hash)
                        placeCommitDetail(c.hash);
                }).catch(() => { });
            }
        }
    }
}
function renderBranch() {
    const s = gitState;
    const ahead = s.ahead ? ` ↑${s.ahead}` : '';
    const behind = s.behind ? ` ↓${s.behind}` : '';
    const branchLabel = s.repo ? esc((s.branch || 'main') + ahead + behind) : 'no repository';
    $('#sbBranch').innerHTML = `${svgIcon('gitBranch', 14)}<span>${branchLabel}</span>`;
    const n = s.files?.length ?? 0;
    const badge = $('.act-btn[data-view=git] .badge');
    badge.textContent = n > 99 ? '99+' : String(n || '');
    badge.classList.toggle('hidden', !n);
    renderPs();
}
// Explorer decorations: path -> status class, plus every folder that contains a change.
function gitDecor() {
    const files = new Map(), dirs = new Set();
    const ignored = new Set(gitState.ignored ?? []);
    for (const f of gitState.files ?? []) {
        files.set(f.path, statusOf(f).cls);
        for (let d = dirName(f.path); d; d = dirName(d))
            dirs.add(d);
    }
    const incoming = new Set(gitState.incoming ?? []), incomingDirs = new Set();
    for (const p of incoming)
        for (let d = dirName(p); d; d = dirName(d))
            incomingDirs.add(d);
    return { files, dirs, ignored, incoming, incomingDirs };
}
// Fetches quietly now and then, so files changed on the remote show M↓ before anyone pulls.
let lastFetch = 0;
function backgroundFetch() {
    if (!rootInfo || !gitState.repo || !gitState.upstream || Date.now() - lastFetch < 5 * 60_000)
        return;
    lastFetch = Date.now();
    api.git.sync('fetch').then(() => queueGitRefresh(), () => { });
}
setInterval(backgroundFetch, 60_000);
const GIT_STATUS = {
    A: { letter: 'A', cls: 'git-a', title: 'Added' },
    D: { letter: 'D', cls: 'git-d', title: 'Deleted' },
    R: { letter: 'R', cls: 'git-m', title: 'Renamed' },
    U: { letter: '!', cls: 'git-d', title: 'Conflict' },
};
function statusOf(f, staged = false) {
    if (f.x === '?' || f.y === '?')
        return { letter: 'U', cls: 'git-u', title: 'Untracked' };
    let c = f.y;
    if (staged || f.y === ' ')
        c = f.x;
    return GIT_STATUS[c] ?? { letter: 'M', cls: 'git-m', title: 'Modified' };
}
function syncLabel(s) {
    if (!s.hasRemote)
        return '';
    if (!s.upstream)
        return 'Publish Branch';
    const ahead = s.ahead ? ` ↑${s.ahead}` : '';
    if (s.behind)
        return `Sync ↓${s.behind}${ahead}`;
    return s.ahead ? `Push${ahead}` : '';
}
function scmRowHtml(f, inStaged) {
    const st = statusOf(f, inStaged);
    const enter = seenScm.has(f.path + inStaged) ? '' : ' enter';
    const discard = inStaged ? '' : `<button class="icon-btn" data-scm="discard" title="Discard Changes">${svgIcon('undo')}</button>`;
    const toggle = inStaged
        ? `<button class="icon-btn" data-scm="unstage" title="Unstage Changes">${svgIcon('minus')}</button>`
        : `<button class="icon-btn" data-scm="stage" title="Stage Changes">${svgIcon('plus')}</button>`;
    return `<div class="scm-row ${st.cls}${enter}" data-file="${escAttr(f.path)}" data-staged="${inStaged ? 1 : ''}" title="${escAttr(f.path)} · ${st.title}">
    <span class="ico">${fileIcon(baseName(f.path))}</span><span class="nm">${fileNameHtml(baseName(f.path))}</span><span class="dir">${esc(dirName(f.path))}</span>
    <span class="acts"><button class="icon-btn" data-scm="open" title="Open File">${svgIcon('external')}</button>${discard}${toggle}</span><span class="st">${st.letter}</span></div>`;
}
function scmSectionHtml(key, title, list, inStaged, acts) {
    if (!list.length)
        return '';
    const rows = list.map(f => scmRowHtml(f, inStaged)).join('');
    return `<div class="scm-sec ${scmCollapsed.has(key) ? 'closed' : ''}" data-sec="${key}">
    <div class="scm-head"><span class="chev"><svg width="10" height="10"><use href="#i-chev"/></svg></span><span class="title">${title}</span><span class="acts">${acts}</span><span class="count">${list.length}</span></div>
    <div class="scm-list">${rows}</div></div>`;
}
function lowestModelFor(a) {
    if (a.id === 'antigravity') {
        const models = a.models ?? [];
        const low = models.find(m => /flash-low/i.test(m))
            || models.find(m => /flash-medium/i.test(m))
            || models.find(m => /flash/i.test(m))
            || models.at(-1);
        return { model: low || 'gemini-3.8-flash-low' };
    }
    if (a.id === 'codex') {
        const models = a.models ?? [];
        const low = models.find(m => /mini/i.test(m)) || models.at(-1);
        return { model: low || 'gpt-4o-mini' };
    }
    if (a.id === 'claude')
        return { model: 'haiku' };
    if (a.api) {
        const models = a.models ?? [];
        const low = models.find(m => /(1\.5b|3b|mini|small)/i.test(m)) || models[0];
        return { model: low || a.version || undefined };
    }
    return { model: a.models?.at(-1) };
}
function heuristicCommitMsg(files) {
    if (!files.length)
        return 'chore: update project';
    const names = files.map(f => baseName(f.path));
    const dirs = [...new Set(files.map(f => dirName(f.path)).filter(Boolean))];
    const scope = dirs.length === 1 ? `(${dirs[0].split(/[/\\]/).pop()})` : '';
    const isTestOnly = files.every(f => /test|\.spec\./i.test(f.path));
    if (isTestOnly)
        return `test${scope}: update tests for ${names.slice(0, 3).join(', ')}`;
    const isDocOnly = files.every(f => /\.(md|txt|doc)$/i.test(f.path));
    if (isDocOnly)
        return `docs${scope}: update documentation`;
    const isStyleOnly = files.every(f => /\.(css|scss|less)$/i.test(f.path));
    if (isStyleOnly)
        return `style${scope}: update styling in ${names.slice(0, 3).join(', ')}`;
    const isBuildOnly = files.every(f => /(package\.json|tsconfig|webpack|vite|rollup|build)/i.test(f.path));
    if (isBuildOnly)
        return `chore${scope}: update build and dependencies`;
    const hasNew = files.some(f => f.x === '?' || f.x === 'A');
    const type = hasNew ? 'feat' : 'fix';
    return `${type}${scope}: update ${names.slice(0, 2).join(', ')}${names.length > 2 ? ` and ${names.length - 2} other file${names.length > 3 ? 's' : ''}` : ''}`;
}
function autoResizeScmMsg(el) {
    const msg = el || $('#scmMsg');
    if (!msg)
        return;
    msg.style.height = 'auto';
    const target = Math.min(160, Math.max(28, msg.scrollHeight));
    msg.style.height = `${target}px`;
    msg.style.overflowY = msg.scrollHeight > 160 ? 'auto' : 'hidden';
}
function currentActiveAgent() {
    try {
        const list = surfaceTabs !== undefined ? surfaceTabs['ide'] : null;
        const curId = activeTabId !== undefined ? activeTabId['ide'] : null;
        const ideTab = list?.find(t => t.id === curId);
        const agentId = ideTab?.agentId || appState.agent;
        const found = appState.detect?.agents.find(a => a.id === agentId && a.found);
        if (found)
            return found;
    }
    catch { }
    return selectedAgent();
}
function updateScmGenBtn() {
    const btn = $('#scmGenMsg');
    if (!btn)
        return;
    const a = currentActiveAgent() || appState.detect?.agents.find(x => x.found);
    btn.classList.remove('hidden');
    const tip = a?.found ? `Generate commit message (${a.name})` : 'Generate commit message';
    btn.title = tip;
    btn.dataset.tooltip = tip;
}
async function generateCommitMsg() {
    const currentFiles = gitState.files ?? [];
    if (!currentFiles.length) {
        toast('No changes to generate commit message for');
        return;
    }
    let activeAg = currentActiveAgent();
    if (!activeAg || !activeAg.found) {
        activeAg = appState.detect?.agents?.find(a => a.found) || null;
    }
    const isStaged = currentFiles.some(f => f.x !== ' ' && f.x !== '?');
    const genBtnEl = $('#scmGenMsg');
    if (genBtnEl) {
        genBtnEl.disabled = true;
        genBtnEl.classList.add('busy');
        genBtnEl.innerHTML = `<div class="spinner sm"></div>`;
    }
    try {
        if (!activeAg?.found) {
            const fallbackMsg = heuristicCommitMsg(currentFiles);
            const msgArea = $('#scmMsg');
            if (msgArea) {
                msgArea.value = fallbackMsg;
                scmDraft = msgArea.value;
                autoResizeScmMsg(msgArea);
                msgArea.focus();
            }
            toast('Commit message generated');
            return;
        }
        const stagedDiff = isStaged ? await api.git.diff([], true).catch(() => '') : '';
        const unstagedDiff = await api.git.diff([], false).catch(() => '');
        let diffText = '';
        if (stagedDiff && unstagedDiff) {
            diffText = `Staged changes:\n${stagedDiff}\n\nUnstaged changes:\n${unstagedDiff}`;
        }
        else {
            diffText = stagedDiff || unstagedDiff || '';
        }
        const summary = currentFiles.map(f => `${statusOf(f, isStaged).title}: ${f.path}`).join('\n');
        const fullDiff = (diffText || '').trim() || summary;
        const truncated = fullDiff.length > 5000 ? fullDiff.slice(0, 5000) + '\n...(truncated)' : fullDiff;
        // Use currently selected model if available, otherwise lowest/available model for agent
        const modelSel = $('#agentModelSelect');
        const userChosenModel = modelSel?.value?.trim() || undefined;
        const { model: fallbackModel } = lowestModelFor(activeAg);
        const chosenModel = userChosenModel || fallbackModel || activeAg.version || activeAg.models?.[0];
        const prevCommit = gitLog.commits?.[0];
        const prevCommitContext = prevCommit
            ? `Previous commit (${prevCommit.hash.slice(0, 7)}): ${prevCommit.subject}\n`
            : 'Repository has no previous commits (Initial commit).\n';
        const prompt = `You are an expert developer generating a concise Git commit message.
Analyze all current changes compared to the previous commit. Wrap up everything that was changed accurately and comprehensively.

Context:
${prevCommitContext}
Changed files:
${summary}

Diff:
${truncated}

Instructions:
- Follow Conventional Commits format (e.g. feat: ..., fix: ..., chore: ..., refactor: ..., docs: ..., style: ..., test: ...).
- If there are multiple distinct changes, provide a concise summary title, followed by an empty line and short bullet points (- ...) detailing the key changes.
- Output ONLY the commit message itself. Do NOT output code blocks, quotes, or conversational preamble.`;
        const res = await api.git.genCommitMsg({
            agent: activeAg.id,
            prompt,
            model: chosenModel,
            effort: undefined, // No forced effort requirement: every model works smoothly
        });
        if (res) {
            const msgArea = $('#scmMsg');
            if (msgArea) {
                msgArea.value = res.trim();
                scmDraft = msgArea.value;
                autoResizeScmMsg(msgArea);
                msgArea.focus();
            }
            toast(`Commit message generated with ${activeAg.name}`);
        }
    }
    catch (err) {
        const fallbackMsg = heuristicCommitMsg(currentFiles);
        const msgArea = $('#scmMsg');
        if (msgArea) {
            msgArea.value = fallbackMsg;
            scmDraft = msgArea.value;
            autoResizeScmMsg(msgArea);
            msgArea.focus();
        }
        toast(`Commit message generated (${errMsg(err)})`);
    }
    finally {
        if (genBtnEl) {
            genBtnEl.disabled = false;
            genBtnEl.classList.remove('busy');
            genBtnEl.innerHTML = svgIcon('sparkles', 14);
        }
    }
}
function renderScm() {
    const el = $('#scm');
    if (!rootInfo) {
        el.innerHTML = '<p class="side-note">Open a folder to use source control.</p>';
        return;
    }
    if (!gitState.repo) {
        el.innerHTML = `<div class="side-note">This folder isn't a git repository yet. Turn it on to save checkpoints you can always go back to.<button class="btn btn-primary btn-sm" data-act="git.init">Initialize Repository</button></div>`;
        return;
    }
    const files = gitState.files ?? [];
    const staged = files.filter(f => f.x !== ' ' && f.x !== '?');
    const changes = files.filter(f => f.y !== ' ' || f.x === '?');
    const commitLabel = (!staged.length && changes.length ? 'Commit All' : 'Commit') + (gitState.hasRemote ? ' & Push' : '');
    const sync = syncLabel(gitState);
    const syncBtn = sync ? `<button class="btn btn-sm commit-btn" data-act="git.sync">${sync}</button>` : '';
    const empty = files.length ? '' : '<p class="side-note">No changes. Everything is saved in a checkpoint.</p>';
    el.innerHTML = `
    <div class="commit-box">
      <textarea class="input" id="scmMsg" rows="1" aria-label="Commit message" placeholder="Message (Ctrl+Enter to commit on ‘${escAttr(gitState.branch || 'main')}’)"></textarea>
      <div class="row gap-6">
        <button class="btn btn-primary btn-sm commit-btn" data-act="git.commit" ${files.length ? '' : 'disabled'}>${commitLabel}</button>
        ${syncBtn}
      </div>
    </div>
    ${scmSectionHtml('staged', 'Staged Changes', staged, true, `<button class="icon-btn" data-scm-all="unstage" title="Unstage All">${svgIcon('minus')}</button>`)}
    ${scmSectionHtml('changes', 'Changes', changes, false, `<button class="icon-btn" data-scm-all="discard" title="Discard All Changes">${svgIcon('undo')}</button><button class="icon-btn" data-scm-all="stage" title="Stage All Changes">${svgIcon('plus')}</button>`)}
    ${incomingSectionHtml()}
    ${empty}
    <div class="scm-sec graph ${scmCollapsed.has('graph') ? 'closed' : ''}" data-sec="graph">
      <div class="scm-head"><span class="chev"><svg width="10" height="10"><use href="#i-chev"/></svg></span><span class="title">Checkpoints</span><span class="count">${gitLog.commits.length}</span></div>
      <div class="scm-list">${renderGraphRows()}</div>
    </div>`;
    seenScm.clear();
    for (const f of staged)
        seenScm.add(f.path + true);
    for (const f of changes)
        seenScm.add(f.path + false);
    const msg = $('#scmMsg', el);
    msg.value = scmDraft;
    autoResizeScmMsg(msg);
    msg.oninput = () => {
        scmDraft = msg.value;
        autoResizeScmMsg(msg);
    };
    msg.onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        run('git.commit');
    } };
    updateScmGenBtn();
}
// Files the remote changed since this branch last pulled; Sync brings them in.
function incomingSectionHtml() {
    const list = gitState.incoming ?? [];
    if (!list.length)
        return '';
    const rows = list.map(p => `<div class="scm-row git-in" title="${escAttr(p)} · Changed on the remote, not pulled yet">
    <span class="ico">${fileIcon(baseName(p))}</span><span class="nm">${fileNameHtml(baseName(p))}</span><span class="dir">${esc(dirName(p))}</span><span class="st">M↓</span></div>`).join('');
    return `<div class="scm-sec ${scmCollapsed.has('incoming') ? 'closed' : ''}" data-sec="incoming">
    <div class="scm-head"><span class="chev"><svg width="10" height="10"><use href="#i-chev"/></svg></span><span class="title">Incoming (not pulled)</span><span class="acts"><button class="icon-btn" data-act="git.sync" title="Pull">${svgIcon('down')}</button></span><span class="count">${list.length}</span></div>
    <div class="scm-list">${rows}</div></div>`;
}
let scmDraft = '';
const seenScm = new Set();
function toggleScmSection(head) {
    const sec = head.parentElement;
    const key = sec.dataset.sec;
    const list = sec.querySelector('.scm-list');
    if (sec.classList.contains('closing') || sec.classList.contains('opening') || !list)
        return;
    const isClosing = !sec.classList.contains('closed');
    if (isClosing) {
        scmCollapsed.add(key);
        sec.classList.add('closing');
        const startH = list.scrollHeight;
        list.style.overflow = 'hidden';
        list.style.maxHeight = startH + 'px';
        list.style.opacity = '1';
        list.style.transform = 'translateY(0)';
        const _reflow = list.offsetHeight;
        list.style.transition = 'max-height .22s cubic-bezier(.16, 1, .3, 1), opacity .18s ease, transform .22s cubic-bezier(.16, 1, .3, 1)';
        list.style.maxHeight = '0px';
        list.style.opacity = '0';
        list.style.transform = 'translateY(-4px)';
        const cleanup = () => {
            sec.classList.remove('closing');
            sec.classList.add('closed');
            list.style.overflow = '';
            list.style.maxHeight = '';
            list.style.opacity = '';
            list.style.transform = '';
            list.style.transition = '';
        };
        setTimeout(cleanup, 230);
    }
    else {
        scmCollapsed.delete(key);
        sec.classList.remove('closed');
        sec.classList.add('opening');
        list.style.overflow = 'hidden';
        list.style.maxHeight = '0px';
        list.style.opacity = '0';
        list.style.transform = 'translateY(-4px)';
        const _reflow = list.offsetHeight;
        const targetH = list.scrollHeight;
        list.style.transition = 'max-height .22s cubic-bezier(.16, 1, .3, 1), opacity .22s ease, transform .22s cubic-bezier(.16, 1, .3, 1)';
        list.style.maxHeight = targetH + 'px';
        list.style.opacity = '1';
        list.style.transform = 'translateY(0)';
        const cleanup = () => {
            sec.classList.remove('opening');
            list.style.overflow = '';
            list.style.maxHeight = '';
            list.style.opacity = '';
            list.style.transform = '';
            list.style.transition = '';
        };
        setTimeout(cleanup, 230);
    }
    store.set('breeze.scmCollapsed', [...scmCollapsed]);
}
function scmAll(kind) {
    const files = gitState.files ?? [];
    if (kind === 'stage')
        void gitOp(() => api.git.stage(files.filter(f => f.y !== ' ' || f.x === '?').map(f => f.path)));
    if (kind === 'unstage')
        void gitOp(() => api.git.unstage(files.filter(f => f.x !== ' ' && f.x !== '?').map(f => f.path), !!gitState.hasCommits));
    if (kind === 'discard')
        confirmDiscardChanges(files.filter(f => f.y !== ' ' || f.x === '?'));
}
function scmRowAction(t, rowEl) {
    const path = rowEl.dataset.file;
    const f = (gitState.files ?? []).find(x => x.path === path);
    const act = t.closest('[data-scm]')?.dataset.scm;
    if (act === 'open')
        openFile(path);
    else if (act === 'stage')
        void gitOp(() => api.git.stage([path]));
    else if (act === 'unstage')
        void gitOp(() => api.git.unstage([path], !!gitState.hasCommits));
    else if (act === 'discard' && f)
        confirmDiscardChanges([f]);
    else if (f)
        void showDiff(f, !!rowEl.dataset.staged);
}
$('#scm').addEventListener('click', e => {
    const t = e.target;
    const head = t.closest('.scm-head');
    if (head && !t.closest('button')) {
        toggleScmSection(head);
        return;
    }
    const all = t.closest('[data-scm-all]');
    if (all) {
        scmAll(all.dataset.scmAll);
        return;
    }
    const commitRow = t.closest('[data-commit]');
    if (commitRow) {
        void toggleCommit(commitRow.dataset.commit);
        return;
    }
    const rowEl = t.closest('.scm-row');
    if (rowEl)
        scmRowAction(t, rowEl);
});
$('#scm').addEventListener('pointerover', e => {
    const commitRow = e.target.closest('[data-commit]');
    if (!commitRow)
        return;
    const hash = commitRow.dataset.commit;
    if (hash && !commitDetails.has(hash)) {
        api.git.show(hash).then(d => {
            commitDetails.set(hash, d);
            if (openCommit === hash)
                placeCommitDetail(hash);
        }).catch(() => { });
    }
});
async function gitOp(fn, done) {
    if (gitBusy)
        return false;
    gitBusy = true;
    $('#scm').classList.add('busy');
    try {
        await fn();
        if (done)
            toast(done);
        return true;
    }
    catch (e) {
        const m = errMsg(e);
        if (m.length > 90 || m.includes('\n'))
            openModal(`<h3>Git said no</h3><pre class="git-err">${esc(m)}</pre><div class="row end"><button class="btn btn-primary" data-close>OK</button></div>`);
        else
            toast(m);
        return false;
    }
    finally {
        gitBusy = false;
        $('#scm').classList.remove('busy');
        await refreshGit();
    }
}
function confirmDiscardChanges(files) {
    if (!files.length)
        return;
    const untracked = files.filter(f => f.x === '?').length;
    const what = files.length === 1 ? 'changes in ' + esc(baseName(files[0].path)) : plural(files.length, 'change');
    const goes = untracked > 1 ? 's go' : ' goes';
    const bin = untracked ? `${untracked} new file${goes} to the Recycle Bin. ` : '';
    openModal(`<h3>Discard ${what}?</h3>
    <p class="sub">${bin}Edits to tracked files go back to the last checkpoint. This can't be undone with Ctrl+Z.</p>
    <div class="row end"><button class="btn" data-close>Cancel</button><button class="btn btn-danger" id="discardOk">Discard</button></div>`, m => {
        $('#discardOk', m).onclick = () => {
            closeModal();
            void gitOp(() => api.git.discard(files.map(f => ({ path: f.path, untracked: f.x === '?' }))));
        };
    });
}
function diffLineClass(l) {
    if (l.startsWith('@@'))
        return 'hunk';
    if (l.startsWith('+'))
        return 'add';
    return l.startsWith('-') ? 'del' : '';
}
async function showDiff(f, staged) {
    let text = '';
    try {
        if (f.x === '?') {
            const r = await api.fs.readFile(f.path);
            text = (r.text ?? '(binary file)').split('\n').map(l => '+' + l).join('\n');
        }
        else
            text = await api.git.diff(f.path, staged);
    }
    catch (e) {
        toast(errMsg(e));
        return;
    }
    const lines = text.split('\n').filter(l => !/^(?:diff --git|index |--- |\+\+\+ )/.test(l));
    const body = lines.map(l => `<div class="dl ${diffLineClass(l)}">${esc(l) || ' '}</div>`).join('') || '<div class="dl">No textual changes.</div>';
    openModal(`<div class="diff-head"><span class="ico">${fileIcon(baseName(f.path))}</span><b>${esc(f.path)}</b><span class="pill">${staged ? 'Staged' : statusOf(f).title}</span></div>
    <div class="diff">${body}</div>
    <div class="row end mt-12"><button class="btn" id="diffOpen">Open File</button><button class="btn btn-primary" id="diffStage">${staged ? 'Unstage' : 'Stage'}</button></div>`, m => {
        $('#diffOpen', m).onclick = () => { closeModal(); openFile(f.path); };
        $('#diffStage', m).onclick = () => { closeModal(); void gitOp(() => (staged ? api.git.unstage([f.path], !!gitState.hasCommits) : api.git.stage([f.path]))); };
    }, undefined, 'top');
}
/* ----- Commit graph ----- */
const LANE_COLORS = ['#7aa9ff', '#c4b5fd', '#86efac', '#fdba74', '#f9a8d4', '#7dd3fc'];
// The first free lane (or a new one) for a commit.
function claimLane(lanes, hash) {
    let i = lanes.indexOf(hash);
    if (i !== -1)
        return i;
    i = lanes.indexOf(null);
    if (i === -1)
        i = lanes.length;
    lanes[i] = hash;
    return i;
}
function layoutGraph(commits) {
    const lanes = [];
    return commits.map(c => {
        const lane = claimLane(lanes, c.hash);
        const before = lanes.slice();
        const merges = before.map((h, i) => (h === c.hash && i !== lane ? i : -1)).filter(i => i >= 0);
        merges.forEach(i => { lanes[i] = null; });
        lanes[lane] = c.parents[0] ?? null;
        const forks = c.parents.slice(1).map(p => claimLane(lanes, p));
        while (lanes.length && lanes.at(-1) == null)
            lanes.pop();
        return { c, lane, before, after: lanes.slice(), merges, forks };
    });
}
const laneColor = (i) => LANE_COLORS[i % LANE_COLORS.length];
function graphSvg(r, H, X) {
    const mid = H / 2;
    const paths = r.before.map((h, i) => {
        if (!h)
            return '';
        if (i === r.lane)
            return `<path d="M${X(i)} 0V${mid}" stroke="${laneColor(i)}"/>`;
        if (r.merges.includes(i))
            return `<path d="M${X(i)} 0C${X(i)} ${mid} ${X(r.lane)} ${mid / 2} ${X(r.lane)} ${mid}" stroke="${laneColor(i)}"/>`;
        return `<path d="M${X(i)} 0V${H}" stroke="${laneColor(i)}"/>`;
    });
    if (r.after[r.lane])
        paths.push(`<path d="M${X(r.lane)} ${mid}V${H}" stroke="${laneColor(r.lane)}"/>`);
    for (const f of r.forks)
        paths.push(`<path d="M${X(r.lane)} ${mid}C${X(r.lane)} ${H} ${X(f)} ${mid} ${X(f)} ${H}" stroke="${laneColor(f)}"/>`);
    const isHead = r.c.hash === gitLog.head;
    const fill = isHead ? laneColor(r.lane) : 'var(--bg-1)';
    paths.push(`<circle cx="${X(r.lane)}" cy="${mid}" r="${isHead ? 5 : 4}" fill="${fill}" stroke="${laneColor(r.lane)}" stroke-width="2"/>`);
    return paths.join('');
}
function refClass(ref) {
    if (ref.startsWith('HEAD'))
        return 'head';
    if (ref.startsWith('tag: '))
        return 'tag';
    return ref.includes('/') ? 'remote' : 'branch';
}
function detailGraphSvg(r, X) {
    const lines = [];
    r.after.forEach((h, i) => {
        if (h) {
            lines.push(`<path d="M${X(i)} -1V101" stroke="${laneColor(i)}" stroke-width="2" vector-effect="non-scaling-stroke"/>`);
        }
    });
    return lines.join('');
}
function commitDetailWrapHtml(r, width, X, d) {
    return `<div class="commit-detail-row" data-detail-hash="${r.c.hash}">
    <div class="detail-graph-col" style="width:${width}px;flex-shrink:0;align-self:stretch;display:flex;min-height:100%;">
      <svg class="detail-graph" width="${width}" viewBox="0 0 ${width} 100" preserveAspectRatio="none" style="width:${width}px;flex:1 1 100%;align-self:stretch;height:100%;min-height:100%;display:block;overflow:visible;pointer-events:none;">${detailGraphSvg(r, X)}</svg>
    </div>
    ${commitDetailHtml(r.c, d)}
  </div>`;
}
function renderGraphRows() {
    if (!gitLog.commits.length)
        return '<p class="side-note">No checkpoints yet. Commit your changes to save the first one.</p>';
    const rows = layoutGraph(gitLog.commits);
    const H = 36, X = (i) => 10 + i * 12;
    const width = Math.min(6, Math.max(...rows.map(r => Math.max(r.before.length, r.after.length, r.lane + 1)))) * 12 + 8;
    return rows.map(r => {
        const refs = r.c.refs.map(ref => `<span class="ref ${refClass(ref)}">${esc(ref.replace(/^HEAD -> /, '').replace(/^tag: /, ''))}</span>`).join('');
        const open = openCommit === r.c.hash;
        const detail = open ? commitDetailWrapHtml(r, width, X, commitDetails.get(r.c.hash)) : '';
        const tipText = `${r.c.subject} (${r.c.hash.slice(0, 7)} · ${r.c.author} · ${r.c.when})`;
        return `<div class="commit ${open ? 'on' : ''}" data-commit="${r.c.hash}" data-tooltip="${escAttr(tipText)}">
      <svg width="${width}" height="${H}" fill="none" stroke-width="2">${graphSvg(r, H, X)}</svg>
      <div class="msgline"><div>${refs}<span class="subj">${esc(r.c.subject)}</span></div><small>${esc(r.c.author)} · ${esc(r.c.when)}</small></div>
    </div>${detail}`;
    }).join('');
}
function splitFilePath(p) {
    const slash = p.lastIndexOf('/');
    const dot = p.lastIndexOf('.');
    if (dot > slash + 1) {
        return { name: p.slice(0, dot), ext: p.slice(dot) };
    }
    return { name: p, ext: '' };
}
function commitDetailHtml(c, d) {
    const files = d
        ? d.files.map(f => {
            const { name, ext } = splitFilePath(f.path);
            return `<div class="file" data-open-file="${escAttr(f.path)}" title="${escAttr(f.path)}"><span class="ico">${fileIcon(baseName(f.path))}</span><span class="fp"><span class="fp-name">${esc(name)}</span><span class="fp-ext">${esc(ext)}</span></span><span class="file-stats"><span class="add">+${f.added}</span> <span class="del">−${f.removed}</span></span></div>`;
        }).join('')
        : '<div class="side-note">Loading changed files…</div>';
    return `<div class="commit-detail">
    <div class="cd-msg">${esc(d ? d.message : c.subject)}</div>
    <div class="cd-meta">${esc(d ? d.author : c.author)} · ${esc(d ? d.when : c.when)} · <code>${c.hash.slice(0, 8)}</code></div>
    ${files}
    <div class="row mt-8 commit-actions"><button class="btn btn-sm" data-branch-from="${c.hash}">Branch from here</button><button class="btn btn-sm" data-copy-hash="${c.hash}">Copy id</button></div>
  </div>`;
}
// Opens or closes one checkpoint's details in place; the rest of the panel is left alone.
const commitRow = (hash) => $(`#scm .commit[data-commit="${hash}"]`);
function closeCommitDetail(hash, instant = false) {
    const row = commitRow(hash);
    row?.classList.remove('on');
    const d = row?.nextElementSibling;
    if ((d?.classList.contains('commit-detail-row') || d?.classList.contains('commit-detail')) && !d.dataset.closing) {
        if (instant) {
            d.remove();
            return;
        }
        d.dataset.closing = '1';
        d.style.overflow = 'hidden';
        d.style.maxHeight = d.scrollHeight + 'px';
        const _reflow = d.offsetHeight;
        d.style.transition = 'max-height .2s cubic-bezier(.16, 1, .3, 1), opacity .18s ease, transform .2s cubic-bezier(.16, 1, .3, 1)';
        d.style.maxHeight = '0px';
        d.style.opacity = '0';
        d.style.transform = 'translateY(-4px)';
        setTimeout(() => { d.remove(); }, 210);
    }
}
function placeCommitDetail(hash) {
    const row = commitRow(hash);
    if (!row)
        return;
    const rows = layoutGraph(gitLog.commits);
    const r = rows.find(x => x.c.hash === hash);
    if (!r)
        return;
    const X = (i) => 10 + i * 12;
    const width = Math.min(6, Math.max(...rows.map(row => Math.max(row.before.length, row.after.length, row.lane + 1)))) * 12 + 8;
    const holder = document.createElement('div');
    holder.innerHTML = commitDetailWrapHtml(r, width, X, commitDetails.get(hash));
    const fresh = holder.firstElementChild;
    const old = row.nextElementSibling;
    // Loading → loaded swaps the contents only, so the box doesn't animate in twice.
    if ((old?.classList.contains('commit-detail-row') || old?.classList.contains('commit-detail')) && !old.dataset.closing) {
        const card = old.querySelector('.commit-detail') || old;
        const freshCard = fresh.querySelector('.commit-detail') || fresh;
        card.innerHTML = freshCard.innerHTML;
        const graphCol = old.querySelector('.detail-graph-col');
        const freshGraphCol = fresh.querySelector('.detail-graph-col');
        if (graphCol && freshGraphCol) {
            graphCol.innerHTML = freshGraphCol.innerHTML;
        }
        if (old.style.maxHeight && old.style.maxHeight !== 'none') {
            old.style.maxHeight = old.scrollHeight + 'px';
        }
    }
    else {
        if (old?.classList.contains('commit-detail-row') || old?.classList.contains('commit-detail'))
            old.remove();
        fresh.style.overflow = 'hidden';
        fresh.style.maxHeight = '0px';
        fresh.style.opacity = '0';
        fresh.style.transform = 'translateY(-4px)';
        row.after(fresh);
        const _reflow = fresh.offsetHeight;
        const targetH = fresh.scrollHeight;
        fresh.style.transition = 'max-height .22s cubic-bezier(.16, 1, .3, 1), opacity .2s ease, transform .22s cubic-bezier(.16, 1, .3, 1)';
        fresh.style.maxHeight = targetH + 'px';
        fresh.style.opacity = '1';
        fresh.style.transform = 'translateY(0)';
        setTimeout(() => {
            fresh.style.overflow = '';
            fresh.style.maxHeight = '';
            fresh.style.opacity = '';
            fresh.style.transform = '';
            fresh.style.transition = '';
        }, 240);
    }
    row.classList.add('on');
}
async function toggleCommit(hash) {
    const was = openCommit;
    openCommit = openCommit === hash ? null : hash;
    if (was)
        closeCommitDetail(was, openCommit !== null);
    if (!openCommit)
        return;
    placeCommitDetail(hash);
    if (commitDetails.has(hash))
        return;
    try {
        commitDetails.set(hash, await api.git.show(hash));
    }
    catch (e) {
        toast(errMsg(e));
        if (openCommit === hash) {
            openCommit = null;
            closeCommitDetail(hash, true);
        }
        return;
    }
    if (openCommit === hash)
        placeCommitDetail(hash);
}
$('#scm').addEventListener('click', e => {
    const t = e.target;
    const f = t.closest('[data-open-file]');
    if (f) {
        e.stopPropagation();
        openFile(f.dataset.openFile);
    }
    const b = t.closest('[data-branch-from]');
    if (b) {
        e.stopPropagation();
        void newBranch(b.dataset.branchFrom);
    }
    const c = t.closest('[data-copy-hash]');
    if (c) {
        e.stopPropagation();
        background(navigator.clipboard.writeText(c.dataset.copyHash ?? '').then(() => toast('Commit id copied')));
    }
}, true);
async function commitNow() {
    const msg = scmDraft.trim();
    if (!msg) {
        toast('Write a short message describing this checkpoint');
        $('#scmMsg')?.focus();
        return;
    }
    const files = gitState.files ?? [];
    if (!files.length) {
        toast('Nothing to commit');
        return;
    }
    await saveAll();
    const all = !files.some(f => f.x !== ' ' && f.x !== '?');
    let hash = '';
    if (!(await gitOp(async () => { hash = await api.git.commit(msg, all); })))
        return;
    sfx.play('save');
    scmDraft = '';
    renderScm();
    // A checkpoint is committed and pushed in one go (pulling first if the branch is behind).
    if (!gitState.hasRemote) {
        toast(`Checkpoint saved · ${hash} (no remote to push to yet)`);
        return;
    }
    toast(`Checkpoint saved · ${hash} — pushing…`);
    const behind = !!gitState.behind;
    await gitOp(async () => {
        if (behind)
            await api.git.sync('pull');
        await api.git.sync('push');
    }, `Checkpoint ${hash} saved and pushed`);
}
async function newBranch(from) {
    const name = await askName(from ? 'New branch from this checkpoint' : 'New branch', '', 'Create');
    if (!name)
        return;
    await gitOp(() => api.git.switchTo(name, true, from), `Switched to new branch ${name}`);
}
function branchListHtml(branches, q) {
    const create = q && !branches.includes(q)
        ? `<div class="qo-item" data-new="1"><span class="qo-title">${svgIcon('plus', 14)} <span>Create branch “${esc(q)}”</span></span></div>`
        : '';
    const rows = branches.filter(b => b.toLowerCase().includes(q.toLowerCase())).map(b => {
        const current = b === gitState.branch;
        const del = current
            ? ''
            : `<button class="br-del" data-del="${escAttr(b)}" title="Hold for 5 seconds to delete" aria-label="Hold for 5 seconds to delete ${escAttr(b)}">${svgIcon('trash', 14)}</button>`;
        return `<div class="qo-item ${current ? 'on' : ''}" data-br="${escAttr(b)}"><span class="qo-title">${svgIcon('gitBranch', 14)} <span>${esc(b)}</span></span>${current ? '<small class="qo-badge">current</small>' : ''}${del}</div>`;
    });
    return create + rows.join('');
}
const HOLD_MS = 5000; //hold time duration
// Fires onDone only if the button is held for the full 5 seconds; releasing, leaving the button or losing focus cancels.
function holdToDelete(btn, onDone) {
    let timer;
    const stop = (early) => {
        if (timer == null)
            return;
        clearTimeout(timer);
        timer = undefined;
        btn.classList.remove('holding');
        if (early)
            toast('Keep holding for 5 seconds to delete');
    };
    const start = () => {
        if (timer != null)
            return;
        btn.classList.add('holding');
        timer = setTimeout(() => {
            timer = undefined;
            btn.classList.remove('holding');
            if (btn.isConnected) {
                onDone();
            }
        }, HOLD_MS);
    };
    btn.onpointerdown = e => {
        if (e.button !== 0)
            return;
        e.preventDefault();
        e.stopPropagation();
        btn.setPointerCapture(e.pointerId);
        start();
    };
    btn.onpointermove = e => { const r = btn.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
        stop(false); };
    btn.onpointerup = () => stop(true);
    btn.onpointercancel = () => stop(false);
    btn.onblur = () => stop(false);
    btn.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat)
            start();
    } };
    btn.onkeyup = () => stop(true);
    btn.onclick = e => e.stopPropagation(); // never let it count as picking the row
}
async function pickBranch() {
    if (!gitState.repo) {
        showView('git', true);
        return;
    }
    const branches = await api.git.branches().catch(() => []);
    openModal(`<input class="input w-full" id="brIn" aria-label="Branch name" placeholder="Switch to a branch, or type a new name" spellcheck="false"><div class="qo-list" id="brList"></div>`, m => {
        const input = $('#brIn', m);
        input.focus();
        const switchTo = (name, create) => {
            closeModal();
            const msg = create ? `Switched to new branch ${name}` : `Switched to ${name}`;
            if (create || name !== gitState.branch)
                void gitOp(() => api.git.switchTo(name, create), msg);
        };
        const remove = async (name) => {
            if (!(await gitOp(() => api.git.deleteBranch(name), `Deleted branch ${name}`)))
                return;
            const i = branches.indexOf(name);
            if (i >= 0)
                branches.splice(i, 1);
            render();
        };
        const render = () => {
            const q = input.value.trim();
            $('#brList', m).innerHTML = branchListHtml(branches, q);
            $$('[data-br]', m).forEach(el => el.onclick = () => switchTo(el.dataset.br, false));
            $$('[data-del]', m).forEach(btn => holdToDelete(btn, () => void remove(btn.dataset.del)));
            $('[data-new]', m)?.addEventListener('click', () => switchTo(q, true));
        };
        input.oninput = render;
        input.onkeydown = e => { if (e.key === 'Enter')
            $('[data-new], [data-br]', m)?.click(); };
        render();
    }, undefined, 'top');
}
$('#sbBranch').onclick = () => void pickBranch();
async function syncBranch() {
    const s = gitState;
    if (!s.upstream)
        return gitOp(() => api.git.sync('push'), 'Branch published');
    if (!s.behind)
        return gitOp(() => api.git.sync('push'), 'Pushed');
    return gitOp(async () => {
        await api.git.sync('pull');
        if (s.ahead)
            await api.git.sync('push');
    }, 'In sync');
}
Object.assign(commands, {
    'git.refresh': refreshGit,
    'git.init': () => gitOp(() => api.git.init(), 'Repository created'),
    'git.commit': commitNow,
    'git.sync': syncBranch,
    'git.genCommitMsg': () => void generateCommitMsg(),
    'git.more': () => {
        const btn = $('[data-act="git.more"]');
        if (btn && (btn.classList.contains('open') || (justClosedTrigger === btn && Date.now() - justClosedAt < 350))) {
            closeMenu();
            return;
        }
        closeMenu();
        btn?.classList.add('open');
        const r = btn.getBoundingClientRect();
        popupMenu(r.left, r.bottom + 4, [
            { label: 'Pull', run: () => void gitOp(() => api.git.sync('pull'), 'Pulled') },
            { label: 'Push', run: () => void gitOp(() => api.git.sync('push'), 'Pushed') },
            { label: 'Fetch', run: () => void gitOp(() => api.git.sync('fetch'), 'Fetched') },
            { sep: true },
            { label: 'Switch Branch…', run: () => void pickBranch() },
            { label: 'Create Branch…', run: () => void newBranch() },
        ], () => btn?.classList.remove('open'), btn);
    },
});
$('#scmGenMsg')?.addEventListener('click', () => { void generateCommitMsg(); });
/* ================= Views ================= */
function updateActIndicator(immediate = false) {
    const activeBtn = document.querySelector('.act-btn[data-view].on');
    const ind = document.getElementById('actIndicator');
    if (!ind)
        return;
    if (!activeBtn || !layout.sideOpen || !activeBtn.offsetParent) {
        ind.style.opacity = '0';
        return;
    }
    const top = activeBtn.offsetTop + (activeBtn.offsetHeight - 20) / 2;
    if (immediate || !ind.classList.contains('ready')) {
        ind.style.transition = 'none';
        ind.style.transform = `translateY(${top}px)`;
        ind.style.opacity = '1';
        const _reflow = ind.offsetHeight;
        ind.style.transition = '';
        ind.classList.add('ready');
    }
    else {
        ind.style.transform = `translateY(${top}px)`;
        ind.style.opacity = '1';
    }
}
window.addEventListener('resize', () => updateActIndicator(true));
function showView(v, reveal = false) {
    layout.view = v;
    if (reveal && !layout.sideOpen)
        layout.sideOpen = true;
    applyLayout();
    $$('.act-btn[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === v));
    $$('[data-panel]').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== v));
    updateActIndicator();
    if (v === 'git')
        void refreshGit();
}
// Clicking the active view's icon again collapses the side bar, like VS Code.
$$('.act-btn[data-view]').forEach(b => b.onclick = () => {
    const v = b.dataset.view;
    if (v === layout.view && layout.sideOpen) {
        layout.sideOpen = false;
        applyLayout();
    }
    else
        showView(v, true);
});
/* ================= Breeze Box (chat only) ================= */
// The same agents and conversation as the IDE's agent panel, with nothing else on screen.
function enterMode(mode) {
    appState.mode = mode;
    appState.onboarded = true;
    saveApp();
    closeMenu();
    if (mode === 'ide') {
        showIde();
        return;
    }
    swapScreen('#box');
    useSurface('box');
    renderUser();
    renderAgentPill();
    renderBoxFolder();
    // Box lists every agent Breeze found, so look for them if that hasn't happened yet.
    if (!appState.detect)
        detectTools().catch(() => toast('Could not look for agents on this computer'));
    if (!SURFACES.box.chat.children.length)
        restoreChat(SURFACES.box);
    SURFACES.box.prompt.focus();
}
function renderBoxFolder() {
    const chip = $('#boxFolder');
    const name = rootInfo ? rootInfo.name : 'Breeze Box folder';
    chip.innerHTML = `${svgIcon('folder', 13)}<span>${esc(name)}</span>`;
    chip.title = rootInfo ? `Agents work in ${rootInfo.root}` : 'No project open: agents work in Documents/Breeze Box';
}
function boxAgentItems() {
    const a = selectedAgent();
    const items = [];
    if (a?.found && a.models?.length) {
        items.push({ label: `${a.name} Models:`, enabled: () => false }, ...modelMenuItems(a), { sep: true });
    }
    items.push({ label: 'Switch Agent:', enabled: () => false });
    const agents = appState.detect?.agents ?? [];
    for (const ag of agents) {
        items.push({
            label: ag.api && ag.version ? `${ag.name} · ${ag.version}` : ag.name,
            key: ag.found ? undefined : 'not set up',
            checked: () => ag.id === appState.agent,
            enabled: () => ag.found,
            run: () => {
                appState.agent = ag.id;
                saveApp();
                renderAgentPill();
                if (SURFACES.box.chat.querySelector('.empty'))
                    emptyChat(SURFACES.box);
                toast(`Breeze Box now uses ${ag.name}`);
            },
        });
    }
    return [...items, { sep: true }, { label: 'Manage agents…', run: openAgentPicker }];
}
$('#boxModel').onclick = e => {
    const btn = e.currentTarget;
    if (btn.classList.contains('open')) {
        closeMenu();
        return;
    }
    btn.classList.add('open');
    const r = btn.getBoundingClientRect();
    popupMenu(r.left, r.top - 8, boxAgentItems(), () => btn.classList.remove('open'));
    const m = $('#menuRoot .menu');
    m.classList.add('up');
    m.style.top = `${Math.max(8, r.top - m.offsetHeight - 6)}px`; // open upwards, above the composer
};
$('#boxFolder').onclick = e => {
    const btn = e.currentTarget;
    if (btn.classList.contains('open')) {
        closeMenu();
        return;
    }
    btn.classList.add('open');
    const r = btn.getBoundingClientRect();
    const choose = (create) => background(chooseProject(create).then(renderBoxFolder));
    popupMenu(r.left, r.top - 8, [
        { label: 'Open Folder…', run: () => choose(false) },
        { label: 'Create New Project…', run: () => choose(true) },
        ...(rootInfo ? [{ sep: true }, { label: 'Close Folder', run: () => background(closeFolderCmd().then(renderBoxFolder)) }] : []),
    ], () => btn.classList.remove('open'));
    const m = $('#menuRoot .menu');
    m.classList.add('up');
    m.style.top = `${Math.max(8, r.top - m.offsetHeight - 6)}px`;
};
/* ================= Vibe Mode ================= */
// While an agent works, the IDE fades and blurs away and the user's feed plays in a 9:16 frame.
// In the desktop app main.js lays the live site exactly over #vibeFrame; the browser preview shows a placeholder.
const VIBE_DELAY = 3000; // quick answers don't trigger it
let vibeOn = false;
let vibeTimer;
let vibeClock;
let vibeStarted = 0;
let vibeMuted = false;
let vibeSiteShown = null;
const vibeFrame = $('#vibeFrame');
const agentWorking = () => Object.values(agentsDef).some(a => a.status === 'working');
function setVibeArmed(on) {
    appState.vibeArmed = on;
    saveApp();
    refreshSettings();
}
function openFeedPicker() {
    openModal(`<h3>Vibe Mode feeds</h3><p class="sub">Pick what plays while your agents work. Connecting opens the site so you can sign in.</p>
    <div class="social-grid" id="feedPick"></div><div class="row end"><button class="btn btn-primary" data-close>Done</button></div>`, m => void renderFeedChoices($('#feedPick', m)), () => { if (connectedSites().length && !appState.vibeArmed)
        setVibeArmed(true); });
}
commands['vibe.feeds'] = openFeedPicker;
function frameRect() {
    const r = vibeFrame.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
}
function renderVibeSites() {
    $('#vibeSites').innerHTML = connectedSites().map(s => `<button class="${s.id === vibeSiteShown ? 'on' : ''}" data-vibe-site="${s.id}">${brandMark('mark', s.id, s.mark)}<span class="nm">${esc(s.name)}</span></button>`).join('');
    $$('[data-vibe-site]').forEach(b => {
        b.onclick = () => { appState.vibeSite = b.dataset.vibeSite ?? null; saveApp(); showFeed(); };
        b.title = siteById(b.dataset.vibeSite ?? null)?.name ?? '';
    });
    // The card never grows to fit its tabs: when they don't fit, all but the watched one shrink to their icon.
    const row = $('#vibeSites');
    row.classList.remove('tight');
    if (row.scrollWidth > row.clientWidth)
        row.classList.add('tight');
}
function showFeed() {
    const site = siteById(appState.vibeSite) ?? connectedSites()[0];
    vibeSiteShown = site?.id ?? null;
    renderVibeSites();
    const placeholder = $('#vibePlaceholder');
    placeholder.classList.toggle('hidden', isDesktop && !!site);
    placeholder.innerHTML = site
        ? `<div>${brandMark('mark big-mark', site.id, site.mark)}<h4>${esc(site.name)}</h4><div>Your feed plays here in the Breeze desktop app.</div></div>`
        : '<div><h4>No feed connected</h4><div>Open Settings → Vibe Mode Feeds to connect one.</div></div>';
    if (site && isDesktop)
        background(api.vibe.show(site.id, frameRect()));
}
function tickVibeClock() {
    const s = Math.floor((Date.now() - vibeStarted) / 1000);
    $('#vibeClock').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    const a = Object.values(agentsDef).find(x => x.status === 'working');
    if (a)
        $('#vibeTask').textContent = `${a.name}: ${a.task}`;
}
function enterVibe() {
    if (vibeOn)
        return;
    vibeOn = true;
    closeMenu();
    vibeStarted = Date.now();
    $('#vibeReady').classList.add('hidden');
    $('#vibeStatus').classList.remove('hidden');
    $('#vibe').classList.remove('hidden');
    document.body.classList.add('vibing');
    tickVibeClock();
    vibeClock = setInterval(tickVibeClock, 1000);
    // Wait for the stage to settle before laying the live feed over it.
    setTimeout(() => { if (vibeOn)
        showFeed(); }, 450);
}
function exitVibe() {
    if (!vibeOn)
        return;
    vibeOn = false;
    clearInterval(vibeClock);
    if (isDesktop)
        background(api.vibe.hide());
    document.body.classList.remove('vibing');
    $('#vibe').classList.add('hidden');
}
// Called whenever an agent's status changes.
function vibeTick() {
    if (vibeOn && agentWorking() && !$('#vibeReady').classList.contains('hidden')) {
        resumeVibe();
        return;
    }
    if (!appState.vibeArmed || !connectedSites().length || vibeOn || vibeTimer != null || !agentWorking())
        return;
    vibeTimer = setTimeout(() => {
        vibeTimer = undefined;
        if (agentWorking())
            enterVibe();
    }, VIBE_DELAY);
}
// The ready card was showing and the agents started again (e.g. the Builder after plan approval).
function resumeVibe() {
    $('#vibeReady').classList.add('hidden');
    $('#vibeStatus').classList.remove('hidden');
    clearInterval(vibeClock);
    tickVibeClock();
    vibeClock = setInterval(tickVibeClock, 1000);
}
// `plan`: the Planner finished and its plan waits for approval.
function vibeDone(ok, plan = false) {
    clearTimeout(vibeTimer);
    vibeTimer = undefined;
    if (!vibeOn)
        return;
    clearInterval(vibeClock);
    $('#vibeStatus').classList.add('hidden');
    $('#vibeReady').classList.remove('hidden');
    $('#vibeReady').classList.toggle('failed', !ok);
    let text = ok ? '✓ Your code is ready' : 'The agent stopped';
    if (ok && plan)
        text = '📋 The plan is ready for you';
    $('#vibeReadyText').textContent = text;
    let backBtnText = 'Back to code';
    if (ok) {
        backBtnText = plan ? 'Review plan' : 'Show me';
    }
    $('#vibeBack').textContent = backBtnText;
    // The feed keeps playing; leaving Vibe Mode stays the user's call. The card pops and the system says so.
    const card = $('#vibeReady');
    card.classList.remove('ping');
    const _reflow = card.offsetWidth;
    card.classList.add('ping');
    notifyVibe(text.replace(/^\W+\s*/, ''), ok ? 'Head back to Breeze when you’re ready. Your feed keeps playing.' : 'Head back to Breeze to see what happened.');
}
// A system notification, so it is noticed over the feed or from another window. Clicking it brings Breeze up.
function notifyVibe(title, body) {
    if (typeof Notification === 'undefined')
        return;
    const show = () => {
        const n = new Notification(title, { body, icon: '../../assets/brand/Icon.png', tag: 'breeze-vibe' });
        n.onclick = () => { window.focus(); n.close(); };
    };
    if (Notification.permission === 'granted')
        show();
    else if (Notification.permission !== 'denied')
        void Notification.requestPermission().then(p => { if (p === 'granted')
            show(); });
}
$('#vibeClose').onclick = exitVibe;
$('#vibeBack').onclick = () => {
    exitVibe();
    const t = lastRunFiles[0];
    if (t)
        openFile(t);
};
$('#vibeMute').onclick = () => {
    vibeMuted = !vibeMuted;
    void setIcon($('#vibeMute'), vibeMuted ? 'volumeOff' : 'volume');
    $('#vibeMute').title = vibeMuted ? 'Unmute' : 'Mute';
    if (isDesktop)
        background(api.vibe.mute(vibeMuted));
};
// Keep the live feed glued to the frame when the window changes size.
new ResizeObserver(() => { if (vibeOn && vibeSiteShown && isDesktop)
    background(api.vibe.bounds(frameRect())); }).observe(vibeFrame);
/* ================= Discord ================= */
// Rich Presence through the Discord app on this computer (main.js talks to it); updates are coalesced.
const discordSince = Date.now();
let discordTimer;
let discordLive = false; // connected and showing
function discordActivity() {
    const working = Object.values(agentsDef).find(a => a.status === 'working');
    const inBox = appState.mode === 'box';
    const file = active ? baseName(active) : null;
    if (!appState.discordDetails) {
        let details = 'Writing code';
        if (working)
            details = 'Vibe coding with agents';
        else if (inBox)
            details = 'Chatting with an agent';
        return { details, state: 'Breeze Code', start: discordSince };
    }
    let details = inBox ? 'Chatting in Breeze Box' : 'Idle';
    if (working)
        details = `${working.name}: ${working.task}`;
    else if (!inBox && file)
        details = `Editing ${file}`;
    const lang = !inBox && active ? langOf(active)[1] : '';
    const where = rootInfo ? `in ${rootInfo.name}` : 'Breeze Code';
    return { details, state: lang && !working ? `${lang} · ${where}` : where, start: discordSince };
}
// Settings → Discord shows this state; there is no status bar button any more.
let discordState = { state: 'off', why: '' };
function renderDiscord(state, why = '') {
    discordState = { state, why };
    refreshSettings();
}
async function pushDiscord() {
    if (!appState.discord)
        return;
    try {
        await api.discord.set(discordActivity());
        if (!discordLive)
            renderDiscord('on');
        discordLive = true;
    }
    catch (e) {
        discordLive = false;
        renderDiscord('error', errMsg(e));
    }
}
function queueDiscord() {
    if (!appState.discord)
        return;
    clearTimeout(discordTimer);
    discordTimer = setTimeout(() => void pushDiscord(), 1200);
}
async function discordOn(details) {
    appState.discordDetails = details;
    try {
        const r = await api.discord.set(discordActivity());
        appState.discord = true;
        discordLive = true;
        saveApp();
        renderDiscord('on');
        toast(r.user ? `Showing on Discord as ${r.user}` : 'Discord presence on');
        return true;
    }
    catch (e) {
        openModal(`<h3>Couldn't reach Discord</h3><pre class="git-err">${esc(errMsg(e))}</pre><div class="row end"><button class="btn btn-primary" data-close>OK</button></div>`);
        return false;
    }
}
function discordOff() {
    appState.discord = false;
    discordLive = false;
    saveApp();
    clearTimeout(discordTimer);
    renderDiscord('off');
    background(api.discord.clear());
}
/* ================= Modal & misc ================= */
let modalOnClose = null;
const modalOpen = () => !!document.querySelector('#modalRoot .scrim:not(.closing)');
function openModal(html, bind, onClose, place = 'center') {
    closeModal();
    $$('#modalRoot .scrim.closing').forEach(x => x.remove());
    const top = place === 'top';
    $('#modalRoot').insertAdjacentHTML('beforeend', `<div class="scrim ${top ? 'top' : ''}"><div class="modal ${top ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`);
    const m = $('#modalRoot .scrim:not(.closing) .modal');
    modalOnClose = onClose ?? null;
    $('#modalRoot .scrim:not(.closing)').onmousedown = e => { if (e.target.classList.contains('scrim'))
        closeModal(); };
    $$('[data-close]', m).forEach(b => b.onclick = closeModal);
    const owner = popOwner();
    if (owner)
        growFrom(m, owner);
    bind?.(m);
}
function closeModal() {
    const scrim = $('#modalRoot .scrim:not(.closing)');
    if (!scrim)
        return;
    // Play the closing animation on a detached copy so a new modal can open immediately.
    scrim.classList.add('closing');
    setTimeout(() => scrim.remove(), 320);
    const cb = modalOnClose;
    modalOnClose = null;
    cb?.();
}
function bindToasts(root = document) {
    $$('[data-toast]', root).forEach(b => b.onclick = () => toast(b.dataset.toast ?? ''));
}
/* ================= Custom Tooltip UI ================= */
let tooltipEl = null;
let tooltipTimer;
let cursorX = 0;
let cursorY = 0;
let lastTooltipTime = 0;
function initTooltip() {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'breeze-tooltip';
    tooltipEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(tooltipEl);
    const hideTooltip = () => {
        clearTimeout(tooltipTimer);
        if (tooltipEl?.classList.contains('visible')) {
            lastTooltipTime = Date.now();
            tooltipEl.classList.remove('visible');
        }
    };
    const updateTooltipPos = () => {
        if (!tooltipEl?.classList.contains('visible'))
            return;
        const tipW = tooltipEl.offsetWidth;
        const tipH = tooltipEl.offsetHeight;
        let left = cursorX + 10;
        let top = cursorY + 14;
        // Flip horizontally if tooltip would overflow right edge
        if (left + tipW > window.innerWidth - 8) {
            left = cursorX - tipW - 8;
        }
        // Flip vertically if tooltip would overflow bottom edge
        if (top + tipH > window.innerHeight - 8) {
            top = cursorY - tipH - 8;
        }
        // Keep within viewport boundaries
        left = Math.max(6, Math.min(left, window.innerWidth - tipW - 6));
        top = Math.max(6, Math.min(top, window.innerHeight - tipH - 6));
        tooltipEl.style.left = `${Math.round(left)}px`;
        tooltipEl.style.top = `${Math.round(top)}px`;
    };
    document.addEventListener('pointermove', (e) => {
        cursorX = e.clientX;
        cursorY = e.clientY;
        if (tooltipEl?.classList.contains('visible')) {
            updateTooltipPos();
        }
    }, { passive: true });
    document.addEventListener('pointerover', (e) => {
        cursorX = e.clientX;
        cursorY = e.clientY;
        const target = e.target.closest('[title], [data-tooltip], [alt]');
        if (!target) {
            hideTooltip();
            return;
        }
        // Never show tooltips on agents tab, agent pill, or agent tab items
        if (target.closest('#agentTabsBar, #boxAgentTabsBar, #agentPill, #agentCount, #tglAgents, .agent-tab, .agent-tabs-list')) {
            if (target.hasAttribute('title'))
                target.removeAttribute('title');
            hideTooltip();
            return;
        }
        if (target.hasAttribute('title')) {
            const val = target.getAttribute('title') || '';
            target.removeAttribute('title');
            if (val.trim())
                target.dataset.tooltip = val.trim();
        }
        else if (target.hasAttribute('alt') && !target.dataset.tooltip) {
            const val = target.getAttribute('alt') || '';
            if (val.trim())
                target.dataset.tooltip = val.trim();
        }
        const tip = target.dataset.tooltip;
        if (!tip || !tooltipEl) {
            hideTooltip();
            return;
        }
        clearTimeout(tooltipTimer);
        const warmDelay = (Date.now() - lastTooltipTime < 600) ? 0 : 120;
        tooltipTimer = setTimeout(() => {
            if (!target.isConnected || !tooltipEl)
                return;
            tooltipEl.textContent = tip;
            tooltipEl.classList.add('visible');
            updateTooltipPos();
            lastTooltipTime = Date.now();
        }, warmDelay);
    }, true);
    document.addEventListener('pointerout', (e) => {
        const related = e.relatedTarget;
        const current = e.target.closest('[data-tooltip]');
        if (current && related && current.contains(related))
            return;
        hideTooltip();
    }, true);
    document.addEventListener('pointerdown', hideTooltip, true);
    window.addEventListener('scroll', hideTooltip, true);
}
/* ================= Init ================= */
async function boot() {
    void Promise.all([
        document.fonts.load('400 12px Inter'),
        document.fonts.load('500 12px Inter'),
        document.fonts.load('600 11px Inter'),
        document.fonts.load('700 12px Inter'),
    ]);
    buildMenubar();
    applyLayout();
    showView(layout.view);
    renderTree();
    renderTabs();
    renderEditor();
    renderAgents();
    renderPreview();
    emptyChat();
    renderScm();
    renderBranch();
    bindToasts();
    initTooltip();
    void refreshGit();
    renderDetection();
    setVibeArmed(appState.vibeArmed);
    if (appState.discord) {
        renderDiscord('off', 'Connecting to Discord…');
        queueDiscord();
    }
    // The main process remembers who signed in; it wins over the renderer's copy.
    const signed = await api.auth.user().catch(() => null);
    if (signed || isDesktop) {
        user = signed;
        appState.user = signed;
        saveApp();
    }
    await refreshAccounts();
    if (appState.onboarded)
        enterMode(appState.mode);
    else
        goStep(step);
    booted = true;
    updateActIndicator(true);
    const info = await api.fs.restore().catch(() => null);
    if (info)
        await loadWorkspace(info);
    else {
        term.cwd = await api.term.cwd();
        renderPs();
    }
    renderTree();
    if (step === STEP.mode)
        renderModeChoice();
    renderBoxFolder();
    // Refresh the tool and agent status in the background; the cached result shows meanwhile.
    if (appState.onboarded)
        detectTools().catch(() => { });
}
// Opening animation hand-off: the glow and logo are CSS. Once the logo has settled, it glides into the welcome
// page's logo on a first run, or the splash fades out over the app.
function endSplash() {
    const splash = $('#splash');
    const welcome = $('.ob-step[data-step="0"]');
    welcome.classList.remove('ob-await');
    if (getComputedStyle(splash).display === 'none') {
        splash.remove();
        return;
    } // reduced motion: no splash at all
    if (!welcome.getClientRects().length) {
        // Returning user: the app fades in underneath while the splash fades away over it.
        $$('#ide:not(.hidden), #box:not(.hidden)').forEach(el => {
            el.classList.add('app-in');
            el.addEventListener('animationend', () => el.classList.remove('app-in'), { once: true });
        });
        splash.addEventListener('animationend', () => splash.remove(), { once: true });
        splash.classList.add('out');
        return;
    }
    const from = $('.splash-logo', splash).getBoundingClientRect(), to = $('.ob-logo', welcome).getBoundingClientRect();
    splash.style.setProperty('--dx', `${to.left + to.width / 2 - (from.left + from.width / 2)}px`);
    splash.style.setProperty('--dy', `${to.top + to.height / 2 - (from.top + from.height / 2)}px`);
    splash.style.setProperty('--s', String(to.width / from.width));
    welcome.classList.add('ob-landing', 'ob-intro');
    splash.classList.add('leaving');
    setTimeout(() => { welcome.classList.remove('ob-landing'); splash.remove(); }, 700);
}
{
    const splash = $('#splash');
    const starting = boot();
    background(starting);
    if (getComputedStyle(splash).display === 'none')
        endSplash();
    else {
        // The splash stays (its loading bar running) until the logo has settled AND Breeze has finished starting.
        // Each wait has a limit: a hidden window never fires animationend, and a stuck start shouldn't keep the app covered.
        const wait = (ms) => new Promise(done => setTimeout(done, ms));
        const settled = new Promise(done => {
            splash.addEventListener('animationend', e => { if (e.animationName === 'splashLogo')
                setTimeout(done, 150); });
            setTimeout(done, 1200);
        });
        void Promise.all([settled, Promise.race([starting.catch(() => undefined), wait(8000)])]).then(endSplash);
    }
}
