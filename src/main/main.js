// Electron main process for Breeze IDE: window, file system, search, terminal, git, agents, sign-in and Vibe Mode.
const { app, BrowserWindow, Menu, WebContentsView, dialog, ipcMain, nativeImage, net, protocol, safeStorage, session, shell } = require('electron');
const { spawn, execFile, exec } = require('node:child_process');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const nodeModule = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
const { findTools, freshPath, toolEnv, runPlan, runSteps, ensureBuildIgnored, mergePath, installHint, installCmd, installUrl, unpacked } = require('./toolchains');
const { isFileUrl, resolveUnder, blockedRel, agentBlocked, isLocalHost, safeGitArgs, shellCommand } = require('./guard');
const { AntigravityAgentService } = require('./antigravityAgentService.js');
const syncEngine = require('./sync');
const { TeamCoordinator, claudeDenyArgs } = require('./team');
const { parseMentions, shortName } = require('./mentions');

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch {
  // Available when installed; only needed for packaged application updates.
}



const IGNORED_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', '.cache', '__pycache__', '.venv']);
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i;
const MAX_LISTED_FILES = 10000;
const MAX_SEARCH_RESULTS = 500;

let win = null;
let root = null;          // absolute path of the open project folder
let watcher = null;
let liveServer = null;
let liveRoot = null;      // project root used by the local share server
const liveClients = new Set();
let termCwd = os.homedir();
const terms = new Map();  // id -> child process


/* ================= Application updates ================= */
// electron-builder writes app-update.yml from the `build.publish` configuration
// in package.json. electron-updater reads that file in a packaged application.
// Keep update checks out of development, where no update configuration exists.
function configureAutoUpdater() {
  if (!app.isPackaged) {
    console.info('[updater] Skipping update check in development.');
    return;
  }


  if (!autoUpdater) {
    try {
      ({ autoUpdater } = require('electron-updater'));
    } catch (error) {
      console.warn('[updater] Update check unavailable:', error?.message || error);
      return;
    }
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // The download runs in the background: its progress shows on the taskbar button, and if it fails
  // (network, or a release whose latest.yml doesn't match its installer) the user is told instead of left waiting.
  let downloading = false;
  autoUpdater.on('error', async error => {
    // An unavailable release or network issue must not prevent the IDE opening.
    console.error('[updater] Update error:', error?.message || error);
    if (!downloading) return;
    downloading = false;
    win?.setProgressBar(-1);
    const { response } = await dialog.showMessageBox(win, {
      type: 'error',
      title: 'Update failed',
      message: 'The update could not be downloaded.',
      detail: `${error?.message || error}\n\nYou can download the installer from the releases page instead.`,
      buttons: ['Open releases page', 'Close'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) shell.openExternal('https://github.com/itsphatto/BreezeCode/releases/latest');
  });
  autoUpdater.on('download-progress', p => win?.setProgressBar(Math.max(0, Math.min(1, p.percent / 100))));

  autoUpdater.on('update-available', async info => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Update available',
      message: `Breeze Code ${info.version} is available.`,
      detail: 'Download the update now? You can keep using Breeze Code while it downloads.',
      buttons: ['Download update', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return;
    downloading = true;
    win?.setProgressBar(2); // indeterminate until the first progress event
    autoUpdater.downloadUpdate().catch(logError('update download'));
  });

  autoUpdater.on('update-downloaded', async info => {
    downloading = false;
    win?.setProgressBar(-1);
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Update ready',
      message: `Breeze Code ${info.version} has been downloaded.`,
      detail: 'Restart now to install it, or install automatically when you close the app.',
      buttons: ['Restart and install', 'Install on quit'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) autoUpdater.quitAndInstall(false, true);
  });

  autoUpdater.checkForUpdates().catch(logError('update check'));
}



// A development run gets its own data directory, so it doesn't share the installed app's
// single-instance lock (below) and quit as soon as it starts while the installed app is open.
if (!app.isPackaged) app.setPath('userData', `${app.getPath('userData')}-dev`);

// Keep Chromium's cache in this app's own per-user data directory. The shared
// temp directory can be locked by another process on Windows, which prevents
// Chromium from creating its disk and GPU caches.
const SESSION_DATA = path.join(app.getPath('userData'), 'session-data');
fs.mkdirSync(SESSION_DATA, { recursive: true });
app.setPath('sessionData', SESSION_DATA);

// A second copy would fight the first over those caches ("Unable to move the cache: Access is denied"),
// so it focuses the running window and exits before Chromium opens them.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => {
  if (!win) return;
  showMain(); // still behind the launch splash: skip straight to the app
  if (win.isMinimized()) win.restore();
  win.focus();
});

// Logs a failure from work nobody waits for. A page load that a redirect or reload replaced isn't one.
const logError = where => err => {
  if (err?.code !== 'ERR_ABORTED') console.error(`[breeze] ${where}:`, err?.message ?? err);
};
// Opens an https link in the user's browser.
// Web pages, plus dev servers on this computer (a terminal's http://localhost:5173/); never file: or other schemes.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);
function openInBrowser(url) {
  let u;
  try { u = new URL(url); } catch { return; }
  if (u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname))) shell.openExternal(u.href).catch(logError('openExternal'));
}

/* ================= Persisted main-process state ================= */
const statePath = () => path.join(app.getPath('userData'), 'breeze-state.json');
function loadState() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { return { lastRoot: null, recent: [] }; }
}
function saveState(patch) {
  const s = { ...loadState(), ...patch };
  try { fs.writeFileSync(statePath(), JSON.stringify(s, null, 2)); } catch { /* best effort */ }
  return s;
}

/* ================= Window ================= */
// The app icon on the taskbar, window and dock.
const ROOT = path.join(__dirname, '..', '..'); // project root: assets, runtime, .env and breeze.config.json live here
const APP_ICON = path.join(ROOT, 'assets', 'brand', 'Icon.png');
// The one page the window may show. Anything else (a file dropped onto the window, a link) would run with the
// preload bridge, which can run commands, so the window never navigates away from it.
const APP_PAGE = path.join(ROOT, 'src', 'renderer', 'breeze.html');

// Only Breeze's own page may use the main process: not another page in the window, not a frame inside it.
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    const frame = e.senderFrame;
    if (!frame || frame.parent || !isFileUrl(frame.url, APP_PAGE)) throw new Error('Breeze only answers its own window');
    return fn(e, ...args);
  });
}

// The launch intro (launch.html) plays in its own see-through, click-through window, so the light bubbles over the
// desktop itself, darkened but sharp. Only a transparent window shows the desktop unblurred, and a transparent window
// can't be resized, so the app window is a normal one: it loads hidden behind the splash, already showing the intro's
// last frame, and takes over at LAUNCH_HANDOFF (win:launchWait, then win:launchShow), when it lifts onto the app.
const SPLASH_PAGE = path.join(ROOT, 'src', 'renderer', 'launch.html');
const LAUNCH_HANDOFF = 3900; // ms: 0.8s bubbling, 1s opening, the swirl in by 2.1s, then held 1.8s
let splash = null;
let splashStart = 0;
let splashShown = Promise.resolve();

function createSplash(bounds) {
  splash = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    title: 'Breeze Code',
    icon: APP_ICON,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // No setIgnoreMouseEvents here: on Windows it turns the window into an opaque layered one and the desktop stops
  // showing through. The splash can't take focus, so a click on it simply does nothing.
  splash.webContents.on('will-navigate', e => e.preventDefault());
  splash.on('closed', () => { splash = null; });
  // The hand-off counts from when the intro first shows; a splash that never paints doesn't hold the app back.
  splashShown = new Promise(done => {
    splash.once('ready-to-show', () => { splashStart = Date.now(); splash?.show(); done(); });
    setTimeout(done, 3000);
  });
  splash.loadFile(SPLASH_PAGE).catch(logError('splash'));
}

// Shows the app window and, once it has drawn over the splash, closes the splash.
function showMain() {
  if (win && !win.isVisible()) win.show();
  const s = splash;
  splash = null;
  if (s) setTimeout(() => { if (!s.isDestroyed()) s.destroy(); }, 150);
}

// The page waits here until the intro has played through, then gets how long it has been running, so it can match
// the sky's drifting light before it shows. null: no splash (a reload), so there is nothing to hand over.
handle('win:launchWait', async () => {
  if (!splash) return null;
  await splashShown;
  const left = LAUNCH_HANDOFF - (Date.now() - splashStart);
  if (splashStart && left > 0) await new Promise(done => setTimeout(done, left));
  return splashStart ? Date.now() - splashStart : 0;
});
handle('win:launchShow', () => showMain());

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false, // shown by showMain, at the launch hand-off
    title: 'Breeze Code',
    icon: APP_ICON,
    backgroundColor: '#1d1d1f',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#232325', symbolColor: '#aaaaaa', height: 38 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Breeze's own clicks and chimes: without this Chromium can hold the audio back until a gesture, and
      // suspends it again when idle, so some sounds were silently dropped.
      autoplayPolicy: 'no-user-gesture-required',
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: [`--breeze-version=${app.getVersion()}`],
    },
  });

  showTaskbarIcon(win);
  createSplash(win.getBounds());
  // However the page fares, the app window shows in the end.
  setTimeout(showMain, LAUNCH_HANDOFF + 5000);
  win.loadFile(APP_PAGE).catch(logError('loadFile'));

  // Open external links in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isFileUrl(url, APP_PAGE)) e.preventDefault();
  });
  // A reload or crash drops the renderer's terminal state, so nothing may keep running for it.
  win.webContents.on('did-start-navigation', (_e, _url, _inPlace, isMainFrame) => { if (isMainFrame) killAllTerms(); });
  win.webContents.on('render-process-gone', killAllTerms);
  win.on('closed', () => { win = null; vibeView = null; splash?.destroy(); stopWatching(); stopLiveServer(); killAllTerms(); });
}

// Windows draws the taskbar button from the app's user model id, which in development is electron.exe, so the
// button showed Electron's atom instead of Breeze. setAppDetails points that id at our icon; it wants an .ico,
// so one is written once (a PNG inside an ICO wrapper) into the user data folder.
function showTaskbarIcon(w) {
  if (!isWin) return;
  try {
    const png = nativeImage.createFromPath(APP_ICON).resize({ width: 256, height: 256, quality: 'best' }).toPNG();
    const ico = path.join(app.getPath('userData'), 'Icon.ico');
    if (!fs.existsSync(ico) || fs.statSync(ico).mtimeMs < fs.statSync(APP_ICON).mtimeMs) {
      const head = Buffer.alloc(22);
      head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4); // ICO, one image
      head.writeUInt8(0, 6); head.writeUInt8(0, 7); // 0 = 256 px
      head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12); // planes, bits per pixel
      head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
      fs.writeFileSync(ico, Buffer.concat([head, png]));
    }
    w.setIcon(nativeImage.createFromBuffer(png));
    // The window gets its own id: with the process id (electron.exe's path in development) Windows looks the
    // icon up from that exe. A separate id plus the relaunch icon makes the taskbar button use ours.
    w.setAppDetails({ appId: app.isPackaged ? 'com.breeze.ide' : 'com.breeze.ide.dev', appIconPath: ico, appIconIndex: 0, relaunchDisplayName: 'Breeze Code' });
  } catch (e) { logError('taskbar icon')(e); }
}

// The preview iframe is sandboxed (an opaque origin), and Chromium won't let an opaque origin load file://
// stylesheets, scripts or images. So the preview is served from breeze-preview://project/<path> instead.
const PREVIEW_SCHEME = 'breeze-preview';
protocol.registerSchemesAsPrivileged([{ scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const PREVIEW_STYLE = '<style data-breeze-preview>html,body{scrollbar-width:none}::-webkit-scrollbar{display:none;width:0;height:0}</style>';
// Goes right after <head> (or <html>) so the doctype stays first and the page keeps standards mode.
function withHiddenScrollbars(html) {
  const at = /<head\b[^>]*>/i.exec(html) || /<html\b[^>]*>/i.exec(html);
  return at ? html.slice(0, at.index + at[0].length) + PREVIEW_STYLE + html.slice(at.index + at[0].length) : html + PREVIEW_STYLE;
}
async function servePreview(req) {
  try {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '');
    let abs = resolveIn(rel);
    if ((await fsp.stat(abs)).isDirectory()) abs = resolveIn(path.join(rel, 'index.html')); // it may be a link too
    const res = await net.fetch(pathToFileURL(abs).href);
    const type = res.headers.get('content-type') || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' };
    // Pages scroll without a scrollbar in the preview, like the rest of Breeze (the sandboxed frame can't be styled from outside).
    if (/text\/html/i.test(type)) return new Response(withHiddenScrollbars(await res.text()), { status: res.status, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
    return new Response(res.body, { status: res.status, headers });
  } catch {
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  }
}

async function startApp() {
  await app.whenReady();
  protocol.handle(PREVIEW_SCHEME, servePreview);
  // The menu bar is drawn in HTML; the native one would only duplicate it.
  Menu.setApplicationMenu(null);
  if (process.platform === 'darwin') app.dock?.setIcon(APP_ICON);
  // Windows only shows notifications (Vibe Mode's "your code is ready") for an app with a user model id.
  if (isWin) app.setAppUserModelId(app.isPackaged ? 'com.breeze.ide' : process.execPath);
  createWindow();
  try { await getTools(); } catch (e) { logError('toolchains')(e); }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  configureAutoUpdater();
}
startApp().catch(logError('startup'));

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ================= Paths ================= */
// resolveUnder (guard.js) refuses anything that leaves the folder, by `..` or through a link.
function resolveIn(rel = '') {
  if (!root) throw new Error('No folder is open');
  return resolveUnder(root, rel);
}
const relTo = (base, abs) => path.relative(base, abs).split(path.sep).join('/');
const toRel = abs => relTo(root, abs);
// Breeze Box chats work here when no project folder is open.
function boxDir() {
  const dir = path.join(app.getPath('documents'), 'Breeze Box');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function setRoot(dir) {
  const st = await fsp.stat(dir);
  if (!st.isDirectory()) throw new Error('Not a folder');
  if (root !== dir) { stopLiveServer(); stopTeams(); }
  root = dir;
  termCwd = dir;
  const saved = loadState();
  const recent = [dir, ...(saved.recent || []).filter(r => r !== dir)].slice(0, 10);
  // When each recent folder was last opened, for the Home screen's "2h ago".
  const recentAt = Object.fromEntries(recent.map(r => [r, r === dir ? Date.now() : saved.recentAt?.[r] ?? null]));
  saveState({ lastRoot: dir, recent, recentAt });
  startWatching();
  return { root: dir, name: path.basename(dir) };
}

/* ================= Watching ================= */
function startWatching(retried = false) {
  stopWatching();
  let pending = new Set();
  let timer = null;
  try {
    watcher = fs.watch(root, { recursive: true }, (_type, file) => {
      if (!file) return;
      const rel = String(file).split(path.sep).join('/');
      // Build output and dependencies change in bursts nobody is looking at (the file list skips them too).
      if (rel.split('/').some(part => IGNORED_DIRS.has(part))) return;
      pending.add(rel);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const changed = [...pending];
        win?.webContents.send('fs:changed', changed);
        notifyLiveClients(changed);
        pending = new Set();
      }, 250);
    });
    watcher.on('error', err => {
      stopWatching();
      // Try once more (a busy disk or a renamed folder can end a watch), then tell the user.
      if (!retried && root) setTimeout(() => { if (root && !watcher) startWatching(true); }, 1000);
      else watchLost(err);
    });
  } catch (err) { watcher = null; watchLost(err); } // some file systems can't be watched; Refresh still works
}
function watchLost(err) {
  logError('watch')(err);
  win?.webContents.send('fs:watchLost', err?.message ?? String(err));
}
function stopWatching() { watcher?.close(); watcher = null; }

/* ================= Live Share ================= */
// A deliberately small local-only static server. Files are read on each request, so browser refreshes
// always see the current on-disk project state; connected pages receive a reload event after edits.
const LIVE_PORT = 2026;
const LIVE_URL = `http://127.0.0.1:${LIVE_PORT}/`;
const LIVE_RELOAD_PATH = '/__breeze_live_reload';
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.wasm': 'application/wasm',
};
const liveReloadScript = `<script>(() => { const s = new EventSource('${LIVE_RELOAD_PATH}'); s.onmessage = () => location.reload(); })();</script>`;
function notifyLiveClients(changed) {
  if (!liveClients.size) return;
  const body = `data: ${JSON.stringify({ changed })}\n\n`;
  for (const res of liveClients) res.write(body);
}
function stopLiveServer() {
  for (const res of liveClients) {
    try { res.end(); } catch {}
  }
  liveClients.clear();
  if (liveServer) {
    try {
      if (typeof liveServer.closeAllConnections === 'function') {
        liveServer.closeAllConnections();
      }
    } catch {}
    try {
      liveServer.close();
    } catch {}
  }
  liveServer = null;
  liveRoot = null;
}
async function findLiveIndex(dir = root) {
  if (!dir) return null;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return null; }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const index = entries.find(entry => entry.isFile() && entry.name === 'index.html');
  if (index) return path.join(dir, index.name);
  for (const entry of entries) {
    if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
    const nested = await findLiveIndex(path.join(dir, entry.name));
    if (nested) return nested;
  }
  return null;
}
async function liveIndexUrl() {
  const index = await findLiveIndex();
  return index ? new URL(`${relTo(root, index).replace(/index\.html$/, '')}`, LIVE_URL).href : LIVE_URL;
}
async function hasLiveIndex() {
  return !!(await findLiveIndex());
}
async function serveLive(req, res) {
  if (!isLocalHost(req.headers.host, LIVE_PORT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  try {
    const parsed = new URL(req.url || '/', LIVE_URL);
    if (parsed.pathname === LIVE_RELOAD_PATH) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      liveClients.add(res);
      req.on('close', () => liveClients.delete(res));
      return;
    }
    const decoded = decodeURIComponent(parsed.pathname);
    const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    let abs = resolveUnder(liveRoot, rel);
    let st = await fsp.stat(abs);
    if (st.isDirectory()) {
      abs = resolveUnder(liveRoot, path.join(rel, 'index.html'));
      st = await fsp.stat(abs);
    }
    if (!st.isFile()) throw new Error('Not a file');
    if (agentBlocked(liveRoot, abs)) throw new Error('Not shared'); // .env files and .git stay private: answered as Not found
    const type = MIME_TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    let body = await fsp.readFile(abs);
    if (type.startsWith('text/html')) {
      const html = body.toString('utf8');
      body = Buffer.from(/<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${liveReloadScript}</body>`) : html + liveReloadScript);
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}
async function startLiveServer() {
  const index = await findLiveIndex();
  if (!index) throw new Error('Live Share needs an index.html file in the project');
  liveRoot = root;
  const url = await liveIndexUrl();
  if (!liveServer) {
    liveServer = http.createServer((req, res) => { void serveLive(req, res); });
    await new Promise((resolve, reject) => {
      const fail = err => { liveServer?.off('listening', ready); liveServer = null; reject(err); };
      const ready = () => { liveServer?.off('error', fail); resolve(); };
      liveServer.once('error', fail);
      liveServer.once('listening', ready);
      liveServer.listen(LIVE_PORT, '127.0.0.1');
    });
  }
  openInBrowser(url);
  return { url, running: true };
}

/* ================= File system IPC ================= */
// Folders first, then names A–Z.
function byDirThenName(a, b) {
  if (a.dir !== b.dir) return a.dir ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

handle('fs:openFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return setRoot(r.filePaths[0]);
});

// Asks where to create a new project folder (its name is typed in the dialog), creates it and opens it.
handle('fs:createFolder', async () => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Create a new project', buttonLabel: 'Create',
    defaultPath: path.join(app.getPath('documents'), 'my-breeze-project'),
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  if (r.canceled || !r.filePath) return null;
  if (fs.existsSync(r.filePath)) {
    const inside = await fsp.readdir(r.filePath).catch(() => ['(a file)']);
    if (inside.length) throw new Error(`${path.basename(r.filePath)} already exists and isn't empty — pick another name`);
  }
  await fsp.mkdir(r.filePath, { recursive: true });
  return setRoot(r.filePath);
});

handle('fs:restore', async () => {
  const { lastRoot } = loadState();
  if (!lastRoot) return null;
  try { return await setRoot(lastRoot); } catch { saveState({ lastRoot: null }); return null; }
});

handle('fs:closeFolder', () => {
  root = null; termCwd = os.homedir(); stopWatching(); stopLiveServer(); stopTeams(); saveState({ lastRoot: null });
});

handle('fs:recent', () => {
  const st = loadState();
  return (st.recent || []).map(p => ({ path: p, name: path.basename(p), openedAt: st.recentAt?.[p] ?? null, missing: !fs.existsSync(p) }));
});

handle('fs:forgetRecent', (_e, dir) => {
  const st = loadState();
  const recentAt = { ...st.recentAt };
  delete recentAt[dir];
  saveState({ recent: (st.recent || []).filter(r => r !== dir), recentAt });
});

handle('fs:openRecent', async (_e, dir) => {
  if (!(loadState().recent || []).includes(dir)) throw new Error('Unknown folder');
  return setRoot(dir);
});

handle('fs:readDir', async (_e, rel) => {
  const entries = await fsp.readdir(resolveIn(rel), { withFileTypes: true });
  return entries.map(d => ({ name: d.name, dir: d.isDirectory() })).sort(byDirThenName);
});

handle('fs:readFile', async (_e, rel) => {
  const abs = resolveIn(rel);
  const st = await fsp.stat(abs);
  // Images are shown from their file URL, so only their size is needed here.
  if (IMAGE_FILE.test(abs)) return { image: true, size: st.size };
  if (st.size > MAX_FILE_BYTES) return { tooLarge: true, size: st.size };
  const buf = await fsp.readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) return { binary: true, size: st.size };
  return { text: buf.toString('utf8'), size: st.size };
});

handle('fs:writeFile', async (_e, rel, text) => {
  await fsp.writeFile(resolveIn(rel), text, 'utf8');
});

handle('fs:createFile', async (_e, rel) => {
  const abs = resolveIn(rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, '', { flag: 'wx' });
});

handle('fs:createDir', async (_e, rel) => {
  await fsp.mkdir(resolveIn(rel), { recursive: false });
});

handle('fs:rename', async (_e, from, to) => {
  const src = resolveIn(from), dest = resolveIn(to);
  // A case-only rename (foo.js → Foo.js) finds the file itself at the new name on Windows and macOS.
  if (fs.existsSync(dest) && !(await sameFile(src, dest))) throw new Error('Something with that name already exists');
  await fsp.rename(src, dest);
});
async function sameFile(a, b) {
  try {
    const [x, y] = await Promise.all([fsp.stat(a, { bigint: true }), fsp.stat(b, { bigint: true })]);
    return x.dev === y.dev && x.ino === y.ino;
  } catch { return false; }
}

// Deleting moves to the Recycle Bin / Trash so it can be undone.
handle('fs:trash', async (_e, rel) => {
  if (!rel) throw new Error('Refusing to delete the project folder');
  await shell.trashItem(resolveIn(rel));
});

handle('fs:fileUrl', (_e, rel) => {
  const base = root || boxDir();
  return pathToFileURL(resolveUnder(base, rel)).href;
});

handle('fs:previewUrl', (_e, rel) => {
  resolveIn(rel); // throws when no folder is open or the path leaves the project
  const segments = String(rel).replaceAll('\\', '/').split('/').map(encodeURIComponent).join('/');
  return `${PREVIEW_SCHEME}://project/${segments}`;
});

// Every file under `dir`, skipping build output and dependencies. Folders are read in parallel.
async function listFiles(dir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; } // unreadable folder: skip it
  const files = entries.filter(d => d.isFile()).map(d => path.join(dir, d.name));
  const subdirs = entries.filter(d => d.isDirectory() && !IGNORED_DIRS.has(d.name)).map(d => path.join(dir, d.name));
  const nested = await Promise.all(subdirs.map(listFiles));
  return files.concat(...nested).slice(0, MAX_LISTED_FILES);
}

const IMPORT_MAX_BYTES = 50 * 1024 * 1024;
// A dropped file arrives as bytes, so Breeze never reads a path the page names. Never overwrites: a taken name gets " (1)".
handle('fs:import', async (_e, dirRel, name, data) => {
  if (!(data instanceof Uint8Array)) throw new Error('Nothing to save');
  if (data.byteLength > IMPORT_MAX_BYTES) throw new Error(`${path.basename(String(name))} is larger than 50 MB`);
  const base = root || boxDir();
  const target = resolveUnder(base, path.join(String(dirRel || ''), String(name)));
  if (path.relative(base, target).split(path.sep).some(p => /^(?:\.git|git~1)[. ]*$/i.test(p))) throw new Error('Files can’t be dropped into the .git folder');
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const { dir, name: stem, ext } = path.parse(target);
  for (let n = 0; ; n++) {
    const candidate = n ? path.join(dir, `${stem} (${n})${ext}`) : target;
    try { await fsp.writeFile(candidate, data, { flag: 'wx' }); return path.relative(base, candidate).split(path.sep).join('/'); }
    catch (err) { if (err.code !== 'EEXIST' || n > 999) throw err; }
  }
});




handle('fs:listFiles', async () => (await listFiles(resolveIn(''))).map(toRel));

handle('fs:search', (_e, query, matchCase) => searchProject(query, matchCase));

// A file's text if it is small and not binary, else null.
async function readSearchable(abs) {
  try {
    const st = await fsp.stat(abs);
    if (st.size > 1024 * 1024) return null;
    const buf = await fsp.readFile(abs);
    return buf.subarray(0, 8000).includes(0) ? null : buf.toString('utf8');
  } catch {
    return null; // deleted or locked while searching
  }
}
function searchText(text, rel, needle, matchCase, results) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && results.length < MAX_SEARCH_RESULTS; i++) {
    const col = (matchCase ? lines[i] : lines[i].toLowerCase()).indexOf(needle);
    if (col !== -1) results.push({ path: rel, line: i, col, text: lines[i].slice(0, 300) });
  }
}
// Reads files a batch at a time and stops once there are enough results. `skip(rel)` leaves files out.
async function searchProject(query, matchCase, base = resolveIn(''), skip = () => false) {
  if (!query) return [];
  const files = (await listFiles(base)).filter(f => !skip(relTo(base, f)));
  const needle = matchCase ? query : query.toLowerCase();
  const results = [];
  const batch = async start => {
    if (start >= files.length || results.length >= MAX_SEARCH_RESULTS) return;
    const texts = await Promise.all(files.slice(start, start + 32).map(readSearchable));
    texts.forEach((text, k) => { if (text != null) searchText(text, relTo(base, files[start + k]), needle, matchCase, results); });
    await batch(start + 32);
  };
  await batch(0);
  return results;
}

/* ================= Syntax check (JavaScript / TypeScript) ================= */
// V8 compiles the code into a function that is never called, so this only finds syntax errors.
// Returns { ok: true }, the first error as { line, col, len, msg, eof } (0-based), or null when it can't tell.
const MODULE_SYNTAX = [/^[ \t]*import\s*[\w$*{'"]/m, /^[ \t]*export\b/m, /\bimport\.meta\b/];
const MODULE_WRAP = '(async function(){"use strict";';
const blank = s => s.replaceAll(/[^\n]/g, ' ');

// The end of an `import … from '…'` or `export … from '…'` statement starting at `from`, or -1.
function statementEnd(code, from) {
  let i = from;
  const brace = code.indexOf('{', i);
  const quote = code.slice(i).search(/["']/) + i;
  if (brace !== -1 && brace < quote) i = code.indexOf('}', brace) + 1;
  const q = code.slice(i).search(/["']|;|\n\s*\n/);
  if (q === -1 || !/["']/.test(code[i + q])) return i; // `export { a, b };` with no module
  const open = i + q, close = code.indexOf(code[open], open + 1);
  if (close === -1) return -1;
  let end = close + 1;
  const attrs = /^\s*(?:with|assert)\s*\{[^}]*\}/.exec(code.slice(end));
  if (attrs) end += attrs[0].length;
  return code[end] === ';' ? end + 1 : end;
}
// Blank out import/export syntax (same length, same lines) so module code parses inside a function.
function moduleAsScript(code) {
  const chars = [...code];
  const wipe = (from, to) => { for (let k = from; k < to; k++) if (chars[k] !== '\n') chars[k] = ' '; };
  if (code.startsWith('#!')) wipe(0, code.indexOf('\n') === -1 ? code.length : code.indexOf('\n'));
  for (const m of code.matchAll(/^[ \t]*import\b(?![ \t]*[.(])/gm)) {
    const end = statementEnd(code, m.index + m[0].length);
    if (end > 0) wipe(m.index, end);
  }
  for (const m of code.matchAll(/^[ \t]*export[ \t]*(?=[*{])/gm)) {
    const end = statementEnd(code, m.index + m[0].length);
    if (end > 0) wipe(m.index, end);
  }
  return chars.join('')
    .replaceAll(/\bimport\.meta\b/g, 'Object.meta')
    .replaceAll(/^([ \t]*)export[ \t]+default\b/gm, (m, ind) => ind + 'void' + ' '.repeat(m.length - ind.length - 4))
    .replaceAll(/^[ \t]*export[ \t]+(?=(?:async[ \t]+)?function\b|class\b|const\b|let\b|var\b)/gm, blank);
}

// V8 and Node's TypeScript stripper both report "<file>:LINE", the source line(s), then a row of carets.
function syntaxError(e, code, shift) {
  const rows = String(e.stack || '').split('\n');
  const line = Number(rows[0].slice(rows[0].lastIndexOf(':') + 1)) - 1;
  if (!Number.isInteger(line) || line < 0) return null;
  const caret = rows.slice(1, 6).find(r => r.trim() && /^\^+$/.test(r.trim())) || '';
  const lines = code.split('\n');
  const eof = line >= lines.length || /end of input/i.test(e.message);
  if (line >= lines.length) return { line: lines.length - 1, col: lines.at(-1).length, len: 1, msg: 'Unexpected end of input', eof };
  const col = Math.max(0, caret.indexOf('^') - (line === 0 ? shift : 0));
  return { line, col, len: Math.max(1, caret.trim().length), msg: e.message, eof };
}
// Types are blanked out in place (same positions); enums and namespaces need a real compiler, so those return null.
function stripTypes(code) {
  try { return { src: nodeModule.stripTypeScriptTypes(code, { mode: 'strip' }) }; }
  catch (e) { return { error: e.code === 'ERR_INVALID_TYPESCRIPT_SYNTAX' ? syntaxError(e, code, 0) : null }; }
}
function syntaxCheck(code, ext) {
  let src = code;
  if (/^[mc]?ts$/.test(ext)) {
    const r = stripTypes(code);
    if (!r.src) return r.error;
    src = r.src;
  }
  const isModule = /^m[jt]s$/.test(ext) || MODULE_SYNTAX.some(re => re.test(src));
  if (isModule) src = `${MODULE_WRAP}${moduleAsScript(src)}\n})`;
  try {
    vm.compileFunction(src, [], { filename: 'check' });
    return { ok: true };
  } catch (e) {
    if (!(e instanceof SyntaxError)) return null;
    if (e.message === "Unexpected token '<'" && /^[mc]?js$/.test(ext)) return null; // probably JSX in a .js file
    return syntaxError(e, code, isModule ? MODULE_WRAP.length : 0);
  }
}
handle('lint:check', (_e, code, ext) => (typeof code === 'string' && code.length <= 400000 ? syntaxCheck(code, String(ext)) : null));

/* ================= Terminal ================= */
let nextTermId = 1;
handle('term:cwd', () => termCwd);

const unquote = s => (s.length > 1 && (s[0] === '"' || s[0] === "'") && s.at(-1) === s[0] ? s.slice(1, -1) : s);
// "cd somewhere" changes the terminal's folder instead of running in a shell that exits right away.
function changeDir(command) {
  const t = command.trim();
  if (!/^cd(?:\s|$)/i.test(t)) return null;
  const arg = unquote(t.slice(2).trim());
  const target = arg ? path.resolve(termCwd, arg) : os.homedir();
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return { error: `The system cannot find the path specified: ${target}` };
  termCwd = target;
  return { cwd: termCwd };
}
handle('term:run', async (_e, command) => {
  const cd = changeDir(command);
  if (cd) return cd;
  const { tools, pathValue } = await getTools();
  const id = nextTermId++;
  const env = toolEnv(process.env, [...tools.binDirs, ...agentDirs()], process.platform, pathValue);
  env.FORCE_COLOR = '1';
  env.NPM_CONFIG_COLOR = 'always';
  const child = spawn(command, { shell: true, cwd: termCwd, env, windowsHide: true });
  terms.set(id, child);
  child.stdin.on('error', ignoreEpipe);
  // Decoded as a stream, so a character split across two chunks stays whole.
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const send = chunk => win?.webContents.send('term:data', id, chunk);
  child.stdout.on('data', send);
  child.stderr.on('data', send);
  child.on('error', err => send(`${err.message}\n`));
  child.on('close', code => { terms.delete(id); win?.webContents.send('term:exit', id, code); });
  return { id };
});
handle('term:write', (_e, id, text) => {
  const stdin = terms.get(id)?.stdin;
  if (stdin?.writable) stdin.write(String(text));
});

// Compilers and Python found on this PC (memoised; `force` looks again, e.g. after the user installs one).
const ignoreEpipe = () => { /* the program exited before reading its input */ };
const probe = (file, args) => new Promise(res => {
  execFile(file, args, { windowsHide: true, timeout: 4000 }, (err, stdout) => {
    let code = 0;
    if (err) {
      code = typeof err.code === 'number' ? err.code : null;
    }
    res({ code, stdout: String(stdout || '') });
  });
});
// lstat, not existsSync: Store app-execution aliases (WindowsApps\python.exe) fail existsSync
const exists = p => { try { fs.lstatSync(p); return true; } catch { return false; } };
// Expands one `*` in the last path segment that has one.
function glob(pattern) {
  const parts = pattern.split(/[\\/]/);
  const i = parts.findIndex(p => p.includes('*'));
  if (i === -1) return [pattern];
  const parent = parts.slice(0, i).join(path.sep);
  const re = new RegExp('^' + parts[i].split('*').map(x => x.replaceAll(/\W/g, String.raw`\$&`)).join('.*') + '$', 'i');
  try {
    return fs.readdirSync(parent).filter(n => re.test(n)).map(n => [parent, n, ...parts.slice(i + 1)].join(path.sep));
  } catch { return []; }
}
let toolsPromise = null;
function getTools(force = false) {
  if (!toolsPromise || force) {
    const p = toolsPromise = (async () => {
      const inheritedKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path');
      const pathValue = mergePath(await freshPath(process.platform, probe), inheritedKey ? process.env[inheritedKey] : '', process.platform);
      const tools = await findTools({ platform: process.platform, pathValue, env: process.env, exists, glob, run: probe });
      return { tools, pathValue };
    })();
    p.catch(() => { if (toolsPromise === p) toolsPromise = null; }); // don't keep a failed lookup
  }
  return toolsPromise;
}

// Runs a .c, .cpp, .cs, .java, .py or .rs file in the open folder, streaming into the terminal under one id.
let activeRun = null; // { id, cancel }
const SOURCE_FILE = /\.(?:c|cc|cpp|cxx|cs|java|py|rs)$/i;
// The nearest project file (a .csproj, a Cargo.toml) in the file's folder or a folder above it, without leaving the open project.
function nearestProject(abs, isProject) {
  for (let dir = path.dirname(abs); ; dir = path.dirname(dir)) {
    let names = [];
    try { names = fs.readdirSync(dir).filter(name => isProject(name)).sort((a, b) => a.localeCompare(b)); } catch { /* unreadable: keep looking up */ }
    if (names.length) return path.join(dir, names[0]);
    if (path.relative(root, dir) === '' || dir === path.dirname(dir)) return null;
  }
}
handle('run:file', async (_e, rel) => {
  if (activeRun) return { error: 'A program is still running — press Ctrl+C to stop it' };
  if (!root) return { error: 'Open a folder first' };
  const claim = activeRun = { id: 0, cancel() { /* still starting */ } };
  const fail = error => {
    if (activeRun === claim) {
      activeRun = null;
    }
    return { error };
  };
  try {
    const abs = resolveIn(rel);
    // gcc can't read inside the packaged app's asar archive; the header is unpacked next to it.
    const stdioHeader = unpacked(path.join(ROOT, 'runtime', 'breeze_stdio.h'));
    let { tools, pathValue } = await getTools();
    const opts = {
      csproj: /\.cs$/i.test(abs) ? nearestProject(abs, n => /\.csproj$/i.test(n)) : null,
      cargoToml: /\.rs$/i.test(abs) ? nearestProject(abs, n => n === 'Cargo.toml') : null,
    };
    let plan = runPlan(abs, tools, process.platform, stdioHeader, opts);
    if (plan.error && SOURCE_FILE.test(abs)) {
      ({ tools, pathValue } = await getTools(true));
      plan = runPlan(abs, tools, process.platform, stdioHeader, opts);
    }
    if (plan.error) return fail(plan.error);
    if (plan.steps.length > 1) fs.mkdirSync(path.join(plan.steps[0].cwd, 'build'), { recursive: true }); // gcc and rustc won't create it
    if (plan.steps.length > 1) { try { ensureBuildIgnored(root); } catch { /* .gitignore is a nicety */ } }
    if (activeRun !== claim) return { error: 'Cancelled' }; // the window reloaded while this was starting
    const id = claim.id = nextTermId++;
    const send = text => win?.webContents.send('term:data', id, text);
    // Start after the reply is sent, so the renderer knows the id before the first output arrives.
    setImmediate(() => {
      if (activeRun !== claim) return; // cancelled (window reloaded) before it started
      try {
        const { cancel } = runSteps(plan.steps, {
          spawn,
          env: toolEnv(process.env, tools.binDirs, process.platform, pathValue),
          onStart: step => send(`${step.cwd}> ${step.display}\n`),
          onData: send,
          onChild: child => { terms.set(id, child); child.stdin.on('error', ignoreEpipe); },
          onDone: (code, ms) => {
            terms.delete(id);
            if (activeRun === claim) activeRun = null;
            const outcome = code === null ? 'stopped' : `exited with code ${code}`;
            send(`${outcome} · ${(ms / 1000).toFixed(1)}s\n`);
            win?.webContents.send('term:exit', id, code);
          },
        });
        claim.cancel = cancel;
      } catch (err) {
        if (activeRun === claim) activeRun = null;
        send(err.message + '\n');
        win?.webContents.send('term:exit', id, 1);
      }
    });
    // Where the program runs (a Cargo project's folder, say): relative paths in its errors resolve there.
    return { id, cwd: plan.steps[0].cwd };
  } catch (err) {
    return fail(err.message);
  }
});

const TASKKILL = path.join(process.env.SystemRoot || String.raw`C:\Windows`, 'System32', 'taskkill.exe');
function killTree(child) {
  if (process.platform === 'win32') execFile(TASKKILL, ['/pid', String(child.pid), '/T', '/F'], () => { /* already gone */ });
  else child.kill('SIGTERM');
}
handle('term:kill', (_e, id) => {
  const c = terms.get(id);
  if (c) killTree(c); // the whole tree first, then stop the run from starting its next step
  if (activeRun?.id === id) activeRun.cancel();
});
// Completes the last word of a terminal line to a file or folder in the terminal's folder.
handle('term:complete', async (_e, word) => {
  const w = unquote(String(word || ''));
  const cut = Math.max(w.lastIndexOf('/'), w.lastIndexOf('\\')) + 1;
  const dirPart = w.slice(0, cut), start = w.slice(cut).toLowerCase();
  let entries;
  try { entries = await fsp.readdir(path.resolve(termCwd, dirPart || '.'), { withFileTypes: true }); } catch { return []; } // no such folder
  return entries
    .filter(d => d.name.toLowerCase().startsWith(start))
    .map(d => ({ name: d.name, dir: d.isDirectory() }))
    .sort(byDirThenName)
    .slice(0, 60)
    .map(d => ({ text: dirPart + d.name + (d.dir ? '/' : ''), dir: d.dir }));
});
function killAllTerms() {
  for (const c of terms.values()) killTree(c);
  terms.clear();
  if (activeRun) { activeRun.cancel(); activeRun = null; }
}

/* ================= Tool & agent detection ================= */
const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const isWin = process.platform === 'win32';

const AGENTS = [
  {
    id: 'antigravity', name: 'Antigravity', vendor: 'Google DeepMind', commands: ['agy', 'antigravity'],
    url: 'https://antigravity.google/',
    paths: () => isWin ? [
      path.join(LOCALAPPDATA, 'agy', 'bin', 'agy.exe'),
      path.join(HOME, '.gemini', 'antigravity-cli', 'bin', 'agy.cmd'),
      path.join(APPDATA, 'npm', 'agy.cmd'),
      path.join(LOCALAPPDATA, 'Programs', 'Antigravity IDE', 'bin', 'antigravity-ide.cmd'),
      path.join(HOME, '.gemini', 'antigravity-ide', 'bin', 'agentapi.bat'),
      path.join(LOCALAPPDATA, 'Programs', 'Antigravity IDE', 'Antigravity IDE.exe'),
    ] : [
      path.join(HOME, '.gemini', 'antigravity-cli', 'bin', 'agy'),
      '/usr/local/bin/agy',
      '/opt/homebrew/bin/agy',
      path.join(HOME, '.gemini', 'antigravity-ide', 'bin', 'agentapi'),
      '/Applications/Antigravity IDE.app/Contents/MacOS/Antigravity IDE',
    ],
  },
  {
    id: 'codex', name: 'Codex', vendor: 'OpenAI', commands: ['codex'],
    url: 'https://developers.openai.com/codex/cli',
    paths: () => isWin ? [path.join(APPDATA, 'npm', 'codex.cmd')] : ['/usr/local/bin/codex', '/opt/homebrew/bin/codex'],
  },
  {
    id: 'claude', name: 'Claude', vendor: 'Anthropic', commands: ['claude'],
    url: 'https://claude.com/claude-code',
    paths: () => isWin ? [
      path.join(HOME, '.local', 'bin', 'claude.exe'),
      path.join(APPDATA, 'npm', 'claude.cmd'),
    ] : [path.join(HOME, '.local', 'bin', 'claude'), path.join(HOME, '.claude', 'local', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude'],
  },
];
// Claude Code takes these aliases for --model; "default" leaves the choice to its own settings.
const CLAUDE_MODELS = ['default', 'opus', 'sonnet', 'haiku'];
const agentBins = new Map(); // agent id -> executable found by the last scan
// Folders of the agents found off PATH, so the Terminal panel can run them by name.
const agentDirs = () => [...new Set([...agentBins.values()].filter(b => !b.endsWith('.app')).map(b => path.dirname(b)))];

// Asked once and shared: `agy models` can take seconds, and a second scan shouldn't start another.
let cachedAntigravityModels = null;
function antigravityModels(bin) {
  cachedAntigravityModels ??= AntigravityAgentService.getAvailableModelsAsync(bin)
    .catch(() => [...AntigravityAgentService.DEFAULT_MODELS]);
  return cachedAntigravityModels;
}

// `pathValue` searches the PATH as it is now (getTools reads it fresh), so a tool installed since Breeze started is found.
function which(cmd, pathValue) {
  return new Promise(res => {
    const env = pathValue ? toolEnv(process.env, [], process.platform, pathValue) : process.env;
    execFile(isWin ? 'where' : 'which', [cmd], { windowsHide: true, timeout: 4000, env }, (err, stdout) => {
      if (err) { res(null); return; }
      const hits = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      // On Windows prefer the runnable shim (.cmd/.exe) over the extension-less sh script npm also writes.
      res((isWin && hits.find(h => /\.(?:cmd|exe|bat)$/i.test(h))) || hits[0] || null);
    });
  });
}

// "git version 2.45.1.windows.1" → "2.45.1"
function versionIn(text) {
  const token = text.split(/[^\d.]+/).find(t => /^\d+\.\d+/.test(t));
  return token ? token.split('.').slice(0, 3).filter(Boolean).join('.') : null;
}
function versionOf(bin) {
  // Launching a GUI app's .exe would open its window, so only ask CLIs for a version.
  if (bin.endsWith('.app') || (isWin && /\.exe$/i.test(bin) && !/(?:codex|claude|git|node)\.exe$/i.test(bin))) return Promise.resolve(null);
  return new Promise(res => {
    exec(`"${bin}" --version`, { windowsHide: true, timeout: 8000 }, (err, stdout) => res(err ? null : versionIn(stdout)));
  });
}

// The one terminal command that installs a missing agent, or null where there is none (Antigravity ships as an app).
function agentInstallCmd(id, platform) {
  if (id === 'claude') return 'npm install -g @anthropic-ai/claude-code';
  if (id === 'codex') return 'npm install -g @openai/codex';
  if (id !== 'local') return null;
  if (platform === 'win32') return 'winget install Ollama.Ollama';
  if (platform === 'darwin') return 'brew install ollama';
  return null;
}

async function locate(commands, paths) {
  const found = await Promise.all(commands.map(which));
  return found.find(Boolean) || paths.find(p => p && fs.existsSync(p)) || null;
}

async function detectAgent(a) {
  const bin = await locate(a.commands, a.paths());
  if (bin) agentBins.set(a.id, bin);
  else agentBins.delete(a.id);

  let models = [];
  let version = null;

  if (a.id === 'codex') {
    const cm = codexModels();
    models = cm.length ? cm : ['gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini', 'o3-mini', 'chatgpt-4o-latest'];
    version = loadState().codexModel || 'gpt-4o';
  } else if (a.id === 'antigravity') {
    models = bin ? await antigravityModels(bin) : [...AntigravityAgentService.DEFAULT_MODELS];
    version = loadState().antigravityModel || models[0] || 'claude-sonnet-4-6';
  } else if (a.id === 'claude') {
    models = CLAUDE_MODELS;
    version = loadState().claudeModel || 'default';
  } else if (bin) {
    version = await versionOf(bin);
  }

  return { id: a.id, name: a.name, vendor: a.vendor, url: a.url, found: !!bin, path: bin, version, models, install: bin ? null : agentInstallCmd(a.id, process.platform) };
}

// `force` (the Rescan buttons) looks for the compilers again; otherwise the lookup made at startup is reused.
handle('sys:detect', async (_e, force) => {
  const agents = await Promise.all(AGENTS.map(detectAgent));
  // A local LLM server (Ollama, LM Studio…) speaks the OpenAI API instead of being a CLI.
  let llm = await llmConfig(true).catch(() => null);
  // A saved server may have been closed since: it only counts as found while it answers and still has the model.
  if (llm) llm = await llmReachable(llm).then(() => llm, () => null);
  agents.push({ id: 'local', name: 'Ollama', vendor: 'Ollama, LM Studio or any OpenAI-compatible server', url: 'https://ollama.com/download', api: true, found: !!llm, path: llm?.url ?? null, version: llm?.model ?? null, models: llm?.models ?? [], install: llm ? null : agentInstallCmd('local', process.platform) });
  const { tools: found, pathValue } = await getTools(!!force);
  const tools = await Promise.all([['git', 'Git'], ['node', 'Node.js']].map(async ([cmd, name]) => {
    const bin = await which(cmd, pathValue);
    return { id: cmd, name, found: !!bin, version: bin ? await versionOf(bin) : null, hint: bin ? null : installHint(cmd, process.platform), cmd: bin ? null : installCmd(cmd, process.platform), url: bin ? null : installUrl(cmd, process.platform) };
  }));
  for (const [id, name, t, kind] of [['cc', 'C/C++', found.cc, 'c'], ['python', 'Python', found.python, 'py'], ['dotnet', 'C#', found.dotnet, 'cs'], ['java', 'Java', found.java, 'java'], ['rust', 'Rust', found.rustc, 'rs']]) {
    tools.push({ id, name, found: !!t, version: t ? versionIn(t.version) : null, optional: true, hint: t ? null : installHint(kind, process.platform), cmd: t ? null : installCmd(kind, process.platform), url: t ? null : installUrl(kind, process.platform) });
  }
  return { agents, tools, platform: process.platform };
});

/* ================= Window & shell IPC ================= */
handle('sys:openExternal', (_e, url) => openInBrowser(url));
// Opens a terminal running one of the tools list's install commands; anything else is refused.
handle('sys:runCommand', async (_e, cmd) => {
  if (typeof cmd !== 'string') return false;
  const command = cmd.trim();
  const allowed = [
    ...['git', 'node', 'c', 'py', 'cs', 'java', 'rs'].map(kind => installCmd(kind, process.platform)),
    ...['claude', 'codex', 'local'].map(id => agentInstallCmd(id, process.platform)),
  ].filter(Boolean);
  if (!allowed.includes(command)) return false;
  const escaped = command.replaceAll(/[\\"]/g, String.raw`\$&`);
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec || path.join(process.env.SystemRoot || String.raw`C:\Windows`, 'System32', 'cmd.exe');
    spawn(comspec, ['/c', 'start', 'cmd.exe', '/k', command], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('/usr/bin/osascript', ['-e', `tell application "Terminal" to do script "${escaped}"`], { detached: true, stdio: 'ignore' }).unref();
  } else {
    // Debian's terminal alternative, by its full path rather than whatever PATH would find first.
    spawn('/usr/bin/x-terminal-emulator', ['-e', command], { detached: true, stdio: 'ignore' }).unref();
  }
  return true;
});
// Full access: build mode runs with no guard. Agents may reach files outside the project, .env files and .git,
// Claude skips every permission check and Codex leaves its sandbox. Off unless the user turns it on.
const fullAccess = () => loadState().agentFullAccess === true;
handle('agent:fullAccess', () => fullAccess());
handle('agent:setFullAccess', (_e, on) => { saveState({ agentFullAccess: on === true }); return on === true; });
handle('agent:setModel', async (_e, { agent, model, effort }) => {
  if (agent === 'codex') {
    const nextState = { codexModel: model || null };
    if (effort !== undefined) nextState.codexEffort = effort || null;
    saveState(nextState);
    return true;
  }
  if (agent === 'antigravity') {
    const nextState = { antigravityModel: model || null };
    if (effort !== undefined) nextState.antigravityEffort = effort || null;
    saveState(nextState);
    return true;
  }
  if (agent === 'claude') {
    const nextState = { claudeModel: CLAUDE_MODELS.includes(model) ? model : null };
    if (effort !== undefined) nextState.claudeEffort = effort || null;
    saveState(nextState);
    return true;
  }
  return false;
});
handle('live:status', async () => ({ available: await hasLiveIndex(), running: !!liveServer, url: await liveIndexUrl() }));
handle('live:start', () => startLiveServer());
handle('live:stop', async () => {
  stopLiveServer();
  return { available: await hasLiveIndex(), running: false, url: await liveIndexUrl() };
});
handle('win:reload', () => win?.webContents.reload());
handle('win:devtools', () => win?.webContents.toggleDevTools());
handle('win:quit', () => app.quit());
// The window's own background and the title bar's min/max/close buttons follow Settings → Appearance.
const THEME_CHROME = {
  dark: { bg: '#1d1d1f', bar: '#232325', symbols: '#aaaaaa' },
  contrast: { bg: '#000000', bar: '#0b0b0d', symbols: '#a1a1aa' },
  light: { bg: '#ffffff', bar: '#f5f5f7', symbols: '#5f5f64' },
};
handle('win:theme', (_e, theme) => {
  const c = THEME_CHROME[theme];
  if (!c || !win) return;
  win.setBackgroundColor(c.bg);
  win.setTitleBarOverlay({ color: c.bar, symbolColor: c.symbols, height: 38 });
});
handle('win:edit', (_e, role) => {
  const wc = win?.webContents;
  if (wc && ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'].includes(role)) wc[role]();
});

/* ================= Secrets (encrypted with the OS keychain) ================= */
const secretsPath = () => path.join(app.getPath('userData'), 'breeze-secrets.json');
function readSecrets() {
  try { return JSON.parse(fs.readFileSync(secretsPath(), 'utf8')); } catch { return {}; }
}
function getSecret(name) {
  const enc = readSecrets()[name];
  if (!enc || !safeStorage.isEncryptionAvailable()) return null;
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { return null; }
}
function setSecret(name, value) {
  const all = readSecrets();
  if (value == null) delete all[name];
  else {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is not available on this computer');
    all[name] = safeStorage.encryptString(value).toString('base64');
  }
  fs.writeFileSync(secretsPath(), JSON.stringify(all));
}

/* ================= Local LLM API (Ollama, LM Studio or any OpenAI-compatible server) ================= */
// The usual addresses of Ollama and LM Studio, tried when nothing is configured yet.
const LLM_DEFAULTS = ['http://127.0.0.1:11434/v1', 'http://127.0.0.1:1234/v1'];
// The server address without trailing slashes.
function llmBase(url) {
  const s = String(url || '').trim();
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') end--;
  return s.slice(0, end);
}
const llmHeaders = key => (key ? { Authorization: `Bearer ${key}` } : {});

async function llmModels(url, key, timeout = 5000) {
  const r = await fetch(`${llmBase(url)}/models`, { headers: llmHeaders(key), signal: AbortSignal.timeout(timeout) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `The server answered with status ${r.status}`);
  const ids = (j.data || j.models || []).map(m => m.id || m.name).filter(Boolean);
  if (!ids.length) throw new Error('The server has no models yet. Download one first, for example: ollama pull llama3.1');
  return ids;
}
// The saved server; with `probe`, otherwise the first usual address that answers (it is then saved).
async function llmConfig(probe) {
  const s = loadState();
  if (s.llmUrl) return { url: s.llmUrl, model: s.llmModel, models: s.llmModels || [], key: getSecret('llmKey') };
  if (!probe || s.llmOff) return null;
  const answers = await Promise.all(LLM_DEFAULTS.map(u => llmModels(u, null, 700).then(models => ({ url: u, models }), () => null)));
  const hit = answers.find(Boolean);
  if (!hit) return null;
  saveState({ llmUrl: hit.url, llmModel: hit.models[0], llmModels: hit.models });
  return { url: hit.url, model: hit.models[0], models: hit.models, key: null };
}

// Checks that the saved server still answers and still has the chosen model (the user may have closed or unloaded it).
async function llmReachable(cfg) {
  let models;
  try { models = await llmModels(cfg.url, cfg.key, 2500); }
  catch { throw new Error('The local LLM server is not running. Start Ollama or LM Studio again, or choose another agent.'); }
  if (cfg.model && !models.includes(cfg.model)) throw new Error(`${cfg.model} is no longer loaded on the local LLM server. Load it again or pick another model.`);
  return models;
}

// With no address, the usual local addresses are tried with the key.
async function llmFind(key) {
  const errors = [];
  for (const u of LLM_DEFAULTS) {
    try { return { url: u, models: await llmModels(u, key, 1500) }; } catch (err) { errors.push(err); }
  }
  const answered = errors.find(e => !/fetch failed|timeout|aborted|ECONNREFUSED/i.test(e.message));
  throw answered || new Error('No local LLM server is running. Start Ollama or LM Studio, then connect again.');
}
handle('llm:connect', async (_e, url, key) => {
  url = llmBase(url);
  key = String(key || '').trim();
  if (!url) ({ url } = await llmFind(key));
  if (!/^https?:\/\/[^\s/]+/i.test(url)) throw new Error('Enter the server address, for example http://localhost:11434/v1');
  const models = await llmModels(url, key);
  setSecret('llmKey', key || null);
  saveState({ llmUrl: url, llmModel: models[0], llmModels: models, llmOff: false });
  return { url, model: models[0], models };
});
handle('llm:setModel', (_e, model) => {
  if (!(loadState().llmModels || []).includes(model)) throw new Error('That model is not on the server');
  saveState({ llmModel: model });
});
// Forget the server, and stop looking for one until the user connects again.
handle('llm:disconnect', () => {
  setSecret('llmKey', null);
  saveState({ llmUrl: null, llmModel: null, llmModels: null, llmOff: true });
});

/* ================= Agents ================= */
// Every run streams normalized events to the renderer:
// session · text · plan · tool · file · note · error · done
const runs = new Map();
let nextRun = 1;
const sendEvent = (runId, ev) => win?.webContents.send('agent:event', runId, ev);
// A team run's events go through its coordinator first, which hides the claim pass and enforces ownership.
// A dropped team keeps the runs still going until their done, so a team stopped by a folder change hears them end.
const teamOf = new Map(); // runId -> { team: TeamCoordinator, done }
function emit(runId, ev) {
  if (ev?.t === 'done' && ev.tokens) addUsage(runs.get(runId)?.agent, ev.tokens);
  const entry = teamOf.get(runId);
  if (entry) {
    if (ev?.t === 'done') {
      entry.done = true;
      if (teams.get(entry.team.id) !== entry.team) teamOf.delete(runId);
    }
    if (entry.team.observe(runId, ev)) return;
  }
  sendEvent(runId, ev);
}
const relOut = p => {
  if (!p || !root) return p || '';
  const r = path.relative(root, path.resolve(root, p));
  return r.startsWith('..') ? p : r.split(path.sep).join('/');
};
const SAFE_ID = /^[\w-]{6,80}$/;

// `opts.team` ({ coordinator, agentId }) only ever comes from a TeamCoordinator, never from the renderer.
function launchRun(opts) {
  const runId = nextRun++;
  if (opts?.team) teamOf.set(runId, { team: opts.team.coordinator, done: false });
  startRun(runId, opts).catch(err => {
    emit(runId, { t: 'error', text: err.message });
    emit(runId, { t: 'done', ok: false });
    runs.delete(runId);
  });
  return runId;
}
// A stopped run that is still going always ends with a done (teams wait for it).
function stopRun(runId) {
  const r = runs.get(runId);
  if (!r) return;
  r.stopped = true;
  if (r.service) r.service.stop().then(r.onStopped, r.onStopped); // the service drops its exit event once stopped
  if (r.child) killTree(r.child);
  r.abort?.abort();
}
handle('agent:run', (_e, opts) => launchRun({ ...opts, team: null }));

/* ----- Agent usage: tokens each agent used this month, and how much of its plan is left ----- */
// Tokens come from Claude's and Codex's own logs (below) and, for other agents, from each finished run in Breeze.
// Plan limits are only what the agents report themselves: Claude in its
// stream (rate_limit_event), Codex in its session logs. Antigravity reports neither, a local model has no limit.
const usageMonth = () => new Date().toISOString().slice(0, 7);
function addUsage(agent, tokens) {
  if (!agent) return;
  const all = loadState().usage || {};
  const cur = all[agent]?.month === usageMonth() ? all[agent] : { month: usageMonth(), tokens: 0 };
  saveState({ usage: { ...all, [agent]: { month: cur.month, tokens: cur.tokens + tokens } } });
}
const windowLabel = min => ({ 300: '5-hour', 10080: 'Weekly', 43200: 'Monthly' })[min] || `${Math.round(min / 60)}-hour`;
// A window whose reset time has passed is empty again until the agent next reports.
const limitWindow = (label, usedPct, resetsAt) =>
  resetsAt && resetsAt * 1000 < Date.now() ? { label, used: 0, resetsAt: null } : { label, used: Math.min(100, Math.max(0, usedPct)), resetsAt: resetsAt || null };
const CLAUDE_WINDOWS = { five_hour: '5-hour', seven_day: 'Weekly', seven_day_opus: 'Weekly (Opus)', seven_day_sonnet: 'Weekly (Sonnet)' };
// The last Breeze run's numbers (rate_limit_event: utilization 0–1, resetsAt in seconds). Only a fallback: they go stale
// as soon as Claude is used anywhere else.
function claudeLimits() {
  const w = loadState().claudeLimits || {};
  return Object.entries(w).filter(([, v]) => typeof v?.utilization === 'number')
    .map(([k, v]) => limitWindow(CLAUDE_WINDOWS[k] || k.replace(/_/g, ' '), v.utilization * 100, v.resetsAt));
}
// Live numbers, the same ones Claude's own usage page shows (utilization in percent, resets_at as a date), asked for
// with the sign-in Claude Code saved on this computer. The token is only ever sent to Anthropic; Breeze keeps nothing.
// At most once a minute; null when it can't (signed out, an expired token Claude Code hasn't refreshed yet, offline).
let claudeLive = { at: 0, windows: null };
async function claudeLiveLimits() {
  if (Date.now() - claudeLive.at < 60_000) return claudeLive.windows;
  claudeLive.at = Date.now();
  try {
    const file = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
    const token = JSON.parse(await fs.promises.readFile(file, 'utf8')).claudeAiOauth?.accessToken;
    if (!token) return (claudeLive.windows = null);
    const res = await net.fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return (claudeLive.windows = null);
    const d = await res.json();
    const windows = Object.entries(CLAUDE_WINDOWS).filter(([k]) => typeof d?.[k]?.utilization === 'number')
      .map(([k, label]) => limitWindow(label, d[k].utilization, d[k].resets_at ? Date.parse(d[k].resets_at) / 1000 : null));
    return (claudeLive.windows = windows.length ? windows : null);
  } catch { return (claudeLive.windows = null); }
}
// The newest Codex session log (sessions/YYYY/MM/DD/rollout-*.jsonl) holds the latest rate_limits it was sent.
function codexLimits() {
  try {
    let dir = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
    for (let depth = 0; depth < 3; depth++) {
      const sub = fs.readdirSync(dir).filter(n => /^\d+$/.test(n)).sort().pop();
      if (!sub) return [];
      dir = path.join(dir, sub);
    }
    const file = fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')).map(n => path.join(dir, n))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    const line = file && fs.readFileSync(file, 'utf8').split('\n').reverse().find(l => l.includes('"rate_limits"'));
    const r = line && JSON.parse(line).payload?.rate_limits;
    return [r?.primary, r?.secondary].filter(w => typeof w?.used_percent === 'number')
      .map(w => limitWindow(windowLabel(w.window_minutes), w.used_percent, w.resets_at));
  } catch { return []; }
}
// Claude Code and Codex log every session on disk, whether it ran in Breeze or not, so their monthly tokens come from
// those logs: input (cached or not) plus output, the same total Codex reports. Each log is re-read only when it changes.
const logCache = new Map(); // file -> { key, data }
async function recentLogs(dir, depth, since) {
  const out = [];
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) out.push(...await recentLogs(p, depth - 1, since));
    else if (e.isFile() && e.name.endsWith('.jsonl') && (await fs.promises.stat(p).catch(() => null))?.mtimeMs >= since) out.push(p);
  }
  return out;
}
async function readLog(file, parse) {
  const st = await fs.promises.stat(file).catch(() => null);
  if (!st) return null;
  const key = `${st.mtimeMs}:${st.size}:${usageMonth()}`;
  if (logCache.get(file)?.key === key) return logCache.get(file).data;
  const data = parse((await fs.promises.readFile(file, 'utf8')).split('\n'), usageMonth());
  logCache.set(file, { key, data });
  return data;
}
const monthStart = () => Date.parse(`${usageMonth()}-01T00:00:00Z`);
// Claude repeats a message's usage on each of its lines and a resumed chat copies earlier ones, so each message id counts once.
async function claudeTokens() {
  const base = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  const byMsg = new Map();
  for (const file of await recentLogs(base, 3, monthStart())) {
    const msgs = await readLog(file, (lines, month) => {
      const m = new Map();
      for (const line of lines) {
        if (!line.includes('"usage"')) continue;
        try {
          const d = JSON.parse(line), u = d.message?.usage;
          if (!u || !d.message.id || d.timestamp?.slice(0, 7) !== month) continue;
          m.set(d.message.id, (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0));
        } catch { /* a line still being written */ }
      }
      return m;
    });
    for (const [id, n] of msgs ?? []) byMsg.set(id, n);
  }
  return [...byMsg.values()].reduce((a, b) => a + b, 0);
}
// A Codex session keeps a running total; this month's share is its last total less the last one from before the month.
async function codexTokens() {
  const base = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  let sum = 0;
  for (const file of await recentLogs(base, 4, monthStart())) {
    sum += await readLog(file, (lines, month) => {
      let before = 0, last = 0;
      for (const line of lines) {
        if (!line.includes('"token_count"')) continue;
        try {
          const d = JSON.parse(line), t = d.payload?.info?.total_token_usage?.total_tokens;
          if (typeof t !== 'number') continue;
          if (d.timestamp?.slice(0, 7) < month) before = t; else last = t;
        } catch { /* a line still being written */ }
      }
      return Math.max(0, last - before);
    }) ?? 0;
  }
  return sum;
}
let usageJob = null;
async function agentUsage() {
  const month = usageMonth();
  const usage = Object.fromEntries(Object.entries(loadState().usage || {}).map(([id, u]) => [id, u.month === month ? u.tokens : 0]));
  // The logs include Breeze's own runs; Breeze's count stays as a floor in case an agent logs somewhere else.
  usage.claude = Math.max(usage.claude || 0, await claudeTokens());
  usage.codex = Math.max(usage.codex || 0, await codexTokens());
  return { usage, limits: { claude: (await claudeLiveLimits()) ?? claudeLimits(), codex: codexLimits() } };
}
handle('agent:usage', () => (usageJob ??= agentUsage().finally(() => { usageJob = null; })));
handle('agent:stop', (_e, runId) => stopRun(runId));

/* ----- Agent teams: one prompt split between several agents, each owning its own files ----- */
const teams = new Map(); // teamId -> TeamCoordinator
const teamTimers = new Map(); // teamId -> the timer that drops it
const TEAM_TTL_MS = 30 * 60 * 1000;
const CLAIM_MS = 60 * 1000;
const MAX_TASK = 20000;
const TEAM_FINISHED = 'That team has finished.';
const teamDeps = { startRun: launchRun, stopRun, emit: sendEvent, setTimeout, clearTimeout };

// The agents a prompt can mention: the CLI agents the last scan found, and the local LLM once one is set up.
async function teamAgents() {
  const llm = await llmConfig(false).catch(() => null);
  return [
    ...AGENTS.map(a => ({ id: a.id, name: a.name, found: agentBins.has(a.id) })),
    { id: 'local', name: 'Ollama', found: !!llm?.model },
  ];
}
function dropTeam(id) {
  const t = teams.get(id);
  if (!t) return;
  clearTimeout(teamTimers.get(id));
  teamTimers.delete(id);
  teams.delete(id);
  t.stop();
  for (const [runId, entry] of teamOf) if (entry.team === t && entry.done) teamOf.delete(runId);
}
// A team and its snapshot go after 30 minutes, but not while one of its runs is still going.
function expireTeam(id) {
  const t = teams.get(id);
  if ([...teamOf.values()].some(e => e.team === t && !e.done)) teamTimers.set(id, setTimeout(() => expireTeam(id), TEAM_TTL_MS));
  else dropTeam(id);
}
function stopTeams() {
  for (const id of [...teams.keys()]) dropTeam(id);
}
const isPlainObject = o => Object.prototype.toString.call(o) === '[object Object]';

handle('team:parse', async (_e, text) => parseMentions(String(text ?? ''), await teamAgents()));
handle('team:claim', async (_e, o) => {
  const agents = await teamAgents();
  if (!root) throw new Error('Open a folder first');
  const list = o?.members;
  if (!Array.isArray(list) || list.length < 2 || list.length > 4) throw new Error('A team needs 2 to 4 agents.');
  if (o.shared != null && typeof o.shared !== 'string') throw new Error('The shared part of the prompt must be text.');
  const members = [];
  for (const m of list) {
    const agent = agents.find(a => a.id === m?.agentId);
    if (!agent?.found) throw new Error('That agent was not found on this computer.');
    if (members.some(x => x.agentId === agent.id)) throw new Error('Each agent can only be on a team once.');
    if (typeof m.task !== 'string') throw new Error('Every agent on a team needs a task.');
    const session = typeof m.session === 'string' && SAFE_ID.test(m.session) ? m.session : null;
    members.push({ agentId: agent.id, name: shortName(agent), task: m.task.slice(0, MAX_TASK), session });
  }
  const id = crypto.randomUUID();
  const team = new TeamCoordinator({ id, root, shared: (o.shared ?? '').slice(0, MAX_TASK), members, deps: teamDeps });
  teams.set(id, team);
  teamTimers.set(id, setTimeout(() => expireTeam(id), TEAM_TTL_MS));
  return { teamId: id, ...await team.claim({ timeoutMs: CLAIM_MS }) };
});
handle('team:start', (_e, o) => {
  const team = teams.get(o?.teamId);
  if (!team) throw new Error(TEAM_FINISHED);
  const owners = o.owners ?? {};
  const exclude = o.exclude ?? [];
  const member = a => team.members.some(m => m.agentId === a);
  if (!isPlainObject(owners) || !Object.values(owners).every(member)) throw new Error('Each file must belong to an agent on this team.');
  if (!Array.isArray(exclude) || !exclude.every(member)) throw new Error('Only an agent on this team can be left out.');
  if (team.members.every(m => exclude.includes(m.agentId))) throw new Error('A team needs at least one agent.');
  return team.start(owners, { exclude });
});
handle('team:stop', (_e, teamId) => dropTeam(teamId));
handle('team:undo', (_e, o) => {
  const team = teams.get(o?.teamId);
  if (!team) throw new Error(TEAM_FINISHED);
  return team.undo(o.path);
});

async function runAntigravity(runId, run, { mode, prompt, session, base }) {
  const bin = agentBins.get('antigravity');
  const st = loadState();
  const model = st.antigravityModel || 'claude-sonnet-4-6';
  const effort = st.antigravityEffort || 'high';

  const service = new AntigravityAgentService({
    executablePath: bin || undefined,
    cwd: base,
    mode,
    model,
    effort,
    sessionId: session,
    prompt,
    autoOpenAuth: false,
  });

  run.service = service;
  let lastText = '';
  let doneEmitted = false;
  // A stopped run ends here once: from 'exit', or from stopRun when the stopped service never sends 'exit'.
  let stopEnded = false;
  run.onStopped = () => {
    if (stopEnded || doneEmitted) return;
    stopEnded = true;
    runs.delete(runId);
    emit(runId, { t: 'done', ok: false, stopped: true });
  };

  service.on('output', ev => {
    if (run.stopped) return;
    if (ev.type === 'auth-required') {
      emit(runId, { t: 'auth', text: ev.text, url: ev.raw?.url, command: ev.raw?.command });
      service.triggerExternalAuth().catch(logError('auth'));
      return;
    }
    if (ev.type === 'text' && ev.text) {
      lastText = ev.text;
    }
    if (ev.type === 'plan' && ev.text) {
      lastText = ev.text;
    }
    if (ev.type === 'done') {
      doneEmitted = true;
      if (mode === 'plan' && lastText) {
        emit(runId, { t: 'plan', text: lastText });
      }
    }
    emit(runId, {
      t: ev.type,
      text: ev.text,
      kind: ev.kind,
      label: ev.label,
      path: ev.path ? relOut(ev.path) : undefined,
      ok: ev.ok,
    });
  });

  service.on('auth-required', auth => {
    if (run.stopped) return;
    emit(runId, { t: 'auth', text: auth.rawText, url: auth.url, command: auth.command });
    service.triggerExternalAuth(auth.url).catch(logError('auth'));
  });

  service.on('error', err => {
    if (run.stopped) return;
    emit(runId, { t: 'error', text: err.message });
  });

  service.on('exit', (code, signal) => {
    runs.delete(runId);
    if (run.stopped) {
      run.onStopped();
    } else if (!doneEmitted) {
      if (mode === 'plan' && lastText) {
        emit(runId, { t: 'plan', text: lastText });
      }
      emit(runId, { t: 'done', ok: code === 0 });
    }
  });

  try {
    await service.start();
    run.child = service.getChildProcess();
  } catch (err) {
    if (!run.stopped) {
      emit(runId, { t: 'error', text: err.message });
      emit(runId, { t: 'done', ok: false });
    }
    runs.delete(runId);
  }
}
// The CLI name for a Breeze effort level: Codex and Claude Code call the top level "xhigh", Breeze shows "Extra".
const EFFORT_ARGS = { low: 'low', medium: 'medium', high: 'high', extra: 'xhigh' };
const effortArg = effort => EFFORT_ARGS[String(effort || '').toLowerCase()] || null;
// Command-line flags for a CLI agent, and the prompt it reads from stdin.
function cliArgs(agent, mode, prompt, session, team, shell) {
  if (agent === 'claude') return claudeArgs(mode, prompt, session, team, shell);
  const build = mode === 'build';
  const sandbox = !build ? 'read-only' : fullAccess() ? 'danger-full-access' : 'workspace-write';
  const args = ['exec', '--json', '-s', sandbox, '--skip-git-repo-check'];
  const st = loadState();
  const model = st.codexModel;
  if (model && SAFE_MODEL.test(model)) args.push('-m', model);
  const effort = effortArg(st.codexEffort);
  // Unquoted: Codex reads a -c value that is not valid TOML as a plain string, and quotes can't pass the npm shim's shell.
  if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
  if (session) args.push('resume', session);
  args.push('-');
  if (build) return { args, prompt };
  const ask = mode === 'plan' ? 'Make a short numbered plan for this request. Do not change any files yet.' : 'Answer without changing any files.';
  return { args, prompt: `${ask}\n\n${prompt}` };
}
// Claude Code in print mode: one JSON event per line. Build mode may edit files and run commands without asking
// (with full access, every permission check is off); ask and plan modes can read and search but every tool that
// changes files is switched off.
const NO_SESSION = /No conversation found with session ID/i;
const CLAUDE_WRITE_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash'];
// On a team, build mode also denies editing what a teammate owns (rule paths are relative to the project root).
// Those rules can't pass through a shell (`shell`: an npm .cmd shim), so they come back as `deny` for a settings file.
function claudeArgs(mode, prompt, session, team, shell) {
  const build = mode === 'build';
  const full = build && fullAccess();
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', full ? 'bypassPermissions' : build ? 'acceptEdits' : 'default'];
  if (!build) args.push('--disallowedTools', ...CLAUDE_WRITE_TOOLS);
  else if (!full) args.push('--allowedTools', 'Bash'); // print mode can't ask, so commands would otherwise be refused
  const deny = build && team ? claudeDenyArgs(team.coordinator.owners, team.agentId) : [];
  if (deny.length && !shell) args.push('--disallowedTools', ...deny);
  const st = loadState();
  const model = st.claudeModel;
  if (model && model !== 'default' && CLAUDE_MODELS.includes(model)) args.push('--model', model);
  const effort = effortArg(st.claudeEffort);
  if (effort) args.push('--effort', effort);
  if (session) args.push('--resume', session);
  if (build) return deny.length && shell ? { args, prompt, deny } : { args, prompt };
  const ask = mode === 'plan' ? 'Make a short numbered plan for this request. Do not change any files yet.' : 'Answer without changing any files.';
  return { args, prompt: `${ask}\n\n${prompt}` };
}
// A Claude Code settings file holding a team member's deny rules, for `--settings`. Null when its path can't
// pass through the shell (a user name with a space, say) or it can't be written.
function teamSettingsFile(runId, deny) {
  const file = path.join(os.tmpdir(), `breeze-team-${runId}-${crypto.randomBytes(6).toString('hex')}.json`).replaceAll('\\', '/');
  try { shellCommand('', [file]); } catch { return null; }
  try { fs.writeFileSync(file, JSON.stringify({ permissions: { deny } }), { flag: 'wx', mode: 0o600 }); } catch { return null; }
  return file;
}
function dropSettingsFile(run) {
  if (run.settingsFile) fs.rm(run.settingsFile, { force: true }, () => { /* best effort */ });
  run.settingsFile = null;
}
const NO_BLOCK_NOTE = 'Claude can\'t be blocked from teammates\' files on this computer, so Breeze will undo any edit it makes to them instead.';
// What each Claude Code tool call looks like in the chat.
const CLAUDE_TOOLS = {
  Read: i => ['read', `Read ${relOut(i.file_path)}`],
  Edit: i => ['edit', `Edited ${relOut(i.file_path)}`, i.file_path],
  MultiEdit: i => ['edit', `Edited ${relOut(i.file_path)}`, i.file_path],
  Write: i => ['edit', `Wrote ${relOut(i.file_path)}`, i.file_path],
  NotebookEdit: i => ['edit', `Edited ${relOut(i.notebook_path)}`, i.notebook_path],
  Bash: i => ['run', `$ ${i.command}`],
  Grep: i => ['search', `Searched for ${i.pattern}`],
  Glob: i => ['search', `Listed ${i.pattern}`],
  WebSearch: i => ['web', `Searched the web for ${i.query}`],
  WebFetch: i => ['web', `Read ${i.url}`],
  TodoWrite: () => ['todo', 'Updated its to-do list'],
};
// One piece of an assistant message: text for the chat, or a tool call shown as a line (and the file it touched).
function claudeContent(runId, c, ctx) {
  if (c.type === 'text' && c.text?.trim()) {
    ctx.lastText = c.text;
    emit(runId, { t: 'text', text: c.text });
    return;
  }
  if (c.type !== 'tool_use') return;
  const [kind, label, file] = CLAUDE_TOOLS[c.name]?.(c.input || {}) ?? ['tool', c.name];
  emit(runId, { t: 'tool', kind, label });
  if (file) emit(runId, { t: 'file', path: relOut(file) });
}
function claudeResult(runId, d, ctx, mode) {
  if (d.is_error || d.subtype !== 'success') {
    // Reported when the process exits (streamCli): the reason may only be on stderr, and a stale
    // session gets one retry as a fresh chat there.
    ctx.lastError = d.result || (d.errors || []).join('\n') || '';
    return;
  }
  ctx.done = true;
  const text = d.result || ctx.lastText;
  if (mode === 'plan' && text) emit(runId, { t: 'plan', text });
  emit(runId, { t: 'done', ok: true, tokens: (d.usage?.input_tokens || 0) + (d.usage?.output_tokens || 0) });
}
function claudeEvent(runId, d, ctx, mode) {
  if (d.type === 'system' && d.subtype === 'init' && d.session_id) emit(runId, { t: 'session', id: d.session_id });
  else if (d.type === 'assistant') for (const c of d.message?.content || []) claudeContent(runId, c, ctx);
  else if (d.type === 'result') claudeResult(runId, d, ctx, mode);
  else if (d.type === 'rate_limit_event' && d.rate_limit_info?.unifiedWindows) saveState({ claudeLimits: d.rate_limit_info.unifiedWindows });
}

// Codex's config may name a model the signed-in account can't use (e.g. a ChatGPT plan without API models).
// Breeze then retries once with the best model from Codex's own model list and keeps using it.
const SAFE_MODEL = /^[\w.:-]{1,64}$/;
const MODEL_REFUSED = /model[^\n]{0,80}(?:is not supported|does not exist|not found|unsupported|not available)/i;
function codexModels() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(HOME, '.codex', 'models_cache.json'), 'utf8'));
    return (j.models || []).filter(m => m.visibility !== 'hide' && SAFE_MODEL.test(m.slug || ''))
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99)).map(m => m.slug);
  } catch { return []; }
}
function codexFallback(errText) {
  const refused = /'([\w.:-]+)' model|model '([\w.:-]+)'|model `([\w.:-]+)`/i.exec(errText);
  const bad = refused?.slice(1).find(Boolean);
  return codexModels().find(m => m !== bad && m !== loadState().codexModel) || null;
}

// Agents work in the open project; Breeze Box chats may also run without one, in the Breeze Box folder.
async function startRun(runId, { agent, mode, prompt, session, box, team }) {
  const base = root || (box ? boxDir() : null);
  if (!base) throw new Error('Open a folder first');
  if (session && !SAFE_ID.test(session)) session = null;
  const run = { agent, child: null, abort: null, stopped: false, team: team || null };
  runs.set(runId, run);
  if (agent === 'local') return runLocal(runId, run, { mode, prompt, session, base });
  if (agent === 'antigravity') return runAntigravity(runId, run, { mode, prompt, session, base });
  const bin = agentBins.get(agent);
  if (!bin) throw new Error('That agent was not found on this computer. Rescan from Settings → Run Setup Again.');
  const shell = /\.(?:cmd|bat)$/i.test(bin);
  const launch = () => {
    dropSettingsFile(run);
    const cli = cliArgs(agent, mode, prompt, session, run.team, shell);
    if (cli.deny) {
      run.settingsFile = teamSettingsFile(runId, cli.deny);
      if (run.settingsFile) cli.args.push('--settings', run.settingsFile);
      else if (!run.noBlockNoted) { run.noBlockNoted = true; emit(runId, { t: 'note', text: NO_BLOCK_NOTE }); } // the coordinator still undoes it
    }
    // The prompt goes through stdin, so it never reaches a shell command line. Only fixed flags,
    // a validated model name and a validated session id do (npm .cmd shims need a shell on Windows).
    const opts = { cwd: base, windowsHide: true, env: process.env };
    let child;
    try {
      child = shell ? spawn(shellCommand(bin, cli.args), { ...opts, shell: true }) : spawn(bin, cli.args, opts);
    } catch (err) { dropSettingsFile(run); throw err; }
    run.child = child;
    child.stdin.on('error', () => { /* the agent exited before reading its prompt; its output says why */ });
    child.stdin.end(cli.prompt ?? undefined);
    streamCli(runId, run, child, agent === 'claude' ? claudeEvent : codexEvent, mode, retryModel);
  };
  // A retry starts from the close listener, so a failed launch there ends the run instead of throwing.
  const relaunch = () => {
    runs.set(runId, run);
    try { launch(); } catch (err) {
      runs.delete(runId);
      emit(runId, { t: 'error', text: err.message });
      emit(runId, { t: 'done', ok: false });
    }
    return true;
  };
  // Called once when Codex refuses its configured model, or Claude Code can't find the chat to resume.
  let retried = false;
  const retryModel = errText => {
    if (!retried && agent === 'claude' && session && NO_SESSION.test(errText)) {
      retried = true;
      session = null;
      emit(runId, { t: 'note', text: 'Claude couldn’t find the earlier conversation, so this message starts a new one.' });
      return relaunch();
    }
    const model = !retried && agent === 'codex' ? codexFallback(errText) : null;
    if (!model) return false;
    retried = true;
    saveState({ codexModel: model });
    emit(runId, { t: 'note', text: `Codex can't use the model in its settings with your account, so Breeze switched it to ${model}.` });
    return relaunch();
  };
  launch();
}
// Parses one JSON event per line from the agent's stdout.
function streamCli(runId, run, child, parse, mode, retryModel) {
  const ctx = { done: false, lastError: '', stderr: '', lastText: '', retryModel };
  let buf = '';
  const line = text => {
    if (!text) return;
    try { parse(runId, JSON.parse(text), ctx, mode); } catch { ctx.stderr += text + '\n'; } // not JSON: keep it for the error message
  };
  // Decoded as a stream, so a character split across two chunks stays whole.
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) line(l.trim());
  });
  child.stderr.on('data', chunk => { ctx.stderr = (ctx.stderr + chunk).slice(-4000); });
  child.on('error', err => { ctx.lastError = err.message; });
  child.on('close', code => {
    runs.delete(runId);
    dropSettingsFile(run);
    if (!ctx.done && !ctx.retry && NO_SESSION.test(ctx.lastError + ctx.stderr)) ctx.retry = ctx.lastError + ctx.stderr;
    if (ctx.retry && !run.stopped && ctx.retryModel?.(ctx.retry)) return;
    if (ctx.done) return;
    if (run.stopped) { emit(runId, { t: 'done', ok: false, stopped: true }); return; }
    emit(runId, { t: 'error', text: ctx.lastError || ctx.stderr.trim().split('\n').slice(-6).join('\n') || `The agent exited with code ${code}` });
    emit(runId, { t: 'done', ok: false });
  });
}

function codexError(msg) {
  try { const j = JSON.parse(msg); return j.error?.message || j.message || msg; } catch { return msg; } // plain text already
}
const CHANGE_VERB = { add: 'Created', delete: 'Deleted' };
const CODEX_ITEMS = {
  agent_message: (runId, it, ctx) => { if (it.text) { ctx.lastText = it.text; emit(runId, { t: 'text', text: it.text }); } },
  command_execution: (runId, it) => {
    const exit = it.exit_code ? `  (exit ${it.exit_code})` : '';
    emit(runId, { t: 'tool', kind: 'run', label: `$ ${it.command}${exit}` });
  },
  file_change: (runId, it) => {
    for (const ch of it.changes || []) {
      emit(runId, { t: 'tool', kind: 'edit', label: `${CHANGE_VERB[ch.kind] || 'Edited'} ${relOut(ch.path)}` });
      emit(runId, { t: 'file', path: relOut(ch.path) });
    }
  },
  mcp_tool_call: (runId, it) => emit(runId, { t: 'tool', kind: 'tool', label: `${it.server}: ${it.tool}` }),
  web_search: (runId, it) => emit(runId, { t: 'tool', kind: 'web', label: `Searched the web for ${it.query}` }),
  todo_list: runId => emit(runId, { t: 'tool', kind: 'todo', label: 'Updated its to-do list' }),
  // Codex's warning about a model it has no metadata for is noise to the user.
  error: (runId, it) => { if (it.message && !/^Model metadata for/i.test(it.message)) emit(runId, { t: 'note', text: it.message }); },
};
function codexEvent(runId, d, ctx, mode) {
  if (d.type === 'thread.started') emit(runId, { t: 'session', id: d.thread_id });
  else if (d.type === 'item.completed' && d.item) CODEX_ITEMS[d.item.type]?.(runId, d.item, ctx);
  else if (d.type === 'error') ctx.lastError = codexError(d.message || '');
  else if (d.type === 'turn.failed') {
    const text = codexError(d.error?.message || ctx.lastError || 'The turn failed');
    // A refused model gets one retry with another model once the process exits (see streamCli).
    if (MODEL_REFUSED.test(text) && ctx.retryModel && !ctx.retry) { ctx.retry = text; return; }
    ctx.done = true;
    emit(runId, { t: 'error', text });
    emit(runId, { t: 'done', ok: false });
  } else if (d.type === 'turn.completed') {
    ctx.done = true;
    if (mode === 'plan' && ctx.lastText) emit(runId, { t: 'plan', text: ctx.lastText });
    emit(runId, { t: 'done', ok: true, tokens: (d.usage?.input_tokens || 0) + (d.usage?.output_tokens || 0) });
  }
}

/* ----- Local LLM agent loop (OpenAI-style function calling over the project folder) ----- */
// Keeping token use down: the first message carries a map of the project (so the model doesn't explore it
// call by call), files are read as windows of numbered lines, edits send only the changed snippet, and every
// request is fitted to the model's context by agentbrain.compactHistory. Repeated calls and endless loops stop early.
const brain = require('./agentbrain');
const llmSessions = new Map(); // session id -> chat messages (earlier turns already settled)
const LLM_TOOLS = [
  { name: 'list_files', description: 'List the files and folders under a folder, two levels deep. Folders end with "/".', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Folder relative to the project root; "." for the root' } } } },
  { name: 'read_file', description: `Read numbered lines of a text file (${brain.READ_LINES} lines unless end_line says otherwise). Read only the part you need.`, parameters: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer', description: 'First line to read, from 1' }, end_line: { type: 'integer', description: 'Last line to read' } }, required: ['path'] } },
  { name: 'search_files', description: 'Find lines containing some text (plain text, not a regex) across the project. Use it to find code before reading files.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'edit_file', description: 'Change a file by replacing one exact snippet. old_text must appear exactly once in the file: copy it from read_file, without the line numbers.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } },
  { name: 'write_file', description: 'Create a new file, or replace a whole file, with its complete contents. For changes to an existing file use edit_file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'run_command', description: 'Run a shell command in the project folder (build, test, install, git…) and get its output. It stops after 2 minutes, so don\'t start servers or watchers.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
].map(fn => ({ type: 'function', function: fn }));
const WRITE_TOOLS = new Set(['edit_file', 'write_file', 'run_command']);
const LIST_MAX = 200;
const COMMAND_MS = 2 * 60 * 1000;
const COMMAND_OUT_MAX = 8000; // characters of output the model gets back; the end is kept, where errors show

// Each tool works inside ctx.base: the open project, or the Breeze Box folder. Secrets (.env…) and the .git
// folder are off limits: what the model reads goes to the LLM server, and git's config and hooks run commands.
// With full access none of that applies: any path on the computer is fair.
function agentPath(ctx, rel) {
  if (ctx.full) return path.resolve(ctx.base, String(rel ?? ''));
  const abs = resolveUnder(ctx.base, rel);
  const why = agentBlocked(ctx.base, abs);
  if (why) throw new Error(why);
  return abs;
}
// On a team, a write to a teammate's file is refused before it lands. A file no one owns becomes this agent's.
async function checkTeamWrite(ctx, rel) {
  if (!ctx.team) return;
  const { coordinator, agentId } = ctx.team;
  const owner = await coordinator.foreignOwner(agentId, rel);
  if (!owner) return;
  emit(ctx.runId, { t: 'crossing', path: rel, agent: agentId, owner, blocked: true });
  const name = coordinator.members.find(m => m.agentId === owner)?.name || owner;
  throw new Error(`That file belongs to ${name} on this team. Leave it and mention what you need in your final message.`);
}
const LLM_TOOL_FNS = {
  async list_files(ctx, a) {
    const dir = agentPath(ctx, a.path || '.');
    emit(ctx.runId, { t: 'tool', kind: 'read', label: `Listed ${a.path && a.path !== '.' ? a.path : 'the project'}` });
    const out = [];
    const walk = async (d, indent, level) => {
      let entries;
      try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
      entries.sort((x, y) => Number(y.isDirectory()) - Number(x.isDirectory()) || x.name.localeCompare(y.name));
      for (const e of entries) {
        if (out.length >= LIST_MAX) return;
        if (e.isDirectory() && IGNORED_DIRS.has(e.name)) continue;
        out.push(`${indent}${e.name}${e.isDirectory() ? '/' : ''}`);
        if (e.isDirectory() && level < 1) await walk(path.join(d, e.name), `${indent}  `, level + 1);
      }
    };
    await walk(dir, '', 0);
    if (!out.length) return 'Empty folder.';
    return out.join('\n') + (out.length >= LIST_MAX ? '\n… more entries; list a subfolder' : '');
  },
  async read_file(ctx, a) {
    const abs = agentPath(ctx, a.path);
    await fsp.stat(abs); // a missing file comes back as an error the model can read
    const rel = relTo(ctx.base, abs);
    const range = a.start_line > 1 || a.end_line ? ` (lines ${a.start_line || 1}–${a.end_line || ''})` : '';
    emit(ctx.runId, { t: 'tool', kind: 'read', label: `Read ${rel}${range}` });
    const text = await readSearchable(abs);
    if (text == null) return 'Not a readable text file (binary, or larger than 1 MB).';
    return brain.readRange(text, rel, a.start_line, a.end_line);
  },
  async search_files(ctx, a) {
    emit(ctx.runId, { t: 'tool', kind: 'search', label: `Searched for ${a.query}` });
    return brain.formatHits(await searchProject(String(a.query || ''), false, ctx.base, ctx.full ? undefined : blockedRel));
  },
  // The shell's output, both streams as they came. The whole process tree stops at the time limit or when the run is stopped.
  run_command(ctx, a) {
    const command = String(a.command ?? '').trim();
    if (!command) throw new Error('command is empty.');
    emit(ctx.runId, { t: 'tool', kind: 'run', label: `$ ${command}` });
    return new Promise(resolve => {
      const child = spawn(command, { cwd: ctx.base, shell: true, windowsHide: true, env: process.env });
      let out = '', timedOut = false;
      const add = d => { out = (out + d).slice(-COMMAND_OUT_MAX * 2); };
      child.stdout.on('data', add);
      child.stderr.on('data', add);
      const stop = () => killTree(child);
      const timer = setTimeout(() => { timedOut = true; stop(); }, COMMAND_MS);
      ctx.signal?.addEventListener('abort', stop, { once: true });
      const finish = head => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', stop);
        const body = out.length > COMMAND_OUT_MAX ? `…${out.slice(-COMMAND_OUT_MAX)}` : out;
        resolve(`${head}\n${body.trim() || '(no output)'}`);
      };
      child.on('error', err => finish(`Couldn't start it: ${err.message}`));
      child.on('close', code => finish(timedOut ? `Stopped after ${COMMAND_MS / 60000} minutes.` : `Exit code ${code}.`));
    });
  },
  async edit_file(ctx, a) {
    const abs = agentPath(ctx, a.path);
    const rel = relTo(ctx.base, abs);
    await checkTeamWrite(ctx, rel);
    const { text, line } = brain.applyEdit(await fsp.readFile(abs, 'utf8'), a.old_text, a.new_text);
    await fsp.writeFile(abs, text, 'utf8');
    emit(ctx.runId, { t: 'tool', kind: 'edit', label: `Edited ${rel}` });
    emit(ctx.runId, { t: 'file', path: relOut(abs) });
    return `Edited ${rel} at line ${line}.`;
  },
  async write_file(ctx, a) {
    const abs = agentPath(ctx, a.path);
    await checkTeamWrite(ctx, relTo(ctx.base, abs));
    const content = String(a.content ?? '');
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf8');
    emit(ctx.runId, { t: 'tool', kind: 'edit', label: `Wrote ${relTo(ctx.base, abs)}` });
    emit(ctx.runId, { t: 'file', path: relOut(abs) });
    return `Saved ${relTo(ctx.base, abs)} (${content.split('\n').length} lines).`;
  },
};
async function llmTool(ctx, call) {
  const name = call.function?.name;
  const fn = LLM_TOOL_FNS[name];
  if (!fn) throw new Error(`There is no tool called ${name}. Use one of: ${ctx.toolNames.join(', ')}.`);
  if (WRITE_TOOLS.has(name) && ctx.mode !== 'build') throw new Error('This is read-only mode, so files can’t be changed and commands can’t run. Describe the change instead.');
  let args;
  try { args = JSON.parse(call.function.arguments || '{}'); } catch { throw new Error('The arguments were not valid JSON. Call the tool again with a JSON object.'); }
  if (WRITE_TOOLS.has(name)) ctx.seen.clear(); // files changed, so reading them again is fair
  else {
    const key = brain.callKey(name, args);
    if (ctx.seen.has(key) && ctx.turn - ctx.seen.get(key) <= 2) return 'You just made this exact call and its result is above. Use it, or try something different.';
    ctx.seen.set(key, ctx.turn);
  }
  return fn(ctx, args);
}
// Runs a reply's tool calls one after another (a later call may read what an earlier one wrote).
function runToolCalls(ctx, calls) {
  return calls.reduce(async (prev, call) => {
    const replies = await prev;
    let content;
    try { content = String(await llmTool(ctx, call)); } catch (err) { content = `Error: ${err.message}`; }
    return [...replies, { role: 'tool', tool_call_id: call.id, content }];
  }, Promise.resolve([]));
}
const LLM_MODE_NOTE = {
  build: 'Build mode: make the change with edit_file (write_file only for new files), run_command to build or test it, then say what you changed.',
  plan: 'Plan mode: read only. Look at the code you need, then reply with a short numbered plan of the changes.',
  ask: 'Ask mode: read only. Answer the question directly.',
};
// Reliability rules adapted from the Gravitas skill (MIT, github.com/udaysharmadev/Gravitas), trimmed to the tools this agent has.
const llmSystemPrompt = base => `You are Breeze, a coding agent working in the user's project "${path.basename(base)}".
Work efficiently:
- The first message has a map of the project. Use search_files to find code, then read_file only the lines you need.
- Read code before you change it. Change files with edit_file; use write_file only for new files.
- Never repeat a tool call with the same arguments. Stop calling tools as soon as you can answer.
- Only say something works or is fixed if a tool result showed it. Say what you could not check.
- Stay inside the project and do only what was asked.
Reply short and plain. After changing files, list the files, what you checked, and why.
When the user asks for code or a file to keep (and you are not writing it into the project), give it as one fenced block with the language and a file name, like \`\`\`html index.html, so it shows as a card they can copy or download.`;
async function llmPost(cfg, body, signal) {
  const r = await fetch(`${cfg.url}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...llmHeaders(cfg.key) },
    body: JSON.stringify(body),
    signal,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || j.error || `The server answered with status ${r.status}`);
  return j;
}
// Some local models can't call tools; they still answer, just without looking at files.
async function llmRequest(ctx, body, signal) {
  if (ctx.noTools || !body.tools) return llmPost(ctx.cfg, { ...body, tools: undefined }, signal);
  try {
    return await llmPost(ctx.cfg, body, signal);
  } catch (err) {
    if (!/tool/i.test(err.message)) throw err;
    ctx.noTools = true;
    emit(ctx.runId, { t: 'note', text: `${ctx.cfg.model} can't use tools, so it answers without looking at your files.` });
    return llmPost(ctx.cfg, { ...body, tools: undefined }, signal);
  }
}
// A reply that is only a tool call written as text ({"name": "read_file", "arguments": {...}}), possibly fenced,
// becomes real tool calls. Anything else (prose, other JSON, unknown tool names) is left alone.
function textToolCalls(text, toolNames) {
  const body = String(text ?? '').trim().replace(/^```[\w-]*\s*\n?/, '').replace(/\n?```$/, '').trim();
  if (!/^[[{]/.test(body)) return null;
  let parsed;
  try { parsed = JSON.parse(body); } catch { return null; }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const calls = [];
  for (const c of list) {
    const fn = c?.function ?? c;
    const args = fn?.arguments ?? fn?.parameters ?? {};
    if (typeof fn?.name !== 'string' || !toolNames.includes(fn.name) || args === null || typeof args === 'number') return null;
    calls.push({ id: `call_${crypto.randomUUID().slice(0, 8)}`, type: 'function', function: { name: fn.name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
  }
  return calls.length ? calls : null;
}
const LLM_MAX_TURNS = 24;
const LLM_REPLY_RESERVE = 1500; // tokens left free for the model's own reply
// Ollama runs models with a small context unless it was raised on the server; other servers usually allow more.
// `llmContext` in the saved state overrides the guess.
function llmBudget(cfg) {
  const window = Number(loadState().llmContext) || (/:11434\b/.test(cfg.url) ? 4096 : 8192);
  return Math.max(1500, window - LLM_REPLY_RESERVE - brain.tokensOf(JSON.stringify(LLM_TOOLS)));
}
// Reasoning models (Qwen 3, DeepSeek R1…) put their thinking in <think> tags: it is neither shown nor kept.
const withoutThinking = s => String(s ?? '').replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '').trim();
async function executeLlmTurns(ctx, run, ask, messages) {
  for (let n = 0; n < LLM_MAX_TURNS && !run.stopped; n++) {
    ctx.turn = n;
    const calls = await ask(true);
    if (!calls) break;
    messages.push(...await runToolCalls(ctx, calls));
    if (n === LLM_MAX_TURNS - 1 && !run.stopped) {
      emit(ctx.runId, { t: 'note', text: `${ctx.cfg.model} used ${LLM_MAX_TURNS} steps, so Breeze asked it to answer with what it found.` });
      messages.push({ role: 'user', content: 'You have used many steps. Stop using tools and answer now with what you found.' });
      await ask(false);
    }
  }
}

async function runLocal(runId, run, { mode, prompt, session, base }) {
  const cfg = await llmConfig(false);
  if (!cfg?.model) throw new Error('Connect a local LLM server first (Settings → Run Setup Again).');
  await llmReachable(cfg);
  const sid = session && llmSessions.has(session) ? session : crypto.randomUUID();
  const fresh = !llmSessions.has(sid);
  const messages = llmSessions.get(sid) || [{ role: 'system', content: llmSystemPrompt(base) }];
  llmSessions.set(sid, messages);
  emit(runId, { t: 'session', id: sid, model: cfg.model });
  const budget = llmBudget(cfg);
  const map = fresh ? `Project map:\n${brain.projectMap((await listFiles(base)).map(f => relTo(base, f)), Math.min(2400, Math.floor(budget * 0.8)))}\n\n` : '';
  messages.push({ role: 'user', content: `${map}${prompt}\n\n(${LLM_MODE_NOTE[mode] ?? LLM_MODE_NOTE.ask})` });
  const tools = LLM_TOOLS.filter(t => mode === 'build' || !WRITE_TOOLS.has(t.function.name));
  run.abort = new AbortController();
  const full = mode === 'build' && fullAccess();
  const ctx = { runId, base, cfg, mode, full, signal: run.abort.signal, team: run.team, noTools: false, seen: new Map(), turn: 0, toolNames: tools.map(t => t.function.name) };
  const started = Date.now();
  let tokens = 0, lastText = '';
  // One request; only the assistant's text and tool calls are kept (servers add extra fields).
  const ask = async withTools => {
    const body = { model: cfg.model, messages: brain.compactHistory(messages, budget), temperature: 0.2, stream: false };
    if (withTools) body.tools = tools;
    const j = await llmRequest(ctx, body, run.abort.signal);
    tokens += j.usage?.total_tokens || 0;
    const msg = j.choices?.[0]?.message;
    if (!msg) throw new Error('The model returned no answer');
    let text = withoutThinking(msg.content);
    let calls = msg.tool_calls?.length ? msg.tool_calls : null;
    // Small models often print the call as JSON text instead of using the tool API: run it rather than show it.
    if (!calls && withTools) {
      calls = textToolCalls(text, ctx.toolNames);
      if (calls) text = '';
    }
    messages.push({ role: 'assistant', content: text, ...(calls ? { tool_calls: calls } : {}) });
    if (text) { lastText = text; emit(runId, { t: 'text', text }); }
    return calls;
  };
  try {
    await executeLlmTurns(ctx, run, ask, messages);
  } catch (err) {
    if (!run.stopped) throw err; // stopping aborts the request
  } finally {
    // Later turns keep the conversation, not this turn's raw tool output.
    messages.splice(0, messages.length, ...brain.settle(messages));
  }
  runs.delete(runId);
  if (run.stopped) { emit(runId, { t: 'done', ok: false, stopped: true }); return; }
  if (mode === 'plan' && lastText) emit(runId, { t: 'plan', text: lastText });
  emit(runId, { t: 'done', ok: true, ms: Date.now() - started, tokens });
}

/* ================= Git ================= */
// Git runs from its full path: the usual install folders first, then wherever PATH finds it.
let gitPath = null;
async function gitBin() {
  if (gitPath) return gitPath;
  const known = isWin
    ? [path.join(process.env.ProgramFiles || String.raw`C:\Program Files`, 'Git', 'cmd', 'git.exe'), path.join(LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe')]
    : ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'];
  gitPath = known.find(p => fs.existsSync(p)) || await which('git');
  if (!gitPath) throw new Error('Git is not installed. Get it from https://git-scm.com/downloads');
  return gitPath;
}
async function git(args, { input, timeout = 60000 } = {}) {
  const bin = await gitBin();
  return new Promise((res, rej) => {
    const child = execFile(bin, safeGitArgs(args), {
      cwd: resolveIn(''), windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    }, (err, stdout, stderr) => (err ? rej(new Error((stderr || err.message).trim())) : res(stdout)));
    if (input != null) child.stdin.end(input);
  });
}
const checkPaths = paths => (Array.isArray(paths) ? paths : [paths]).map(p => { resolveIn(p); return p; });
const HASH = /^[0-9a-f]{4,40}$/i;

// "## main...origin/main [ahead 1, behind 2]" → branch, upstream, ahead and behind.
function parseBranchHeader(head) {
  if (head.startsWith('No commits yet on ')) return { hasCommits: false, branch: head.slice(18) };
  let rest = head, track = '';
  const bracket = rest.lastIndexOf(' [');
  if (bracket !== -1 && rest.endsWith(']')) {
    track = rest.slice(bracket + 2, -1);
    rest = rest.slice(0, bracket);
  }
  const [branch, upstream = ''] = rest.split('...');
  const count = word => Number(new RegExp(String.raw`${word} (\d+)`).exec(track)?.[1] || 0);
  return { branch: branch === 'HEAD (no branch)' ? 'detached' : branch, upstream, ahead: count('ahead'), behind: count('behind') };
}
// An ignored path ("!! dir/"), relative to the open folder with forward slashes and no trailing slash.
function ignoredPath(rel) {
  let clean = rel.replaceAll('\\', '/');
  while (clean.endsWith('/')) clean = clean.slice(0, -1);
  return clean;
}
// One "XY path" entry: an ignored path or a changed file, unless it lies outside the open folder.
function addStatusEntry(res, e, top, currentRoot) {
  const x = e[0], y = e[1];
  const rel = path.relative(currentRoot, path.join(top, e.slice(3)));
  if (rel.startsWith('..')) return;
  if (x !== '!' || y !== '!') { res.files.push({ path: rel.split(path.sep).join('/'), x, y }); return; }
  const clean = ignoredPath(rel);
  if (clean) res.ignored.push(clean);
}
function parseGitStatusPorcelain(out, top, currentRoot) {
  const res = { branch: '', upstream: '', ahead: 0, behind: 0, files: [], ignored: [] };
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.startsWith('## ')) Object.assign(res, parseBranchHeader(e.slice(3)));
    else if (e) {
      addStatusEntry(res, e, top, currentRoot);
      // A rename or copy is followed by its old path as the next entry, which isn't a change of its own.
      if (e[0] === 'R' || e[0] === 'C') i++;
    }
  }
  return res;
}

handle('git:status', async () => {
  if (!root) return { repo: false };
  let top;
  try { top = (await git(['rev-parse', '--show-toplevel'])).trim(); } catch { return { repo: false }; } // not a repository
  const [out, remotes] = await Promise.all([
    git(['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all', '--ignored=matching']),
    git(['remote']).catch(() => ''),
  ]);
  const parsed = parseGitStatusPorcelain(out, top, root);
  // Files changed on the upstream branch that are not pulled yet (known since the last fetch).
  const incoming = parsed.behind && parsed.upstream
    ? (await git(['diff', '--name-only', '-z', '--relative', 'HEAD...@{u}']).catch(() => '')).split('\0').filter(Boolean)
    : [];
  return { repo: true, ...parsed, incoming, hasCommits: true, hasRemote: !!remotes.trim() };
});

handle('git:log', async () => {
  let out;
  try {
    out = await git(['log', '--all', '--topo-order', '-n', '150', '--numstat', '--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%ar%x1f%D%x1f%s%x1f%B%x1f']);
  } catch {
    return { head: null, commits: [], details: [] };
  }
  const head = (await git(['rev-parse', 'HEAD']).catch(() => '')).trim();
  const commits = [];
  const details = [];
  const records = out.split('\x1e').filter(Boolean);
  for (const r of records) {
    const [hash, parents, author, email, when, refs, subject, body, stats = ''] = r.split('\x1f');
    if (!hash) continue;
    const files = stats.trim().split('\n').filter(Boolean).map(l => {
      const [a, d, ...p] = l.split('\t');
      return { path: p.join('\t'), added: a === '-' ? 0 : Number(a), removed: d === '-' ? 0 : Number(d) };
    });
    commits.push({
      hash,
      parents: parents ? parents.trim().split(' ').filter(Boolean) : [],
      author,
      when,
      refs: refs ? refs.trim().split(', ').filter(Boolean) : [],
      subject: subject || ''
    });
    details.push({
      hash,
      author,
      email: email || '',
      when,
      message: (body || subject || '').trim(),
      files
    });
  }
  return { head, commits, details };
});

handle('git:show', async (_e, hash) => {
  if (!HASH.test(hash)) throw new Error('Bad commit id');
  const out = await git(['show', '--numstat', '--format=%H%x1f%an%x1f%ae%x1f%ar%x1f%B%x1e', hash]);
  const [header, stats = ''] = out.split('\x1e');
  const [full, author, email, when, body] = header.split('\x1f');
  const files = stats.trim().split('\n').filter(Boolean).map(l => {
    const [a, d, ...p] = l.split('\t');
    return { path: p.join('\t'), added: a === '-' ? 0 : Number(a), removed: d === '-' ? 0 : Number(d) };
  });
  return { hash: full, author, email, when, message: (body || '').trim(), files };
});

handle('git:diff', (_e, rel, staged) => git(['diff', '--no-color', ...(staged ? ['--cached'] : []), '--', ...checkPaths(rel)]));
handle('git:init', () => git(['init']));
handle('git:stage', (_e, paths) => git(['add', '-A', '--', ...checkPaths(paths)]));
handle('git:unstage', (_e, paths, hasCommits) => {
  const p = checkPaths(paths);
  return hasCommits ? git(['restore', '--staged', '--', ...p]) : git(['rm', '--cached', '-r', '-q', '--', ...p]);
});
// Discarding untracked files moves them to the Recycle Bin rather than deleting them.
handle('git:discard', async (_e, files) => {
  const tracked = files.filter(f => !f.untracked).map(f => f.path);
  const untracked = files.filter(f => f.untracked).map(f => f.path);
  checkPaths([...tracked, ...untracked]);
  await Promise.all(untracked.map(p => shell.trashItem(resolveIn(p))));
  if (tracked.length) await git(['restore', '--worktree', '--', ...tracked]);
});
handle('git:commit', async (_e, message, all) => {
  if (!String(message || '').trim()) throw new Error('Write a message for this checkpoint first');
  if (all) await git(['add', '-A']);
  await git(['commit', '-F', '-'], { input: message });
  return (await git(['rev-parse', '--short', 'HEAD'])).trim();
});
handle('git:branches', async () => {
  const out = await git(['branch', '--format=%(refname:short)']).catch(() => '');
  return out.split('\n').map(s => s.trim()).filter(Boolean);
});
handle('git:switch', async (_e, name, create, from) => {
  await git(['check-ref-format', '--branch', name]);
  if (from && !HASH.test(from)) throw new Error('Bad commit id');
  return git(create ? ['switch', '-c', name, ...(from ? [from] : [])] : ['switch', name]);
});

handle('git:deleteBranch', async (_e, name) => {
  const names = (await git(['branch', '--format=%(refname:short)'])).split('\n').map(s => s.trim()).filter(Boolean);
  if (!names.includes(String(name))) throw new Error('That branch no longer exists');
  const current = (await git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
  if (name === current) throw new Error("You can't delete the branch you're on. Switch to another branch first.");
  return git(['branch', '-D', '--', name]);
});

handle('git:sync', async (_e, op) => {
  const opts = { timeout: 120000 };
  if (op === 'fetch') return git(['fetch', '--all', '--prune'], opts);
  if (op === 'pull') return git(['pull', '--ff-only'], opts);
  if (op === 'push') {
    const upstream = await git(['rev-parse', '--abbrev-ref', '@{u}']).catch(() => '');
    return git(upstream ? ['push'] : ['push', '-u', 'origin', 'HEAD'], opts);
  }
  throw new Error('Unknown sync operation');
});

// The first agent that can write a commit message when none is picked: installed CLIs first, then a local LLM.
async function defaultCommitAgent() {
  for (const id of ['antigravity', 'codex', 'claude']) if (agentBins.get(id)) return id;
  return (await llmConfig(true).catch(() => null)) ? 'local' : null;
}
// Agents tend to wrap the message in a code fence or quotes; the commit box wants the bare text.
function cleanCommitText(text, fallback) {
  let clean = String(text || '').trim();
  if (clean.startsWith('```') && clean.endsWith('```')) clean = clean.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
  const quoted = (clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"));
  if (quoted) clean = clean.slice(1, -1).trim();
  return clean || fallback;
}
// Runs an agent CLI with the prompt on stdin and resolves with whatever `finish` makes of its whole output.
function runCommitCli(bin, args, base, prompt, finish, onLine) {
  return new Promise((resolve, reject) => {
    const child = /\.(?:cmd|bat)$/i.test(bin)
      ? spawn(shellCommand(bin, args), { cwd: base, windowsHide: true, env: process.env, shell: true })
      : spawn(bin, args, { cwd: base, windowsHide: true, env: process.env });
    let out = '';
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      out += chunk;
      if (!onLine) return;
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      lines.forEach(onLine);
    });
    child.stdin.on('error', () => { /* exited early; close reports it */ });
    child.stdin.end(prompt);
    child.on('close', () => resolve(finish(out)));
    child.on('error', reject);
  });
}
function antigravityCommitMsg(base, prompt, model) {
  const service = new AntigravityAgentService({
    executablePath: agentBins.get('antigravity') || undefined,
    cwd: base,
    mode: 'ask',
    model: model || 'gemini-3.8-flash-low',
    effort: undefined, // No forced effort requirement: every model (Claude, Flash, Opus, GPT-OSS) runs without conflict
    prompt,
    autoOpenAuth: false,
  });
  return new Promise((resolve, reject) => {
    let resultText = '';
    service.on('output', ev => {
      if (ev.type !== 'text' || !ev.text) return;
      // A finished JSON turn carries the whole reply; plain-text output arrives one line at a time.
      if (ev.raw || !resultText) resultText = ev.text;
      else resultText = `${resultText}\n${ev.text}`;
    });
    service.on('error', reject);
    service.on('exit', code => {
      const clean = cleanCommitText(resultText, '');
      if (clean) resolve(clean);
      else if (code === 0) resolve('chore: update project');
      else reject(new Error(`Antigravity exited with code ${code}`));
    });
    service.start().catch(reject);
  });
}
async function localCommitMsg(base, prompt, model) {
  const cfg = await llmConfig(true).catch(() => null);
  if (!cfg) throw new Error('No Ollama server is connected');
  const body = {
    model: model || cfg.model,
    messages: [
      { role: 'system', content: 'You write detailed Git commit messages: a Conventional Commits subject line (at most 72 characters) followed by a blank line and one specific bullet per distinct change, naming the files, components or behaviour affected. Follow the format and rules in the request exactly. Output ONLY the commit message without quotes, code fences or explanations.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.2,
    stream: false
  };
  const j = await llmRequest({ base, cfg }, body);
  return cleanCommitText(withoutThinking(j.choices?.[0]?.message?.content || ''), 'chore: update files');
}
function codexCommitMsg(base, prompt, model, effort) {
  const bin = agentBins.get('codex');
  if (!bin) throw new Error('Codex was not found');
  const targetModel = model || 'gpt-4o-mini';
  const args = ['exec', '--json', '-s', 'read-only', '--skip-git-repo-check', '-m', targetModel];
  if (effortArg(effort) && /^(o1|o3|o4)/i.test(targetModel)) args.push('-c', `model_reasoning_effort=${effortArg(effort)}`);
  let message = '';
  const onLine = l => {
    try {
      const ev = JSON.parse(l);
      if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item?.text) message = ev.item.text;
    } catch { /* not a JSON event */ }
  };
  return runCommitCli(bin, args, base, prompt, () => cleanCommitText(message, 'chore: update project'), onLine);
}
function claudeCommitMsg(base, prompt, model) {
  const bin = agentBins.get('claude');
  if (!bin) throw new Error('Claude was not found');
  const targetModel = CLAUDE_MODELS.includes(model) && model !== 'default' ? model : 'haiku';
  const args = ['-p', '--output-format', 'json', '--model', targetModel, '--disallowedTools', ...CLAUDE_WRITE_TOOLS];
  const finish = out => {
    let text;
    try { text = JSON.parse(out).result; } catch { text = out; }
    return cleanCommitText(text, 'chore: update project');
  };
  return runCommitCli(bin, args, base, prompt, finish);
}
const COMMIT_WRITERS = { antigravity: antigravityCommitMsg, local: localCommitMsg, codex: codexCommitMsg, claude: claudeCommitMsg };
handle('git:genCommitMsg', async (_e, { agent, prompt, model, effort }) => {
  const base = root;
  if (!base) throw new Error('Open a folder first');
  const writer = COMMIT_WRITERS[agent || await defaultCommitAgent()];
  if (!writer) throw new Error(`Unsupported agent: ${agent}`);
  return writer(base, prompt, model, effort);
});

/* ================= Sign in with GitHub / Google ================= */
// Client ids come from breeze.config.json in the project root, or from environment variables.
// A .env in the project root fills in environment variables; ones already set in the shell win.
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env */ }
function authConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(ROOT, 'breeze.config.json'), 'utf8')); } catch { /* not configured */ }
  return {
    github: { clientId: process.env.BREEZE_GITHUB_CLIENT_ID || file.github?.clientId || '' },
    google: {
      clientId: process.env.BREEZE_GOOGLE_CLIENT_ID || file.google?.clientId || '',
      clientSecret: process.env.BREEZE_GOOGLE_CLIENT_SECRET || file.google?.clientSecret || '',
    },
  };
}
let authAbort = null;
const authEmit = ev => win?.webContents.send('auth:event', ev);
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('cancelled')); }, { once: true });
});

// Every account signed in on this computer is remembered; one of them is active.
const accountId = u => `${u.provider}:${u.login}`;
function accountsState() {
  const s = loadState();
  const accounts = s.accounts || (s.user ? [s.user] : []);
  return { accounts, active: s.user ? accountId(s.user) : null };
}
function addAccount(user) {
  const { accounts } = accountsState();
  saveState({ user, accounts: [...accounts.filter(a => accountId(a) !== accountId(user)), user] });
}
handle('auth:user', () => loadState().user || null);
// /user only shows a public email; /user/emails (the user:email scope) has the primary one even when it's private.
async function githubEmail(token, signal) {
  try {
    const r = await fetch('https://api.github.com/user/emails', {
      signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Breeze-IDE' },
    });
    if (!r.ok) return null;
    const list = await r.json();
    return (list.find(e => e.primary) || list.find(e => e.verified) || list[0])?.email || null;
  } catch { return null; }
}
// GitHub accounts signed in before Breeze asked /user/emails: look their email up once per run.
const emailLookedUp = new Set();
async function fillAccountEmails() {
  const missing = accountsState().accounts.filter(a => a.provider === 'GitHub' && !a.email && !emailLookedUp.has(accountId(a)));
  if (!missing.length) return;
  const found = new Map();
  await Promise.all(missing.map(async a => {
    emailLookedUp.add(accountId(a));
    const token = getSecret(`token:${accountId(a)}`);
    const email = token && await githubEmail(token);
    if (email) found.set(accountId(a), email);
  }));
  if (!found.size) return;
  const s = loadState(), { accounts } = accountsState();
  const withEmail = a => (found.has(accountId(a)) ? { ...a, email: found.get(accountId(a)) } : a);
  saveState({ accounts: accounts.map(withEmail), user: s.user ? withEmail(s.user) : s.user });
}
handle('auth:accounts', async () => { await fillAccountEmails(); return accountsState(); });
handle('auth:switch', (_e, id) => {
  const user = accountsState().accounts.find(a => accountId(a) === id);
  if (!user) throw new Error('That account is no longer signed in');
  saveState({ user });
  return user;
});
// Signs the active account out and switches to the next one, if any.
handle('auth:signOut', () => {
  const { accounts, active } = accountsState();
  if (active) setSecret(`token:${active}`, null);
  const rest = accounts.filter(a => accountId(a) !== active);
  const user = rest[0] || null;
  saveState({ accounts: rest, user });
  return user;
});
// Forgets one remembered account (and its saved sign-in). Removing the active one switches to the next.
handle('auth:remove', (_e, id) => {
  const { accounts, active } = accountsState();
  if (!accounts.some(a => accountId(a) === id)) throw new Error('That account is no longer signed in');
  setSecret(`token:${id}`, null);
  const rest = accounts.filter(a => accountId(a) !== id);
  const user = id === active ? rest[0] || null : loadState().user || null;
  saveState({ accounts: rest, user });
  return user;
});
handle('auth:cancel', () => { authAbort?.abort(); authAbort = null; });
handle('auth:start', (_e, provider) => {
  const cfg = authConfig();
  if (provider === 'GitHub' && !cfg.github.clientId) return { error: 'not-configured' };
  if (provider === 'Google' && !cfg.google.clientId) return { error: 'not-configured' };
  authAbort?.abort();
  const ac = new AbortController();
  authAbort = ac;
  (provider === 'GitHub' ? githubSignIn(cfg.github, ac.signal) : googleSignIn(cfg.google, ac.signal))
    .then(user => { addAccount(user); authEmit({ t: 'done', user }); })
    .catch(err => { if (!ac.signal.aborted) authEmit({ t: 'error', text: err.message }); })
    .finally(() => { if (authAbort === ac) authAbort = null; });
  return { started: true };
});

// GitHub device flow: the user types a short code on github.com; no client secret needed.
async function githubSignIn({ clientId }, signal) {
  const post = async (url, body) => (await fetch(url, {
    method: 'POST', signal,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })).json();
  const dc = await post('https://github.com/login/device/code', { client_id: clientId, scope: 'read:user user:email repo' }); // repo: workspace sync keeps a private breeze-sync repo
  if (dc.error) throw new Error(dc.error_description || dc.error);
  authEmit({ t: 'code', provider: 'GitHub', code: dc.user_code, uri: dc.verification_uri });
  openInBrowser(dc.verification_uri);
  const deadline = Date.now() + (dc.expires_in || 900) * 1000;
  // Ask GitHub every few seconds until the user has entered the code.
  const poll = async interval => {
    if (Date.now() > deadline) throw new Error('The code expired. Try again.');
    await sleep(interval, signal);
    const t = await post('https://github.com/login/oauth/access_token', {
      client_id: clientId, device_code: dc.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (t.access_token) return t.access_token;
    if (t.error === 'slow_down') return poll(interval + 5000);
    if (t.error === 'authorization_pending') return poll(interval);
    throw new Error(t.error_description || t.error);
  };
  const token = await poll((dc.interval || 5) * 1000);
  const ur = await fetch('https://api.github.com/user', {
    signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Breeze-IDE' },
  });
  if (!ur.ok) throw new Error('GitHub signed you in but did not share your profile. Try again.');
  const u = await ur.json();
  const user = { provider: 'GitHub', name: u.name || u.login, login: u.login, email: u.email || await githubEmail(token, signal), avatar: u.avatar_url || null };
  setSecret(`token:${accountId(user)}`, token);
  return user;
}

// Google: authorization code + PKCE through a one-shot loopback server on 127.0.0.1.
// The page the browser lands on after Google: Breeze's look, with Unbounded headings and Instrument Sans text.
const PAGE_ICON = {
  ok: '<path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#f5f5f7" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  fail: '<path d="M12 7.5v5.5M12 16.5v.01" fill="none" stroke="#f5f5f7" stroke-width="2.4" stroke-linecap="round"/>',
};
// The Breeze IDE wordmark is inlined so the one-shot server needs no asset route.
let wordmarkUri = null;
function wordmarkSrc() {
  if (wordmarkUri === null) {
    try { wordmarkUri = `data:image/png;base64,${fs.readFileSync(path.join(ROOT, 'assets', 'brand', 'BreezeCode.png')).toString('base64')}`; } catch { wordmarkUri = ''; }
  }
  return wordmarkUri;
}
function googleRedirectPage(ok) {
  const title = ok ? 'You’re signed in' : 'Sign-in didn’t finish';
  const text = ok ? 'Breeze has your account now. You can close this tab and head back to Breeze.' : 'Nothing was changed. Close this tab and try again from Breeze.';
  // The badge starts on the brand blue and eases to green once the sign-in lands; a failure stays amber.
  const tone = ok
    ? { from: '#007AFF', to: '#57C478', shadowFrom: 'rgba(0,122,255,.45)', shadowTo: 'rgba(87,196,120,.45)', glowFrom: 'rgba(0,122,255,.32)', glowTo: 'rgba(87,196,120,.3)' }
    : { from: '#d97706', to: '#d97706', shadowFrom: 'rgba(217,119,6,.4)', shadowTo: 'rgba(217,119,6,.4)', glowFrom: 'rgba(0,122,255,.32)', glowTo: 'rgba(217,119,6,.26)' };
  const logo = wordmarkSrc();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Breeze</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@600;700&family=Instrument+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>
  @property --glow { syntax: '<color>'; inherits: false; initial-value: ${tone.glowFrom}; }
  @property --gx { syntax: '<percentage>'; inherits: false; initial-value: 50%; }
  @property --gy { syntax: '<percentage>'; inherits: false; initial-value: -10%; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; color: #f5f5f7; font: 15px/1.6 "Instrument Sans", system-ui, sans-serif;
    background: radial-gradient(900px 460px at var(--gx, 50%) var(--gy, -10%), var(--glow, ${tone.glowFrom}), transparent 70%), #1d1d1f;
    animation: glowTone 1.2s .5s cubic-bezier(.4,0,.2,1) both, sway 11s ease-in-out infinite alternate; }
  .card { width: min(440px, 100%); text-align: center; padding: 40px 36px 34px; border-radius: 24px; border: 1px solid rgba(255,255,255,.1);
    background: rgba(28,28,34,.55); backdrop-filter: blur(22px) saturate(160%); box-shadow: 0 30px 90px rgba(0,0,0,.55); animation: rise .5s cubic-bezier(.2,.8,.2,1); }
  .badge { width: 64px; height: 64px; margin: 0 auto 22px; border-radius: 50%; display: grid; place-items: center;
    background: ${tone.from}; box-shadow: 0 10px 30px ${tone.shadowFrom}; animation: badgeTone 1s .55s cubic-bezier(.4,0,.2,1) both; }
  .badge path { stroke-dasharray: 20; stroke-dashoffset: 20; animation: draw .45s .3s ease-out forwards; }
  h1 { margin: 0 0 10px; font: 700 26px/1.2 Unbounded, "Instrument Sans", sans-serif; letter-spacing: -.01em; }
  p { margin: 0; color: #aaaaaa; }
  .brand { margin-top: 26px; display: flex; align-items: center; justify-content: center; color: #7c7c80; font: 600 12px Unbounded, "Instrument Sans", sans-serif; }
  .brand img { display: block; height: 20px; width: auto; opacity: .75; }
  @keyframes rise { from { opacity: 0; transform: translateY(10px) scale(.98); } }
  @keyframes badgeTone { from { background: ${tone.from}; box-shadow: 0 10px 30px ${tone.shadowFrom}; } to { background: ${tone.to}; box-shadow: 0 10px 30px ${tone.shadowTo}; } }
  @keyframes glowTone { from { --glow: ${tone.glowFrom}; } to { --glow: ${tone.glowTo}; } }
  @keyframes sway { from { --gx: 34%; --gy: -14%; } to { --gx: 66%; --gy: 2%; } }
  @keyframes draw { to { stroke-dashoffset: 0; } }
  @media (prefers-reduced-motion: reduce) { body, .badge, .badge path { animation: none; } .badge path { stroke-dashoffset: 0; } .badge { background: ${tone.to}; } }
</style></head><body>
<main class="card">
  <div class="badge"><svg width="30" height="30" viewBox="0 0 24 24">${ok ? PAGE_ICON.ok : PAGE_ICON.fail}</svg></div>
  <h1>${title}</h1>
  <p>${text}</p>
  <div class="brand">${logo ? `<img src="${logo}" alt="Breeze IDE">` : 'Breeze'}</div>
</main></body></html>`;
}
function waitForGoogleCode({ clientId, challenge, state }, signal) {
  return new Promise((res, rej) => {
    let redirect = '';
    const server = http.createServer((req, resp) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/') { resp.writeHead(404).end(); return; }
      const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
      resp.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(googleRedirectPage(ok));
      server.close();
      if (ok) res({ code: u.searchParams.get('code'), redirect });
      else rej(new Error(u.searchParams.get('error') || 'Sign-in did not finish'));
    });
    server.listen(0, '127.0.0.1', () => {
      redirect = `http://127.0.0.1:${server.address().port}`;
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.search = new URLSearchParams({
        // drive.appdata reaches only Breeze's hidden app folder in Drive, where workspace sync lives.
        client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: `openid email profile ${DRIVE_SCOPE}`,
        code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent select_account',
      }).toString();
      openInBrowser(auth.href);
      authEmit({ t: 'waiting', provider: 'Google' });
    });
    signal.addEventListener('abort', () => { server.close(); rej(new Error('cancelled')); }, { once: true });
  });
}
async function googleSignIn({ clientId, clientSecret }, signal) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');
  const { code, redirect } = await waitForGoogleCode({ clientId, challenge, state }, signal);
  const tr = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}),
      code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code',
    }),
  });
  const tok = await tr.json();
  if (!tr.ok) throw new Error(tok.error_description || tok.error || 'Google did not accept the sign-in');
  const ur = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { signal, headers: { Authorization: `Bearer ${tok.access_token}` } });
  if (!ur.ok) throw new Error('Google signed you in but did not share your profile. Try again.');
  const u = await ur.json();
  const user = { provider: 'Google', name: u.name || u.email, login: u.email, email: u.email || null, avatar: u.picture || null };
  if (tok.refresh_token) setSecret(`token:${accountId(user)}`, tok.refresh_token);
  return user;
}

/* ================= Workspace sync ================= */
// The engine is in sync.js. Here: which cloud the signed-in account uses, and what each folder last synced.
const DRIVE_SCOPE = syncEngine.DRIVE_SCOPE;
const syncDir = () => path.join(app.getPath('userData'), 'sync');
// One small file per account and folder: { id, rev, base } from the last sync.
// The file is named by a hash of the account and folder (just a stable name, nothing secret).
const linkName = (algo, acct, dir) => crypto.createHash(algo).update(acct + '\0' + dir).digest('hex') + '.json'; // NOSONAR: sha1 only matches the names of pre-sha256 link files
const linkFile = (acct, dir) => path.join(syncDir(), linkName('sha256', acct, dir));
function readLink(acct, dir) {
  const file = linkFile(acct, dir);
  // Links saved before the switch to sha256 sit under their sha1 name; move one over the first time it's read.
  // (sha1 here only recognises an old name; nothing is protected by it.)
  const legacy = path.join(syncDir(), linkName('sha1', acct, dir));
  try { if (!fs.existsSync(file) && fs.existsSync(legacy)) fs.renameSync(legacy, file); } catch { /* read the old one below */ }
  for (const f of [file, legacy]) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* try the next */ }
  }
  return null;
}
function writeLink(acct, dir, link) {
  fs.mkdirSync(syncDir(), { recursive: true });
  fs.writeFileSync(linkFile(acct, dir), JSON.stringify(link));
}
async function syncStore() {
  const user = loadState().user;
  if (!user) throw new syncEngine.SyncError('Sign in to sync your workspaces.', 'signed-out');
  const acct = accountId(user);
  const secret = getSecret(`token:${acct}`);
  if (!secret) throw new syncEngine.SyncError(`Sign in to ${user.provider} again to let Breeze sync your workspaces.`, 'reauth');
  if (user.provider === 'GitHub') return { acct, store: syncEngine.githubStore({ token: secret, login: user.login }) };
  const accessToken = await syncEngine.googleAccessToken({ ...authConfig().google, refreshToken: secret });
  return { acct, store: syncEngine.driveStore({ accessToken }) };
}
// IPC drops an error's code, so sync failures come back as { error, code } for the renderer to act on.
function syncHandle(channel, fn) {
  handle(channel, async (...args) => {
    try { return await fn(...args); } catch (err) {
      if (err instanceof syncEngine.SyncError) return { error: err.message, code: err.code || null };
      throw err;
    }
  });
}
let syncBusy = false;
async function oneSync(work) {
  if (syncBusy) throw new syncEngine.SyncError('A sync is already running.');
  syncBusy = true;
  try { return await work(); } finally { syncBusy = false; }
}
const syncBackupDir = () => path.join(app.getPath('userData'), 'sync-backups', new Date().toISOString().replace(/[:.]/g, '-'));

// What the cloud holds, and whether it is ahead of the open folder.
syncHandle('sync:status', async () => {
  const { acct, store } = await syncStore();
  const link = root ? readLink(acct, root) : null;
  const status = await syncEngine.workspaceStatus(store, link);
  return { ...status, linked: !!link, device: os.hostname() };
});
// mode 'sync' merges both ways; 'pull' makes this folder match the cloud (edits it replaces are backed up).
syncHandle('sync:run', (_e, mode) => oneSync(async () => {
  if (!root) throw new syncEngine.SyncError('Open a folder to sync it.');
  const { acct, store } = await syncStore();
  const dir = root;
  const { link, summary } = await syncEngine.syncWorkspace({
    store, dir, link: readLink(acct, dir), mode: mode === 'pull' ? 'pull' : 'sync',
    device: os.hostname(), name: path.basename(dir), backupDir: syncBackupDir(),
  });
  writeLink(acct, dir, link);
  return summary;
}));
// Downloads a cloud workspace into a new folder the user picks the place of, then opens it.
syncHandle('sync:clone', (_e, id) => oneSync(async () => {
  const { acct, store } = await syncStore();
  const ws = (await syncEngine.listWorkspaces(store)).find(w => w.id === id);
  if (!ws) throw new syncEngine.SyncError('That workspace is no longer in the cloud.');
  const r = await dialog.showOpenDialog(win, {
    title: `Where should ${ws.name} go?`, buttonLabel: 'Download here',
    defaultPath: app.getPath('documents'), properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const safeName = ws.name.replace(/[/\\:*?"<>|]/g, '-').replace(/^\.+$/, '') || 'workspace';
  // The first of "name", "name (2)", "name (3)"… that doesn't exist yet or is an empty folder.
  const taken = async d => fs.existsSync(d) && (await fsp.readdir(d)).length > 0;
  let dir = path.join(r.filePaths[0], safeName);
  let n = 2;
  while (await taken(dir)) dir = path.join(r.filePaths[0], `${safeName} (${n++})`);
  await fsp.mkdir(dir, { recursive: true });
  const { link, summary } = await syncEngine.syncWorkspace({
    store, dir, link: { id, rev: 0, base: {} }, mode: 'pull', device: os.hostname(), name: ws.name,
  });
  writeLink(acct, dir, link);
  return { info: await setRoot(dir), summary };
}));
// The renderer's shared settings ({ updatedAt, values }); the newer side wins.
syncHandle('sync:settings', async (_e, local) => {
  const { store } = await syncStore();
  return syncEngine.syncSettings(store, local && typeof local === 'object' ? local : null);
});

/* ================= Vibe Mode: social feeds ================= */
// Feeds live in their own browser session (persist:vibe), apart from the app. Signing in happens on the
// site itself in a Breeze window; Breeze only checks whether a sign-in cookie exists.
const VIBE_PARTITION = 'persist:vibe';
const VIBE_SITES = {
  instagram: { name: 'Instagram Reels', url: 'https://www.instagram.com/reels/', cookie: ['instagram.com', 'sessionid'], domains: ['instagram.com'] },
  facebook: { name: 'Facebook Reels', url: 'https://www.facebook.com/reel/', cookie: ['facebook.com', 'c_user'], domains: ['facebook.com'] },
};
let vibeView = null;
let vibeSessionReady = false;
function vibeSite(id) {
  const site = Object.hasOwn(VIBE_SITES, id) ? VIBE_SITES[id] : null;
  if (!site) throw new Error('Unknown feed');
  return site;
}
// Some sites refuse sign-in from embedded browsers, so the feed session presents a plain Chrome user agent.
function vibeSession() {
  const ses = session.fromPartition(VIBE_PARTITION);
  if (!vibeSessionReady) {
    const ua = ses.getUserAgent().split(' ').filter(t => !t.startsWith('Electron/') && !t.startsWith(`${app.getName()}/`)).join(' ');
    ses.setUserAgent(ua);
    // Fullscreen video is fine; cameras, microphones, location and notifications are not.
    ses.setPermissionRequestHandler((_wc, permission, done) => done(permission === 'fullscreen'));
    vibeSessionReady = true;
  }
  return ses;
}
// The same Chrome, presenting as Chrome on an Android phone (keeps the real version number).
const mobileUserAgent = ua => ua.replace(/\([^)]*\)/, '(Linux; Android 14; Pixel 8)').replace(/ Safari\//, ' Mobile Safari/');
const feedPrefs = () => ({ session: vibeSession(), sandbox: true, contextIsolation: true, nodeIntegration: false });
// Feed pages may only load https; links that open new windows load in place.
function guardFeed(wc) {
  wc.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) wc.loadURL(url).catch(logError('feed popup'));
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => { if (!url.startsWith('https://')) e.preventDefault(); });
}
// Instagram's desktop Reels page sizes its cards to the media instead of the
// embedded view.  In a phone-shaped Vibe frame that leaves enough space for a
// second reel to peek through below the current one.  Keep the page's actual
// reel cards viewport-sized and make its scroll areas snap between them.
function keepInstagramReelsFullscreen(wc) {
  wc.once('did-finish-load', () => {
    if (!wc.getURL().startsWith('https://www.instagram.com/')) return;
    wc.executeJavaScript(`(() => {
      const viewport = () => Math.max(document.documentElement.clientHeight, window.innerHeight);
      const containsOneVideo = el => el.querySelectorAll('video').length === 1;
      const reelCard = video => {
        let el = video.parentElement;
        let fallback = null;
        while (el && el !== document.body) {
          if (containsOneVideo(el)) {
            fallback = el;
            if (el.matches('article')) return el;
            const parent = el.parentElement;
            if (parent && parent.querySelectorAll('video').length > 1) return el;
          }
          el = el.parentElement;
        }
        return fallback;
      };
      const apply = () => {
        for (const video of document.querySelectorAll('video')) {
          const card = reelCard(video);
          if (!card) continue;
          card.style.minHeight = viewport() + 'px';
          card.style.scrollSnapAlign = 'start';
          card.style.scrollSnapStop = 'always';
          for (let el = card.parentElement; el && el !== document.body; el = el.parentElement) {
            const style = getComputedStyle(el);
            if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
              el.style.scrollSnapType = 'y mandatory';
              break;
            }
          }
        }
      };
      apply();
      let scheduled = false;
      new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => { scheduled = false; apply(); });
      }).observe(document.documentElement, { childList: true, subtree: true });
      addEventListener('resize', apply, { passive: true });
    })()`).catch(logError('reels layout'));
  });
}
async function signedIn(id) {
  const [domain, name] = vibeSite(id).cookie;
  const cookies = await vibeSession().cookies.get({ domain, name });
  return cookies.length > 0;
}

handle('vibe:status', async () => {
  const ids = Object.keys(VIBE_SITES);
  const states = await Promise.all(ids.map(signedIn));
  return Object.fromEntries(ids.map((id, i) => [id, states[i]]));
});
// Feed pages scroll without the default scrollbar.
const hideScrollbars = wc => wc.on('dom-ready', () => {
  wc.insertCSS('::-webkit-scrollbar { display: none !important; } html { scrollbar-width: none !important; }').catch(logError('feed css'));
});
// Signing in to a feed: the site opens in a rounded view inside the Breeze window, over the renderer's blurred
// backdrop (renderer passes the frame's bounds). Resolves with the sign-in state once the renderer closes it.
let connectView = null;
let connectDone = null;
function closeConnect() {
  if (connectView) {
    win?.contentView.removeChildView(connectView);
    connectView.webContents.close();
    connectView = null;
  }
  const done = connectDone; connectDone = null; done?.();
}
handle('vibe:connect', (_e, id, bounds) => {
  const site = vibeSite(id);
  if (!win) return false;
  closeConnect();
  connectView = new WebContentsView({ webPreferences: feedPrefs() });
  connectView.setBorderRadius(14);
  connectView.setBackgroundColor('#1d1d1f');
  guardFeed(connectView.webContents);
  hideScrollbars(connectView.webContents);
  win.contentView.addChildView(connectView);
  connectView.setBounds(toBounds(bounds));
  connectView.webContents.loadURL(site.url).catch(logError('connect'));
  return new Promise(resolve => { connectDone = () => signedIn(id).then(resolve, () => resolve(false)); });
});
handle('vibe:connectBounds', (_e, bounds) => connectView?.setBounds(toBounds(bounds)));
handle('vibe:connectClose', () => closeConnect());
// Forgets the site's sign-in by removing its cookies from the feed session.
handle('vibe:disconnect', async (_e, id) => {
  const ses = vibeSession();
  const lists = await Promise.all(vibeSite(id).domains.map(domain => ses.cookies.get({ domain })));
  await Promise.all(lists.flat().map(c => ses.cookies.remove(`https://${c.domain.replace(/^\./, '')}${c.path}`, c.name)));
});
const toBounds = b => ({ x: Math.round(b.x), y: Math.round(b.y), width: Math.max(1, Math.round(b.width)), height: Math.max(1, Math.round(b.height)) });
// Lays the live feed over the renderer's 9:16 frame.
handle('vibe:show', (_e, id, bounds) => {
  const site = vibeSite(id);
  if (!win) return;
  if (!vibeView) {
    vibeView = new WebContentsView({ webPreferences: feedPrefs() });
    vibeView.setBorderRadius(16);
    vibeView.setBackgroundColor('#1d1d1f');
    guardFeed(vibeView.webContents);
    hideScrollbars(vibeView.webContents);
    win.contentView.addChildView(vibeView);
  }
  vibeView.setBounds(toBounds(bounds));
  // In a phone-shaped frame the desktop Reels pages shrink the video into a small card with empty space around it;
  // as a phone browser they get their full-bleed mobile layout. Only the feed view does this, not the sign-in window.
  vibeView.webContents.setUserAgent(mobileUserAgent(vibeSession().getUserAgent()));
  if (id === 'instagram') keepInstagramReelsFullscreen(vibeView.webContents);
  vibeView.webContents.loadURL(site.url).catch(logError('feed'));
});
handle('vibe:bounds', (_e, bounds) => vibeView?.setBounds(toBounds(bounds)));
handle('vibe:mute', (_e, muted) => vibeView?.webContents.setAudioMuted(!!muted));
// Closing the view also stops its video and sound.
handle('vibe:hide', () => {
  if (!vibeView) return;
  win?.contentView.removeChildView(vibeView);
  vibeView.webContents.close();
  vibeView = null;
});

/* ================= Discord Rich Presence ================= */
// Talks to the Discord app on this computer. It needs the id of a Discord application (made once at
// https://discord.com/developers/applications); the id is public, not a secret.
const { DiscordRpc, DiscordPresence } = require('./discord');
const DEFAULT_DISCORD_CLIENT_ID = '';
function discordClientId() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(ROOT, 'breeze.config.json'), 'utf8')); } catch { /* not configured */ }
  return String(process.env.BREEZE_DISCORD_CLIENT_ID || file.discord?.clientId || DEFAULT_DISCORD_CLIENT_ID).trim();
}
const discord = new DiscordPresence(() => new DiscordRpc(discordClientId()), { onError: logError('discord') });
const discordText = (s, max = 120) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, max) : undefined);
handle('discord:set', async (_e, a) => {
  if (!/^\d{15,22}$/.test(discordClientId())) throw new Error('Discord presence needs a Discord application id. Add "discord": { "clientId": "…" } to breeze.config.json or set BREEZE_DISCORD_CLIENT_ID.');
  const user = await discord.set({
    details: discordText(a?.details), state: discordText(a?.state), startTimestamp: Number(a?.start) || undefined,
    largeImageKey: 'breeze', largeImageText: 'Breeze Code',
  });
  return { user: user?.global_name || user?.username || null };
});
handle('discord:clear', async () => { discord.clear(); });
app.on('before-quit', () => discord.close());
