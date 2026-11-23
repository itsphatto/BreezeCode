// Measures start-up time and memory of Breeze Code against other Electron editors on this machine.
//   node scripts/bench.js [--runs 3] [--big-mb 500] [--app "Name=path/to/exe"]...
// Each editor gets its own clean profile (no extensions), opens the same TypeScript project (and, separately, one big log file),
// and is timed from spawn until the marker on the file's first line is drawn (read over CDP).
// Memory is the whole process tree after a 20 s settle: private working set on Windows (Task Manager's
// "Memory" column), RSS elsewhere. Results print as a Markdown table and are saved to reports/bench-<date>.json.
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MARKER = 'BREEZEBENCHMARKER';
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const RUNS = Number(arg('--runs', 3));
const BIG_MB = Number(arg('--big-mb', 500));
const SETTLE_MS = 20000;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-bench-'));

const WIN = process.platform === 'win32';
const LOCAL = process.env.LOCALAPPDATA || '';
function defaultApps() {
  const breeze = WIN ? path.join(ROOT, 'dist', 'win-unpacked', 'Breeze Code.exe')
    : process.platform === 'darwin' ? path.join(ROOT, 'dist', 'mac-arm64', 'Breeze Code.app', 'Contents', 'MacOS', 'Breeze Code')
    : path.join(ROOT, 'dist', 'linux-unpacked', 'breeze-code');
  const list = [{ name: 'Breeze Code', exe: breeze, kind: 'breeze' }];
  const others = WIN
    ? [['VS Code', path.join(LOCAL, 'Programs', 'Microsoft VS Code', 'Code.exe')], ['Antigravity IDE', path.join(LOCAL, 'Programs', 'Antigravity IDE', 'Antigravity IDE.exe')], ['Cursor', path.join(LOCAL, 'Programs', 'cursor', 'Cursor.exe')], ['Windsurf', path.join(LOCAL, 'Programs', 'Windsurf', 'Windsurf.exe')]]
    : process.platform === 'darwin'
      ? [['VS Code', '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'], ['Cursor', '/Applications/Cursor.app/Contents/MacOS/Cursor']]
      : [['VS Code', '/usr/share/code/code'], ['Cursor', '/usr/share/cursor/cursor']];
  for (const [name, exe] of others) list.push({ name, exe, kind: 'vscode' });
  return list;
}
function apps() {
  const extra = process.argv.flatMap((a, i) => (a === '--app' ? [process.argv[i + 1]] : []));
  const list = extra.length ? extra.map(s => { const [name, exe] = s.split('='); return { name, exe, kind: /breeze/i.test(name) ? 'breeze' : 'vscode' }; }) : defaultApps();
  return list.filter(a => fs.existsSync(a.exe));
}

// ---- the test files ----
function makeProject() {
  const dir = path.join(WORK, 'project');
  fs.mkdirSync(dir);
  for (const f of fs.readdirSync(path.join(ROOT, 'src', 'main'))) if (f.endsWith('.ts')) fs.copyFileSync(path.join(ROOT, 'src', 'main', f), path.join(dir, f));
  const file = path.join(dir, 'bench.ts');
  fs.writeFileSync(file, `// ${MARKER}\n` + fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.ts'), 'utf8'));
  return { dir, file };
}
function makeBig() {
  const dir = path.join(WORK, 'big');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'big.log');
  const line = '2026-11-23T10:00:00.000Z INFO request served path=/api/items status=200 ms=12 user=anon\n';
  const chunk = line.repeat(Math.ceil((8 << 20) / line.length));
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, `${MARKER}\n`);
  for (let written = 0; written < BIG_MB << 20; written += chunk.length) fs.writeSync(fd, chunk);
  fs.closeSync(fd);
  return { dir, file };
}

// ---- processes ----
// pid → { ppid, bytes } for every process.
function processTable() {
  const out = new Map();
  if (WIN) {
    const ps = 'Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | % { "$($_.IDProcess) $($_.CreatingProcessID) $($_.WorkingSetPrivate)" }';
    for (const l of execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)) {
      const [pid, ppid, bytes] = l.trim().split(' ').map(Number);
      if (pid) out.set(pid, { ppid, bytes });
    }
  } else {
    for (const l of execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' }).split('\n')) {
      const [pid, ppid, kb] = l.trim().split(/\s+/).map(Number);
      if (pid) out.set(pid, { ppid, bytes: kb * 1024 });
    }
  }
  return out;
}
function treeBytes(root) {
  const t = processTable();
  const pids = new Set([root]);
  for (let grew = true; grew;) { grew = false; for (const [pid, p] of t) if (!pids.has(pid) && pids.has(p.ppid)) { pids.add(pid); grew = true; } }
  let bytes = 0;
  for (const pid of pids) bytes += t.get(pid)?.bytes ?? 0;
  return { bytes, count: [...pids].filter(p => t.has(p)).length };
}
function killTree(pid) {
  try { if (WIN) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); else process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// ---- CDP ----
async function evalOn(port, expr) {
  let targets;
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { return []; }
  const results = [];
  for (const t of targets.filter(x => x.type === 'page' && x.webSocketDebuggerUrl)) {
    results.push(await new Promise(resolve => {
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      const done = v => { try { ws.close(); } catch { /* closed */ } resolve(v); };
      const timer = setTimeout(() => done(undefined), 3000);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, replMode: true } }));
      ws.onmessage = m => { const r = JSON.parse(m.data); if (r.id === 1) { clearTimeout(timer); done(r.result?.result?.value); } };
      ws.onerror = () => { clearTimeout(timer); done(undefined); };
    }));
  }
  return results;
}

let portSeq = 9400;
function launch(app, profile, targetArgs) {
  const port = portSeq++;
  const common = [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`];
  const extra = app.kind === 'vscode'
    ? [`--extensions-dir=${path.join(profile, 'ext')}`, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window']
    : ['--disable-renderer-backgrounding'];
  const child = spawn(app.exe, [...common, ...extra, ...targetArgs], { detached: !WIN, stdio: 'ignore', windowsHide: false });
  return { child, port, t0: performance.now() };
}
async function waitFor(port, expr, ms) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if ((await evalOn(port, expr)).some(Boolean)) return performance.now();
    await sleep(50);
  }
  return null;
}

// Quits through CDP so Chromium writes localStorage out (a killed process loses it), else kills after 15 s.
async function quit(child, port) {
  const exited = new Promise(r => child.once('exit', r));
  try {
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const ws = new WebSocket(webSocketDebuggerUrl);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
  } catch { /* not reachable: killed below */ }
  if (await Promise.race([exited.then(() => true), sleep(15000).then(() => false)]) === false) killTree(child.pid);
  await sleep(1500);
}
// A fresh Breeze profile starts on setup: mark it done once, so the measured runs open straight into the editor.
async function primeBreeze(app, profile, file) {
  const { child, port } = launch(app, profile, [file]);
  await waitFor(port, 'typeof appState === "object"', 60000);
  await evalOn(port, 'appState.onboarded = true; appState.termsAcceptedAt = Date.now(); appState.name = "Bench"; appState.mode = "ide"; saveApp(); true');
  await quit(child, port);
}

// One profile per editor, used by every run: run 0 creates its caches and is dropped, so the rest are warm starts.
async function measure(app, target, label, profile) {
  const runs = [];
  for (let i = 0; i <= RUNS; i++) {
    const args = app.kind === 'vscode' ? [target.dir, target.file] : [target.file];
    const { child, port, t0 } = launch(app, profile, args);
    const ready = await waitFor(port, `!!document.body && document.body.innerText.includes(${JSON.stringify(MARKER)})`, 120000);
    await sleep(SETTLE_MS);
    const samples = [];
    for (let k = 0; k < 5; k++) { samples.push(treeBytes(child.pid)); await sleep(1000); }
    killTree(child.pid);
    await sleep(2000);
    const run = { ms: ready === null ? null : Math.round(ready - t0), mb: Math.round(median(samples.map(s => s.bytes)) / 2 ** 20), processes: median(samples.map(s => s.count)) };
    console.error(`  ${app.name} · ${label} · run ${i}: ${run.ms ?? 'never drew'} ms, ${run.mb} MB, ${run.processes} processes`);
    if (i > 0) runs.push(run);
  }
  const ok = runs.filter(r => r.ms !== null);
  return { app: app.name, scenario: label, ms: ok.length ? median(ok.map(r => r.ms)) : null, mb: median(runs.map(r => r.mb)), processes: median(runs.map(r => r.processes)), runs };
}

(async () => {
  const list = apps();
  if (!list.length) { console.error('No editors found. Build Breeze first (electron-builder --dir) or pass --app "Name=path".'); process.exit(1); }
  console.error(`Workspace ${WORK}\nEditors: ${list.map(a => a.name).join(', ')}`);
  const project = makeProject();
  const big = makeBig();
  const results = [];
  for (const app of list) {
    const profile = fs.mkdtempSync(path.join(WORK, 'profile-'));
    if (app.kind === 'breeze') await primeBreeze(app, profile, project.file);
    results.push(await measure(app, project, 'TypeScript project', profile));
    results.push(await measure(app, big, `${BIG_MB} MB log file`, profile));
  }
  const machine = { os: `${os.type()} ${os.release()}`, cpu: os.cpus()[0]?.model.trim(), cores: os.cpus().length, ramGB: Math.round(os.totalmem() / 2 ** 30), node: process.version };
  const date = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'reports', `bench-${date}.json`), JSON.stringify({ date, machine, runs: RUNS, settleMs: SETTLE_MS, results }, null, 2));
  console.log(`| Editor | Scenario | Start-up to first line drawn | Memory after 20 s | Processes |\n| --- | --- | ---: | ---: | ---: |`);
  for (const r of results) console.log(`| ${r.app} | ${r.scenario} | ${r.ms === null ? "didn't draw" : (r.ms / 1000).toFixed(2) + ' s'} | ${r.mb} MB | ${r.processes} |`);
  console.log(`\n${machine.os}, ${machine.cpu}, ${machine.ramGB} GB RAM. Median of ${RUNS} warm starts after one dropped warm-up, one clean profile per editor, no extensions.`);
  fs.rmSync(WORK, { recursive: true, force: true });
})();
