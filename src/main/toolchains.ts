import * as fs from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ChildProcess } from 'node:child_process';

export interface Tool { path: string; name: string; version: string }
const TOOL_KEYS = ['cc', 'cxx', 'gdb', 'python', 'dotnet', 'java', 'rustc', 'cargo', 'node', 'lua', 'php', 'sqlite', 'go', 'ruby', 'kotlinc', 'swiftc', 'dart', 'zig', 'scala', 'elixir', 'runghc', 'rscript', 'perl', 'groovy'] as const;
export type ToolKey = typeof TOOL_KEYS[number];
export type Tools = Record<ToolKey, Tool | null> & { binDirs: string[] };
// What a program run returns: the exit code (null if it never ran) and what it printed.
export interface RunResult { code: number | null; stdout?: string }
export type RunFn = (file: string, args: string[]) => Promise<RunResult | null>;
type Env = Record<string, string | undefined>;
export interface FindOptions {
  platform: string; pathValue?: string; env?: Env;
  exists: (p: string) => boolean; glob: (pattern: string) => string[]; run: RunFn;
}
// One program to run: what to show, the file and arguments, and where and how.
export interface Step {
  display: string; file: string; args: string[]; cwd?: string; env?: Record<string, string>; shell?: boolean; mkdir?: string; cargo?: boolean;
}
export type Plan = { error: string; steps?: undefined } | { steps: Step[]; error?: undefined };
export interface DebugPlan {
  error?: string; steps?: Step[]; exe?: string | null; entry?: string | null; cpp?: boolean;
}
interface PlanOpts { csproj?: string | null; cargoToml?: string | null }
interface MissingEntry { lead: string; cmd?: string | null; url?: string }

const pathFor = (platform: string) => (platform === 'win32' ? path.win32 : path.posix);

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
const DOTNET_DIRS = (platform: string, env: Env): string[] => (platform === 'win32'
  ? [env.ProgramFiles && env.ProgramFiles + '\\dotnet', env.USERPROFILE && env.USERPROFILE + '\\.dotnet']
  : ['/usr/local/share/dotnet', '/usr/share/dotnet', '/usr/lib/dotnet', '/opt/homebrew/bin', env.HOME && env.HOME + '/.dotnet']
).filter(Boolean) as string[];
// Where JDKs install when they aren't on the PATH: JAVA_HOME, then the usual vendors' folders (one `*` each, for glob).
const JDK_DIRS = (platform: string, env: Env): string[] => [
  env.JAVA_HOME && pathFor(platform).join(env.JAVA_HOME, 'bin'),
  ...(platform === 'win32'
    ? ['Java\\jdk*', 'Eclipse Adoptium\\jdk*', 'Microsoft\\jdk*', 'Zulu\\zulu*', 'Amazon Corretto\\jdk*'].map(d => env.ProgramFiles && `${env.ProgramFiles}\\${d}\\bin`)
    : platform === 'darwin'
      ? ['/opt/homebrew/opt/openjdk/bin', '/usr/local/opt/openjdk/bin', '/Library/Java/JavaVirtualMachines/*/Contents/Home/bin']
      : ['/usr/lib/jvm/*/bin']),
].filter(Boolean) as string[];
// rustup puts rustc and cargo in CARGO_HOME/bin, which is ~/.cargo/bin unless moved.
const CARGO_DIRS = (platform: string, env: Env): string[] => {
  const P = pathFor(platform);
  const home = platform === 'win32' ? env.USERPROFILE : env.HOME;
  return [env.CARGO_HOME && P.join(env.CARGO_HOME, 'bin'), home && P.join(home, '.cargo', 'bin')].filter(Boolean) as string[];
};
// Node strips TypeScript types without moving positions from 22.18 (23.6 on the 23 line).
function nodeSupportsTs(version: unknown): boolean {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(version || ''));
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  if (major >= 24) return true;
  if (major === 23) return minor >= 6;
  if (major === 22) return minor >= 18;
  return false;
}
// Newest version first when a wildcard matches several (jdk-21 before jdk-17).
const newestFirst = (a: string, b: string) => b.localeCompare(a, undefined, { numeric: true });

// Compilers in lookup order: [C compiler, its C++ partner]
const COMPILERS = (platform: string): string[][] => [
  ['gcc', 'g++'],
  ['clang', 'clang++'],
  ...(platform === 'win32' ? [] : [['cc', 'c++']]),
];

async function findTools(o: FindOptions): Promise<Tools> {
  const { platform, pathValue, env, exists, glob, run } = o;
  const win = platform === 'win32';
  const P = pathFor(platform);
  const clean = (d: string) => d.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '');
  const same = (a: string, b: string) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);

  const pathDirs = (pathValue || '').split(win ? ';' : ':').map(clean).filter(Boolean);
  const dirs = [...pathDirs];
  if (win) {
    const extra = [...WIN_EXTRA];
    if (env?.LOCALAPPDATA) extra.push(...glob(WINLIBS.replace('%LOCALAPPDATA%', env.LOCALAPPDATA)).map(clean));
    for (const d of extra) if (!dirs.some((x) => same(x, d))) dirs.push(d);
  }

  const file = (dir: string, name: string) => P.join(dir, win ? name + '.exe' : name);
  // First candidate that exists and passes `--version` (the Store python shortcut exits non-zero).
  // Lua has no --version; it takes -v.
  const probe = async (candDirs: string[], name: string, pre: string[] = [], flag = '--version'): Promise<(Tool & { dir: string }) | null> => {
    for (const dir of candDirs) {
      const p = file(dir, name);
      if (!exists(p)) continue;
      const r = await run(p, [...pre, flag]).catch(() => null);
      if (r && r.code === 0) return { dir, path: p, name, version: String(r.stdout || '').split(/\r?\n/)[0].trim() };
    }
    return null;
  };
  const tool = (f: Tool | null): Tool | null => f && { path: f.path, name: f.name, version: f.version };

  let cc: Tool | null = null, cxx: Tool | null = null, ccDir: string | null = null;
  for (const [c, cpp] of COMPILERS(platform)) {
    const f = await probe(dirs, c);
    if (!f) continue;
    cc = tool(f);
    ccDir = f.dir;
    cxx = tool(await probe([f.dir], cpp));
    break;
  }
  // GDB debugs C, C++ and Rust (debugGdb.js); MinGW-w64 builds put it beside gcc.
  const gdb = tool(await probe(ccDir ? [ccDir, ...dirs] : dirs, 'gdb'));

  let python: Tool | null = null;
  // `pip install x` then F5 should just work, but a PC can hold several Pythons (Store, python.org, MSYS2) and
  // `py -3` or `python` may not be the one `pip` installs into. So the first pip on PATH picks: whichever
  // Python imports pip from the folder that pip reports.
  const pip = await probe(pathDirs, win ? 'pip' : 'pip3');
  const pipDir = /^pip \S+ from (.+) \(python [^)]*\)$/.exec(pip?.version || '')?.[1];
  if (pipDir) {
    const OWNER = "import os, sys, pip; print(sys.executable); print(os.path.dirname(pip.__file__)); print('Python ' + sys.version.split()[0])";
    const cands: [string, string[]][] = win ? [['py', ['-3']]] : [];
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
      const [exe, dir, version]: (string | undefined)[] = r && r.code === 0 ? String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()) : [];
      if (exe && dir && same(clean(dir), clean(pipDir))) { python = { path: exe, name: 'python', version: version ?? '' }; break; }
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
  const withExtra = (extra: string[]) => {
    const out = [...pathDirs];
    for (const d of extra.flatMap(x => (x.includes('*') ? glob(x).map(clean).sort(newestFirst) : [x]))) if (!out.some((x) => same(x, d))) out.push(d);
    return out;
  };

  // Java: a JDK, found by its javac (`javac --version` needs JDK 9+); java is the launcher beside it.
  let java: Tool | null = null;
  const jdk = await probe(withExtra(JDK_DIRS(platform, env || {})), 'javac');
  if (jdk) {
    const launcher = await probe([jdk.dir], 'java');
    if (launcher) java = { path: launcher.path, name: 'java', version: jdk.version };
  }

  // Rust: rustc compiles a lone .rs file, cargo runs a Cargo project. rustup installs both into the same folder.
  const rustDirs = withExtra(CARGO_DIRS(platform, env || {}));
  const rustc = tool(await probe(rustDirs, 'rustc'));
  const cargo = tool(await probe(rustDirs, 'cargo'));

  // JavaScript and TypeScript: Node runs both (TypeScript by stripping its types).
  const node = tool(await probe(pathDirs, 'node'));

  // Lua goes by several names (lua5.4 on Linux, lua54 in some Windows builds), with LuaJIT as a fallback.
  let lua: Tool | null = null;
  for (const n of ['lua', 'lua5.4', 'lua54', 'lua5.3', 'luajit']) if ((lua = tool(await probe(pathDirs, n, [], '-v')))) break;
  const php = tool(await probe(pathDirs, 'php'));
  // SQL runs in SQLite's shell, against an in-memory database.
  const sqlite = tool(await probe(pathDirs, 'sqlite3'));

  // Some Windows installs launch through a batch file (kotlinc.bat, elixir.bat, groovy.bat). Those can't run
  // without cmd.exe, so they're found by name alone and runPlan runs them through it.
  const script = (candDirs: string[], name: string): Tool | null => {
    if (!win) return null;
    for (const dir of candDirs) for (const x of ['.bat', '.cmd']) { const p = P.join(dir, name + x); if (exists(p)) return { path: p, name, version: '' }; }
    return null;
  };
  const find = async (candDirs: string[], names: string[], flag = '--version'): Promise<Tool | null> => {
    for (const n of names) { const t = tool(await probe(candDirs, n, [], flag)) || script(candDirs, n); if (t) return t; }
    return null;
  };
  const extra = (list: string[]) => withExtra(win ? list : []);
  const go = await find(extra(['C:\\Program Files\\Go\\bin']), ['go'], 'version');
  const ruby = await find(extra(['C:\\Ruby*\\bin']), ['ruby']);
  const kotlinc = await find(pathDirs, ['kotlinc']);
  const swiftc = await find(pathDirs, ['swiftc']);
  const dart = await find(pathDirs, ['dart']);
  const zig = await find(pathDirs, ['zig'], 'version');
  const scala = await find(pathDirs, ['scala-cli', 'scala']);
  const elixir = await find(pathDirs, ['elixir']);
  const runghc = await find(extra(['C:\\ghcup\\bin']), ['runghc']);
  const rscript = await find(extra(['C:\\Program Files\\R\\R-*\\bin']), ['Rscript']);
  const perl = await find(extra(['C:\\Strawberry\\perl\\bin']), ['perl']);
  const groovy = await find(pathDirs, ['groovy']);

  const binDirs: string[] = [];
  for (const t of [cc, cxx, gdb, python, dotnet, java, rustc, cargo, node, lua, php, sqlite, go, ruby, kotlinc, swiftc, dart, zig, scala, elixir, runghc, rscript, perl, groovy]) {
    if (!t) continue;
    const d = P.dirname(t.path);
    if (!pathDirs.some((x) => same(x, d)) && !binDirs.some((x) => same(x, d))) binDirs.push(d);
  }
  return { cc, cxx, gdb, python, dotnet, java, rustc, cargo, node, lua, php, sqlite, go, ruby, kotlinc, swiftc, dart, zig, scala, elixir, runghc, rscript, perl, groovy, binDirs };
}

async function freshPath(platform: string, run: RunFn): Promise<string> {
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

function toolEnv(baseEnv: Env, binDirs: string[], platform: string, pathValue?: string | null): Env {
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
const GIT_URL = 'https://git-scm.com/downloads';
const NODE_URL = 'https://nodejs.org/en/download';
const LUA_URL = 'https://www.lua.org/download.html';
const PHP_URL = 'https://www.php.net/downloads';
const SQLITE_URL = 'https://sqlite.org/download.html';
const MISSING: Record<string, Record<string, MissingEntry>> = {
  git: {
    win32: { lead: "Git wasn't found. Install it with:", cmd: 'winget install Git.Git', url: GIT_URL },
    darwin: { lead: "Git wasn't found. Install it with:", cmd: 'xcode-select --install', url: GIT_URL },
    other: { lead: 'Install git with your package manager (e.g. sudo apt install git)', url: GIT_URL },
  },
  node: {
    win32: { lead: "Node.js wasn't found. Install it with:", cmd: 'winget install OpenJS.NodeJS.LTS', url: NODE_URL },
    darwin: { lead: "Node.js wasn't found. Install it with:", cmd: 'brew install node', url: NODE_URL },
    other: { lead: 'Install Node.js with your package manager', url: NODE_URL },
  },
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
  lua: {
    win32: { lead: "Lua wasn't found. Install it with:", cmd: 'winget install DEVCOM.Lua', url: LUA_URL },
    darwin: { lead: "Lua wasn't found. Install it with:", cmd: 'brew install lua', url: LUA_URL },
    other: { lead: 'Install Lua with your package manager (e.g. sudo apt install lua5.4)', url: LUA_URL },
  },
  php: {
    win32: { lead: "PHP wasn't found. Install it with:", cmd: 'winget install PHP.PHP.8.5', url: PHP_URL },
    darwin: { lead: "PHP wasn't found. Install it with:", cmd: 'brew install php', url: PHP_URL },
    other: { lead: 'Install PHP with your package manager (e.g. sudo apt install php-cli)', url: PHP_URL },
  },
  sql: {
    win32: { lead: "SQLite wasn't found. Install it with:", cmd: 'winget install SQLite.SQLite', url: SQLITE_URL },
    darwin: { lead: "SQLite wasn't found. Install it with:", cmd: 'brew install sqlite', url: SQLITE_URL },
    other: { lead: 'Install SQLite with your package manager (e.g. sudo apt install sqlite3)', url: SQLITE_URL },
  },
  ...langMissing(),
};
// The other languages' compilers and interpreters: name, download page, and the install command on Windows and macOS
// where there is one. Elsewhere, the package manager.
function langMissing(): Record<string, Record<string, MissingEntry>> {
  const LANG: Record<string, [string, string, string | null, string | null]> = {
    go: ['Go', 'https://go.dev/dl/', 'winget install GoLang.Go', 'brew install go'],
    rb: ['Ruby', 'https://www.ruby-lang.org/en/downloads/', 'winget install RubyInstallerTeam.Ruby.3.3', 'brew install ruby'],
    kt: ['Kotlin', 'https://kotlinlang.org/docs/command-line.html', null, 'brew install kotlin'],
    swift: ['Swift', 'https://www.swift.org/install/', 'winget install Swift.Toolchain', 'xcode-select --install'],
    dart: ['Dart', 'https://dart.dev/get-dart', null, 'brew install dart-lang/dart/dart'],
    zig: ['Zig', 'https://ziglang.org/download/', 'winget install zig.zig', 'brew install zig'],
    scala: ['Scala', 'https://www.scala-lang.org/download/', null, 'brew install Virtuslab/scala-cli/scala-cli'],
    ex: ['Elixir', 'https://elixir-lang.org/install.html', null, 'brew install elixir'],
    hs: ['Haskell', 'https://www.haskell.org/ghcup/', null, 'brew install ghc'],
    r: ['R', 'https://cran.r-project.org/', 'winget install RProject.R', 'brew install r'],
    pl: ['Perl', 'https://www.perl.org/get.html', 'winget install StrawberryPerl.StrawberryPerl', null],
    groovy: ['Groovy', 'https://groovy.apache.org/download.html', null, 'brew install groovy'],
  };
  const one = (name: string, url: string, cmd: string | null, other?: boolean): MissingEntry => (cmd ? { lead: `${name} wasn't found. Install it with:`, cmd, url } : { lead: `${name} wasn't found.${other ? ' Install it with your package manager' : ''}`, url });
  return Object.fromEntries(Object.entries(LANG).map(([kind, [name, url, win, mac]]) =>
    [kind, { win32: one(name, url, win), darwin: one(name, url, mac), other: one(name, url, null, true) }]));
}
// The kinds of tool the Tools list shows an install button for (main.js allows only their commands).
const LANG_KINDS = ['go', 'rb', 'kt', 'swift', 'dart', 'zig', 'scala', 'ex', 'hs', 'r', 'pl', 'groovy'];
const entry = (kind: string, platform: string): MissingEntry => MISSING[kind][platform] || MISSING[kind].other;
// The lead and command, then the download page when there is one.
const download = (m: MissingEntry) => (m.url ? `\n${m.cmd ? 'Or download it from' : 'Download it from'} ${m.url}` : '');
const missing = (kind: string, platform: string) => { const m = entry(kind, platform); return (m.cmd ? m.lead + '\n' + m.cmd : m.lead) + download(m); };
// Short install hint for the tools list: the command, or the plain advice where there is none.
const installHint = (kind: string, platform: string) => { const m = entry(kind, platform); return m.cmd || m.lead; };
const installCmd = (kind: string, platform: string) => entry(kind, platform).cmd || null;
// The download page for the tools list's "Get" button, if there is one.
const installUrl = (kind: string, platform: string) => entry(kind, platform).url || null;

// PATH entries: `fresh` first, then those of `inherited` that `fresh` lacks (case-insensitive on Windows, trailing separators ignored).
function mergePath(fresh: string | null | undefined, inherited: string | null | undefined, platform: string): string {
  const win = platform === 'win32';
  const delim = win ? ';' : ':';
  const norm = (d: string) => { const c = d.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, ''); return win ? c.toLowerCase() : c; };
  const seen = new Set();
  const out: string[] = [];
  for (const d of [...(fresh || '').split(delim), ...(inherited || '').split(delim)]) {
    const k = norm(d);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(d.trim());
  }
  return out.join(delim);
}

// Files that run in one step: extension → [findTools key, install kind, arguments before the file].
const ONE_STEP: Record<string, [ToolKey, string, string[]]> = {
  '.go': ['go', 'go', ['run']], '.rb': ['ruby', 'rb', []], '.dart': ['dart', 'dart', ['run']], '.zig': ['zig', 'zig', ['run']],
  '.scala': ['scala', 'scala', ['run']], '.sc': ['scala', 'scala', ['run']], '.ex': ['elixir', 'ex', []], '.exs': ['elixir', 'ex', []],
  '.hs': ['runghc', 'hs', []], '.r': ['rscript', 'r', []], '.pl': ['perl', 'pl', []], '.groovy': ['groovy', 'groovy', []],
  '.kts': ['kotlinc', 'kt', ['-script']],
};
// Windows can only start a .bat/.cmd launcher through cmd.exe. Each part goes in quotes, which keeps spaces, & and
// parentheses literal; cmd still expands % inside quotes and a " would end them, so a path with either is refused.
function viaCmd(step: Step, platform: string): Step | { error: string } {
  if (platform !== 'win32' || !/\.(?:bat|cmd)$/i.test(step.file)) return step;
  const parts = [step.file, ...step.args];
  const bad = parts.find((p) => /["%\r\n]/.test(p));
  if (bad != null) return { error: `Breeze can't pass ${bad} to ${path.win32.basename(step.file)} through cmd.exe: it has a % or " in it. Rename it and run again.` };
  return { display: step.display, file: parts.map((p) => `"${p}"`).join(' '), args: [], cwd: step.cwd, ...(step.env ? { env: step.env } : {}), shell: true };
}

// `opts.csproj` is the nearest .csproj at or above a .cs file, and `opts.cargoToml` the nearest Cargo.toml at or
// above a .rs file, if any (main.js looks them up).
function runPlan(absFile: string, tools: Tools, platform: string, stdioHeader: string, opts: PlanOpts = {}): Plan {
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

  if (/^\.[cm]?[jt]s$/.test(e)) {
    const node = tools.node;
    if (!node) return { error: missing('node', platform) };
    if (e.endsWith('ts') && !nodeSupportsTs(node.version)) {
      const m = entry('node', platform);
      return { error: `Node ${node.version} can't run a TypeScript file; that needs Node 22.18 or newer.` + (m.cmd ? `\nUpdate with:\n${m.cmd}` : '') + download(m) };
    }
    return { steps: [{ display: `node "${base}"`, file: node.path, args: [absFile], cwd }] };
  }

  if (e === '.lua') {
    if (!tools.lua) return { error: missing('lua', platform) };
    return { steps: [{ display: `${tools.lua.name} "${base}"`, file: tools.lua.path, args: [absFile], cwd }] };
  }

  if (e === '.php') {
    if (!tools.php) return { error: missing('php', platform) };
    return { steps: [{ display: `php "${base}"`, file: tools.php.path, args: [absFile], cwd }] };
  }

  // A fresh in-memory database each run: CREATE TABLE, INSERT and SELECT in one file just work. Results print as
  // boxed tables, and -bail stops at the first error rather than running the rest against a half-built database.
  if (e === '.sql') {
    if (!tools.sqlite) return { error: missing('sql', platform) };
    // Just the file name (it runs from its folder), so there are no folder backslashes for the shell to unescape.
    const read = `.read "${base}"`;
    return { steps: [{ display: `sqlite3 -bail -box :memory: '${read}'`, file: tools.sqlite.path, args: ['-bail', '-box', ':memory:', read], cwd }] };
  }

  const out = P.join('build', name + (platform === 'win32' ? '.exe' : ''));
  const runOut = { display: platform === 'win32' ? out : './' + out, file: P.join(cwd, out), args: [], cwd };

  // Batch-file launchers run through cmd.exe (viaCmd); a step that can't be passed safely fails the plan.
  const plan = (...steps: Step[]): Plan => {
    const s = steps.map((x) => viaCmd(x, platform));
    const bad = s.find((x): x is { error: string } => 'error' in x);
    return bad ? { error: bad.error } : { steps: s as Step[] };
  };
  const script = ONE_STEP[e];
  if (script) {
    const [key, kind, pre] = script;
    const t = tools[key];
    if (!t) return { error: missing(kind, platform) };
    return plan({ display: [t.name, ...pre, `"${base}"`].join(' '), file: t.path, args: [...pre, absFile], cwd });
  }
  // Kotlin: kotlinc builds a jar with the Kotlin runtime inside, and the JDK's java runs it.
  if (e === '.kt') {
    if (!tools.kotlinc) return { error: missing('kt', platform) };
    if (!tools.java) return { error: missing('java', platform) };
    const jar = P.join('build', name + '.jar');
    return plan(
      { display: `kotlinc "${base}" -include-runtime -d "${jar}"`, file: tools.kotlinc.path, args: [absFile, '-include-runtime', '-d', jar], cwd },
      { display: `java -jar "${jar}"`, file: tools.java.path, args: ['-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', '-jar', jar], cwd },
    );
  }
  if (e === '.swift') {
    if (!tools.swiftc) return { error: missing('swift', platform) };
    return plan({ display: `swiftc "${base}" -o "${out}"`, file: tools.swiftc.path, args: [absFile, '-o', out], cwd }, runOut);
  }

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
  if (e !== '.c' && !cpp) return { error: 'Breeze can run .c, .cpp, .cs, .dart, .ex, .exs, .go, .groovy, .hs, .java, .js, .kt, .kts, .lua, .php, .pl, .py, .r, .rb, .rs, .sc, .scala, .sql, .swift, .ts and .zig files' };
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

// How the debugger builds a C, C++ or Rust file: like runPlan, with no optimising and with `debugHeader`
// (runtime/breeze_debug.h), which holds the program before main until GDB attaches. Returns { steps, exe, entry, cpp }
// (`entry` is the function "stop on entry" stops at) or { error }.
function debugPlan(absFile: string, tools: Tools, platform: string, { stdioHeader, debugHeader }: { stdioHeader: string; debugHeader: string }, opts: PlanOpts = {}): DebugPlan {
  const P = pathFor(platform);
  const cwd = P.dirname(absFile);
  const { name, ext, base } = P.parse(absFile);
  const e = ext.toLowerCase();
  const exe = P.join(cwd, 'build', name + (platform === 'win32' ? '.exe' : ''));

  if (e === '.rs') {
    // Rust can't take a header: the wait is a small C object linked into the program, which needs GCC.
    if (!tools.cc) return { error: 'Debugging Rust needs GCC and GDB (MinGW-w64, from MSYS2 or WinLibs) next to Rust' };
    const waitObj = P.join(opts.cargoToml ? P.dirname(opts.cargoToml) : cwd, opts.cargoToml ? 'target' : 'build', 'breeze_debug.o');
    const wait = { display: `${tools.cc.name} -c breeze_debug.h`, file: tools.cc.path, args: ['-c', '-x', 'c', debugHeader, '-o', waitObj], cwd };
    // kernel32 again after the object: the linker reads libraries once, in order, and rustc lists them before it.
    const link = ['-C', `link-arg=${waitObj}`, '-C', 'link-arg=-lkernel32'];
    if (opts.cargoToml) {
      if (!tools.cargo) return { error: missing('rs', platform) };
      const dir = P.dirname(opts.cargoToml);
      // The encoded form keeps a path with spaces whole (RUSTFLAGS splits on them).
      const env = { CARGO_ENCODED_RUSTFLAGS: link.join('\x1f') };
      return {
        steps: [
          { ...wait, mkdir: P.dirname(waitObj) },
          { display: 'cargo build', file: tools.cargo.path, args: ['build', '--message-format=json-render-diagnostics'], cwd: dir, env, cargo: true },
        ],
        exe: null, entry: null, cpp: false,
      };
    }
    if (!tools.rustc) return { error: missing('rs', platform) };
    const crate = name.replace(/\W/g, '_');
    const flags = ['--edition', '2021', '-g', '-C', 'opt-level=0', ...link];
    return {
      steps: [
        { ...wait, mkdir: P.dirname(waitObj) },
        { display: `rustc "${base}" -o "${P.join('build', P.basename(exe))}" -g`, file: tools.rustc.path, args: [absFile, '-o', exe, ...flags], cwd },
      ],
      exe, entry: `${crate}::main`, cpp: false,
    };
  }

  const cpp = ['.cpp', '.cc', '.cxx'].includes(e);
  if (e !== '.c' && !cpp) return { error: 'Breeze can debug .c, .cpp and .rs files this way' };
  const compiler = cpp ? tools.cxx : tools.cc;
  if (!compiler) return { error: missing('c', platform) };
  const flags = [cpp ? '-std=c++20' : '-std=c17', '-Wall', '-g', '-O0', ...(/clang/i.test(compiler.name) ? ['-gdwarf-4'] : [])];
  return {
    steps: [{
      display: `${compiler.name} "${base}" -o "${P.join('build', P.basename(exe))}" ${flags.join(' ')}`,
      file: compiler.path, args: [absFile, '-o', exe, ...flags, '-include', stdioHeader, '-include', debugHeader], cwd, mkdir: P.dirname(exe),
    }],
    exe, entry: 'main', cpp,
  };
}

interface RunStepsOptions {
  spawn: (file: string, args: string[], options: Record<string, unknown>) => ChildProcess;
  env: Env;
  onStart: (step: Step) => void;
  onData: (text: string) => void;
  onChild: (child: ChildProcess) => void;
  onDone: (code: number | null, ms: number) => void;
}
function runSteps(steps: Step[], { spawn, env, onStart, onData, onChild, onDone }: RunStepsOptions): { cancel(): void } {
  let child: ChildProcess | null = null;
  let cancelled = false;
  let finished = false;
  let t0 = 0;

  const finish = (code: number | null) => {
    if (finished) return;
    finished = true;
    onDone(code, Date.now() - t0);
  };

  const next = (i: number): void => {
    if (cancelled) return finish(null);
    const step = steps[i];
    onStart(step);
    if (!t0) t0 = Date.now();
    let settled = false;
    const end = (code: number | null) => {
      if (settled) return;
      settled = true;
      for (const d of decoders) { const rest = d.end(); if (rest) onData(rest); }
      if (cancelled) finish(null);
      else if (code !== 0 || i === steps.length - 1) finish(code);
      else next(i + 1);
    };
    child = spawn(step.file, step.args, { cwd: step.cwd, env: step.env ? { ...env, ...step.env } : env, windowsHide: true, ...(step.shell ? { shell: true } : {}) });
    onChild(child);
    // one decoder per stream so a multi-byte character split across chunks stays whole
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    child.stdout!.on('data', (b: Buffer) => onData(decoders[0].write(b)));
    child.stderr!.on('data', (b: Buffer) => onData(decoders[1].write(b)));
    child.on('error', (err: Error) => {
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
const unpacked = (p: string) => p.replace(/([\\/])app\.asar(?=[\\/])/, '$1app.asar.unpacked');

function ensureBuildIgnored(rootDir: string): void {
  const file = path.join(rootDir, '.gitignore');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  if (text.split(/\r?\n/).some((l) => ['build', 'build/', '/build/'].includes(l.trim()))) return;
  fs.appendFileSync(file, (text === '' || text.endsWith('\n') ? '' : '\n') + 'build/\n');
}

export { LANG_KINDS, nodeSupportsTs, findTools, freshPath, toolEnv, runPlan, debugPlan, runSteps, ensureBuildIgnored, mergePath, installHint, installCmd, installUrl, unpacked };
