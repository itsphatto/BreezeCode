const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

const WIN_EXTRA = [
  'C:\\msys64\\ucrt64\\bin',
  'C:\\msys64\\mingw64\\bin',
  'C:\\msys64\\clang64\\bin',
  'C:\\MinGW\\bin',
  'C:\\mingw64\\bin',
  'C:\\ProgramData\\mingw64\\mingw64\\bin',
];
const WINLIBS = '%LOCALAPPDATA%\\Microsoft\\WinGet\\Packages\\BrechtSanders.WinLibs*\\mingw64\\bin';
// Where the .NET SDK installs when it isn't on the PATH (installers, Homebrew, distro packages, dotnet-install script).
const DOTNET_DIRS = (platform, env) => (platform === 'win32'
  ? [env.ProgramFiles && env.ProgramFiles + '\\dotnet', env.USERPROFILE && env.USERPROFILE + '\\.dotnet']
  : ['/usr/local/share/dotnet', '/usr/share/dotnet', '/usr/lib/dotnet', '/opt/homebrew/bin', env.HOME && env.HOME + '/.dotnet']
).filter(Boolean);
// Where JDKs install when they aren't on the PATH: JAVA_HOME, then the usual vendors' folders (one `*` each, for glob).
const JDK_DIRS = (platform, env) => [
  env.JAVA_HOME && pathFor(platform).join(env.JAVA_HOME, 'bin'),
  ...(platform === 'win32'
    ? ['Java\\jdk*', 'Eclipse Adoptium\\jdk*', 'Microsoft\\jdk*', 'Zulu\\zulu*', 'Amazon Corretto\\jdk*'].map(d => env.ProgramFiles && `${env.ProgramFiles}\\${d}\\bin`)
    : platform === 'darwin'
      ? ['/opt/homebrew/opt/openjdk/bin', '/usr/local/opt/openjdk/bin', '/Library/Java/JavaVirtualMachines/*/Contents/Home/bin']
      : ['/usr/lib/jvm/*/bin']),
].filter(Boolean);
// rustup puts rustc and cargo in CARGO_HOME/bin, which is ~/.cargo/bin unless moved.
const CARGO_DIRS = (platform, env) => {
  const P = pathFor(platform);
  const home = platform === 'win32' ? env.USERPROFILE : env.HOME;
  return [env.CARGO_HOME && P.join(env.CARGO_HOME, 'bin'), home && P.join(home, '.cargo', 'bin')].filter(Boolean);
};
// Newest version first when a wildcard matches several (jdk-21 before jdk-17).
const newestFirst = (a, b) => b.localeCompare(a, undefined, { numeric: true });

// Compilers in lookup order: [C compiler, its C++ partner]
const COMPILERS = (platform) => [
  ['gcc', 'g++'],
  ['clang', 'clang++'],
  ...(platform === 'win32' ? [] : [['cc', 'c++']]),
];

async function findTools(o) {
  const { platform, pathValue, env, exists, glob, run } = o;
  const win = platform === 'win32';
  const P = pathFor(platform);
  const clean = (d) => d.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '');
  const same = (a, b) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);

  const pathDirs = (pathValue || '').split(win ? ';' : ':').map(clean).filter(Boolean);
  const dirs = [...pathDirs];
  if (win) {
    const extra = [...WIN_EXTRA];
    if (env.LOCALAPPDATA) extra.push(...glob(WINLIBS.replace('%LOCALAPPDATA%', env.LOCALAPPDATA)).map(clean));
    for (const d of extra) if (!dirs.some((x) => same(x, d))) dirs.push(d);
  }

  const file = (dir, name) => P.join(dir, win ? name + '.exe' : name);
  // First candidate that exists and passes `--version` (the Store python shortcut exits non-zero).
  const probe = async (candDirs, name, pre = []) => {
    for (const dir of candDirs) {
      const p = file(dir, name);
      if (!exists(p)) continue;
      const r = await run(p, [...pre, '--version']).catch(() => null);
      if (r && r.code === 0) return { dir, path: p, name, version: String(r.stdout || '').split(/\r?\n/)[0].trim() };
    }
    return null;
  };
  const tool = (f) => f && { path: f.path, name: f.name, version: f.version };

  let cc = null, cxx = null, ccDir = null;
  for (const [c, cpp] of COMPILERS(platform)) {
    const f = await probe(dirs, c);
    if (!f) continue;
    cc = tool(f);
    ccDir = f.dir;
    cxx = tool(await probe([f.dir], cpp));
    break;
  }

  let python = null;
  // `pip install x` then F5 should just work, but a PC can hold several Pythons (Store, python.org, MSYS2) and
  // `py -3` or `python` may not be the one `pip` installs into. So the first pip on PATH picks: whichever
  // Python imports pip from the folder that pip reports.
  const pip = await probe(pathDirs, win ? 'pip' : 'pip3');
  const pipDir = /^pip \S+ from (.+) \(python [^)]*\)$/.exec(pip?.version || '')?.[1];
  if (pipDir) {
    const OWNER = "import os, sys, pip; print(sys.executable); print(os.path.dirname(pip.__file__)); print('Python ' + sys.version.split()[0])";
    const cands = win ? [['py', ['-3']]] : [];
    for (const dir of pathDirs) {
      const names = win ? ['python', 'python3'] : ['python3', 'python'];
      for (const n of names) cands.push([file(dir, n), []]);
      // The Store install only puts versioned aliases (python3.13.exe) in WindowsApps.
      if (win) for (const g of glob(P.join(dir, 'python3.*.exe'))) cands.push([g, []]);
    }
    for (const [c, pre] of cands) {
      const p = c === 'py' ? pathDirs.map((d) => file(d, 'py')).find(exists) : c;
      if (!p || !exists(p)) continue;
      const r = await run(p, [...pre, '-c', OWNER]).catch(() => null);
      const [exe, dir, version] = r && r.code === 0 ? String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()) : [];
      if (exe && dir && same(clean(dir), clean(pipDir))) { python = { path: exe, name: 'python', version }; break; }
    }
  }
  if (!python && win) {
    const f = await probe(pathDirs, 'py', ['-3']);
    if (f) python = tool(f);
  }
  if (!python) {
    const f = await probe(pathDirs, win ? 'python' : 'python3');
    if (f) {
      const r = await run(f.path, ['-c', 'import sys; print(sys.executable)']).catch(() => null);
      const exe = r && r.code === 0 ? String(r.stdout || '').trim() : '';
      python = tool({ ...f, path: exe || f.path });
    }
  }

  // C#: the .NET SDK's `dotnet`. `dotnet --version` only exits 0 when an SDK (not just a runtime) is installed.
  const dotnetDirs = [...pathDirs];
  for (const d of DOTNET_DIRS(platform, env || {})) if (!dotnetDirs.some((x) => same(x, d))) dotnetDirs.push(d);
  const dotnet = tool(await probe(dotnetDirs, 'dotnet'));
  // Extra folders after the PATH ones; a wildcard entry expands through glob.
  const withExtra = (extra) => {
    const out = [...pathDirs];
    for (const d of extra.flatMap(x => (x.includes('*') ? glob(x).map(clean).sort(newestFirst) : [x]))) if (!out.some((x) => same(x, d))) out.push(d);
    return out;
  };

  // Java: a JDK, found by its javac (`javac --version` needs JDK 9+); java is the launcher beside it.
  let java = null;
  const jdk = await probe(withExtra(JDK_DIRS(platform, env || {})), 'javac');
  if (jdk) {
    const launcher = await probe([jdk.dir], 'java');
    if (launcher) java = { path: launcher.path, name: 'java', version: jdk.version };
  }

  // Rust: rustc compiles a lone .rs file, cargo runs a Cargo project. rustup installs both into the same folder.
  const rustDirs = withExtra(CARGO_DIRS(platform, env || {}));
  const rustc = tool(await probe(rustDirs, 'rustc'));
  const cargo = tool(await probe(rustDirs, 'cargo'));

  const binDirs = [];
  for (const t of [cc, cxx, python, dotnet, java, rustc, cargo]) {
    if (!t) continue;
    const d = P.dirname(t.path);
    if (!pathDirs.some((x) => same(x, d)) && !binDirs.some((x) => same(x, d))) binDirs.push(d);
  }
  return { cc, cxx, python, dotnet, java, rustc, cargo, binDirs };
}

async function freshPath(platform, run) {
  const fallback = () => {
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path');
    return (key && process.env[key]) || '';
  };
  if (platform !== 'win32') return process.env.PATH || '';
  try {
    const r = await run('powershell.exe', ['-NoProfile', '-Command',
      "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"]);
    const out = r && r.code === 0 ? String(r.stdout || '').trim() : '';
    return out || fallback();
  } catch {
    return fallback();
  }
}

function toolEnv(baseEnv, binDirs, platform, pathValue) {
  const env = { ...baseEnv };
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const delim = platform === 'win32' ? ';' : ':';
  const base = pathValue != null ? pathValue : env[key];
  env[key] = [...binDirs, ...(base ? [base] : [])].join(delim);
  return env;
}

// What to tell the user when a tool isn't installed. `cmd` is the single command to run, if there is one;
// `url` is a page to download it from.
const DOTNET_URL = 'https://dotnet.microsoft.com/download';
const JDK_URL = 'https://adoptium.net';
const RUST_URL = 'https://rustup.rs';
const MISSING = {
  c: {
    win32: { lead: 'No C/C++ compiler found. Install one with:', cmd: 'winget install BrechtSanders.WinLibs.POSIX.UCRT' },
    darwin: { lead: 'No C/C++ compiler found. Install one with:', cmd: 'xcode-select --install' },
    other: { lead: 'No C/C++ compiler found. Install gcc with your package manager (e.g. sudo apt install build-essential)' },
  },
  py: {
    win32: { lead: "Python wasn't found. Install it with:", cmd: 'winget install Python.Python.3.13' },
    darwin: { lead: "Python wasn't found. Install it with:", cmd: 'xcode-select --install' },
    other: { lead: "Python wasn't found. Install python3 with your package manager" },
  },
  cs: {
    win32: { lead: 'No C# compiler found. Install the .NET SDK with:', cmd: 'winget install Microsoft.DotNet.SDK.10', url: DOTNET_URL },
    darwin: { lead: 'No C# compiler found. Install the .NET SDK with:', cmd: 'brew install --cask dotnet-sdk', url: DOTNET_URL },
    other: { lead: 'No C# compiler found. Install the .NET SDK with your package manager', url: 'https://learn.microsoft.com/dotnet/core/install/linux' },
  },
  java: {
    win32: { lead: 'No Java JDK found. Install one with:', cmd: 'winget install Microsoft.OpenJDK.21', url: JDK_URL },
    darwin: { lead: 'No Java JDK found. Install one with:', cmd: 'brew install openjdk', url: JDK_URL },
    other: { lead: 'No Java JDK found. Install a JDK with your package manager (e.g. sudo apt install openjdk-21-jdk)', url: JDK_URL },
  },
  rs: {
    win32: { lead: 'No Rust compiler found. Install Rust with:', cmd: 'winget install Rustlang.Rustup', url: RUST_URL },
    darwin: { lead: 'No Rust compiler found. Install Rust with rustup', url: RUST_URL },
    other: { lead: 'No Rust compiler found. Install Rust with rustup', url: RUST_URL },
  },
};
const entry = (kind, platform) => MISSING[kind][platform] || MISSING[kind].other;
// The lead and command, then the download page when there is one.
const download = (m) => (m.url ? `\n${m.cmd ? 'Or download it from' : 'Download it from'} ${m.url}` : '');
const missing = (kind, platform) => { const m = entry(kind, platform); return (m.cmd ? m.lead + '\n' + m.cmd : m.lead) + download(m); };
// Short install hint for the tools list: the command, or the plain advice where there is none.
const installHint = (kind, platform) => { const m = entry(kind, platform); return m.cmd || m.lead; };
const installCmd = (kind, platform) => entry(kind, platform).cmd || null;
// The download page for the tools list's "Get" button, if there is one.
const installUrl = (kind, platform) => entry(kind, platform).url || null;

// PATH entries: `fresh` first, then those of `inherited` that `fresh` lacks (case-insensitive on Windows, trailing separators ignored).
function mergePath(fresh, inherited, platform) {
  const win = platform === 'win32';
  const delim = win ? ';' : ':';
  const norm = (d) => { const c = d.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, ''); return win ? c.toLowerCase() : c; };
  const seen = new Set();
  const out = [];
  for (const d of [...(fresh || '').split(delim), ...(inherited || '').split(delim)]) {
    const k = norm(d);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(d.trim());
  }
  return out.join(delim);
}

// `opts.csproj` is the nearest .csproj at or above a .cs file, and `opts.cargoToml` the nearest Cargo.toml at or
// above a .rs file, if any (main.js looks them up).
function runPlan(absFile, tools, platform, stdioHeader, opts = {}) {
  const P = pathFor(platform);
  const cwd = P.dirname(absFile);
  const { name, ext, base } = P.parse(absFile);
  const e = ext.toLowerCase();

  if (e === '.cs') {
    const dn = tools.dotnet;
    if (!dn) return { error: missing('cs', platform) };
    const env = { DOTNET_NOLOGO: '1' };
    // Inside a project, run the project: it builds every .cs file in it.
    if (opts.csproj) {
      return { steps: [{ display: `dotnet run --project "${P.basename(opts.csproj)}"`, file: dn.path, args: ['run', '--project', opts.csproj], cwd: P.dirname(opts.csproj), env }] };
    }
    // A lone .cs file runs as a file-based app, which needs the .NET 10 SDK or newer.
    const major = Number(/^(\d+)\./.exec(dn.version)?.[1] || 0);
    if (major && major < 10) {
      const m = entry('cs', platform);
      return { error: `.NET SDK ${dn.version} can't run a single .cs file; that needs .NET 10 or newer.` +
        (m.cmd ? `\nUpdate with:\n${m.cmd}` : '') + download(m) + '\nOr make this folder a project with: dotnet new console' };
    }
    return { steps: [{ display: `dotnet run "${base}"`, file: dn.path, args: ['run', absFile], cwd, env }] };
  }

  if (e === '.py') {
    const py = tools.python;
    if (!py) return { error: missing('py', platform) };
    const pre = py.name === 'py' ? ['-3'] : [];
    return {
      // UTF-8 so print("café ✓") works when stdout is a pipe on a non-UTF-8 Windows code page
      steps: [{ display: `${py.name} ${[...pre, '-u'].join(' ')} "${base}"`, file: py.path, args: [...pre, '-u', absFile], cwd, env: { PYTHONUTF8: '1' } }],
    };
  }

  const out = P.join('build', name + (platform === 'win32' ? '.exe' : ''));
  const runOut = { display: platform === 'win32' ? out : './' + out, file: P.join(cwd, out), args: [], cwd };

  if (e === '.java') {
    const java = tools.java;
    if (!java) return { error: missing('java', platform) };
    // `java File.java` compiles and runs in one go (the source launcher), which needs JDK 11 or newer.
    const major = Number(/(\d+)(?:\.\d+)*/.exec(java.version)?.[1] || 0);
    if (major && major < 11) {
      const m = entry('java', platform);
      return { error: `${java.version} can't run a .java file directly; that needs JDK 11 or newer.` + (m.cmd ? `\nUpdate with:\n${m.cmd}` : '') + download(m) };
    }
    return {
      // UTF-8 so System.out.println("café ✓") survives the pipe on a non-UTF-8 Windows code page
      steps: [{ display: `java "${base}"`, file: java.path, args: ['-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', absFile], cwd }],
    };
  }

  if (e === '.rs') {
    // Inside a Cargo project, run the project: it builds every file and dependency in it.
    if (opts.cargoToml) {
      if (!tools.cargo) return { error: missing('rs', platform) };
      return { steps: [{ display: 'cargo run', file: tools.cargo.path, args: ['run'], cwd: P.dirname(opts.cargoToml) }] };
    }
    const rustc = tools.rustc;
    if (!rustc) return { error: missing('rs', platform) };
    const flags = ['--edition', '2021', '-g'];
    return {
      steps: [
        { display: `rustc "${base}" -o "${out}" ${flags.join(' ')}`, file: rustc.path, args: [absFile, '-o', out, ...flags], cwd },
        runOut,
      ],
    };
  }

  const cpp = ['.cpp', '.cc', '.cxx'].includes(e);
  if (e !== '.c' && !cpp) return { error: 'Breeze can run .c, .cpp, .cs, .java, .py and .rs files' };
  const compiler = cpp ? tools.cxx : tools.cc;
  if (!compiler) return { error: missing('c', platform) };

  const std = cpp ? '-std=c++20' : '-std=c17';
  const flags = [std, '-Wall', '-g'];
  return {
    steps: [
      {
        display: `${compiler.name} "${base}" -o "${out}" ${flags.join(' ')}`,
        file: compiler.path,
        args: [absFile, '-o', out, ...flags, '-include', stdioHeader],
        cwd,
      },
      runOut,
    ],
  };
}

function runSteps(steps, { spawn, env, onStart, onData, onChild, onDone }) {
  let child = null;
  let cancelled = false;
  let finished = false;
  let t0 = 0;

  const finish = (code) => {
    if (finished) return;
    finished = true;
    onDone(code, Date.now() - t0);
  };

  const next = (i) => {
    if (cancelled) return finish(null);
    const step = steps[i];
    onStart(step);
    if (!t0) t0 = Date.now();
    let settled = false;
    const end = (code) => {
      if (settled) return;
      settled = true;
      for (const d of decoders) { const rest = d.end(); if (rest) onData(rest); }
      if (cancelled) finish(null);
      else if (code !== 0 || i === steps.length - 1) finish(code);
      else next(i + 1);
    };
    child = spawn(step.file, step.args, { cwd: step.cwd, env: step.env ? { ...env, ...step.env } : env, windowsHide: true });
    onChild(child);
    // one decoder per stream so a multi-byte character split across chunks stays whole
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    child.stdout.on('data', (b) => onData(decoders[0].write(b)));
    child.stderr.on('data', (b) => onData(decoders[1].write(b)));
    child.on('error', (err) => {
      if (settled) return;
      onData(err.message + '\n');
      settled = true;
      finish(-1);
    });
    child.on('close', end);
  };

  if (steps.length) next(0);
  else finish(0);

  return {
    cancel() {
      cancelled = true;
      if (child) child.kill();
    },
  };
}

// Outside programs (gcc reading the -include header) can't see into the packaged app's asar archive, so
// electron-builder unpacks those files next to it (asarUnpack in package.json). In development nothing changes.
const unpacked = (p) => p.replace(/([\\/])app\.asar(?=[\\/])/, '$1app.asar.unpacked');

function ensureBuildIgnored(rootDir) {
  const file = path.join(rootDir, '.gitignore');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  if (text.split(/\r?\n/).some((l) => ['build', 'build/', '/build/'].includes(l.trim()))) return;
  fs.appendFileSync(file, (text === '' || text.endsWith('\n') ? '' : '\n') + 'build/\n');
}

module.exports = { findTools, freshPath, toolEnv, runPlan, runSteps, ensureBuildIgnored, mergePath, installHint, installCmd, installUrl, unpacked };
